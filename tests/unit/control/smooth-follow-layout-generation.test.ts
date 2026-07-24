/**
 * Control closes the layout-generation loop (companion §7.2, §26.1, §54).
 *
 * Control is the only party that hears both sides of this loop: the stage
 * reports its own layout generation in every `StageMotionAck`, and the two
 * semantic-frame producers — the tracking worker, and the v1 snapshot bridge —
 * stamp their frames with whatever control tells them. Neither was ever told.
 * The worker's generation stayed frozen at its initial 0 for the whole session,
 * and the bridge stamped `stageGeneration`, which counts stage *windows*, not
 * line-map rebuilds.
 *
 * These tests assert the closed loop from the ack inwards: the ack subscription
 * feeds `set_layout_generation` to the worker, and the bridge stamps the value
 * the stage actually published rather than a counter that merely looks like it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compile } from '../../../src/shared/markdown';
import { STAGE_EVENT, type SemanticMotionFrame, type StageMotionAck } from '../../../src/shared/contracts';
import type {
  TrackingWorkerInbound,
  TrackingWorkerOutbound,
} from '../../../src/shared/tracking/worker-protocol';
import type { TrackingSnapshot } from '../../../src/shared/contracts';

const adapter = vi.hoisted(() => {
  let handler: ((ack: StageMotionAck) => void) | null = null;
  return {
    subscribeStageMotionAcks: (fn: (ack: StageMotionAck) => void) => {
      handler = fn;
      return () => {
        handler = null;
      };
    },
    deliver(ack: StageMotionAck): void {
      if (!handler) throw new Error('no ack subscriber — the stage bridge never started');
      handler(ack);
    },
    subscribed: (): boolean => handler !== null,
  };
});

vi.mock('@tauri-apps/api/event', () => ({
  emitTo: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));
vi.mock('../../../src/control/services/stage', () => ({
  publishStageSnapshot: vi.fn(async () => {}),
  publishStageDirective: vi.fn(async () => {}),
  publishListenerState: vi.fn(async () => {}),
  closeStage: vi.fn(async () => {}),
}));
vi.mock('../../../src/control/services/ipc', async (orig) => {
  const actual = await orig<typeof import('../../../src/control/services/ipc')>();
  return { ...actual, isTauriRuntime: () => true };
});
vi.mock('../../../src/control/services/smooth-follow-adapter', async (orig) => {
  const actual = await orig<typeof import('../../../src/control/services/smooth-follow-adapter')>();
  return { ...actual, subscribeStageMotionAcks: adapter.subscribeStageMotionAcks };
});

const {
  adoptStageLayoutGeneration,
  clearSession,
  currentStageLayoutGeneration,
  setStageEmitterForTesting,
  startLiveSession,
  stopSession,
} = await import('../../../src/control/stores/session');
const { setTrackingWorkerFactoryForTesting } = await import(
  '../../../src/control/services/session'
);

const SOURCE = `# One

First paragraph sentence here. Another sentence in the same block.

Second paragraph sentence follows afterwards.
`;

class FakeWorker {
  posted: TrackingWorkerInbound[] = [];
  private listeners: Array<(event: MessageEvent) => void> = [];
  postMessage(message: unknown): void {
    this.posted.push(message as TrackingWorkerInbound);
  }
  addEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    this.listeners.push(listener);
  }
  terminate(): void {}
  emit(message: TrackingWorkerOutbound): void {
    for (const listener of this.listeners) listener({ data: message } as MessageEvent);
  }
  layoutGenerations(): number[] {
    return this.posted
      .filter((m): m is Extract<TrackingWorkerInbound, { type: 'set_layout_generation' }> =>
        m.type === 'set_layout_generation',
      )
      .map((m) => m.generation);
  }
}

let worker: FakeWorker;
let frames: SemanticMotionFrame[];

function ack(layoutGeneration: number): StageMotionAck {
  return {
    sessionId: 'session-1',
    revision: -1,
    epoch: -1,
    layoutGeneration,
    actualScrollPx: 100,
    actualVelocityPxPerSecond: 0,
    targetScrollPx: 100,
    activeLineId: null,
    controllerState: 'semantic:following',
    droppedFrameCountWindow: 0,
    renderedAtMs: 0,
  };
}

function snapshot(tokenIndex: number, revision: number): TrackingSnapshot {
  return {
    schemaVersion: 1,
    revision,
    sessionId: 'session-1',
    sessionGeneration: 1,
    stageGeneration: 7,
    scriptId: 'script-1',
    tokenIndex,
    committedTokenIndex: Math.max(0, tokenIndex - 1),
    blockId: 'block-0',
    sentenceId: 'sentence-0',
    confidence: 0.9,
    state: 'following',
    provisional: false,
    movement: 'advance',
    sourceItemIds: [],
    generatedAtMs: Date.now(),
  };
}

function start(): void {
  const compiled = compile(SOURCE, { scriptId: 'script-1' });
  startLiveSession({
    sessionId: 'session-1',
    scriptId: 'script-1',
    scriptTitle: 'Launch video',
    mode: 'manual',
    displayLabel: 'Stage',
    outline: [],
    sentences: compiled.sentences,
    totalTokens: compiled.spokenTokens.length,
    compiled,
    sessionGeneration: 1,
    // Deliberately NOT 0 and NOT 1: the bridge used to stamp this counter, so a
    // value that could be mistaken for a layout generation would hide the bug.
    stageGeneration: 7,
  });
}

beforeEach(() => {
  worker = new FakeWorker();
  frames = [];
  setTrackingWorkerFactoryForTesting(() => worker);
  setStageEmitterForTesting(async (_target, event, payload) => {
    if (event === STAGE_EVENT.semanticFrame) frames.push(payload as SemanticMotionFrame);
  });
});

afterEach(() => {
  clearSession();
  setTrackingWorkerFactoryForTesting(null);
  setStageEmitterForTesting(null);
});

describe('worker path: the generation reaches the worker', () => {
  it('forwards each new ack generation as set_layout_generation', () => {
    start();
    expect(adapter.subscribed()).toBe(true);
    expect(worker.layoutGenerations()).toEqual([]);

    adapter.deliver(ack(1));
    expect(worker.layoutGenerations()).toEqual([1]);
    expect(currentStageLayoutGeneration()).toBe(1);

    // A mid-take font-size change bumps the stage's counter.
    adapter.deliver(ack(2));
    expect(worker.layoutGenerations()).toEqual([1, 2]);
  });

  it('does not re-post an unchanged generation at the 500 ms ack cadence', () => {
    start();
    adapter.deliver(ack(3));
    for (let i = 0; i < 20; i += 1) adapter.deliver(ack(3));
    expect(worker.layoutGenerations()).toEqual([3]);
  });

  it('adopts a generation that moved BACKWARD — a reopened stage window', () => {
    // The stage's counter is per-window and restarts at 1 on a remount, while
    // control's belief kept climbing. Refusing to follow it down is what left
    // every later frame permanently ahead of the stage's gate.
    start();
    adopt([1, 2, 3]);
    adapter.deliver(ack(1));
    expect(worker.layoutGenerations()).toEqual([1, 2, 3, 1]);
    expect(currentStageLayoutGeneration()).toBe(1);
  });

  it('ignores a malformed generation rather than poisoning the producers', () => {
    start();
    adapter.deliver(ack(2));
    adapter.deliver(ack(Number.NaN));
    adapter.deliver(ack(1.5));
    adapter.deliver(ack(-1));
    expect(worker.layoutGenerations()).toEqual([2]);
    expect(currentStageLayoutGeneration()).toBe(2);
  });

  it('starts the next session knowing nothing about the new stage window', () => {
    start();
    adapter.deliver(ack(5));
    expect(currentStageLayoutGeneration()).toBe(5);
    stopSession();
    clearSession();
    start();
    expect(currentStageLayoutGeneration()).toBe(0);
  });
});

describe('bridge path: the generation reaches the published frame', () => {
  it('stamps frames with the stage’s layout generation, not stageGeneration', () => {
    start();
    adapter.deliver(ack(4));

    worker.emit({ type: 'snapshot', snapshot: snapshot(3, 1) });
    expect(frames).toHaveLength(1);
    expect(frames[0]?.layoutGeneration).toBe(4);
    // The bug was stamping this instead; it is a different counter entirely.
    expect(frames[0]?.layoutGeneration).not.toBe(7);

    adapter.deliver(ack(5));
    worker.emit({ type: 'snapshot', snapshot: snapshot(6, 2) });
    expect(frames.at(-1)?.layoutGeneration).toBe(5);
  });

  it('stands down once the worker emits real v2 frames', () => {
    start();
    adapter.deliver(ack(4));
    worker.emit({
      type: 'semantic_frame',
      frame: {
        sessionId: 'session-1',
        sessionGeneration: 1,
        scriptCompileHash: '',
        layoutGeneration: 4,
        revision: 1,
        epoch: 1,
        sessionTimeMs: 0,
        estimatedUnit: 0,
        committedUnit: 0,
        velocityUnitsPerSecond: 0,
        accelerationUnitsPerSecond2: 0,
        positionVariance: 0,
        confidence: 0.9,
        sectionId: 'block-0',
        tokenIndex: 0,
        sentenceId: 'sentence-0',
        blockId: 'block-0',
        state: 'following',
        behavior: 'normal',
        finalEvidence: true,
        motionProfileId: 'default-v1',
      },
    });
    const bridged = frames.length;
    worker.emit({ type: 'snapshot', snapshot: snapshot(3, 2) });
    // The bridge no longer duplicates what the worker is already producing.
    expect(frames.length).toBe(bridged);
  });
});

/** Deliver a run of ack generations. */
function adopt(generations: number[]): void {
  for (const g of generations) adapter.deliver(ack(g));
}

describe('the exported adopter is the same path the ack subscription uses', () => {
  it('is a no-op with no driver attached', () => {
    expect(() => adoptStageLayoutGeneration(9)).not.toThrow();
  });
});
