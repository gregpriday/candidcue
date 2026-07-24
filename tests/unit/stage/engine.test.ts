/**
 * StageMotionEngine — the frame → pixels pipeline end to end
 * (companion §26.2, §32, §33, §54, §61, §70).
 */
import { describe, it, expect } from 'vitest';
import type { SemanticMotionFrame, StageTransitionDirective } from '../../../src/shared/contracts';
import {
  buildRenderedLineMap,
  createStageMotionEngine,
  emptyRenderedLineMap,
  identityUnitAxis,
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
    const first = engine.frame(0);
    expect(first.scrollPx).toBeCloseTo(1500, 0);
    // The disposition is consumed: it does not re-fire every frame.
    const second = engine.frame(16.7);
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

  it('degrades to a simpler profile after sustained missed frames (§61)', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    let t = 0;
    for (let i = 0; i < 200; i++) {
      // Every frame overruns the budget badly.
      t += 45;
      engine.receiveFrame(
        frame({ revision: i + 1, sessionTimeMs: t, estimatedUnit: i * 0.2, tokenIndex: i }),
        t,
      );
      engine.frame(t);
    }
    expect(engine.diagnostics.degraded).toBe(true);
    const result = engine.frame(t + 45);
    expect(result.degraded).toBe(true);
    expect(result.controllerState).toContain('degraded');
    // Still a controller, never event-driven jumps.
    expect(result.source).toBe('semantic');
  });
});
