import { describe, expect, it } from 'vitest';
import { stillTracker } from './stillness';

function feed(offsets: [number, number | null][]): number {
  const tracker = stillTracker();
  for (const [now, offset] of offsets) tracker.observe(now, offset);
  return tracker.longestStillMs;
}

describe('the stall rule of a rolling take', () => {
  it('counts a freeze that ended, up to the frame that moved again', () => {
    // Moving, then 1,020 ms on one offset in 20 ms frames, then moving again.
    const frames: [number, number][] = [[0, 0]];
    for (let t = 20; t <= 1020; t += 20) frames.push([t, 0]);
    frames.push([1040, 1]);
    expect(feed(frames)).toBe(1040);
  });

  it('counts a freeze still going when sampling stops', () => {
    expect(feed([[0, 0], [16, 1], [1500, 1]])).toBe(1484);
  });

  it('is one frame for a script that moves every frame', () => {
    expect(feed([[0, 0], [16, 1], [32, 2], [48, 3]])).toBe(16);
  });

  it('treats a lost offset as a reading like any other', () => {
    expect(feed([[0, 0], [16, null], [32, null], [48, 1]])).toBe(32);
  });
});
