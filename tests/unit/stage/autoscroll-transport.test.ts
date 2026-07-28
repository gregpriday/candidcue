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
import { advanceAutoScrollTarget, autoScrollPxPerSecond } from '../../../src/stage/renderer/autoscroll';
import { fixtureFingerprint, syntheticLayout } from '../../fixtures/layout';
import { snapshot } from '../../helpers/alignment';

const FRAME_MS = 1000 / 60;

function engineWithMap(): { engine: StageMotionEngine; maxScrollPx: number; linesPx: number } {
  const layout = syntheticLayout({
    blocks: [
      { kind: 'paragraph', tokens: 120 },
      { kind: 'paragraph', tokens: 120 },
    ],
    columnWidthPx: 800,
    startY: 800,
  });
  const map = buildRenderedLineMap({
    fingerprint: fixtureFingerprint(),
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
  return { engine, maxScrollPx: layout.contentHeightPx, linesPx: layout.lineHeightPx };
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
  options: { pxPerSecond: number; durationMs: number; maxScrollPx: number; startPx?: number },
) {
  let targetPx = options.startPx ?? 0;
  const trace: ReturnType<StageMotionEngine['frame']>[] = [];
  for (let t = 0; t <= options.durationMs; t += FRAME_MS) {
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
