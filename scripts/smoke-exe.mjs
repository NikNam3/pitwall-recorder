// End-to-end check of the built executable: run it, send synthetic game packets, inspect the result.
// Usage: node scripts/smoke-exe.mjs [path/to/exe]
import { spawn } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarise } from '../src/tools/inspect.ts';

const exe = process.argv[2] ?? (process.platform === 'win32' ? 'dist/pitwall-recorder.exe' : 'dist/pitwall-recorder');
const out = mkdtempSync(join(tmpdir(), 'pwrec-smoke-'));
const port = 20799;

const child = spawn(exe, ['--port', String(port), '--out', out, '--duration', '4'], { stdio: ['ignore', 'pipe', 'inherit'] });
let output = '';
child.stdout.on('data', (d) => process.stdout.write((output += d.toString(), d)));
const exited = new Promise((resolve) => child.on('exit', resolve));
const deadline = Date.now() + 10_000;
while (!output.includes('Listening on UDP port')) {
  if (Date.now() > deadline) throw new Error('exe did not start listening');
  await new Promise((r) => setTimeout(r, 50));
}

function packet(id, uid, seq) {
  const buf = Buffer.alloc(100);
  buf.writeUInt16LE(2025, 0);
  buf.writeUInt8(id, 6);
  buf.writeBigUInt64LE(uid, 7);
  buf.writeUInt32LE(seq, 19);
  return buf;
}
const socket = createSocket('udp4');
const plan = [
  ...Array.from({ length: 60 }, (_, i) => packet(i % 3, 0x1111n, i)),
  ...Array.from({ length: 40 }, (_, i) => packet(6, 0x2222n, i)),
];
for (const p of plan) {
  await new Promise((r) => socket.send(p, port, '127.0.0.1', r));
  await new Promise((r) => setTimeout(r, 5));
}
socket.close();

const code = await exited;
const files = readdirSync(out).sort().map((f) => join(out, f));
const summaries = await Promise.all(files.map(summarise));
const failures = [];
if (code !== 0) failures.push(`exit code ${code}`);
if (files.length !== 2) failures.push(`expected 2 files, got ${files.length}`);
const counts = summaries.map((s) => [s.sessionUIDs.join(','), s.datagrams, s.complete]);
const expected = [['0000000000001111', 60, true], ['0000000000002222', 40, true]];
if (JSON.stringify(counts) !== JSON.stringify(expected)) failures.push(`got ${JSON.stringify(counts)}, expected ${JSON.stringify(expected)}`);

if (failures.length > 0) {
  console.error(`SMOKE TEST FAILED: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('smoke test passed:', JSON.stringify(counts));
