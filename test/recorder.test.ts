import { createSocket } from 'node:dgram';
import { basename } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startRecorder, type Recorder, type RecorderEvent } from '../src/recorder/recorder.ts';
import { datagramsOf, listen, makePacket, readAll, send, tempDir, waitFor } from './helpers.ts';

const sender = createSocket('udp4');
let recorder: Recorder | null = null;

afterEach(async () => {
  await recorder?.stop();
  recorder = null;
});

async function start(extra: { forward?: { host: string; port: number } } = {}) {
  const events: RecorderEvent[] = [];
  recorder = await startRecorder({ port: 0, host: '127.0.0.1', outDir: tempDir(), onEvent: (e) => events.push(e), ...extra });
  return { recorder, events };
}

async function sendAll(r: Recorder, packets: Buffer[]): Promise<void> {
  for (const p of packets) await send(sender, p, r.port);
  await waitFor(() => r.stats().datagrams === packets.length);
}

describe('recorder', () => {
  it('writes each game session to its own file, with exactly the bytes received, in order', async () => {
    const { recorder: r } = await start();
    const sessionA = Array.from({ length: 50 }, (_, i) => makePacket({ id: i % 12, uid: 0xaaaan, seq: i }));
    const sessionB = Array.from({ length: 30 }, (_, i) => makePacket({ id: 6, uid: 0xbbbbn, seq: i, size: 1352 }));
    await sendAll(r, [...sessionA, ...sessionB]);

    const files = await r.stop();
    expect(files).toHaveLength(2);
    expect(basename(files[0]!)).toMatch(/^\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d_000000000000aaaa\.pwrec\.gz$/);
    expect(basename(files[1]!)).toMatch(/_000000000000bbbb\.pwrec\.gz$/);

    const a = await readAll(files[0]!);
    const b = await readAll(files[1]!);
    expect(datagramsOf(a)).toEqual(sessionA);
    expect(datagramsOf(b)).toEqual(sessionB);
    expect(a.at(-1)?.type).toBe('end');
    expect(b.at(-1)?.type).toBe('end');
  });

  it('keeps packets with session id 0 or no valid header in the current file instead of splitting', async () => {
    const { recorder: r } = await start();
    const packets = [
      makePacket({ id: 1, uid: 0n }),
      makePacket({ id: 1, uid: 7n }),
      Buffer.from('short'),
      makePacket({ id: 3, uid: 0n }),
      makePacket({ id: 2, uid: 7n }),
    ];
    await sendAll(r, packets);
    const files = await r.stop();
    expect(files.map((f) => basename(f).split('_').at(-1))).toEqual(['unknown-session.pwrec.gz', '0000000000000007.pwrec.gz']);
    expect(datagramsOf(await readAll(files[0]!))).toEqual(packets.slice(0, 1));
    expect(datagramsOf(await readAll(files[1]!))).toEqual(packets.slice(1));
    expect(r.stats().byPacketId.get(-1)).toBe(1);
  });

  it('forwards every datagram unchanged when asked to', async () => {
    const target = await listen();
    const { recorder: r } = await start({ forward: { host: '127.0.0.1', port: target.port } });
    const packets = Array.from({ length: 20 }, (_, i) => makePacket({ id: 6, uid: 1n, seq: i }));
    await sendAll(r, packets);
    await waitFor(() => target.received.length === packets.length);
    expect(target.received.map((x) => x.data)).toEqual(packets);
    target.socket.close();
  });

  it('warns once when the game sends a packet format other than 2025, but still records it', async () => {
    const { recorder: r, events } = await start();
    const packets = [makePacket({ id: 0, uid: 1n, format: 2024 }), makePacket({ id: 0, uid: 1n, format: 2024 })];
    await sendAll(r, packets);
    const warnings = events.filter((e) => e.type === 'warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ message: expect.stringContaining('2024') });
    const files = await r.stop();
    expect(datagramsOf(await readAll(files[0]!))).toEqual(packets);
  });

  it('writes no file when nothing was received', async () => {
    const { recorder: r } = await start();
    expect(await r.stop()).toEqual([]);
  });
});
