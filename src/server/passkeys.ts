/**
 * Passkeys (WebAuthn), docs/login-spec.md: the ceremonies, with `@simplewebauthn/server` doing the cryptography and the checks of the standard.
 *
 * A passkey is offered only where it can work: on a PUBLIC name (a domain, never an IP address: browsers refuse one as an rp id) that the page
 * reached over https. gonogo itself sees plain http behind a tunnel, so https is known from the origin the authenticator signed: the expected
 * origin is `https://<the Host>`, and a page opened over http signs another one and fails. The rp id is the Host name without its port and is fixed
 * for a passkey at its registration. User verification is required, so a passkey is the password and the second factor in one step.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
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

/** register and step belong to a signed-in session; a login challenge belongs to nobody yet and is not kept at all (see below). */
type Kind = 'register' | 'step';
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
  /** Login challenges that were used (their nonces, until they would have expired): kept only after an assertion verified, so an anonymous caller cannot fill it. */
  const spent = new Map<string, number>();
  const sealed = (rpId: string, token: string): string => auth.mac(`passkey-login:${rpId}:${token}`).slice(0, 22);
  /** A login challenge is nonce + time + a keyed hash of them and the rp id: nothing is stored when it is made, so any number of them cost nothing. */
  const loginChallenge = (rpId: string): Uint8Array<ArrayBuffer> => {
    const token = Buffer.concat([randomBytes(16), Buffer.from(String(now()))]).toString('base64url');
    return new Uint8Array(Buffer.from(`${token}.${sealed(rpId, token)}`));
  };
  /** Whether this is a login challenge we made for this rp id, not yet expired. It is NOT marked used here: that happens when the assertion verified. */
  const loginChallengeOk = (challenge: string, rpId: string): string | null => {
    const text = Buffer.from(challenge, 'base64url').toString('utf8');
    const dot = text.lastIndexOf('.');
    if (dot < 1) return null;
    const token = text.slice(0, dot);
    const seal = Buffer.from(sealed(rpId, token));
    const given = Buffer.from(text.slice(dot + 1));
    if (seal.length !== given.length || !timingSafeEqual(seal, given)) return null;
    const raw = Buffer.from(token, 'base64url');
    const at = Number(raw.subarray(16).toString('utf8'));
    if (raw.length < 17 || !Number.isFinite(at) || now() - at > CHALLENGE_MS || at - now() > 1000) return null;
    const nonce = raw.subarray(0, 16).toString('base64url');
    for (const [key, until] of spent) if (until < now()) spent.delete(key);
    return spent.has(nonce) ? null : nonce;
  };
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
    let nonce: string | null = null;
    const response = raw as AuthenticationResponseJSON;
    if (typeof response !== 'object' || response === null || typeof response.id !== 'string') return null;
    const found = here(rp).find((p) => p.id === response.id);
    if (found === undefined) return null;
    try {
      const verified = await verifyAuthenticationResponse({
        response,
        expectedChallenge: (challenge) => {
          if (kind === 'step') return consume(challenge, 'step', rp.rpId, session);
          nonce = loginChallengeOk(challenge, rp.rpId);
          return nonce !== null;
        },
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpId,
        credential: credentialOf(found),
        requireUserVerification: true,
      });
      if (!verified.verified) return null;
      // used only now that it verified: a challenge that failed stays good for its owner
      if (nonce !== null) spent.set(nonce, now() + CHALLENGE_MS);
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
        // discoverable: the passkey is kept on the authenticator, so the login options need not name any credential
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
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
      // no allowCredentials: the options hand out no credential id to whoever asks; the authenticator offers its own passkeys for this rp id
      const options = await generateAuthenticationOptions({ rpID: rp.rpId, userVerification: 'required', challenge: loginChallenge(rp.rpId) });
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
