/**
 * Stage application state machine (spec §45.6, §43.5):
 *
 *   handshake → ready → live, with frozen and blank layered on top.
 *
 * The reducer is pure so the lifecycle (stale-generation rejection, tracking
 * revision monotonicity, heartbeat recovery) is unit-testable. Timers and
 * event wiring live in StageApp.
 */
import type {
  StageSessionEnvelope,
  StageSettings,
  ListenerStageSelection,
  TrackingSnapshot,
  StageDirective,
  StageHeartbeatPayload,
} from '../../shared/contracts';

export type StagePhase = 'handshake' | 'ready' | 'live' | 'frozen' | 'blank';

export type FrozenReason = 'directive' | 'control_lost';

export interface StageAckState {
  label: string;
  durationMs: number;
  /** Monotonic sequence so repeated identical acks still re-trigger. */
  seq: number;
}

export interface StageCalibrationState {
  active: boolean;
  crosshairX: number;
  crosshairY: number;
}

export interface StageAppState {
  /** Base lifecycle phase; frozen/blank are layered flags (see displayPhase). */
  phase: 'handshake' | 'ready' | 'live';
  envelope: StageSessionEnvelope | null;
  settings: StageSettings | null;
  listener: ListenerStageSelection | null;
  tracking: TrackingSnapshot | null;
  lastTrackingRevision: number | null;
  frozen: boolean;
  frozenReason: FrozenReason | null;
  blanked: boolean;
  keepListenerWhenBlanked: boolean;
  ack: StageAckState | null;
  calibration: StageCalibrationState;
  diagnostics: boolean;
  lastHeartbeat: { revision: number; receivedAtMs: number } | null;
}

export type StageAction =
  | { type: 'snapshot'; envelope: StageSessionEnvelope }
  | { type: 'layout_ready' }
  | { type: 'tracking'; snapshot: TrackingSnapshot }
  | { type: 'directive'; stageGeneration: number; directive: StageDirective }
  | { type: 'heartbeat'; payload: StageHeartbeatPayload; receivedAtMs: number }
  | { type: 'control_lost' };

export function initialStageState(): StageAppState {
  return {
    phase: 'handshake',
    envelope: null,
    settings: null,
    listener: null,
    tracking: null,
    lastTrackingRevision: null,
    frozen: false,
    frozenReason: null,
    blanked: false,
    keepListenerWhenBlanked: false,
    ack: null,
    calibration: { active: false, crosshairX: 0.5, crosshairY: 0.38 },
    diagnostics: false,
    lastHeartbeat: null,
  };
}

/** Blank wins over frozen; both win over the base lifecycle phase (§16.6). */
export function displayPhase(state: StageAppState): StagePhase {
  if (state.blanked) return 'blank';
  if (state.frozen) return 'frozen';
  return state.phase;
}

export function stageReducer(state: StageAppState, action: StageAction): StageAppState {
  switch (action.type) {
    case 'snapshot': {
      const incoming = action.envelope;
      // Stale snapshots from a previous stage generation are ignored (§43.5).
      if (state.envelope && incoming.stageGeneration < state.envelope.stageGeneration) {
        return state;
      }
      const newGeneration =
        !state.envelope || incoming.stageGeneration > state.envelope.stageGeneration;
      return {
        ...state,
        envelope: incoming,
        settings: incoming.stageSettings,
        listener: incoming.listener ?? null,
        // A new generation restarts the handshake (layout must settle again);
        // a same-generation re-send just refreshes the document in place.
        phase: newGeneration ? 'handshake' : state.phase,
        tracking: newGeneration ? null : state.tracking,
        lastTrackingRevision: newGeneration ? null : state.lastTrackingRevision,
        frozen: newGeneration ? false : state.frozen,
        frozenReason: newGeneration ? null : state.frozenReason,
      };
    }

    case 'layout_ready': {
      if (!state.envelope || state.phase !== 'handshake') return state;
      return { ...state, phase: 'ready' };
    }

    case 'tracking': {
      const snap = action.snapshot;
      if (!state.envelope || state.phase === 'handshake') return state;
      if (snap.stageGeneration !== state.envelope.stageGeneration) return state;
      if (snap.sessionGeneration !== state.envelope.sessionGeneration) return state;
      if (state.lastTrackingRevision !== null && snap.revision <= state.lastTrackingRevision) {
        return state;
      }
      return {
        ...state,
        tracking: snap,
        lastTrackingRevision: snap.revision,
        phase: 'live',
      };
    }

    case 'directive': {
      if (state.envelope && action.stageGeneration !== state.envelope.stageGeneration) {
        return state;
      }
      const d = action.directive;
      switch (d.kind) {
        case 'blank':
          return {
            ...state,
            blanked: d.blanked,
            keepListenerWhenBlanked: d.keepListener ?? state.keepListenerWhenBlanked,
          };
        case 'freeze':
          return {
            ...state,
            frozen: d.frozen,
            frozenReason: d.frozen ? 'directive' : null,
          };
        case 'ack':
          return {
            ...state,
            ack: {
              label: d.label,
              durationMs: d.durationMs ?? 900,
              seq: (state.ack?.seq ?? 0) + 1,
            },
          };
        case 'settings':
          return { ...state, settings: d.settings };
        case 'listener':
          return { ...state, listener: d.listener };
        case 'calibration':
          return {
            ...state,
            calibration: {
              active: d.active,
              crosshairX: d.crosshairX ?? state.calibration.crosshairX,
              crosshairY: d.crosshairY ?? state.calibration.crosshairY,
            },
          };
        case 'diagnostics':
          return { ...state, diagnostics: d.visible };
        default:
          return state;
      }
    }

    case 'heartbeat': {
      if (state.envelope && action.payload.stageGeneration !== state.envelope.stageGeneration) {
        return state;
      }
      const next: StageAppState = {
        ...state,
        lastHeartbeat: { revision: action.payload.revision, receivedAtMs: action.receivedAtMs },
      };
      // Control came back: recover from a watchdog freeze automatically.
      if (state.frozen && state.frozenReason === 'control_lost') {
        next.frozen = false;
        next.frozenReason = null;
      }
      return next;
    }

    case 'control_lost': {
      if (state.phase === 'handshake' || state.frozen) return state;
      return { ...state, frozen: true, frozenReason: 'control_lost' };
    }

    default:
      return state;
  }
}
