import { describe, it, expect } from 'vitest';
import {
  createClipScheduler,
  planTransitionAtMs,
  mulberry32,
  DEFAULT_CROSSFADE_MS,
  TRANSITION_LEAD_MS,
  withMeasuredDuration,
} from './scheduler';

const MIRA_CLIPS = [
  { id: 'listening-7s', durationMs: 7042 },
  { id: 'listening-10s', durationMs: 10042 },
];

describe('clip scheduler (spec §40.2–40.3)', () => {
  it('plays every eligible clip once before refilling the bag', () => {
    const clips = [
      { id: 'a', durationMs: 8000 },
      { id: 'b', durationMs: 9000 },
      { id: 'c', durationMs: 10000 },
    ];
    const s = createClipScheduler(clips, { seed: 7 });
    for (let bagIdx = 0; bagIdx < 5; bagIdx++) {
      const bag = [s.next()!, s.next()!, s.next()!].map((p) => p.clipId);
      expect(new Set(bag).size).toBe(3);
    }
  });

  it('never immediately repeats a clip across bag boundaries', () => {
    const s = createClipScheduler(MIRA_CLIPS, { seed: 42 });
    const drawn: string[] = [];
    for (let i = 0; i < 40; i++) drawn.push(s.next()!.clipId);
    for (let i = 1; i < drawn.length; i++) {
      expect(drawn[i]).not.toBe(drawn[i - 1]);
    }
  });

  it('is deterministic for a given seed', () => {
    const a = createClipScheduler(MIRA_CLIPS, { seed: 123 });
    const b = createClipScheduler(MIRA_CLIPS, { seed: 123 });
    for (let i = 0; i < 10; i++) {
      expect(a.next()!.clipId).toBe(b.next()!.clipId);
    }
  });

  it('repeats a single-clip pack without an immediate-repeat deadlock', () => {
    const s = createClipScheduler([{ id: 'only', durationMs: 7042 }], { seed: 1 });
    expect(s.next()!.clipId).toBe('only');
    expect(s.next()!.clipId).toBe('only');
  });

  it('returns null for an empty pack (engine degrades to poster)', () => {
    const s = createClipScheduler([], { seed: 1 });
    expect(s.next()).toBeNull();
  });

  it('ignores clips with a non-positive duration', () => {
    const s = createClipScheduler(
      [
        { id: 'broken', durationMs: 0 },
        { id: 'ok', durationMs: 7000 },
      ],
      { seed: 3 },
    );
    for (let i = 0; i < 6; i++) expect(s.next()!.clipId).toBe('ok');
  });

  it('schedules the crossfade inside the neutral tail of the clip', () => {
    const at = planTransitionAtMs(7042);
    expect(at).toBe(7042 - DEFAULT_CROSSFADE_MS - TRANSITION_LEAD_MS);
    expect(at).toBeGreaterThan(0);
    expect(at + DEFAULT_CROSSFADE_MS).toBeLessThan(7042);
  });

  it('never schedules a negative transition time for very short clips', () => {
    expect(planTransitionAtMs(100)).toBe(0);
  });

  it('carries plan timing through next()', () => {
    const s = createClipScheduler(MIRA_CLIPS, { seed: 9, crossfadeMs: 200 });
    const plan = s.next()!;
    expect(plan.crossfadeMs).toBe(200);
    expect(plan.transitionAtMs).toBe(plan.durationMs - 200 - TRANSITION_LEAD_MS);
  });

  it('mulberry32 is deterministic and uniform-ish in [0, 1)', () => {
    const r1 = mulberry32(5);
    const r2 = mulberry32(5);
    for (let i = 0; i < 100; i++) {
      const v = r1();
      expect(v).toBe(r2());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('withMeasuredDuration (B7: trust the element, not the manifest)', () => {
  const plan = {
    clipId: 'listening-7s',
    durationMs: 7042,
    transitionAtMs: planTransitionAtMs(7042),
    crossfadeMs: DEFAULT_CROSSFADE_MS,
  };

  it('re-derives the crossfade point when the media is shorter than declared', () => {
    // The manifest claims 7042 ms; the file is really 6900 ms. With the
    // declared value the crossfade would arm at 6602 ms — after the element's
    // own `loop` has already restarted, so it never fires and the clip
    // hard-cuts on every loop.
    const measured = withMeasuredDuration(plan, 6900);
    expect(measured.durationMs).toBe(6900);
    expect(measured.transitionAtMs).toBe(planTransitionAtMs(6900));
    expect(measured.transitionAtMs).toBeLessThan(6900);
    expect(plan.transitionAtMs).toBeGreaterThan(measured.transitionAtMs);
  });

  it('keeps the crossfade window inside the real media on every clip', () => {
    for (const declared of [7042, 10042]) {
      const measuredMs = declared - 200;
      const next = withMeasuredDuration(
        { clipId: 'x', durationMs: declared, transitionAtMs: planTransitionAtMs(declared), crossfadeMs: DEFAULT_CROSSFADE_MS },
        measuredMs,
      );
      expect(next.transitionAtMs + next.crossfadeMs + TRANSITION_LEAD_MS).toBeLessThanOrEqual(measuredMs);
    }
  });

  it('ignores unusable measurements rather than corrupting the plan', () => {
    expect(withMeasuredDuration(plan, Number.NaN)).toBe(plan);
    expect(withMeasuredDuration(plan, Number.POSITIVE_INFINITY)).toBe(plan);
    expect(withMeasuredDuration(plan, 0)).toBe(plan);
    expect(withMeasuredDuration(plan, -5)).toBe(plan);
  });

  it('is a no-op when the manifest was right', () => {
    expect(withMeasuredDuration(plan, 7042)).toBe(plan);
  });
});
