// Summarises a recording: is it complete, how long, which packets at which rates.
// Usage: node src/tools/inspect.ts <file.pwrec.gz>... [--json]

import { parseArgs } from 'node:util';
import { packetName, peekHeader } from '../f1/header.ts';
import type { RecordingHeader } from '../format/codec.ts';
import { readRecording } from '../format/file.ts';

export interface RecordingSummary {
  file: string;
  header: RecordingHeader | null;
  /** False if the file has no end record, e.g. the recorder was killed or the PC crashed. */
  complete: boolean;
  datagrams: number;
  bytes: number;
  durationMs: number;
  packetFormats: number[];
  sessionUIDs: string[];
  packets: { id: number; name: string; count: number; hz: number }[];
  /** Datagrams too short to carry an F1 packet header. */
  headerless: number;
}

export async function summarise(file: string): Promise<RecordingSummary> {
  let header: RecordingHeader | null = null;
  let complete = false;
  let datagrams = 0;
  let bytes = 0;
  let durationMs = 0;
  let headerless = 0;
  const formats = new Set<number>();
  const sessions = new Set<string>();
  const counts = new Map<number, number>();

  for await (const item of readRecording(file)) {
    if (item.type === 'header') header = item.header;
    else if (item.type === 'end') complete = true;
    else {
      datagrams++;
      bytes += item.data.length;
      durationMs = item.t;
      const packet = peekHeader(item.data);
      if (!packet) {
        headerless++;
        continue;
      }
      formats.add(packet.packetFormat);
      sessions.add(packet.sessionUID.toString(16).padStart(16, '0'));
      counts.set(packet.packetId, (counts.get(packet.packetId) ?? 0) + 1);
    }
  }

  const seconds = durationMs / 1000;
  return {
    file,
    header,
    complete,
    datagrams,
    bytes,
    durationMs,
    packetFormats: [...formats].sort(),
    sessionUIDs: [...sessions],
    packets: [...counts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([id, count]) => ({ id, name: packetName(id), count, hz: seconds > 0 ? count / seconds : 0 })),
    headerless,
  };
}

function printSummary(s: RecordingSummary): void {
  console.log(`\n${s.file}`);
  if (s.header) {
    console.log(`  recorder ${s.header.meta.recorderVersion}, started ${s.header.meta.startedAt}, port ${s.header.meta.listenPort}`);
  }
  console.log(`  ${s.complete ? 'complete' : 'INCOMPLETE (no end record: recorder was killed or crashed; data up to the last flush is intact)'}`);
  console.log(`  duration ${(s.durationMs / 1000).toFixed(1)} s, ${s.datagrams} datagrams, ${(s.bytes / 1e6).toFixed(1)} MB raw`);
  console.log(`  packet format(s): ${s.packetFormats.join(', ') || '-'}   session(s): ${s.sessionUIDs.join(', ') || '-'}`);
  if (s.headerless > 0) console.log(`  ${s.headerless} datagrams without a valid F1 header`);
  for (const p of s.packets) {
    console.log(`  ${String(p.id).padStart(3)} ${p.name.padEnd(20)} ${String(p.count).padStart(9)}  ${p.hz.toFixed(1).padStart(6)} Hz`);
  }
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({ options: { json: { type: 'boolean', default: false } }, allowPositionals: true });
  if (positionals.length === 0) {
    console.error('usage: inspect <file.pwrec.gz>... [--json]');
    process.exit(2);
  }
  const summaries = [];
  for (const file of positionals) summaries.push(await summarise(file));
  if (values.json) console.log(JSON.stringify(summaries, null, 2));
  else summaries.forEach(printSummary);
}
