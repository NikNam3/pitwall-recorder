// Recorder core: listens on UDP, writes every datagram raw, starts a new file per game session.
// No console output here; the CLI (main.ts) turns events and stats into what the user sees.

import { createSocket, type Socket } from 'node:dgram';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { EXPECTED_PACKET_FORMAT, peekHeader } from '../f1/header.ts';
import { RecordingWriter } from '../format/file.ts';
import { RECORDER_VERSION } from '../version.ts';

export interface RecorderOptions {
  /** UDP port to listen on; 0 picks a free port (tests). */
  port: number;
  /** Address to bind; defaults to all interfaces. */
  host?: string;
  outDir: string;
  /** Relay every datagram unchanged to this address, e.g. for SimHub. */
  forward?: { host: string; port: number };
  flushIntervalMs?: number;
  onEvent?: (event: RecorderEvent) => void;
}

export type RecorderEvent =
  | { type: 'file-opened'; path: string; sessionUID: bigint | null }
  | { type: 'file-closed'; path: string; datagrams: number }
  | { type: 'warning'; message: string };

export interface RecorderStats {
  datagrams: number;
  /** Count per F1 packetId; datagrams without a valid header are counted under -1. */
  byPacketId: Map<number, number>;
  currentFile: string | null;
  currentFileBytesOnDisk: number;
  /** performance.now() of the last datagram, or null if none yet. */
  lastDatagramAt: number | null;
}

export interface Recorder {
  readonly port: number;
  stats(): RecorderStats;
  /** Stops listening and finishes all files. Returns the paths of every file written. */
  stop(): Promise<string[]>;
}

export async function startRecorder(options: RecorderOptions): Promise<Recorder> {
  const emit = options.onEvent ?? (() => {});
  mkdirSync(options.outDir, { recursive: true });

  const byPacketId = new Map<number, number>();
  const files: string[] = [];
  const pendingCloses: Promise<void>[] = [];
  const warnedFormats = new Set<number>();
  let writer: RecordingWriter | null = null;
  let writerSession: bigint | null = null;
  let datagrams = 0;
  let lastDatagramAt: number | null = null;
  let stopped = false;

  const socket = createSocket('udp4');
  const forwardSocket: Socket | null = options.forward ? createSocket('udp4') : null;

  function openWriter(sessionUID: bigint | null): RecordingWriter {
    const path = join(options.outDir, fileName(new Date(), sessionUID));
    const opened = new RecordingWriter(
      path,
      { recorderVersion: RECORDER_VERSION, listenPort: actualPort },
      { flushIntervalMs: options.flushIntervalMs },
    );
    files.push(path);
    emit({ type: 'file-opened', path, sessionUID });
    return opened;
  }

  function closeWriter(): void {
    if (!writer) return;
    const closing = writer;
    pendingCloses.push(
      closing.close().then(() => emit({ type: 'file-closed', path: closing.path, datagrams: closing.datagrams })),
    );
    writer = null;
    writerSession = null;
  }

  function onDatagram(data: Buffer): void {
    if (stopped) return;
    datagrams++;
    lastDatagramAt = performance.now();
    if (forwardSocket && options.forward) {
      forwardSocket.send(data, options.forward.port, options.forward.host);
    }

    const header = peekHeader(data);
    const packetId = header ? header.packetId : -1;
    byPacketId.set(packetId, (byPacketId.get(packetId) ?? 0) + 1);

    if (header && header.packetFormat !== EXPECTED_PACKET_FORMAT && !warnedFormats.has(header.packetFormat)) {
      warnedFormats.add(header.packetFormat);
      emit({
        type: 'warning',
        message: `game sends UDP format ${header.packetFormat}, expected ${EXPECTED_PACKET_FORMAT}; set UDP Format to 2025 in the game's telemetry settings`,
      });
    }

    // Session id 0 or unreadable headers don't start a new file; they go into the current one.
    const sessionUID = header && header.sessionUID !== 0n ? header.sessionUID : null;
    if (sessionUID !== null && sessionUID !== writerSession) {
      closeWriter();
      writer = openWriter(sessionUID);
      writerSession = sessionUID;
    } else if (!writer) {
      writer = openWriter(null);
    }
    writer.writeDatagram(data);
  }

  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(options.port, options.host, () => {
      socket.off('error', reject);
      resolve();
    });
  });
  const actualPort = socket.address().port;
  socket.on('message', onDatagram);
  socket.on('error', (error) => emit({ type: 'warning', message: `socket error: ${error.message}` }));

  return {
    port: actualPort,
    stats: () => ({
      datagrams,
      byPacketId: new Map(byPacketId),
      currentFile: writer?.path ?? null,
      currentFileBytesOnDisk: writer?.bytesOnDisk ?? 0,
      lastDatagramAt,
    }),
    async stop() {
      if (!stopped) {
        stopped = true;
        socket.close();
        forwardSocket?.close();
        closeWriter();
      }
      await Promise.all(pendingCloses);
      return [...files];
    },
  };
}

function fileName(date: Date, sessionUID: bigint | null): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_` +
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  const session = sessionUID === null ? 'unknown-session' : sessionUID.toString(16).padStart(16, '0');
  return `${stamp}_${session}.pwrec.gz`;
}
