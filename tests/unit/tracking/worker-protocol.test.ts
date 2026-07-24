/**
 * Tracking worker protocol test (spec §45.4): drives the real worker module
 * with a simulated `self` so the message contract is exercised end-to-end.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type {
  TrackingWorkerInbound,
  TrackingWorkerOutbound,
} from '../../../src/shared/tracking/worker-protocol';
import { demoDocument } from '../../fixtures/alignment/fixture-script';
import { TranscriptScripter } from '../../fixtures/transcript-events/builder';

const outbox: TrackingWorkerOutbound[] = [];
let dispatch: (message: TrackingWorkerInbound) => void;

beforeAll(async () => {
  const fakeSelf = {
    onmessage: undefined as ((event: MessageEvent<TrackingWorkerInbound>) => void) | undefined,
    postMessage: (message: TrackingWorkerOutbound) => {
      outbox.push(message);
    },
  };
  (globalThis as Record<string, unknown>).self = fakeSelf;
  await import('../../../src/workers/tracking.worker');
  if (fakeSelf.onmessage === undefined) throw new Error('worker did not register onmessage');
  const handler = fakeSelf.onmessage;
  dispatch = (message) => handler({ data: message } as MessageEvent<TrackingWorkerInbound>);
});

describe('tracking worker protocol (§45.4)', () => {
  it('rejects messages before initialization', () => {
    outbox.length = 0;
    dispatch({ type: 'pause', nowMs: 1 });
    expect(outbox[0]).toMatchObject({ type: 'error', code: 'not_initialized' });
  });

  it('initializes, consumes transcript events, and emits snapshots', () => {
    outbox.length = 0;
    dispatch({
      type: 'initialize',
      document: demoDocument(),
      session: { sessionId: 's1', sessionGeneration: 1, stageGeneration: 1 },
      nowMs: 0,
    });
    expect(outbox[0]).toMatchObject({ type: 'ready', sessionGeneration: 1 });

    const scripter = new TranscriptScripter(10_000, 1);
    for (const event of scripter.speak({ text: 'Hello everyone and welcome to the channel.' })) {
      dispatch({ type: 'transcript_event', event });
    }
    const snapshots = outbox.filter((m) => m.type === 'snapshot');
    expect(snapshots.length).toBeGreaterThan(0);
    const last = snapshots.at(-1);
    if (last?.type === 'snapshot') {
      expect(last.snapshot.state).toBe('following');
      expect(last.snapshot.tokenIndex).toBeGreaterThan(0);
      expect(last.snapshot.schemaVersion).toBe(1);
    }
    expect(outbox.some((m) => m.type === 'diagnostic')).toBe(true);
  });

  it('handles manual moves and reset with forced snapshots', () => {
    outbox.length = 0;
    dispatch({ type: 'move_to_token', tokenIndex: 40, movement: 'manual', nowMs: 20_000 });
    const manual = outbox.find((m) => m.type === 'snapshot');
    if (manual?.type === 'snapshot') {
      expect(manual.snapshot.movement).toBe('manual');
      expect(manual.snapshot.tokenIndex).toBe(40);
    } else {
      throw new Error('expected snapshot after manual move');
    }

    outbox.length = 0;
    dispatch({ type: 'reset', nowMs: 21_000 });
    const reset = outbox.find((m) => m.type === 'snapshot');
    if (reset?.type === 'snapshot') {
      expect(reset.snapshot.tokenIndex).toBe(0);
    } else {
      throw new Error('expected snapshot after reset');
    }
  });

  it('reports malformed messages instead of crashing', () => {
    outbox.length = 0;
    dispatch(null as unknown as TrackingWorkerInbound);
    expect(outbox[0]).toMatchObject({ type: 'error', code: 'bad_message' });
  });
});
