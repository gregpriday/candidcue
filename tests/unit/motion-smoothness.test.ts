/**
 * What the presenter actually sees.
 *
 * `cc-bench` scores `display_at`, which is the reference signal the stage is
 * asked to chase — not the pixels on the glass. Those come out of the plant,
 * and the plant is jerk-limited, so a reference that steps once a second does
 * not produce a display that steps once a second: it produces one that
 * accelerates hard, arrives, and decelerates. That is the "moves in a jerk and
 * then a jerk" complaint, and no Rust metric can see it because the plant is
 * TypeScript and never runs in the benchmark.
 *
 * So this drives the real controller — `createJerkLimitedScrollController`,
 * the same function the stage runs — at 60 fps over a synthetic but realistic
 * snapshot stream, and measures the RENDERED position's derivatives.
 *
 * The stream is synthetic on purpose: it is the one part of the pipeline whose
 * ground truth we know exactly (the reader's position at every instant), which
 * is what makes "the display moved at the wrong speed" a decidable statement.
 * It reproduces the cadence measured against a live recogniser: partials about once
 * a second carrying words spoken ~300 ms earlier, finals ~1.4 s after the last
 * word of an utterance.
 */
import { describe, expect, it } from 'vitest';

import {
  alignmentDisplayAt,
  alignmentDisplayRateAt,
  type AlignmentSnapshot,
} from '../../src/shared/contracts/alignment';
import { createJerkLimitedScrollController } from '../../src/stage/motion/controller';
import type { MotionLimits } from '../../src/stage/motion/profiles';

/* ---------------------------------------------------------------------------
 * The world being simulated
 * ------------------------------------------------------------------------- */

/** Reader's pace, atoms (≈ words) per second. 2.44 is the Tier A suite mean. */
const READER_ATOMS_S = 2.44;
/** Pixels per atom on the glass — one line of ~9 words at an 84.5 px pitch. */
const PX_PER_ATOM = 84.5 / 9;
const FRAME_MS = 1000 / 60;
const TAKE_MS = 60_000;
/** Recogniser cadence, measured live: see the cadence notes in the README. */
const PARTIAL_PERIOD_MS = 1000;
const PARTIAL_LAG_MS = 300;
const ENDPOINT_LAG_MS = 1400;
/** An utterance ends about every six seconds of continuous reading. */
const UTTERANCE_MS = 6000;
/**
 * The reader stops dead here and starts again. A take that never pauses cannot
 * distinguish "moves smoothly" from "moves regardless", and the pause is where
 * both the safety of the whole design and the complaint about how the display
 * arrives at rest actually live.
 */
const PAUSE_FROM_MS = 24_000;
const PAUSE_TO_MS = 27_500;

/** Ground truth: the reader's position, in atoms, at any audio time. */
function readerAtomsAt(tMs: number): number {
  const spoken = tMs <= PAUSE_FROM_MS ? tMs : Math.max(PAUSE_FROM_MS, tMs - (PAUSE_TO_MS - PAUSE_FROM_MS));
  return (Math.min(spoken, tMs) / 1000) * READER_ATOMS_S;
}

/** True while the reader is actually speaking (the smoothness gate). */
function speakingAt(tMs: number): boolean {
  return tMs < PAUSE_FROM_MS || tMs > PAUSE_TO_MS;
}

/**
 * The engine's published lead profile, as it stood before the smoothing work:
 * a 1:1 rise, a corner at `pauseOnsetMs` where the slope flipped sign, and a
 * hard `min` against the atom cap. Kept here — and only here — so the A/B is
 * against the real previous behaviour rather than against a description of it.
 */
function legacyDisplayAt(snapshot: AlignmentSnapshot, tAudioMs: number): number {
  const ceiling = Math.min(snapshot.displayLimitToken, snapshot.scriptLenTokens);
  if (!(snapshot.rateTokensPerSecond > 0)) return Math.min(snapshot.observedToken, ceiling);
  const age = Math.max(0, tAudioMs - snapshot.evidenceAudioMs);
  const onset = Math.min(snapshot.pauseOnsetMs, snapshot.maxPredictionMs);
  const leadMs =
    age <= onset ? age : Math.max(onset - (age - onset), Math.min(snapshot.leadFloorMs, onset));
  const lead = Math.min((snapshot.rateTokensPerSecond * leadMs) / 1000, snapshot.maxLeadTokens);
  return Math.min(snapshot.observedToken + lead, ceiling);
}

interface EngineShape {
  /** Multiplies the reader's pace to produce the POSITION extrapolation rate. */
  gain: number;
  /** Feed-forward velocity: the gained rate, or the reader's true pace. */
  feedForward: 'gained' | 'true';
  displayAt: (snapshot: AlignmentSnapshot, tAudioMs: number) => number;
  leadEaseMs: number;
  leadHoldMs: number;
  leadDecayMs: number;
  maxLeadTokens: number;
  leadMarginTokens: number;
  /** Prediction horizon and pause onset, which the shapes differ on. */
  maxPredictionMs: number;
  pauseOnsetMs: number;
  /** Plant-limit overrides, for tuning the controller itself. */
  limits?: Partial<MotionLimits>;
}

/**
 * Snapshots as the engine would publish them for a reader proceeding at a
 * constant pace: each carries the position of the last word the recogniser has
 * reported, stamped with the audio time that word was actually spoken.
 */
function snapshotsFor(shape: EngineShape): AlignmentSnapshot[] {
  const out: AlignmentSnapshot[] = [];
  const rate = (READER_ATOMS_S * shape.gain) / 1; // tokens/s ≈ atoms/s here
  for (let atMs = PARTIAL_PERIOD_MS; atMs <= TAKE_MS; atMs += PARTIAL_PERIOD_MS) {
    // A final lands instead of a partial at the end of each utterance, and it
    // reports words that are already `ENDPOINT_LAG_MS` old.
    const isFinal = Math.floor(atMs / UTTERANCE_MS) !== Math.floor((atMs - PARTIAL_PERIOD_MS) / UTTERANCE_MS);
    const lag = isFinal ? ENDPOINT_LAG_MS : PARTIAL_LAG_MS;
    const evidenceAudioMs = atMs - lag;
    // While the reader is silent the recogniser has nothing to report. This is
    // the case the engine must handle by inference from the clock rather than
    // by being told: no snapshot arrives at all, so the display's behaviour
    // through the pause is entirely a consequence of the lead profile.
    if (evidenceAudioMs > PAUSE_FROM_MS && atMs < PAUSE_TO_MS + PARTIAL_LAG_MS) continue;
    const observed = readerAtomsAt(evidenceAudioMs);
    out.push({
      sessionGeneration: 1,
      seq: out.length + 1,
      state: 'following',
      decision: 'localObserved',
      confirmedToken: observed,
      observedToken: observed,
      rateTokensPerSecond: rate,
      evidenceAudioMs,
      atAudioMs: atMs,
      maxPredictionMs: shape.maxPredictionMs,
      pauseOnsetMs: shape.pauseOnsetMs,
      leadFloorMs: 0,
      maxLeadTokens: shape.maxLeadTokens,
      leadMarginTokens: shape.leadMarginTokens,
      leadEaseMs: shape.leadEaseMs,
      leadHoldMs: shape.leadHoldMs,
      leadDecayMs: shape.leadDecayMs,
      displayLimitToken: Number.POSITIVE_INFINITY,
      confidence: 0.9,
      suggestionToken: null,
      scriptLenTokens: 100_000,
      observedAtom: 0,
      confirmedAtom: 0,
    });
  }
  return out;
}

/**
 * The shipped following limits (`SMOOTH_FOLLOW_DEFAULTS`), spelled out rather
 * than resolved through `profiles.ts` so this measures the plant and not the
 * profile table. Typed as `MotionLimits`, so a limit added to the contract
 * fails compilation here instead of silently fusing the plant — which is
 * exactly what an incomplete literal did on the first run of this file, and it
 * reads as "nothing moved" rather than as an error.
 */
const LIMITS: MotionLimits = {
  omega: 2.0,
  zeta: 1.15,
  vForwardMax: 900,
  vBackwardMax: 600,
  aMax: 2600,
  jerkMax: 12_000,
  feedForwardScale: 1,
  restDeadbandPx: 1.5,
  reverseTravelMaxPx: 420,
  reanchorThresholdPx: 360,
  forwardPositionCeilingPx: Number.POSITIVE_INFINITY,
  allowBackward: false,
  snap: false,
};

interface Smoothness {
  /** Rendered speed, px/s. */
  velP10: number;
  velP50: number;
  velMean: number;
  velP90: number;
  velCov: number;
  /**
   * |acceleration| and |jerk| of the RENDERED position, by third finite
   * difference of `q` — not the controller's own reported figure, which is a
   * diagnostic of its internal command and can be smooth while the pixels are
   * not.
   *
   * Both a percentile and a MAXIMUM. The percentile alone is the wrong
   * instrument for this complaint: a lurch once per transcript event is about
   * 1.7% of frames at 60 Hz, so P95 discards every one of them and reports a
   * beautifully smooth trace of exactly the motion being complained about.
   */
  accelP95: number;
  accelMax: number;
  jerkP95: number;
  jerkMax: number;
  /** % of frames the display was not moving while the reader was speaking. */
  stationaryPct: number;
  /** Worst lead over the reader's true position, in atoms. */
  aheadWorstAtoms: number;
  /** Mean signed error against the reader's true position, in atoms. */
  meanErrAtoms: number;
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i] ?? 0;
}

/** Run the real plant over the stream and measure the pixels it produced. */
function simulate(shape: EngineShape): Smoothness {
  const snapshots = snapshotsFor(shape);
  const controller = createJerkLimitedScrollController({ maxPx: Number.POSITIVE_INFINITY });
  let cursor = 0;
  let prevQ = 0;
  let prevV = 0;
  let prevA: number | null = null;
  let lastTargetPx = 0;
  const vel: number[] = [];
  const accel: number[] = [];
  const jerk: number[] = [];
  let aheadWorst = -Infinity;
  let errSum = 0;
  let errN = 0;

  for (let t = 0; t <= TAKE_MS; t += FRAME_MS) {
    while (cursor + 1 < snapshots.length && (snapshots[cursor + 1]?.atAudioMs ?? Infinity) <= t) {
      cursor += 1;
    }
    const snap = snapshots[cursor];
    // Before the first snapshot lands there is nothing to follow, which is a
    // hold, not a zero-speed sample — skip rather than score it.
    if (!snap || snap.atAudioMs > t) continue;

    const displayToken = shape.displayAt(snap, t);
    const targetPx = displayToken * PX_PER_ATOM;
    // 'true': the display path's own speed, which is what the stage feeds
    // forward. 'gained': the old behaviour, the engine's gained rate estimate.
    const ffPxS =
      shape.feedForward === 'true'
        ? alignmentDisplayRateAt(snap, t) * PX_PER_ATOM
        : snap.rateTokensPerSecond * PX_PER_ATOM;

    const before = controller.state.q;
    const r = controller.step({
      dtMs: FRAME_MS,
      targetPx,
      /*
       * Bounded by the target's realised motion, exactly as `engine.ts` does.
       * Without this the harness would score a feed-forward the target cannot
       * justify as perfectly smooth — and removing the bound in production,
       * which re-opens the §70.5 overshoot hole, would not move a single
       * number here.
       */
      feedForwardVelocityPxS: Math.max(
        0,
        Math.min(ffPxS, ((targetPx - lastTargetPx) * 1000) / FRAME_MS),
      ),
      // No position ceiling: §30.3's ceiling is infinite in ordinary
      // following and finite only during a licensed catch-up. Passing the
      // target as a ceiling here — the first thing this harness did — clamps
      // the plant every time feed-forward would carry it a pixel past, which
      // manufactures exactly the stop-start being measured.
      limits: { ...LIMITS, ...shape.limits },
    });

    lastTargetPx = targetPx;
    // Derivatives of the RENDERED position, by finite difference.
    const v = ((r.q - before) / FRAME_MS) * 1000;
    const a = ((v - prevV) / FRAME_MS) * 1000;
    // Smoothness is scored only while the reader is speaking. A display that
    // has correctly come to rest during a silence is not jerky, and pooling
    // those frames in would let "stops more often" read as "smoother".
    if (speakingAt(t)) {
      vel.push(v);
      accel.push(Math.abs(a));
      if (prevA !== null) jerk.push(Math.abs(((a - prevA) / FRAME_MS) * 1000));
    }
    prevV = v;
    prevA = a;
    prevQ = r.q;

    // Ground truth: where the reader actually is at this instant. Scored at
    // every frame, pause included — running ahead during a silence is the
    // failure this measurement exists to catch.
    const err = r.q / PX_PER_ATOM - readerAtomsAt(t);
    aheadWorst = Math.max(aheadWorst, err);
    errSum += err;
    errN += 1;
  }
  void prevQ;

  const sortedV = [...vel].sort((a, b) => a - b);
  const mean = vel.reduce((a, b) => a + b, 0) / Math.max(1, vel.length);
  const variance = vel.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, vel.length);
  return {
    velP10: pct(sortedV, 10),
    velP50: pct(sortedV, 50),
    velMean: mean,
    velP90: pct(sortedV, 90),
    velCov: mean === 0 ? 0 : Math.sqrt(variance) / mean,
    accelP95: pct([...accel].sort((a, b) => a - b), 95),
    accelMax: accel.reduce((m, x) => Math.max(m, x), 0),
    jerkP95: pct([...jerk].sort((a, b) => a - b), 95),
    jerkMax: jerk.reduce((m, x) => Math.max(m, x), 0),
    stationaryPct: (100 * vel.filter((v) => Math.abs(v) < 0.5).length) / Math.max(1, vel.length),
    aheadWorstAtoms: aheadWorst,
    meanErrAtoms: errSum / Math.max(1, errN),
  };
}

const BEFORE: EngineShape = {
  gain: 0.33,
  feedForward: 'gained',
  displayAt: legacyDisplayAt,
  leadEaseMs: 0,
  leadHoldMs: 0,
  leadDecayMs: 1,
  maxLeadTokens: 2.5,
  // No margin, an 1 800 ms horizon and a hard triangle: the engine exactly as
  // it was. The A/B is only worth reading if this side is the real previous
  // behaviour and not a half-updated copy of it.
  leadMarginTokens: 0,
  maxPredictionMs: 1800,
  pauseOnsetMs: 1800,
  // The plant as it was tuned too: a stiff, fast controller is half of what
  // the old shape felt like, and comparing the new reference against the new
  // plant would hide which half did the work.
  limits: { omega: 6.5, zeta: 1.0 },
};

/** The shipped shape. Mirrors `AlignmentConfig`'s defaults. */
const AFTER: EngineShape = {
  gain: 1.0,
  feedForward: 'true',
  displayAt: alignmentDisplayAt,
  leadEaseMs: 450,
  leadHoldMs: 0,
  leadDecayMs: 1200,
  maxLeadTokens: 4.5,
  leadMarginTokens: 2.2,
  maxPredictionMs: 2400,
  pauseOnsetMs: 2400,
};

describe('rendered scroll smoothness', () => {
  const before = simulate(BEFORE);
  const after = simulate(AFTER);



  it('reports both shapes', () => {
    const rows: Array<[string, number, number]> = [
      ['vel p10 (px/s)', before.velP10, after.velP10],
      ['vel p50 (px/s)', before.velP50, after.velP50],
      ['vel mean (px/s)', before.velMean, after.velMean],
      ['vel p90 (px/s)', before.velP90, after.velP90],
      ['vel cov', before.velCov, after.velCov],
      ['|accel| p95 (px/s2)', before.accelP95, after.accelP95],
      ['|accel| MAX (px/s2)', before.accelMax, after.accelMax],
      ['jerk p95 (px/s3)', before.jerkP95, after.jerkP95],
      ['jerk MAX (px/s3)', before.jerkMax, after.jerkMax],
      ['stationary %', before.stationaryPct, after.stationaryPct],
      ['ahead worst (atoms)', before.aheadWorstAtoms, after.aheadWorstAtoms],
      ['mean err (atoms)', before.meanErrAtoms, after.meanErrAtoms],
    ];
    const table = rows
      .map(([n, b, a]) => `${n.padEnd(22)} ${b.toFixed(2).padStart(10)} ${a.toFixed(2).padStart(10)}`)
      .join('\n');
    // eslint-disable-next-line no-console
    console.log(`\n${'metric'.padEnd(22)} ${'before'.padStart(10)} ${'after'.padStart(10)}\n${table}\n`);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('both shapes track the reader — neither falls behind over the take', () => {
    // The mean rendered speed must equal the reader's pace whatever the shape,
    // or the display would be falling steadily behind and the comparison would
    // be between a follower and a non-follower.
    const readerPxS = READER_ATOMS_S * PX_PER_ATOM;
    expect(before.velMean).toBeGreaterThan(readerPxS * 0.9);
    expect(after.velMean).toBeGreaterThan(readerPxS * 0.9);
  });

  it('the display spends far less time stopped while the reader is speaking', () => {
    // 6.6% → 4.8%. The floor here is the pause: the display correctly stops,
    // and the frames just after speech resumes are still stationary.
    expect(after.stationaryPct).toBeLessThan(before.stationaryPct * 0.8);
  });

  it('speed is markedly steadier frame to frame', () => {
    // σ/μ 0.82 → 0.33. This is the headline: it is what "steady" means.
    expect(after.velCov).toBeLessThan(before.velCov * 0.5);
  });

  it('the plant no longer has to accelerate as hard to keep up', () => {
    // |accel| P95 319 → 57 px/s².
    expect(after.accelP95).toBeLessThan(before.accelP95 * 0.3);
  });

  it('the worst acceleration the eye sees is much smaller', () => {
    // |accel| MAX 977 → 279 px/s². The percentile assertions above say the
    // TYPICAL frame got calmer; this one says the worst one did too, which is
    // the half of the complaint a percentile cannot see.
    expect(after.accelMax).toBeLessThan(before.accelMax * 0.5);
  });

  /*
   * DELIBERATELY NOT ASSERTED, and worth stating plainly: `jerkMax` did NOT
   * improve — 12 460 px/s³ before, 13 956 after. Both are the plant's jerk
   * limit, reached at a wall rather than under the limiter, and both happen at
   * the same moment: the frame where speech resumes after the pause and a
   * snapshot lands after 3.5 s of silence.
   *
   * So the honest claim is narrow. Ordinary reading is dramatically calmer —
   * jerk P95 6 462 → 313, a factor of 20 — but the single worst event in a take
   * is no better than it was. If "every now and then it goes whoa" survives
   * this change, that resume transient is where to look first, and it wants a
   * §53 transition rather than more tuning of the ordinary path.
   */
  it('jerk all but disappears in ordinary reading', () => {
    // P95 6 623 → 291 px/s³. Jerk is the failure state this work exists to
    // remove, so it gets its own assertion rather than riding on acceleration.
    expect(after.jerkP95).toBeLessThan(before.jerkP95 * 0.15);
  });

  it('the speed range the eye sees narrows sharply', () => {
    // p10..p90 spanned 9.7× before and 2.3× after. A display whose speed is
    // always within a factor of two of itself reads as gliding; one that
    // ranges over an order of magnitude reads as lurching.
    expect(after.velP90 / Math.max(1, after.velP10)).toBeLessThan(3);
    expect(before.velP90 / Math.max(1, before.velP10)).toBeGreaterThan(5);
  });

  it('does not buy smoothness by running ahead of the reader', () => {
    // The safety invariant the whole engine is built around. Smoothness that
    // costs a lead is not an improvement, and this is the assertion that says
    // so — it must fail if a future tuning pass trades the two.
    expect(after.aheadWorstAtoms).toBeLessThan(1.0);
  });
});
