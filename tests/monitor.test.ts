import { describe, it, expect } from 'vitest';
import { dbWatch } from '../src/lib/monitor';

describe('db watchdog', () => {
  it('alerts once after 3 failures, then once on recovery', async () => {
    const sent: string[] = [];
    let up = true;
    let t = new Date('2026-01-01T00:00:00Z').getTime();
    const w = dbWatch({
      check: async () => {
        if (!up) throw new Error('down');
      },
      send: async (s) => void sent.push(s),
      now: () => new Date(t),
    });
    await w.tick();
    up = false;
    for (let i = 0; i < 5; i++) {
      await w.tick();
      t += 60_000;
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('در دسترس نیست');
    expect(w.down).toBe(true);

    up = true;
    await w.tick();
    await w.tick();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('برگشت');
    expect(sent[1]).toContain('۵');
    expect(w.down).toBe(false);
  });

  it('a single blip does not alert', async () => {
    const sent: string[] = [];
    let n = 0;
    const w = dbWatch({ check: async () => { if (n++ === 1) throw new Error('blip'); }, send: async (s) => void sent.push(s) });
    for (let i = 0; i < 4; i++) await w.tick();
    expect(sent).toHaveLength(0);
  });
});
