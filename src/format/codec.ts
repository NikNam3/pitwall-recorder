// Pure encode/decode of the .pwrec byte stream (the content inside the gzip layer).
// See FORMAT.md for the specification.

export const MAGIC = Buffer.from('PWREC', 'ascii');
export const FORMAT_VERSION = 1;

export const KIND_DATAGRAM = 0;
export const KIND_END = 0xff;

const HEADER_FIXED_SIZE = MAGIC.length + 1 + 4; // magic, u8 version, u32 json length
const RECORD_HEADER_SIZE = 1 + 8 + 2; // u8 kind, f64 time, u16 length

export const MAX_PAYLOAD = 0xffff;

export interface RecordingMeta {
  recorderVersion: string;
  /** ISO timestamp of when this file was started. */
  startedAt: string;
  listenPort: number;
}

export interface RecordingHeader {
  version: number;
  meta: RecordingMeta;
}

export type RecordingItem =
  | { type: 'header'; header: RecordingHeader }
  | { type: 'datagram'; t: number; data: Buffer }
  | { type: 'end'; t: number };

export class FormatError extends Error {}

export function encodeHeader(meta: RecordingMeta): Buffer {
  const json = Buffer.from(JSON.stringify(meta), 'utf8');
  const fixed = Buffer.alloc(HEADER_FIXED_SIZE);
  MAGIC.copy(fixed, 0);
  fixed.writeUInt8(FORMAT_VERSION, MAGIC.length);
  fixed.writeUInt32LE(json.length, MAGIC.length + 1);
  return Buffer.concat([fixed, json]);
}

/** `t` is milliseconds since the file was started. */
export function encodeRecord(kind: number, t: number, payload: Uint8Array = new Uint8Array(0)): Buffer {
  if (payload.length > MAX_PAYLOAD) {
    throw new FormatError(`payload of ${payload.length} bytes exceeds ${MAX_PAYLOAD}`);
  }
  const out = Buffer.alloc(RECORD_HEADER_SIZE + payload.length);
  out.writeUInt8(kind, 0);
  out.writeDoubleLE(t, 1);
  out.writeUInt16LE(payload.length, 9);
  out.set(payload, RECORD_HEADER_SIZE);
  return out;
}

/**
 * Incremental decoder: feed decompressed bytes in arbitrary chunks, get items out.
 * Bytes of an incomplete trailing record stay pending; check `pendingBytes` at the end.
 */
export class RecordingDecoder {
  private pending: Buffer = Buffer.alloc(0);
  private headerDone = false;
  private ended = false;

  get pendingBytes(): number {
    return this.pending.length;
  }

  push(chunk: Uint8Array): RecordingItem[] {
    this.pending = this.pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.pending, chunk]);
    const items: RecordingItem[] = [];
    let offset = 0;

    if (!this.headerDone) {
      const header = this.tryDecodeHeader();
      if (header === null) return items;
      items.push({ type: 'header', header: header.header });
      offset = header.size;
      this.headerDone = true;
    }

    while (this.pending.length - offset >= RECORD_HEADER_SIZE) {
      if (this.ended) throw new FormatError('data after end record');
      const kind = this.pending.readUInt8(offset);
      const t = this.pending.readDoubleLE(offset + 1);
      const length = this.pending.readUInt16LE(offset + 9);
      const total = RECORD_HEADER_SIZE + length;
      if (this.pending.length - offset < total) break;
      const start = offset + RECORD_HEADER_SIZE;
      if (kind === KIND_DATAGRAM) {
        items.push({ type: 'datagram', t, data: Buffer.from(this.pending.subarray(start, start + length)) });
      } else if (kind === KIND_END) {
        items.push({ type: 'end', t });
        this.ended = true;
      }
      // Other kinds are reserved; readers skip them (FORMAT.md).
      offset += total;
    }

    this.pending = this.pending.subarray(offset);
    return items;
  }

  private tryDecodeHeader(): { header: RecordingHeader; size: number } | null {
    const buf = this.pending;
    const magicLen = Math.min(buf.length, MAGIC.length);
    if (!buf.subarray(0, magicLen).equals(MAGIC.subarray(0, magicLen))) {
      throw new FormatError('not a pitwall recording (bad magic)');
    }
    if (buf.length < HEADER_FIXED_SIZE) return null;
    const version = buf.readUInt8(MAGIC.length);
    if (version !== FORMAT_VERSION) {
      throw new FormatError(`unsupported format version ${version} (this tool reads version ${FORMAT_VERSION})`);
    }
    const jsonLength = buf.readUInt32LE(MAGIC.length + 1);
    if (buf.length < HEADER_FIXED_SIZE + jsonLength) return null;
    const json = buf.subarray(HEADER_FIXED_SIZE, HEADER_FIXED_SIZE + jsonLength).toString('utf8');
    let meta: RecordingMeta;
    try {
      meta = JSON.parse(json) as RecordingMeta;
    } catch {
      throw new FormatError('header metadata is not valid JSON');
    }
    return { header: { version, meta }, size: HEADER_FIXED_SIZE + jsonLength };
  }
}
