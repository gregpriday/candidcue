/**
 * StageMotionEngine — the frame → pixels pipeline end to end
 * (companion §26.2, §32, §33, §54, §61, §70).
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SMOOTH_FOLLOW_PROFILE as DEFAULT_PROFILE,
  type SemanticMotionFrame,
  type StageTransitionDirective,
} from '../../../src/shared/contracts';
import {
  buildRenderedLineMap,
  createStageMotionEngine,
  emptyRenderedLineMap,
  identityUnitAxis,
  isCalibrationEvidence,
  limitsForState,
  REANCHOR_FADE_MS,
  type StageMotionEngine,
  type StageRenderedLineMap,
} from '../../../src/stage/motion';
import { fixtureFingerprint, syntheticLayout } from '../../fixtures/layout';

const R = 400;

function mapFor(layoutGeneration = 1, options: { columnWidthPx?: number } = {}) {
  const layout = syntheticLayout({
    blocks: [
      { kind: 'heading', tokens: 4 },
      { kind: 'paragraph', tokens: 80 },
      { kind: 'paragraph', tokens: 80 },
    ],
    columnWidthPx: options.columnWidthPx ?? 800,
    startY: 800,
  });
  const map = buildRenderedLineMap({
    fingerprint: fixtureFingerprint({ layoutGeneration }),
    tokens: layout.tokens,
    blocks: layout.blocks,
    readingLineStartY: R,
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
    0,
  );
  engine.setLineMap(map);
  engine.setBounds(0, maxScrollPx);
  return engine;
}

/** Drive the loop at a fixed refresh rate, feeding frames on a cadence. */
function drive(
  engine: StageMotionEngine,
  options: {
    durationMs: number;
    frameHz?: number;
    semanticHz?: number;
    unitsPerSecond?: number;
    startUnit?: number;
    state?: SemanticMotionFrame['state'];
    transitionAt?: { atMs: number; directive: StageTransitionDirective };
  },
) {
  const frameHz = options.frameHz ?? 60;
  const semanticHz = options.semanticHz ?? 20;
  const dt = 1000 / frameHz;
  const semanticInterval = 1000 / semanticHz;
  const unitsPerSecond = options.unitsPerSecond ?? 3;
  let revision = 0;
  let nextSemanticAt = 0;
  const trace: ReturnType<StageMotionEngine['frame']>[] = [];

  for (let t = 0; t <= options.durationMs; t += dt) {
    if (t >= nextSemanticAt) {
      revision++;
      const unit = (options.startUnit ?? 0) + (unitsPerSecond * t) / 1000;
      engine.receiveFrame(
        frame({
          revision,
          sessionTimeMs: t,
          estimatedUnit: unit,
          committedUnit: unit - 1,
          tokenIndex: Math.floor(unit),
          velocityUnitsPerSecond: unitsPerSecond,
          state: options.state ?? 'following',
          transition:
            options.transitionAt && t >= options.transitionAt.atMs
              ? options.transitionAt.directive
              : undefined,
        }),
        t,
      );
      nextSemanticAt = t + semanticInterval;
    }
    trace.push(engine.frame(t));
  }
  return trace;
}

describe('frame → pixels (§26.2)', () => {
  it('moves continuously between semantic frames, not in steps', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    const trace = drive(engine, { durationMs: 4000, semanticHz: 4 });

    const moving = trace.slice(120);
    // Every frame between (4 Hz) semantic updates still advances the document.
    const advancing = moving.filter((f, i) => i > 0 && f.scrollPx > (moving[i - 1]?.scrollPx ?? 0));
    expect(advancing.length / moving.length).toBeGreaterThan(0.9);
    expect(trace[trace.length - 1]?.source).toBe('semantic');
  });

  it('never moves backward and never jumps within a frame while following', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    const trace = drive(engine, { durationMs: 6000 });

    let previous = -Infinity;
    for (const f of trace) {
      expect(f.scrollPx).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = f.scrollPx;
    }
    // §70.8: no visible single-frame position jump.
    expect(engine.diagnostics.metrics.maxFrameStepPx).toBeLessThan(30);
    expect(engine.diagnostics.metrics.velocitySignChanges).toBe(0);
  });

  it('follows the same trajectory at 60 Hz and 120 Hz (§32.3)', () => {
    const a = mapFor();
    const b = mapFor();
    const engineA = makeEngine(a.map, a.layout.contentHeightPx);
    const engineB = makeEngine(b.map, b.layout.contentHeightPx);
    const at60 = drive(engineA, { durationMs: 5000, frameHz: 60 });
    const at120 = drive(engineB, { durationMs: 5000, frameHz: 120 });
    const endA = at60[at60.length - 1]?.scrollPx ?? 0;
    const endB = at120[at120.length - 1]?.scrollPx ?? 0;
    expect(Math.abs(endA - endB)).toBeLessThan(4);
  });

  it('keeps the active line near the reading position during a steady read', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    const trace = drive(engine, { durationMs: 8000 });
    const settled = trace.slice(200);
    const worstError = Math.max(...settled.map((f) => Math.abs(f.targetPx - f.scrollPx)));
    // §70.4 visual tracking error stays small during ordinary following.
    expect(worstError).toBeLessThan(map.linePitchPx);
  });

  it('reports the active token for capped-rate styling, not every frame', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    const trace = drive(engine, { durationMs: 2000 });
    const ticks = trace.filter((f) => f.styleTick).length;
    expect(ticks).toBeGreaterThan(0);
    expect(ticks).toBeLessThan(trace.length / 4);
    const withToken = trace.filter((f) => f.activeTokenIndex !== null);
    expect(withToken.length).toBeGreaterThan(0);
  });
});

describe('holding and degraded operation (§62, §32)', () => {
  it('holds position when the line map is invalid rather than guessing', () => {
    const engine = makeEngine(emptyRenderedLineMap(fixtureFingerprint()), 10_000);
    const trace = drive(engine, { durationMs: 2000 });
    expect(trace.every((f) => f.source === 'hold')).toBe(true);
    expect(trace[trace.length - 1]?.scrollPx).toBe(0);
  });

  /**
   * H3. The previous version of the test above never installed the tracking
   * fallback, so it proved a hold that production did not provide: an invalid
   * map disabled the semantic planner while the snapshot fallback stayed
   * eligible, and that path estimates positions from block offsets and
   * ESTIMATED heights. The stage moved on guessed geometry at exactly the
   * moment §62 requires it to hold.
   */
  it('holds even with an ACTIVE tracking fallback while the map is invalid (§62)', () => {
    const engine = makeEngine(emptyRenderedLineMap(fixtureFingerprint()), 10_000);
    engine.setFallbackTarget({ scrollPx: 4200, disposition: 'follow', atMs: 0 });
    const trace = drive(engine, { durationMs: 2000 });
    expect(trace.every((f) => f.source === 'hold')).toBe(true);
    expect(engine.controller.state.q).toBe(0);
    expect(trace[trace.length - 1]?.controllerState).toContain('map_unresolved');
  });

  it('holds against a fallback that would re-anchor, too', () => {
    // `reanchor`/`instant` dispositions write plant state directly. While the
    // map is unresolved that write has no trustworthy destination.
    const engine = makeEngine(emptyRenderedLineMap(fixtureFingerprint()), 10_000);
    engine.setFallbackTarget({ scrollPx: 7777, disposition: 'reanchor', atMs: 0 });
    engine.frame(0);
    engine.frame(16.7);
    expect(engine.controller.state.q).toBe(0);
  });

  it('holds before any map has been built at all', () => {
    const engine = createStageMotionEngine({ unitAxis: identityUnitAxis() });
    engine.configureSession(
      { sessionId: 'session-a', sessionGeneration: 1, scriptCompileHash: 'hash-a', layoutGeneration: 1 },
      0,
    );
    engine.setBounds(0, 10_000);
    engine.setFallbackTarget({ scrollPx: 3000, disposition: 'follow', atMs: 0 });
    for (let t = 0; t < 1000; t += 16.7) engine.frame(t);
    expect(engine.controller.state.q).toBe(0);
  });

  it('resumes the fallback as soon as a valid map arrives', () => {
    const engine = makeEngine(emptyRenderedLineMap(fixtureFingerprint()), 10_000);
    engine.setFallbackTarget({ scrollPx: 2000, disposition: 'follow', atMs: 0 });
    for (let t = 0; t < 500; t += 16.7) engine.frame(t);
    expect(engine.controller.state.q).toBe(0);

    const { map, layout } = mapFor();
    engine.setLineMap(map);
    engine.setBounds(0, layout.contentHeightPx);
    let last = engine.frame(500);
    for (let t = 500; t < 5000; t += 16.7) last = engine.frame(t);
    expect(last.source).toBe('fallback');
    expect(last.scrollPx).toBeCloseTo(2000, 0);
  });

  it('reports a non-finite fallback target through the fuse instead of rendering NaN (C1)', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    drive(engine, { durationMs: 1000 });
    const before = engine.controller.state.q;
    engine.setFallbackTarget({ scrollPx: Number.NaN, disposition: 'follow', atMs: 4000 });
    let last = engine.frame(5000);
    for (let t = 5000; t < 6000; t += 16.7) last = engine.frame(t);
    expect(Number.isFinite(last.scrollPx)).toBe(true);
    expect(engine.controller.state.q).toBe(before);
    expect(engine.diagnostics.metrics.fusedFrames).toBeGreaterThan(0);
    expect(last.controllerState).toContain('fused');
  });

  it('discards a poisoned frame at the gate and keeps rendering finite pixels (C1)', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    drive(engine, { durationMs: 1500 });

    for (const field of [
      'estimatedUnit',
      'committedUnit',
      'velocityUnitsPerSecond',
      'accelerationUnitsPerSecond2',
      'confidence',
      'tokenIndex',
      'layoutGeneration',
      'positionVariance',
    ] as const) {
      const accepted = engine.receiveFrame(
        frame({ revision: 9000, sessionTimeMs: 1500, [field]: Number.NaN } as never),
        1500,
      );
      expect(accepted, field).toBe(false);
    }

    let last = engine.frame(1520);
    for (let t = 1520; t < 3000; t += 16.7) last = engine.frame(t);
    expect(Number.isFinite(last.scrollPx)).toBe(true);
    expect(Number.isFinite(engine.controller.state.v)).toBe(true);
    expect(Number.isFinite(engine.controller.state.a)).toBe(true);
    expect(engine.receiver.stats.byReason.malformed).toBe(8);
  });

  it('falls back to snapshot-driven pixel targets when frames go stale', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    drive(engine, { durationMs: 1000 });

    // No further semantic frames: the tracking snapshot path takes over.
    engine.setFallbackTarget({ scrollPx: 2000, disposition: 'follow', atMs: 5000 });
    let last = engine.frame(5000);
    for (let t = 5000; t < 9000; t += 16.7) last = engine.frame(t);
    expect(last.source).toBe('fallback');
    expect(last.scrollPx).toBeCloseTo(2000, 0);
  });

  it('re-anchors on an explicit jump disposition without a per-frame teleport elsewhere', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    engine.setFallbackTarget({ scrollPx: 1500, disposition: 'reanchor', atMs: 0 });
    // §20.4: the jump is spent under the fade, so it lands one fade-down later
    // — but still as ONE step, not a roll. Nothing moves in between.
    let last = engine.frame(0);
    expect(last.scrollPx).toBeCloseTo(0, 0);
    for (let t = 16.7; t <= REANCHOR_FADE_MS + 16.7; t += 16.7) last = engine.frame(t);
    expect(last.scrollPx).toBeCloseTo(1500, 0);
    // The disposition is consumed: it does not re-fire every frame.
    const second = engine.frame(REANCHOR_FADE_MS + 33.4);
    expect(Math.abs(second.scrollPx - 1500)).toBeLessThan(2);
  });

  it('caps a hitch instead of integrating it, and counts the dropped frame', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    drive(engine, { durationMs: 2000 });
    const before = engine.controller.state.q;
    engine.receiveFrame(
      frame({ revision: 9999, sessionTimeMs: 2000, estimatedUnit: 60, tokenIndex: 60 }),
      2000,
    );
    const hitched = engine.frame(6000); // 4-second gap
    expect(hitched.hitch).toBe(true);
    expect(hitched.scrollPx - before).toBeLessThan(60);
    expect(engine.diagnostics.metrics.droppedFrames).toBeGreaterThan(0);
  });

  it('re-anchors to the rendered position when the window becomes visible again', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    drive(engine, { durationMs: 2000 });
    engine.visibilityRestored(1234, 10_000);
    expect(engine.controller.state.q).toBe(1234);
    expect(engine.controller.state.v).toBe(0);
  });
});

describe('transitions and authority (§53, §26.3)', () => {
  it('applies a reanchor exactly once and moves the document there', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    const destinationLine = map.lines[10];
    expect(destinationLine).toBeDefined();

    drive(engine, {
      durationMs: 1500,
      transitionAt: {
        atMs: 800,
        directive: {
          id: 't1',
          type: 'reanchor',
          authority: 'ordinary',
          fromUnit: 3,
          toUnit: destinationLine?.spokenUnitStart ?? 0,
          destinationTokenIndex: destinationLine?.firstTokenIndex ?? 0,
          issuedAtMs: 800,
          expiresAtMs: 4000,
          semanticEpoch: 1,
          reason: 'large_forward_skip',
        },
      },
    });

    // The document arrived at the destination line and — crucially — did not
    // reverse afterwards while the worker's frames still described the old
    // position: a re-anchor is a discontinuity, not a licence to run backward.
    expect(engine.controller.state.q).toBeCloseTo(
      (destinationLine?.baselineY ?? 0) - R,
      0,
    );
    // Repeated frames carrying the same directive must not re-run it.
    expect(engine.transitions.consumePlantOverwrite()).toBeNull();
  });

  it('does not let a settle directive overwrite plant state', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    drive(engine, { durationMs: 1000 });
    const before = engine.controller.state.q;
    engine.receiveFrame(
      frame({
        revision: 5000,
        sessionTimeMs: 1000,
        estimatedUnit: 3,
        transition: {
          id: 's1',
          type: 'settle',
          authority: 'ordinary',
          fromUnit: 3,
          toUnit: 3,
          destinationTokenIndex: 3,
          issuedAtMs: 1000,
          expiresAtMs: 5000,
          semanticEpoch: 1,
          reason: 'layout_recovery',
        },
      }),
      1000,
    );
    const after = engine.frame(1016);
    expect(Math.abs(after.scrollPx - before)).toBeLessThan(20);
    expect(after.controllerState).toContain('settle');
  });
});

/**
 * H1, engine side. Under a forward-only profile the desired position is latched
 * monotonically: reverse is forbidden, so a target that moves BACKWARD can only
 * park the plant somewhere it can never leave. A genuine regression arrives as a
 * backward-capable state or a re-anchor directive, both of which release it.
 *
 * The latch is bounded, though. Without an upper bound it converts a single
 * spiky frame that raced the plant forward into a PERMANENT error: every
 * corrective target afterwards is "backward", every one is suppressed, and
 * forward-only means nothing on the stage can bring it back. `§30
 * reanchorThresholdPx` is where the latch stops being a filter and starts being
 * a lie, so past it — and only once the disagreement has persisted — the stage
 * spends an authorized §53 discontinuity instead.
 *
 * Note on revisions below: `revision` is a finite INTEGER by contract, and the
 * receiver enforces it. These loops used to stamp `100000 + t` at a 16.7 ms
 * step, so all but a handful of frames were structurally malformed and never
 * reached the engine at all — the oscillation and the regression they claimed
 * to drive never happened. `Math.round` is load-bearing.
 */
describe('forward target latch (§70.5)', () => {
  const THRESHOLD_PX = limitsForState('following', DEFAULT_PROFILE).reanchorThresholdPx;

  /** Scroll distance between two spoken units on the built path. */
  function gapPx(map: StageRenderedLineMap, fromUnit: number, toUnit: number): number {
    return (
      (map.sampleMotionPath(toUnit)?.scrollPx ?? 0) - (map.sampleMotionPath(fromUnit)?.scrollPx ?? 0)
    );
  }

  it('suppresses a sub-threshold backward target revision while ordinary following', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    drive(engine, { durationMs: 4000, unitsPerSecond: 6 });
    const advanced = engine.controller.state.q;
    expect(advanced).toBeGreaterThan(200);

    // Revised backward by less than the re-anchor threshold: tracker noise, not
    // a reposition. Speech velocity stays positive — the exact scenario named.
    const revisedUnit = 20;
    expect(gapPx(map, revisedUnit, 24)).toBeLessThan(THRESHOLD_PX);
    let last = engine.frame(4000);
    for (let t = 4000; t < 6000; t += 16.7) {
      engine.receiveFrame(
        frame({
          revision: 100000 + Math.round(t),
          sessionTimeMs: t,
          estimatedUnit: revisedUnit,
          committedUnit: revisedUnit - 1,
          tokenIndex: revisedUnit,
          velocityUnitsPerSecond: 6,
        }),
        t,
      );
      last = engine.frame(t);
    }
    expect(engine.targetRegressions).toBeGreaterThan(0);
    expect(last.controllerState).toContain('target_regression');
    // Suppressed, not resolved: no discontinuity was spent on tracker noise.
    expect(engine.latchReanchors).toBe(0);
    // The plant did not chase a target it cannot reach, and did not move
    // backward either.
    expect(engine.controller.state.q).toBeGreaterThanOrEqual(advanced - 1e-6);
    expect(last.targetPx).toBeGreaterThanOrEqual(advanced - map.linePitchPx);
  });

  it('never renders backward motion while a sub-threshold target oscillates', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    drive(engine, { durationMs: 3000, unitsPerSecond: 8 });
    // A flapping tracker, entirely inside the threshold.
    expect(gapPx(map, 20, 40)).toBeLessThan(THRESHOLD_PX);
    let previous = engine.controller.state.q;
    let accepted = 0;
    for (let t = 3000; t < 5000; t += 16.7) {
      if (
        engine.receiveFrame(
          frame({
            revision: 200000 + Math.round(t),
            sessionTimeMs: t,
            estimatedUnit: t % 200 < 100 ? 20 : 40,
            tokenIndex: 20,
            velocityUnitsPerSecond: 5,
          }),
          t,
        )
      ) {
        accepted++;
      }
      const result = engine.frame(t);
      expect(result.scrollPx).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = result.scrollPx;
    }
    // The oscillation genuinely reached the engine — see the note above.
    expect(accepted).toBeGreaterThan(100);
    expect(engine.targetRegressions).toBeGreaterThan(0);
    expect(engine.latchReanchors).toBe(0);
  });

  it('gives way to an authorized re-anchor past reanchorThresholdPx', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    drive(engine, { durationMs: 4000, unitsPerSecond: 12 });
    const advanced = engine.controller.state.q;
    const trueUnit = 2;
    const truePx = map.sampleMotionPath(trueUnit)?.scrollPx ?? 0;
    expect(advanced - truePx).toBeGreaterThan(THRESHOLD_PX);

    // The tracker insists, frame after frame, that the presenter is far behind
    // where the document sits. Forward-only following can never close that.
    let firstReanchorAtMs: number | null = null;
    let last = engine.frame(4000);
    for (let t = 4016; t < 8000; t += 16.7) {
      engine.receiveFrame(
        frame({
          revision: 500000 + Math.round(t),
          sessionTimeMs: t,
          estimatedUnit: trueUnit,
          committedUnit: trueUnit,
          tokenIndex: trueUnit,
          velocityUnitsPerSecond: 3,
        }),
        t,
      );
      last = engine.frame(t);
      if (last.controllerState.includes('latch_reanchor')) firstReanchorAtMs ??= t;
    }

    expect(engine.latchReanchors).toBe(1);
    // Persistence, not a hair trigger: nothing moved for the first 400 ms.
    expect(firstReanchorAtMs).not.toBeNull();
    expect((firstReanchorAtMs ?? 0) - 4016).toBeGreaterThanOrEqual(400);
    // And the document ends up where the presenter actually is, rather than a
    // third of a viewport ahead of it for the rest of the session.
    expect(Math.abs(last.scrollPx - truePx)).toBeLessThan(map.linePitchPx);
  });

  it('does not re-anchor on a momentary beyond-threshold blip', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    drive(engine, { durationMs: 4000, unitsPerSecond: 12 });
    const advanced = engine.controller.state.q;
    expect(advanced - (map.sampleMotionPath(2)?.scrollPx ?? 0)).toBeGreaterThan(THRESHOLD_PX);

    // 300 ms of "you are at unit 2" — under the persistence window — then the
    // tracker recovers. A blip must not reposition the document.
    for (let t = 4016; t < 4316; t += 16.7) {
      engine.receiveFrame(
        frame({
          revision: 600000 + Math.round(t),
          sessionTimeMs: t,
          estimatedUnit: 2,
          tokenIndex: 2,
          velocityUnitsPerSecond: 3,
        }),
        t,
      );
      engine.frame(t);
    }
    expect(engine.latchReanchors).toBe(0);
    for (let t = 4316; t < 5200; t += 16.7) {
      engine.receiveFrame(
        frame({
          revision: 600000 + Math.round(t),
          sessionTimeMs: t,
          estimatedUnit: 48 + (3 * (t - 4316)) / 1000,
          tokenIndex: 48,
          velocityUnitsPerSecond: 3,
        }),
        t,
      );
      engine.frame(t);
    }
    expect(engine.latchReanchors).toBe(0);
    expect(engine.controller.state.q).toBeGreaterThanOrEqual(advanced - 1e-6);
  });

  it('releases the latch for a backward-capable state (an explicit regression)', () => {
    expect(limitsForState('rewinding', DEFAULT_PROFILE).allowBackward).toBe(true);
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    drive(engine, { durationMs: 4000, unitsPerSecond: 6 });
    const advanced = engine.controller.state.q;

    let last = engine.frame(4000);
    for (let t = 4000; t < 7000; t += 16.7) {
      engine.receiveFrame(
        frame({
          revision: 300000 + Math.round(t),
          sessionTimeMs: t,
          estimatedUnit: 3,
          committedUnit: 3,
          tokenIndex: 3,
          velocityUnitsPerSecond: -2,
          state: 'rewinding',
          behavior: 'return',
        }),
        t,
      );
      last = engine.frame(t);
    }
    expect(last.controllerState).not.toContain('target_regression');
    expect(engine.controller.state.q).toBeLessThan(advanced);
    // A backward-capable state classifies the regression itself; the latch's
    // escape hatch is for the case where nothing else will.
    expect(engine.latchReanchors).toBe(0);
  });

  it('releases the latch on an authorized re-anchor', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    drive(engine, { durationMs: 4000, unitsPerSecond: 6 });
    engine.manualOverride(50, 4000);
    // The re-anchor releases the latch, so the tracker's re-acquired (lower)
    // position is followed instead of being clamped to the pre-override one.
    let last = engine.frame(4000);
    for (let t = 4016; t < 9000; t += 16.7) {
      engine.receiveFrame(
        frame({ revision: 400000 + Math.round(t), sessionTimeMs: t, estimatedUnit: 5, tokenIndex: 5 }),
        t,
      );
      last = engine.frame(t);
    }
    // The latch does not drag the plant back toward the position it held before
    // the manual reposition: the target is the path's own answer for unit 5.
    expect(last.controllerState).not.toContain('target_regression');
    expect(engine.targetRegressions).toBe(0);
    expect(last.targetPx).toBeCloseTo(map.sampleMotionPath(5)?.scrollPx ?? -1, 0);
  });
});

/**
 * H4. An interval whose SECANT exceeds the visual-block limit cannot be
 * followed: the path would have to cover the whole image height inside one
 * spoken token. The stage holds at the entry and crosses it as one authorized
 * re-anchor (§53) instead of racing at the velocity ceiling.
 */
describe('visual-block spans (§8.6)', () => {
  function visualMap() {
    const layout = syntheticLayout({
      blocks: [
        { kind: 'paragraph', tokens: 6 },
        { kind: 'paragraph', tokens: 1 },
        { kind: 'image', heightPx: 900 },
        { kind: 'paragraph', tokens: 1 },
        { kind: 'paragraph', tokens: 30 },
      ],
      startY: 400,
      paragraphGapPx: 0,
    });
    const map = buildRenderedLineMap({
      fingerprint: fixtureFingerprint(),
      tokens: layout.tokens,
      blocks: layout.blocks,
      readingLineStartY: R,
      lineHeightPx: layout.lineHeightPx,
      viewportHeightPx: 1080,
      maxScrollPx: layout.contentHeightPx,
      maxSlopePxPerUnit: layout.lineHeightPx * 8,
      boundarySlopeClampPxPerUnit: layout.lineHeightPx * 3,
    });
    return { map, layout };
  }

  it('holds at the span entry rather than racing across the image', () => {
    const { map, layout } = visualMap();
    const span = map.visualBlockSpans[0];
    expect(span).toBeDefined();

    const engine = makeEngine(map, layout.contentHeightPx);
    const inside = ((span?.unitStart ?? 0) + (span?.unitEnd ?? 1)) / 2;
    let last = engine.frame(0);
    for (let t = 0; t < 2500; t += 16.7) {
      engine.receiveFrame(
        frame({
          revision: 1 + Math.round(t),
          sessionTimeMs: t,
          estimatedUnit: inside,
          committedUnit: inside,
          tokenIndex: Math.floor(inside),
          velocityUnitsPerSecond: 0.2,
        }),
        t,
      );
      last = engine.frame(t);
    }
    expect(last.controllerState).toContain('visual_block');
    // Parked at the entry, not somewhere in the middle of the image.
    expect(engine.controller.state.q).toBeCloseTo(span?.scrollStartPx ?? 0, 0);
    expect(Math.abs(engine.controller.state.v)).toBeLessThan(5);
  });

  it('crosses the span as one authorized re-anchor when the presenter passes it', () => {
    const { map, layout } = visualMap();
    const span = map.visualBlockSpans[0];
    const engine = makeEngine(map, layout.contentHeightPx);
    const inside = ((span?.unitStart ?? 0) + (span?.unitEnd ?? 1)) / 2;
    let t = 0;
    for (; t < 2000; t += 16.7) {
      engine.receiveFrame(
        frame({
          revision: 1 + Math.round(t),
          sessionTimeMs: t,
          estimatedUnit: inside,
          tokenIndex: Math.floor(inside),
          velocityUnitsPerSecond: 0.2,
        }),
        t,
      );
      engine.frame(t);
    }
    const beyond = (span?.unitEnd ?? 1) + 0.5;
    engine.receiveFrame(
      frame({
        revision: 999999,
        sessionTimeMs: t,
        estimatedUnit: beyond,
        tokenIndex: Math.ceil(beyond),
        velocityUnitsPerSecond: 2,
      }),
      t,
    );
    const crossed = engine.frame(t);
    expect(crossed.controllerState).not.toContain('visual_block');
    // ONE discontinuity: the plant lands past the image immediately instead of
    // racing ~900 px at the velocity ceiling for a second.
    expect(crossed.scrollPx).toBeGreaterThanOrEqual((span?.scrollEndPx ?? 0) - 5);
    // ...and it arrives calmly, not carrying the speed a race would have built.
    expect(Math.abs(crossed.velocityPxS)).toBeLessThan(50);
  });
});

describe('layout invalidation during Live (§33)', () => {
  it('preserves the semantic position across a rebuild instead of raw scrollTop', () => {
    const wide = mapFor(1, { columnWidthPx: 900 });
    const engine = makeEngine(wide.map, wide.layout.contentHeightPx);
    drive(engine, { durationMs: 5000 });
    const unitBefore = engine.lastPrediction?.unit ?? 0;
    expect(unitBefore).toBeGreaterThan(5);

    // The user shrinks the column: same script, completely different wrapping.
    const narrow = mapFor(2, { columnWidthPx: 420 });
    engine.setBounds(0, narrow.layout.contentHeightPx);
    engine.layoutRecovery({ map: narrow.map, nowMs: 5000 });

    const expected = narrow.map.sampleMotionPath(unitBefore)?.scrollPx ?? 0;
    expect(engine.controller.state.q).toBeCloseTo(expected, 0);
    expect(engine.controller.state.a).toBe(0);
    expect(engine.receiver.gate.layoutGeneration).toBe(2);
  });

  it('rejects frames stamped with the superseded layout generation', () => {
    const first = mapFor(1);
    const engine = makeEngine(first.map, first.layout.contentHeightPx);
    drive(engine, { durationMs: 1000 });
    const second = mapFor(2);
    engine.layoutRecovery({ map: second.map, nowMs: 1000 });
    const stale = engine.receiveFrame(
      frame({ revision: 8000, layoutGeneration: 1, sessionTimeMs: 1050 }),
      1050,
    );
    expect(stale).toBe(false);
    expect(engine.receiver.stats.byReason.layout_generation).toBeGreaterThan(0);
  });
});

describe('unit-axis calibration evidence (§6 seam)', () => {
  it('only calibrates on frames the tracker actually stands behind', () => {
    expect(isCalibrationEvidence(frame())).toBe(true);
    expect(isCalibrationEvidence(frame({ state: 'catching_up' }))).toBe(true);

    // States that are guessing, coasting, or mid-correction.
    for (const state of [
      'uncertain',
      'coasting',
      'acquiring',
      'adlib_hold',
      'retake_pending',
      'rewinding',
      'reanchoring',
      'paused',
      'lost_local',
    ] as const) {
      expect(isCalibrationEvidence(frame({ state })), state).toBe(false);
    }
    // Low confidence, and an in-flight retake, are also not evidence.
    expect(isCalibrationEvidence(frame({ confidence: 0.2 }))).toBe(false);
    expect(isCalibrationEvidence(frame({ behavior: 'retake' }))).toBe(false);
    expect(isCalibrationEvidence(frame({ behavior: 'retake_candidate' }))).toBe(false);
  });

  it('does not let uncertain frames distort the learned axis', () => {
    const clean = createStageMotionEngine();
    const polluted = createStageMotionEngine();
    for (const engine of [clean, polluted]) {
      engine.configureSession(
        { sessionId: 'session-a', sessionGeneration: 1, scriptCompileHash: 'hash-a', layoutGeneration: 1 },
        0,
      );
    }
    let revision = 0;
    for (let token = 0; token <= 60; token += 4) {
      revision++;
      const sound = frame({
        revision,
        sessionTimeMs: revision * 50,
        estimatedUnit: token * 1.25,
        tokenIndex: token,
      });
      clean.receiveFrame(sound, revision * 50);
      polluted.receiveFrame(sound, revision * 50);
      // The polluted feed also carries a low-confidence guess that is wrong by
      // a wide margin — the kind a tracker emits while it is unsure.
      revision++;
      polluted.receiveFrame(
        frame({
          revision,
          sessionTimeMs: revision * 50,
          estimatedUnit: token * 1.25 + 0.6,
          tokenIndex: token + 25,
          state: 'uncertain',
          confidence: 0.2,
          behavior: 'lost',
        }),
        revision * 50,
      );
    }
    expect(clean.unitAxis.toMapUnit(50)).toBeCloseTo(40, 3);
    expect(polluted.unitAxis.toMapUnit(50)).toBeCloseTo(clean.unitAxis.toMapUnit(50), 3);
  });
});

describe('acknowledgement and degradation (§54, §61)', () => {
  it('emits an ack on a low periodic cadence, not per frame', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    const trace = drive(engine, { durationMs: 3000 });
    const acks = trace.map((f) => f.ack).filter((a): a is NonNullable<typeof a> => a !== null);
    expect(acks.length).toBeGreaterThan(3);
    expect(acks.length).toBeLessThan(trace.length / 10);

    const ack = acks[acks.length - 1];
    expect(ack?.sessionId).toBe('session-a');
    expect(ack?.layoutGeneration).toBe(1);
    expect(ack?.activeLineId).toBeTruthy();
    expect(ack?.controllerState).toContain('following');
    expect(ack?.targetScrollPx).toBeGreaterThan(0);
    expect(ack?.droppedFrameCountWindow).toBe(0);
  });

  /** Run the loop on a fixed cadence pattern and report the final frame. */
  function runCadence(engine: StageMotionEngine, intervalsMs: number[], frames: number) {
    let t = 0;
    let last = engine.frame(0);
    for (let i = 0; i < frames; i++) {
      t += intervalsMs[i % intervalsMs.length] ?? 16.7;
      engine.receiveFrame(
        frame({ revision: i + 1, sessionTimeMs: t, estimatedUnit: i * 0.2, tokenIndex: i }),
        t,
      );
      last = engine.frame(t);
    }
    return { last, t };
  }

  it('degrades to a simpler profile after sustained missed frames (§61)', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    // A 60 Hz display genuinely dropping a third of its frames.
    const { last, t } = runCadence(engine, [16.7, 16.7, 50], 300);
    expect(engine.diagnostics.degraded).toBe(true);
    expect(last.degraded).toBe(true);
    const result = engine.frame(t + 50);
    expect(result.controllerState).toContain('degraded');
    // Still a controller, never event-driven jumps.
    expect(result.source).toBe('semantic');
  });

  /**
   * §70.8. `HITCH_THRESHOLD_MS` was a fixed 28 ms — a 60 Hz assumption wearing
   * a constant's clothing. A 30 Hz panel has a 33.3 ms period, so EVERY healthy
   * frame counted as a dropped one: the ratio pinned at 1.0, degradation
   * tripped in 4 s, and the 0.05 recovery ratio was unreachable because the
   * numerator was every frame. 4K@30 over HDMI is an ordinary cheap
   * teleprompter monitor.
   */
  it('does not call a steady 30 Hz display degraded (§70.8)', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    const { last } = runCadence(engine, [1000 / 30], 600);
    expect(engine.diagnostics.degraded).toBe(false);
    expect(last.degraded).toBe(false);
    expect(last.hitch).toBe(false);
    expect(engine.diagnostics.metrics.droppedFrames).toBeLessThan(
      engine.diagnostics.metrics.frames * 0.05,
    );
  });

  it('still catches a 30 Hz display that is missing refreshes', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    // Nominal 30 Hz, but every third refresh is missed (66.7 ms).
    const { last } = runCadence(engine, [1000 / 30, 1000 / 30, 1000 / 15], 400);
    expect(engine.diagnostics.degraded).toBe(true);
    expect(last.degraded).toBe(true);
  });

  it('does not call an ordinary 120 Hz frame a hitch on a 120 Hz display', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    const { last } = runCadence(engine, [1000 / 120], 600);
    expect(engine.diagnostics.degraded).toBe(false);
    expect(last.hitch).toBe(false);
  });
});
