import { afterEach, describe, expect, it } from 'vitest';
import { compile } from '../../../src/shared/markdown';
import type {
  TrackingWorkerInbound,
  TrackingWorkerOutbound,
} from '../../../src/shared/tracking/worker-protocol';
import {
  createTrackingDriver,
  createWorkerTrackingDriver,
  setTrackingWorkerFactoryForTesting,
  type TrackingWorkerLike,
} from '../../../src/control/services/session';
import type { TrackingSnapshot } from '../../../src/shared/contracts';

const SOURCE = `# One

First paragraph sentence here. Another sentence in the same block.

Second paragraph sentence follows afterwards.
`;

class FakeWorker implements TrackingWorkerLike {
  posted: TrackingWorkerInbound[] = [];
  terminated = false;
  private listeners: Array<(event: MessageEvent) => void> = [];

  postMessage(message: unknown): void {
    this.posted.push(message as TrackingWorkerInbound);
  }
  addEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    this.listeners.push(listener);
  }
  terminate(): void {
    this.terminated = true;
  }
  emit(message: TrackingWorkerOutbound): void {
    for (const listener of this.listeners) {
      listener({ data: message } as MessageEvent);
    }
  }
}

afterEach(() => {
  setTrackingWorkerFactoryForTesting(null);
});

function makeDriver() {
  const compiled = compile(SOURCE, { scriptId: 'script-1' });
  const worker = new FakeWorker();
  setTrackingWorkerFactoryForTesting(() => worker);
  const snapshots: TrackingSnapshot[] = [];
  const driver = createWorkerTrackingDriver({
    sessionId: 'session-1',
    scriptId: 'script-1',
    sentences: compiled.sentences,
    totalTokens: compiled.spokenTokens.length,
    compiled,
    sessionGeneration: 1,
    stageGeneration: 3,
    onSnapshot: (s) => snapshots.push(s),
    onTranscript: () => {},
  });
  return { compiled, worker, driver, snapshots };
}

function snapshotFor(compiled: ReturnType<typeof compile>, tokenIndex: number): TrackingSnapshot {
  const sentence = compiled.sentences.find(
    (s) => s.startTokenIndex <= tokenIndex && tokenIndex <= s.endTokenIndex,
  )!;
  return {
    schemaVersion: 1,
    revision: 1,
    sessionId: 'session-1',
    sessionGeneration: 1,
    stageGeneration: 3,
    scriptId: 'script-1',
    tokenIndex,
    committedTokenIndex: tokenIndex,
    blockId: sentence.blockId,
    sentenceId: sentence.id,
    confidence: 0.9,
    state: 'following',
    provisional: false,
    movement: 'advance',
    sourceItemIds: [],
    generatedAtMs: Date.now(),
  };
}

describe('worker tracking driver (spec §45.4 binding)', () => {
  it('initializes the worker with the tracking document and holds until start', () => {
    const { compiled, worker } = makeDriver();
    expect(worker.posted[0]?.type).toBe('initialize');
    const init = worker.posted[0] as Extract<TrackingWorkerInbound, { type: 'initialize' }>;
    expect(init.document.scriptId).toBe('script-1');
    expect(init.document.spokenTokens.length).toBe(compiled.spokenTokens.length);
    expect(init.document.sentences.length).toBe(compiled.sentences.length);
    expect(init.session).toEqual({
      sessionId: 'session-1',
      sessionGeneration: 1,
      stageGeneration: 3,
    });
    // §9.1: the engine holds position until the user starts prompting.
    expect(worker.posted[1]?.type).toBe('pause');
  });

  it('relays snapshots and forwards transcript events', () => {
    const { compiled, worker, driver, snapshots } = makeDriver();
    driver.start();
    expect(worker.posted.at(-1)?.type).toBe('resume');

    worker.emit({ type: 'snapshot', snapshot: snapshotFor(compiled, 2) });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.tokenIndex).toBe(2);

    driver.feedTranscript({
      type: 'completed',
      sessionGeneration: 1,
      itemId: 'item-1',
      text: 'first paragraph sentence here',
      receivedAtMs: Date.now(),
    });
    const fed = worker.posted.at(-1) as Extract<TrackingWorkerInbound, { type: 'transcript_event' }>;
    expect(fed.type).toBe('transcript_event');
    expect(fed.event.type).toBe('completed');

    driver.maskItems(['item-1']);
    expect(worker.posted.at(-1)).toEqual({ type: 'mask_items', itemIds: ['item-1'] });

    driver.setCommandPending(true);
    expect(worker.posted.at(-1)?.type).toBe('set_command_pending');
  });

  it('maps sentence and paragraph moves onto move_to_token', () => {
    const { compiled, worker, driver } = makeDriver();
    driver.start();
    // Position on the second sentence of block one.
    const second = compiled.sentences[1]!;
    worker.emit({ type: 'snapshot', snapshot: snapshotFor(compiled, second.startTokenIndex) });

    driver.moveSentences(1);
    let move = worker.posted.at(-1) as Extract<TrackingWorkerInbound, { type: 'move_to_token' }>;
    expect(move.type).toBe('move_to_token');
    expect(move.movement).toBe('manual');
    expect(move.tokenIndex).toBe(compiled.sentences[2]!.startTokenIndex);

    // Restart paragraph goes to the first sentence of the current block.
    driver.restartParagraph();
    move = worker.posted.at(-1) as Extract<TrackingWorkerInbound, { type: 'move_to_token' }>;
    const blockFirst = compiled.sentences.find((s) => s.blockId === second.blockId)!;
    expect(move.tokenIndex).toBe(blockFirst.startTokenIndex);

    driver.dispose();
    expect(worker.terminated).toBe(true);
  });

  it('createTrackingDriver picks the worker driver when a factory exists', () => {
    const { driver } = makeDriver();
    driver.dispose();
    const worker = new FakeWorker();
    setTrackingWorkerFactoryForTesting(() => worker);
    const compiled = compile(SOURCE, { scriptId: 'script-2' });
    const chosen = createTrackingDriver({
      sessionId: 's',
      scriptId: 'script-2',
      sentences: compiled.sentences,
      totalTokens: 10,
      compiled,
      onSnapshot: () => {},
      onTranscript: () => {},
    });
    expect(worker.posted[0]?.type).toBe('initialize');
    chosen.dispose();
  });
});
