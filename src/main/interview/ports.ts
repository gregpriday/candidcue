import type {
  SpeechPlaybackPlan,
  SpeechAudioChunk,
  StageStateProjection,
  OperatorSessionSnapshot,
} from '@shared/contracts';
import type { PublicAppError } from '@shared/errors/app-error';

/** Minimal structured logger the orchestrator depends on (diagnostics logger is compatible). */
export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export const NOOP_LOGGER: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * The orchestrator drives the StageWindow through this port. The IPC layer
 * implements it by forwarding to the stage renderer; tests implement a fake.
 */
export interface StagePort {
  openMicGate(): void;
  closeMicGate(): void;
  /**
   * Fire-and-forget cue to play an immediate backchannel acknowledgment the
   * instant a turn commits (#53). Must not block the commit pipeline: it returns
   * synchronously and the stage plays a pre-decoded clip (or nothing, if the
   * character ships none).
   */
  playBackchannel(): void;
  /**
   * Preload + buffer the speech plan. Resolves true when the stage confirms it
   * is ready; false means readiness was NOT confirmed (stage error or timeout)
   * and playback must not be treated as having started.
   */
  preloadSpeechPlan(plan: SpeechPlaybackPlan): Promise<boolean>;
  /**
   * Play the speech plan. Resolves true when the stage confirms audio ended;
   * false means playback was NOT confirmed (stage error or timeout) and the
   * turn must not be treated as having been spoken.
   */
  playSpeechPlan(plan: SpeechPlaybackPlan): Promise<boolean>;
  /**
   * Push one streamed TTS audio chunk to the stage for a `streaming` plan (C4).
   * Fire-and-forget; the stage decodes + schedules it and reports ready/ended via
   * the same playback-report path as the buffered plan.
   */
  sendSpeechChunk(chunk: SpeechAudioChunk): void;
  setVisualState(projection: StageStateProjection): void;
}

/** Sink for operator-console snapshots (IPC forwards to ControlWindow). */
export interface SnapshotSink {
  publish(snapshot: OperatorSessionSnapshot): void;
}

/**
 * Sink for fatal / unrecoverable session errors. IPC forwards these to the
 * ControlWindow's global error banner (CHANNELS.evtError). Recoverable /
 * transient faults (STT disconnects, rate limits) do NOT flow here — they
 * surface via the snapshot's `recoverableWarning` and provider health instead.
 */
export interface ErrorSink {
  publish(error: PublicAppError): void;
}

export type Clock = () => number;
