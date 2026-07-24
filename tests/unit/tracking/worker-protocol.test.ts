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

  it('emits semantic frames and movement decisions (companion §26.1, §65)', () => {
    outbox.length = 0;
    dispatch({
      type: 'initialize',
      document: demoDocument(),
      session: { sessionId: 's2', sessionGeneration: 2, stageGeneration: 1, layoutGeneration: 3 },
      smoothProfile: { alignment: { beamWidth: 6 } },
      nowMs: 0,
    });
    const scripter = new TranscriptScripter(10_000, 2);
    for (const event of scripter.speak({ text: 'Hello everyone and welcome to the channel.' })) {
      dispatch({ type: 'transcript_event', event });
    }
    const frames = outbox.filter((m) => m.type === 'semantic_frame');
    expect(frames.length).toBeGreaterThan(0);
    expect(outbox.some((m) => m.type === 'movement_decision')).toBe(true);

    let previous = 0;
    for (const message of frames) {
      if (message.type !== 'semantic_frame') continue;
      expect(message.frame.revision).toBeGreaterThan(previous);
      previous = message.frame.revision;
      expect(message.frame.layoutGeneration).toBe(3);
      expect(message.frame.sessionGeneration).toBe(2);
      expect(Number.isFinite(message.frame.estimatedUnit)).toBe(true);
    }
  });

  it('ticks advance the continuous estimate between transcript events (§3.1)', () => {
    outbox.length = 0;
    for (let t = 1; t <= 40; t++) dispatch({ type: 'tick', nowMs: 20_000 + t * 33 });
    expect(outbox.filter((m) => m.type === 'semantic_frame').length).toBeGreaterThan(0);
  });

  it('accepts bounded semantic assist without moving the cursor (§40)', () => {
    outbox.length = 0;
    dispatch({ type: 'move_to_token', tokenIndex: 30, movement: 'manual', nowMs: 30_000 });
    outbox.length = 0;
    dispatch({
      type: 'semantic_assist',
      evidence: {
        assistId: 'a1',
        // The engine's epoch advanced with the manual move, so this stale
        // payload must be discarded rather than scored.
        epoch: 0,
        requestRevision: 1,
        sourceItemIds: [],
        receivedAtMs: 30_100,
        opinions: [{ candidateId: 'continuity:120', relation: 'near_exact', confidence: 1 }],
      },
    });
    expect(outbox.filter((m) => m.type === 'error')).toEqual([]);
    dispatch({ type: 'tick', nowMs: 30_200 });
    const message = outbox.filter((m) => m.type === 'semantic_frame').at(-1);
    if (message?.type === 'semantic_frame') expect(message.frame.tokenIndex).toBeLessThan(120);
  });

  it('acknowledges a rebuilt line map (§7.2)', () => {
    outbox.length = 0;
    dispatch({ type: 'set_layout_generation', generation: 9, nowMs: 31_000 });
    const message = outbox.find((m) => m.type === 'semantic_frame');
    if (message?.type === 'semantic_frame') {
      expect(message.frame.layoutGeneration).toBe(9);
      expect(message.frame.transition?.reason).toBe('layout_recovery');
    } else {
      throw new Error('expected a frame after a layout generation change');
    }
  });

  it('reports malformed messages instead of crashing', () => {
    outbox.length = 0;
    dispatch(null as unknown as TrackingWorkerInbound);
    expect(outbox[0]).toMatchObject({ type: 'error', code: 'bad_message' });
  });
});
