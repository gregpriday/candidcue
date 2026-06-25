import type {
  SpeechPlaybackPlan,
  StageStateProjection,
  OperatorSessionSnapshot,
} from '@shared/contracts';

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
  setVisualState(projection: StageStateProjection): void;
}

/** Sink for operator-console snapshots (IPC forwards to ControlWindow). */
export interface SnapshotSink {
  publish(snapshot: OperatorSessionSnapshot): void;
}

export type Clock = () => number;
