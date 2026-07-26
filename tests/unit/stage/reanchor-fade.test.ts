/**
 * The re-anchor visual transition (§20.4, §22.2; gate 6, acceptance §86/§87).
 *
 * A re-anchor is an authorized discontinuity, and until this existed the stage
 * simply took it: on the frame a large skip, a distant retake or a command jump
 * resolved, the document's transform was rewritten in full view and the whole
 * script teleported across the presenter's glass.
 *
 * §20.4 does not soften that step, it HIDES it — fade down, change the
 * transform while obscured, fade up. Which makes the ordering the entire
 * specification. "A fade happened" and "a jump happened" are both true of the
 * broken code; the only claim worth testing is that no frame the presenter
 * could actually see contained the movement.
 *
 * So the load-bearing assertion here is not "opacity dipped". It is: sample
 * every frame, and for every frame with non-zero opacity, the document moved by
 * less than a visible step. That fails on a bare re-anchor, and it fails on a
 * fade that merely overlaps one.
 *
 * Time is injected throughout — `engine.frame(nowMs)` IS the clock — so nothing
 * here depends on wall-clock scheduling.
 */
import { describe, expect, it } from 'vitest';
import type { AlignmentSnapshot, StageTransitionDirective } from '../../../src/shared/contracts';
import {
  buildRenderedLineMap,
  createStageMotionEngine,
  emptyRenderedLineMap,
  REANCHOR_FADE_MS,
  type StageMotionEngine,
  type StageRenderedLineMap,
} from '../../../src/stage/motion';
import { fixtureFingerprint, syntheticLayout } from '../../fixtures/layout';

const FRAME_MS = 16;
/** Where the presenter is before the correction. */
const START_UNIT = 180;
/** Where the directive says they actually are — most of a document away. */
const DESTINATION_UNIT = 10;

function makeMap() {
  const layout = syntheticLayout({
    blocks: [
      { kind: 'paragraph', tokens: 120 },
      { kind: 'paragraph', tokens: 120 },
    ],
    startY: 800,
  });
  const map = buildRenderedLineMap({
    fingerprint: fixtureFingerprint({ layoutGeneration: 1 }),
    tokens: layout.tokens,
    blocks: layout.blocks,
    readingLineStartY: 400,
    lineHeightPx: layout.lineHeightPx,
    viewportHeightPx: 1080,
    maxScrollPx: layout.contentHeightPx,
  });
  return { map, layout };
}

function pxFor(map: StageRenderedLineMap, unit: number): number {
  const at = map.sampleMotionPath(unit);
  if (!at) throw new Error(`no motion path at unit ${unit}`);
  return at.scrollPx;
}

function alignmentSnapshot(overrides: Partial<AlignmentSnapshot> = {}): AlignmentSnapshot {
  return {
    sessionGeneration: 1,
    seq: 1,
    atAudioMs: 0,
    evidenceAudioMs: 0,
    observedToken: START_UNIT,
    confirmedToken: START_UNIT,
    rateTokensPerSecond: 0,
    maxPredictionMs: 900,
    confidence: 0.9,
    state: 'following',
    decision: 'localConfirmed',
    suggestionToken: null,
    scriptLenTokens: 10_000,
    observedAtom: 0,
    confirmedAtom: 0,
    ...overrides,
  };
}

function reanchorDirective(
  overrides: Partial<StageTransitionDirective> = {},
): StageTransitionDirective {
  return {
    id: 'dir-1',
    type: 'reanchor',
    authority: 'command',
    fromUnit: START_UNIT,
    toUnit: DESTINATION_UNIT,
    destinationTokenIndex: DESTINATION_UNIT,
    issuedAtMs: 0,
    expiresAtMs: 5000,
    semanticEpoch: 1,
    reason: 'distant_retake',
    ...overrides,
  };
}

function scenario(options: { reducedMotion?: boolean; invalidMap?: boolean } = {}) {
  const { map, layout } = makeMap();
  const engine = createStageMotionEngine();
  engine.configureSession(1, 0);
  engine.setLineMap(
    options.invalidMap ? emptyRenderedLineMap(fixtureFingerprint({ layoutGeneration: 1 })) : map,
  );
  engine.setBounds(0, layout.contentHeightPx);
  engine.setReducedMotion(options.reducedMotion ?? false);
  engine.reset(pxFor(map, START_UNIT));
  return { engine, map, layout };
}

interface Sample {
  t: number;
  scrollPx: number;
  opacity: number;
  controllerState: string;
  styleTick: boolean;
}

/**
 * Drive the loop frame by frame on an injected clock, re-affirming the
 * presenter's position every 50 ms.
 *
 * `directives` submits a directive on the first frame at or after its time.
 * They are submitted directly rather than ridden in on a snapshot because the
 * engine does not carry directives any more: it reports positions and decision
 * codes, and the stage mints its own. These tests are about what the FADE does
 * with a directive, so they hand one over rather than arranging for one to be
 * classified into existence.
 */
function drive(
  engine: StageMotionEngine,
  options: {
    fromMs: number;
    toMs: number;
    directives?: { atMs: number; directive: StageTransitionDirective }[];
    /**
     * Where the tracker says the presenter is at time `t`. Defaults to the
     * starting unit; the re-anchor tests move it to the destination when the
     * directive is issued, which is what a real retake epoch does — otherwise
     * ordinary following would simply chase the document back.
     */
    unitFor?: (t: number) => number;
    onFrame?: (t: number) => void;
  },
): Sample[] {
  const samples: Sample[] = [];
  const unitFor = options.unitFor ?? (() => START_UNIT);
  let revision = 0;
  let nextSemanticAt = options.fromMs;
  for (let t = options.fromMs; t <= options.toMs; t += FRAME_MS) {
    options.onFrame?.(t);
    // A directive arrives on the frame it is timed for; the worker re-affirms
    // it afterwards, and idempotency makes every copy a no-op.
    const arriving = (options.directives ?? []).find(
      (d) => d.atMs > t - FRAME_MS && d.atMs <= t,
    );
    if (arriving) engine.transitions.submit(arriving.directive, t);
    if (arriving || t >= nextSemanticAt) {
      revision++;
      const unit = unitFor(t);
      engine.receiveSnapshot(
        alignmentSnapshot({
          seq: revision,
          atAudioMs: t,
          evidenceAudioMs: t,
          observedToken: unit,
          confirmedToken: unit,
        }),
        t,
      );
      nextSemanticAt = t + 50;
    }
    const r = engine.frame(t);
    samples.push({
      t,
      scrollPx: r.scrollPx,
      opacity: r.documentOpacity,
      controllerState: r.controllerState,
      styleTick: r.styleTick,
    });
  }
  return samples;
}

const DIRECTIVE_AT_MS = 200;

/** The tracker relocates with the directive, as a retake/skip epoch does. */
function unitAfterDirective(destination = DESTINATION_UNIT) {
  return (t: number) => (t < DIRECTIVE_AT_MS ? START_UNIT : destination);
}

/** Per-frame movement large enough that a presenter would see the document go. */
function visibleStepPx(map: StageRenderedLineMap): number {
  return Math.max(8, map.linePitchPx);
}

function steps(samples: Sample[]): { from: Sample; to: Sample; deltaPx: number }[] {
  const out: { from: Sample; to: Sample; deltaPx: number }[] = [];
  for (let i = 1; i < samples.length; i++) {
    const from = samples[i - 1];
    const to = samples[i];
    if (!from || !to) continue;
    out.push({ from, to, deltaPx: Math.abs(to.scrollPx - from.scrollPx) });
  }
  return out;
}

describe('§20.4 — the document moves only while it is obscured', () => {
  it('performs the transform write on a frame whose opacity is zero', () => {
    const { engine, map } = scenario();
    const samples = drive(engine, {
      fromMs: 0,
      toMs: 900,
      directives: [{ atMs: DIRECTIVE_AT_MS, directive: reanchorDirective() }],
      unitFor: unitAfterDirective(),
    });

    const big = steps(samples).filter((s) => s.deltaPx > visibleStepPx(map));
    // The correction is spent as ONE discontinuity, not a traversal (gate 6).
    expect(big).toHaveLength(1);
    const jump = big[0];
    expect(jump?.deltaPx).toBeGreaterThan(1000);
    // …and the frame that carries it is painted at zero opacity. This is the
    // assertion the pre-fade implementation cannot satisfy: it wrote the
    // transform at full opacity.
    expect(jump?.to.opacity).toBe(0);
    // The frame before it was still showing the OLD position, deep into the
    // fade — dim and stationary, never dim and moving.
    expect(jump?.from.opacity).toBeLessThan(0.2);
  });

  it('never moves the document by a visible amount on a frame the presenter can see', () => {
    const { engine, map } = scenario();
    const samples = drive(engine, {
      fromMs: 0,
      toMs: 900,
      directives: [{ atMs: DIRECTIVE_AT_MS, directive: reanchorDirective() }],
      unitFor: unitAfterDirective(),
    });

    // The overlap test. A fade that ran alongside the jump — or a jump with no
    // fade at all — puts a large delta on a frame with opacity > 0.
    for (const s of steps(samples)) {
      // The delta is only ever *seen* if the frame carrying the new transform
      // is painted at non-zero opacity: that is the frame on which the
      // document appears in its new place.
      if (s.to.opacity > 0) {
        expect(
          s.deltaPx,
          `frame ${s.to.t}ms moved ${s.deltaPx.toFixed(1)}px at opacity ${s.to.opacity}`,
        ).toBeLessThan(visibleStepPx(map));
      }
    }
  });

  it('holds the document still through the fade-down instead of creeping under it', () => {
    const { engine } = scenario();
    const samples = drive(engine, {
      fromMs: 0,
      toMs: 900,
      directives: [{ atMs: DIRECTIVE_AT_MS, directive: reanchorDirective() }],
      unitFor: unitAfterDirective(),
    });

    const fading = samples.filter((s) => s.controllerState.includes('reanchor_fade'));
    expect(fading.length).toBeGreaterThan(3);
    const first = fading[0];
    const last = fading[fading.length - 1];
    // §20.3 step 4: decelerate, do not travel. Nothing moves behind the fade.
    expect(Math.abs((last?.scrollPx ?? 0) - (first?.scrollPx ?? 0))).toBeLessThan(1);
  });

  it('fades down and back up inside the §20.4 timing envelope', () => {
    expect(REANCHOR_FADE_MS).toBeGreaterThanOrEqual(90);
    expect(REANCHOR_FADE_MS).toBeLessThanOrEqual(130);

    const { engine } = scenario();
    const samples = drive(engine, {
      fromMs: 0,
      toMs: 900,
      directives: [{ atMs: DIRECTIVE_AT_MS, directive: reanchorDirective() }],
      unitFor: unitAfterDirective(),
    });

    const dimmed = samples.filter((s) => s.opacity < 1);
    const firstDim = dimmed[0];
    const lastDim = dimmed[dimmed.length - 1];
    const zero = samples.find((s) => s.opacity === 0);
    expect(firstDim && lastDim && zero).toBeTruthy();
    // Each leg lands within one frame of the specified duration.
    expect((zero?.t ?? 0) - (firstDim?.t ?? 0)).toBeGreaterThanOrEqual(REANCHOR_FADE_MS - FRAME_MS);
    expect((zero?.t ?? 0) - (firstDim?.t ?? 0)).toBeLessThanOrEqual(REANCHOR_FADE_MS + FRAME_MS);
    expect((lastDim?.t ?? 0) - (zero?.t ?? 0)).toBeLessThanOrEqual(REANCHOR_FADE_MS + FRAME_MS);
    // Monotone down then monotone up — no flicker, no white flash.
    let bottomed = false;
    let previous = 1;
    for (const s of dimmed) {
      if (s.opacity === 0) bottomed = true;
      else if (bottomed) expect(s.opacity).toBeGreaterThanOrEqual(previous);
      else expect(s.opacity).toBeLessThanOrEqual(previous);
      previous = s.opacity;
    }
  });

  it('refreshes styling on the obscured frame so the band is right when the text returns', () => {
    const { engine } = scenario();
    const samples = drive(engine, {
      fromMs: 0,
      toMs: 900,
      directives: [{ atMs: DIRECTIVE_AT_MS, directive: reanchorDirective() }],
      unitFor: unitAfterDirective(),
    });
    // §22.4: passed styling updates atomically with the re-anchor, not up to a
    // styling cadence later — which would be most of the fade-up spent visibly
    // correcting itself.
    const obscured = samples.find((s) => s.opacity === 0);
    expect(obscured?.styleTick).toBe(true);
  });
});

describe('§20.4 — opacity returns to 1 on every exit path', () => {
  const settled = (samples: Sample[]) => samples[samples.length - 1]?.opacity;

  it('after an ordinary completed re-anchor', () => {
    const { engine, map } = scenario();
    const samples = drive(engine, {
      fromMs: 0,
      toMs: 1200,
      directives: [{ atMs: DIRECTIVE_AT_MS, directive: reanchorDirective() }],
      unitFor: unitAfterDirective(),
    });
    expect(settled(samples)).toBe(1);
    expect(engine.transitions.active).toBeNull();
    expect(engine.reanchorFades).toBe(1);
    const landed = samples[samples.length - 1]?.scrollPx ?? -1;
    expect(Math.abs(landed - pxFor(map, DESTINATION_UNIT))).toBeLessThan(map.linePitchPx);
  });

  it('when the directive expires mid-fade', () => {
    const { engine, map } = scenario();
    const before = pxFor(map, START_UNIT);
    // Expiry lands squarely inside the fade-down.
    const samples = drive(engine, {
      fromMs: 0,
      toMs: 1200,
      directives: [
        {
          atMs: DIRECTIVE_AT_MS,
          directive: reanchorDirective({
            expiresAtMs: DIRECTIVE_AT_MS + REANCHOR_FADE_MS / 2,
          }),
        },
      ],
    });

    // The fade started, then had nothing left to hide.
    expect(engine.reanchorFades).toBe(1);
    expect(samples.some((s) => s.opacity < 1)).toBe(true);
    expect(samples.some((s) => s.opacity === 0)).toBe(false);
    // It unwound rather than stranding the presenter reading dimmed text.
    expect(settled(samples)).toBe(1);
    expect(engine.transitions.active).toBeNull();
    // And a revoked licence did not move anything.
    expect(Math.abs((samples[samples.length - 1]?.scrollPx ?? 0) - before)).toBeLessThan(
      map.linePitchPx,
    );
  });

  it('when a second directive arrives mid-fade', () => {
    const { engine, map } = scenario();
    const samples = drive(engine, {
      fromMs: 0,
      toMs: 1200,
      directives: [
        { atMs: DIRECTIVE_AT_MS, directive: reanchorDirective() },
        {
          atMs: DIRECTIVE_AT_MS + Math.round(REANCHOR_FADE_MS / 2),
          directive: reanchorDirective({
            id: 'dir-2',
            toUnit: 60,
            destinationTokenIndex: 60,
            issuedAtMs: 260,
            expiresAtMs: 6000,
          }),
        },
      ],
      unitFor: unitAfterDirective(60),
    });

    expect(settled(samples)).toBe(1);
    expect(engine.transitions.active).toBeNull();
    /*
     * Policy: REPLACE THE DESTINATION, CONTINUE THE FADE.
     *
     * Restarting the fade-down would let a burst of directives hold the glass
     * dark indefinitely; cancelling it to fade back up first would show the
     * presenter the OLD position for a moment before dropping it again. So a
     * newer directive supersedes the pending destination — the transition
     * controller already revokes the older licence — and rides the fade that
     * is already in flight. One dim-move-brighten, landing on the newest
     * authorized destination.
     */
    expect(engine.reanchorFades).toBe(1);
    const landed = samples[samples.length - 1]?.scrollPx ?? -1;
    expect(Math.abs(landed - pxFor(map, 60))).toBeLessThan(map.linePitchPx);
    expect(Math.abs(landed - pxFor(map, DESTINATION_UNIT))).toBeGreaterThan(map.linePitchPx);
    // Still obscured for the move, and still exactly one visible-scale step.
    const big = steps(samples).filter((s) => s.deltaPx > visibleStepPx(map));
    expect(big).toHaveLength(1);
    expect(big[0]?.to.opacity).toBe(0);
  });

  it('when the line map stops resolving mid-fade (§62)', () => {
    const { engine } = scenario();
    let wiped = false;
    const samples = drive(engine, {
      fromMs: 0,
      toMs: 600,
      directives: [{ atMs: DIRECTIVE_AT_MS, directive: reanchorDirective() }],
      unitFor: unitAfterDirective(),
      onFrame: (t) => {
        // A relayout wipes the map halfway through the fade-down.
        if (!wiped && t >= DIRECTIVE_AT_MS + REANCHOR_FADE_MS / 2) {
          wiped = true;
          engine.setLineMap(emptyRenderedLineMap(fixtureFingerprint({ layoutGeneration: 1 })));
        }
      },
    });

    // The §62 park takes over; the fade has nothing to hide and comes back up
    // rather than leaving the stage dim for the rest of the rebuild window.
    expect(samples.some((s) => s.controllerState.includes('transition_deferred'))).toBe(true);
    expect(settled(samples)).toBe(1);
    expect(engine.deferredPlantOverwrites).toBeGreaterThan(0);
  });

  it('when the presenter takes manual control mid-fade', () => {
    const { engine } = scenario();
    let grabbedAtMs = -1;
    const samples = drive(engine, {
      fromMs: 0,
      toMs: 1200,
      directives: [{ atMs: DIRECTIVE_AT_MS, directive: reanchorDirective() }],
      unitFor: unitAfterDirective(),
      onFrame: (t) => {
        if (grabbedAtMs < 0 && t >= DIRECTIVE_AT_MS + 3 * FRAME_MS) {
          grabbedAtMs = t;
          engine.manualOverride(1200, t);
        }
      },
    });
    // Direct manipulation is never shown through a dimmed layer: the fade the
    // directive had started is dropped on the spot.
    expect(samples.find((s) => s.t === grabbedAtMs)?.opacity).toBe(1);
    // The directive is still authorized, so it re-fades from full opacity and
    // completes normally rather than landing behind a half-dim layer.
    expect(settled(samples)).toBe(1);
    expect(engine.reanchorFades).toBe(2);
  });

  it('when the window is hidden mid-fade and restored later', () => {
    const { engine } = scenario();
    drive(engine, {
      fromMs: 0,
      toMs: 200 + Math.round(REANCHOR_FADE_MS / 2),
      directives: [{ atMs: DIRECTIVE_AT_MS, directive: reanchorDirective() }],
      unitFor: unitAfterDirective(),
    });
    // No frames ran while hidden, so nothing could have unwound the fade.
    engine.visibilityRestored(2100, 60_000);
    expect(engine.frame(60_016).documentOpacity).toBe(1);
  });

  it('when the session is reconfigured mid-fade', () => {
    const { engine } = scenario();
    drive(engine, {
      fromMs: 0,
      toMs: 200 + Math.round(REANCHOR_FADE_MS / 2),
      directives: [{ atMs: DIRECTIVE_AT_MS, directive: reanchorDirective() }],
      unitFor: unitAfterDirective(),
    });
  engine.configureSession(1, 1000);
    expect(engine.frame(1016).documentOpacity).toBe(1);
  });
});

describe('§20.4 — reduced motion cuts instead of fading', () => {
  it('never dims the document, and lands the correction immediately', () => {
    const { engine, map } = scenario({ reducedMotion: true });
    const samples = drive(engine, {
      fromMs: 0,
      toMs: 900,
      directives: [{ atMs: DIRECTIVE_AT_MS, directive: reanchorDirective() }],
      unitFor: unitAfterDirective(),
    });

    /*
     * §20.4 asks for "a near-instant opacity transition" here; this is a
     * deliberate, documented deviation (see `REDUCED_MOTION_FADE_MS`). Fading
     * the whole document is a full-field luminance swing, and shrinking it to
     * two frames obscures nothing anyway — it is a flicker wrapped around a
     * jump the presenter still sees. Everywhere else in this codebase reduced
     * motion already means "reposition with no spectacle" (§32.4), so a bare
     * cut is the consistent reading.
     */
    expect(samples.every((s) => s.opacity === 1)).toBe(true);
    expect(engine.reanchorFades).toBe(0);
    expect(samples.some((s) => s.controllerState.includes('reanchor_fade'))).toBe(false);

    // It still re-anchors, and still in one step.
    const big = steps(samples).filter((s) => s.deltaPx > visibleStepPx(map));
    expect(big).toHaveLength(1);
    const landed = samples[samples.length - 1]?.scrollPx ?? -1;
    expect(Math.abs(landed - pxFor(map, DESTINATION_UNIT))).toBeLessThan(map.linePitchPx);
    // And it lands on the very next frame, not a fade-down later.
    expect(big[0]?.to.t).toBeLessThanOrEqual(200 + 2 * FRAME_MS);
  });

  it('cuts a reduced-motion fallback jump too', () => {
    const { engine, layout } = scenario({ reducedMotion: true });
    engine.setFallbackTarget({ scrollPx: 300, disposition: 'instant', atMs: 0 });
    const first = engine.frame(16);
    expect(first.documentOpacity).toBe(1);
    expect(first.scrollPx).toBeCloseTo(300, 0);
    expect(layout.contentHeightPx).toBeGreaterThan(300);
  });
});

describe('§20.4 — the fade is reserved for corrections worth obscuring', () => {
  it('does not flash for a re-anchor the presenter could not see anyway', () => {
    const { engine, map } = scenario();
    // A directive whose destination is where the plant already is: a re-affirmed
    // command, or a session reset while already at the top. Fading here would be
    // a gratuitous flash on an otherwise steady stage.
    const samples = drive(engine, {
      fromMs: 0,
      toMs: 400,
      directives: [
        {
          atMs: 200,
          directive: reanchorDirective({ toUnit: START_UNIT, destinationTokenIndex: START_UNIT }),
        },
      ],
    });
    expect(samples.every((s) => s.opacity === 1)).toBe(true);
    expect(engine.reanchorFades).toBe(0);
    expect(engine.transitions.active).toBeNull();
    expect(
      Math.abs((samples[samples.length - 1]?.scrollPx ?? 0) - pxFor(map, START_UNIT)),
    ).toBeLessThan(map.linePitchPx);
  });

  it('does not start a fade for a directive that cannot be resolved (§62)', () => {
    const { engine } = scenario({ invalidMap: true });
    const samples = drive(engine, {
      fromMs: 0,
      toMs: 400,
      directives: [{ atMs: DIRECTIVE_AT_MS, directive: reanchorDirective() }],
      unitFor: unitAfterDirective(),
    });
    // The map is unusable, so the licence is parked. A fade must not begin for
    // a write that has nowhere to land — it would dim the stage for the whole
    // rebuild window with nothing to show for it.
    expect(samples.some((s) => s.controllerState.includes('transition_deferred'))).toBe(true);
    expect(samples.every((s) => s.opacity === 1)).toBe(true);
    expect(engine.reanchorFades).toBe(0);
  });

  it('does not fade a settle directive, which never writes plant state at all', () => {
    const { engine } = scenario();
    const samples = drive(engine, {
      fromMs: 0,
      toMs: 400,
      directives: [
        {
          atMs: 200,
          directive: reanchorDirective({ id: 'settle-1', type: 'settle', reason: 'layout_recovery' }),
        },
      ],
    });
    expect(samples.every((s) => s.opacity === 1)).toBe(true);
    expect(engine.reanchorFades).toBe(0);
  });
});

describe('§20.4 — the degraded snapshot path fades too', () => {
  it('obscures a fade_jump disposition from the fallback target path', () => {
    const { engine, map } = scenario();
    const target = pxFor(map, DESTINATION_UNIT);
    engine.setFallbackTarget({ scrollPx: target, disposition: 'reanchor', atMs: 0 });

    const samples: Sample[] = [];
    for (let t = 0; t <= 600; t += FRAME_MS) {
      const r = engine.frame(t);
      samples.push({
        t,
        scrollPx: r.scrollPx,
        opacity: r.documentOpacity,
        controllerState: r.controllerState,
        styleTick: r.styleTick,
      });
    }

    const big = steps(samples).filter((s) => s.deltaPx > visibleStepPx(map));
    expect(big).toHaveLength(1);
    expect(big[0]?.to.opacity).toBe(0);
    expect(samples[samples.length - 1]?.opacity).toBe(1);
    expect(engine.reanchorFades).toBe(1);
    // Consumed exactly once: it does not re-fade every frame.
    expect(samples.filter((s) => s.opacity === 0)).toHaveLength(1);
  });
});
