/**
 * The layout-generation loop (companion §7.2, §26.1, §54).
 *
 * The stage owns a LOCAL layout generation; it bumps on every real layout
 * change and gates every incoming `SemanticMotionFrame` on it. The producers
 * (the tracking worker, and the v1 snapshot bridge) stamp their frames with
 * whatever generation control last told them, and control only ever learns it
 * from a `StageMotionAck`. That is a loop, and it has to be closed at every
 * link or the gate degenerates:
 *
 *  - a producer stuck BEHIND the gate is rejected for the grace window after
 *    every rebuild and merely *tolerated* forever after, so the gate spends the
 *    whole session running on its own escape hatch;
 *  - a producer that gets AHEAD of the gate (a stage window reopened
 *    mid-session restarts the counter while control's kept climbing) used to be
 *    rejected with neither grace nor tolerance, permanently, which silently
 *    killed the whole v2 motion path for the rest of the take.
 *
 * These tests assert the closed loop: the stage reports its generation on the
 * ordinary ack cadence even before it has accepted a single frame (the ack was
 * the only way out of that deadlock and it used to be gated on one), a
 * re-synchronised producer is accepted cleanly with no tolerance at all, and a
 * disagreement that survives the grace window degrades to tolerated rather than
 * fatal.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SMOOTH_FOLLOW_PROFILE as PROFILE,
  type SemanticMotionFrame,
} from '../../../src/shared/contracts';
import {
  buildRenderedLineMap,
  createSemanticFrameReceiver,
  createStageMotionEngine,
  identityUnitAxis,
} from '../../../src/stage/motion';
import { fixtureFingerprint, syntheticLayout } from '../../fixtures/layout';

function frame(overrides: Partial<SemanticMotionFrame> = {}): SemanticMotionFrame {
  return {
    sessionId: 's',
    sessionGeneration: 1,
    scriptCompileHash: 'h',
    layoutGeneration: 0,
    revision: 1,
    epoch: 1,
    sessionTimeMs: 0,
    estimatedUnit: 0,
    committedUnit: 0,
    velocityUnitsPerSecond: 3,
    accelerationUnitsPerSecond2: 0,
    positionVariance: 0,
    confidence: 0.9,
    sectionId: 'sec',
    tokenIndex: 0,
    sentenceId: 'sent',
    blockId: 'b',
    state: 'following',
    behavior: 'normal',
    finalEvidence: true,
    motionProfileId: 'p',
    ...overrides,
  };
}

function newReceiver() {
  return createSemanticFrameReceiver({
    gate: { sessionId: 's', sessionGeneration: 1, scriptCompileHash: 'h', layoutGeneration: 0 },
  });
}

describe('the stage reports its layout generation before it accepts anything', () => {
  /**
   * The deadlock this closes: the gate bumps to a generation control has never
   * heard of, so every frame is rejected — and while the ack was gated on an
   * accepted frame, nothing ever went out to tell control which generation to
   * use. The session then depended entirely on the stale-layout tolerance
   * opening at 900 ms.
   */
  it('acks on the ordinary cadence with no frame ever accepted', () => {
    const layout = syntheticLayout({ blocks: [{ kind: 'paragraph', tokens: 60 }], startY: 600 });
    const map = buildRenderedLineMap({
      fingerprint: fixtureFingerprint({ layoutGeneration: 4 }),
      tokens: layout.tokens,
      blocks: layout.blocks,
      readingLineStartY: 400,
      lineHeightPx: layout.lineHeightPx,
      viewportHeightPx: 1080,
      maxScrollPx: layout.contentHeightPx,
    });
    const engine = createStageMotionEngine({ unitAxis: identityUnitAxis() });
    engine.configureSession(
      { sessionId: 's', sessionGeneration: 1, scriptCompileHash: 'h', layoutGeneration: 4 },
      0,
    );
    engine.setLineMap(map);
    engine.setBounds(0, layout.contentHeightPx);

    // Frames stamped with a generation the stage does not have: all rejected.
    let acks = 0;
    let firstAckAtMs: number | null = null;
    let firstAcceptedAtMs: number | null = null;
    for (let t = 0; t <= 2000; t += 16) {
      const took = engine.receiveFrame(
        frame({ revision: t + 1, sessionTimeMs: t, layoutGeneration: 0 }),
        t,
      );
      if (took) firstAcceptedAtMs ??= t;
      const result = engine.frame(t);
      if (result.ack) {
        acks++;
        firstAckAtMs ??= t;
        // Whatever else the ack says, it says which layout the stage is in.
        expect(result.ack.layoutGeneration).toBe(4);
        expect(result.ack.sessionId).toBe('s');
      }
    }
    expect(acks).toBeGreaterThan(0);
    expect(firstAckAtMs).not.toBeNull();
    // Nothing was accepted until the stale-layout escape hatch opened at
    // 900 ms — so an ack that waits for an accepted frame is an ack that never
    // arrives in time to prevent the blackout it is supposed to explain.
    expect(firstAcceptedAtMs).not.toBeNull();
    expect(firstAcceptedAtMs ?? 0).toBeGreaterThan(firstAckAtMs ?? 0);
    // The 500 ms ack cadence lands well inside the 900 ms grace window, so the
    // producer can re-sync before tolerance is ever needed.
    expect(firstAckAtMs ?? Infinity).toBeLessThan(PROFILE.prediction.normalHorizonMs);
  });

  it('reports -1 counters rather than borrowing a stale frame’s revision', () => {
    const engine = createStageMotionEngine({ unitAxis: identityUnitAxis() });
    engine.configureSession(
      { sessionId: 's', sessionGeneration: 1, scriptCompileHash: 'h', layoutGeneration: 2 },
      0,
    );
    const ack = engine.frame(0).ack;
    expect(ack).not.toBeNull();
    expect(ack?.revision).toBe(-1);
    expect(ack?.epoch).toBe(-1);
    expect(ack?.layoutGeneration).toBe(2);
  });

  it('stays silent when there is no session identity to report against', () => {
    const engine = createStageMotionEngine({ unitAxis: identityUnitAxis() });
    expect(engine.frame(0).ack).toBeNull();
    expect(engine.frame(600).ack).toBeNull();
  });
});

describe('a producer that adopts the stage generation is accepted cleanly', () => {
  /**
   * The whole point of closing the loop: once the producer is re-stamped, the
   * gate stops softening anything. A test that only asserted "frames are
   * accepted" would still pass on the broken system via tolerance, so this
   * asserts the *absence* of tolerance too.
   */
  it('accepts with no tolerance and no rejections once re-synced', () => {
    const receiver = newReceiver();
    receiver.setGate({ layoutGeneration: 1 }, 0);

    // The ack lands at 500 ms; the producer re-stamps from the next frame on.
    let revision = 0;
    let rejectedBeforeResync = 0;
    for (let t = 50; t <= 500; t += 50) {
      const out = receiver.accept(
        frame({ revision: ++revision, sessionTimeMs: t, layoutGeneration: 0 }),
        t,
      );
      if (!out.accepted) rejectedBeforeResync++;
    }
    for (let t = 550; t < 20_000; t += 50) {
      const out = receiver.accept(
        frame({ revision: ++revision, sessionTimeMs: t, layoutGeneration: 1 }),
        t,
      );
      expect(out.accepted).toBe(true);
      expect(out.tolerated).toBeUndefined();
    }

    // The pre-resync window is bounded by the ack cadence, not by the grace
    // window — 10 frames, not the 17 a full 900 ms blackout costs.
    expect(rejectedBeforeResync).toBe(10);
    expect(receiver.stats.toleratedStaleLayout).toBe(0);
    expect(receiver.stats.toleratedFutureLayout).toBe(0);
    expect(receiver.stats.byReason.layout_generation).toBe(rejectedBeforeResync);
  });

  it('re-syncs the same way after a mid-take layout change', () => {
    const receiver = newReceiver();
    receiver.setGate({ layoutGeneration: 1 }, 0);
    let revision = 0;
    for (let t = 0; t < 5000; t += 50) {
      receiver.accept(frame({ revision: ++revision, sessionTimeMs: t, layoutGeneration: 1 }), t);
    }
    // Presenter changes the font size at t = 5 s.
    receiver.setGate({ layoutGeneration: 2 }, 5000);
    let rejected = 0;
    for (let t = 5050; t <= 5500; t += 50) {
      const out = receiver.accept(
        frame({ revision: ++revision, sessionTimeMs: t, layoutGeneration: 1 }),
        t,
      );
      if (!out.accepted) rejected++;
    }
    for (let t = 5550; t < 8000; t += 50) {
      const out = receiver.accept(
        frame({ revision: ++revision, sessionTimeMs: t, layoutGeneration: 2 }),
        t,
      );
      expect(out.accepted).toBe(true);
      expect(out.tolerated).toBeUndefined();
    }
    expect(rejected).toBe(10);
    expect(receiver.stats.toleratedStaleLayout).toBe(0);
  });
});

describe('a producer stuck ahead of the gate degrades instead of dying', () => {
  /**
   * The reopened-stage-window case. The stage's counter restarted at 1 while
   * control's kept climbing, so every frame claimed a newer layout than the one
   * the stage was in — which the receiver rejected with no grace and no
   * tolerance for the rest of the session, silently taking the entire v2 motion
   * path down with it.
   */
  it('rejects for the grace window, then tolerates and counts it', () => {
    const receiver = newReceiver();
    receiver.setGate({ layoutGeneration: 1 }, 0);

    let rejected = 0;
    let accepted = 0;
    for (let t = 1000; t < 60_000; t += 50) {
      const out = receiver.accept(
        frame({ revision: t, sessionTimeMs: t, layoutGeneration: 3 }),
        t,
      );
      if (out.accepted) {
        accepted++;
        expect(out.tolerated).toBe('layout_generation');
      } else {
        rejected++;
        expect(out.reason).toBe('layout_generation');
      }
    }

    // 900 ms of grace at 20 Hz, then following resumes for the rest of the run.
    expect(rejected).toBe(18);
    expect(accepted).toBe(1162);
    // Counted apart from stale tolerance: a nonzero value here is the signature
    // of a broken ack loop, not of an ordinary relayout.
    expect(receiver.stats.toleratedFutureLayout).toBe(accepted);
    expect(receiver.stats.toleratedStaleLayout).toBe(0);
  });

  it('gives a fresh grace window each time the disagreement is new', () => {
    const receiver = newReceiver();
    receiver.setGate({ layoutGeneration: 1 }, 0);
    // Disagreement observed at t=0, survives the window, is tolerated.
    expect(receiver.accept(frame({ revision: 1, layoutGeneration: 5 }), 0).accepted).toBe(false);
    expect(receiver.accept(frame({ revision: 2, layoutGeneration: 5 }), 950).accepted).toBe(true);
    // The producer re-syncs; the gate stops softening.
    const synced = receiver.accept(frame({ revision: 3, layoutGeneration: 1 }), 1000);
    expect(synced.accepted).toBe(true);
    expect(synced.tolerated).toBeUndefined();
    // A NEW disagreement is a new claim and gets rejected again on sight.
    expect(receiver.accept(frame({ revision: 4, layoutGeneration: 9 }), 1050).accepted).toBe(false);
    expect(receiver.accept(frame({ revision: 5, layoutGeneration: 9 }), 1400).accepted).toBe(false);
    expect(receiver.accept(frame({ revision: 6, layoutGeneration: 9 }), 2000).accepted).toBe(true);
  });

  it('restarts the window when our OWN generation moves', () => {
    const receiver = newReceiver();
    receiver.setGate({ layoutGeneration: 1 }, 0);
    expect(receiver.accept(frame({ revision: 1, layoutGeneration: 4 }), 0).accepted).toBe(false);
    // A local rebuild at t = 500 ms — still not generation 4, but the
    // disagreement is a different one now, so the window starts over.
    receiver.setGate({ layoutGeneration: 2 }, 500);
    expect(receiver.accept(frame({ revision: 2, layoutGeneration: 4 }), 600).accepted).toBe(false);
    expect(receiver.accept(frame({ revision: 3, layoutGeneration: 4 }), 1000).accepted).toBe(false);
    expect(receiver.accept(frame({ revision: 4, layoutGeneration: 4 }), 1600).accepted).toBe(true);
  });
});
