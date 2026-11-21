import { describe, expect, it } from 'vitest';
import { windowTurns, type TranscriptTurn } from '../src/ingest/window.js';

const turn = (index: number, content: string): TranscriptTurn => ({
  index,
  role: index % 2 === 0 ? 'user' : 'assistant',
  content,
  at: new Date(Date.UTC(2026, 0, 1, 12, index)).toISOString(),
});

describe('windowTurns', () => {
  it('returns [] for empty input', () => {
    expect(windowTurns([], 6000)).toEqual([]);
  });

  it('fits consecutive turns up to maxChars', () => {
    const turns = [turn(0, 'aaaa'), turn(1, 'bbbb'), turn(2, 'cccc')];
    const windows = windowTurns(turns, 11); // 4+1+4=9 fits, +1+4=14 does not
    expect(windows).toEqual([[turns[0], turns[1]], [turns[2]]]);
  });

  it('never splits a turn in half', () => {
    const turns = [turn(0, 'one'), turn(1, 'two'), turn(2, 'three'), turn(3, 'four')];
    const windows = windowTurns(turns, 8);
    const all = windows.flat();
    expect(all.map((t) => t.content)).toEqual(['one', 'two', 'three', 'four']);
    for (const w of windows) {
      const joined = w.map((t) => t.content).join(' ');
      expect(joined.length).toBeLessThanOrEqual(8);
    }
  });

  it('keeps a single oversized turn whole as its own window', () => {
    const big = turn(0, 'x'.repeat(6001));
    const windows = windowTurns([big, turn(1, 'small')], 6000);
    expect(windows).toHaveLength(2);
    expect(windows[0]?.[0]?.content).toBe(big.content);
    expect(windows[0]?.[0]?.at).toBe(big.at);
    expect(windows[1]?.[0]?.content).toBe('small');
  });
});
