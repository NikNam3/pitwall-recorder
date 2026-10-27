// Runs the real CLI as a child process, the way a friend's exe runs it.
import { spawn, type ChildProcess } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RECORDER_VERSION } from '../src/version.ts';
import { datagramsOf, makePacket, readAll, send, tempDir, waitFor } from './helpers.ts';

const sender = createSocket('udp4');
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
});

async function startCli(args: string[]) {
  const out = tempDir();
  const child = spawn(process.execPath, ['src/recorder/main.ts', '--port', '0', '--out', out, ...args]);
  children.push(child);
  let stdout = '';
  child.stdout!.on('data', (d: Buffer) => (stdout += d.toString()));
  child.stderr!.on('data', (d: Buffer) => (stdout += d.toString()));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  await waitFor(() => /Listening on UDP port \d+/.test(stdout), 10_000);
  const port = Number(/Listening on UDP port (\d+)/.exec(stdout)![1]);
  return { child, out, port, exited, output: () => stdout };
}

function recordings(dir: string): string[] {
  return readdirSync(dir).map((f) => join(dir, f));
}

const packets = Array.from({ length: 40 }, (_, i) => makePacket({ id: i % 8, uid: 99n, seq: i }));

describe('recorder CLI', () => {
  it.skipIf(process.platform === 'win32')('Ctrl+C finishes the file cleanly', async () => {
    const cli = await startCli([]);
    for (const p of packets) await send(sender, p, cli.port);
    await waitFor(() => cli.output().includes('Recording new session'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    cli.child.kill('SIGINT');
    expect(await cli.exited).toBe(0);

    const [file, ...rest] = recordings(cli.out);
    expect(rest).toEqual([]);
    const items = await readAll(file!);
    expect(datagramsOf(items)).toEqual(packets);
    expect(items.at(-1)?.type).toBe('end');
  });

  it('a hard kill still leaves a readable file with everything up to the last flush', async () => {
    const cli = await startCli([]);
    for (const p of packets) await send(sender, p, cli.port);
    await new Promise((resolve) => setTimeout(resolve, 1600)); // > 1 s flush interval
    cli.child.kill('SIGKILL');
    await cli.exited;

    const items = await readAll(recordings(cli.out)[0]!);
    expect(datagramsOf(items)).toEqual(packets);
    expect(items.some((i) => i.type === 'end')).toBe(false);
  });

  it('--duration stops by itself and finishes files', async () => {
    const cli = await startCli(['--duration', '1']);
    for (const p of packets) await send(sender, p, cli.port);
    expect(await cli.exited).toBe(0);
    const items = await readAll(recordings(cli.out)[0]!);
    expect(datagramsOf(items)).toEqual(packets);
    expect(items.at(-1)?.type).toBe('end');
  });

  it('explains a busy port instead of crashing with a stack trace', async () => {
    const blocker = createSocket('udp4');
    await new Promise<void>((resolve) => blocker.bind(0, resolve));
    const port = blocker.address().port;
    const child = spawn(process.execPath, ['src/recorder/main.ts', '--port', String(port), '--out', tempDir()]);
    children.push(child);
    let output = '';
    child.stderr.on('data', (d: Buffer) => (output += d.toString()));
    const code = await new Promise((resolve) => child.on('exit', resolve));
    blocker.close();
    expect(code).toBe(1);
    expect(output).toContain(`UDP port ${port} is already in use`);
    expect(output).not.toContain('    at ');
  });
});

it('version constant matches package.json', () => {
  expect(RECORDER_VERSION).toBe(JSON.parse(readFileSync('package.json', 'utf8')).version);
});
