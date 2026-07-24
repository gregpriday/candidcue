/// <reference lib="webworker" />
/**
 * Tracking worker (spec §42.1, §45.4) — hosts the deterministic local
 * alignment engine off the UI thread (non-negotiable decision 7: no LLM
 * decides the user's script position). Instantiate from the control window:
 *
 *   new Worker(new URL('../workers/tracking.worker.ts', import.meta.url), { type: 'module' })
 *
 * Protocol types live in src/shared/tracking/worker-protocol.ts.
 */
import { AlignmentEngine, type EngineOutput } from '../shared/tracking/engine';
import type {
  TrackingWorkerInbound,
  TrackingWorkerOutbound,
} from '../shared/tracking/worker-protocol';

let engine: AlignmentEngine | undefined;
let lastSnapshotSentAtMs = -Infinity;
let minSnapshotIntervalMs = 1000 / 30; // §31.16: at most 30 snapshots/second

function post(message: TrackingWorkerOutbound): void {
  (self as unknown as { postMessage(m: TrackingWorkerOutbound): void }).postMessage(message);
}

function flush(output: EngineOutput, nowMs: number, force = false): void {
  if (output.stateChanged !== undefined) {
    post({ type: 'state_change', state: output.stateChanged });
  }
  if (output.snapshot) {
    // Cap emission rate (§31.16); state changes and committed movement are
    // always forwarded so the stage never misses a transition.
    const important =
      force ||
      output.stateChanged !== undefined ||
      output.snapshot.movement !== 'advance' ||
      !output.snapshot.provisional;
    if (important || nowMs - lastSnapshotSentAtMs >= minSnapshotIntervalMs) {
      lastSnapshotSentAtMs = nowMs;
      post({ type: 'snapshot', snapshot: output.snapshot });
    }
  }
  if (output.diagnostic) {
    post({ type: 'diagnostic', diagnostic: output.diagnostic });
  }
}

self.onmessage = (event: MessageEvent<TrackingWorkerInbound>) => {
  const message = event.data;
  if (message === null || typeof message !== 'object' || typeof message.type !== 'string') {
    post({ type: 'error', code: 'bad_message', message: 'malformed worker message' });
    return;
  }

  if (message.type === 'initialize') {
    engine = new AlignmentEngine(message.document, message.session, message.profile);
    minSnapshotIntervalMs = 1000 / Math.max(1, engine.profile.maxSnapshotsPerSecond);
    lastSnapshotSentAtMs = -Infinity;
    post({ type: 'ready', sessionGeneration: message.session.sessionGeneration });
    return;
  }

  if (!engine) {
    post({ type: 'error', code: 'not_initialized', message: `dropped ${message.type}` });
    return;
  }

  switch (message.type) {
    case 'transcript_event':
      flush(engine.handleTranscriptEvent(message.event), message.event.receivedAtMs);
      break;
    case 'manual_move':
      flush(engine.moveTo(message.target.tokenIndex, 'manual', message.nowMs), message.nowMs, true);
      break;
    case 'command_move':
      flush(engine.moveTo(message.target.tokenIndex, 'command', message.nowMs), message.nowMs, true);
      break;
    case 'move_to_token':
      flush(engine.moveTo(message.tokenIndex, message.movement, message.nowMs), message.nowMs, true);
      break;
    case 'mask_items':
      engine.maskItems(message.itemIds);
      break;
    case 'release_items':
      engine.releaseItems(message.itemIds);
      break;
    case 'set_command_pending':
      flush(engine.setCommandPending(message.pending, message.nowMs), message.nowMs, true);
      break;
    case 'pause':
      flush(engine.pause(message.nowMs), message.nowMs, true);
      break;
    case 'resume':
      flush(engine.resume(message.nowMs), message.nowMs, true);
      break;
    case 'reset':
      flush(engine.reset(message.nowMs), message.nowMs, true);
      break;
  }
};

export {};
