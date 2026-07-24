/**
 * End-to-end: a synthesized take through the real orchestrator and the real
 * lanes, asserted on what the presenter would actually see.
 *
 * The question every assertion here has to survive is "would this still pass if
 * the orchestrator did nothing?" An assembly layer is unusually easy to test
 * vacuously — an empty `CoachRailState` satisfies most shape assertions — so
 * each test below asserts a *value that only exists because two lanes were
 * joined*: a WPM that tracks the synthesized speaking rate, a ribbon with
 * speech ticks in it, a filler counted and then corrected, an alert that
 * appears, expires and recurs.
 */
import { describe, expect, it } from 'vitest';

import { TakeHarness, prose } from './harness';

describe('coaching integration — pace reaches the rail', () => {
  it('publishes a plausible WPM that tracks the synthesized speaking rate', () => {
    const slow = new TakeHarness();
    const fast = new TakeHarness();

    // Same wall of audio, different word counts: 18 words per 6 s ≈ 180 WPM
    // against 8 words per 6 s ≈ 80 WPM. The orchestrator has to have carried
    // both the frames (for the voiced-time denominator) and the transcript (for
    // the numerator) into the pace lane for these to differ at all.
    for (let index = 0; index < 5; index += 1) {
      fast.say(prose(18), 6_000);
      slow.say(prose(8), 6_000);
    }
    fast.orchestrator.tick();
    slow.orchestrator.tick();

    const fastRail = fast.latest();
    const slowRail = slow.latest();
    expect(fastRail).not.toBeNull();
    expect(slowRail).not.toBeNull();

    const fastWpm = fastRail?.pace.wpm;
    const slowWpm = slowRail?.pace.wpm;
    // §27.1: `null` means "we do not know", and after 30 s of speech with a
    // final transcript we do.
    expect(fastWpm).not.toBeNull();
    expect(slowWpm).not.toBeNull();
    expect(fastWpm as number).toBeGreaterThan(60);
    expect(fastWpm as number).toBeLessThan(300);
    // The load-bearing assertion: the number is derived, not decorative.
    expect(fastWpm as number).toBeGreaterThan((slowWpm as number) + 30);
    expect(fastRail?.pace.state).not.toBe('learning');
  });

  it('publishes on the 200 ms cadence, never at frame rate', () => {
    const harness = new TakeHarness();
    harness.say(prose(20), 6_000);
    // 6.9 s of audio: 345 analysis frames and 69 aggregation passes. §12.2 caps
    // publication at one per 200 ms plus material changes, so the count has to
    // sit near `audio / 200` — a count near 69 means the rail is being driven
    // from the aggregation pass, and near 345 from the frame pump.
    expect(harness.published.length).toBeGreaterThan(0);
    expect(harness.published.length).toBeLessThanOrEqual(harness.audioMs / 200 + 10);
    // No two snapshots closer together than a single aggregation pass, either.
    const gaps = harness.published
      .slice(1)
      .map((state, index) => state.audioTimeMs - (harness.published[index]?.audioTimeMs ?? 0));
    expect(gaps.every((gap) => gap >= 100)).toBe(true);
    const revisions = harness.published.map((state) => state.stageRevision);
    expect(revisions).toEqual([...revisions].sort((a, b) => a - b));
    expect(new Set(revisions).size).toBe(revisions.length);
  });

  it('carries speech onto the ribbon and the audio clock onto the payload', () => {
    const harness = new TakeHarness();
    harness.say(prose(20), 6_000);
    const rail = harness.latest();
    expect(rail).not.toBeNull();
    // `buildRibbonEvents` had no caller anywhere in the codebase; an empty
    // ribbon is exactly what the subsystem produced before this layer existed.
    const speech = rail?.ribbonEvents.filter((event) => event.type === 'speech') ?? [];
    expect(speech.length).toBeGreaterThan(0);
    expect(speech[0]?.takePassId).toBe(rail?.takePassId);
    // §27: the producer's own clock, so the stage never has to estimate one.
    expect(rail?.audioTimeMs).toBeGreaterThan(6_000);
  });

  it('collapses gutter marks per line using the caller-supplied token map (§11)', () => {
    // §11.2: a line with several events is one marker with a `count`, and the
    // token → line map is the script compiler's, so it is injected.
    const lineForToken = (tokenId: string): string =>
      tokenId.startsWith('span-1') || tokenId.startsWith('span-2') ? 'line-1' : 'line-2';
    const harness = new TakeHarness({
      settings: { mode: 'studio' },
      host: { lineForToken },
    });
    harness.say('um we should start here', 2_000, { spanId: 'span-1' });
    harness.say('um the next part matters', 2_000, { spanId: 'span-2' });
    harness.say('um and then we finish', 2_000, { spanId: 'span-9' });

    const rail = harness.latest();
    expect(rail?.modules.gutterMarks).toBe(true);
    const marks = rail?.gutterMarks ?? [];
    expect(marks).toHaveLength(2);
    const firstLine = marks.find((mark) => mark.markId.includes('line-1'));
    expect(firstLine?.count).toBe(2);
    expect(firstLine?.type).toBe('confirmed_filler');
    expect(marks.every((mark) => mark.takePassId === rail?.takePassId)).toBe(true);
  });

  it('drops marks and ribbon events from a previous take pass (§11.3)', () => {
    const harness = new TakeHarness({ settings: { mode: 'studio' } });
    harness.say('um we should start here', 2_000, { spanId: 'span-1' });
    expect(harness.latest()?.fillers.confirmedCount).toBe(1);

    harness.orchestrator.beginTakePass('take-2', harness.audioMs);
    harness.say(prose(12), 4_000, { spanId: 'span-1' });

    const rail = harness.latest();
    expect(rail?.takePassId).toBe('take-2');
    expect(rail?.fillers.confirmedCount).toBe(0);
    expect(rail?.gutterMarks).toHaveLength(0);
    expect(rail?.ribbonEvents.every((event) => event.takePassId === 'take-2')).toBe(true);
    // §27: the revision counter never restarts, including across take passes.
    expect(rail?.stageRevision).toBeGreaterThan(1);
  });
});
