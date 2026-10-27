import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { summarise } from '../src/tools/inspect.ts';
import { replay } from '../src/tools/replay.ts';
import { listen, makePacket, tempDir, waitFor, writeRecordingFile } from './helpers.ts';

describe('replay', () => {
  it('sends the original datagrams in order with the recorded spacing', async () => {
    const recorded = Array.from({ length: 6 }, (_, i) => ({ t: i * 100, data: makePacket({ id: i, uid: 5n, seq: i }) }));
    const path = join(tempDir(), 'r.pwrec.gz');
    writeRecordingFile(path, recorded);
    const target = await listen();

    expect(await replay(path, { host: '127.0.0.1', port: target.port, speed: 1 })).toBe(6);
    await waitFor(() => target.received.length === 6);
    target.socket.close();

    expect(target.received.map((r) => r.data)).toEqual(recorded.map((r) => r.data));
    const first = target.received[0]!.at;
    target.received.forEach((r, i) => expect(Math.abs(r.at - first - i * 100)).toBeLessThan(50));
  });

  it('plays faster with a speed factor', async () => {
    const path = join(tempDir(), 'fast.pwrec.gz');
    writeRecordingFile(path, [0, 1000, 2000].map((t) => ({ t, data: makePacket({ id: 0, uid: 1n }) })));
    const target = await listen();
    const started = performance.now();
    await replay(path, { host: '127.0.0.1', port: target.port, speed: 10 });
    const elapsed = performance.now() - started;
    target.socket.close();
    expect(elapsed).toBeGreaterThan(150);
    expect(elapsed).toBeLessThan(800);
  });
});

describe('inspect', () => {
  it('reports duration, per-packet counts and rates, and completeness', async () => {
    // 2 seconds: Motion at 60 Hz, Session at 2 Hz.
    const datagrams = [
      ...Array.from({ length: 121 }, (_, i) => ({ t: (i * 1000) / 60, data: makePacket({ id: 0, uid: 0xabcn }) })),
      ...Array.from({ length: 5 }, (_, i) => ({ t: i * 500, data: makePacket({ id: 1, uid: 0xabcn }) })),
    ].sort((a, b) => a.t - b.t);
    const path = join(tempDir(), 'i.pwrec.gz');
    writeRecordingFile(path, datagrams);

    const s = await summarise(path);
    expect(s.complete).toBe(true);
    expect(s.durationMs).toBe(2000);
    expect(s.datagrams).toBe(126);
    expect(s.packetFormats).toEqual([2025]);
    expect(s.sessionUIDs).toEqual(['0000000000000abc']);
    expect(s.packets.map(({ name, count }) => ({ name, count }))).toEqual([
      { name: 'Motion', count: 121 },
      { name: 'Session', count: 5 },
    ]);
    expect(s.packets[0]!.hz).toBeCloseTo(60.5, 1);
  });

  it('flags files without an end record as incomplete', async () => {
    const path = join(tempDir(), 'cut.pwrec.gz');
    writeRecordingFile(path, [{ t: 0, data: makePacket({ id: 0, uid: 1n }) }], false);
    expect((await summarise(path)).complete).toBe(false);
  });
});
