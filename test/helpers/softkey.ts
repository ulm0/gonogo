// A software authenticator for the tests: a P-256 key, `none` attestation, user presence and verification, and the counter. It writes what a
// browser would hand to the server (the JSON of a PublicKeyCredential), so the server's own code and the library are what is tried.
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
const sha256 = (data: Uint8Array): Buffer => createHash('sha256').update(data).digest();

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
}
type Cbor = number | string | Uint8Array | Cbor[] | Map<number | string, Cbor>;
/** The few CBOR types WebAuthn needs, in the order the standard asks (shortest key first). */
function cbor(value: Cbor): Buffer {
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cbor)]);
  const entries = [...value.entries()].map(([k, v]) => [cbor(k), cbor(v)] as const).sort((a, b) => Buffer.compare(a[0], b[0]));
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, v]) => [k, v])]);
}

export interface Ceremony {
  rpId: string;
  origin: string;
  challenge: string;
  /** Tests: the type, the user verification flag and the origin can be made wrong on purpose. */
  type?: string;
  verified?: boolean;
  present?: boolean;
}

export interface SoftKey {
  id: string;
  counter: number;
  create(c: Ceremony): Record<string, unknown>;
  get(c: Ceremony & { counter?: number }): Record<string, unknown>;
}

export function softKey(): SoftKey {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credentialId = randomBytes(32);
  const cose = cbor(new Map<number | string, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x as string, 'base64url')], [-3, Buffer.from(jwk.y as string, 'base64url')]]));
  const key: SoftKey = {
    id: b64(credentialId),
    counter: 0,
    create(c) {
      const clientData = Buffer.from(JSON.stringify({ type: c.type ?? 'webauthn.create', challenge: c.challenge, origin: c.origin, crossOrigin: false }));
      const flags = 0x40 | (c.present === false ? 0 : 0x01) | (c.verified === false ? 0 : 0x04);
      const counter = Buffer.alloc(4);
      counter.writeUInt32BE(key.counter);
      const length = Buffer.alloc(2);
      length.writeUInt16BE(credentialId.length);
      const authData = Buffer.concat([sha256(Buffer.from(c.rpId)), Buffer.from([flags]), counter, Buffer.alloc(16), length, credentialId, cose]);
      return {
        id: key.id,
        rawId: key.id,
        type: 'public-key',
        authenticatorAttachment: 'platform',
        clientExtensionResults: {},
        response: { clientDataJSON: b64(clientData), attestationObject: b64(cbor(new Map<number | string, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))), transports: ['internal'] },
      };
    },
    get(c) {
      if (c.counter !== undefined) key.counter = c.counter;
      else key.counter += 1;
      const clientData = Buffer.from(JSON.stringify({ type: c.type ?? 'webauthn.get', challenge: c.challenge, origin: c.origin, crossOrigin: false }));
      const flags = (c.present === false ? 0 : 0x01) | (c.verified === false ? 0 : 0x04);
      const counter = Buffer.alloc(4);
      counter.writeUInt32BE(key.counter);
      const authData = Buffer.concat([sha256(Buffer.from(c.rpId)), Buffer.from([flags]), counter]);
      const signature = sign('sha256', Buffer.concat([authData, sha256(clientData)]), privateKey);
      return {
        id: key.id,
        rawId: key.id,
        type: 'public-key',
        authenticatorAttachment: 'platform',
        clientExtensionResults: {},
        response: { clientDataJSON: b64(clientData), authenticatorData: b64(authData), signature: b64(signature), userHandle: b64(Buffer.from('user')) },
      };
    },
  };
  return key;
}
