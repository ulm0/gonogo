// What a browser holds for one push subscription (its key pair and its auth secret) and how it reads a push: RFC 8291 section 3.4,
// written from the RFC and not from push.ts, so a test that uses it checks the sender and not itself.
import { createDecipheriv, createECDH, hkdfSync } from 'node:crypto';
import { expect } from 'vitest';

const b64 = (b: Buffer): string => b.toString('base64url');

/** A new subscription's keys: `p256dh` and `auth` go to the server, `receive` reads what the server sent. */
export function phone(): { p256dh: string; auth: string; receive(body: Buffer): string } {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const auth = Buffer.from('0123456789abcdef');
  return {
    p256dh: b64(ua.getPublicKey()),
    auth: b64(auth),
    // RFC 8291 section 3.4, the receiving side
    receive(body) {
      const salt = body.subarray(0, 16);
      expect(body.readUInt32BE(16)).toBe(4096);
      const idlen = body.readUInt8(20);
      const asPublic = body.subarray(21, 21 + idlen);
      const secret = ua.computeSecret(asPublic);
      const ikm = Buffer.from(hkdfSync('sha256', secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]), 32));
      const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
      const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
      const rest = body.subarray(21 + idlen);
      const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
      decipher.setAuthTag(rest.subarray(rest.length - 16));
      const plain = Buffer.concat([decipher.update(rest.subarray(0, rest.length - 16)), decipher.final()]);
      expect(plain[plain.length - 1]).toBe(2);
      return plain.subarray(0, plain.length - 1).toString('utf8');
    },
  };
}

