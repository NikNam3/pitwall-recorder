// CLI entry: what a friend sees after double-clicking pitwall-recorder.exe.

import { dirname, join, resolve } from 'node:path';
import { isSea } from 'node:sea';
import { parseArgs } from 'node:util';
import { packetName } from '../f1/header.ts';
import { RECORDER_VERSION } from '../version.ts';
import { startRecorder, type Recorder, type RecorderEvent } from './recorder.ts';

const NO_DATA_WARNING_MS = 10_000;

const HELP = `pitwall-recorder ${RECORDER_VERSION}: records F1 25 UDP telemetry

Options:
  --port <n>              UDP port to listen on (default 20777)
  --out <dir>             where recordings go (default: pitwall-recordings next to the program)
  --forward <host:port>   also pass every packet on, e.g. 127.0.0.1:20778 for SimHub
  --duration <seconds>    stop automatically after this long
  --help                  show this text`;

const SETTINGS_CHECKLIST = `In F1 25: Settings > Telemetry Settings
  UDP Telemetry ......... On
  UDP Broadcast Mode .... Off
  UDP IP Address ........ 127.0.0.1
  UDP Port .............. {port}
  UDP Send Rate ......... 60Hz
  UDP Format ............ 2025
  Your Telemetry ........ Public   <- everyone in the lobby, or their car data is missing`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', default: '20777' },
      out: { type: 'string' },
      forward: { type: 'string' },
      duration: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }

  const port = parseInteger(values.port, '--port');
  const outDir = resolve(values.out ?? join(isSea() ? dirname(process.execPath) : process.cwd(), 'pitwall-recordings'));
  const forward = values.forward === undefined ? undefined : parseHostPort(values.forward);
  const durationS = values.duration === undefined ? undefined : parseInteger(values.duration, '--duration');

  const display = new StatusDisplay();
  let recorder: Recorder;
  try {
    recorder = await startRecorder({ port, outDir, forward, onEvent: (event) => display.event(event) });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new UserError(
        `UDP port ${port} is already in use, probably by another telemetry app (SimHub, Crew Chief…).\n` +
          `Close that app, or start this with --port 20778 and set the game's UDP Port to 20778.\n` +
          `To keep using the other app too, see "Using SimHub at the same time" in the README.`,
      );
    }
    throw error;
  }

  console.log(`pitwall-recorder ${RECORDER_VERSION}`);
  console.log(`Listening on UDP port ${recorder.port}${forward ? `, forwarding to ${forward.host}:${forward.port}` : ''}`);
  console.log(`Recordings go to: ${outDir}\n`);
  console.log(SETTINGS_CHECKLIST.replace('{port}', String(recorder.port)));
  console.log(`\nStop with Ctrl+C or by closing this window. Waiting for data from the game…\n`);

  const startedAt = performance.now();
  const ticker = setInterval(() => display.tick(recorder, startedAt), 1000);

  let stopping = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    clearInterval(ticker);
    display.clearLine();
    console.log(`\n${reason}: finishing files…`);
    const files = await recorder.stop();
    console.log(files.length === 0 ? 'No data was received, nothing recorded.' : `Done. ${files.length} file(s) in ${outDir}`);
    process.exit(0);
  };
  // SIGHUP is what Windows sends when the console window is closed.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => void shutdown('Stopping'));
  }
  if (durationS !== undefined) {
    setTimeout(() => void shutdown(`Duration of ${durationS}s reached`), durationS * 1000);
  }
}

class StatusDisplay {
  private readonly tty = process.stdout.isTTY === true;
  private lastCount = 0;
  private lastPrintedAt = 0;
  private warnedNoData = false;
  private lineVisible = false;

  event(event: RecorderEvent): void {
    this.clearLine();
    if (event.type === 'file-opened') console.log(`● Recording new session → ${event.path}`);
    else if (event.type === 'file-closed') console.log(`✓ Saved ${event.path} (${event.datagrams} packets)`);
    else console.log(`⚠ ${event.message}`);
  }

  tick(recorder: Recorder, startedAt: number): void {
    const stats = recorder.stats();
    const now = performance.now();
    const rate = stats.datagrams - this.lastCount;
    this.lastCount = stats.datagrams;

    const silentFor = now - (stats.lastDatagramAt ?? startedAt);
    if (silentFor > NO_DATA_WARNING_MS && !this.warnedNoData) {
      this.warnedNoData = true;
      this.event({
        type: 'warning',
        message:
          stats.lastDatagramAt === null
            ? 'No data yet. Check the telemetry settings above (and that you are on track or in a session).'
            : 'No data for 10 seconds (fine in menus; otherwise check the game).',
      });
    }
    if (silentFor <= NO_DATA_WARNING_MS) this.warnedNoData = false;

    if (stats.datagrams === 0) return;
    const types = [...stats.byPacketId.keys()].filter((id) => id >= 0).map(packetName);
    const line =
      `REC ${formatDuration(now - startedAt)} | ${rate} pkt/s | ${stats.datagrams} packets | ` +
      `${(stats.currentFileBytesOnDisk / 1e6).toFixed(1)} MB | ${types.length} packet types`;
    if (this.tty) {
      const width = (process.stdout.columns ?? 100) - 1;
      process.stdout.write(`\r${line.slice(0, width).padEnd(width)}`);
      this.lineVisible = true;
    } else if (now - this.lastPrintedAt >= 10_000) {
      this.lastPrintedAt = now;
      console.log(line);
    }
  }

  clearLine(): void {
    if (this.tty && this.lineVisible) {
      process.stdout.write(`\r${' '.repeat((process.stdout.columns ?? 100) - 1)}\r`);
      this.lineVisible = false;
    }
  }
}

class UserError extends Error {}

function parseInteger(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new UserError(`${flag} must be a whole number, got "${value}"`);
  return n;
}

function parseHostPort(value: string): { host: string; port: number } {
  const match = /^(.+):(\d+)$/.exec(value);
  if (!match) throw new UserError(`--forward must look like host:port, got "${value}"`);
  return { host: match[1]!, port: parseInteger(match[2]!, '--forward port') };
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

main().catch(async (error: unknown) => {
  console.error(`\n✗ ${error instanceof UserError ? error.message : String((error as Error)?.stack ?? error)}`);
  // A double-clicked exe closes its window on exit; keep it open so the message can be read.
  if (isSea() && process.stdin.isTTY) {
    console.error('\nPress Enter to close.');
    await new Promise((resolve) => process.stdin.once('data', resolve));
  }
  process.exit(1);
});
