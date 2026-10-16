/**
 * §30.6 — what happens after the presenter moves the script by hand.
 *
 * ---------------------------------------------------------------------------
 * THE FAILURE THIS FILE IS ABOUT
 * ---------------------------------------------------------------------------
 * A wheel gesture moves the DOCUMENT. It does not move the tracker, which goes
 * on believing the presenter is wherever it last heard them — so the moment
 * manual authority lapsed, ordinary following found a gap the size of the
 * gesture in front of it and closed it at `maxForwardVelocityPxS`: 900 px/s,
 * about ten rendered lines a second, most of a screen. From the reader's chair
 * that is the script snatching itself away, and it happened at the worst
 * possible moment — the instant they started speaking again.
 *
 * Two things had to change, and this file covers both. The hold now waits for
 * EVIDENCE rather than for a clock, so nothing moves while the presenter is
 * deciding where to read from; and the correction that follows is a bounded
 * re-acquisition rather than ordinary following, so it travels at a speed an
 * eye can stay with.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SMOOTH_FOLLOW_PROFILE as DEFAULT_PROFILE,
  type AlignmentSnapshot,
} from '../../../src/shared/contracts';
import {
  buildRenderedLineMap,
  createStageMotionEngine,
  limitsForState,
  REACQUIRE_FALLBACK_VELOCITY_PX_S,
  REACQUIRE_LINES_PER_SECOND,
  type StageMotionEngine,
  type StageRenderedLineMap,
} from '../../../src/stage/motion';
import { fixtureFingerprint, syntheticLayout } from '../../fixtures/layout';
import { snapshot } from '../../helpers/alignment';

const R = 400;
const FRAME_MS = 1000 / 60;

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
    readingLineStartY: R,
    lineHeightPx: layout.lineHeightPx,
    viewportHeightPx: 1080,
    maxScrollPx: layout.contentHeightPx,
  });
  return { map, layout };
}

function makeEngine(map: StageRenderedLineMap, maxScrollPx: number): StageMotionEngine {
  const engine = createStageMotionEngine();
  engine.configureSession(1, 0);
  engine.setLineMap(map);
  engine.setBounds(0, maxScrollPx);
  return engine;
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

/** Establish a lock and a settled document position. */
function settle(engine: StageMotionEngine, untilMs: number, unit = 12) {
  for (let t = 0; t <= untilMs; t += FRAME_MS) {
    engine.receiveSnapshot(snapshotAt(unit, t, { rateTokensPerSecond: 0 }), t);
    engine.frame(t);
  }
  return engine.controller.state.q;
}

/** Run the loop with no new snapshots at all. */
function coast(engine: StageMotionEngine, fromMs: number, toMs: number) {
  const trace = [];
  for (let t = fromMs; t < toMs; t += FRAME_MS) trace.push(engine.frame(t));
  return trace;
}

/**
 * Run the loop while the tracker keeps reporting the same place, the way it
 * does when the presenter is speaking but has not moved on yet.
 */
function speak(
  engine: StageMotionEngine,
  fromMs: number,
  toMs: number,
  unit: number,
  decision: AlignmentSnapshot['decision'] = 'localConfirmed',
) {
  const trace = [];
  for (let t = fromMs; t < toMs; t += FRAME_MS) {
    engine.receiveSnapshot(snapshotAt(unit, t, { rateTokensPerSecond: 0, decision }), t);
    trace.push(engine.frame(t));
  }
  return trace;
}

describe('the hold waits for the presenter, not for a clock', () => {
  it('does not move when the grace interval expires in silence', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    const settled = settle(engine, 3000);

    // The presenter scrolls back to re-read something, then says nothing at
    // all — reading it to themselves, drawing breath, finding their place.
    const moved = settled - 300;
    engine.manualOverride(moved, 3000);
    const trace = coast(engine, 3000, 9000);

    // Six seconds is well past the 2.5 s grace, and past the point the old
    // wall-clock rule would have set the document off toward a position the
    // presenter had deliberately left.
    expect(engine.controller.state.q).toBeCloseTo(moved, 1);
    expect(trace.every((f) => f.controllerState.includes('manual'))).toBe(true);
  });

  it('is not released by snapshots that report silence', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    const settled = settle(engine, 3000);

    const moved = settled - 300;
    engine.manualOverride(moved, 3000);
    /*
     * The aligner emits on its own cadence whether or not anybody is speaking,
     * and `noEvidence` is what it emits into silence. Releasing on one would
     * put the wall clock back in charge through the side door.
     */
    for (let t = 3000; t < 9000; t += FRAME_MS) {
      engine.receiveSnapshot(snapshotAt(12, t, { rateTokensPerSecond: 0, decision: 'noEvidence' }), t);
      engine.frame(t);
    }
    expect(engine.controller.state.q).toBeCloseTo(moved, 1);
    expect(engine.awaitingManualEvidence).toBe(true);
  });

  it('releases on the first snapshot the tracker was willing to act on', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    const settled = settle(engine, 3000);

    const moved = settled - 300;
    engine.manualOverride(moved, 3000);
    coast(engine, 3000, 6000);
    expect(engine.awaitingManualEvidence).toBe(true);

    speak(engine, 6000, 6100, 12);
    expect(engine.awaitingManualEvidence).toBe(false);
  });
});

describe('manual authority does not outlive its session', () => {
  it('is cleared by a new session, not carried into it', () => {
    /*
     * The stage window outlives a take, which is the whole reason
     * `configureSession` exists — and every other piece of cross-session state
     * is cleared there. Without this one, a take that ENDED with the
     * presenter's hand on the script opened take two already holding, with the
     * §62 degraded fallback suppressed alongside it, until somebody spoke.
     */
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    settle(engine, 3000);
    engine.manualOverride(0, 3000);
    expect(engine.awaitingManualEvidence).toBe(true);

    engine.configureSession(2, 4000);
    expect(engine.awaitingManualEvidence).toBe(false);
  });

  it('is cleared by a reset for the same reason', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    settle(engine, 3000);
    engine.manualOverride(0, 3000);

    engine.reset(0);
    expect(engine.awaitingManualEvidence).toBe(false);
  });
});

describe('the re-grab travels at reading speed', () => {
  it('closes the gap without ever running at the following ceiling', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    // 12 s, not 3: `settled` is the reference the re-grab is judged against, so
    // it has to be the plant's true resting place. An overdamped ω=2 controller
    // is still short of it at 3 s, and the assertion then reads as the re-grab
    // missing by exactly that shortfall.
    const settled = settle(engine, 12_000);

    // Scrolled back four lines or so — a re-read, the commonest gesture there
    // is on a prompter.
    const moved = settled - map.linePitchPx * 4;
    engine.manualOverride(moved, 12_000);
    coast(engine, 12_000, 13_000);

    const trace = speak(engine, 13_000, 25_000, 12);
    const peak = Math.max(...trace.map((f) => Math.abs(f.velocityPxS)));

    /*
     * The bound the presenter was promised, in the unit it was promised in.
     * A little slack for the jerk limiter's approach to it.
     */
    const ceilingPxS = REACQUIRE_LINES_PER_SECOND * map.linePitchPx;
    expect(peak).toBeLessThanOrEqual(ceilingPxS * 1.05);
    // And decisively short of what ordinary following would have spent.
    expect(peak).toBeLessThan(DEFAULT_PROFILE.motion.maxForwardVelocityPxS * 0.6);

    // It still arrives. A gentle correction that never lands is just a slow
    // version of being in the wrong place.
    expect(Math.abs(engine.controller.state.q - settled)).toBeLessThan(map.linePitchPx * 0.5);
    expect(trace.some((f) => f.controllerState.includes('reacquire'))).toBe(true);
  });

  it('walks backward to meet a presenter who scrolled ahead and read on', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    // 12 s, not 3: `settled` is the REFERENCE the re-grab is judged against, so
    // it has to be the plant's true resting place. An overdamped ω=2 controller
    // is still a pixel or two short at 3 s, and the whole assertion then reads
    // as the re-grab missing by exactly that much.
    const settled = settle(engine, 12_000);

    /*
     * The mirror case, and the one ordinary following cannot answer at all:
     * looking ahead leaves the document PAST the tracker, and reverse is
     * forbidden during following, so the script simply froze until the reader's
     * own progress caught up with where they had scrolled to.
     */
    const moved = settled + map.linePitchPx * 3;
    engine.manualOverride(moved, 12_000);
    coast(engine, 12_000, 13_000);

    // Longer than it used to need: ω dropped from 6.5 to 2.0, so the same
    // journey is walked at the same speed but eased into and out of. What is
    // asserted is that the re-grab ARRIVES, not how long it takes.
    speak(engine, 13_000, 27_000, 12);
    expect(engine.controller.state.q).toBeLessThan(moved - map.linePitchPx);
    expect(Math.abs(engine.controller.state.q - settled)).toBeLessThan(map.linePitchPx * 0.5);
  });

  it('expires rather than running forever on a gap it cannot close', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    settle(engine, 3000);

    engine.manualOverride(0, 3000);
    coast(engine, 3000, 4000);
    // Long enough to cover the wall-clock grace AND the whole eligible cap.
    const trace = speak(engine, 4000, 11_000, 60);
    const late = trace.slice(-30);
    expect(late.every((f) => !f.controllerState.includes('reacquire'))).toBe(true);
  });

  it('does not spend its allowance on frames it is not allowed to move', () => {
    /*
     * The defect this pins is the one that rebuilt the original bug out of its
     * own fix. The cap used to be an absolute deadline armed the moment
     * evidence arrived — and evidence routinely arrives in the same second as
     * the gesture, because a presenter who scrolls mid-sentence never stops
     * speaking. The deadline then ran down through the remaining wall-clock
     * grace, during which manual authority zeroes both velocity limits and the
     * plant cannot move at all. The re-grab got what was left (often a frame or
     * two), expired, and ordinary following took the rest of the gap at the
     * profile's ceiling.
     *
     * So: speak IMMEDIATELY after the gesture, and check the re-grab still gets
     * its travel once the grace lifts.
     */
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    const settled = settle(engine, 3000);

    const moved = settled - map.linePitchPx * 4;
    engine.manualOverride(moved, 3000);

    // Evidence 16 ms later — the presenter never stopped talking.
    const trace = speak(engine, 3016, 9000, 12);

    // Nothing moved during the grace, and the licence was not billed for it.
    const duringGrace = trace.filter((f) => f.controllerState.includes('manual'));
    expect(duringGrace.length).toBeGreaterThan(60);
    expect(duringGrace.every((f) => !f.controllerState.includes('reacquire'))).toBe(true);

    // And the correction, when it finally runs, is still the gentle one.
    const peak = Math.max(...trace.map((f) => Math.abs(f.velocityPxS)));
    expect(peak).toBeLessThanOrEqual(REACQUIRE_LINES_PER_SECOND * map.linePitchPx * 1.05);
    expect(trace.some((f) => f.controllerState.includes('reacquire'))).toBe(true);
    expect(Math.abs(engine.controller.state.q - settled)).toBeLessThan(map.linePitchPx * 0.5);
  });
});

describe('a long backward re-grab arrives', () => {
  it('is not dead-stopped short by the §30.5 wall', () => {
    /*
     * The gap a re-grab has to close is bounded above by the relocation
     * threshold — scroll further than half a viewport and the tracker is
     * re-seeded instead — and half a 1080 px viewport is 540 px, comfortably
     * MORE than the 420 px standing reverse budget. So the long backward
     * re-grab is the ordinary case, not an edge.
     *
     * The licence is therefore latched once, from the plant's position at the
     * start. Deriving it from the remaining gap each frame lowered the ceiling
     * as fast as the cumulative counter rose: the two met part-way, the
     * controller hit the wall, and the document stopped visibly short with
     * forward-only following unable to finish the journey.
     */
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    // See the note on the other re-grab: `settled` must be the true resting
    // place, or the gap being measured includes the settle's own shortfall.
    const settled = settle(engine, 12_000);

    const gapPx = 500;
    expect(gapPx).toBeGreaterThan(DEFAULT_PROFILE.motion.reverseTravelMaxPx);

    // Scrolled forward, so closing the gap means travelling BACKWARD.
    engine.manualOverride(settled + gapPx, 12_000);
    coast(engine, 12_000, 13_000);
    speak(engine, 13_000, 33_000, 12);

    expect(Math.abs(engine.controller.state.q - settled)).toBeLessThan(map.linePitchPx * 0.5);
  });
});

describe('the presenter overtakes the aligner', () => {
  it('does not let a catch-up minted before the gesture take the correction', () => {
    /*
     * A `catch_up` directive outlives the manual grace by design — its TTL is
     * explicitly built to cover it — so on the first frame after the grace it
     * won the limit selection and spent the gap at `catchUpMultiplier` speed,
     * around the four-lines-a-second re-grab entirely. The presenter scrolled,
     * spoke, and watched the script fly anyway: the original defect, wearing a
     * directive.
     */
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    const settled = settle(engine, 3000);

    // A forward skip the tracker accepts — this is what mints a `catch_up`.
    engine.receiveSnapshot(
      snapshotAt(40, 3000, { rateTokensPerSecond: 0, decision: 'jumpForwardAccepted' }),
      3000,
    );
    expect(engine.transitions.active?.directive.type).toBe('catch_up');

    // ...and then the presenter takes the wheel anyway.
    engine.manualOverride(settled, 3100);
    coast(engine, 3100, 4000);
    const trace = speak(engine, 4000, 9000, 12);

    const peak = Math.max(...trace.map((f) => Math.abs(f.velocityPxS)));
    expect(peak).toBeLessThanOrEqual(REACQUIRE_LINES_PER_SECOND * map.linePitchPx * 1.05);
  });

  it('keeps a manual-authority directive, which is somebody else deciding', () => {
    // An outline jump or a re-find is a DECISION, not the aligner's opinion, so
    // a wheel gesture must not quietly revoke it.
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    settle(engine, 3000);

    engine.manualOverride(0, 3000);
    engine.receiveSnapshot(
      snapshotAt(40, 3100, { rateTokensPerSecond: 0, decision: 'manualAnchor' }),
      3100,
    );
    expect(engine.transitions.active?.directive.authority).toBe('manual');
    for (let t = 3100; t < 6000; t += FRAME_MS) engine.frame(t);
    // It was spent, not starved: the plant went where the operator asked.
    const destination = map.sampleMotionPath(40)?.scrollPx ?? 0;
    expect(Math.abs(engine.controller.state.q - destination)).toBeLessThan(map.linePitchPx);
  });
});

describe('a relayout during a manual hold', () => {
  it('preserves where the presenter scrolled to, not where the aligner is', () => {
    /*
     * `lastDisplayToken` follows the ALIGNER right through a manual hold, and
     * `layoutRecovery` reached for it when the renderer had no anchor of its
     * own to offer. So a font change, a resize, or an optics rebuild landing
     * inside the hold — all of which happen mid-take — snapped the document
     * back to the place the presenter had just scrolled away from, and then
     * froze there, still holding, until they spoke.
     */
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    settle(engine, 3000, 12);

    // Scrolled a long way off, and the token now on the reading line goes with
    // the gesture — which is what the renderer supplies from its line map.
    const movedTo = map.sampleMotionPath(60)?.scrollPx ?? 0;
    engine.manualOverride(movedTo, 3000, 60);
    coast(engine, 3000, 4000);

    // A live relayout with no anchor of its own: same geometry, new generation.
    const { map: rebuilt } = mapFor(2);
    engine.layoutRecovery({ map: rebuilt, nowMs: 4000 });

    expect(Math.abs(engine.controller.state.q - movedTo)).toBeLessThan(map.linePitchPx);
  });
});

describe('switching following off holds the document', () => {
  it('stops automatic motion without stopping the frame loop', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    // Settled for long enough that the plant is genuinely AT REST before the
    // pause: an overdamped ω=2 controller still carries a little velocity at
    // 3 s, and this test is about the pause holding the document, not about
    // residual momentum coasting a pixel or two after it.
    settle(engine, 12_000);

    engine.setPaused(true);
    const parked = engine.controller.state.q;
    // The tracker carries on reporting — transcription stays connected when
    // following is switched off (§48) — and none of it moves the document.
    const trace = speak(engine, 12_000, 16_000, 60);
    expect(engine.controller.state.q).toBeCloseTo(parked, 1);
    expect(trace.every((f) => f.controllerState.includes('manual'))).toBe(true);
  });

  it('re-grabs gently when it is switched back on', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    settle(engine, 3000);

    engine.setPaused(true);
    // The presenter reads on by hand while following is off.
    engine.manualOverride(engine.controller.state.q + map.linePitchPx * 3, 3500);
    coast(engine, 3500, 5000);

    engine.setPaused(false);
    // Still nothing until they speak: the switch is not evidence.
    const parked = engine.controller.state.q;
    coast(engine, 5000, 6500);
    expect(engine.controller.state.q).toBeCloseTo(parked, 1);

    const trace = speak(engine, 6500, 10000, 12);
    const peak = Math.max(...trace.map((f) => Math.abs(f.velocityPxS)));
    expect(peak).toBeLessThanOrEqual(REACQUIRE_LINES_PER_SECOND * map.linePitchPx * 1.05);
  });

  /*
   * #275. Following off is the state a presenter picks to drive the script by
   * hand, and the pause parked EVERY re-anchor — including the operator's own
   * sentence step or section jump coming back from the engine as
   * `manualAnchor`. It sat there until its TTL ran out, so those keys moved the
   * engine and never the glass.
   */
  it.each([
    ['forward', 120],
    ['back', 4],
  ])('still goes where a manual move sends it (%s), and holds there', (_label, unit) => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    settle(engine, 12_000, 40);
    engine.setPaused(true, 12_000);

    // The answer to a move carries a rate — the engine reports `following` at
    // the place it was told — and a paused document must not run on it.
    engine.receiveSnapshot(
      snapshotAt(unit, 12_100, { decision: 'manualAnchor', confirmedToken: unit }),
      12_100,
    );
    const trace = coast(engine, 12_100, 13_000);
    const landing = trace.find((f) => f.reanchored);
    expect(landing).toBeDefined();

    const destination = map.sampleMotionPath(unit)?.scrollPx ?? 0;
    expect(Math.abs(engine.controller.state.q - destination)).toBeLessThan(map.linePitchPx);

    // From the landing frame on, through the whole of the snapshot's
    // prediction window: the display path creeps, the document does not.
    coast(engine, 13_000, 16_000);
    expect(engine.controller.state.q).toBeCloseTo(landing!.scrollPx, 1);
  });

  it('leaves a hand-scrolled document where the hand left it when the echo comes back', () => {
    /*
     * A wheel gesture far enough to relocate the reader reports the token on
     * the reading line, and the engine answers with a `manualAnchor` there.
     * Spending that answer would snap the document from where the presenter
     * stopped to the start of the same line — after every gesture, in the
     * mode where they are driving by hand.
     */
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    settle(engine, 12_000, 12);
    engine.setPaused(true, 12_000);

    // Stopped partway down a line, as a wheel does.
    const handPx = (map.sampleMotionPath(60)?.scrollPx ?? 0) + map.linePitchPx * 0.4;
    const readingY = handPx + map.readingLineStartY;
    const onMark = map.lines.find((line) => line.bottomY >= readingY)!;
    engine.manualOverride(handPx, 12_100, onMark.firstTokenIndex);
    coast(engine, 12_100, 12_400);

    engine.receiveSnapshot(
      snapshotAt(onMark.firstTokenIndex, 12_400, {
        decision: 'manualAnchor',
        confirmedToken: onMark.firstTokenIndex,
      }),
      12_400,
    );
    const trace = coast(engine, 12_400, 13_400);
    expect(trace.some((f) => f.reanchored)).toBe(false);
    expect(engine.controller.state.q).toBeCloseTo(handPx, 1);
    // Spent, not parked: nothing is left over to land when following returns.
    expect(engine.transitions.active).toBeNull();
  });

  it('recognises the echo by the line the hand reported, whatever the pixels say', () => {
    // The renderer reads the reading line off the PAINTED position, which is
    // snapped to the pixel grid; the plant is not. Half a pixel past a line's
    // bottom, the two name neighbouring lines — so the echo is matched against
    // the token the gesture reported, not against a measurement.
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    settle(engine, 12_000, 12);
    engine.setPaused(true, 12_000);

    const reported = map.lines.find((line) => line.firstTokenIndex >= 60)!;
    const handPx = reported.bottomY + 0.5 - map.readingLineStartY;
    engine.manualOverride(handPx, 12_100, reported.firstTokenIndex);
    coast(engine, 12_100, 12_400);
    engine.receiveSnapshot(
      snapshotAt(reported.firstTokenIndex, 12_400, {
        decision: 'manualAnchor',
        confirmedToken: reported.firstTokenIndex,
      }),
      12_400,
    );

    const trace = coast(engine, 12_400, 13_400);
    expect(trace.some((f) => f.reanchored)).toBe(false);
    expect(engine.controller.state.q).toBeCloseTo(handPx, 1);
  });

  it('still steps to the next line from a line boundary after a hand scroll', () => {
    // The mark resting on the bottom edge of the hand's line is not the next
    // line, and a sentence step there is a move — a paragraph gap below would
    // otherwise leave the next line short of the mark.
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    settle(engine, 12_000, 12);
    engine.setPaused(true, 12_000);

    const index = map.lines.findIndex((line) => line.firstTokenIndex >= 60);
    const hand = map.lines[index]!;
    const next = map.lines[index + 1]!;
    engine.manualOverride(hand.bottomY + 0.25 - map.readingLineStartY, 12_100, hand.firstTokenIndex);
    coast(engine, 12_100, 12_400);
    engine.receiveSnapshot(
      snapshotAt(next.firstTokenIndex, 12_400, {
        decision: 'manualAnchor',
        confirmedToken: next.firstTokenIndex,
      }),
      12_400,
    );

    expect(coast(engine, 12_400, 13_400).some((f) => f.reanchored)).toBe(true);
  });

  it('still moves to the first measured line when the reading mark is above it', () => {
    // Above the measured window is not "on its first line". Taking it for one
    // swallowed a jump to that line entirely.
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    engine.setPaused(true, 0);
    const first = map.lines[0]!;
    expect(engine.controller.state.q + map.readingLineStartY).toBeLessThan(first.topY);

    engine.receiveSnapshot(
      snapshotAt(first.firstTokenIndex, 100, {
        decision: 'manualAnchor',
        confirmedToken: first.firstTokenIndex,
      }),
      100,
    );
    const trace = coast(engine, 100, 1100);
    expect(trace.some((f) => f.reanchored)).toBe(true);
    const destination = map.sampleMotionPath(first.spokenUnitStart)?.scrollPx ?? 0;
    expect(Math.abs(engine.controller.state.q - destination)).toBeLessThan(map.linePitchPx);
  });

  it('does not take a move back once the transport has taken the document again', () => {
    /*
     * The separate stage window is handed the same alignment snapshot on every
     * live-sync revision. Releasing the lock after a move used to forget how
     * far the feed had got, so the next copy of the move was accepted as new
     * and spent again — a roll pulled back to the landing point twice a second.
     */
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    settle(engine, 12_000, 40);
    engine.setPaused(true, 12_000);

    const move = snapshotAt(120, 12_100, { decision: 'manualAnchor', confirmedToken: 120 });
    expect(engine.receiveSnapshot(move, 12_100)).toBe(true);
    expect(coast(engine, 12_100, 13_000).some((f) => f.reanchored)).toBe(true);

    engine.releaseAlignment();
    expect(engine.receiveSnapshot(move, 13_000)).toBe(false);
    expect(coast(engine, 13_000, 14_000).some((f) => f.reanchored)).toBe(false);
    // A genuinely newer snapshot is still welcome.
    expect(
      engine.receiveSnapshot(snapshotAt(130, 14_000, { decision: 'manualAnchor' }), 14_000),
    ).toBe(true);
  });

  it('keeps the aligner’s own relocations parked while following is off', () => {
    const { map, layout } = mapFor();
    const engine = makeEngine(map, layout.contentHeightPx);
    settle(engine, 12_000, 40);
    engine.setPaused(true, 12_000);
    const parked = engine.controller.state.q;

    let t = 12_100;
    for (const decision of ['relocationAccepted', 'jumpForwardAccepted'] as const) {
      engine.receiveSnapshot(snapshotAt(140, t, { decision, rateTokensPerSecond: 0 }), t);
      const trace = coast(engine, t, t + 2000);
      expect(trace.some((f) => f.reanchored)).toBe(false);
      expect(engine.controller.state.q).toBeCloseTo(parked, 1);
      t += 2000;
    }
  });
});

describe('the limits themselves (§30.6)', () => {
  const base = { linePitchPx: 85 };

  it('caps travel in lines, so the promise is the same on every panel', () => {
    for (const pitch of [50, 85, 200]) {
      const limits = limitsForState('following', DEFAULT_PROFILE, {
        reacquire: true,
        linePitchPx: pitch,
      });
      const linesPerSecond = limits.vForwardMax / pitch;
      expect(linesPerSecond).toBeCloseTo(REACQUIRE_LINES_PER_SECOND, 1);
    }
  });

  it('falls back to the pixel ceiling when no pitch has been measured', () => {
    const limits = limitsForState('following', DEFAULT_PROFILE, { reacquire: true });
    expect(limits.vForwardMax).toBe(REACQUIRE_FALLBACK_VELOCITY_PX_S);
  });

  it('only ever narrows the limits it is applied on top of', () => {
    /*
     * A `min`, never a multiplier. Applied to a state that is already slower
     * than the re-acquisition ceiling, the state has to win — otherwise a
     * correction the presenter did not ask for could be made FASTER by the
     * engine's own uncertainty.
     */
    const ambiguous = limitsForState('ambiguous', DEFAULT_PROFILE, base);
    const reacquiring = limitsForState('ambiguous', DEFAULT_PROFILE, { ...base, reacquire: true });
    expect(reacquiring.vForwardMax).toBeLessThanOrEqual(ambiguous.vForwardMax);
  });

  it('licenses exactly the backward travel it was handed', () => {
    const budgetPx = 900;
    const limits = limitsForState('following', DEFAULT_PROFILE, {
      ...base,
      reacquire: true,
      reacquireReverseBudgetPx: budgetPx,
    });
    expect(limits.allowBackward).toBe(true);
    // §30.5's standing budget is a bound on tracker jitter reversing the
    // document, and this is not that — but it is still bounded.
    expect(limits.reverseTravelMaxPx).toBe(budgetPx);
  });

  it('never lowers the standing reverse budget', () => {
    // The licence is a floor, not a replacement. A re-grab whose gap is smaller
    // than §30.5's standing allowance must not shrink what ordinary backward
    // motion is entitled to on the frames either side of it.
    const standing = limitsForState('following', DEFAULT_PROFILE, base).reverseTravelMaxPx;
    const limits = limitsForState('following', DEFAULT_PROFILE, {
      ...base,
      reacquire: true,
      reacquireReverseBudgetPx: 10,
    });
    expect(limits.reverseTravelMaxPx).toBe(standing);
  });

  it('stands down for reduced motion, which asked for no animation at all', () => {
    const limits = limitsForState('following', DEFAULT_PROFILE, {
      ...base,
      reacquire: true,
      reducedMotion: true,
    });
    expect(limits.snap).toBe(true);
    expect(limits.vForwardMax).toBe(
      limitsForState('following', DEFAULT_PROFILE, { ...base, reducedMotion: true }).vForwardMax,
    );
  });

  it('is suppressed entirely while manual authority still holds', () => {
    const limits = limitsForState('following', DEFAULT_PROFILE, {
      ...base,
      manualGrace: true,
      reacquire: true,
    });
    expect(limits.vForwardMax).toBe(0);
    expect(limits.vBackwardMax).toBe(0);
  });
});
