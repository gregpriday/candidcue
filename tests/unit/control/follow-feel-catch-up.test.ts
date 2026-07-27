/**
 * §47.1 × §30.3 — what each follow feel does with the three catch-up bounds.
 *
 * `catchUpMaxDurationMs`, `catchUpReleaseMs` and `catchUpDecayCorridors` were
 * added to `SmoothFollowProfile.motion` and inherited unscaled by every feel,
 * because `applyFeel` spreads `...base.motion`. Inheriting is not neutral here:
 * the feel scales `catchUpMultiplier`, `maxAccelerationPxS2` and `maxJerkPxS3`
 * together, so the plant the three bounds are sized against is a different
 * plant at each feel.
 *
 * These are deliberately NOT settings. §47.1's design is that the user picks a
 * feel and the app resolves it into a versioned profile; three raw numeric
 * inputs would undo that. So the only way they can be wrong is silently, and
 * the only place that can be caught is here.
 *
 * Two kinds of assertion below, both of which fail if `applyFeel` is reverted
 * to spreading the base values through:
 *
 *  - the derivation: decay distance ÷ the plant's own full-authority stopping
 *    distance, which the appendix sizes at ~1.2 and which unscaled corridors
 *    push to 1.04 at responsive — the value the appendix itself calls
 *    decoration;
 *  - the behaviour: the real stage motion engine, driven at 100 Hz, with every
 *    rate derived from Δ(rendered position) and never from a reported field.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SMOOTH_FOLLOW_PROFILE as BASE,
  type AlignmentSnapshot,
  type SmoothFollowProfile,
} from '../../../src/shared/contracts';
import {
  applyFeel,
  defaultFollowingSettings,
  resolveFollowProfile,
  FOLLOW_FEELS,
  type FollowFeel,
} from '../../../src/control/lib/follow-profiles';
import {
  buildRenderedLineMap,
  createStageMotionEngine,
  type StageMotionEngine,
  type StageMotionFrameResult,
  type StageRenderedLineMap,
} from '../../../src/stage/motion';
import { fixtureFingerprint, syntheticLayout } from '../../fixtures/layout';

/* -------------------------------------------------------------------------
 * 1. The resolved numbers
 * ---------------------------------------------------------------------- */

describe('§47.1 catch-up bounds are resolved by the feel, not inherited', () => {
  it('gives each feel its own three values', () => {
    const calm = applyFeel(BASE, 'calm').motion;
    const balanced = applyFeel(BASE, 'balanced').motion;
    const responsive = applyFeel(BASE, 'responsive').motion;

    // Balanced is the identity — the appendix profile, unmodified.
    expect(balanced.catchUpMaxDurationMs).toBe(BASE.motion.catchUpMaxDurationMs);
    expect(balanced.catchUpReleaseMs).toBe(BASE.motion.catchUpReleaseMs);
    expect(balanced.catchUpDecayCorridors).toBe(BASE.motion.catchUpDecayCorridors);

    expect(calm.catchUpMaxDurationMs).toBe(2000);
    expect(calm.catchUpReleaseMs).toBe(213);
    expect(calm.catchUpDecayCorridors).toBe(12);

    expect(responsive.catchUpMaxDurationMs).toBe(2500);
    expect(responsive.catchUpReleaseMs).toBe(288);
    expect(responsive.catchUpDecayCorridors).toBe(16);
  });

  /**
   * §47.1's standing rule, applied to a bound that did not exist when the rule
   * was written: a feel may tighten a safety ceiling and may never relax one.
   * Responsive gets a bigger multiplier, not a longer licence to use it.
   */
  it('never lets a feel extend the duration cap', () => {
    for (const feel of FOLLOW_FEELS) {
      expect(
        applyFeel(BASE, feel).motion.catchUpMaxDurationMs,
        `${feel} must not raise the §30.3 ceiling`,
      ).toBeLessThanOrEqual(BASE.motion.catchUpMaxDurationMs);
    }
  });

  it('carries the resolution all the way through resolveFollowProfile', () => {
    const calm = resolveFollowProfile({ ...defaultFollowingSettings(), feel: 'calm' });
    expect(calm.motion.catchUpMaxDurationMs).toBe(2000);
    // Voice lead touches prediction only, so it cannot disturb these.
    const calmMoreLead = resolveFollowProfile({
      ...defaultFollowingSettings(),
      feel: 'calm',
      voiceLead: 'more',
    });
    expect(calmMoreLead.motion).toEqual(calm.motion);
  });

  it('leaves the release inside the cap it ramps out of', () => {
    for (const feel of FOLLOW_FEELS) {
      const m = applyFeel(BASE, feel).motion;
      expect(m.catchUpReleaseMs, feel).toBeLessThan(m.catchUpMaxDurationMs);
      expect(m.catchUpReleaseMs, feel).toBeGreaterThan(0);
    }
  });
});

/* -------------------------------------------------------------------------
 * 2. The derivation the two scaled bounds come from
 * ---------------------------------------------------------------------- */

/**
 * A 1080p stage with the default 4% reading band. `catchUpDecayCorridors` is
 * expressed in corridor half-heights precisely so this number is the only
 * screen-dependent term.
 */
const CORRIDOR_HALF_PX = 604.8 / 14;

/**
 * Distance a boosted catch-up needs to come to rest under its own limits, on
 * the S-curve estimate the appendix uses: the constant-acceleration term plus
 * the jerk-limited term. A catch-up multiplies BOTH velocity and acceleration
 * (`stateMultipliers`, stage/motion/profiles.ts) and never jerk.
 */
function fullAuthorityStopPx(profile: SmoothFollowProfile): number {
  const m = profile.motion;
  const v = m.maxForwardVelocityPxS * m.catchUpMultiplier;
  const a = m.maxAccelerationPxS2 * m.catchUpMultiplier;
  const j = m.maxJerkPxS3;
  return (v * v) / (2 * a) + (v * a) / (2 * j);
}

function decayLeadRatio(profile: SmoothFollowProfile): number {
  return (profile.motion.catchUpDecayCorridors * CORRIDOR_HALF_PX) / fullAuthorityStopPx(profile);
}

describe('§30.3 the decay still leads the braking at every feel', () => {
  it('holds decay ÷ stopping distance within a hair of the appendix value', () => {
    const reference = decayLeadRatio(BASE);
    expect(reference).toBeGreaterThan(1.2);
    for (const feel of FOLLOW_FEELS) {
      const ratio = decayLeadRatio(applyFeel(BASE, feel));
      expect(ratio, `${feel}: the decay must lead the plant, not trail it`).toBeGreaterThan(1.15);
      expect(Math.abs(ratio - reference), `${feel} drifted from the appendix shape`).toBeLessThan(
        0.03,
      );
    }
  });

  /**
   * MUTATION. This is the revert: the three bounds spread through unscaled.
   * The appendix says the decay is decoration below about 13 corridors for the
   * balanced plant, and responsive's plant brakes 16% longer — so the inherited
   * 14 lands inside exactly that margin and the guard fires first.
   */
  it('MUTATION: inheriting the corridors unscaled makes responsive decoration', () => {
    const inherited = (feel: FollowFeel): SmoothFollowProfile => {
      const scaled = applyFeel(BASE, feel);
      return {
        ...scaled,
        motion: { ...scaled.motion, catchUpDecayCorridors: BASE.motion.catchUpDecayCorridors },
      };
    };
    expect(decayLeadRatio(inherited('responsive'))).toBeLessThan(1.1);
    // …and calm over-decays by as much in the other direction, spending its
    // boost so early it barely closes anything.
    expect(decayLeadRatio(inherited('calm'))).toBeGreaterThan(1.35);
  });

  /**
   * The release has to outlast the plant's own acceleration swing, or the ramp
   * is a step again — the shape that put a −175,500 px/s² sub-step in the
   * position trace. Responsive's swing is the longest, so its ramp is too.
   */
  it('keeps the release proportional to the acceleration swing it covers', () => {
    const swingMs = (p: SmoothFollowProfile): number =>
      (2 * p.motion.maxAccelerationPxS2 * p.motion.catchUpMultiplier * 1000) / p.motion.maxJerkPxS3;
    const reference = BASE.motion.catchUpReleaseMs / swingMs(BASE);
    for (const feel of FOLLOW_FEELS) {
      const profile = applyFeel(BASE, feel);
      const ratio = profile.motion.catchUpReleaseMs / swingMs(profile);
      expect(Math.abs(ratio - reference), `${feel}`).toBeLessThan(0.01);
    }
    // Stated as the surprise it is: every other responsive number is quicker.
    expect(applyFeel(BASE, 'responsive').motion.catchUpReleaseMs).toBeGreaterThan(
      BASE.motion.catchUpReleaseMs,
    );
  });
});

/* -------------------------------------------------------------------------
 * 3. The behaviour, on the real engine
 * ---------------------------------------------------------------------- */

interface Sample {
  tMs: number;
  /** Realized velocity over this frame, from Δ(rendered position) only. */
  vPxS: number;
  controllerState: string;
}

/**
 * A long paragraph with NO reading corridor, so the corridor decay and the
 * upper ceiling are both inert and the trace measures the duration cap alone.
 */
function driveUnclosableCatchUp(profile: SmoothFollowProfile): {
  engine: StageMotionEngine;
  trace: Sample[];
} {
  const layout = syntheticLayout({
    blocks: [{ kind: 'paragraph', tokens: 1400 }],
    columnWidthPx: 800,
    startY: 800,
  });
  const map: StageRenderedLineMap = buildRenderedLineMap({
    fingerprint: fixtureFingerprint({ layoutGeneration: 1 }),
    tokens: layout.tokens,
    blocks: layout.blocks,
    readingLineStartY: 400,
    lineHeightPx: layout.lineHeightPx,
    viewportHeightPx: 1080,
    maxScrollPx: layout.contentHeightPx,
  });
  const engine = createStageMotionEngine();
  engine.configureSession(1, 0);
  engine.setLineMap(map);
  engine.setBounds(0, layout.contentHeightPx);
  engine.setProfile(profile);

  const dt = 10;
  let revision = 0;
  let nextSemanticAt = 0;
  let previous: StageMotionFrameResult | null = null;
  const trace: Sample[] = [];

  /*
   * The catch-up licence is an ACCEPTED FORWARD JUMP: the engine reports a
   * position a long way from the last one and says it accepted the
   * discontinuity. Priming at 0 first is what makes the jump a jump, since a
   * relocation is measured from where the display already was.
   */
  const seed = (unit: number, seq: number, decision: AlignmentSnapshot['decision']) => ({
    sessionGeneration: 1,
    seq,
    atAudioMs: 0,
    evidenceAudioMs: 0,
    observedToken: unit,
    confirmedToken: Math.max(0, unit - 1),
    rateTokensPerSecond: 3,
    confidence: 0.92,
    state: 'following' as const,
    maxPredictionMs: 900,
  pauseOnsetMs: 1800,
  leadFloorMs: 550,
  maxLeadTokens: 2.5,
  displayLimitToken: 10_000,
    decision,
    suggestionToken: null,
    scriptLenTokens: 10_000,
    observedAtom: unit,
    confirmedAtom: Math.max(0, unit - 1),
  });
  engine.receiveSnapshot(seed(0, 1, 'localConfirmed'), 0);
  engine.frame(0);
  engine.receiveSnapshot(seed(700, 2, 'jumpForwardAccepted'), 0);
  revision = 2;

  for (let t = 0; t <= 4000; t += dt) {
    if (t >= nextSemanticAt) {
      revision++;
      const unit = 700 + (3 * t) / 1000;
      const frame: AlignmentSnapshot = {
        ...seed(unit, revision + 2, 'localConfirmed'),
        atAudioMs: t,
        evidenceAudioMs: t,
      };
      engine.receiveSnapshot(frame, t);
      nextSemanticAt = t + 50;
    }
    const result = engine.frame(t);
    trace.push({
      tMs: t,
      vPxS: previous === null ? 0 : ((result.scrollPx - previous.scrollPx) / dt) * 1000,
      controllerState: result.controllerState,
    });
    previous = result;
  }
  return { engine, trace };
}

function firstCappedAtMs(trace: Sample[]): number {
  return trace.find((s) => s.controllerState.includes('catch_up_capped'))?.tMs ?? Number.NaN;
}

describe('§30.3 a calm catch-up actually stops sooner on the stage', () => {
  const base = BASE.motion.maxForwardVelocityPxS;

  it('ends the boost half a second earlier than balanced does', () => {
    const calm = driveUnclosableCatchUp(applyFeel(BASE, 'calm'));
    const balanced = driveUnclosableCatchUp(applyFeel(BASE, 'balanced'));

    // Both ran as real catch-ups first — the boost is visible in the rendered
    // position, not merely configured.
    expect(Math.max(...calm.trace.slice(0, 150).map((s) => s.vPxS))).toBeGreaterThan(base * 1.2);
    expect(Math.max(...balanced.trace.slice(0, 150).map((s) => s.vPxS))).toBeGreaterThan(
      base * 1.2,
    );

    // Both ended on the cap with the gap still open, and calm ended first.
    expect(calm.engine.catchUpCapExpiries).toBe(1);
    expect(balanced.engine.catchUpCapExpiries).toBe(1);
    expect(firstCappedAtMs(calm.trace)).toBeGreaterThanOrEqual(2000);
    expect(firstCappedAtMs(calm.trace)).toBeLessThan(2100);
    expect(firstCappedAtMs(balanced.trace)).toBeGreaterThanOrEqual(2500);

    /*
     * The window that only exists because calm's cap moved: between calm's
     * ramp-out and balanced's cap, one is back to ordinary following and the
     * other is still sprinting. This is the difference a presenter sees.
     */
    const window = (t: Sample) => t.tMs >= 2300 && t.tMs <= 2450;
    expect(Math.max(...calm.trace.filter(window).map((s) => s.vPxS))).toBeLessThanOrEqual(
      base * 1.02,
    );
    expect(Math.max(...balanced.trace.filter(window).map((s) => s.vPxS))).toBeGreaterThan(
      base * 1.2,
    );
  });

  /**
   * MUTATION. With the cap inherited from the base profile — the revert — calm
   * behaves exactly like balanced, and the window above closes.
   */
  it('MUTATION: with the cap inherited, calm sprints as long as balanced', () => {
    const scaled = applyFeel(BASE, 'calm');
    const inherited = driveUnclosableCatchUp({
      ...scaled,
      motion: { ...scaled.motion, catchUpMaxDurationMs: BASE.motion.catchUpMaxDurationMs },
    });
    expect(firstCappedAtMs(inherited.trace)).toBeGreaterThanOrEqual(2500);
    const window = (t: Sample) => t.tMs >= 2300 && t.tMs <= 2450;
    // The assertion the scaled run passes is exactly the one that fails here.
    expect(Math.max(...inherited.trace.filter(window).map((s) => s.vPxS))).toBeGreaterThan(
      base * 1.15,
    );
  });
});
