/**
 * Passkeys in the page (docs/login-spec.md): the bytes the browser wants, and the JSON the server's library reads. Nothing here decides anything;
 * the server checks the origin, the rp id, the challenge, the signature and the user verification.
 */

const bytes = (text: string): ArrayBuffer => {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out.buffer;
};
const text = (buffer: ArrayBuffer | ArrayBufferView): string => {
  const view = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let raw = '';
  for (const byte of view) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

type Json = Record<string, unknown>;
const list = (value: unknown): Json[] => (Array.isArray(value) ? (value as Json[]) : []);

export const passkeysSupported = (): boolean => typeof window !== 'undefined' && 'PublicKeyCredential' in window && typeof navigator.credentials?.create === 'function';

export function creationOptions(json: Json): PublicKeyCredentialCreationOptions {
  const user = json.user as Json;
  return {
    ...(json as unknown as PublicKeyCredentialCreationOptions),
    challenge: bytes(String(json.challenge)),
    user: { ...(user as unknown as PublicKeyCredentialUserEntity), id: bytes(String(user.id)) },
    excludeCredentials: list(json.excludeCredentials).map((c) => ({ ...(c as unknown as PublicKeyCredentialDescriptor), id: bytes(String(c.id)) })),
  };
}

export function requestOptions(json: Json): PublicKeyCredentialRequestOptions {
  return {
    ...(json as unknown as PublicKeyCredentialRequestOptions),
    challenge: bytes(String(json.challenge)),
    allowCredentials: list(json.allowCredentials).map((c) => ({ ...(c as unknown as PublicKeyCredentialDescriptor), id: bytes(String(c.id)) })),
  };
}

/** A credential from the browser as the JSON the server's library reads. */
export function credentialJson(credential: PublicKeyCredential): Json {
  const base: Json = { id: credential.id, rawId: text(credential.rawId), type: credential.type, clientExtensionResults: credential.getClientExtensionResults() };
  if (credential.authenticatorAttachment !== null) base.authenticatorAttachment = credential.authenticatorAttachment;
  const raw: unknown = credential.response;
  if (typeof raw === 'object' && raw !== null && 'attestationObject' in raw) {
    const made = raw as AuthenticatorAttestationResponse;
    base.response = { clientDataJSON: text(made.clientDataJSON), attestationObject: text(made.attestationObject), transports: typeof made.getTransports === 'function' ? made.getTransports() : [] };
  } else {
    const got = raw as AuthenticatorAssertionResponse;
    base.response = { clientDataJSON: text(got.clientDataJSON), authenticatorData: text(got.authenticatorData), signature: text(got.signature), ...(got.userHandle === null ? {} : { userHandle: text(got.userHandle) }) };
  }
  return base;
}
