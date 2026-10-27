import fc from 'fast-check';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, createGzip } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  encodeHeader,
  encodeRecord,
  FormatError,
  KIND_DATAGRAM,
  KIND_END,
  RecordingDecoder,
  type RecordingItem,
} from '../src/format/codec.ts';
import { RecordingWriter } from '../src/format/file.ts';
import { datagramsOf, readAll, tempDir } from './helpers.ts';

const meta = { recorderVersion: '0.0.0', startedAt: '2026-01-01T00:00:00.000Z', listenPort: 20777 };
const datagram = fc.uint8Array({ minLength: 0, maxLength: 1500 }).map((a) => Buffer.from(a));
const timestamp = fc.double({ min: 0, max: 1e9, noNaN: true });

function decodeInChunks(bytes: Buffer, cuts: number[]): RecordingItem[] {
  const decoder = new RecordingDecoder();
  const items: RecordingItem[] = [];
  let previous = 0;
  for (const cut of [...cuts.map((c) => c % (bytes.length + 1)).sort((a, b) => a - b), bytes.length]) {
    items.push(...decoder.push(bytes.subarray(previous, cut)));
    previous = cut;
  }
  return items;
}

describe('codec', () => {
  it('decodes exactly what was encoded, however the byte stream is chunked', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(timestamp, datagram), { maxLength: 40 }), fc.array(fc.nat(), { maxLength: 10 }), (records, cuts) => {
        const bytes = Buffer.concat([
          encodeHeader(meta),
          ...records.map(([t, data]) => encodeRecord(KIND_DATAGRAM, t, data)),
          encodeRecord(KIND_END, 42),
        ]);
        const items = decodeInChunks(bytes, cuts);
        expect(items[0]).toEqual({ type: 'header', header: { version: 1, meta } });
        expect(items.slice(1, -1)).toEqual(records.map(([t, data]) => ({ type: 'datagram', t, data })));
        expect(items.at(-1)).toEqual({ type: 'end', t: 42 });
      }),
    );
  });

  it('rejects an unknown format version instead of misreading it', () => {
    const bytes = encodeHeader(meta);
    bytes[5] = 2;
    expect(() => new RecordingDecoder().push(bytes)).toThrow(/unsupported format version 2/);
  });

  it('rejects files that are not recordings', () => {
    expect(() => new RecordingDecoder().push(Buffer.from('PK\x03\x04 a zip file'))).toThrow(FormatError);
  });

  it('skips reserved record kinds so newer files stay readable', () => {
    const data = Buffer.from([1, 2, 3]);
    const bytes = Buffer.concat([
      encodeHeader(meta),
      encodeRecord(7, 1, Buffer.from('future marker')),
      encodeRecord(KIND_DATAGRAM, 2, data),
    ]);
    expect(new RecordingDecoder().push(bytes).slice(1)).toEqual([{ type: 'datagram', t: 2, data }]);
  });

  it('refuses datagrams too large for the u16 length field', () => {
    expect(() => encodeRecord(KIND_DATAGRAM, 0, new Uint8Array(70_000))).toThrow(FormatError);
  });
});

describe('gzip file layer', () => {
  it('writer output reads back to the same datagrams in order, marked complete', async () => {
    const path = join(tempDir(), 'a.pwrec.gz');
    const sent = Array.from({ length: 300 }, (_, i) => Buffer.from(`packet ${i}`.repeat(1 + (i % 50))));
    const writer = new RecordingWriter(path, { recorderVersion: 'x', listenPort: 1 });
    sent.forEach((d) => writer.writeDatagram(d));
    await writer.close();

    const items = await readAll(path);
    expect(datagramsOf(items)).toEqual(sent);
    expect(items.at(-1)?.type).toBe('end');
    const times = items.flatMap((i) => (i.type === 'datagram' ? [i.t] : []));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('a file cut off at any byte keeps every datagram written before the last flush, and nothing corrupt', async () => {
    // Build the same stream the writer produces (gzip + periodic sync flush), remembering where each flush ended.
    const batches = Array.from({ length: 6 }, (_, b) => Array.from({ length: 20 }, (_, i) => Buffer.from(`b${b} p${i} `.repeat(10))));
    const gzip = createGzip();
    const chunks: Buffer[] = [];
    gzip.on('data', (c: Buffer) => chunks.push(c));
    const flushPoints: { compressedBytes: number; datagrams: number }[] = [];
    gzip.write(encodeHeader(meta));
    let written = 0;
    for (const batch of batches) {
      for (const d of batch) gzip.write(encodeRecord(KIND_DATAGRAM, written++, d));
      await new Promise<void>((resolve) => gzip.flush(constants.Z_SYNC_FLUSH, () => resolve()));
      flushPoints.push({ compressedBytes: Buffer.concat(chunks).length, datagrams: written });
    }
    const full = Buffer.concat(chunks);
    const all = batches.flat();
    const dir = tempDir();

    await fc.assert(
      fc.asyncProperty(fc.integer({ min: flushPoints[0]!.compressedBytes, max: full.length }), async (cut) => {
        const path = join(dir, `cut-${cut}.pwrec.gz`);
        writeFileSync(path, full.subarray(0, cut));
        const items = await readAll(path);
        const got = datagramsOf(items);
        const guaranteed = flushPoints.filter((f) => f.compressedBytes <= cut).at(-1)!.datagrams;
        expect(got.length).toBeGreaterThanOrEqual(guaranteed);
        expect(got).toEqual(all.slice(0, got.length));
        expect(items.some((i) => i.type === 'end')).toBe(false);
      }),
      { numRuns: 60 },
    );
  });
});
