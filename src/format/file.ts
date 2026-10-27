// Reading and writing .pwrec.gz files: the codec wrapped in gzip.

import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { pipeline } from 'node:stream';
import { constants as zlibConstants, createGunzip, createGzip, type Gzip } from 'node:zlib';
import {
  encodeHeader,
  encodeRecord,
  KIND_DATAGRAM,
  KIND_END,
  RecordingDecoder,
  type RecordingItem,
  type RecordingMeta,
} from './codec.ts';

export interface WriterOptions {
  /** How often buffered data is sync-flushed so a crash loses at most this much. Default 1000 ms. */
  flushIntervalMs?: number;
}

export class RecordingWriter {
  readonly path: string;
  private readonly gzip: Gzip;
  private readonly file: WriteStream;
  private readonly done: Promise<void>;
  private readonly flushTimer: NodeJS.Timeout;
  private readonly startedAtMs: number;
  private closed = false;
  datagrams = 0;

  constructor(path: string, meta: Omit<RecordingMeta, 'startedAt'>, options: WriterOptions = {}) {
    this.path = path;
    this.startedAtMs = performance.now();
    this.gzip = createGzip();
    this.file = createWriteStream(path);
    this.done = new Promise((resolve, reject) => {
      this.file.on('close', resolve);
      this.file.on('error', reject);
      this.gzip.on('error', reject);
    });
    this.gzip.pipe(this.file);
    this.gzip.write(encodeHeader({ ...meta, startedAt: new Date().toISOString() }));
    this.flushTimer = setInterval(() => this.gzip.flush(zlibConstants.Z_SYNC_FLUSH), options.flushIntervalMs ?? 1000);
    this.flushTimer.unref();
  }

  /** Compressed bytes on disk so far. */
  get bytesOnDisk(): number {
    return this.file.bytesWritten;
  }

  writeDatagram(data: Uint8Array): void {
    if (this.closed) throw new Error(`writer for ${this.path} is closed`);
    this.gzip.write(encodeRecord(KIND_DATAGRAM, performance.now() - this.startedAtMs, data));
    this.datagrams++;
  }

  /** Force buffered data out to disk now (same as the periodic flush). */
  flush(): Promise<void> {
    return new Promise((resolve) => this.gzip.flush(zlibConstants.Z_SYNC_FLUSH, () => resolve()));
  }

  /** Writes the end record, finishes the gzip stream and closes the file. */
  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      clearInterval(this.flushTimer);
      this.gzip.end(encodeRecord(KIND_END, performance.now() - this.startedAtMs));
    }
    await this.done;
  }
}

/**
 * Streams the items of a recording. Files cut off by a crash are read up to the last flush;
 * such files have no `end` item.
 */
export async function* readRecording(path: string): AsyncGenerator<RecordingItem> {
  const decoder = new RecordingDecoder();
  const gunzip = createGunzip({ finishFlush: zlibConstants.Z_SYNC_FLUSH });
  // pipeline forwards read errors (e.g. missing file) into gunzip, which ends the loop below with that error.
  pipeline(createReadStream(path), gunzip, () => {});
  for await (const chunk of gunzip as AsyncIterable<Buffer>) {
    yield* decoder.push(chunk);
  }
}
