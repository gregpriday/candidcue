/**
 * Realtime session lifecycle state machine (spec §29.1).
 *
 * Transitions are centralized here; components render state, they do not
 * infer it from booleans. Pure — no timers, no I/O.
 *
 * States (Appendix C.3 `RealtimeState`):
 *   idle → requesting_permission → opening_microphone → minting_credential
 *   → negotiating → ready → listening ↔ soft_paused → reconnecting
 *   → stopping → idle, with any transitional/active state able to enter
 *   recoverable_error or fatal_error.
 */
import type { RealtimeState } from '../../../shared/contracts';

export type RealtimeStateEvent =
  | 'start' // user starts tracking (spec §29.2 step 1)
  | 'permission_granted'
  | 'microphone_open'
  | 'credential_minted'
  | 'negotiated' // data channel open, config verified → ready
  | 'start_listening' // user presses Start (spec §29.2 step 11)
  | 'soft_pause'
  | 'resume'
  | 'suspend' // system sleep detected (spec §29.8); remain paused on wake
  | 'connection_lost' // enter reconnecting; position held (spec §29.6)
  | 'reconnected' // fresh connection up; stays paused for explicit resume
  | 'stop' // stop or hard pause: both tear the session down (spec §29.7)
  | 'stopped'
  | 'recoverable_error'
  | 'fatal_error'
  | 'retry' // from recoverable_error: fresh credential + reconnect
  | 'reset'; // acknowledge terminal error → idle

const ACTIVE_OR_TRANSITIONAL: RealtimeState[] = [
  'requesting_permission',
  'opening_microphone',
  'minting_credential',
  'negotiating',
  'ready',
  'listening',
  'soft_paused',
  'reconnecting',
  'stopping',
];

type TransitionTable = Partial<Record<RealtimeState, Partial<Record<RealtimeStateEvent, RealtimeState>>>>;

const TABLE: TransitionTable = {
  idle: {
    start: 'requesting_permission',
  },
  requesting_permission: {
    permission_granted: 'opening_microphone',
    stop: 'stopping',
  },
  opening_microphone: {
    microphone_open: 'minting_credential',
    stop: 'stopping',
  },
  minting_credential: {
    credential_minted: 'negotiating',
    stop: 'stopping',
  },
  negotiating: {
    negotiated: 'ready',
    stop: 'stopping',
  },
  ready: {
    start_listening: 'listening',
    connection_lost: 'reconnecting',
    suspend: 'soft_paused',
    stop: 'stopping',
  },
  listening: {
    soft_pause: 'soft_paused',
    connection_lost: 'reconnecting',
    suspend: 'soft_paused',
    stop: 'stopping',
  },
  soft_paused: {
    resume: 'listening',
    connection_lost: 'reconnecting',
    suspend: 'soft_paused',
    stop: 'stopping',
  },
  reconnecting: {
    // After reconnection the session stays paused with position held; the
    // user is prompted to repeat the last phrase and resumes explicitly
    // (spec §29.6).
    reconnected: 'soft_paused',
    stop: 'stopping',
  },
  stopping: {
    stopped: 'idle',
  },
  recoverable_error: {
    retry: 'minting_credential',
    reset: 'idle',
    stop: 'stopping',
    fatal_error: 'fatal_error',
  },
  fatal_error: {
    reset: 'idle',
  },
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: RealtimeState,
    readonly event: RealtimeStateEvent,
  ) {
    super(`Invalid realtime state transition: ${from} --${event}-->`);
    this.name = 'InvalidTransitionError';
  }
}

export type StateChangeListener = (
  next: RealtimeState,
  previous: RealtimeState,
  event: RealtimeStateEvent,
) => void;

export function resolveTransition(
  from: RealtimeState,
  event: RealtimeStateEvent,
): RealtimeState | null {
  // Error escapes are available from every transitional/active state.
  if (event === 'recoverable_error' && ACTIVE_OR_TRANSITIONAL.includes(from)) {
    return 'recoverable_error';
  }
  if (event === 'fatal_error' && (ACTIVE_OR_TRANSITIONAL.includes(from) || from === 'recoverable_error')) {
    return 'fatal_error';
  }
  return TABLE[from]?.[event] ?? null;
}

export class RealtimeStateMachine {
  private current: RealtimeState = 'idle';
  private readonly listeners = new Set<StateChangeListener>();

  get state(): RealtimeState {
    return this.current;
  }

  canTransition(event: RealtimeStateEvent): boolean {
    return resolveTransition(this.current, event) !== null;
  }

  /** Apply an event; throws InvalidTransitionError on an illegal edge. */
  transition(event: RealtimeStateEvent): RealtimeState {
    const next = resolveTransition(this.current, event);
    if (next === null) throw new InvalidTransitionError(this.current, event);
    const previous = this.current;
    this.current = next;
    if (next !== previous) {
      for (const listener of this.listeners) listener(next, previous, event);
    }
    return next;
  }

  /** Apply an event only if legal; returns the state either way. */
  tryTransition(event: RealtimeStateEvent): RealtimeState {
    if (this.canTransition(event)) return this.transition(event);
    return this.current;
  }

  onChange(listener: StateChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
