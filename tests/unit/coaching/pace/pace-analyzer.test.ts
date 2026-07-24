/**
 * Pace state machine, end to end (spec §14.1, §14.4–§14.10, §27.1).
 *
 * The fixtures are synthetic takes whose true rate is fixed by construction:
 * `N` words spread evenly over `T` milliseconds of speech is `N / T` words per
 * millisecond and nothing else. Every WPM assertion below is that arithmetic,
 * so a regression that quietly switched to `totalWords / totalElapsed`, or
 * returned a constant, fails here rather than passing with a shrug.
 *
 * The analyzer never reads a wall clock; `now` is whatever the injected
 * {@link CoachClockContext} says it is.
 */
import { describe, expect, it } from 'vitest';
import type { CoachCandidate, SpeechInterval } from '../../../../src/shared/contracts/coaching';
import { PaceAnalyzer } from '../../../../src/shared/coaching/pace/pace-analyzer';
import { SpeechClock, type CoachClockContext } from '../../../../src/shared/coaching/pace/speech-clock';
import type { SpokenSegment, SpokenWord } from '../../../../src/shared/coaching/pace/token-timing';

function ctx(audioTimeMs: number, commitSequence: number | null = 1): CoachClockContext {
  return { audioTimeMs, trackingEpoch: 4, takePassId: 'pass-7', commitSequence };
}

function words(count: number, options: { fillerEvery?: number } = {}): SpokenWord[] {
  const out: SpokenWord[] = [];
  for (let i = 0; i < count; i += 1) {
    const isFiller = options.fillerEvery !== undefined && (i + 1) % options.fillerEvery === 0;
    out.push({
      text: isFiller ? 'um' : `w${i}`,
      excluded: false,
      confirmedFiller: isFiller,
      repetition: false,
      speechWeight: 1,
      endsSentence: i === count - 1,
    });
  }
  return out;
}

function interval(startMs: number, endMs: number): SpeechInterval {
  return {
    startMs,
    endMs,
    voicedMs: endMs - startMs,
    silenceMs: 0,
    meanSnrDb: 35,
    takePassId: 'pass-7',
  };
}

function segment(
  index: number,
  startMs: number,
  endMs: number,
  segmentWords: SpokenWord[],
  final = true,
): SpokenSegment {
  return {
    segmentId: `seg-${index}`,
    words: segmentWords,
    audioStartMs: startMs,
    audioEndMs: endMs,
    final,
    commitSequence: index,
    takePassId: 'pass-7',
    confidence: 0.95,
  };
}

/**
 * A take of `segmentCount` bursts, each `segmentMs` long and carrying
 * `wordsPerSegment` evenly weighted words, separated by `gapMs` of silence.
 */
function buildTake(options: {
  analyzer: PaceAnalyzer;
  clock: SpeechClock;
  segmentCount: number;
  segmentMs: number;
  wordsPerSegment: number;
  gapMs?: number;
  fillerEvery?: number;
  updateEachSegment?: boolean;
}): { endMs: number } {
  const { analyzer, clock, segmentCount, segmentMs, wordsPerSegment } = options;
  const gapMs = options.gapMs ?? 0;
  clock.start(0);
  let cursor = 0;
  for (let index = 0; index < segmentCount; index += 1) {
    const startMs = cursor;
    const endMs = startMs + segmentMs;
    clock.noteSpeechInterval(interval(startMs, endMs));
    analyzer.ingestSegment(
      segment(
        index,
        startMs,
        endMs,
        words(wordsPerSegment, { fillerEvery: options.fillerEvery ?? undefined }),
      ),
      clock,
      ctx(endMs, index),
    );
    if (options.updateEachSegment === true) {
      analyzer.update(clock, { context: ctx(endMs, index), sentenceBoundaryPassed: true });
    }
    cursor = endMs + gapMs;
    if (gapMs > 0) {
      clock.advanceTo(cursor);
    }
  }
  return { endMs: cursor - gapMs };
}

describe('PaceAnalyzer reads the rate the fixture was built with', () => {
  it('reports exactly 150 WPM for 150 words over exactly 60 s of speech', () => {
    // 15 bursts × 4 000 ms × 10 words = 150 words in 60 000 ms of continuous
    // speech. 150 words / 1 minute = 150 WPM, full stop.
    const analyzer = new PaceAnalyzer();
    const clock = new SpeechClock();
    const { endMs } = buildTake({
      analyzer,
      clock,
      segmentCount: 15,
      segmentMs: 4_000,
      wordsPerSegment: 10,
    });
    expect(endMs).toBe(60_000);

    const result = analyzer.update(clock, { context: ctx(60_000) });
    expect(result.display.wpm).toBeCloseTo(150, 6);
    expect(result.rates.audibleWpm).toBeCloseTo(150, 6);
    // No fillers, so content matches audible exactly.
    expect(result.rates.contentWpm).toBeCloseTo(150, 6);
    // No silence anywhere, so articulation matches too.
    expect(result.rates.articulationWpm).toBeCloseTo(150, 6);
    expect(result.display.state).toBe('on_target');
    expect(result.display.confidence).toBeCloseTo(1, 6);
    expect(result.display.targetLowWpm).toBe(115);
    expect(result.display.targetHighWpm).toBe(160);
  });

  it('reports exactly 200 WPM for 200 words over exactly 60 s', () => {
    const analyzer = new PaceAnalyzer();
    const clock = new SpeechClock();
    buildTake({ analyzer, clock, segmentCount: 20, segmentMs: 3_000, wordsPerSegment: 10 });
    const result = analyzer.update(clock, { context: ctx(60_000) });
    expect(result.display.wpm).toBeCloseTo(200, 6);
  });

  it('separates content from audible when confirmed fillers are present', () => {
    // Every fifth word is a confirmed filler: 150 audible words, 120 content
    // words, over the same 60 s.
    const analyzer = new PaceAnalyzer();
    const clock = new SpeechClock();
    buildTake({
      analyzer,
      clock,
      segmentCount: 15,
      segmentMs: 4_000,
      wordsPerSegment: 10,
      fillerEvery: 5,
    });
    const result = analyzer.update(clock, { context: ctx(60_000) });

    expect(result.rates.audibleWpm).toBeCloseTo(150, 6);
    // The content series is a staircase rather than a straight line, so the
    // weighted fit lands near — not exactly on — 120. What must never happen
    // is content tracking audible.
    expect(result.rates.contentWpm ?? 0).toBeGreaterThan(112);
    expect(result.rates.contentWpm ?? 0).toBeLessThan(128);
    expect(result.rates.contentWpm ?? 0).toBeLessThan(result.rates.audibleWpm ?? 0);
    // The rail shows Audible (§14.1).
    expect(result.display.wpm).toBeCloseTo(result.rates.audibleWpm ?? 0, 9);
  });

  it('separates articulation from audible when half the delivery time is silence', () => {
    // 30 bursts of 1 000 ms carrying 5 words each, separated by 1 000 ms of
    // silence. On the voiced-time axis that is 5 words per 1 000 ms = exactly
    // 300 WPM of articulation; on the delivery axis it is half that.
    const analyzer = new PaceAnalyzer();
    const clock = new SpeechClock();
    buildTake({
      analyzer,
      clock,
      segmentCount: 30,
      segmentMs: 1_000,
      wordsPerSegment: 5,
      gapMs: 1_000,
    });
    const result = analyzer.update(clock, { context: ctx(59_000) });

    expect(result.rates.articulationWpm).toBeCloseTo(300, 6);
    expect(result.rates.audibleWpm ?? 0).toBeGreaterThan(130);
    expect(result.rates.audibleWpm ?? 0).toBeLessThan(170);
    expect(result.rates.articulationWpm ?? 0).toBeGreaterThan((result.rates.audibleWpm ?? 0) * 1.5);
  });

  it('measures the rate after a long pause, not the rate averaged across it', () => {
    // 50 words at 150 WPM, a 20 s pause, then 50 more at 150 WPM. Averaging
    // over the whole take would say 100 words / 60 s = 100 WPM. The presenter
    // never spoke at 100 WPM.
    const analyzer = new PaceAnalyzer();
    const clock = new SpeechClock();
    clock.start(0);
    for (let index = 0; index < 5; index += 1) {
      const startMs = index * 4_000;
      clock.noteSpeechInterval(interval(startMs, startMs + 4_000));
      analyzer.ingestSegment(
        segment(index, startMs, startMs + 4_000, words(10)),
        clock,
        ctx(startMs + 4_000, index),
      );
    }
    clock.advanceTo(40_000);
    for (let index = 0; index < 5; index += 1) {
      const startMs = 40_000 + index * 4_000;
      clock.noteSpeechInterval(interval(startMs, startMs + 4_000));
      analyzer.ingestSegment(
        segment(index + 5, startMs, startMs + 4_000, words(10)),
        clock,
        ctx(startMs + 4_000, index + 5),
      );
    }

    const result = analyzer.update(clock, { context: ctx(60_000) });
    expect(result.display.wpm).toBeCloseTo(150, 6);
    expect(result.display.state).toBe('on_target');
  });
});

describe('PaceAnalyzer pause ladder (§14.5)', () => {
  function pausedTake(): { analyzer: PaceAnalyzer; clock: SpeechClock } {
    const analyzer = new PaceAnalyzer();
    const clock = new SpeechClock();
    buildTake({ analyzer, clock, segmentCount: 15, segmentMs: 4_000, wordsPerSegment: 10 });
    analyzer.update(clock, { context: ctx(60_000) });
    return { analyzer, clock };
  }

  it('holds the last number through the first 1.5 s of silence', () => {
    const { analyzer, clock } = pausedTake();
    clock.advanceTo(61_000);
    const result = analyzer.update(clock, { context: ctx(61_000) });
    expect(result.pauseStage).toBe('holding');
    expect(result.display.wpm).toBeCloseTo(150, 6);
    expect(result.display.state).toBe('on_target');
  });

  it('switches to PAUSED with a null wpm — never 0 — after 1.5 s', () => {
    const { analyzer, clock } = pausedTake();
    clock.advanceTo(61_600);
    const result = analyzer.update(clock, { context: ctx(61_600) });
    expect(result.pauseStage).toBe('paused');
    expect(result.display.state).toBe('paused');
    expect(result.display.wpm).toBeNull();
    // The last measured number is still recoverable for the low-contrast
    // rendering §14.5 asks for.
    expect(result.display.recentSeries.at(-1)?.wpm).toBeCloseTo(150, 6);
  });

  it('goes idle after 8 s of silence and stays null', () => {
    const { analyzer, clock } = pausedTake();
    clock.advanceTo(68_500);
    const result = analyzer.update(clock, { context: ctx(68_500) });
    expect(result.pauseStage).toBe('idle');
    expect(result.display.state).toBe('paused');
    expect(result.display.wpm).toBeNull();
  });

  it('treats a manual pause as idle immediately, without waiting out the ladder', () => {
    const { analyzer, clock } = pausedTake();
    const result = analyzer.update(clock, { context: ctx(60_000), suppressed: true });
    expect(result.pauseStage).toBe('idle');
    expect(result.display.wpm).toBeNull();
  });

  it('reports learning with a null wpm before there is any evidence', () => {
    const analyzer = new PaceAnalyzer();
    const clock = new SpeechClock();
    clock.start(0);
    clock.advanceTo(2_000);
    const result = analyzer.update(clock, { context: ctx(2_000) });
    expect(result.display.state).toBe('learning');
    expect(result.display.wpm).toBeNull();
    expect(result.display.recentSeries).toEqual([]);
  });

  it('stays in learning below the minimum active evidence even with words in hand', () => {
    // 3 000 ms of speech is under §14.4's 3 500 ms floor.
    const analyzer = new PaceAnalyzer();
    const clock = new SpeechClock();
    buildTake({ analyzer, clock, segmentCount: 3, segmentMs: 1_000, wordsPerSegment: 3 });
    const result = analyzer.update(clock, { context: ctx(3_000) });
    expect(result.display.state).toBe('learning');
    expect(result.display.wpm).toBeNull();
  });
});

describe('PaceAnalyzer classification (§14.7)', () => {
  it('reaches FAST only after the condition has held for the dwell time', () => {
    // 200 WPM is past the 172 WPM fast threshold from the first estimate, but
    // §14.7 requires 4 s before the state may say FAST.
    const analyzer = new PaceAnalyzer();
    const clock = new SpeechClock();
    clock.start(0);
    const states: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      const startMs = index * 3_000;
      clock.noteSpeechInterval(interval(startMs, startMs + 3_000));
      analyzer.ingestSegment(
        segment(index, startMs, startMs + 3_000, words(10)),
        clock,
        ctx(startMs + 3_000, index),
      );
      states.push(analyzer.update(clock, { context: ctx(startMs + 3_000, index) }).display.state);
    }

    // t = 3 000 has only 3 000 ms of evidence; t = 6 000 and 9 000 are inside
    // the dwell; FAST from t = 12 000 onward.
    expect(states).toEqual([
      'learning',
      'slightly_fast',
      'slightly_fast',
      'fast',
      'fast',
      'fast',
      'fast',
      'fast',
    ]);
  });

  it('classifies a rate inside the band as on target and one just above as slightly fast', () => {
    const onTarget = new PaceAnalyzer();
    const onTargetClock = new SpeechClock();
    buildTake({
      analyzer: onTarget,
      clock: onTargetClock,
      segmentCount: 15,
      segmentMs: 4_000,
      wordsPerSegment: 10,
    });
    expect(onTarget.update(onTargetClock, { context: ctx(60_000) }).display.state).toBe('on_target');

    // 165 WPM: above the 160 band top, below the 172 fast threshold.
    const slightly = new PaceAnalyzer();
    const slightlyClock = new SpeechClock();
    buildTake({
      analyzer: slightly,
      clock: slightlyClock,
      segmentCount: 15,
      segmentMs: 4_000,
      wordsPerSegment: 11,
    });
    const result = slightly.update(slightlyClock, { context: ctx(60_000) });
    expect(result.display.wpm).toBeCloseTo(165, 6);
    expect(result.display.state).toBe('slightly_fast');
  });

  it('honours the style band rather than a hard-coded one', () => {
    // 150 WPM is on target for `natural` and slightly slow for `expressive`,
    // whose band starts at 150 — sitting exactly on the low edge is inside it.
    const analyzer = new PaceAnalyzer({ style: 'calm' });
    const clock = new SpeechClock();
    buildTake({ analyzer, clock, segmentCount: 15, segmentMs: 4_000, wordsPerSegment: 10 });
    const result = analyzer.update(clock, { context: ctx(60_000) });
    expect(result.display.targetLowWpm).toBe(110);
    expect(result.display.targetHighWpm).toBe(145);
    // 150 WPM is above a calm explainer's 145 ceiling.
    expect(result.display.state).toBe('slightly_fast');
  });
});

describe('PaceAnalyzer tip candidates (§14.8)', () => {
  function fastRun(
    overrides: Partial<Parameters<PaceAnalyzer['update']>[1]> = {},
    segments = 10,
  ): { candidates: string[]; analyzer: PaceAnalyzer } {
    const analyzer = new PaceAnalyzer();
    const clock = new SpeechClock();
    clock.start(0);
    const seen: string[] = [];
    for (let index = 0; index < segments; index += 1) {
      const startMs = index * 3_000;
      clock.noteSpeechInterval(interval(startMs, startMs + 3_000));
      analyzer.ingestSegment(
        segment(index, startMs, startMs + 3_000, words(10)),
        clock,
        ctx(startMs + 3_000, index),
      );
      const result = analyzer.update(clock, {
        context: ctx(startMs + 3_000, index),
        sentenceBoundaryPassed: true,
        ...overrides,
      });
      for (const candidate of result.candidates) {
        seen.push(candidate.type);
      }
    }
    return { candidates: seen, analyzer };
  }

  it('proposes pace_too_fast once the fast state has persisted, and only once per cooldown', () => {
    // FAST from t = 12 000; persistence reaches 6 000 ms at t = 18 000. The
    // 25 s cooldown then blocks a second proposal for the rest of this 30 s run.
    const { candidates } = fastRun();
    expect(candidates).toEqual(['pace_too_fast']);
  });

  it('carries a stamp that a stale-evidence check can actually use', () => {
    const analyzer = new PaceAnalyzer();
    const clock = new SpeechClock();
    clock.start(0);
    let candidate: CoachCandidate | null = null;
    for (let index = 0; index < 8; index += 1) {
      const startMs = index * 3_000;
      clock.noteSpeechInterval(interval(startMs, startMs + 3_000));
      analyzer.ingestSegment(
        segment(index, startMs, startMs + 3_000, words(10)),
        clock,
        ctx(startMs + 3_000, index),
      );
      const result = analyzer.update(clock, {
        context: ctx(startMs + 3_000, index),
        sentenceBoundaryPassed: true,
        scriptSpanId: 'span-9',
      });
      if (result.candidates.length > 0) {
        candidate = result.candidates[0] ?? null;
      }
    }
    expect(candidate).not.toBeNull();
    const found = candidate as CoachCandidate;
    expect(found.type).toBe('pace_too_fast');
    expect(found.stamp.trackingEpoch).toBe(4);
    expect(found.stamp.takePassId).toBe('pass-7');
    // The evidence interval is the fast episode, which began at t = 12 000.
    expect(found.stamp.audioStartMs).toBe(12_000);
    expect(found.stamp.audioEndMs).toBe(18_000);
    expect(found.scriptSpanId).toBe('span-9');
    expect(found.finalEvidence).toBe(true);
    expect(found.localConfidence).toBeGreaterThan(0.5);
  });

  it('stays silent while the presenter is reading a marked fast section', () => {
    expect(fastRun({ authoredFastSection: true }).candidates).toEqual([]);
  });

  it('stays silent while line tracking is catching up after a transcript delay', () => {
    expect(fastRun({ trackingCatchingUp: true }).candidates).toEqual([]);
  });

  it('stays silent until a sentence boundary has passed', () => {
    expect(fastRun({ sentenceBoundaryPassed: false }).candidates).toEqual([]);
  });

  it('proposes nothing at all for a well-paced take', () => {
    // §2.6: the correct output for most windows is no tip.
    const analyzer = new PaceAnalyzer();
    const clock = new SpeechClock();
    const seen: string[] = [];
    clock.start(0);
    for (let index = 0; index < 15; index += 1) {
      const startMs = index * 4_000;
      clock.noteSpeechInterval(interval(startMs, startMs + 4_000));
      analyzer.ingestSegment(
        segment(index, startMs, startMs + 4_000, words(10)),
        clock,
        ctx(startMs + 4_000, index),
      );
      seen.push(
        ...analyzer
          .update(clock, { context: ctx(startMs + 4_000, index), sentenceBoundaryPassed: true })
          .candidates.map((candidate) => candidate.type),
      );
    }
    expect(seen).toEqual([]);
  });

  it('marks a candidate resting on a provisional tail as non-final evidence', () => {
    const analyzer = new PaceAnalyzer();
    const clock = new SpeechClock();
    clock.start(0);
    // Five final 3 000 ms bursts at 200 WPM take the state to FAST at 12 000;
    // at t = 15 000 the fast episode is only 3 000 ms old, so nothing fires yet.
    for (let index = 0; index < 5; index += 1) {
      const startMs = index * 3_000;
      clock.noteSpeechInterval(interval(startMs, startMs + 3_000));
      analyzer.ingestSegment(
        segment(index, startMs, startMs + 3_000, words(10)),
        clock,
        ctx(startMs + 3_000, index),
      );
      analyzer.update(clock, {
        context: ctx(startMs + 3_000, index),
        sentenceBoundaryPassed: true,
      });
    }
    // The tail that pushes persistence past 6 000 ms is still provisional.
    clock.noteSpeechInterval(interval(15_000, 18_000));
    analyzer.ingestSegment(
      segment(5, 15_000, 18_000, words(10), false),
      clock,
      ctx(18_000, null),
    );
    const result = analyzer.update(clock, {
      context: ctx(18_000, null),
      sentenceBoundaryPassed: true,
    });

    expect(result.usingProvisionalEvidence).toBe(true);
    expect(result.candidates.map((candidate) => candidate.type)).toEqual(['pace_too_fast']);
    expect(result.candidates[0]?.finalEvidence).toBe(false);
  });
});

describe('PaceAnalyzer schedule (§14.10)', () => {
  it('surfaces the target duration and a positive delta when running long', () => {
    const analyzer = new PaceAnalyzer({ targetDurationMs: 300_000 });
    const clock = new SpeechClock();
    // 120 WPM: 12 bursts × 4 000 ms × 8 words = 96 words in 48 s.
    buildTake({ analyzer, clock, segmentCount: 15, segmentMs: 4_000, wordsPerSegment: 8 });
    const result = analyzer.update(clock, {
      context: ctx(60_000),
      scriptProgress: {
        cursorUnitIndex: 96,
        totalUnits: 696,
        remainingSpokenWordEquivalents: 600,
        confidence: 0.9,
        observedAtMs: 60_000,
        trackingEpoch: 4,
        reacquiring: false,
      },
    });

    expect(result.display.wpm).toBeCloseTo(120, 6);
    expect(result.display.targetDurationMs).toBe(300_000);
    // 600 words at 120 WPM is 300 s more, on top of 60 s spent → 60 s over.
    expect(result.schedule.rawProjectedFinishDeltaMs).toBeCloseTo(60_000, 3);
    expect(result.display.projectedFinishDeltaMs ?? 0).toBeGreaterThan(0);
    expect(result.schedule.requiredWpm).toBeCloseTo(150, 6);
  });

  it('reports no schedule at all when no target duration is set', () => {
    const analyzer = new PaceAnalyzer();
    const clock = new SpeechClock();
    buildTake({ analyzer, clock, segmentCount: 15, segmentMs: 4_000, wordsPerSegment: 10 });
    const result = analyzer.update(clock, {
      context: ctx(60_000),
      scriptProgress: {
        cursorUnitIndex: 150,
        totalUnits: 750,
        remainingSpokenWordEquivalents: 600,
        confidence: 0.9,
        observedAtMs: 60_000,
        trackingEpoch: 4,
        reacquiring: false,
      },
    });
    expect(result.display.targetDurationMs).toBeNull();
    expect(result.display.projectedFinishDeltaMs).toBeNull();
  });
});

describe('PaceAnalyzer discontinuities', () => {
  it('forgets the previous rate after a retake reset', () => {
    const analyzer = new PaceAnalyzer();
    const clock = new SpeechClock();
    buildTake({ analyzer, clock, segmentCount: 15, segmentMs: 4_000, wordsPerSegment: 10 });
    expect(analyzer.update(clock, { context: ctx(60_000) }).display.wpm).toBeCloseTo(150, 6);

    analyzer.resetForDiscontinuity();
    const result = analyzer.update(clock, { context: ctx(60_000) });
    expect(result.display.wpm).toBeNull();
    expect(result.display.state).toBe('learning');
    expect(result.display.recentSeries).toEqual([]);
  });
});

describe('PaceAnalyzer slow pace (§14.7, §14.8)', () => {
  /** 10 words per 7 500 ms burst is exactly 80 WPM — below the 103 WPM floor. */
  function slowRun(
    overrides: Partial<Parameters<PaceAnalyzer['update']>[1]> = {},
  ): { states: string[]; candidates: string[]; lastWpm: number | null } {
    const analyzer = new PaceAnalyzer();
    const clock = new SpeechClock();
    clock.start(0);
    const states: string[] = [];
    const candidates: string[] = [];
    let lastWpm: number | null = null;
    for (let index = 0; index < 4; index += 1) {
      const startMs = index * 7_500;
      clock.noteSpeechInterval(interval(startMs, startMs + 7_500));
      analyzer.ingestSegment(
        segment(index, startMs, startMs + 7_500, words(10)),
        clock,
        ctx(startMs + 7_500, index),
      );
      const result = analyzer.update(clock, {
        context: ctx(startMs + 7_500, index),
        sentenceBoundaryPassed: true,
        ...overrides,
      });
      states.push(result.display.state);
      candidates.push(...result.candidates.map((candidate) => candidate.type));
      lastWpm = result.display.wpm;
    }
    return { states, candidates, lastWpm };
  }

  it('reaches SLOW only after the longer slow dwell, then proposes pace_too_slow', () => {
    const { states, candidates, lastWpm } = slowRun();
    expect(lastWpm).toBeCloseTo(80, 6);
    // 7 500 ms of evidence at the first update, then §14.7's 5 s dwell.
    expect(states).toEqual(['slightly_slow', 'slow', 'slow', 'slow']);
    // Persistence reaches 6 000 ms one update after SLOW is entered.
    expect(candidates).toEqual(['pace_too_slow']);
  });

  it('never proposes pace_too_slow on a reflective line, list, quotation or retake', () => {
    expect(slowRun({ suppressSlowTip: true }).candidates).toEqual([]);
  });

  it('still proposes pace_too_fast when the fast suppression flag is the one set', () => {
    // Guards against a suppression flag being wired to the wrong branch.
    expect(slowRun({ authoredFastSection: true }).candidates).toEqual(['pace_too_slow']);
  });
});

describe('PaceAnalyzer positive reinforcement (§25.6)', () => {
  it('proposes positive_pace only after a long recovery onto target', () => {
    // 18 s at 200 WPM (fast), then 150 WPM for the rest of a 98 s take.
    const analyzer = new PaceAnalyzer();
    const clock = new SpeechClock();
    clock.start(0);
    const seen: Array<{ atMs: number; type: string }> = [];

    for (let index = 0; index < 6; index += 1) {
      const startMs = index * 3_000;
      clock.noteSpeechInterval(interval(startMs, startMs + 3_000));
      analyzer.ingestSegment(
        segment(index, startMs, startMs + 3_000, words(10)),
        clock,
        ctx(startMs + 3_000, index),
      );
      const result = analyzer.update(clock, {
        context: ctx(startMs + 3_000, index),
        sentenceBoundaryPassed: true,
      });
      for (const candidate of result.candidates) {
        seen.push({ atMs: startMs + 3_000, type: candidate.type });
      }
    }

    let onTargetSince: number | null = null;
    for (let index = 0; index < 20; index += 1) {
      const startMs = 18_000 + index * 4_000;
      clock.noteSpeechInterval(interval(startMs, startMs + 4_000));
      analyzer.ingestSegment(
        segment(index + 6, startMs, startMs + 4_000, words(10)),
        clock,
        ctx(startMs + 4_000, index + 6),
      );
      const result = analyzer.update(clock, {
        context: ctx(startMs + 4_000, index + 6),
        sentenceBoundaryPassed: true,
      });
      if (result.display.state === 'on_target' && onTargetSince === null) {
        onTargetSince = startMs + 4_000;
      }
      for (const candidate of result.candidates) {
        seen.push({ atMs: startMs + 4_000, type: candidate.type });
      }
    }

    const types = seen.map((entry) => entry.type);
    expect(types).toContain('pace_too_fast');
    expect(types.filter((type) => type === 'positive_pace')).toHaveLength(1);

    // It cannot arrive before the recovery has actually lasted 45 s.
    const positive = seen.find((entry) => entry.type === 'positive_pace');
    expect(positive).toBeDefined();
    expect(onTargetSince).not.toBeNull();
    expect((positive?.atMs ?? 0) - (onTargetSince ?? 0)).toBeGreaterThanOrEqual(45_000);
  });

  it('never proposes positive_pace for a take that was on target the whole way', () => {
    // §25.6: praise for never having had a problem is exactly the patronizing
    // tone the setting exists to avoid.
    const analyzer = new PaceAnalyzer();
    const clock = new SpeechClock();
    clock.start(0);
    const seen: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      const startMs = index * 4_000;
      clock.noteSpeechInterval(interval(startMs, startMs + 4_000));
      analyzer.ingestSegment(
        segment(index, startMs, startMs + 4_000, words(10)),
        clock,
        ctx(startMs + 4_000, index),
      );
      seen.push(
        ...analyzer
          .update(clock, { context: ctx(startMs + 4_000, index), sentenceBoundaryPassed: true })
          .candidates.map((candidate) => candidate.type),
      );
    }
    expect(seen).toEqual([]);
  });
});
