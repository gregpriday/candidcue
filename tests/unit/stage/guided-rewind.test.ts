/**
 * Guided rewind — an accepted retake as one visible, eye-trackable journey
 * (companion §30.5, §53, §20.4).
 *
 * The behaviour under test, stated once:
 *
 *   accepted earlier reading position
 *     -> the live target moves to that position
 *     -> the one persistent controller brakes and reverses
 *     -> the document stays fully visible throughout
 *     -> speed stays inside the line/viewport ceiling
 *     -> the spoken line reaches the configured reading band
 *     -> the backward authority ends
 *     -> ordinary following resumes continuously
 *
 * There is no distance at which that turns into a fade, a snap or a plant
 * overwrite. What distance changes is how LONG it takes.
 *
 * Everything here drives the real engine through synthetic geometry, so the
 * assertions are about the rendered position trace rather than about the
 * alignment engine's estimated token.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SMOOTH_FOLLOW_PROFILE as DEFAULT_PROFILE,
  type AlignmentSnapshot,
} from '../../../src/shared/contracts';
import {
  buildRenderedLineMap,
  createStageMotionEngine,
  guidedRewindVelocityLimitPx,
  GUIDED_REWIND_FALLBACK_VELOCITY_PX_S,
  limitsForState,
  relocationDirectiveFor,
  type RewindReach,
  type StageMotionEngine,
  type StageMotionFrameResult,
  type StageRenderedLineMap,
} from '../../../src/stage/motion';
import { fixtureFingerprint, syntheticLayout } from '../../fixtures/layout';
import { snapshot } from '../../helpers/alignment';

const R = 400;
const VIEWPORT_PX = 1080;

function mapFor(tokensPerParagraph = 120) {
  const layout = syntheticLayout({
    blocks: [
      { kind: 'heading', tokens: 4 },
      { kind: 'paragraph', tokens: tokensPerParagraph },
      { kind: 'paragraph', tokens: tokensPerParagraph },
    ],
    columnWidthPx: 800,
    startY: 800,
  });
  const map = buildRenderedLineMap({
    fingerprint: fixtureFingerprint(),
    tokens: layout.tokens,
    blocks: layout.blocks,
    readingLineStartY: R,
    lineHeightPx: layout.lineHeightPx,
    viewportHeightPx: VIEWPORT_PX,
    maxScrollPx: layout.contentHeightPx,
  });
  return { map, layout };
}

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

function makeEngine(map: StageRenderedLineMap | null, maxScrollPx: number): StageMotionEngine {
  const engine = createStageMotionEngine();
  engine.configureSession(1, 0);
  engine.setLineMap(map);
  engine.setBounds(0, maxScrollPx);
  return engine;
}

/** Read forward at a steady pace, one snapshot a second, at a chosen refresh. */
function readForward(
  engine: StageMotionEngine,
  options: { fromMs: number; toMs: number; unitsPerSecond: number; frameMs?: number; startUnit?: number },
) {
  const frameMs = options.frameMs ?? 1000 / 60;
  let nextSnapshotAt = options.fromMs;
  const trace: StageMotionFrameResult[] = [];
  for (let t = options.fromMs; t < options.toMs; t += frameMs) {
    if (t >= nextSnapshotAt) {
      const unit =
        (options.startUnit ?? 0) + (options.unitsPerSecond * (t - options.fromMs)) / 1000;
      engine.receiveSnapshot(
        snapshotAt(unit, t, { rateTokensPerSecond: options.unitsPerSecond }),
        t,
      );
      nextSnapshotAt += 1000;
    }
    trace.push(engine.frame(t));
  }
  return trace;
}

/** One accepted retake, then frames with the tracker holding at the new place. */
function retakeTo(
  engine: StageMotionEngine,
  unit: number,
  options: { fromMs: number; toMs: number; frameMs?: number },
) {
  const frameMs = options.frameMs ?? 1000 / 60;
  expect(
    engine.receiveSnapshot(
      snapshotAt(unit, options.fromMs, { rateTokensPerSecond: 0, decision: 'retakeAccepted' }),
      options.fromMs,
    ),
  ).toBe(true);
  const trace: StageMotionFrameResult[] = [];
  for (let t = options.fromMs; t < options.toMs; t += frameMs) trace.push(engine.frame(t));
  return trace;
}

function pathPx(map: StageRenderedLineMap, unit: number): number {
  const sample = map.sampleMotionPath(unit);
  expect(sample).not.toBeNull();
  return sample?.scrollPx ?? Number.NaN;
}

/** The standing §30.5 reverse budget for this geometry — the old, fixed wall. */
function standingBudgetPx(map: StageRenderedLineMap): number {
  return limitsForState('following', DEFAULT_PROFILE, { linePitchPx: map.linePitchPx })
    .reverseTravelMaxPx;
}

/* =========================================================================
 * 1. Classification. A retake is a rewind, full stop.
 * ====================================================================== */

describe('classification: a retake never becomes a plant overwrite', () => {
  function directiveFor(fromToken: number, toToken: number, decision: AlignmentSnapshot['decision']) {
    return relocationDirectiveFor(
      snapshotAt(toToken, 0, { decision, rateTokensPerSecond: 0 }),
      fromToken,
      0,
    );
  }

  it('is a rewind at every backward distance, with no geometry to consult', () => {
    // The old rule promoted anything past the remaining reverse budget to a
    // `reanchor`, so the further back — and the more the presenter needed to
    // SEE the return — the more likely they were to get a teleport.
    for (const [from, to] of [
      [100, 99],
      [100, 95],
      [100, 70],
      [300, 20],
      [4000, 1],
    ] as const) {
      const directive = directiveFor(from, to, 'retakeAccepted');
      expect(directive?.type).toBe('rewind');
      expect(directive?.authority).toBe('ordinary');
    }
  });

  it('licenses a retake the old six-token relocation gate would have dropped', () => {
    /*
     * Ordinary following is forward-only, so a retake with no directive is a
     * retake nothing on the glass can act on: it sits behind the §70.5 forward
     * latch until the disagreement grows past `reanchorThresholdPx` and the
     * latch's escape hatch teleports the document — the outcome this whole
     * mechanism exists to remove.
     */
    expect(directiveFor(100, 97, 'retakeAccepted')?.type).toBe('rewind');
    expect(directiveFor(100, 98, 'retakeAccepted')?.type).toBe('rewind');
    // And still nothing at all for a "retake" that reports the place we are.
    expect(directiveFor(100, 100, 'retakeAccepted')).toBeNull();
    expect(directiveFor(100, 99.6, 'retakeAccepted')).toBeNull();
  });

  it('gives a rewind a licence long enough to outlive the journey', () => {
    function ttlFor(reach: RewindReach | null): number {
      const directive = relocationDirectiveFor(
        snapshotAt(20, 0, { decision: 'retakeAccepted', rateTokensPerSecond: 0 }),
        200,
        0,
        DEFAULT_PROFILE,
        undefined,
        reach,
      );
      return (directive?.expiresAtMs ?? 0) - (directive?.issuedAtMs ?? 0);
    }

    // Ten seconds is the FLOOR, which is what a retake arriving with no
    // geometry to measure against gets — and the frame loop re-arms it from the
    // real journey on the first frame it can see one (see the map-rebuild test).
    expect(ttlFor(null)).toBeGreaterThanOrEqual(10_000);

    // A journey longer than the floor covers gets more, in proportion. At three
    // lines a second an 85px pitch closes 255px/s, so 6000px is ~23.5 s of
    // travel, and the licence carries a safety multiple of that.
    const geometry = { linePitchPx: 85, viewportHeightPx: 1080 };
    const long = ttlFor({ travelPx: 6000, graceRemainingMs: 0, ...geometry });
    expect(long).toBeGreaterThan((6000 / 255) * 1000 * 2);
    // And a short one is not padded out to match it.
    const short = ttlFor({ travelPx: 200, graceRemainingMs: 0, ...geometry });
    expect(short).toBeLessThan(long);
    expect(short).toBeGreaterThanOrEqual(10_000);

    // Manual authority is time the licence provably cannot be spent, so it is
    // added on top rather than eaten into (§30.6).
    expect(ttlFor({ travelPx: 200, graceRemainingMs: 2500, ...geometry })).toBeCloseTo(
      short + 2500,
      6,
    );
  });

  it('leaves forward and manual relocation exactly as they were', () => {
    expect(directiveFor(100, 130, 'jumpForwardAccepted')?.type).toBe('catch_up');
    expect(directiveFor(100, 200, 'relocationAccepted')?.type).toBe('reanchor');
    expect(directiveFor(100, 20, 'manualAnchor')?.type).toBe('reanchor');
    // Including the six-token gate, which is the stage second-guessing a
    // classification the engine did not stake a retake decision on.
    expect(directiveFor(100, 103, 'jumpForwardAccepted')).toBeNull();
    expect(directiveFor(100, 104, 'relocationAccepted')).toBeNull();
    // A manual move is authoritative at any distance.
    expect(directiveFor(100, 101, 'manualAnchor')?.type).toBe('reanchor');
  });

  it('says nothing at all about ordinary following', () => {
    expect(directiveFor(100, 130, 'localConfirmed')).toBeNull();
    expect(directiveFor(100, 70, 'holdLowEvidence')).toBeNull();
  });
});

/* =========================================================================
 * 2. The speed ceiling: lines, met by the glass.
 * ====================================================================== */

describe('the guided rewind speed ceiling (§30.5)', () => {
  it('is the narrower of three lines a second and a third of the glass', () => {
    // pitch | viewport | which bound wins
    const matrix: Array<[number | null, number | null, number, string]> = [
      [50, 600, 150, 'lines'],
      [85, 1080, 255, 'lines'],
      [150, 600, 210, 'viewport'],
      [300, 1080, 378, 'viewport'],
      [null, 1080, GUIDED_REWIND_FALLBACK_VELOCITY_PX_S, 'pixel fallback'],
    ];
    for (const [pitch, viewport, expected] of matrix) {
      expect(guidedRewindVelocityLimitPx(pitch, viewport)).toBeCloseTo(expected, 6);
    }
  });

  it('refuses to multiply a pitch that is not a size anybody chose', () => {
    // A font that never loaded, a measurement against an empty document. The
    // 0.5x–3x band around the pixel figure is what keeps a measurement fault
    // from becoming a screen-sized sweep on the presenter's glass.
    expect(guidedRewindVelocityLimitPx(4000, 0)).toBe(GUIDED_REWIND_FALLBACK_VELOCITY_PX_S * 3);
    expect(guidedRewindVelocityLimitPx(1, 0)).toBe(GUIDED_REWIND_FALLBACK_VELOCITY_PX_S * 0.5);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -80, null, undefined]) {
      expect(guidedRewindVelocityLimitPx(bad, null)).toBe(GUIDED_REWIND_FALLBACK_VELOCITY_PX_S);
    }
  });

  it('is calmer than the manual re-acquisition ceiling, on purpose', () => {
    /*
     * A re-acquisition happens when the presenter has stopped reading and moved
     * the script by hand; a retake happens when they are mid-sentence and
     * recovering their place. The second is the worse moment to make somebody
     * chase text, so it is the slower of the two.
     */
    const rewinding = limitsForState('following', DEFAULT_PROFILE, {
      transition: 'rewind',
      linePitchPx: 85,
      viewportHeightPx: 1080,
    });
    const reacquiring = limitsForState('following', DEFAULT_PROFILE, {
      reacquire: true,
      linePitchPx: 85,
      viewportHeightPx: 1080,
    });
    expect(rewinding.vBackwardMax).toBeLessThan(reacquiring.vBackwardMax);
  });
});

describe('the limits a guided rewind actually runs under', () => {
  const base = { transition: 'rewind', linePitchPx: 85, viewportHeightPx: 1080 } as const;

  it('caps both directions, so a live target cannot produce a fast rebound', () => {
    const limits = limitsForState('following', DEFAULT_PROFILE, base);
    const cap = guidedRewindVelocityLimitPx(85, 1080);
    expect(limits.vBackwardMax).toBeCloseTo(cap, 6);
    expect(limits.vForwardMax).toBeCloseTo(cap, 6);
    // Which is a long way under what the old rewind shape permitted: 600 × 0.9
    // is 540 px/s, about 6.4 rendered lines a second at this pitch.
    expect(limits.vBackwardMax).toBeLessThan(
      DEFAULT_PROFILE.motion.maxBackwardVelocityPxS * 0.9 * 0.5,
    );
  });

  it('unlocks backward motion and stops leading', () => {
    const limits = limitsForState('following', DEFAULT_PROFILE, base);
    expect(limits.allowBackward).toBe(true);
    // Feed-forward is a bet on where the reader will be next; a rewind is the
    // stage closing a disagreement about where they are now.
    expect(limits.feedForwardScale).toBe(0);
    expect(limits.zeta).toBeGreaterThanOrEqual(1.25);
  });

  it('takes the destination-sized reverse licence, and only ever upward', () => {
    const standing = limitsForState('following', DEFAULT_PROFILE, base).reverseTravelMaxPx;
    const roomy = limitsForState('following', DEFAULT_PROFILE, {
      ...base,
      rewindReverseBudgetPx: standing * 4,
    });
    expect(roomy.reverseTravelMaxPx).toBeCloseTo(standing * 4, 6);
    // A licence smaller than the standing budget is not a reason to tighten it.
    const mean = limitsForState('following', DEFAULT_PROFILE, {
      ...base,
      rewindReverseBudgetPx: 1,
    });
    expect(mean.reverseTravelMaxPx).toBe(standing);
    for (const bad of [0, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        limitsForState('following', DEFAULT_PROFILE, { ...base, rewindReverseBudgetPx: bad })
          .reverseTravelMaxPx,
      ).toBe(standing);
    }
  });

  it('cannot move while a hand is on the script', () => {
    // §30.6 zeroes both velocity budgets, and a `min` with zero is zero.
    const limits = limitsForState('following', DEFAULT_PROFILE, { ...base, manualGrace: true });
    expect(limits.vForwardMax).toBe(0);
    expect(limits.vBackwardMax).toBe(0);
  });

  it('leaves every other path exactly where it was', () => {
    const following = limitsForState('following', DEFAULT_PROFILE, {
      linePitchPx: 85,
      viewportHeightPx: 1080,
    });
    expect(following.allowBackward).toBe(false);
    expect(following.vForwardMax).toBe(DEFAULT_PROFILE.motion.maxForwardVelocityPxS);

    for (const transition of ['catch_up', 'settle', 'reanchor', 'reset'] as const) {
      const withGlass = limitsForState('following', DEFAULT_PROFILE, {
        transition,
        linePitchPx: 85,
        viewportHeightPx: 1080,
      });
      const without = limitsForState('following', DEFAULT_PROFILE, {
        transition,
        linePitchPx: 85,
      });
      // The viewport is only ever read by the guided rewind ceiling, so adding
      // it must be a no-op for everything else.
      expect(withGlass).toEqual(without);
    }

    const reacquire = limitsForState('following', DEFAULT_PROFILE, {
      reacquire: true,
      linePitchPx: 85,
    });
    expect(
      limitsForState('following', DEFAULT_PROFILE, {
        reacquire: true,
        linePitchPx: 85,
        viewportHeightPx: 1080,
      }),
    ).toEqual(reacquire);
  });

  it('yields to reduced motion, which repositions rather than animates', () => {
    const limits = limitsForState('following', DEFAULT_PROFILE, {
      ...base,
      reducedMotion: true,
    });
    expect(limits.snap).toBe(true);
    // The cap is not applied at all: `snap` bypasses the plant, so capping it
    // would be dressing on a code path that does not integrate.
    expect(limits.vBackwardMax).toBe(
      limitsForState('following', DEFAULT_PROFILE, {
        transition: 'rewind',
        linePitchPx: 85,
        reducedMotion: true,
      }).vBackwardMax,
    );
  });
});

/* =========================================================================
 * 3. The rendered journey.
 * ====================================================================== */

describe('a distant retake, on the glass', () => {
  /** The whole journey, as one place every trace assertion can read. */
  function journey(options: { frameMs?: number; hitchAtMs?: number } = {}) {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    const frameMs = options.frameMs ?? 1000 / 60;
    readForward(engine, { fromMs: 0, toMs: 8000, unitsPerSecond: 12, frameMs });
    const advanced = engine.controller.state.q;

    const retakeUnit = 2;
    const destinationPx = pathPx(map, retakeUnit);
    const travelPx = advanced - destinationPx;

    engine.receiveSnapshot(
      snapshotAt(retakeUnit, 8000, { rateTokensPerSecond: 0, decision: 'retakeAccepted' }),
      8000,
    );
    const trace: StageMotionFrameResult[] = [];
    let hitched = false;
    for (let t = 8000; t < 30_000; ) {
      trace.push(engine.frame(t));
      if (!hitched && options.hitchAtMs !== undefined && t >= options.hitchAtMs) {
        hitched = true;
        t += 50;
      } else {
        t += frameMs;
      }
    }
    return { engine, map, trace, advanced, destinationPx, travelPx };
  }

  it('never fades, never steps, and never overwrites the plant', () => {
    const { engine, map, trace, advanced, destinationPx, travelPx } = journey();
    // The distance that used to guarantee the cut.
    expect(travelPx).toBeGreaterThan(standingBudgetPx(map) * 2);

    expect(engine.reanchorFades).toBe(0);
    expect(engine.latchReanchors).toBe(0);
    expect(trace.every((f) => f.documentOpacity === 1)).toBe(true);
    expect(trace.every((f) => !f.controllerState.includes('reanchor'))).toBe(true);

    // Progressive: many frames, each a small fraction of a rendered line, and
    // no single frame anywhere near the whole gap. Seeded from the pre-retake
    // position so the FIRST frame after the directive is measured too — the one
    // a teleport would show up on.
    let previous = advanced;
    let biggestStepPx = 0;
    let movingFrames = 0;
    for (const frame of trace) {
      const step = Math.abs(frame.scrollPx - previous);
      if (step > 0.5) movingFrames++;
      biggestStepPx = Math.max(biggestStepPx, step);
      previous = frame.scrollPx;
    }
    expect(movingFrames).toBeGreaterThan(200);
    expect(biggestStepPx).toBeLessThan(map.linePitchPx * 0.15);
    expect(biggestStepPx).toBeLessThan(travelPx * 0.01);

    // And it arrives, at the target ordinary following aims at — not at a line
    // start a re-anchor would have snapped to.
    expect(Math.abs(engine.controller.state.q - destinationPx)).toBeLessThan(
      map.linePitchPx * 0.1,
    );
  });

  it('stays inside the reading-relative speed ceiling the whole way', () => {
    const { engine, map, trace } = journey();
    const capPxS = guidedRewindVelocityLimitPx(map.linePitchPx, VIEWPORT_PX);
    const peakBackwardPxS = Math.max(0, ...trace.map((f) => -f.velocityPxS));
    expect(peakBackwardPxS).toBeGreaterThan(capPxS * 0.5); // it really did cruise
    expect(peakBackwardPxS).toBeLessThanOrEqual(capPxS * (1 + 1e-6));
    // Under three rendered lines a second, which is the claim being made.
    expect(peakBackwardPxS / map.linePitchPx).toBeLessThanOrEqual(3 + 1e-6);
    // Acceleration and jerk stay inside the same bounds ordinary following runs
    // under — the guided rewind reshapes limits, it does not escape them.
    const limits = limitsForState('following', DEFAULT_PROFILE, {
      transition: 'rewind',
      linePitchPx: map.linePitchPx,
      viewportHeightPx: VIEWPORT_PX,
    });
    expect(Math.max(...trace.map((f) => Math.abs(f.accelerationPxS2)))).toBeLessThanOrEqual(
      limits.aMax * (1 + 1e-6),
    );
    // Nothing about the walk drove the plant into a non-finite state.
    expect(engine.diagnostics.metrics.fusedFrames).toBe(0);
  });

  it('spends more reverse travel than the standing budget would ever allow', () => {
    // The mechanism, not just its consequence: the licence really is sized to
    // the destination, and the §30.5 wall really did move out of the way.
    const { engine, map } = journey();
    expect(engine.controller.reverseTravelPx).toBeGreaterThan(standingBudgetPx(map) * 1.5);
  });

  it('ends by arriving, not by timing out, and hands following straight back', () => {
    const { engine, trace } = journey();
    expect(engine.guidedRewindStarts).toBe(1);
    expect(engine.guidedRewindCompletes).toBe(1);
    expect(engine.guidedRewindTimeouts).toBe(0);
    expect(engine.guidedRewindCancels).toBe(0);
    // The backward licence is gone well before its TTL, and the trace says so.
    expect(engine.transitions.active).toBeNull();
    const walked = trace.filter((f) => f.controllerState.includes('guided_rewind'));
    expect(walked.length).toBeGreaterThan(100);
    expect(trace[trace.length - 1]?.controllerState).not.toContain('guided_rewind');
    // Ordinary forward-only following is back: the last frames are at rest.
    expect(Math.abs(trace[trace.length - 1]?.velocityPxS ?? 99)).toBeLessThan(1);
  });

  it('behaves the same at 120, 60 and 30 Hz, and across a 50 ms hitch', () => {
    const cases = [
      { label: '120hz', frameMs: 1000 / 120 },
      { label: '60hz', frameMs: 1000 / 60 },
      { label: '30hz', frameMs: 1000 / 30 },
      { label: 'hitch', frameMs: 1000 / 60, hitchAtMs: 9000 },
    ];
    for (const options of cases) {
      const { engine, map, trace, advanced, destinationPx } = journey(options);
      const capPxS = guidedRewindVelocityLimitPx(map.linePitchPx, VIEWPORT_PX);
      // No case teleports…
      expect(engine.reanchorFades).toBe(0);
      expect(trace.every((f) => f.documentOpacity === 1)).toBe(true);
      let previous = advanced;
      let biggestStepPx = 0;
      for (const frame of trace) {
        biggestStepPx = Math.max(biggestStepPx, Math.abs(frame.scrollPx - previous));
        previous = frame.scrollPx;
      }
      // …and no frame moves further than its own duration at the cap allows,
      // with the frame-time clamp covering the hitch.
      expect(biggestStepPx, options.label).toBeLessThan(
        (capPxS * Math.max(options.frameMs, 50)) / 1000 + 1,
      );
      // …and every case ends in the same place.
      expect(Math.abs(engine.controller.state.q - destinationPx), options.label).toBeLessThan(
        map.linePitchPx * 0.1,
      );
      expect(engine.guidedRewindTimeouts, options.label).toBe(0);
    }
  });
});

describe('a small retake, which is the common one', () => {
  /*
   * The backward licence is now generous — ten seconds and more — because a
   * long walk must never expire underneath itself. That generosity is only safe
   * because the episode ends on ARRIVAL: a rewind that stayed live for its whole
   * TTL would hold the §70.5 forward latch open, and ordinary tracker jitter
   * could reverse the document at will for the rest of it.
   */
  it('is walked, and hands the forward-only latch straight back', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    readForward(engine, { fromMs: 0, toMs: 6000, unitsPerSecond: 6 });
    const displayed = engine.lastDisplayToken ?? 0;

    // Three words back — under the six-token gate that used to drop this on the
    // floor, leaving forward-only following unable to act on it at all.
    const trace = retakeTo(engine, displayed - 3, { fromMs: 6000, toMs: 12_000 });
    expect(engine.guidedRewindStarts).toBe(1);
    expect(engine.guidedRewindCompletes).toBe(1);
    expect(engine.reanchorFades).toBe(0);
    expect(trace.every((f) => f.documentOpacity === 1)).toBe(true);

    // Well under a second of backward authority for a three-word correction,
    // against a licence entitled to ten.
    const walking = trace.filter((f) => f.controllerState.includes('guided_rewind'));
    expect(walking.length).toBeGreaterThan(0);
    expect(walking.length).toBeLessThan(60);
    expect(engine.transitions.active).toBeNull();
  });

  it('completes at once when the display is already at or below the retake', () => {
    // Prediction routinely leaves the display short of the reported token, so a
    // retake whose destination is not actually behind us is common. Holding a
    // backward licence open for that would be ten seconds of licence for a
    // journey of zero.
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    readForward(engine, { fromMs: 0, toMs: 6000, unitsPerSecond: 6 });
    const displayed = engine.lastDisplayToken ?? 0;

    const trace = retakeTo(engine, displayed + 2, { fromMs: 6000, toMs: 8000 });
    expect(engine.guidedRewindCompletes).toBe(1);
    expect(trace.filter((f) => f.controllerState.includes('guided_rewind')).length).toBe(1);
    expect(engine.transitions.active).toBeNull();
    expect(engine.reanchorFades).toBe(0);
  });
});

describe('the journey under real conditions', () => {
  it('brakes forward momentum smoothly instead of flipping the sign', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    // Reading on at a fair pace, so the plant carries real forward velocity
    // into the retake.
    readForward(engine, { fromMs: 0, toMs: 6000, unitsPerSecond: 12 });
    const entryVelocity = engine.controller.state.v;
    expect(entryVelocity).toBeGreaterThan(20);

    const trace = retakeTo(engine, 4, { fromMs: 6000, toMs: 26_000 });

    // A one-frame sign change is the exact visible kick the controller exists
    // to avoid, so the velocity has to walk through zero.
    const velocities = [entryVelocity, ...trace.map((f) => f.velocityPxS)];
    let biggestDeltaPxS = 0;
    for (let i = 1; i < velocities.length; i++) {
      biggestDeltaPxS = Math.max(
        biggestDeltaPxS,
        Math.abs((velocities[i] ?? 0) - (velocities[i - 1] ?? 0)),
      );
    }
    const limits = limitsForState('following', DEFAULT_PROFILE, {
      transition: 'rewind',
      linePitchPx: map.linePitchPx,
      viewportHeightPx: VIEWPORT_PX,
    });
    expect(biggestDeltaPxS).toBeLessThanOrEqual((limits.aMax * (1000 / 60)) / 1000 + 1e-6);
    // It really did cross zero rather than being reset there.
    expect(velocities.some((v) => v < -10)).toBe(true);
    expect(engine.reanchorFades).toBe(0);
    expect(Math.abs(engine.controller.state.q - pathPx(map, 4))).toBeLessThan(
      map.linePitchPx * 0.1,
    );
  });

  it('follows the live target while the presenter reads on through the retake', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    readForward(engine, { fromMs: 0, toMs: 8000, unitsPerSecond: 12 });

    // The retake, and then continued speech from the restarted phrase — so the
    // target advances underneath the walk. What must arrive at the reading band
    // is the line being spoken NOW, not the first retake word.
    engine.receiveSnapshot(
      snapshotAt(6, 8000, { rateTokensPerSecond: 3, decision: 'retakeAccepted' }),
      8000,
    );
    const trace: StageMotionFrameResult[] = [];
    let nextSnapshotAt = 9000;
    let spokenUnit = 6;
    for (let t = 8000; t < 30_000; t += 1000 / 60) {
      if (t >= nextSnapshotAt) {
        spokenUnit += 3;
        engine.receiveSnapshot(snapshotAt(spokenUnit, t, { rateTokensPerSecond: 3 }), t);
        nextSnapshotAt += 1000;
      }
      trace.push(engine.frame(t));
    }

    expect(engine.reanchorFades).toBe(0);
    expect(trace.every((f) => f.documentOpacity === 1)).toBe(true);
    expect(engine.guidedRewindCompletes).toBe(1);
    expect(engine.guidedRewindTimeouts).toBe(0);

    // No direction chatter around the settle: once the walk is over the
    // document does not hunt.
    const tail = trace.slice(-120);
    let reversals = 0;
    for (let i = 1; i < tail.length; i++) {
      const a = tail[i - 1]?.velocityPxS ?? 0;
      const b = tail[i]?.velocityPxS ?? 0;
      if (Math.sign(a) !== 0 && Math.sign(b) !== 0 && Math.sign(a) !== Math.sign(b)) reversals++;
    }
    expect(reversals).toBeLessThan(3);

    // And the document is where the tracker says the presenter is.
    const last = trace[trace.length - 1];
    expect(Math.abs((last?.scrollPx ?? 0) - (last?.targetPx ?? 0))).toBeLessThan(
      map.linePitchPx * 0.1,
    );
  });

  it('holds while the line map is rebuilding, then walks once it resolves', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    readForward(engine, { fromMs: 0, toMs: 8000, unitsPerSecond: 12 });
    const advanced = engine.controller.state.q;

    // The map goes away — a font change, a resize, an optics rebuild — and the
    // retake lands in the gap.
    engine.setLineMap(null);
    const held = retakeTo(engine, 4, { fromMs: 8000, toMs: 10_000 });
    /*
     * Nothing moved on guessed geometry, and nothing was faded or overwritten.
     * The bound is a few pixels rather than zero because the plant was reading
     * forward when the map went: §20.3 brakes it to rest under its own jerk
     * limits rather than cutting it dead, so a little run-off is the deliberate
     * behaviour. What must not happen is travel toward the retake.
     */
    expect(held.every((f) => f.documentOpacity === 1)).toBe(true);
    expect(held.every((f) => f.controllerState.includes('map_unresolved'))).toBe(true);
    expect(engine.controller.state.q).toBeGreaterThan(advanced - 1);
    expect(engine.controller.state.q - advanced).toBeLessThan(map.linePitchPx * 0.25);
    expect(engine.reanchorFades).toBe(0);
    // The authorization survived the gap rather than being spent in it.
    expect(engine.guidedRewindStarts).toBe(1);
    expect(engine.guidedRewindCompletes).toBe(0);
    expect(engine.guidedRewindTimeouts).toBe(0);

    engine.setLineMap(map);
    for (let t = 10_000; t < 26_000; t += 1000 / 60) engine.frame(t);
    expect(engine.reanchorFades).toBe(0);
    expect(engine.guidedRewindCompletes).toBe(1);
    expect(Math.abs(engine.controller.state.q - pathPx(map, 4))).toBeLessThan(
      map.linePitchPx * 0.1,
    );
  });

  it('re-arms its deadline once the destination is finally measurable', () => {
    /*
     * The regression. A retake that lands during a rebuild has no geometry to
     * resolve a destination from, so its licence is issued against the bare
     * ten-second floor — and ten seconds at three lines a second is about
     * 2 550 px. A retake to the top of a long script is further than that, so
     * the licence used to expire mid-walk and strand the plant above the
     * presenter with forward-only following unable to finish. Worse, the
     * §70.5 latch would then see a beyond-threshold disagreement and spend its
     * escape-hatch re-anchor 400 ms later: a teleport, arrived at the long way
     * round.
     */
    // A long script, so the walk is genuinely further than a bare ten-second
    // licence could carry at three rendered lines a second.
    const { map, layout } = mapFor(500);
    const engine = makeEngine(map, layout.contentHeightPx);
    readForward(engine, { fromMs: 0, toMs: 40_000, unitsPerSecond: 24 });
    const advanced = engine.controller.state.q;

    engine.setLineMap(null);
    retakeTo(engine, 2, { fromMs: 40_000, toMs: 41_000 });
    const destinationPx = pathPx(map, 2);
    // Further than the ten-second floor can carry at the guided ceiling.
    const capPxS = guidedRewindVelocityLimitPx(map.linePitchPx, VIEWPORT_PX);
    expect(advanced - destinationPx).toBeGreaterThan(capPxS * 10);

    /*
     * The map comes back, and the presenter keeps reading the restarted line.
     * Feeding the lock matters: a walk this long outlives `snapshotStaleMs`, and
     * a feed that has genuinely gone away is a hold rather than a walk — which
     * is right, and is not what is being tested here.
     */
    engine.setLineMap(map);
    let nextSnapshotAt = 41_000;
    for (let t = 41_000; t < 130_000; t += 1000 / 60) {
      if (t >= nextSnapshotAt) {
        engine.receiveSnapshot(snapshotAt(2, t, { rateTokensPerSecond: 0 }), t);
        nextSnapshotAt += 1000;
      }
      engine.frame(t);
    }

    expect(engine.guidedRewindTimeouts).toBe(0);
    expect(engine.guidedRewindCompletes).toBe(1);
    expect(engine.latchReanchors).toBe(0);
    expect(engine.reanchorFades).toBe(0);
    expect(Math.abs(engine.controller.state.q - destinationPx)).toBeLessThan(
      map.linePitchPx * 0.1,
    );
  });

  it('leaves no second owner behind when the degraded path takes the walk over', () => {
    /*
     * A walk has two possible owners — an alignment `rewind` directive and the
     * renderer's `rewind` disposition — and a long one can change hands: the
     * feed goes quiet for `snapshotStaleMs`, and the degraded path picks the
     * correction up. Retiring only the owner named in the episode leaves the
     * other armed, and either half alone is enough to hold `allowBackward` open
     * and both velocity budgets capped for the rest of the licence.
     */
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    readForward(engine, { fromMs: 0, toMs: 8000, unitsPerSecond: 12 });
    retakeTo(engine, 2, { fromMs: 8000, toMs: 9000 });
    expect(engine.transitions.active?.directive.type).toBe('rewind');

    // The feed goes away mid-walk and the renderer drives instead.
    const destinationPx = pathPx(map, 2);
    engine.setFallbackTarget({ scrollPx: destinationPx, disposition: 'rewind', atMs: 9000 });
    for (let t = 9000; t < 40_000; t += 1000 / 60) engine.frame(t);

    // One walk, one arrival, and nothing left holding backward authority.
    expect(engine.guidedRewindCompletes).toBeGreaterThanOrEqual(1);
    expect(engine.transitions.active).toBeNull();
    expect(engine.reanchorFades).toBe(0);
    expect(Math.abs(engine.controller.state.q - destinationPx)).toBeLessThan(
      map.linePitchPx * 0.5,
    );
    const settled = engine.frame(40_000);
    expect(settled.controllerState).not.toContain('guided_rewind');
  });

  it('stays visible when it supersedes a re-anchor that was mid-fade', () => {
    /*
     * A rewind that arrives during a §20.4 fade inherits it: the re-anchor's
     * licence is revoked by the supersession, so nothing is pending behind the
     * fade and it merely ramps back up over ~110 ms. The plant is not frozen
     * during that ramp, so the first stretch of the walk would be painted as a
     * half-transparent ghost — or not at all, if the fade happened to be at
     * zero when it was superseded.
     */
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    readForward(engine, { fromMs: 0, toMs: 8000, unitsPerSecond: 12 });

    // A forward relocation, which fades before it steps.
    engine.receiveSnapshot(
      snapshotAt(200, 8000, { rateTokensPerSecond: 0, decision: 'relocationAccepted' }),
      8000,
    );
    // The fade-down begins on the frame that consumes the licence, so the first
    // frame is still at full opacity by construction; sample past it.
    engine.frame(8016);
    const fading = engine.frame(8050);
    expect(fading.documentOpacity).toBeLessThan(1);
    expect(fading.documentOpacity).toBeGreaterThan(0);

    // …and, mid-fade, the presenter turns out to have gone back instead.
    const trace = retakeTo(engine, 4, { fromMs: 8066, toMs: 24_000 });
    expect(trace.every((f) => f.documentOpacity === 1)).toBe(true);
    expect(engine.guidedRewindCompletes).toBe(1);
    expect(Math.abs(engine.controller.state.q - pathPx(map, 4))).toBeLessThan(
      map.linePitchPx * 0.1,
    );
  });
});

/* =========================================================================
 * 4. Interruption. The latest deliberate instruction wins, permanently.
 * ====================================================================== */

describe('interrupting a guided rewind', () => {
  /** Read forward, retake a long way back, and get part-way home. */
  function midWalk() {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    readForward(engine, { fromMs: 0, toMs: 8000, unitsPerSecond: 12 });
    retakeTo(engine, 2, { fromMs: 8000, toMs: 11_000 });
    // Genuinely in flight: moving backward, nowhere near the destination.
    expect(engine.controller.state.v).toBeLessThan(-20);
    expect(engine.transitions.active?.directive.type).toBe('rewind');
    return { engine, map, layout, atMs: 11_000, positionPx: engine.controller.state.q };
  }

  it('is ended for good by a manual scroll — it never resumes after the grace', () => {
    const { engine, map, atMs } = midWalk();
    // The presenter puts the script where THEY want it and reads on from there.
    const parkedPx = pathPx(map, 90);
    engine.manualOverride(parkedPx, atMs, 90);
    expect(engine.guidedRewindCancels).toBe(1);
    // Revoked, not merely forgotten: the backward licence is gone with it.
    expect(engine.transitions.active).toBeNull();
    expect(
      limitsForState('following', DEFAULT_PROFILE, { linePitchPx: map.linePitchPx })
        .allowBackward,
    ).toBe(false);

    // Well past the 2.5 s grace, with the presenter reading on from where they
    // put the script. The old rewind must not come back for them.
    for (let t = atMs; t < atMs + 12_000; t += 1000 / 60) {
      if (Math.round(t) % 1000 < 17) {
        engine.receiveSnapshot(snapshotAt(90, t, { rateTokensPerSecond: 3 }), t);
      }
      engine.frame(t);
    }
    expect(engine.guidedRewindStarts).toBe(1);
    expect(engine.guidedRewindCompletes).toBe(0);
    expect(engine.reanchorFades).toBe(0);
    // The document stayed with the reader, and never set off for the retake
    // point the aligner had asked for before their hand touched the script.
    expect(Math.abs(engine.controller.state.q - parkedPx)).toBeLessThan(map.linePitchPx);
    expect(engine.controller.state.q - pathPx(map, 2)).toBeGreaterThan(
      standingBudgetPx(map) * 2,
    );
  });

  it('is ended by following being switched off', () => {
    const { engine, atMs, positionPx } = midWalk();
    engine.setPaused(true, atMs);
    expect(engine.guidedRewindCancels).toBe(1);
    expect(engine.transitions.active).toBeNull();

    for (let t = atMs; t < atMs + 8000; t += 1000 / 60) engine.frame(t);
    // §48: nothing automatic moves. A few pixels of jerk-limited run-off is the
    // deliberate reading of "stops" here, so this is a bound rather than zero.
    expect(Math.abs(engine.controller.state.q - positionPx)).toBeLessThan(40);
    expect(engine.guidedRewindCompletes).toBe(0);
    expect(engine.reanchorFades).toBe(0);
  });

  it('is replaced, not stacked, by a second retake', () => {
    const { engine, map, atMs } = midWalk();
    const firstIsAt = engine.controller.state.q;
    const velocityBefore = engine.controller.state.v;

    engine.receiveSnapshot(
      snapshotAt(60, atMs, { rateTokensPerSecond: 0, decision: 'retakeAccepted' }),
      atMs,
    );
    const first = engine.frame(atMs);
    // Plant state carries straight through: no reset, no kick.
    expect(Math.abs(first.scrollPx - firstIsAt)).toBeLessThan(2);
    expect(Math.abs(first.velocityPxS - velocityBefore)).toBeLessThan(50);

    for (let t = atMs; t < atMs + 16_000; t += 1000 / 60) engine.frame(t);
    expect(engine.guidedRewindStarts).toBe(2);
    expect(engine.guidedRewindCompletes).toBe(1);
    expect(engine.guidedRewindTimeouts).toBe(0);
    expect(engine.reanchorFades).toBe(0);
    // The newer destination is the one that wins.
    expect(Math.abs(engine.controller.state.q - pathPx(map, 60))).toBeLessThan(
      map.linePitchPx * 0.1,
    );
  });

  it('is superseded by an authorized forward relocation', () => {
    const { engine, atMs } = midWalk();
    engine.receiveSnapshot(
      snapshotAt(200, atMs, { rateTokensPerSecond: 0, decision: 'relocationAccepted' }),
      atMs,
    );
    expect(engine.guidedRewindCancels).toBe(1);
    expect(engine.transitions.active?.directive.type).toBe('reanchor');
    for (let t = atMs; t < atMs + 4000; t += 1000 / 60) engine.frame(t);
    // The forward relocation keeps its own §20.4 treatment.
    expect(engine.reanchorFades).toBe(1);
    expect(engine.guidedRewindCompletes).toBe(0);
  });

  it('does not survive a session boundary', () => {
    const { engine, atMs } = midWalk();
    engine.configureSession(2, atMs);
    expect(engine.transitions.active).toBeNull();
    // Counters are per-session, so the cancel that cleared it is cleared too.
    expect(engine.guidedRewindStarts).toBe(0);
    expect(engine.guidedRewindCancels).toBe(0);
    for (let t = atMs; t < atMs + 4000; t += 1000 / 60) engine.frame(t);
    expect(engine.guidedRewindCompletes).toBe(0);
  });
});

/* =========================================================================
 * 5. The degraded path takes the same journey.
 * ====================================================================== */

describe('a fallback retake (§62)', () => {
  it('walks, exactly as the alignment path does', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    engine.reset(6000);
    // No alignment feed at all: this is the renderer's own band correction,
    // classified as a retake by `classifyTransition`.
    const destinationPx = 1200;
    engine.setFallbackTarget({ scrollPx: destinationPx, disposition: 'rewind', atMs: 0 });

    const trace: StageMotionFrameResult[] = [];
    for (let t = 0; t < 40_000; t += 1000 / 60) trace.push(engine.frame(t));

    expect(engine.reanchorFades).toBe(0);
    expect(trace.every((f) => f.documentOpacity === 1)).toBe(true);
    expect(engine.guidedRewindStarts).toBe(1);
    expect(engine.guidedRewindCompletes).toBe(1);
    expect(engine.guidedRewindTimeouts).toBe(0);
    expect(Math.abs(engine.controller.state.q - destinationPx)).toBeLessThan(
      map.linePitchPx * 0.1,
    );

    const capPxS = guidedRewindVelocityLimitPx(map.linePitchPx, VIEWPORT_PX);
    const peakBackwardPxS = Math.max(0, ...trace.map((f) => -f.velocityPxS));
    expect(peakBackwardPxS).toBeLessThanOrEqual(capPxS * (1 + 1e-6));
    // And it really did travel further than the standing §30.5 wall.
    expect(engine.controller.reverseTravelPx).toBeGreaterThan(standingBudgetPx(map));
  });

  it('is bounded by a deadline of its own, because it owns no directive', () => {
    /*
     * An alignment episode is retired by its directive's TTL. A fallback
     * episode has no directive, and the degraded path can simply stop
     * publishing mid-walk — `setFallbackTarget(null)` — with no alignment feed
     * to take over. Without a bound the episode would wait for a frame that
     * never comes, holding `allowBackward` open and both velocity budgets
     * capped at three lines a second for the rest of the stage window's life.
     */
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    engine.reset(6000);
    engine.setFallbackTarget({ scrollPx: 1200, disposition: 'rewind', atMs: 0 });
    for (let t = 0; t < 1000; t += 1000 / 60) engine.frame(t);
    expect(engine.controller.state.v).toBeLessThan(-20);

    // The renderer stops driving: no target, and no alignment either.
    engine.setFallbackTarget(null);
    for (let t = 1000; t < 90_000; t += 1000 / 60) engine.frame(t);

    expect(engine.guidedRewindTimeouts).toBe(1);
    expect(engine.guidedRewindCompletes).toBe(0);
    // Held where it stopped — never re-anchored to a destination it failed to
    // reach gently.
    expect(engine.reanchorFades).toBe(0);
    const parkedPx = engine.controller.state.q;
    expect(parkedPx).toBeGreaterThan(1200);

    // And ordinary forward-only following really is back, at full speed.
    const last = engine.frame(90_000);
    expect(last.controllerState).not.toContain('guided_rewind');
    expect(
      limitsForState('following', DEFAULT_PROFILE, { linePitchPx: map.linePitchPx })
        .allowBackward,
    ).toBe(false);
  });

  it('cannot push its own deadline forward for ever on a walk that never lands', () => {
    /*
     * The deadline is re-armed from the journey, and only on the frames the
     * journey gets LONGER. Re-arming it every eligible frame instead would tie
     * it to the wall clock — `nowMs + ttl` grows for as long as frames keep
     * coming — so a walk that can never arrive would hold the backward licence
     * and the three-lines-a-second cap open for the rest of the session.
     *
     * A target clamped outside the document is the concrete way to get there:
     * the controller stops at its own bound, the gap never closes, and nothing
     * else in the frame loop would ever retire the episode.
     */
    for (const [label, fromPx, toPx] of [
      // A long journey, where the travel term sets the deadline…
      ['long', 7000, -5000],
      // …and a short one, where the ten-second floor does. The floor is the
      // dangerous case: it is the term that does not shrink as the gap closes,
      // so a deadline tied to the clock would renew it every single frame.
      ['short', 300, -200],
    ] as const) {
      const { map, layout } = mapFor();
      const engine = makeEngine(map, layout.contentHeightPx);
      engine.reset(fromPx);
      // Below the document's own floor, so the plant reaches its bound and
      // stops with the reported gap still open.
      engine.setFallbackTarget({ scrollPx: toPx, disposition: 'rewind', atMs: 0 });
      for (let t = 0; t < 200_000; t += 1000 / 60) engine.frame(t);

      expect(engine.guidedRewindTimeouts, label).toBe(1);
      expect(engine.guidedRewindCompletes, label).toBe(0);
      expect(engine.reanchorFades, label).toBe(0);
      // Parked at the document's own floor, not carried past it.
      expect(engine.controller.state.q, label).toBeGreaterThanOrEqual(0);
      const settled = engine.frame(200_000);
      expect(settled.controllerState, label).not.toContain('guided_rewind');
    }
  });

  it('is disarmed by an authority that arrives before its first frame', () => {
    /*
     * Backward authority can exist before an episode does. The renderer
     * publishes `disposition: 'rewind'` the moment it classifies a retake, and
     * the branch that turns that into an episode only runs on frames where the
     * fallback is the SELECTED source — so there is a window with the walk
     * armed and no episode to cancel. Returning early there made
     * `setPaused(true)` and `releaseAlignment()` look like they had taken the
     * authority away when they had not, and the next fallback frame started the
     * stale walk.
     */
    for (const disarm of ['pause', 'release'] as const) {
      const { map, layout } = mapFor();
      const engine = makeEngine(map, layout.contentHeightPx);
      engine.reset(2000);
      // Armed, but no frame has run, so no episode exists yet.
      engine.setFallbackTarget({ scrollPx: 400, disposition: 'rewind', atMs: 0 });
      expect(engine.guidedRewindStarts, disarm).toBe(0);

      if (disarm === 'pause') engine.setPaused(true, 0);
      else engine.releaseAlignment();

      // Following comes back, and the presenter's own place is what matters —
      // not a retake decided before any of that happened.
      if (disarm === 'pause') engine.setPaused(false, 1000);
      for (let t = 0; t < 20_000; t += 1000 / 60) engine.frame(t);

      expect(engine.guidedRewindStarts, disarm).toBe(0);
      expect(engine.guidedRewindCancels, disarm).toBe(0);
      expect(Math.abs(engine.controller.state.q - 2000), disarm).toBeLessThan(
        map.linePitchPx * 0.5,
      );
    }
  });

  it('is ended by a fallback that overwrites the plant instead', () => {
    // §32.4 / §20.4: `instant` and `reanchor` write the plant directly, which
    // puts the document somewhere the walk knows nothing about.
    for (const disposition of ['instant', 'reanchor'] as const) {
      const { map, layout } = mapFor();
      const engine = makeEngine(map, layout.contentHeightPx);
      const startPx = pathPx(map, 200);
      const overwritePx = pathPx(map, 120);
      engine.reset(startPx);
      engine.setFallbackTarget({ scrollPx: pathPx(map, 20), disposition: 'rewind', atMs: 0 });
      for (let t = 0; t < 1000; t += 1000 / 60) engine.frame(t);
      expect(engine.guidedRewindStarts, disposition).toBe(1);
      expect(engine.controller.state.v, disposition).toBeLessThan(-20);

      engine.setReducedMotion(disposition === 'instant');
      engine.setFallbackTarget({ scrollPx: overwritePx, disposition, atMs: 1000 });
      for (let t = 1000; t < 3000; t += 1000 / 60) engine.frame(t);

      expect(engine.guidedRewindCancels, disposition).toBe(1);
      expect(engine.guidedRewindCompletes, disposition).toBe(0);
      expect(engine.guidedRewindTimeouts, disposition).toBe(0);
      expect(Math.abs(engine.controller.state.q - overwritePx), disposition).toBeLessThan(
        map.linePitchPx,
      );
    }
  });

  it('keeps its licence when later targets come back as ordinary following', () => {
    /*
     * The renderer republishes a fallback target on every snapshot, and only
     * the retake one carries `rewind`. Dropping the episode when the next
     * `follow` target arrives would take the backward licence away mid-walk and
     * strand the plant above the presenter, which forward-only following has
     * nothing to fix with.
     */
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    engine.reset(6000);
    const destinationPx = 1200;
    engine.setFallbackTarget({ scrollPx: destinationPx, disposition: 'rewind', atMs: 0 });
    for (let t = 0; t < 2000; t += 1000 / 60) engine.frame(t);
    expect(engine.controller.state.v).toBeLessThan(-20);

    engine.setFallbackTarget({ scrollPx: destinationPx, disposition: 'follow', atMs: 2000 });
    for (let t = 2000; t < 40_000; t += 1000 / 60) engine.frame(t);

    expect(engine.guidedRewindCompletes).toBe(1);
    expect(engine.reanchorFades).toBe(0);
    expect(Math.abs(engine.controller.state.q - destinationPx)).toBeLessThan(
      map.linePitchPx * 0.1,
    );
  });
});
