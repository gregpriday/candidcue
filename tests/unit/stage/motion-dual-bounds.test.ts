/**
 * The motion bounds, stated twice: in measured lines and in viewport heights
 * (companion §30, §30.3, §20.4).
 *
 * `SmoothFollowLineUnits` shipped with a `linePitchPx` option on
 * `limitsForState` that no production caller ever passed, so every rig went on
 * running the pixel numbers a 64 px body at a 1.32 line height was tuned to.
 * The engine now takes the pitch from the line map — the same object that
 * describes the geometry the bound is about — and hands it to every limit it
 * composes.
 *
 * Line units alone are not the answer either. A line is a useful scale exactly
 * while it is a small part of the glass, and a 15.6-inch panel calibrated for
 * arm's length puts the pitch past 200 px, where five lines of reverse travel
 * is more than a full screen. So each bound is met by a viewport-relative
 * ceiling and the narrower wins.
 *
 * Everything below is asserted against the ENGINE rather than against
 * `limitsForState` directly (`motion-line-units.test.ts` covers that unit), and
 * each pair of assertions is a difference the presenter would see:
 *
 *   - the same PIXEL correction is judged differently at two type sizes;
 *   - the same LINE correction is judged identically at both, which is the
 *     whole point of measuring the pitch;
 *   - and the panel can veto what the pitch licenses.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SMOOTH_FOLLOW_PROFILE as PROFILE,
  isInterpretableSmoothFollowProfile,
  type AlignmentSnapshot,
  type SmoothFollowProfile,
  type StageTransitionDirective,
} from '../../../src/shared/contracts';
import {
  buildRenderedLineMap,
  createStageMotionEngine,
  viewportBoundedProfile,
  type StageMotionEngine,
  type StageRenderedLineMap,
} from '../../../src/stage/motion';
import {
  PROVISIONAL_MAX_CORRECTION_PX,
  PROVISIONAL_MAX_CORRECTION_VIEWPORT_FRACTION,
  provisionalMaxCorrectionPx,
} from '../../../src/stage/renderer/motion';
import { fixtureFingerprint, syntheticLayout } from '../../fixtures/layout';

const FRAME_MS = 16;
const R = 400;

/**
 * A rig at a given type size, laid out ONE SPOKEN TOKEN PER LINE.
 *
 * The column is exactly one word wide, so a distance of `n` tokens is a
 * distance of `n` rendered lines and the same scenario can be posed in either
 * unit without a conversion factor sitting between the test and its claim.
 * That is the only reason for the odd geometry: with the fixture's ordinary
 * ~7.7 tokens per line, every token distance carries the pitch inside it and a
 * test that varied the pitch would vary both sides of its own comparison.
 */
function rig(options: { pitchPx: number; viewportHeightPx?: number; tokens?: number }) {
  const layout = syntheticLayout({
    blocks: [{ kind: 'paragraph', tokens: options.tokens ?? 120 }],
    columnWidthPx: 800,
    wordWidthPx: 800,
    lineHeightPx: options.pitchPx,
    startY: 800,
  });
  const viewportHeightPx = options.viewportHeightPx ?? 1080;
  const map = buildRenderedLineMap({
    fingerprint: fixtureFingerprint({ layoutGeneration: 1, viewportHeightPx }),
    tokens: layout.tokens,
    blocks: layout.blocks,
    readingLineStartY: R,
    lineHeightPx: layout.lineHeightPx,
    viewportHeightPx,
    maxScrollPx: layout.contentHeightPx,
  });
  const engine = createStageMotionEngine();
  engine.configureSession(1, 0);
  engine.setLineMap(map);
  engine.setBounds(0, layout.contentHeightPx);
  return { engine, map, maxScrollPx: layout.contentHeightPx };
}

function pxFor(map: StageRenderedLineMap, unit: number): number {
  const at = map.sampleMotionPath(unit);
  if (!at) throw new Error(`no motion path at unit ${unit}`);
  return at.scrollPx;
}

let seq = 0;

/** The presenter at `unit`, speaking at `rate` tokens per second. */
function speakingAt(
  unit: number,
  atMs: number,
  rate: number,
  decision: AlignmentSnapshot['decision'] = 'localConfirmed',
): AlignmentSnapshot {
  seq += 1;
  return {
    sessionGeneration: 1,
    seq,
    state: 'following',
    decision,
    observedToken: unit,
    confirmedToken: unit,
    observedAtom: unit,
    confirmedAtom: unit,
    rateTokensPerSecond: rate,
    evidenceAudioMs: atMs,
    atAudioMs: atMs,
    maxPredictionMs: 900,
    pauseOnsetMs: 1800,
    leadFloorMs: 550,
    maxLeadTokens: 2.5,
    displayLimitToken: 10_000,
    confidence: 0.92,
    suggestionToken: null,
    scriptLenTokens: 10_000,
  };
}

/**
 * The presenter, standing still at `unit`.
 *
 * A zero speaking rate keeps `displayAt` from extrapolating, so the target the
 * engine aims at is the position under test and nothing else.
 */
function stillAt(unit: number, atMs: number): AlignmentSnapshot {
  return speakingAt(unit, atMs, 0);
}

/**
 * Establish the forward latch at `fromUnit`, then insist for `holdMs` that the
 * presenter is at `toUnit` — the §70.5 regression the latch either suppresses
 * as tracker noise or gives way to as an authorized re-anchor, depending on
 * whether it is past `reanchorThresholdPx`.
 */
function regress(
  engine: StageMotionEngine,
  map: StageRenderedLineMap,
  options: { fromUnit: number; toUnit: number; holdMs?: number },
) {
  engine.reset(pxFor(map, options.fromUnit));
  let t = 0;
  for (; t < 400; t += FRAME_MS) {
    engine.receiveSnapshot(stillAt(options.fromUnit, t), t);
    engine.frame(t);
  }
  const until = t + (options.holdMs ?? 1500);
  for (; t < until; t += FRAME_MS) {
    engine.receiveSnapshot(stillAt(options.toUnit, t), t);
    engine.frame(t);
  }
  return {
    regressionPx: pxFor(map, options.fromUnit) - pxFor(map, options.toUnit),
    reanchored: engine.latchReanchors > 0,
    regressions: engine.targetRegressions,
  };
}

/* -------------------------------------------------------------------------
 * The pitch reaches the limits
 * ---------------------------------------------------------------------- */

describe('the engine composes its limits against the measured pitch (§30)', () => {
  it('judges the same PIXEL correction differently at 60 px and 200 px of pitch', () => {
    /*
     * ~300 px back. On small type that is five rendered lines — past the
     * re-anchor threshold, and the honest reading is "we are somewhere the
     * presenter is not". On large type the identical pixel distance is a line
     * and a half, which is tracker noise, and repositioning the document for it
     * would be the display flinching at its own jitter.
     *
     * Before the pitch was threaded through, both rigs answered with the
     * profile's 360 px and the same 300 px correction was noise on both — a
     * bound that had stopped describing anything the presenter experiences.
     */
    const small = rig({ pitchPx: 60 });
    const large = rig({ pitchPx: 200 });
    const smallRun = regress(small.engine, small.map, { fromUnit: 40, toUnit: 35 });
    const largeRun = regress(large.engine, large.map, { fromUnit: 40, toUnit: 38.5 });

    // The two scenarios really are the same pixel move, within the spline's
    // curvature between knots.
    expect(smallRun.regressionPx).toBeGreaterThan(250);
    expect(smallRun.regressionPx).toBeLessThan(350);
    expect(largeRun.regressionPx).toBeGreaterThan(250);
    expect(largeRun.regressionPx).toBeLessThan(350);

    expect(smallRun.reanchored).toBe(true);
    expect(largeRun.reanchored).toBe(false);
    // Suppressed rather than ignored: the large-type rig SAW the regression and
    // held the latch against it.
    expect(largeRun.regressions).toBeGreaterThan(0);
  });

  it('judges the same LINE correction identically at both, which is the point', () => {
    // Six lines is past the 4.25-line threshold and a line and a half is not,
    // and both statements are true of the presenter's experience rather than of
    // one panel's pixels.
    for (const pitchPx of [60, 200]) {
      const far = rig({ pitchPx });
      expect(regress(far.engine, far.map, { fromUnit: 40, toUnit: 34 }).reanchored).toBe(true);
      const near = rig({ pitchPx });
      const nearRun = regress(near.engine, near.map, { fromUnit: 40, toUnit: 38.5 });
      expect(nearRun.reanchored).toBe(false);
      expect(nearRun.regressions).toBeGreaterThan(0);
    }
  });

  it('re-anchors on a correction the profile PIXEL threshold calls noise', () => {
    /*
     * The small-type rig's re-anchor above cannot be explained by anything but
     * the pitch, and this is the arithmetic that says so: 300 px is inside the
     * profile's own 360 px threshold, which is what a stage that has measured
     * nothing runs and what every stage ran before the pitch was threaded
     * through. Five lines is past it; 300 px is not; the engine re-anchored.
     */
    const { engine, map } = rig({ pitchPx: 60 });
    const run = regress(engine, map, { fromUnit: 40, toUnit: 35 });
    expect(run.reanchored).toBe(true);
    expect(run.regressionPx).toBeLessThan(PROFILE.motion.reanchorThresholdPx);
  });
});

/* -------------------------------------------------------------------------
 * The panel caps what the pitch licenses
 * ---------------------------------------------------------------------- */

describe('viewportBoundedProfile (§30)', () => {
  it('changes nothing on the 1080 px stage the profile was tuned against', () => {
    // Identity, not equality: the reference rig must not even allocate a
    // different profile, because "these ceilings are a safety net rather than a
    // retune" is a claim about the tuned rig specifically.
    expect(viewportBoundedProfile(PROFILE, 1080)).toBe(PROFILE);
    expect(viewportBoundedProfile(PROFILE, 2160)).toBe(PROFILE);
  });

  it('narrows every coupled dynamic on a short panel, and only narrows', () => {
    const short = viewportBoundedProfile(PROFILE, 540);
    expect(short).not.toBe(PROFILE);
    expect(short.motion.maxForwardVelocityPxS).toBe(540);
    expect(short.motion.maxBackwardVelocityPxS).toBeCloseTo(378, 6);
    expect(short.motion.maxAccelerationPxS2).toBe(1350);
    expect(short.motion.maxJerkPxS3).toBe(6480);

    /*
     * Velocity, acceleration and jerk move together. The limit-cycle note in
     * `profiles.ts` is about `aMax` moving against a fixed `jerkMax`: the
     * actuator's rail-to-rail swing time `2·aMax/jerkMax` grows, phase margin
     * goes, and the text rocks. Here the swing time may only SHORTEN.
     */
    const swing = (p: SmoothFollowProfile) =>
      (2 * p.motion.maxAccelerationPxS2) / p.motion.maxJerkPxS3;
    expect(swing(short)).toBeLessThanOrEqual(swing(PROFILE) + 1e-9);

    // Nothing outside the dynamics is touched — this is a ceiling, not a feel.
    expect(short.motion.catchUpMultiplier).toBe(PROFILE.motion.catchUpMultiplier);
    expect(short.motion.reverseTravelMaxPx).toBe(PROFILE.motion.reverseTravelMaxPx);
    expect(short.lineUnits).toBe(PROFILE.lineUnits);
    expect(short.coaching).toBe(PROFILE.coaching);
  });

  it('refuses a viewport it cannot believe rather than capping motion to nothing', () => {
    for (const height of [0, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(viewportBoundedProfile(PROFILE, height)).toBe(PROFILE);
    }
  });

  it('bounds the rendered sweep on a short panel', () => {
    /*
     * The same document, the same type, the same correction — on 1080 px of
     * glass and on 540 px. A limit measured in pixels alone crosses the short
     * panel at one and two thirds screens a second, which is a document
     * leaving rather than a document following.
     *
     * Measured from Δq, never from a reported velocity: a bound the plant does
     * not actually honour would report itself honoured either way.
     */
    function peakSweep(viewportHeightPx: number): number {
      const { engine, maxScrollPx } = rig({ pitchPx: 64, viewportHeightPx, tokens: 400 });
      engine.reset(0);
      engine.setFallbackTarget({
        scrollPx: maxScrollPx,
        disposition: 'follow',
        atMs: 0,
      });
      let previous = 0;
      let peak = 0;
      for (let t = 0; t <= 3000; t += FRAME_MS) {
        const frame = engine.frame(t);
        if (t > 0) peak = Math.max(peak, ((frame.scrollPx - previous) / FRAME_MS) * 1000);
        previous = frame.scrollPx;
      }
      return peak;
    }

    const tall = peakSweep(1080);
    const short = peakSweep(540);
    // The tall panel is unbounded by the viewport and runs at the profile's own
    // ceiling; the short one is held to a screen a second.
    expect(tall).toBeGreaterThan(850);
    expect(tall).toBeLessThanOrEqual(PROFILE.motion.maxForwardVelocityPxS * 1.01);
    expect(short).toBeGreaterThan(500);
    expect(short).toBeLessThanOrEqual(540 * 1.01);
  });

  it('bounds the BOOSTED sweep too, and leaves the boost meaning 1.6x', () => {
    /*
     * The fastest motion a presenter ever sees is a licensed catch-up, and it
     * is composed at a different call site from ordinary following — so the
     * sweep test above passes with the ceiling withdrawn from exactly the site
     * where the numbers are largest.
     *
     * The second claim is the one that says WHERE the ceiling belongs. It is
     * applied to the profile's base rather than to the composed limits, so
     * `catchUpMultiplier` still means "1.6x ordinary following" on both rigs:
     * 1440 is 1.6 x 900 and 864 is 1.6 x 540. Cap after the multiplier instead
     * and the short panel would top out at its own 540, the boost would mean
     * nothing there, and §30.3's three bounds on the catch-up would be sitting
     * behind a panel constant that knows nothing about the gap being closed.
     */
    function peakCatchUpSweep(viewportHeightPx: number): number {
      const { engine, map } = rig({ pitchPx: 64, viewportHeightPx, tokens: 900 });
      engine.reset(pxFor(map, 20));
      let previous = engine.frame(0).scrollPx;
      let peak = 0;
      let unit = 20;
      let licensed = false;
      for (let t = FRAME_MS; t <= 4000; t += FRAME_MS) {
        if (t < 200) {
          // Settle, so the jump has a display position to be measured FROM.
          engine.receiveSnapshot(speakingAt(unit, t, 0), t);
        } else if (t < 200 + FRAME_MS) {
          unit = 200;
          engine.receiveSnapshot(speakingAt(unit, t, 20, 'jumpForwardAccepted'), t);
        } else {
          // Still talking, fast: the boost holds while the gap is real.
          unit += (20 * FRAME_MS) / 1000;
          engine.receiveSnapshot(speakingAt(unit, t, 20), t);
        }
        const frame = engine.frame(t);
        if (frame.controllerState.includes('catch_up')) licensed = true;
        peak = Math.max(peak, ((frame.scrollPx - previous) / FRAME_MS) * 1000);
        previous = frame.scrollPx;
      }
      // Without a licence the ceiling is never composed and the figure is noise.
      expect(licensed).toBe(true);
      return peak;
    }

    const boost = PROFILE.motion.catchUpMultiplier;
    const tall = peakCatchUpSweep(1080);
    const short = peakCatchUpSweep(540);
    expect(tall).toBeGreaterThan(PROFILE.motion.maxForwardVelocityPxS * boost * 0.99);
    expect(tall).toBeLessThanOrEqual(PROFILE.motion.maxForwardVelocityPxS * boost * 1.01);
    expect(short).toBeGreaterThan(540 * boost * 0.99);
    expect(short).toBeLessThanOrEqual(540 * boost * 1.01);
  });
});

/* -------------------------------------------------------------------------
 * The two profile fields that had no reader
 * ---------------------------------------------------------------------- */

function reanchorDirective(toUnit: number): StageTransitionDirective {
  return {
    id: 'dir-1',
    type: 'reanchor',
    authority: 'command',
    fromUnit: 40,
    toUnit,
    destinationTokenIndex: toUnit,
    issuedAtMs: 0,
    expiresAtMs: 5000,
    semanticEpoch: 1,
    reason: 'command_navigation',
  };
}

/** Drive a directive-led re-anchor and report the darkest frame it produced. */
function minOpacityForReanchor(
  profile: SmoothFollowProfile,
  pitchPx: number,
  /** Where the directive lands, in tokens — and so, in this rig, in lines. */
  toUnit = 38,
): number {
  const { engine, map } = rig({ pitchPx });
  engine.setProfile(profile);
  engine.reset(pxFor(map, 40));
  let darkest = 1;
  for (let t = 0; t <= 800; t += FRAME_MS) {
    if (t === 0) engine.transitions.submit(reanchorDirective(toUnit), t);
    engine.receiveSnapshot(stillAt(toUnit, t), t);
    darkest = Math.min(darkest, engine.frame(t).documentOpacity);
  }
  return darkest;
}

describe('§20.4 fadeSkipLines is the profile field it claims to be', () => {
  it('obscures a two-line re-anchor and cuts a re-anchor the profile calls small', () => {
    /*
     * Two rendered lines, on both runs — the only difference is the profile's
     * own answer to "how small is too small to be worth hiding". The engine
     * used to hard-code exactly one pitch, so a profile that set the field
     * changed nothing at all, which is the same defect as a setting nothing
     * reads.
     */
    expect(minOpacityForReanchor(PROFILE, 60)).toBe(0);
    const generous: SmoothFollowProfile = {
      ...PROFILE,
      lineUnits: { ...PROFILE.lineUnits!, fadeSkipLines: 3 },
    };
    expect(minOpacityForReanchor(generous, 60)).toBe(1);
  });

  it('will not let large type redefine a third of the screen as invisible', () => {
    /*
     * The viewport ceiling. At a 300 px pitch three lines is 900 px of a
     * 1080 px stage, and a step across most of the glass is one the presenter
     * sees whatever the type size — so the fade stays.
     */
    const generous: SmoothFollowProfile = {
      ...PROFILE,
      lineUnits: { ...PROFILE.lineUnits!, fadeSkipLines: 3 },
    };
    expect(minOpacityForReanchor(generous, 300)).toBe(0);
  });

  it('still skips the fade for a profile that carries no lineUnits at all', () => {
    /*
     * §55 makes `lineUnits` additive: a profile that omits the block is asking
     * for the behaviour every build before it had, and for this bound that
     * behaviour was one measured pitch. Resolving the absent field to nothing
     * would collapse the threshold onto `fadeWorthwhile`'s one-pixel floor, and
     * a half-line re-anchor the presenter could not have seen would arrive
     * wrapped in a 220 ms full-field fade — the exact gratuitous flash §20.4
     * skips the fade to avoid.
     *
     * The default profile is asserted beside it so the claim is "the block's
     * absence changed nothing", not "half a line happens to be small".
     */
    const { lineUnits: _absent, ...withoutBlock } = PROFILE;
    const legacy = withoutBlock as SmoothFollowProfile;
    expect(isInterpretableSmoothFollowProfile(legacy)).toBe(true);

    expect(minOpacityForReanchor(legacy, 60, 39.5)).toBe(1);
    expect(minOpacityForReanchor(PROFILE, 60, 39.5)).toBe(1);
    // …and it is still a threshold rather than an absence: two lines fades.
    expect(minOpacityForReanchor(legacy, 60, 38)).toBe(0);
  });
});

describe('§30.3 catchUpCeilingLines bounds a catch-up with no corridor to measure', () => {
  const PITCH_PX = 64;

  /**
   * A profile boosted hard enough that the plant genuinely outruns its own
   * brake.
   *
   * The shipped 1.6× boost is gentle: the §70.5 overshoot guard stops it
   * cleanly every time, and a test written against it would pass with the
   * ceiling deleted. The ceiling is a bound on the PROFILE SPACE — anything a
   * presenter can choose — so the scenario has to reach the part of that space
   * where a jerk-limited brake physically cannot stop inside the remaining
   * error, which is what the boundary exists for.
   */
  const EAGER: SmoothFollowProfile = {
    ...PROFILE,
    motion: { ...PROFILE.motion, catchUpMultiplier: 4 },
  };

  /**
   * The largest LEAD the rendered document took over the position it should
   * have been at — `q − target`, never the tracking error. A plant parked ahead
   * of a target moving at its own speed has zero relative velocity and is
   * invisible to an error-based measure, and that is precisely the shape this
   * bound catches.
   *
   * The map is built with no reading corridor, which is the case the
   * line-relative ceiling exists for: `forwardPositionCeilingPx` was infinity
   * on exactly those frames, and ordinary following is forward-only, so the
   * overrun never came back.
   */
  function maxLeadPx(profile: SmoothFollowProfile): number {
    const { engine, map } = rig({ pitchPx: PITCH_PX, tokens: 900 });
    engine.setProfile(profile);
    engine.reset(pxFor(map, 20));
    let lead = Number.NEGATIVE_INFINITY;
    let unit = 20;
    let stopped = false;
    let licensed = false;
    for (let t = 0; t <= 8000; t += FRAME_MS) {
      if (t < 200) {
        // Settle, so the engine has a display position to measure a jump FROM.
        engine.receiveSnapshot(speakingAt(unit, t, 0), t);
      } else if (t < 200 + FRAME_MS) {
        unit = 60;
        engine.receiveSnapshot(speakingAt(unit, t, 20, 'jumpForwardAccepted'), t);
      } else if (!stopped) {
        // Still talking, fast: the feed-forward is what justifies the speed the
        // plant is carrying.
        unit += (20 * FRAME_MS) / 1000;
        engine.receiveSnapshot(speakingAt(unit, t, 20), t);
      } else {
        // …and now they stop dead. The feed-forward vanishes under a plant that
        // is still moving at catch-up speed.
        engine.receiveSnapshot(speakingAt(unit, t, 0), t);
      }
      const frame = engine.frame(t);
      if (frame.controllerState.includes('catch_up')) licensed = true;
      if (!stopped && t > 400 && frame.targetPx - frame.scrollPx < 400) stopped = true;
      if (frame.source === 'alignment') lead = Math.max(lead, frame.scrollPx - frame.targetPx);
    }
    // The scenario really did run under a catch-up licence; without one the
    // ceiling is not applied at all and the whole measurement means nothing.
    expect(licensed).toBe(true);
    expect(stopped).toBe(true);
    return lead;
  }

  it('holds the line inside one pitch of where it belongs', () => {
    expect(maxLeadPx(EAGER)).toBeLessThanOrEqual(PITCH_PX + 1e-6);
  });

  it('MUTATION: with the ceiling withdrawn the line is carried well past it', () => {
    const unbounded: SmoothFollowProfile = {
      ...EAGER,
      lineUnits: { ...PROFILE.lineUnits!, catchUpCeilingLines: 0 },
    };
    expect(maxLeadPx(unbounded)).toBeGreaterThan(PITCH_PX * 3);
  });
});

/* -------------------------------------------------------------------------
 * The same sentence, on the fallback path
 * ---------------------------------------------------------------------- */

describe('§16.4 the provisional cap is stated in both units too', () => {
  /*
   * The renderer's fallback runs when the line map is unresolved, which is
   * exactly when a bound has least to go on — so the ceiling is the half of it
   * that survives having measured nothing. Asserted here rather than only
   * through `ScriptLayer`, because the argument this makes about weak evidence
   * has to hold whatever eventually calls it.
   */
  it('leaves a caller that measured neither input exactly where it was', () => {
    expect(provisionalMaxCorrectionPx()).toBe(PROVISIONAL_MAX_CORRECTION_PX);
    expect(provisionalMaxCorrectionPx(null, null)).toBe(PROVISIONAL_MAX_CORRECTION_PX);
  });

  it('refuses a viewport it cannot believe rather than capping to nothing', () => {
    /*
     * A stage between layouts reports 0, and a NaN arrives from arithmetic on a
     * height nobody measured. Both must leave the line-or-pixel answer standing:
     * `Math.min(x, 0)` is a cap of zero — weak evidence could never move the
     * document at all — and `Math.min(x, NaN)` is NaN, which propagates into
     * the clamp and out onto the transform.
     */
    for (const height of [0, -1, Number.NaN]) {
      expect(provisionalMaxCorrectionPx(85, height)).toBe(provisionalMaxCorrectionPx(85));
      expect(Number.isFinite(provisionalMaxCorrectionPx(85, height))).toBe(true);
    }
  });

  it('will not let large type license a screen-sized correction on weak evidence', () => {
    /*
     * At a 300 px pitch two lines is 600 px — the whole of a 9-inch panel — and
     * `resolveLineLimitPx`'s band cannot catch it, because 300 px is a real
     * calibration rather than a measurement fault and the band is stated against
     * the pixel default rather than against the glass.
     */
    const tall = provisionalMaxCorrectionPx(300, 1080);
    expect(tall).toBe(1080 * PROVISIONAL_MAX_CORRECTION_VIEWPORT_FRACTION);
    const short = provisionalMaxCorrectionPx(300, 600);
    expect(short).toBe(600 * PROVISIONAL_MAX_CORRECTION_VIEWPORT_FRACTION);
    // Two lines at that pitch is what the ceiling is refusing.
    expect(short).toBeLessThan(600);
  });

  it('does not touch the reference rig, where two lines is nowhere near a third', () => {
    expect(provisionalMaxCorrectionPx(85, 1080)).toBe(provisionalMaxCorrectionPx(85));
    expect(provisionalMaxCorrectionPx(85, 1080)).toBeCloseTo(170, 6);
  });
});
