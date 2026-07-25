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
import { SessionClock } from '../shared/tracking/session-clock';
import type { TranscriptEvent } from '../shared/tracking/types';
import type {
  TrackingWorkerInbound,
  TrackingWorkerOutbound,
} from '../shared/tracking/worker-protocol';

let engine: AlignmentEngine | undefined;
let lastSnapshotSentAtMs = -Infinity;
let minSnapshotIntervalMs = 1000 / 30; // §31.16: at most 30 snapshots/second

/**
 * Companion §9.1. Every stamp arriving from the control window is on that
 * window's `Date.now()`; the engine's whole time domain — pace, prediction
 * horizon, evidence age, and the `sessionTimeMs` stamped on every semantic
 * frame — is whatever it is handed. This is the one place that can make the
 * domain session-relative and monotone, so it is the only place that reads a
 * raw producer stamp.
 */
const clock = new SessionClock();

/** Carry a transcript event into the session domain (§9.1). */
function toSessionTime(event: TranscriptEvent): TranscriptEvent {
  const receivedAtMs = clock.advance(event.receivedAtMs);
  if (event.type === 'item_started') {
    return { ...event, receivedAtMs, audioStartMs: clock.map(event.audioStartMs) };
  }
  if (event.type === 'completed' && event.audioEndMs !== undefined) {
    return { ...event, receivedAtMs, audioEndMs: clock.map(event.audioEndMs) };
  }
  return { ...event, receivedAtMs };
}

function post(message: TrackingWorkerOutbound): void {
  (self as unknown as { postMessage(m: TrackingWorkerOutbound): void }).postMessage(message);
}

function flush(output: EngineOutput, nowMs: number, force = false): void {
  if (output.stateChanged !== undefined) {
    post({ type: 'state_change', state: output.stateChanged });
  }
  // Companion §26.1: semantic frames are the stage's motion input and are
  // already rate-limited (and change-gated) by the engine's frame emitter, so
  // they are never subject to the v1 snapshot cadence cap.
  if (output.frame) {
    post({ type: 'semantic_frame', frame: output.frame });
  }
  if (output.decision) {
    post({ type: 'movement_decision', record: output.decision });
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
    // §9.1: session start is where `sessionTimeMs = 0` is defined.
    clock.start(message.nowMs);
    engine = new AlignmentEngine(
      message.document,
      message.session,
      message.profile,
      message.smoothProfile,
    );
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
    case 'transcript_event': {
      const event = toSessionTime(message.event);
      flush(engine.handleTranscriptEvent(event), event.receivedAtMs);
      break;
    }
    case 'manual_move': {
      const nowMs = clock.advance(message.nowMs);
      flush(engine.moveTo(message.target.tokenIndex, 'manual', nowMs), nowMs, true);
      break;
    }
    case 'command_move': {
      const nowMs = clock.advance(message.nowMs);
      flush(engine.moveTo(message.target.tokenIndex, 'command', nowMs), nowMs, true);
      break;
    }
    case 'move_to_token': {
      const nowMs = clock.advance(message.nowMs);
      flush(engine.moveTo(message.tokenIndex, message.movement, nowMs), nowMs, true);
      break;
    }
    case 'mask_items':
      engine.maskItems(message.itemIds);
      break;
    case 'release_items':
      engine.releaseItems(message.itemIds);
      break;
    case 'set_command_pending': {
      const nowMs = clock.advance(message.nowMs);
      flush(engine.setCommandPending(message.pending, nowMs), nowMs, true);
      break;
    }
    case 'pause': {
      const nowMs = clock.advance(message.nowMs);
      flush(engine.pause(nowMs), nowMs, true);
      break;
    }
    case 'resume': {
      const nowMs = clock.advance(message.nowMs);
      flush(engine.resume(nowMs), nowMs, true);
      break;
    }
    case 'reset': {
      // The epoch resets; the session clock does not. `sessionTimeMs` is
      // defined once per session (§9.1), and the stage orders frames across a
      // reset by it.
      const nowMs = clock.advance(message.nowMs);
      flush(engine.reset(nowMs), nowMs, true);
      break;
    }
    case 'tick': {
      // Between transcript events the continuous estimate keeps moving
      // (companion §3.1); a tick emits a frame only when one is due.
      const nowMs = clock.advance(message.nowMs);
      flush(engine.tick(nowMs), nowMs);
      break;
    }
    case 'set_layout_generation': {
      const nowMs = clock.advance(message.nowMs);
      flush(engine.setLayoutGeneration(message.generation, nowMs), nowMs, true);
      break;
    }
  }
};

export {};
