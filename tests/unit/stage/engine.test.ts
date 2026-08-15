/**
 * StageMotionEngine — the frame → pixels pipeline end to end
 * (companion §26.2, §32, §33, §54, §61, §70).
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SMOOTH_FOLLOW_PROFILE as DEFAULT_PROFILE,
  alignmentDisplayAt,
  type AlignmentSnapshot,
  type StageTransitionDirective,
} from '../../../src/shared/contracts';
import {
  buildRenderedLineMap,
  createStageMotionEngine,
  emptyRenderedLineMap,
  limitsForState,
  REANCHOR_FADE_MS,
  type StageMotionEngine,
  type StageRenderedLineMap,
} from '../../../src/stage/motion';
import { fixtureFingerprint, syntheticLayout } from '../../fixtures/layout';
import { snapshot } from '../../helpers/alignment';

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

/**
 * A snapshot at a given position, with the audio clock and the rate agreeing.
 *
 * The engine's own `displayAt` extrapolates from `observedToken` at
 * `rateTokensPerSecond` for at most `maxPredictionMs`, so a test that sets a
 * position without setting the matching audio stamp is asking the stage to
 * extrapolate from a moment that never happened.
 */
function snapshotAt(
  unit: number,
  atMs: number,
  overrides: Partial<AlignmentSnapshot> = {},
): AlignmentSnapshot {
  return snapshot({
    observedToken: unit,
    confirmedToken: Math.max(0, unit - 1),
    observedAtom: unit,
    confirmedAtom: Math.max(0, unit - 1),
    evidenceAudioMs: atMs,
    atAudioMs: atMs,
    ...overrides,
  });
}

function makeEngine(map: StageRenderedLineMap, maxScrollPx: number): StageMotionEngine {
  const engine = createStageMotionEngine();
  engine.configureSession(1, 0);
  engine.setLineMap(map);
  engine.setBounds(0, maxScrollPx);
  return engine;
}

/** Drive the loop at a fixed refresh rate, feeding snapshots on a cadence. */
function drive(
  engine: StageMotionEngine,
  options: {
    durationMs: number;
    frameHz?: number;
    /** Snapshot cadence. Defaults to 1 Hz — what the real engine produces. */
    snapshotHz?: number;
    unitsPerSecond?: number;
    startUnit?: number;
    state?: AlignmentSnapshot['state'];
    decision?: AlignmentSnapshot['decision'];
  },
) {
  const frameHz = options.frameHz ?? 60;
  const snapshotHz = options.snapshotHz ?? 1;
  const dt = 1000 / frameHz;
  const snapshotInterval = 1000 / snapshotHz;
  const unitsPerSecond = options.unitsPerSecond ?? 3;
  let nextSnapshotAt = 0;
  const trace: ReturnType<StageMotionEngine['frame']>[] = [];

  for (let t = 0; t <= options.durationMs; t += dt) {
    if (t >= nextSnapshotAt) {
      const unit = (options.startUnit ?? 0) + (unitsPerSecond * t) / 1000;
      engine.receiveSnapshot(
        snapshotAt(unit, t, {
          rateTokensPerSecond: options.state === undefined || options.state === 'following'
            ? unitsPerSecond
            : 0,
          state: options.state ?? 'following',
          ...(options.decision ? { decision: options.decision } : {}),
        }),
        t,
      );
      nextSnapshotAt += snapshotInterval;
    }
    trace.push(engine.frame(t));
  }
  return trace;
}

describe('frame → pixels (§26.2)', () => {
  it('moves continuously between semantic frames, not in steps', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    const trace = drive(engine, { durationMs: 4000, snapshotHz: 4 });

    const moving = trace.slice(120);
    // Every frame between (4 Hz) semantic updates still advances the document.
    const advancing = moving.filter((f, i) => i > 0 && f.scrollPx > (moving[i - 1]?.scrollPx ?? 0));
    expect(advancing.length / moving.length).toBeGreaterThan(0.9);
    expect(trace[trace.length - 1]?.source).toBe('alignment');
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
    const engine = createStageMotionEngine();
    engine.configureSession(1, 0);
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
    // Long enough for an overdamped ω=2 controller to settle: the assertion is
    // that the fallback is resumed and ARRIVES, not how fast the plant closes
    // the last few pixels of a 2 000 px approach.
    for (let t = 500; t < 15_000; t += 16.7) last = engine.frame(t);
    expect(last.source).toBe('fallback');
    expect(last.scrollPx).toBeCloseTo(2000, 0);
  });

  it('reports a non-finite fallback target through the fuse instead of rendering NaN (C1)', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    drive(engine, { durationMs: 1000 });
    // Past the staleness threshold, so the fallback is the live source and its
    // poisoned target is the one reaching the plant.
    let last = engine.frame(20_000);
    for (let t = 20_000; t < 21_000; t += 16.7) last = engine.frame(t);
    const before = engine.controller.state.q;
    engine.setFallbackTarget({ scrollPx: Number.NaN, disposition: 'follow', atMs: 21_000 });
    for (let t = 21_000; t < 22_000; t += 16.7) last = engine.frame(t);
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
      'observedToken',
      'confirmedToken',
      'rateTokensPerSecond',
      'confidence',
      'evidenceAudioMs',
      'atAudioMs',
      'maxPredictionMs',
      'scriptLenTokens',
    ] as const) {
      const accepted = engine.receiveSnapshot(
        snapshotAt(60, 1500, { [field]: Number.NaN } as never),
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

  it('falls back to a pixel target only once the feed is GONE, not merely quiet', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    drive(engine, { durationMs: 1000 });
    engine.setFallbackTarget({ scrollPx: 2000, disposition: 'follow', atMs: 5000 });

    /*
     * A presenter who stops talking produces no transcript events and so no
     * snapshots. That is silence, not a fault, and `displayAt` already stops
     * advancing at `maxPredictionMs` — so several seconds of quiet must NOT
     * hand the display over to a guessed target.
     */
    let quiet = engine.frame(5000);
    for (let t = 5000; t < 12_000; t += 16.7) quiet = engine.frame(t);
    expect(quiet.source).toBe('alignment');

    // Past the staleness threshold the feed is treated as gone.
    let last = engine.frame(20_000);
    for (let t = 20_000; t < 34_000; t += 16.7) last = engine.frame(t);
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
    engine.receiveSnapshot(snapshotAt(60, 2000), 2000);
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
  /*
   * The stage used to sample `alignmentDisplayAt` at `now + leadSeconds` so the
   * presenter read into already-placed text. That lead did not replace the
   * engine's extrapolation, it stacked on top of it — and every millisecond of
   * it is spent claiming words were said that were not. Measured on the live
   * captures, it took the share of a take spent ahead of the reader from 3.8%
   * to 6.5% at its old default.
   *
   * Equality with the shared contract is the assertion, not an inequality:
   * "not much ahead" is how a lead comes back at half the size.
   */
  it('samples the display at now, adding no lead of its own', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    const snap = snapshotAt(30, 1_000, { rateTokensPerSecond: 4 });
    engine.receiveSnapshot(snap, 1_000);
    // Frames well after the snapshot, where a lead would compound with the
    // engine's own extrapolation rather than hide inside it.
    for (let t = 1_000; t < 1_400; t += 16.7) engine.frame(t);
    engine.frame(1_400);

    expect(engine.lastDisplayToken).toBeCloseTo(alignmentDisplayAt(snap, 1_400), 6);
    // What the old 0.38 s default would have produced, spelled out: 1.5 tokens
    // of script the reader has given no evidence of having reached.
    expect(engine.lastDisplayToken!).toBeLessThan(alignmentDisplayAt(snap, 1_400 + 380) - 1);
  });

  it('applies a reanchor exactly once and moves the document there', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    const destinationLine = map.lines[10];
    expect(destinationLine).toBeDefined();

    drive(engine, { durationMs: 800 });

    // An accepted relocation: the position moves a long way at once, and the
    // engine says so with a decision code. The stage classifies that into one
    // authorized discontinuity — there is no directive on the wire.
    engine.receiveSnapshot(
      snapshotAt(destinationLine?.spokenUnitStart ?? 0, 800, {
        decision: 'relocationAccepted',
      }),
      800,
    );
    const trace: number[] = [];
    for (let t = 800; t <= 2300; t += 16.7) trace.push(engine.frame(t).scrollPx);

    /*
     * The document arrived at the destination line — within a line pitch,
     * because ordinary following resumes the moment the discontinuity is spent
     * and carries the display on from there.
     */
    const destinationPx = (destinationLine?.baselineY ?? 0) - R;
    expect(Math.abs(engine.controller.state.q - destinationPx)).toBeLessThan(map.linePitchPx);
    // And — crucially — it did not reverse afterwards: a re-anchor is a
    // discontinuity, not a licence to run backward.
    const settled = trace.slice(trace.length - 30);
    for (let i = 1; i < settled.length; i++) {
      expect(settled[i]!).toBeGreaterThanOrEqual((settled[i - 1] ?? 0) - 0.5);
    }
    // The discontinuity was spent exactly once.
    expect(engine.transitions.consumePlantOverwrite()).toBeNull();
  });

  it('does not let a settle directive overwrite plant state', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    drive(engine, { durationMs: 1000 });
    const before = engine.controller.state.q;
    // Submitted directly: only `reanchor`/`reset` may overwrite plant state,
    // and a `settle` handed straight to the controller must still not.
    engine.transitions.submit(
      {
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
      engine.receiveSnapshot(
        snapshotAt(revisedUnit, t, { rateTokensPerSecond: 6 }),
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
        engine.receiveSnapshot(
          snapshotAt(t % 200 < 100 ? 20 : 40, t, { rateTokensPerSecond: 5 }),
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
    // Long enough for the overdamped plant to settle onto the re-anchored
    // position. The assertions are that ONE re-anchor is spent, that it waits
    // out the persistence window, and that the document ends up where the
    // presenter is — none of which is a claim about settling time.
    for (let t = 4016; t < 24_000; t += 16.7) {
      engine.receiveSnapshot(
        snapshotAt(trueUnit, t, { rateTokensPerSecond: 3 }),
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
      engine.receiveSnapshot(
        snapshotAt(2, t, { rateTokensPerSecond: 3 }),
        t,
      );
      engine.frame(t);
    }
    expect(engine.latchReanchors).toBe(0);
    for (let t = 4316; t < 5200; t += 16.7) {
      engine.receiveSnapshot(
        snapshotAt(48 + (3 * (t - 4316)) / 1000, t, { rateTokensPerSecond: 3 }),
        t,
      );
      engine.frame(t);
    }
    expect(engine.latchReanchors).toBe(0);
    expect(engine.controller.state.q).toBeGreaterThanOrEqual(advanced - 1e-6);
  });

  it('releases the latch for an accepted retake (an explicit regression)', () => {
    // Backward capability comes from the `rewind` directive an accepted retake
    // mints, not from a state — which is what makes "the presenter went back"
    // a claim the engine has to stand behind rather than a mood the display
    // can be in.
    expect(
      limitsForState('following', DEFAULT_PROFILE, { transition: 'rewind' }).allowBackward,
    ).toBe(true);
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    drive(engine, { durationMs: 4000, unitsPerSecond: 6 });
    const advanced = engine.controller.state.q;

    let last = engine.frame(4000);
    engine.receiveSnapshot(
      snapshotAt(3, 4000, { rateTokensPerSecond: 0, decision: 'retakeAccepted' }),
      4000,
    );
    for (let t = 4000; t < 7000; t += 16.7) {
      last = engine.frame(t);
    }
    expect(last.controllerState).not.toContain('target_regression');
    expect(engine.controller.state.q).toBeLessThan(advanced);
    // The retake classifies the regression itself; the latch's escape hatch is
    // for the case where nothing else will.
    expect(engine.latchReanchors).toBe(0);
  });

  /*
   * §53 "nearby rewind, distant re-anchor" — where "nearby" is measured.
   *
   * A presenter who backs up to re-read a phrase has gone somewhere they can
   * still SEE. Cutting the document there (fade down, step, fade up) is the
   * treatment for a place they cannot see, and spending it on a move of a few
   * lines is what made an ordinary re-read feel like being thrown. The gate is
   * the §30.5 reverse-travel budget in pixels, so everything the plant can
   * actually walk to is walked to.
   */
  describe('an accepted retake the plant can walk to (§53, §30.5)', () => {
    /** The reverse budget this map's pitch resolves to — the gate itself. */
    function budgetPx(map: StageRenderedLineMap): number {
      return limitsForState('following', DEFAULT_PROFILE, { linePitchPx: map.linePitchPx })
        .reverseTravelMaxPx;
    }

    /** The path position for a unit — asserted to exist, never defaulted to 0. */
    function pathPx(map: StageRenderedLineMap, unit: number): number {
      const sample = map.sampleMotionPath(unit);
      expect(sample).not.toBeNull();
      // The engine measures a rewind against `planner.target()`, which returns
      // this same number untouched whenever the path covers the unit. Asserting
      // the sample exists is what keeps the two the same measurement.
      return sample?.scrollPx ?? Number.NaN;
    }

    /** Feed one retake, then run the loop with the tracker holding position. */
    function retakeTo(engine: StageMotionEngine, unit: number, fromMs: number, toMs: number) {
      expect(
        engine.receiveSnapshot(
          snapshotAt(unit, fromMs, { rateTokensPerSecond: 0, decision: 'retakeAccepted' }),
          fromMs,
        ),
      ).toBe(true);
      const trace: ReturnType<StageMotionEngine['frame']>[] = [];
      for (let t = fromMs; t < toMs; t += 16.7) trace.push(engine.frame(t));
      return trace;
    }

    it('scrolls back to it rather than cutting, well past the old token gate', () => {
      const { map, layout } = mapFor();
      const engine = makeEngine(map, layout.contentHeightPx);
      drive(engine, { durationMs: 4000, unitsPerSecond: 12 });
      const advanced = engine.controller.state.q;
      const displayedToken = engine.lastDisplayToken ?? 0;

      // A paragraph-scale re-read: far more than the twelve tokens that used to
      // decide this, and still inside the travel the plant may spend.
      const retakeUnit = 16;
      const travelPx = advanced - pathPx(map, retakeUnit);
      expect(displayedToken - retakeUnit).toBeGreaterThan(12);
      expect(travelPx).toBeGreaterThan(map.linePitchPx * 3);
      expect(travelPx).toBeLessThan(budgetPx(map));

      const trace = retakeTo(engine, retakeUnit, 4000, 7000);
      // The classification itself, not just its consequences.
      expect(engine.transitions.seenIds).toBeGreaterThan(0);

      // Nothing was obscured: the presenter watched the script come back.
      expect(engine.reanchorFades).toBe(0);
      expect(trace.every((f) => f.documentOpacity === 1)).toBe(true);
      // And no frame stepped: the walk is continuous under the same jerk limits
      // as ordinary following. Seeded with the pre-retake position so the FIRST
      // frame after the directive is measured too — that is the one a step would
      // show up on.
      let previous = advanced;
      let biggestStep = 0;
      for (const frame of trace) {
        biggestStep = Math.max(biggestStep, Math.abs(frame.scrollPx - previous));
        previous = frame.scrollPx;
      }
      expect(biggestStep).toBeLessThan(map.linePitchPx);
      // It arrives — the licence outlives the travel it authorized.
      expect(engine.controller.state.q).toBeLessThan(advanced);
      expect(Math.abs(engine.controller.state.q - (trace[trace.length - 1]?.targetPx ?? 0)))
        .toBeLessThan(map.linePitchPx * 0.5);
      // And then it ends. A backward licence that never expires would leave
      // ordinary following able to reverse for the rest of the session.
      expect(engine.transitions.active).toBeNull();
    });

    it('keeps the licence alive across the manual grace it cannot move during', () => {
      /*
       * §30.6 zeroes both velocity limits while manual authority holds, so a
       * rewind that arrives mid-drag spends none of its licence. If it expired
       * in there, nothing could ever carry the document back: ordinary
       * following is forward-only, and the directive is idempotent by id, so no
       * re-sent copy would revive it.
       */
      const { map, layout } = mapFor();
      const engine = makeEngine(map, layout.contentHeightPx);
      drive(engine, { durationMs: 4000, unitsPerSecond: 12 });
      const advanced = engine.controller.state.q;

      // The presenter grabs the script, then the tracker reports the retake.
      engine.manualOverride(advanced, 4000);
      const retakeUnit = 16;
      const destinationPx = pathPx(map, retakeUnit);
      const duringGrace = retakeTo(engine, retakeUnit, 4016, 6000);
      // Nothing moved automatically while the grace held.
      expect(duringGrace.every((f) => f.controllerState.includes('manual'))).toBe(true);
      expect(Math.abs(engine.controller.state.q - advanced)).toBeLessThan(1);

      // Grace over: the walk the presenter was promised still happens.
      for (let t = 6000; t < 10000; t += 16.7) engine.frame(t);
      expect(engine.reanchorFades).toBe(0);
      expect(Math.abs(engine.controller.state.q - destinationPx)).toBeLessThan(map.linePitchPx);
    });

    it('walks to a second retake even though the first one spent the budget', () => {
      const { map, layout } = mapFor();
      const engine = makeEngine(map, layout.contentHeightPx);
      drive(engine, { durationMs: 4000, unitsPerSecond: 12 });

      // A near-budget walk, which leaves most of §30.5's standing travel spent.
      retakeTo(engine, 18, 4000, 9000);
      expect(engine.reanchorFades).toBe(0);
      expect(engine.controller.reverseTravelPx).toBeGreaterThan(budgetPx(map) * 0.5);

      // The presenter re-reads a little — not far enough for forward motion to
      // refund what the walk spent.
      let t = 9000;
      for (let unit = 18; unit <= 26; unit += 2) {
        engine.receiveSnapshot(snapshotAt(unit, t, { rateTokensPerSecond: 3 }), t);
        for (const end = t + 700; t < end; t += 16.7) engine.frame(t);
      }
      const remainingPx = budgetPx(map) - engine.controller.reverseTravelPx;

      /*
       * A second retake that fits the standing budget ON PAPER but not what is
       * left of it — which is precisely the case that used to be promoted to a
       * cut, on the reasoning that a walk would strand the plant half way. The
       * licence is sized to the destination now, and it INCLUDES what the first
       * walk already spent, because the controller compares it against a
       * cumulative counter rather than against the distance remaining.
       */
      const destinationPx = map.sampleMotionPath(6)?.scrollPx ?? 0;
      const travelPx = engine.controller.state.q - destinationPx;
      expect(travelPx).toBeLessThan(budgetPx(map));
      expect(travelPx).toBeGreaterThan(remainingPx);

      const trace = retakeTo(engine, 6, t, t + 8000);
      expect(engine.reanchorFades).toBe(0);
      expect(trace.every((f) => f.documentOpacity === 1)).toBe(true);
      expect(Math.abs(engine.controller.state.q - destinationPx)).toBeLessThan(map.linePitchPx);
      expect(engine.guidedRewindTimeouts).toBe(0);
    });

    it('walks to one much further back than the standing reverse budget', () => {
      const { map, layout } = mapFor();
      const engine = makeEngine(map, layout.contentHeightPx);
      drive(engine, { durationMs: 8000, unitsPerSecond: 12 });
      const advanced = engine.controller.state.q;

      const retakeUnit = 2;
      const destinationPx = map.sampleMotionPath(retakeUnit)?.scrollPx ?? 0;
      // Several times the standing §30.5 budget: the distance that used to
      // guarantee a fade and a teleport.
      expect(advanced - destinationPx).toBeGreaterThan(budgetPx(map) * 2);

      const trace = retakeTo(engine, retakeUnit, 8000, 24_000);

      // Distance changed the DURATION, not the transition type.
      expect(engine.reanchorFades).toBe(0);
      expect(engine.latchReanchors).toBe(0);
      expect(trace.every((f) => f.documentOpacity === 1)).toBe(true);
      expect(trace.every((f) => !f.controllerState.includes('reanchor'))).toBe(true);
      expect(Math.abs(engine.controller.state.q - destinationPx)).toBeLessThan(map.linePitchPx);
      expect(engine.guidedRewindStarts).toBe(1);
      expect(engine.guidedRewindCompletes).toBe(1);
      expect(engine.guidedRewindTimeouts).toBe(0);
    });
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
      engine.receiveSnapshot(
        snapshotAt(5, t),
        t,
      );
      last = engine.frame(t);
    }
    // The latch does not drag the plant back toward the position it held before
    // the manual reposition: the target is the path's own answer for unit 5.
    expect(last.controllerState).not.toContain('target_regression');
    // No DISCONTINUITY was spent: the latch let go because a manual reposition
    // is an explicit classification, not because it gave up and re-anchored.
    expect(engine.latchReanchors).toBe(0);
    /*
     * And the target is the path's own answer for where the display is.
     *
     * These snapshots carry evidence stamped at the frame that delivers them,
     * so there is nothing to extrapolate across and the display sits exactly on
     * the reported position. It used to sit slightly past it — §47.3 voice lead
     * pushed the sample into the future — and that lead has been removed.
     */
    const displayed = engine.lastDisplayToken ?? -1;
    expect(displayed).toBeCloseTo(5, 6);
    expect(last.targetPx).toBeCloseTo(map.sampleMotionPath(displayed)?.scrollPx ?? -1, 0);
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
    for (let t = 0; t < 8000; t += 16.7) {
      engine.receiveSnapshot(
        snapshotAt(inside, t, { rateTokensPerSecond: 0.2 }),
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
      engine.receiveSnapshot(
        snapshotAt(inside, t, { rateTokensPerSecond: 0.2 }),
        t,
      );
      engine.frame(t);
    }
    const beyond = (span?.unitEnd ?? 1) + 0.5;
    engine.receiveSnapshot(
      snapshotAt(beyond, t, { rateTokensPerSecond: 2 }),
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
    const unitBefore = engine.lastDisplayToken ?? 0;
    expect(unitBefore).toBeGreaterThan(5);

    // The user shrinks the column: same script, completely different wrapping.
    const narrow = mapFor(2, { columnWidthPx: 420 });
    engine.setBounds(0, narrow.layout.contentHeightPx);
    engine.layoutRecovery({ map: narrow.map, nowMs: 5000 });

    const expected = narrow.map.sampleMotionPath(unitBefore)?.scrollPx ?? 0;
    expect(engine.controller.state.q).toBeCloseTo(expected, 0);
    expect(engine.controller.state.a).toBe(0);
    expect(engine.map?.generation).toBe(2);
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
    expect(ack?.sessionGeneration).toBe(1);
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
      engine.receiveSnapshot(
        snapshotAt(i * 0.2, t),
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
    expect(result.source).toBe('alignment');
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
