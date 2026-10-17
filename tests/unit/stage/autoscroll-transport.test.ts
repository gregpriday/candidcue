/**
 * The fixed-pace transport, driven through the real motion engine.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS TEST EXISTS AT THIS LEVEL
 * ---------------------------------------------------------------------------
 * `renderer/autoscroll.ts` is arithmetic and its unit tests prove the
 * arithmetic. What they cannot prove is the design claim the whole feature
 * rests on: that expressing auto-scroll as a fallback target creeping forward
 * at a constant rate produces smooth, bounded, monotone motion — because the
 * engine, not the transport, is what turns a goal into pixels.
 *
 * That claim is load-bearing. The alternative implementation — writing a
 * velocity into the plant — would have been simpler and would have bypassed
 * every velocity, acceleration and jerk limit on the way past, which on a
 * teleprompter is the difference between a script that rolls and a script that
 * lurches. So the thing under test here is the seam, driven exactly the way
 * `ScriptLayer.driveAutoScroll` drives it: advance the target, publish it, and
 * let the controller do the rest.
 *
 * jsdom cannot host this. The renderer's line map is built from measured DOM
 * rects, which are all zero there, so §62 correctly refuses to move at all —
 * which is why this runs in node against a synthetic layout instead.
 */
import { describe, expect, it } from 'vitest';
import { buildRenderedLineMap, createStageMotionEngine } from '../../../src/stage/motion';
import type { StageMotionEngine } from '../../../src/stage/motion';
import {
  advanceAutoScrollTarget,
  autoScrollPxPerSecond,
  measureAutoScrollScale,
} from '../../../src/stage/renderer/autoscroll';
import { fixtureFingerprint, syntheticLayout } from '../../fixtures/layout';
import type { SyntheticBlockSpec } from '../../fixtures/layout';
import { snapshot } from '../../helpers/alignment';

const FRAME_MS = 1000 / 60;
const READING_LINE_START_Y = 400;

function engineOnLayout(blocks: SyntheticBlockSpec[], startY = 800) {
  const layout = syntheticLayout({ blocks, columnWidthPx: 800, startY });
  const map = buildRenderedLineMap({
    fingerprint: fixtureFingerprint(),
    tokens: layout.tokens,
    blocks: layout.blocks,
    readingLineStartY: READING_LINE_START_Y,
    lineHeightPx: layout.lineHeightPx,
    viewportHeightPx: 1080,
    maxScrollPx: layout.contentHeightPx,
  });
  const engine = createStageMotionEngine();
  engine.configureSession(1, 0);
  engine.setLineMap(map);
  engine.setBounds(0, layout.contentHeightPx);
  return { engine, map, layout, maxScrollPx: layout.contentHeightPx };
}

function engineWithMap(): { engine: StageMotionEngine; maxScrollPx: number; linesPx: number } {
  const { engine, layout, maxScrollPx } = engineOnLayout([
    { kind: 'paragraph', tokens: 120 },
    { kind: 'paragraph', tokens: 120 },
  ]);
  return { engine, maxScrollPx, linesPx: layout.lineHeightPx };
}

/**
 * Run the transport for a while, exactly as the renderer does it.
 *
 * Returns the frame trace so the assertions can talk about the whole run rather
 * than its endpoint — "it ended up further down" is true of a lurch as well as
 * of a roll, and the difference between those two is the entire point.
 */
function roll(
  engine: StageMotionEngine,
  options: {
    pxPerSecond: number;
    durationMs: number;
    maxScrollPx: number;
    startPx?: number;
    /** Wall clock the run starts at, for a second leg after an interruption. */
    startMs?: number;
    /**
     * The renderer always stamps the transport's target as the operator's, so
     * that is the default here too — the point of this file is fidelity to
     * `driveAutoScroll`. Passed as `null` to model a target that is the
     * renderer's own guess instead.
     */
    mandate?: 'operator' | null;
  },
) {
  let targetPx = options.startPx ?? 0;
  const mandate = options.mandate === undefined ? 'operator' : options.mandate;
  const startMs = options.startMs ?? 0;
  const trace: ReturnType<StageMotionEngine['frame']>[] = [];
  for (let t = startMs; t <= startMs + options.durationMs; t += FRAME_MS) {
    targetPx = advanceAutoScrollTarget({
      targetPx,
      pxPerSecond: options.pxPerSecond,
      dtMs: FRAME_MS,
      maxScrollPx: options.maxScrollPx,
    });
    engine.setFallbackTarget({
      scrollPx: targetPx,
      disposition: 'follow',
      atMs: t,
      feedForwardVelocityPxS: options.pxPerSecond,
      ...(mandate === null ? {} : { mandate }),
    });
    trace.push(engine.frame(t));
  }
  return { trace, targetPx };
}

describe('the transport moves the document', () => {
  it('rolls the script forward at the pace it was given', () => {
    const { engine, maxScrollPx } = engineWithMap();
    // 8 px a word at 150 wpm — a plausible body size and a plausible delivery.
    const pxPerSecond = autoScrollPxPerSecond(150, { pxPerWord: 8, sampledWords: 200 });
    const { trace } = roll(engine, { pxPerSecond, durationMs: 6000, maxScrollPx });

    const travelled = trace[trace.length - 1]!.scrollPx;
    // Six seconds at 20 px/s is 120 px, and the loop runs the closing frame too.
    // The band is a couple of pixels either side: wide enough not to be a
    // restatement of the arithmetic, narrow enough that a plant which lagged or
    // raced would fail it.
    expect(travelled).toBeGreaterThan(115);
    expect(travelled).toBeLessThan(125);
  });

  it('settles at the requested velocity rather than chasing or overshooting', () => {
    const { engine, maxScrollPx } = engineWithMap();
    const pxPerSecond = autoScrollPxPerSecond(150, { pxPerWord: 8, sampledWords: 200 });
    const { trace } = roll(engine, { pxPerSecond, durationMs: 8000, maxScrollPx });

    // The last second, by which any starting ramp is long spent.
    const settled = trace.slice(-60);
    for (const frame of settled) {
      expect(frame.velocityPxS).toBeGreaterThan(pxPerSecond * 0.9);
      expect(frame.velocityPxS).toBeLessThan(pxPerSecond * 1.1);
    }
  });

  it('never goes backwards, and never jumps', () => {
    /*
     * Both halves matter to a reader. Reverse motion on a prompter is
     * disorienting in a way forward motion is not — the eye has already left
     * that line — and a jump is the spectacle the whole re-anchor machinery
     * exists to avoid. A constant-rate goal should produce neither.
     */
    const { engine, maxScrollPx } = engineWithMap();
    const pxPerSecond = autoScrollPxPerSecond(200, { pxPerWord: 9, sampledWords: 200 });
    const { trace } = roll(engine, { pxPerSecond, durationMs: 5000, maxScrollPx });

    for (let i = 1; i < trace.length; i++) {
      const step = trace[i]!.scrollPx - trace[i - 1]!.scrollPx;
      expect(step).toBeGreaterThanOrEqual(0);
      // One frame at 60 Hz carries about half a pixel at this pace. A whole
      // line in one frame would be a discontinuity by any definition.
      expect(step).toBeLessThan(20);
    }
  });

  it('comes to rest when the target is released, without a final lurch', () => {
    // Stopping is `setFallbackTarget(null)`: with nothing to aim at the engine
    // holds, and holding means aiming at where the plant already is.
    const { engine, maxScrollPx } = engineWithMap();
    const pxPerSecond = autoScrollPxPerSecond(150, { pxPerWord: 8, sampledWords: 200 });
    const { trace } = roll(engine, { pxPerSecond, durationMs: 4000, maxScrollPx });
    const releasedAt = trace[trace.length - 1]!.scrollPx;

    engine.setFallbackTarget(null);
    const after: number[] = [];
    for (let t = 4000; t <= 6000; t += FRAME_MS) after.push(engine.frame(t).scrollPx);

    const finalPx = after[after.length - 1]!;
    expect(finalPx).toBeGreaterThanOrEqual(releasedAt);
    // It coasts to a stop rather than stopping dead OR carrying on: a couple of
    // lines of deceleration is the jerk limit doing its job.
    expect(finalPx - releasedAt).toBeLessThan(40);
    const lastSecond = after.slice(-60);
    expect(lastSecond[lastSecond.length - 1]! - lastSecond[0]!).toBeLessThan(1);
  });

  it('stops at the end of the document instead of running past it', () => {
    const { engine, maxScrollPx } = engineWithMap();
    // Fast enough to reach the bottom well inside the run.
    const { trace, targetPx } = roll(engine, {
      pxPerSecond: 400,
      durationMs: 60_000,
      maxScrollPx,
    });

    expect(targetPx).toBe(maxScrollPx);
    for (const frame of trace) expect(frame.scrollPx).toBeLessThanOrEqual(maxScrollPx);
  });
});

describe('the transport takes authority when it starts', () => {
  it('rolls immediately instead of waiting out a fifteen-second alignment lock', () => {
    /*
     * THE BUG THIS PINS, AND WHY NO OTHER TEST HERE COULD SEE IT.
     *
     * An accepted snapshot outranks every fallback target for
     * `DEFAULT_SNAPSHOT_STALE_MS` — fifteen seconds — which is right for a
     * presenter drawing breath and wrong for one who has just pressed a key.
     * Without an explicit release, pressing A moments after speech left the
     * script held for up to fifteen seconds and then jumped the whole distance
     * the target had accrued meanwhile: a key that looks broken, then a lurch.
     *
     * Every other test in this file starts from a stage that has never received
     * a snapshot, so `receiver.current` is null and the fallback wins by
     * default. That is the one arrangement in which this bug is invisible.
     */
    const { engine, maxScrollPx } = engineWithMap();
    engine.receiveSnapshot(
      snapshot({
        observedToken: 12,
        confirmedToken: 11,
        observedAtom: 12,
        confirmedAtom: 11,
        evidenceAudioMs: 1000,
        atAudioMs: 1000,
      }),
      1000,
    );
    // The lock is live: the engine is following, and a fallback alone loses.
    expect(engine.frame(1000).source).toBe('alignment');

    engine.releaseAlignment();
    const { trace } = roll(engine, {
      pxPerSecond: 20,
      durationMs: 3000,
      maxScrollPx,
      startPx: engine.frame(1000).scrollPx,
    });

    // Fallback owns the very first frame, not the frame fifteen seconds later.
    expect(trace[0]?.source).toBe('fallback');
    expect(trace.every((f) => f.source === 'fallback')).toBe(true);
  });

  it('does not weaken the ordinary rule that alignment outranks a fallback', () => {
    // The protection this whole precedence exists for. A plain fallback target
    // — a manual scroll, a paused session, the pre-roll — must still lose to a
    // live alignment frame, or guessed geometry reaches the glass.
    const { engine, maxScrollPx } = engineWithMap();
    engine.receiveSnapshot(
      snapshot({
        observedToken: 12,
        confirmedToken: 11,
        observedAtom: 12,
        confirmedAtom: 11,
        evidenceAudioMs: 1000,
        atAudioMs: 1000,
      }),
      1000,
    );
    engine.setFallbackTarget({ scrollPx: maxScrollPx, disposition: 'follow', atMs: 1000 });
    expect(engine.frame(1016).source).toBe('alignment');
  });
});

describe('the target carries its own rate, and has to', () => {
  it('reports a true velocity, which is what keeps the paint off the pixel grid', () => {
    /*
     * THE BUG THIS PINS.
     *
     * A goal creeping a third of a pixel per frame satisfies every condition of
     * §29.3's rest deadband: the error is tiny, the plant is slow, and without a
     * feed-forward there is nothing to say otherwise. So the plant was snapped
     * to the goal and reported `v = 0` on every single frame — positionally
     * perfect, and a lie with two consequences. Nothing was being integrated, so
     * no limit was being applied; and `ScriptLayer.restingSnap` quantises the
     * painted offset to the device pixel grid whenever velocity reads as at
     * rest, which turns smooth travel into a 1 px step twenty times a second on
     * a panel with no spare resolution to hide it in.
     */
    const { engine, maxScrollPx } = engineWithMap();
    const pxPerSecond = 20;

    const withRate = roll(engine, { pxPerSecond, durationMs: 3000, maxScrollPx });
    expect(withRate.trace[withRate.trace.length - 1]!.velocityPxS).toBeGreaterThan(15);

    // The same motion with the rate withheld: still tracks, still reports rest.
    const bare = engineWithMap();
    let targetPx = 0;
    let last = 0;
    for (let t = 0; t <= 3000; t += FRAME_MS) {
      targetPx = advanceAutoScrollTarget({
        targetPx,
        pxPerSecond,
        dtMs: FRAME_MS,
        maxScrollPx: bare.maxScrollPx,
      });
      bare.engine.setFallbackTarget({ scrollPx: targetPx, disposition: 'follow', atMs: t });
      last = bare.engine.frame(t).velocityPxS;
    }
    expect(last).toBe(0);
  });
});

describe('the transport outranks the pause it takes', () => {
  /*
   * THE BUG THIS PINS, AND WHY EVERY OTHER TEST IN THIS FILE MISSED IT.
   *
   * Starting the transport PAUSES voice following — control's rule, and the
   * right one: two things moving the same document with different ideas about
   * where the presenter is would be worse than either alone. But the engine's
   * pause is `manualGrace`, and manual grace zeroes `vForwardMax` and
   * `feedForwardScale` outright, so the transport was suppressed by its own
   * precondition.
   *
   * It did not look broken, which is the interesting part. With the
   * feed-forward zeroed, §29.3's rest deadband snapped the plant onto a goal
   * that never got a whole pixel ahead of it, and at a conversational pace the
   * document rolled — on the deadband, not on the controller, with the velocity
   * reported as zero on every frame. Wind the pace up until the per-frame creep
   * clears the deadband and the roll stopped dead while the goal ran away down
   * the script.
   *
   * Every test above this line drives a stage that was never paused, which is
   * the one arrangement in which the whole failure is invisible.
   */
  it('rolls at the pace it was given while voice following is paused', () => {
    const { engine, maxScrollPx } = engineWithMap();
    engine.setPaused(true, 0);
    // Fast enough that the per-frame creep clears the rest deadband — the pace a
    // presenter reaches by winding the bracket keys to the top of the range.
    const pxPerSecond = 85;
    const { trace } = roll(engine, { pxPerSecond, durationMs: 6000, maxScrollPx });

    const travelled = trace[trace.length - 1]!.scrollPx;
    expect(travelled).toBeGreaterThan(pxPerSecond * 6 * 0.9);
    expect(travelled).toBeLessThan(pxPerSecond * 6 * 1.1);
    // And on the controller rather than on the deadband, which is what makes the
    // painted offset fractional instead of a 1 px step twenty times a second.
    const settled = trace.slice(-60);
    for (const frame of settled) {
      expect(frame.velocityPxS).toBeGreaterThan(pxPerSecond * 0.9);
      expect(frame.velocityPxS).toBeLessThan(pxPerSecond * 1.1);
    }
  });

  it('still holds a paused document against a target that is only a guess', () => {
    /*
     * The other half, and the reason the mandate rides on the target rather than
     * being a mode on the engine. §48 is a promise about automatic motion: with
     * following switched off, the renderer's own geometry-derived corrections
     * must not reach the glass. Exempting the transport must not exempt those.
     */
    const { engine, maxScrollPx } = engineWithMap();
    engine.setPaused(true, 0);
    const { trace } = roll(engine, {
      pxPerSecond: 85,
      durationMs: 4000,
      maxScrollPx,
      mandate: null,
    });

    expect(trace[trace.length - 1]!.scrollPx).toBeLessThan(2);
  });

  it('waits out a manual step and then carries on', () => {
    /*
     * The boundary the exemption stops at. A presenter who steps the script by
     * hand has said something more recent than the pace key, so the TIMED grace
     * still binds — but it is timed, and the roll has to come back afterwards.
     * The open-ended holds (`paused`, "moved it and has not spoken since") would
     * both outlast the take, which is why only the interval survives.
     */
    const { engine, maxScrollPx } = engineWithMap();
    engine.setPaused(true, 0);
    const pxPerSecond = 85;
    const opening = roll(engine, { pxPerSecond, durationMs: 2000, maxScrollPx });
    const steppedFrom = opening.trace[opening.trace.length - 1]!.scrollPx;

    // Exactly what an arrow key does: reposition, and take authority for the
    // grace interval (§30.6). It also arms `manualAwaitingEvidence`, and no
    // recogniser is running to clear it — a transport-only take never will.
    engine.manualOverride(steppedFrom + 120, 2000);

    const duringGrace = roll(engine, {
      pxPerSecond,
      durationMs: 1000,
      maxScrollPx,
      startPx: opening.targetPx,
      startMs: 2016,
    });
    const held = duringGrace.trace[duringGrace.trace.length - 1]!.scrollPx;
    // The step landed and nothing chased it back.
    expect(held).toBeGreaterThan(steppedFrom + 100);
    expect(held).toBeLessThan(steppedFrom + 140);

    const after = roll(engine, {
      pxPerSecond,
      durationMs: 3000,
      maxScrollPx,
      // Re-seeded from the document, which is what `driveAutoScroll` does on the
      // frame it finds the plant somewhere it did not put it.
      startPx: held,
      startMs: 5000,
    });
    const resumed = after.trace[after.trace.length - 1]!.scrollPx;
    expect(resumed).toBeGreaterThan(held + pxPerSecond * 3 * 0.8);
  });
});

describe('the transport respects what the engine is for', () => {
  it('does not move at all while the line map is unresolved (§62)', () => {
    /*
     * Auto-scroll is pure pixels and could in principle roll without a map —
     * and must not. §62 is a promise about the whole stage: it does not move on
     * geometry it has not measured, and a transport that quietly exempted
     * itself would be moving a document whose bounds it cannot trust.
     */
    const engine = createStageMotionEngine();
    engine.configureSession(1, 0);
    engine.setBounds(0, 10_000);
    const { trace } = roll(engine, { pxPerSecond: 30, durationMs: 3000, maxScrollPx: 10_000 });

    expect(trace.every((f) => f.source === 'hold')).toBe(true);
    expect(trace[trace.length - 1]!.scrollPx).toBe(0);
  });
});

describe('a script with an image in it', () => {
  /*
   * #278. The pace is measured off the line map, and a line map only has lines
   * where there are words — so an image's height sat inside one baseline step,
   * was charged to the words either side of it, and the text rolled faster than
   * the dial said. Measured here through the real map builder over a real block
   * layout, because that is where the block boxes the correction reads come
   * from in production.
   */
  const PROSE: SyntheticBlockSpec[] = [
    { kind: 'paragraph', tokens: 24 },
    { kind: 'paragraph', tokens: 120 },
  ];
  const WITH_IMAGE: SyntheticBlockSpec[] = [
    { kind: 'paragraph', tokens: 24 },
    { kind: 'image', heightPx: 600 },
    { kind: 'paragraph', tokens: 120 },
  ];

  /**
   * The density of the words alone: the same prose with nothing between it.
   *
   * An average over that prose — paragraph spacing, short closing lines and
   * all — which is what the dial's words a minute are an average of too. The
   * claim is that an image does not change it, not that every line of the
   * prose carries the same number of words.
   */
  const PROSE_PX_PER_WORD = (() => {
    const { map, layout } = engineOnLayout(PROSE);
    return measureAutoScrollScale(map.lines, layout.blocks)!.pxPerWord;
  })();

  /** Words a minute crossing the glass at `pxPerSecond`, over that prose. */
  function wordsPerMinuteOverText(pxPerSecond: number): number {
    return (pxPerSecond / PROSE_PX_PER_WORD) * 60;
  }

  it('measures the words, not the screenshot', () => {
    const { map, layout } = engineOnLayout(WITH_IMAGE);
    const corrected = measureAutoScrollScale(map.lines, layout.blocks);
    const uncorrected = measureAutoScrollScale(map.lines);

    // Within what the image's own paragraph margin costs the step either side.
    const pace = wordsPerMinuteOverText(autoScrollPxPerSecond(130, corrected));
    expect(pace).toBeGreaterThan(130 * 0.95);
    expect(pace).toBeLessThan(130 * 1.05);
    // The same map measured the old way, which is the bug.
    const old = wordsPerMinuteOverText(autoScrollPxPerSecond(130, uncorrected));
    expect(old).toBeGreaterThan(130 * 1.3);
  });

  it('crosses the image at the pace of the text, and reaches the next line still at it', () => {
    /*
     * The other half of the claim: the transport does not hurry across the
     * image and then arrive at the first line after it with speed to shed. The
     * whole crossing is one constant goal rate, so the plant should be settled
     * at that rate from the ramp-in to the last frame — on the prose before the
     * image, across it, and on the prose after it.
     */
    // Opened near the top so the image arrives within a reasonable run.
    const { engine, map, layout, maxScrollPx } = engineOnLayout(WITH_IMAGE, READING_LINE_START_Y);
    const pxPerSecond = autoScrollPxPerSecond(130, measureAutoScrollScale(map.lines, layout.blocks));
    const firstAfter = map.lines.find((line) => line.blockId === 'b2')!;
    const arrivePx = firstAfter.baselineY - READING_LINE_START_Y;
    // Long enough to put several lines of the second paragraph past the mark.
    const durationMs = (arrivePx / pxPerSecond) * 1000 + 8000;

    const { trace } = roll(engine, { pxPerSecond, durationMs, maxScrollPx });

    expect(trace[trace.length - 1]!.scrollPx).toBeGreaterThan(arrivePx + layout.lineHeightPx * 2);
    // Three seconds in, by which any starting ramp is long spent.
    const settled = trace.slice(Math.round(3000 / FRAME_MS));
    expect(settled.length).toBeGreaterThan(0);
    for (const frame of settled) {
      expect(frame.velocityPxS).toBeGreaterThan(pxPerSecond * 0.9);
      expect(frame.velocityPxS).toBeLessThan(pxPerSecond * 1.1);
    }
    for (let i = 1; i < trace.length; i++) {
      const step = trace[i]!.scrollPx - trace[i - 1]!.scrollPx;
      expect(step).toBeGreaterThanOrEqual(0);
      expect(step).toBeLessThan(20);
    }

    /*
     * And the words after the image go by at the prose's own pace. Measured off
     * the distance the document actually travelled, not the velocity the engine
     * reports — a plant that reported the right speed while integrating the
     * wrong one would pass the checks above.
     */
    const afterImage = settled.filter((frame) => frame.scrollPx > arrivePx);
    expect(afterImage.length).toBeGreaterThan(60);
    const travelledPx = afterImage[afterImage.length - 1]!.scrollPx - afterImage[0]!.scrollPx;
    const elapsedS = ((afterImage.length - 1) * FRAME_MS) / 1000;
    const pace = wordsPerMinuteOverText(travelledPx / elapsedS);
    expect(pace).toBeGreaterThan(130 * 0.95);
    expect(pace).toBeLessThan(130 * 1.05);
  });
});
