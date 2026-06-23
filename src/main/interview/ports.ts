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
  preloadSpeechPlan(plan: SpeechPlaybackPlan): Promise<void>;
  playSpeechPlan(plan: SpeechPlaybackPlan): Promise<void>;
  setVisualState(projection: StageStateProjection): void;
}

/** Sink for operator-console snapshots (IPC forwards to ControlWindow). */
export interface SnapshotSink {
  publish(snapshot: OperatorSessionSnapshot): void;
}

export type Clock = () => number;
