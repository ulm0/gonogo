/**
 * The wire format between the hub and the pty host (docs/live-reload-spec.md): frames on a unix socket.
 *
 * A frame is `[length: u32 BE][type: u8][payload]`, where length counts the type byte and the payload.
 *   type 0  JSON control frame (a request, a reply, an event or a state push)
 *   type 1  output: `[attachment id: u32 BE][bytes]`, the raw output of one attachment
 * Pure: no sockets, no files. The reader reassembles frames from any chunking and refuses a frame that is too large.
 */

/** Bumped when a frame or an operation changes in a way an older host cannot answer. A mismatch means: restart with --resume. */
export const PTYHOST_VERSION = 1;
export const FRAME_JSON = 0;
export const FRAME_OUTPUT = 1;
/** A frame above this is a broken or hostile peer: the connection is dropped. */
export const FRAME_MAX_BYTES = 8 * 1024 * 1024;

export type Frame = { type: typeof FRAME_JSON; json: unknown } | { type: typeof FRAME_OUTPUT; attachment: number; bytes: Buffer };

export function encodeJson(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const out = Buffer.allocUnsafe(5 + body.length);
  out.writeUInt32BE(1 + body.length, 0);
  out.writeUInt8(FRAME_JSON, 4);
  body.copy(out, 5);
  return out;
}

export function encodeOutput(attachment: number, bytes: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(9 + bytes.length);
  out.writeUInt32BE(5 + bytes.length, 0);
  out.writeUInt8(FRAME_OUTPUT, 4);
  out.writeUInt32BE(attachment >>> 0, 5);
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).copy(out, 9);
  return out;
}

/** Feeds on chunks; `push` returns the frames that are complete, or throws (the caller closes the connection). */
export class FrameReader {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): Frame[] {
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    const frames: Frame[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length < 1 || length > FRAME_MAX_BYTES) throw new Error(`bad frame length ${length}`);
      if (this.buffer.length < 4 + length) break;
      const type = this.buffer.readUInt8(4);
      const payload = this.buffer.subarray(5, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      if (type === FRAME_JSON) {
        frames.push({ type: FRAME_JSON, json: JSON.parse(payload.toString('utf8')) as unknown });
      } else if (type === FRAME_OUTPUT && payload.length >= 4) {
        frames.push({ type: FRAME_OUTPUT, attachment: payload.readUInt32BE(0), bytes: Buffer.from(payload.subarray(4)) });
      } else {
        throw new Error(`bad frame type ${type}`);
      }
    }
    return frames;
  }
}

/** Where the host lives, under the home: the directory is 0700, the socket and the key 0600. */
export const RUN_DIR = 'run';
export const SOCKET_FILE = 'ptyhost.sock';
export const KEY_FILE = 'ptyhost.key';
export const HOST_LOG_FILE = 'ptyhost.log';
export const HOLDS_FILE = 'hub-state.json';
export const TOKENS_FILE = 'tokens.json';
