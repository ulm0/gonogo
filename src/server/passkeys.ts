/**
 * Passkeys (WebAuthn), docs/login-spec.md: the ceremonies, with `@simplewebauthn/server` doing the cryptography and the checks of the standard.
 *
 * A passkey is offered only where it can work: on a PUBLIC name (a domain, never an IP address: browsers refuse one as an rp id) that the page
 * reached over https. gonogo itself sees plain http behind a tunnel, so https is known from the origin the authenticator signed: the expected
 * origin is `https://<the Host>`, and a page opened over http signs another one and fails. The rp id is the Host name without its port and is fixed
 * for a passkey at its registration. User verification is required, so a passkey is the password and the second factor in one step.
 */
import { createHash } from 'node:crypto';
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { AuthStore, HostClass, LoginResult, Passkey, Who } from './auth.js';
import { hostName } from './web.js';

export interface RelyingParty {
  rpId: string;
  /** What the authenticator signs as the page's origin: https and the Host as the browser wrote it (the port stays, the rp id has none). */
  origin: string;
}

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const CHALLENGE_MS = 5 * 60 * 1000;
const CHALLENGES_MAX = 200;

/** The relying party of a request, or null where a passkey cannot be offered: not a public name, or not a domain. */
export function relyingParty(host: string | undefined, cls: HostClass): RelyingParty | null {
  if (cls !== 'public' || host === undefined) return null;
  const name = hostName(host);
  if (name === null || !DOMAIN.test(name)) return null;
  return { rpId: name, origin: `https://${host.trim().toLowerCase()}` };
}

type Kind = 'register' | 'login' | 'step';
interface Challenge {
  kind: Kind;
  rpId: string;
  session: string | null;
  at: number;
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

export interface Passkeys {
  /** Options for a new passkey, for the signed-in session. */
  registerOptions(sessionId: string, rp: RelyingParty): Promise<Record<string, unknown>>;
  registerFinish(sessionId: string, who: Who, rp: RelyingParty, response: unknown, name: string): Promise<'ok' | 'bad' | 'full'>;
  /** Options to sign in; null when there is no passkey for this rp id. */
  loginOptions(rp: RelyingParty): Promise<Record<string, unknown> | null>;
  loginFinish(who: Who, rp: RelyingParty, response: unknown): Promise<LoginResult>;
  /** Options to confirm a step-up with a passkey; null when there is none. */
  stepOptions(sessionId: string, rp: RelyingParty): Promise<Record<string, unknown> | null>;
  stepFinish(sessionId: string, rp: RelyingParty, response: unknown): Promise<{ ok: true; session: string } | { ok: false }>;
  /** Whether this rp id has a passkey (for the login page's button). */
  has(rp: RelyingParty): boolean;
}

export function createPasskeys(auth: AuthStore, now: () => number = Date.now): Passkeys {
  const challenges = new Map<string, Challenge>();
  const remember = (challenge: string, entry: Omit<Challenge, 'at'>): void => {
    const t = now();
    for (const [key, value] of challenges) if (t - value.at > CHALLENGE_MS) challenges.delete(key);
    if (challenges.size >= CHALLENGES_MAX) challenges.delete(challenges.keys().next().value as string);
    challenges.set(challenge, { ...entry, at: t });
  };
  /** A challenge is used once, by the kind and the session that asked for it, within five minutes. */
  const consume = (challenge: string, kind: Kind, rpId: string, session: string | null): boolean => {
    const found = challenges.get(challenge);
    challenges.delete(challenge);
    return found !== undefined && now() - found.at <= CHALLENGE_MS && found.kind === kind && found.rpId === rpId && found.session === session;
  };
  const here = (rp: RelyingParty): Passkey[] => auth.passkeys().filter((p) => p.rpId === rp.rpId);
  const credentialOf = (p: Passkey): { id: string; publicKey: Uint8Array<ArrayBuffer>; counter: number; transports: never[] } => ({ id: p.id, publicKey: new Uint8Array(Buffer.from(p.publicKey, 'base64url')), counter: p.counter, transports: p.transports as never[] });

  async function assertion(kind: 'login' | 'step', session: string | null, rp: RelyingParty, raw: unknown): Promise<{ passkey: Passkey; counter: number } | null> {
    const response = raw as AuthenticationResponseJSON;
    if (typeof response !== 'object' || response === null || typeof response.id !== 'string') return null;
    const found = here(rp).find((p) => p.id === response.id);
    if (found === undefined) return null;
    try {
      const verified = await verifyAuthenticationResponse({
        response,
        expectedChallenge: (challenge) => consume(challenge, kind, rp.rpId, session),
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpId,
        credential: credentialOf(found),
        requireUserVerification: true,
      });
      if (!verified.verified) return null;
      return { passkey: found, counter: verified.authenticationInfo.newCounter };
    } catch (error) {
      // a counter that did not go up says the credential was copied
      if (error instanceof Error && /counter/i.test(error.message)) auth.passkeyCounterAlert(found.id);
      return null;
    }
  }

  return {
    has: (rp) => here(rp).length > 0,

    async registerOptions(sessionId, rp) {
      const user = auth.user();
      const options = await generateRegistrationOptions({
        rpName: 'gonogo',
        rpID: rp.rpId,
        userName: user,
        userDisplayName: user,
        userID: new Uint8Array(createHash('sha256').update(`gonogo:${user}`).digest()),
        attestationType: 'none',
        excludeCredentials: here(rp).map((p) => ({ id: p.id, transports: p.transports })),
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      });
      remember(options.challenge, { kind: 'register', rpId: rp.rpId, session: sessionId });
      return options as unknown as Record<string, unknown>;
    },

    async registerFinish(sessionId, who, rp, raw, name) {
      const response = raw as RegistrationResponseJSON;
      if (typeof response !== 'object' || response === null) return 'bad';
      try {
        const verified = await verifyRegistrationResponse({
          response,
          expectedChallenge: (challenge) => consume(challenge, 'register', rp.rpId, sessionId),
          expectedOrigin: rp.origin,
          expectedRPID: rp.rpId,
          requireUserVerification: true,
        });
        if (!verified.verified) return 'bad';
        const { credential, credentialBackedUp } = verified.registrationInfo;
        const added = auth.passkeyAdd(sessionId, who, { id: credential.id, publicKey: b64(credential.publicKey), counter: credential.counter, transports: credential.transports ?? [], name, rpId: rp.rpId, backedUp: credentialBackedUp });
        return added ? 'ok' : 'full';
      } catch {
        return 'bad';
      }
    },

    async loginOptions(rp) {
      const mine = here(rp);
      if (mine.length === 0) return null;
      const options = await generateAuthenticationOptions({ rpID: rp.rpId, userVerification: 'required', allowCredentials: mine.map((p) => ({ id: p.id, transports: p.transports })) });
      remember(options.challenge, { kind: 'login', rpId: rp.rpId, session: null });
      return options as unknown as Record<string, unknown>;
    },

    async loginFinish(who, rp, raw) {
      const got = await assertion('login', null, rp, raw);
      if (got === null) return { ok: false, reason: 'wrong' };
      return auth.passkeyLogin(who, got.passkey.id, got.counter);
    },

    async stepOptions(sessionId, rp) {
      const mine = here(rp);
      if (mine.length === 0) return null;
      const options = await generateAuthenticationOptions({ rpID: rp.rpId, userVerification: 'required', allowCredentials: mine.map((p) => ({ id: p.id, transports: p.transports })) });
      remember(options.challenge, { kind: 'step', rpId: rp.rpId, session: sessionId });
      return options as unknown as Record<string, unknown>;
    },

    async stepFinish(sessionId, rp, raw) {
      const got = await assertion('step', sessionId, rp, raw);
      if (got === null) return { ok: false };
      const done = auth.passkeyStepUp(sessionId, got.passkey.id, got.counter);
      return done.ok ? done : { ok: false };
    },
  };
}
