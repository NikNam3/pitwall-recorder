import { createSocket, type Socket } from 'node:dgram';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { encodeHeader, encodeRecord, KIND_DATAGRAM, KIND_END, type RecordingItem } from '../src/format/codec.ts';
import { readRecording } from '../src/format/file.ts';

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'pwrec-test-'));
}

/** A synthetic F1-style datagram with a valid 29-byte header and a recognisable body. */
export function makePacket(opts: { id: number; uid: bigint; format?: number; size?: number; seq?: number }): Buffer {
  const buf = Buffer.alloc(Math.max(29, opts.size ?? 64));
  buf.writeUInt16LE(opts.format ?? 2025, 0);
  buf.writeUInt8(25, 2);
  buf.writeUInt8(opts.id, 6);
  buf.writeBigUInt64LE(opts.uid, 7);
  buf.writeUInt32LE(opts.seq ?? 0, 19);
  for (let i = 29; i < buf.length; i++) buf[i] = (i * 7 + (opts.seq ?? 0)) & 0xff;
  return buf;
}

/** Writes a recording with exact, chosen timestamps (the real writer uses wall-clock time). */
export function writeRecordingFile(path: string, datagrams: { t: number; data: Buffer }[], complete = true): void {
  const parts = [encodeHeader({ recorderVersion: 'test', startedAt: '2026-01-01T00:00:00.000Z', listenPort: 0 })];
  for (const d of datagrams) parts.push(encodeRecord(KIND_DATAGRAM, d.t, d.data));
  if (complete) parts.push(encodeRecord(KIND_END, datagrams.at(-1)?.t ?? 0));
  writeFileSync(path, gzipSync(Buffer.concat(parts)));
}

export async function readAll(path: string): Promise<RecordingItem[]> {
  const items: RecordingItem[] = [];
  for await (const item of readRecording(path)) items.push(item);
  return items;
}

export function datagramsOf(items: RecordingItem[]): Buffer[] {
  return items.flatMap((item) => (item.type === 'datagram' ? [item.data] : []));
}

export async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function send(socket: Socket, data: Buffer, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    socket.send(data, port, '127.0.0.1', (error) => (error ? reject(error) : resolve())),
  );
}

/** A UDP socket on a free port that collects every datagram it receives. */
export async function listen(): Promise<{ socket: Socket; port: number; received: { at: number; data: Buffer }[] }> {
  const socket = createSocket('udp4');
  const received: { at: number; data: Buffer }[] = [];
  socket.on('message', (data) => received.push({ at: performance.now(), data }));
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  return { socket, port: socket.address().port, received };
}
