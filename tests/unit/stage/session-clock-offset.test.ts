/**
 * The stage's session-clock offset (companion §9.1, §26.2, §27).
 *
 * Frames carry session-relative timestamps produced by the tracking worker's
 * `SessionClock`; the stage window only has `performance.now()`. One number
 * bridges the two domains, and everything time-shaped downstream is measured
 * through it: evidence age, the prediction horizon, the §26.2 staleness gate,
 * and transition-directive lifetimes.
 *
 * These tests exercise the real `SessionClock` from the worker side against the
 * real engine, because the estimator's correctness is a JOINT property. The
 * stage tracks the MINIMUM observed offset and nothing else; that is only sound
 * because `sessionTimeMs` is a monotone re-basing of the producer's clock, which
 * makes every sample `trueOffset + transportDelay` with a hard floor at zero
 * delay. The scenarios below are the ones that used to move the offset — a
 * wall-clock step in each direction, and a sleep/wake — and the assertions are
 * about the residual the estimator is left carrying.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SMOOTH_FOLLOW_PROFILE as DEFAULT_PROFILE,
  type SemanticMotionFrame,
} from '../../../src/shared/contracts';
import { SessionClock } from '../../../src/shared/tracking/session-clock';
import {
  buildRenderedLineMap,
  createStageMotionEngine,
  identityUnitAxis,
  limitsForState,
  type MotionSource,
  type StageMotionEngine,
  type StageRenderedLineMap,
} from '../../../src/stage/motion';
import { fixtureFingerprint, syntheticLayout } from '../../fixtures/layout';

/** `performance.now()` in the stage window at the moment the session starts. */
const STAGE_EPOCH = 12_345;
/** `Date.now()` in the control window at the same moment. */
const PRODUCER_EPOCH = 1_780_000_000_000;
/** The worker's own emission cadence, and so the size of a re-base residual. */
const WORKER_TICK_MS = 50;

const FRAME_STALE_MS = 3000;

function mapFor(layoutGeneration = 1) {
  const layout = syntheticLayout({
    blocks: [
      { kind: 'heading', tokens: 4 },
      { kind: 'paragraph', tokens: 80 },
      { kind: 'paragraph', tokens: 80 },
    ],
    columnWidthPx: 800,
    startY: 800,
  });
  const map = buildRenderedLineMap({
    fingerprint: fixtureFingerprint({ layoutGeneration }),
    tokens: layout.tokens,
    blocks: layout.blocks,
    readingLineStartY: 400,
    lineHeightPx: layout.lineHeightPx,
    viewportHeightPx: 1080,
    maxScrollPx: layout.contentHeightPx,
  });
  return { map, layout };
}

function frame(overrides: Partial<SemanticMotionFrame> = {}): SemanticMotionFrame {
  return {
    sessionId: 'session-a',
    sessionGeneration: 1,
    scriptCompileHash: 'hash-a',
    layoutGeneration: 1,
    revision: 1,
    epoch: 1,
    sessionTimeMs: 0,
    estimatedUnit: 0,
    committedUnit: 0,
    velocityUnitsPerSecond: 3,
    accelerationUnitsPerSecond2: 0,
    positionVariance: 0.2,
    confidence: 0.92,
    sectionId: 'section:0',
    tokenIndex: 0,
    sentenceId: 's0',
    blockId: 'b0',
    state: 'following',
    behavior: 'normal',
    finalEvidence: true,
    motionProfileId: 'default-v1',
    ...overrides,
  };
}

function makeEngine(map: StageRenderedLineMap, maxScrollPx: number): StageMotionEngine {
  const engine = createStageMotionEngine({ unitAxis: identityUnitAxis() });
  engine.configureSession(
    {
      sessionId: 'session-a',
      sessionGeneration: 1,
      scriptCompileHash: 'hash-a',
      layoutGeneration: map.generation,
    },
    STAGE_EPOCH,
  );
  engine.setLineMap(map);
  engine.setBounds(0, maxScrollPx);
  return engine;
}

/* ------------------------------------------------------------------------- *
 * Arrival-instant probe.
 *
 * Deliver one frame and run exactly one display frame at the same instant, so
 * the age the engine reports IS the transport delay that arrival experienced —
 * with no display-cadence quantisation in the way. This measures the offset
 * estimator itself; the motion world below measures what it does to pixels.
 * ------------------------------------------------------------------------- */
function probeAgeMs(
  engine: StageMotionEngine,
  arrivalMs: number,
  sessionTimeMs: number,
  unit: number,
  revision: number,
): number {
  engine.receiveFrame(
    frame({
      revision,
      sessionTimeMs,
      estimatedUnit: unit,
      committedUnit: Math.max(0, unit - 1),
      tokenIndex: Math.floor(unit),
    }),
    arrivalMs,
  );
  engine.frame(arrivalMs);
  const prediction = engine.lastPrediction;
  expect(prediction).not.toBeNull();
  return prediction?.ageMs ?? Number.NaN;
}

/**
 * Deterministic transport jitter, in ms. Real cross-window delivery is a floor
 * plus a tail, so the table has a genuine minimum and a spread above it.
 */
const JITTER_MS = [0, 12, 41, 7, 33, 19, 45, 3, 28, 9, 37, 15, 24, 5, 31, 11];
function jitterAt(tick: number): number {
  return JITTER_MS[tick % JITTER_MS.length] ?? 0;
}

describe('the offset estimator (§9.1)', () => {
  it('settles on the transport floor and stays a constant under ordinary jitter', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);

    // The first arrival is the best-case one, so the estimator recovers the
    // true offset exactly and every later age IS that arrival's transport delay.
    expect(probeAgeMs(engine, STAGE_EPOCH, 0, 0, 1)).toBeCloseTo(0, 9);

    for (let k = 1; k <= 400; k++) {
      const sessionTimeMs = WORKER_TICK_MS * k;
      const delay = jitterAt(k);
      const age = probeAgeMs(
        engine,
        STAGE_EPOCH + sessionTimeMs + delay,
        sessionTimeMs,
        (3 * sessionTimeMs) / 1000,
        k + 1,
      );
      // Exact, on every one of 400 arrivals: the offset does not wander, creep,
      // or relax toward the samples. A drift term of any size fails here within
      // a handful of frames, and its steady state understates age by the mean
      // transport delay — eventually reporting an ordinary arrival as fresher
      // than the instant it was stamped.
      expect(age).toBeCloseTo(delay, 9);
      expect(age).toBeGreaterThanOrEqual(0);
    }
  });

  it('lowers the offset on the frame a faster arrival appears, not slowly', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);

    // A run where the best arrival so far took 40 ms: ages are measured from
    // that floor, so a typical arrival reads as fresh.
    for (let k = 0; k < 20; k++) {
      const sessionTimeMs = WORKER_TICK_MS * k;
      const age = probeAgeMs(
        engine,
        STAGE_EPOCH + sessionTimeMs + 40,
        sessionTimeMs,
        (3 * sessionTimeMs) / 1000,
        k + 1,
      );
      expect(age).toBeCloseTo(0, 9);
    }

    // One arrival crosses in 5 ms. That is a better estimate of the true
    // offset, and it is adopted on this frame rather than approached.
    const fastAt = WORKER_TICK_MS * 20;
    expect(probeAgeMs(engine, STAGE_EPOCH + fastAt + 5, fastAt, 60, 21)).toBeCloseTo(0, 9);

    // Ordinary arrivals now report their true 40 ms of age against the new floor.
    const afterAt = WORKER_TICK_MS * 21;
    expect(probeAgeMs(engine, STAGE_EPOCH + afterAt + 40, afterAt, 63, 22)).toBeCloseTo(35, 9);
  });

  it('absorbs a forward wall-clock step on the first frame after it', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    const clock = new SessionClock();

    let producerSkewMs = 0;
    for (let k = 0; k <= 60; k++) {
      // An NTP correction — or a laptop waking with wall time advanced while
      // the stage's monotonic clock slept. Either way the producer's clock
      // gains five seconds that no speech happened in.
      if (k === 30) producerSkewMs += 5000;
      const realMs = WORKER_TICK_MS * k;
      const sessionTimeMs = clock.advance(PRODUCER_EPOCH + realMs + producerSkewMs);
      const delay = jitterAt(k);
      const age = probeAgeMs(
        engine,
        STAGE_EPOCH + realMs + delay,
        sessionTimeMs,
        (3 * realMs) / 1000,
        k + 1,
      );
      // Session time steps forward with the producer, so every sample steps
      // DOWN by the same five seconds. The minimum therefore adopts a new floor
      // on the very first arrival after the step, and the ONLY cost is that the
      // floor has to be rediscovered from the arrivals that follow: age is
      // briefly understated and never — on any frame — overstated. Overstating
      // is the direction that inflates evidence age into the staleness gate and
      // freezes the glass; there is no residual of that kind to relax away.
      expect(age).toBeGreaterThanOrEqual(0);
      expect(age).toBeLessThanOrEqual(delay + 1e-9);
      // JITTER_MS carries a zero, so a full jitter period past the step the
      // floor is back and ages are exact again.
      if (k > 30 + JITTER_MS.length) expect(age).toBeCloseTo(delay, 9);
    }
    expect(clock.rebaseCount).toBe(0);
  });

  it('carries at most one worker tick of residual across a backward wall-clock step', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    const clock = new SessionClock();

    let producerSkewMs = 0;
    let worstResidualMs = 0;
    for (let k = 0; k <= 200; k++) {
      if (k === 30) producerSkewMs -= 5000;
      const realMs = WORKER_TICK_MS * k;
      const sessionTimeMs = clock.advance(PRODUCER_EPOCH + realMs + producerSkewMs);
      const delay = jitterAt(k);
      const age = probeAgeMs(
        engine,
        STAGE_EPOCH + realMs + delay,
        sessionTimeMs,
        (3 * realMs) / 1000,
        k + 1,
      );
      worstResidualMs = Math.max(worstResidualMs, age - delay);
      expect(age).toBeGreaterThanOrEqual(delay - 1e-9);
    }

    // The worker re-bases rather than clamping, so session time stays monotone
    // and loses only the interval since its previous stamp. A minimum will not
    // rise, so that one tick is permanent — and one tick is the whole cost,
    // against a 750 ms horizon and a 3 s staleness gate.
    expect(clock.rebaseCount).toBe(1);
    expect(worstResidualMs).toBeGreaterThan(0);
    expect(worstResidualMs).toBeLessThanOrEqual(WORKER_TICK_MS + 1e-9);
    expect(worstResidualMs).toBeLessThan(DEFAULT_PROFILE.prediction.normalHorizonMs);
  });
});

describe('the §26.2 staleness gate reads through the offset', () => {
  it('leaves the semantic source exactly one staleness window after the stamp', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);

    expect(probeAgeMs(engine, STAGE_EPOCH, 0, 0, 1)).toBeCloseTo(0, 9);
    const lastStampMs = WORKER_TICK_MS * 10;
    const delay = 40;
    const arrivalMs = STAGE_EPOCH + lastStampMs + delay;
    expect(probeAgeMs(engine, arrivalMs, lastStampMs, 1.5, 2)).toBeCloseTo(delay, 9);

    // Age is measured from the STAMP, not from the arrival, so the window
    // closes `delay` earlier in stage time. An offset that had drifted upward
    // would push this boundary later and keep following evidence that is
    // already past the gate.
    const beforeGate = engine.frame(arrivalMs + (FRAME_STALE_MS - delay) - 40);
    expect(beforeGate.source).toBe('semantic');
    const afterGate = engine.frame(arrivalMs + (FRAME_STALE_MS - delay) + 40);
    expect(afterGate.source).toBe('hold');
  });
});

/* ------------------------------------------------------------------------- *
 * The motion world.
 *
 * Three clocks, kept honestly separate:
 *
 *   - `t`, awake real time, which is what the presenter speaks against;
 *   - the stage's `performance.now()`, monotone, which does not advance while
 *     the machine is suspended;
 *   - the control window's `Date.now()`, which is what the worker's
 *     `SessionClock` re-bases and which is the clock that can step.
 * ------------------------------------------------------------------------- */

interface ClockEvent {
  /** Awake-real-time instant the event lands on. */
  atMs: number;
  /** Jump applied to the control window's wall clock. */
  producerStepMs?: number;
  /** Stage-clock time that passes with no display frame (a suspend the stage's clock counted). */
  stageGapMs?: number;
}

interface WorldSample {
  stageNowMs: number;
  q: number;
  source: MotionSource;
  controllerState: string;
}

interface WorldOptions {
  durationMs: number;
  events?: ClockEvent[];
  transportMs?: number;
  unitsPerSecond?: number;
  /**
   * Stamp frames with the raw producer clock instead of the session clock —
   * the pre-770e1cb worker, kept as a contrast so the tests can show which side
   * of the seam the guarantee actually comes from.
   */
  rawProducerStamps?: boolean;
}

function runWorld(engine: StageMotionEngine, options: WorldOptions): WorldSample[] {
  const clock = new SessionClock();
  const displayDtMs = 1000 / 60;
  const unitsPerSecond = options.unitsPerSecond ?? 3;
  const transportMs = options.transportMs ?? 0;
  const events = [...(options.events ?? [])].sort((a, b) => a.atMs - b.atMs);

  let producerSkewMs = 0;
  let stageSkewMs = 0;
  let revision = 0;
  let nextStampAtMs = 0;
  const inflight: Array<{ deliverAtMs: number; frame: SemanticMotionFrame }> = [];
  const trace: WorldSample[] = [];

  for (let t = 0; t <= options.durationMs; t += displayDtMs) {
    while (events.length > 0 && (events[0]?.atMs ?? Infinity) <= t) {
      const event = events.shift();
      producerSkewMs += event?.producerStepMs ?? 0;
      stageSkewMs += event?.stageGapMs ?? 0;
    }
    const stageNowMs = STAGE_EPOCH + t + stageSkewMs;

    if (t >= nextStampAtMs) {
      nextStampAtMs = t + WORKER_TICK_MS;
      const producerMs = PRODUCER_EPOCH + t + producerSkewMs;
      const sessionTimeMs = options.rawProducerStamps
        ? producerMs
        : clock.advance(producerMs);
      // The presenter speaks against awake real time: a wall-clock step or a
      // suspend moves no mouth.
      const unit = (unitsPerSecond * t) / 1000;
      revision += 1;
      inflight.push({
        deliverAtMs: stageNowMs + transportMs,
        frame: frame({
          revision,
          sessionTimeMs,
          estimatedUnit: unit,
          committedUnit: Math.max(0, unit - 1),
          tokenIndex: Math.floor(unit),
          velocityUnitsPerSecond: unitsPerSecond,
        }),
      });
    }
    while (inflight.length > 0 && (inflight[0]?.deliverAtMs ?? Infinity) <= stageNowMs) {
      const due = inflight.shift();
      if (due) engine.receiveFrame(due.frame, stageNowMs);
    }

    const result = engine.frame(stageNowMs);
    trace.push({
      stageNowMs,
      q: result.scrollPx,
      source: result.source,
      controllerState: result.controllerState,
    });
  }
  return trace;
}

/**
 * Realized motion, derived from Δq alone — never from a field the plant stored.
 * Velocity is the position difference over the elapsed display interval and
 * acceleration is the difference of that, so a plant that reported healthy
 * numbers while moving badly would still be caught.
 */
function realizedFromDeltaQ(trace: WorldSample[]) {
  const steps: Array<{ dqPx: number; dtMs: number; vPxS: number }> = [];
  for (let i = 1; i < trace.length; i++) {
    const previous = trace[i - 1];
    const current = trace[i];
    if (!previous || !current) continue;
    const dtMs = current.stageNowMs - previous.stageNowMs;
    if (dtMs <= 0) continue;
    const dqPx = current.q - previous.q;
    steps.push({ dqPx, dtMs, vPxS: (dqPx / dtMs) * 1000 });
  }
  const accelerations: number[] = [];
  for (let i = 1; i < steps.length; i++) {
    const previous = steps[i - 1];
    const current = steps[i];
    if (!previous || !current) continue;
    accelerations.push(((current.vPxS - previous.vPxS) / current.dtMs) * 1000);
  }
  return { steps, accelerations };
}

const FOLLOW_LIMITS = limitsForState('following', DEFAULT_PROFILE, {});

function expectNoVisibleDiscontinuity(trace: WorldSample[]) {
  const { steps, accelerations } = realizedFromDeltaQ(trace);
  expect(steps.length).toBeGreaterThan(100);
  for (const step of steps) {
    // Forward-only following: never a backward pixel, never a teleport.
    expect(step.dqPx).toBeGreaterThanOrEqual(-1e-9);
    expect(step.dqPx).toBeLessThan(30);
    expect(step.vPxS).toBeLessThanOrEqual(FOLLOW_LIMITS.vForwardMax * 1.02);
  }
  for (const a of accelerations) {
    expect(Math.abs(a)).toBeLessThanOrEqual(FOLLOW_LIMITS.aMax * 1.05);
  }
}

/** Worst position disagreement between two runs of the same length. */
function worstDivergencePx(a: WorldSample[], b: WorldSample[]): number {
  expect(a.length).toBe(b.length);
  let worst = 0;
  for (let i = 0; i < a.length; i++) {
    worst = Math.max(worst, Math.abs((a[i]?.q ?? 0) - (b[i]?.q ?? 0)));
  }
  return worst;
}

const WORLD = { durationMs: 8000, transportMs: 20 } as const;

/** The same presenter, the same script, and a clock that never misbehaves. */
function baselineWorld(): WorldSample[] {
  const { map, layout } = mapFor();
  return runWorld(makeEngine(map, layout.contentHeightPx), { ...WORLD });
}

describe('a wall-clock step and a sleep/wake produce no motion artefact', () => {
  it('follows through a forward wall-clock step with no discontinuity', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    const trace = runWorld(engine, {
      ...WORLD,
      events: [{ atMs: 4000, producerStepMs: 5000 }],
    });

    expectNoVisibleDiscontinuity(trace);
    expect(trace[trace.length - 1]?.source).toBe('semantic');
    // Not merely "within limits" — the trajectory is the one the presenter
    // would have got with no step at all, to well under a thousandth of a
    // pixel. Session time and the stage's estimate of it stepped together.
    expect(worstDivergencePx(trace, baselineWorld())).toBeLessThan(0.001);
    // The only path from here to a visible jump is the §70.5 escape hatch.
    expect(engine.latchReanchors).toBe(0);
    expect(trace.every((s) => !s.controllerState.includes('latch_reanchor'))).toBe(true);
  });

  it('follows through a backward wall-clock step, one worker tick off the baseline', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    const trace = runWorld(engine, {
      ...WORLD,
      events: [{ atMs: 4000, producerStepMs: -5000 }],
    });

    expectNoVisibleDiscontinuity(trace);
    expect(trace[trace.length - 1]?.source).toBe('semantic');
    expect(engine.latchReanchors).toBe(0);

    // The re-base costs one worker tick of session time, which the stage's
    // minimum cannot give back — so the document runs permanently that much
    // further extrapolated. The bound is therefore the distance the presenter
    // covers in one tick, derived from the baseline run itself rather than
    // asserted as a magic number: about a twentieth of a rendered line.
    const baseline = baselineWorld();
    const divergencePx = worstDivergencePx(trace, baseline);
    const pxPerMs =
      ((baseline[baseline.length - 1]?.q ?? 0) - (baseline[0]?.q ?? 0)) / WORLD.durationMs;
    expect(divergencePx).toBeGreaterThan(0);
    expect(divergencePx).toBeLessThanOrEqual(pxPerMs * WORKER_TICK_MS);
    expect(divergencePx).toBeLessThan(map.linePitchPx * 0.05);
  });

  it('keeps following across a sleep/wake the stage’s monotonic clock did not count', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    // Five minutes of suspend: wall time advanced, the stage's clock did not,
    // and nobody spoke. The offset genuinely jumps by the whole five minutes.
    const trace = runWorld(engine, {
      ...WORLD,
      events: [{ atMs: 4000, producerStepMs: 300_000 }],
    });

    expectNoVisibleDiscontinuity(trace);
    const afterWake = trace.filter((s) => s.stageNowMs > STAGE_EPOCH + 4100);
    expect(afterWake.every((s) => s.source === 'semantic')).toBe(true);

    // Still moving on the far side, and moving exactly as much as an
    // unperturbed run does over the same stretch — neither frozen by an
    // inflated evidence age nor rushing to make up imaginary lost ground.
    const baseline = baselineWorld();
    const wakeIndex = trace.length - afterWake.length;
    const advanced = (trace[trace.length - 1]?.q ?? 0) - (trace[wakeIndex]?.q ?? 0);
    const baselineAdvanced =
      (baseline[baseline.length - 1]?.q ?? 0) - (baseline[wakeIndex]?.q ?? 0);
    expect(advanced).toBeGreaterThan(map.linePitchPx);
    expect(advanced).toBeCloseTo(baselineAdvanced, 3);
    expect(worstDivergencePx(trace, baseline)).toBeLessThan(0.001);
  });

  it('caps the wake frame instead of integrating it when the stage clock counted the suspend', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    const trace = runWorld(engine, {
      durationMs: 8000,
      transportMs: 20,
      // Both clocks gained the suspend, so the offset is unchanged and what
      // arrives instead is a 300 s display interval.
      events: [{ atMs: 4000, producerStepMs: 300_000, stageGapMs: 300_000 }],
    });

    const { steps } = realizedFromDeltaQ(trace);
    for (const step of steps) {
      expect(step.dqPx).toBeGreaterThanOrEqual(-1e-9);
      // §32.2 caps the integration step at `MAX_FRAME_DT_MS`, so even a
      // five-minute gap moves at most one capped frame's worth of pixels.
      expect(step.dqPx).toBeLessThan(60);
    }
    expect(trace[trace.length - 1]?.source).toBe('semantic');
  });

  it('would have frozen on the same backward step if frames were stamped with wall time', () => {
    // The contrast that justifies keeping only a minimum. Raw `Date.now()`
    // stamps move BACKWARD on an NTP correction, which reads downstream as
    // evidence five seconds old; the staleness gate then drops the semantic
    // source and the document stops. Re-basing in the worker is what removes
    // that failure, not anything the stage could compensate for.
    const raw = mapFor();
    const rawEngine = makeEngine(raw.map, raw.layout.contentHeightPx);
    const rawTrace = runWorld(rawEngine, {
      durationMs: 8000,
      transportMs: 20,
      rawProducerStamps: true,
      events: [{ atMs: 4000, producerStepMs: -5000 }],
    });
    const rawAfter = rawTrace.filter((s) => s.stageNowMs > STAGE_EPOCH + 4200);
    expect(rawAfter.some((s) => s.source === 'hold')).toBe(true);

    const fixed = mapFor();
    const fixedEngine = makeEngine(fixed.map, fixed.layout.contentHeightPx);
    const fixedTrace = runWorld(fixedEngine, {
      durationMs: 8000,
      transportMs: 20,
      events: [{ atMs: 4000, producerStepMs: -5000 }],
    });
    const fixedAfter = fixedTrace.filter((s) => s.stageNowMs > STAGE_EPOCH + 4200);
    expect(fixedAfter.every((s) => s.source === 'semantic')).toBe(true);
  });
});

describe('the layout-generation gate is on the stage clock, not the session clock', () => {
  it('still rejects for the grace window and then tolerates, across a wall-clock step', () => {
    const { map, layout } = mapFor(1);
    const engine = makeEngine(map, layout.contentHeightPx);
    expect(probeAgeMs(engine, STAGE_EPOCH, 0, 0, 1)).toBeCloseTo(0, 9);

    // The stage relays out; its generation advances locally.
    const next = mapFor(2);
    engine.layoutRecovery({ map: next.map, nowMs: STAGE_EPOCH + 1000, anchorUnit: 3 });

    // A producer wall-clock step lands in the middle of the grace window. It
    // moves the session domain by five seconds and must move this gate by
    // nothing at all — the window is a stage-local wait for the ack loop.
    const staleGeneration = (sessionTimeMs: number, revision: number) =>
      frame({
        revision,
        sessionTimeMs,
        layoutGeneration: 1,
        estimatedUnit: 3,
        committedUnit: 2,
        tokenIndex: 3,
      });

    expect(engine.receiveFrame(staleGeneration(5_000, 10), STAGE_EPOCH + 1400)).toBe(false);
    expect(engine.receiveFrame(staleGeneration(10_050, 11), STAGE_EPOCH + 1850)).toBe(false);
    expect(engine.receiver.stats.byReason.layout_generation).toBe(2);
    expect(engine.receiver.stats.toleratedStaleLayout).toBe(0);

    // Past 900 ms of STAGE time from the relayout, the layout-independent
    // spoken unit is followed rather than held forever.
    expect(engine.receiveFrame(staleGeneration(10_100, 12), STAGE_EPOCH + 1950)).toBe(true);
    expect(engine.receiver.stats.toleratedStaleLayout).toBe(1);
    expect(engine.receiver.stats.toleratedFutureLayout).toBe(0);
  });
});
