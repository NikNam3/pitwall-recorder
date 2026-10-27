// Sends a recording's datagrams to a UDP port with their original timing.
// Usage: node src/tools/replay.ts <file.pwrec.gz> [--host 127.0.0.1] [--port 20777] [--speed 1|10|max]

import { createSocket } from 'node:dgram';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { readRecording } from '../format/file.ts';

export interface ReplayOptions {
  host: string;
  port: number;
  /** Playback speed multiplier; Infinity sends as fast as possible. */
  speed: number;
}

/** Resolves with the number of datagrams sent. */
export async function replay(file: string, options: ReplayOptions): Promise<number> {
  const socket = createSocket('udp4');
  const startedAt = performance.now();
  let sent = 0;
  try {
    for await (const item of readRecording(file)) {
      if (item.type !== 'datagram') continue;
      if (Number.isFinite(options.speed)) {
        const wait = item.t / options.speed - (performance.now() - startedAt);
        if (wait > 1) await sleep(wait);
      }
      await new Promise<void>((resolve, reject) =>
        socket.send(item.data, options.port, options.host, (error) => (error ? reject(error) : resolve())),
      );
      sent++;
    }
  } finally {
    socket.close();
  }
  return sent;
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    options: {
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string', default: '20777' },
      speed: { type: 'string', default: '1' },
    },
    allowPositionals: true,
  });
  const file = positionals[0];
  const speed = values.speed === 'max' ? Infinity : Number(values.speed);
  if (!file || !(speed > 0)) {
    console.error('usage: replay <file.pwrec.gz> [--host 127.0.0.1] [--port 20777] [--speed 1|10|max]');
    process.exit(2);
  }
  const sent = await replay(file, { host: values.host, port: Number(values.port), speed });
  console.log(`sent ${sent} datagrams to ${values.host}:${values.port}`);
}
