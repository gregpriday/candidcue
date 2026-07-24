/**
 * Implausible-rate defence, end to end (companion §26.1, §27, §30, §70.5).
 *
 * A `SemanticMotionFrame`'s `velocityUnitsPerSecond` is a claim about how fast
 * a human is SPEAKING. Every producer derives it by finite difference, so any
 * position correction — a skipped paragraph, a retake, a command jump — divides
 * a large unit delta by a small time delta and reports a pace no mouth can
 * produce. Three things then compounded it:
 *
 *  1. the receiver validated finiteness but never MAGNITUDE, so 150 units/s
 *     (≈ 9000 wpm) passed the gate exactly like 3 units/s;
 *  2. the predictor's drift budget clamped only the post-horizon coast, so
 *     in-horizon `v0·t + ½a0·t²` was unbounded — 112 units of extrapolation
 *     against a 0.9-unit coast budget;
 *  3. the plant chased the inflated target at up to `vForwardMax`, and the
 *     forward latch then suppressed every corrective (backward) target, so
 *     under a forward-only profile the excursion was PERMANENT.
 *
 * Measured before the fix: one bad frame plus an ordinary breath pause left the
 * stage 908 px — about a full 1080 px viewport — ahead of the true reading
 * position, for the rest of the session, with 252 suppressed regressions.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SMOOTH_FOLLOW_PROFILE as PROFILE,
  type SemanticMotionFrame,
} from '../../../src/shared/contracts';
import {
  buildRenderedLineMap,
  clampFrameToSpeechEnvelope,
  createSemanticFrameReceiver,
  createStageMotionEngine,
  identityUnitAxis,
  predictSemanticPosition,
} from '../../../src/stage/motion';
import { fixtureFingerprint, syntheticLayout } from '../../fixtures/layout';

const R = 400;
const PACE_MAX = PROFILE.prediction.maxUnitsPerSecond;

function baseFrame(overrides: Partial<SemanticMotionFrame> = {}): SemanticMotionFrame {
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

describe('the plausible-speech envelope is a real bound (§55)', () => {
  it('is far above any human delivery and far below a finite-difference artefact', () => {
    // 8 units/s ≈ 480 wpm. A fast read is ~250 wpm; the spike measured on the
    // v1 bridge was 150 units/s ≈ 9000 wpm.
    expect(PACE_MAX).toBeGreaterThan(4);
    expect(PACE_MAX).toBeLessThan(20);
  });

  it('leaves an ordinary frame untouched, by identity', () => {
    const ordinary = baseFrame({ velocityUnitsPerSecond: 3.4, accelerationUnitsPerSecond2: 1.2 });
    expect(clampFrameToSpeechEnvelope(ordinary, PROFILE)).toBe(ordinary);
  });

  it('clamps both derivatives symmetrically and leaves the position alone', () => {
    const spiky = baseFrame({
      estimatedUnit: 137.5,
      committedUnit: 130,
      velocityUnitsPerSecond: 150,
      accelerationUnitsPerSecond2: -900,
    });
    const sane = clampFrameToSpeechEnvelope(spiky, PROFILE);
    expect(sane.velocityUnitsPerSecond).toBe(PACE_MAX);
    expect(sane.accelerationUnitsPerSecond2).toBe(
      -PROFILE.prediction.maxAccelerationUnitsPerSecond2,
    );
    // The measured POSITION is still real evidence — only the derivatives were
    // nonsense. Clamping a frame is strictly better than dropping it.
    expect(sane.estimatedUnit).toBe(137.5);
    expect(sane.committedUnit).toBe(130);
  });
});

describe('the receiver bounds magnitude, not only finiteness (§26.1)', () => {
  function newReceiver() {
    return createSemanticFrameReceiver({
      gate: {
        sessionId: 'session-a',
        sessionGeneration: 1,
        scriptCompileHash: 'hash-a',
        layoutGeneration: 1,
      },
      profile: PROFILE,
    });
  }

  it('accepts a spiky frame but stores a plausible one, and counts it', () => {
    const receiver = newReceiver();
    const out = receiver.accept(baseFrame({ revision: 1, velocityUnitsPerSecond: 150 }), 0);
    expect(out.accepted).toBe(true);
    expect(receiver.current?.velocityUnitsPerSecond).toBe(PACE_MAX);
    expect(receiver.stats.clampedImplausibleRate).toBe(1);
  });

  it('does not count, or copy, an ordinary frame', () => {
    const receiver = newReceiver();
    const ordinary = baseFrame({ revision: 1, velocityUnitsPerSecond: 3 });
    receiver.accept(ordinary, 0);
    expect(receiver.current).toBe(ordinary);
    expect(receiver.stats.clampedImplausibleRate).toBe(0);
  });

  it('bounds a backward rate claim too', () => {
    const receiver = newReceiver();
    receiver.accept(baseFrame({ revision: 1, velocityUnitsPerSecond: -400, state: 'rewinding' }), 0);
    expect(receiver.current?.velocityUnitsPerSecond).toBe(-PACE_MAX);
  });
});

describe('in-horizon prediction is bounded by what a human could have said (§27)', () => {
  it('does not extrapolate a spike across the trusted horizon', () => {
    const spiky = baseFrame({ velocityUnitsPerSecond: 150 });
    const atHorizon = predictSemanticPosition(spiky, PROFILE.prediction.normalHorizonMs, PROFILE);
    const drift = atHorizon.unit - spiky.estimatedUnit;
    // Before: 112.5 units — many rendered lines — against a 0.9-unit budget.
    expect(drift).toBeLessThanOrEqual(
      PACE_MAX * (PROFILE.prediction.normalHorizonMs / 1000) + 1e-9,
    );
    expect(atHorizon.driftClamped).toBe(true);
    // The feed-forward velocity is bounded by the same envelope: it becomes
    // pixels per second at the plant.
    expect(atHorizon.velocityUnitsPerSecond).toBeLessThanOrEqual(PACE_MAX + 1e-9);
  });

  it('bounds an acceleration spike as well as a velocity one', () => {
    const spiky = baseFrame({
      velocityUnitsPerSecond: 3,
      accelerationUnitsPerSecond2: 5000,
    });
    const atHorizon = predictSemanticPosition(spiky, PROFILE.prediction.normalHorizonMs, PROFILE);
    expect(atHorizon.unit - spiky.estimatedUnit).toBeLessThanOrEqual(
      PACE_MAX * (PROFILE.prediction.normalHorizonMs / 1000) + 1e-9,
    );
  });

  it('still follows an ordinary pace across the whole horizon, unclamped', () => {
    // The bound must not turn into the coast budget by the back door: at a
    // normal 3 units/s the horizon has to mean what it says.
    const ordinary = baseFrame({ velocityUnitsPerSecond: 3 });
    const atHorizon = predictSemanticPosition(ordinary, PROFILE.prediction.normalHorizonMs, PROFILE);
    expect(atHorizon.unit - ordinary.estimatedUnit).toBeCloseTo(
      3 * (PROFILE.prediction.normalHorizonMs / 1000),
      9,
    );
    expect(atHorizon.driftClamped).toBe(false);
    expect(atHorizon.unit - ordinary.estimatedUnit).toBeGreaterThan(
      PROFILE.prediction.maxCoastUnits,
    );
  });
});

describe('one spiky frame does not park the document ahead forever', () => {
  it('recovers to the true reading position instead of latching the error in', () => {
    // Long document: 3 paragraphs, 200 tokens each, wrapped at 800 px.
    const layout = syntheticLayout({
      blocks: [
        { kind: 'paragraph', tokens: 200 },
        { kind: 'paragraph', tokens: 200 },
        { kind: 'paragraph', tokens: 200 },
      ],
      columnWidthPx: 800,
      startY: 800,
    });
    const map = buildRenderedLineMap({
      fingerprint: fixtureFingerprint({ layoutGeneration: 1 }),
      tokens: layout.tokens,
      blocks: layout.blocks,
      readingLineStartY: R,
      lineHeightPx: layout.lineHeightPx,
      viewportHeightPx: 1080,
      maxScrollPx: layout.contentHeightPx,
    });
    expect(map.valid).toBe(true);

    const engine = createStageMotionEngine({ unitAxis: identityUnitAxis() });
    engine.configureSession(
      {
        sessionId: 'session-a',
        sessionGeneration: 1,
        scriptCompileHash: 'hash-a',
        layoutGeneration: 1,
      },
      0,
    );
    engine.setLineMap(map);
    engine.setBounds(0, layout.contentHeightPx);

    const dt = 1000 / 60;
    let revision = 0;
    const feed = (t: number, unit: number, velocity: number) => {
      revision++;
      engine.receiveFrame(
        baseFrame({
          revision,
          sessionTimeMs: t,
          estimatedUnit: unit,
          committedUnit: Math.max(0, unit - 1),
          tokenIndex: Math.floor(unit),
          velocityUnitsPerSecond: velocity,
        }),
        t,
      );
    };

    // Phase 1: healthy following at 3 units/s.
    let scrollAt1000 = 0;
    for (let t = 0; t <= 1000; t += dt) {
      const step = Math.floor(t / 50);
      if (step * 50 >= t - dt) feed(step * 50, 3 * (step * 50) * 0.001, 3);
      scrollAt1000 = engine.frame(t).scrollPx;
    }

    // Phase 2: ONE spiky frame — a finite-difference velocity after a skip —
    // then 750 ms of silence, an ordinary breath pause.
    feed(1010, 3.03, 150);
    let maxScroll = 0;
    for (let t = 1010 + dt; t <= 1760; t += dt) {
      maxScroll = Math.max(maxScroll, engine.frame(t).scrollPx);
    }

    // Phase 3: the tracker keeps reporting the truth — the presenter is at
    // unit ~5.3 and still reading at 3 units/s.
    let finalScroll = 0;
    for (let t = 1760 + dt; t <= 8000; t += dt) {
      const step = Math.floor(t / 50);
      if (step * 50 >= t - dt) feed(step * 50, 5.3 + 3 * (step * 50 - 1760) * 0.001, 3);
      finalScroll = engine.frame(t).scrollPx;
    }

    const truePositionScroll = map.sampleMotionPath(5.3 + 3 * (8000 - 1760) * 0.001)?.scrollPx ?? 0;
    const coastExcursion = maxScroll - scrollAt1000;
    const parkedAheadPx = finalScroll - truePositionScroll;

    // The coast is bounded by the pace ceiling, not by the reported spike: at
    // 8 units/s over a 750 ms horizon the whole excursion is a few lines, not
    // the 300+ px the unbounded extrapolation produced.
    expect(coastExcursion).toBeLessThan(2 * map.linePitchPx);
    // And whatever error the spike did leave, the stage does NOT keep it: the
    // document ends up where the presenter actually is.
    expect(Math.abs(parkedAheadPx)).toBeLessThan(map.linePitchPx);
  });
});
