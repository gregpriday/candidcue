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
  AlignmentSnapshot,
  StageCalibrationMode,
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
  mode: StageCalibrationMode;
  crosshairX: number;
  crosshairY: number;
  safeArea: { top: number; right: number; bottom: number; left: number };
  rulerLengthPx: number;
  sampleFontSizePx: number;
  sampleColumnCh: number;
  sampleLabel: string;
}

export interface StageAppState {
  /** Base lifecycle phase; frozen/blank are layered flags (see displayPhase). */
  phase: 'handshake' | 'ready' | 'live';
  envelope: StageSessionEnvelope | null;
  settings: StageSettings | null;
  alignment: AlignmentSnapshot | null;
  lastTrackingRevision: number | null;
  frozen: boolean;
  frozenReason: FrozenReason | null;
  blanked: boolean;
  /**
   * §48. Voice following is switched off; the presenter is driving the script.
   *
   * Off by default and for every take that never touches the control, because
   * following is what a take IS — the switch exists for the presenter who wants
   * to read from a script at their own pace, and a stage that opened with it
   * already flipped would be a prompter that does not prompt.
   */
  followPaused: boolean;
  ack: StageAckState | null;
  calibration: StageCalibrationState;
  diagnostics: boolean;
  lastHeartbeat: { revision: number; receivedAtMs: number } | null;
}

export type StageAction =
  | { type: 'snapshot'; envelope: StageSessionEnvelope }
  | { type: 'layout_ready' }
  | { type: 'alignment'; snapshot: AlignmentSnapshot }
  | { type: 'directive'; stageGeneration: number; directive: StageDirective }
  | { type: 'heartbeat'; payload: StageHeartbeatPayload; receivedAtMs: number }
  | { type: 'control_lost' };

/**
 * Calibration starts inert, centred, and with sample values that are safe to
 * render before control has said anything.
 *
 * Every field carries a usable default rather than being optional, because the
 * directive that turns a mode on may legitimately carry only the one or two
 * fields that mode needs — an operator dragging the safe-area border sends no
 * crosshair position, and must not clear the one already stored.
 */
function initialCalibrationState(): StageCalibrationState {
  return {
    active: false,
    mode: 'crosshair',
    crosshairX: 0.5,
    crosshairY: 0.38,
    safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
    // 400 px is long enough to measure accurately against a ruler and short
    // enough to fit the short edge of a 1024x600 panel with room to spare.
    rulerLengthPx: 400,
    sampleFontSizePx: 64,
    sampleColumnCh: 34,
    sampleLabel: '',
  };
}

export function initialStageState(): StageAppState {
  return {
    phase: 'handshake',
    envelope: null,
    settings: null,
    alignment: null,
    lastTrackingRevision: null,
    frozen: false,
    frozenReason: null,
    blanked: false,
    followPaused: false,
    ack: null,
    calibration: initialCalibrationState(),
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
        // A new generation restarts the handshake (layout must settle again);
        // a same-generation re-send just refreshes the document in place.
        phase: newGeneration ? 'handshake' : state.phase,
        alignment: newGeneration ? null : state.alignment,
        lastTrackingRevision: newGeneration ? null : state.lastTrackingRevision,
        frozen: newGeneration ? false : state.frozen,
        frozenReason: newGeneration ? null : state.frozenReason,
        /*
         * §48. A new take follows the presenter's voice — that is what a take
         * IS — so the switch goes back on with it.
         *
         * The standalone stage window outlives a session, and control sends no
         * `follow` directive at the start of one: it has nothing to say, the
         * switch being on by default. So a take that ended with following
         * switched off left this reducer holding `true`, and the NEXT take
         * opened on a window that was motion-paused and captioned "Following
         * off" while control believed it was following perfectly. Embedded
         * presentation never had this — its prop is read off session state,
         * which does reset — which is exactly why it would have shipped.
         */
        followPaused: newGeneration ? false : state.followPaused,
      };
    }

    case 'layout_ready': {
      if (!state.envelope || state.phase !== 'handshake') return state;
      return { ...state, phase: 'ready' };
    }

    case 'alignment': {
      const snap = action.snapshot;
      if (!state.envelope || state.phase === 'handshake') return state;
      // `seq` is monotone within a session; anything not strictly newer is a
      // duplicate or a reordered delivery.
      if (state.lastTrackingRevision !== null && snap.seq <= state.lastTrackingRevision) {
        return state;
      }
      return {
        ...state,
        alignment: snap,
        lastTrackingRevision: snap.seq,
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
        case 'calibration':
          /*
           * Every field falls back to what is already held.
           *
           * A calibration directive is a nudge, not a snapshot: the operator is
           * dragging one control at a time on the other screen, and the message
           * that moves the safe-area border says nothing about the lens. Reading
           * an absent field as "clear it" would make each adjustment undo the
           * last one — which is precisely the sort of thing that is invisible in
           * a unit test and maddening on a rig.
           */
          return {
            ...state,
            calibration: {
              active: d.active,
              mode: d.mode ?? state.calibration.mode,
              crosshairX: d.crosshairX ?? state.calibration.crosshairX,
              crosshairY: d.crosshairY ?? state.calibration.crosshairY,
              safeArea: d.safeArea ?? state.calibration.safeArea,
              rulerLengthPx: d.rulerLengthPx ?? state.calibration.rulerLengthPx,
              sampleFontSizePx: d.sampleFontSizePx ?? state.calibration.sampleFontSizePx,
              sampleColumnCh: d.sampleColumnCh ?? state.calibration.sampleColumnCh,
              sampleLabel: d.sampleLabel ?? state.calibration.sampleLabel,
            },
          };
        case 'follow':
          return { ...state, followPaused: d.paused };
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
      /*
       * KNOWN GAP, and the reason it is left alone.
       *
       * A stage that is ALREADY frozen keeps the reason it has, so a directive
       * freeze in force when control dies hides the control loss — the stage
       * stays still and says nothing, which is the very symptom the disclosure
       * exists to remove.
       *
       * Representing both at once needs two independent flags rather than one
       * `frozenReason`, because they recover differently: a heartbeat must lift
       * a control loss and must NOT lift a freeze somebody asked for. That is a
       * state-model change, and today it would buy nothing — the only producer
       * of a `freeze` directive in the tree is the preview driver
       * (`src/stage/preview.ts`), a dev tool with no control window to lose.
       * Control never sends one. If control ever does, split the flags here
       * rather than widening `frozenReason`.
       */
      if (state.phase === 'handshake' || state.frozen) return state;
      return { ...state, frozen: true, frozenReason: 'control_lost' };
    }

    default:
      return state;
  }
}
