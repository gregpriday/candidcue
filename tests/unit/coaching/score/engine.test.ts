/**
 * The delivery scoring engine end to end (§9).
 *
 * The properties proved here are the ones that would be invisible to a test
 * that only asserted "the score is a number":
 *
 * - a dimension with no producer is `null` and is *excluded from* the mean;
 * - a step change in the underlying metrics cannot move the visible score
 *   faster than the §9.6 rate cap;
 * - a provisional filler that is later retracted leaves no permanent dent;
 * - a recording fault lowers confidence and never lowers the score;
 * - the §9.7 tiers sit on the published thresholds.
 */
import { describe, expect, it } from 'vitest';
import type { DeliveryDimension, DeliveryScoreState } from '../../../../src/shared/contracts/coaching';
import { DELIVERY_SCORE_WEIGHTS } from '../../../../src/shared/contracts/coaching';
import { DeliveryScoreEngine } from '../../../../src/shared/coaching/score/engine';
import { combineDimensions } from '../../../../src/shared/coaching/score/dimension';
import { DEFAULT_DELIVERY_SCORE_OPTIONS } from '../../../../src/shared/coaching/score/profile';
import { evidenceAt, filler, type FixtureOverrides } from './evidence-fixture';

const TICK_MS = 100;

/** Drive the engine at 10 Hz for `durationMs`, feeding words as it goes. */
function run(
  engine: DeliveryScoreEngine,
  fromMs: number,
  durationMs: number,
  overrides: FixtureOverrides | ((nowMs: number) => FixtureOverrides) = {},
): DeliveryScoreState {
  let state: DeliveryScoreState | null = null;
  let nextWordMs = fromMs;
  for (let now = fromMs + TICK_MS; now <= fromMs + durationMs; now += TICK_MS) {
    // ~150 WPM of finalized transcript: 5 words every 2 seconds.
    while (nextWordMs + 2_000 <= now) {
      nextWordMs += 2_000;
      engine.noteSpokenWords(nextWordMs, 5, true);
    }
    const patch = typeof overrides === 'function' ? overrides(now) : overrides;
    state = engine.update(evidenceAt(now, patch));
  }
  if (state === null) throw new Error('no update ran');
  return state;
}

function dimension(state: DeliveryScoreState, name: DeliveryDimension) {
  const found = state.dimensions.find((entry) => entry.dimension === name);
  if (found === undefined) throw new Error(`missing dimension ${name}`);
  return found;
}

describe('a good delivery', () => {
  it('scores 100 across every available dimension, and reports the rest as null', () => {
    const engine = new DeliveryScoreEngine();
    const state = run(engine, 0, 60_000);

    expect(dimension(state, 'pace').score).toBe(100);
    expect(dimension(state, 'pausing').score).toBe(100);
    expect(dimension(state, 'variety').score).toBe(100);
    expect(dimension(state, 'fluency').score).toBe(100);

    // The three dimensions with no producer at all.
    expect(dimension(state, 'emphasis').score).toBeNull();
    expect(dimension(state, 'clarity').score).toBeNull();
    expect(dimension(state, 'consistency').score).toBeNull();

    expect(state.rawScore).toBe(100);
    expect(state.displayScore).toBe(100);
  });

  it('always reports all seven dimensions with the contract weights', () => {
    const engine = new DeliveryScoreEngine();
    const state = run(engine, 0, 5_000);
    expect(state.dimensions).toHaveLength(7);
    for (const entry of state.dimensions) {
      expect(entry.weight).toBe(DELIVERY_SCORE_WEIGHTS[entry.dimension]);
    }
  });
});

describe('§9.4 — an unavailable dimension is excluded, not defaulted', () => {
  it('does not drag the overall score toward zero', () => {
    const engine = new DeliveryScoreEngine();
    const state = run(engine, 0, 60_000);
    // 72 of the 100 contract points are available. Folding the missing 28 in as
    // zero would give 72; as 100 it would also give 100, so the companion test
    // below pins the direction from the other side.
    expect(state.rawScore).toBe(100);
    expect(state.rawScore).not.toBeCloseTo(72, 0);
  });

  it('does not prop a genuinely poor delivery up toward the missing dimensions', () => {
    const engine = new DeliveryScoreEngine();
    // Everything measurable is bad: far too fast, no pauses, flat, full of ums.
    const state = run(engine, 0, 60_000, (nowMs) => ({
      pace: { wpm: 260, state: 'fast' },
      rates: { audibleWpm: 260 },
      voicedMsInWindow: Math.min(30_000, nowMs) * 0.99,
      pauses: [],
      cadence: { eligibleBoundaries: 8, shapedBoundaries: 0, choppyPauseCount: 0 },
      pitch: { spanSemitones: 1, iqrSemitones: 0.4 },
      energy: { rangeDb: 1.5 },
      fillerEvents: Array.from({ length: 14 }, (_, index) =>
        filler({
          kind: 'strict_vocalized',
          audioStartMs: Math.max(0, nowMs - 28_000 + index * 2_000),
          audioEndMs: Math.max(0, nowMs - 28_000 + index * 2_000) + 200,
        }),
      ),
    }));
    expect(state.rawScore).not.toBeNull();
    const availableScores = state.dimensions
      .map((entry) => entry.score)
      .filter((score): score is number => score !== null);
    expect(availableScores).toHaveLength(4);
    const best = Math.max(...availableScores);
    // The overall score can never exceed the best dimension actually measured.
    expect(state.rawScore as number).toBeLessThanOrEqual(best + 1e-9);
    expect(state.rawScore as number).toBeLessThan(35);

    // And the counterfactual, computed from the same numbers: had the three
    // unavailable dimensions been quietly scored 100 instead of excluded, the
    // total would be far higher. This is the assertion a constant-returning
    // implementation cannot satisfy.
    const propped = combineDimensions(
      state.dimensions.map((entry) => (entry.score === null ? { ...entry, score: 100 } : entry)),
      DEFAULT_DELIVERY_SCORE_OPTIONS.weakDimensionBlend,
    );
    expect(propped.raw as number).toBeGreaterThan((state.rawScore as number) + 10);
  });

  it('scores from a single available dimension without inventing the others', () => {
    const engine = new DeliveryScoreEngine();
    // No transcript at all: fluency has no words, so only the audio dimensions
    // can speak. The score must still exist and must not be diluted.
    let state: DeliveryScoreState | null = null;
    for (let now = TICK_MS; now <= 40_000; now += TICK_MS) {
      state = engine.update(
        evidenceAt(now, {
          pitch: { spanSemitones: 1, iqrSemitones: 0.3 },
          energy: { rangeDb: 1 },
        }),
      );
    }
    expect(state).not.toBeNull();
    const settled = state as DeliveryScoreState;
    expect(dimension(settled, 'fluency').score).toBeNull();
    expect(dimension(settled, 'variety').score).not.toBeNull();
    expect(dimension(settled, 'variety').score as number).toBeLessThan(50);
    expect(settled.rawScore).not.toBeNull();
    // Confidence is zero without words, so nothing is shown — but the raw
    // score exists and the diagnostics can explain it.
    expect(settled.displayScore).toBeNull();
    expect(settled.tier).toBe('warming_up');
  });
});

describe('§9.6 — the visible rate cap', () => {
  it('never moves the display more than the cap in one second', () => {
    const engine = new DeliveryScoreEngine();
    run(engine, 0, 60_000);
    const before = engine.update(evidenceAt(60_000)).displayScore;
    expect(before).toBe(100);

    // A step change: from a textbook delivery to an unintelligible one, in one
    // frame. The underlying metrics jump; the glass must not.
    const collapsed: FixtureOverrides = {
      pace: { wpm: 300, state: 'fast' },
      rates: { audibleWpm: 300 },
      pauses: [],
      voicedMsInWindow: 29_700,
      cadence: { eligibleBoundaries: 8, shapedBoundaries: 0 },
      pitch: { spanSemitones: 0.5, iqrSemitones: 0.2 },
      energy: { rangeDb: 0.5 },
    };

    let previous = before as number;
    let previousMs = 60_000;
    for (let now = 60_000 + TICK_MS; now <= 70_000; now += TICK_MS) {
      const state = engine.update(evidenceAt(now, collapsed));
      const current = state.displayScore as number;
      const allowed =
        DEFAULT_DELIVERY_SCORE_OPTIONS.visibleMaxDeltaPerSecond * ((now - previousMs) / 1000);
      expect(Math.abs(current - previous)).toBeLessThanOrEqual(allowed + 1e-9);
      previous = current;
      previousMs = now;
    }
    // Ten seconds at 2.5 points/second is 25 points, so the score has moved and
    // the cap is not simply freezing it.
    expect(previous).toBeLessThan(80);
    expect(previous).toBeGreaterThanOrEqual(75);
  });

  it('adopts the first value whole rather than crawling up from zero', () => {
    const engine = new DeliveryScoreEngine();
    engine.noteSpokenWords(1_000, 40, true);
    const state = engine.update(evidenceAt(2_000, { deliveryMsInWindow: 2_000 }));
    expect(state.rawScore).not.toBeNull();
    // The raw score is adopted directly on the first pass; the cap governs
    // movement and there has been none yet.
    expect(engine.snapshot()?.state.rawScore).toBe(state.rawScore);
  });

  it('holds through a pass with no available evidence rather than falling', () => {
    const engine = new DeliveryScoreEngine();
    const settled = run(engine, 0, 60_000);
    const held = engine.update(
      evidenceAt(60_100, {
        suppressed: true,
        pitchReliability: { usable: false, reason: 'insufficient_voiced_audio' },
        energy: { rangeDb: null },
        pitch: { spanSemitones: null, iqrSemitones: null },
      }),
    );
    expect(held.rawScore).not.toBe(0);
    expect(held.displayScore).toBe(settled.displayScore);
  });
});

describe('§9.8 — no permanent dent from a retracted filler', () => {
  it('recovers fully once the event is demoted', () => {
    const engine = new DeliveryScoreEngine();
    const clean = run(engine, 0, 60_000);
    expect(clean.rawScore).toBe(100);

    // Six confirmed "um"s land inside the window at once.
    const ums = Array.from({ length: 6 }, (_, index) =>
      filler({
        kind: 'strict_vocalized',
        audioStartMs: 40_000 + index * 1_000,
        audioEndMs: 40_000 + index * 1_000 + 200,
      }),
    );
    const dented = run(engine, 60_000, 5_000, { fillerEvents: ums });
    expect(dented.rawScore).not.toBeNull();
    expect(dented.rawScore as number).toBeLessThan(95);
    expect(dimension(dented, 'fluency').score as number).toBeLessThan(100);

    // The transcript is revised and every one of them is rejected. The tracker
    // reports them as `rejected`; the engine must simply stop counting them.
    const retracted = ums.map((event) => ({ ...event, confidence: 'rejected' as const }));
    const healed = run(engine, 65_000, 30_000, { fillerEvents: retracted });
    expect(dimension(healed, 'fluency').score).toBe(100);
    expect(healed.rawScore).toBe(100);
    // The displayed number is an EWMA and so approaches rather than snaps, but
    // it must come back — a permanent dent would leave it parked at the dented
    // value forever however long the take ran afterwards.
    expect(healed.displayScore as number).toBeGreaterThan(99);
    expect(healed.displayScore as number).toBeLessThanOrEqual(100);
    const longer = run(engine, 95_000, 60_000, { fillerEvents: retracted });
    expect(longer.displayScore as number).toBeGreaterThan(99.9);
  });

  it('never counts a probable-only detection at all', () => {
    const engine = new DeliveryScoreEngine();
    const probable = Array.from({ length: 6 }, (_, index) =>
      filler({
        kind: 'strict_vocalized',
        confidence: 'probable',
        audioStartMs: 40_000 + index * 1_000,
        audioEndMs: 40_000 + index * 1_000 + 200,
      }),
    );
    const state = run(engine, 0, 60_000, { fillerEvents: probable });
    expect(dimension(state, 'fluency').score).toBe(100);
  });

  it('never counts a filler the script authored', () => {
    const engine = new DeliveryScoreEngine();
    const authored = Array.from({ length: 6 }, (_, index) =>
      filler({
        kind: 'strict_vocalized',
        authoredIntentional: true,
        audioStartMs: 40_000 + index * 1_000,
        audioEndMs: 40_000 + index * 1_000 + 200,
      }),
    );
    const state = run(engine, 0, 60_000, { fillerEvents: authored });
    expect(dimension(state, 'fluency').score).toBe(100);
  });
});

describe('§15 — recording faults are not delivery faults', () => {
  const problems = ['clipping', 'noisy', 'low_level', 'no_signal', 'disconnected'] as const;

  it.each(problems)('a %s microphone never lowers a dimension score', (status) => {
    const clean = new DeliveryScoreEngine();
    const faulty = new DeliveryScoreEngine();
    const cleanState = run(clean, 0, 60_000);
    const faultyState = run(faulty, 0, 60_000, { microphone: { status, sustained: true } });

    for (const entry of faultyState.dimensions) {
      const reference = dimension(cleanState, entry.dimension).score;
      if (entry.score === null || reference === null) continue;
      expect(entry.score).toBeGreaterThanOrEqual(reference);
    }
    expect(faultyState.confidence).toBeLessThan(cleanState.confidence);
  });

  const survivable = ['clipping', 'noisy', 'low_level'] as const;

  it.each(survivable)('a %s microphone leaves the displayed number untouched', (status) => {
    const clean = new DeliveryScoreEngine();
    const faulty = new DeliveryScoreEngine();
    const cleanState = run(clean, 0, 60_000);
    const faultyState = run(faulty, 0, 60_000, { microphone: { status, sustained: true } });

    // Not "no worse" — identical. A fault that shaved even a point off the
    // glass would be §15's forbidden "mechanically subtract 15 delivery
    // points", just quieter.
    expect(faultyState.rawScore).toBe(cleanState.rawScore);
    expect(faultyState.displayScore).toBe(cleanState.displayScore);
    expect(faultyState.confidence).toBeLessThan(cleanState.confidence);
  });

  it('suppresses the loudness submetric on a clipping microphone instead of scoring it low', () => {
    const engine = new DeliveryScoreEngine();
    const state = run(engine, 0, 60_000, {
      microphone: { status: 'clipping', sustained: true },
      // A compressed signal shows almost no dynamic range. The speaker has not
      // become monotone; the recording has stopped being able to tell.
      energy: { rangeDb: 0.5, degraded: true, clippedFrameRatio: 0.4 },
    });
    const variety = dimension(state, 'variety');
    // Pitch still carries the dimension; loudness is simply absent, so the
    // score stays at 100 and only the confidence falls.
    expect(variety.score).toBe(100);
    expect(variety.confidence).toBeLessThan(1);
    expect(variety.confidence).toBeGreaterThan(0);
  });

  it('fades the score out rather than down when the signal disappears', () => {
    const engine = new DeliveryScoreEngine();
    run(engine, 0, 60_000);
    const lost = engine.update(
      evidenceAt(60_100, { microphone: { status: 'disconnected', sustained: true } }),
    );
    expect(lost.confidence).toBe(0);
    expect(lost.tier).toBe('warming_up');
    expect(lost.displayScore).toBeNull();
    // And the underlying score is untouched: nothing about the speaker changed.
    expect(lost.rawScore).toBe(100);
  });
});

describe('§9.7 — confidence and the tier ladder', () => {
  it('starts in warming_up and never shows a score there', () => {
    const engine = new DeliveryScoreEngine();
    const first = engine.update(evidenceAt(100, { deliveryMsInWindow: 100, voicedMsInWindow: 80 }));
    expect(first.tier).toBe('warming_up');
    expect(first.displayScore).toBeNull();
    expect(first.displayScore).not.toBe(0);
  });

  it('cannot reach confident before the speaker has been calibrated', () => {
    const engine = new DeliveryScoreEngine();
    const early = run(engine, 0, 8_000, {
      pitchReliability: { usableVoicedMs: 4_000 },
    });
    expect(early.tier).not.toBe('confident');
    const late = run(engine, 8_000, 40_000, { pitchReliability: { usableVoicedMs: 60_000 } });
    expect(late.tier).toBe('confident');
  });
});

describe('§9.6 — the weak dimension is named', () => {
  it('points at the dimension actually dragging, not the lowest-weighted one', () => {
    const engine = new DeliveryScoreEngine();
    const state = run(engine, 0, 60_000, (nowMs) => ({
      fillerEvents: Array.from({ length: 12 }, (_, index) =>
        filler({
          kind: 'strict_vocalized',
          audioStartMs: Math.max(0, nowMs - 28_000 + index * 2_000),
          audioEndMs: Math.max(0, nowMs - 28_000 + index * 2_000) + 200,
        }),
      ),
    }));
    expect(state.weakestDimension).toBe('fluency');
    expect(dimension(state, 'fluency').score as number).toBeLessThan(60);
    // And the weak term has pulled the total below the plain mean.
    const snapshot = engine.snapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot?.mean).not.toBeNull();
    expect(state.rawScore as number).toBeLessThan(snapshot?.mean as number);
  });
});

describe('determinism and take boundaries', () => {
  it('replays to identical numbers', () => {
    const first = new DeliveryScoreEngine();
    const second = new DeliveryScoreEngine();
    const a = run(first, 0, 30_000);
    const b = run(second, 0, 30_000);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('carries nothing across a take pass boundary', () => {
    const engine = new DeliveryScoreEngine();
    const settled = run(engine, 0, 60_000);
    expect(settled.displayScore).toBe(100);

    // A second pass immediately after the first, on a *worse* delivery. The
    // smoothed value from pass one must not survive: if it did, the rate cap
    // would let the new pass open at 97.5 and crawl down from a score that
    // belonged to a different performance.
    const collapsed: FixtureOverrides = {
      pace: { wpm: 300, state: 'fast' },
      rates: { audibleWpm: 300 },
      pauses: [],
      voicedMsInWindow: 29_700,
      cadence: { eligibleBoundaries: 8, shapedBoundaries: 0 },
      pitch: { spanSemitones: 0.5, iqrSemitones: 0.2 },
      energy: { rangeDb: 0.5 },
    };
    let state: DeliveryScoreState | null = null;
    for (let now = 60_100; now <= 61_000; now += TICK_MS) {
      engine.noteSpokenWords(now, 2, true);
      state = engine.update({ ...evidenceAt(now, collapsed), takePassId: 'pass-2' });
    }
    const fresh = state as DeliveryScoreState;
    expect(fresh.rawScore as number).toBeLessThan(50);
    expect(fresh.displayScore as number).toBeLessThan(50);
  });

  it('starts a new take pass in warming_up when there is nothing to judge', () => {
    const engine = new DeliveryScoreEngine();
    run(engine, 0, 60_000);
    const fresh = engine.update({
      ...evidenceAt(60_100, { deliveryMsInWindow: 100, voicedMsInWindow: 0 }),
      takePassId: 'pass-2',
    });
    expect(fresh.displayScore).toBeNull();
    expect(fresh.tier).toBe('warming_up');
  });
});
