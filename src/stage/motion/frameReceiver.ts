/**
 * SemanticFrameReceiver (companion §26.1).
 *
 * The stage consumes `SemanticMotionFrame`s at 15–30 Hz from the tracking
 * worker and must silently discard anything that cannot describe *this*
 * document in *this* layout: wrong session, wrong session generation, wrong
 * script, stale revision, old epoch. Rejections are counted, never logged per
 * frame, and surface through diagnostics.
 *
 * THE STAGE DOES NOT TRUST CONTROL. Frames arrive over an event channel from a
 * separate window; a defect upstream must not be able to wedge the display. The
 * motion plant is *persistent* for the life of the session, so a single frame
 * carrying `NaN` in any numeric field would poison prediction → target →
 * acceleration → velocity → position and every later frame would render
 * `translate3d(0, NaNpx, 0)` forever. Every field is therefore validated
 * structurally before acceptance: numerics must be finite, counters must be
 * finite integers, enums must be members, and the nested transition directive
 * gets the same treatment. `validateSemanticFrame` is exhaustive by
 * construction — the field tables are typed `Record<keyof T, …>`, so adding a
 * field to the contract fails compilation until it is classified here.
 *
 * One deliberate softening of the strict §26.1 wording, counted so it is
 * visible in diagnostics rather than silent: a layout-generation bump is a
 * stage-local event that control learns about asynchronously (through the
 * motion ack). Frames stamped with the *previous* generation are rejected
 * during a short grace window and then tolerated, because the semantic unit
 * they carry is layout-independent and holding the stage forever is worse than
 * following a frame whose geometry we recompute ourselves anyway. A *newer*
 * generation than our own is always rejected: our generation only ever advances
 * locally, so a frame ahead of it is not describing a layout we ever published.
 *
 * The script compile hash is NOT softened. If the stage asserts a hash, a frame
 * that omits one is rejected: an incomplete identity claim is a reason to
 * discard the frame, never a reason to weaken the gate.
 */
import type {
  SemanticMotionFrame,
  StageTransitionDirective,
  TrackingBehavior,
  TrackingStateV2,
} from '../../shared/contracts';

export type FrameRejectReason =
  | 'malformed'
  | 'session'
  | 'session_generation'
  | 'script_hash'
  | 'layout_generation'
  | 'epoch'
  | 'revision';

export interface SemanticFrameGate {
  sessionId: string;
  sessionGeneration: number;
  /** Empty string disables the check (see module note). */
  scriptCompileHash: string;
  layoutGeneration: number;
}

export interface FrameReceiverStats {
  accepted: number;
  rejected: number;
  byReason: Record<FrameRejectReason, number>;
  /** Frames accepted despite a stale layout generation, after the grace window. */
  toleratedStaleLayout: number;
  /** Field name of the most recent structural rejection — diagnostics only. */
  lastMalformedField: string | null;
  lastAcceptedAtMs: number | null;
  lastRevision: number | null;
  lastEpoch: number | null;
}

export interface FrameAcceptance {
  accepted: boolean;
  reason?: FrameRejectReason;
  tolerated?: 'layout_generation';
  /** Which field failed structural validation, when `reason === 'malformed'`. */
  field?: string;
}

export interface SemanticFrameReceiver {
  readonly current: SemanticMotionFrame | null;
  readonly stats: FrameReceiverStats;
  readonly gate: SemanticFrameGate;
  accept(frame: SemanticMotionFrame, nowMs: number): FrameAcceptance;
  /** Update the gate; a layout-generation change restarts the grace window. */
  setGate(patch: Partial<SemanticFrameGate>, nowMs: number): void;
  /** Drop the cached frame (session reset / new document). */
  reset(): void;
}

export interface SemanticFrameReceiverOptions {
  gate: SemanticFrameGate;
  /** How long stale-layout frames are rejected before being tolerated. */
  layoutGraceMs?: number;
}

const DEFAULT_LAYOUT_GRACE_MS = 900;

/* ---------------------------------------------------------------------------
 * Structural validation
 *
 * `FRAME_FIELD_KINDS` classifies every field of `SemanticMotionFrame` and is
 * typed `Record<keyof SemanticMotionFrame, FieldKind>` — so a field added to
 * the contract upstream fails compilation here until it is classified, rather
 * than sliding through unvalidated. The validator is driven directly off this
 * table; there is no second list to keep in sync.
 * ------------------------------------------------------------------------- */

type FieldKind =
  /** Finite number; may be fractional. */
  | 'real'
  /** Finite integer — identity/sequence counters, never fractional, never NaN. */
  | 'integer'
  /** Plain string (may be empty unless the gate asserts otherwise). */
  | 'string'
  | 'state'
  | 'behavior'
  | 'boolean'
  /** Optional nested directive; validated field-by-field when present. */
  | 'transition';

const FRAME_FIELD_KINDS: Record<keyof SemanticMotionFrame, FieldKind> = {
  sessionId: 'string',
  sessionGeneration: 'integer',
  scriptCompileHash: 'string',
  layoutGeneration: 'integer',
  revision: 'integer',
  epoch: 'integer',
  sessionTimeMs: 'real',

  estimatedUnit: 'real',
  committedUnit: 'real',
  velocityUnitsPerSecond: 'real',
  accelerationUnitsPerSecond2: 'real',
  positionVariance: 'real',
  confidence: 'real',

  sectionId: 'string',
  tokenIndex: 'integer',
  sentenceId: 'string',
  blockId: 'string',
  state: 'state',
  behavior: 'behavior',
  finalEvidence: 'boolean',

  transition: 'transition',
  motionProfileId: 'string',
};

const FRAME_FIELD_ENTRIES = Object.entries(FRAME_FIELD_KINDS) as Array<
  [keyof SemanticMotionFrame, FieldKind]
>;

/** Membership sets, complete by construction (`Record<Union, true>`). */
const TRACKING_STATES: Record<TrackingStateV2, true> = {
  acquiring: true,
  following: true,
  coasting: true,
  uncertain: true,
  adlib_hold: true,
  catching_up: true,
  retake_pending: true,
  rewinding: true,
  reanchoring: true,
  command_pending: true,
  paused: true,
  reconnecting: true,
  lost_local: true,
};

const TRACKING_BEHAVIORS: Record<TrackingBehavior, true> = {
  acquire: true,
  normal: true,
  minor_variation: true,
  paraphrase: true,
  adlib: true,
  return: true,
  small_skip: true,
  large_skip: true,
  retake_candidate: true,
  retake: true,
  manual_navigation: true,
  command_navigation: true,
  lost: true,
};

const TRANSITION_TYPES: Record<StageTransitionDirective['type'], true> = {
  none: true,
  settle: true,
  catch_up: true,
  rewind: true,
  reanchor: true,
  reset: true,
};

const TRANSITION_AUTHORITIES: Record<StageTransitionDirective['authority'], true> = {
  ordinary: true,
  command: true,
  manual: true,
};

const TRANSITION_REASONS: Record<StageTransitionDirective['reason'], true> = {
  large_forward_skip: true,
  distant_retake: true,
  command_navigation: true,
  manual_navigation: true,
  layout_recovery: true,
  session_reset: true,
};

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isMember(table: Record<string, true>, value: unknown): boolean {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(table, value);
}

/**
 * Validate the nested transition directive (§53). A directive is authority to
 * overwrite plant state, so it is held to the same standard as the frame.
 * Returns the offending field name, or null when the directive is sound.
 */
export function validateTransitionDirective(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return 'transition';
  const d = value as Record<string, unknown>;
  if (typeof d.id !== 'string' || d.id.length === 0) return 'transition.id';
  if (!isMember(TRANSITION_TYPES, d.type)) return 'transition.type';
  if (!isMember(TRANSITION_AUTHORITIES, d.authority)) return 'transition.authority';
  if (!isMember(TRANSITION_REASONS, d.reason)) return 'transition.reason';
  if (!isFiniteNumber(d.fromUnit)) return 'transition.fromUnit';
  if (!isFiniteNumber(d.toUnit)) return 'transition.toUnit';
  if (!isFiniteInteger(d.destinationTokenIndex)) return 'transition.destinationTokenIndex';
  if (!isFiniteNumber(d.issuedAtMs)) return 'transition.issuedAtMs';
  if (!isFiniteNumber(d.expiresAtMs)) return 'transition.expiresAtMs';
  if (!isFiniteInteger(d.semanticEpoch)) return 'transition.semanticEpoch';
  if (d.destinationLineHint !== undefined && typeof d.destinationLineHint !== 'string') {
    return 'transition.destinationLineHint';
  }
  return null;
}

/**
 * Validate a whole frame structurally. Returns the offending field name, or
 * null when every field is sound. Exported so the engine and its tests can
 * assert the same contract the receiver enforces.
 */
export function validateSemanticFrame(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return 'frame';
  const f = value as Record<string, unknown>;

  for (const [key, kind] of FRAME_FIELD_ENTRIES) {
    const v = f[key];
    switch (kind) {
      case 'string':
        if (typeof v !== 'string') return key;
        break;
      case 'real':
        if (!isFiniteNumber(v)) return key;
        break;
      case 'integer':
        if (!isFiniteInteger(v)) return key;
        break;
      case 'state':
        if (!isMember(TRACKING_STATES, v)) return key;
        break;
      case 'behavior':
        if (!isMember(TRACKING_BEHAVIORS, v)) return key;
        break;
      case 'boolean':
        if (typeof v !== 'boolean') return key;
        break;
      case 'transition': {
        if (v === undefined) break;
        const bad = validateTransitionDirective(v);
        if (bad !== null) return bad;
        break;
      }
    }
  }
  return null;
}

function emptyStats(): FrameReceiverStats {
  return {
    accepted: 0,
    rejected: 0,
    byReason: {
      malformed: 0,
      session: 0,
      session_generation: 0,
      script_hash: 0,
      layout_generation: 0,
      epoch: 0,
      revision: 0,
    },
    toleratedStaleLayout: 0,
    lastMalformedField: null,
    lastAcceptedAtMs: null,
    lastRevision: null,
    lastEpoch: null,
  };
}

export function createSemanticFrameReceiver(
  options: SemanticFrameReceiverOptions,
): SemanticFrameReceiver {
  const graceMs = options.layoutGraceMs ?? DEFAULT_LAYOUT_GRACE_MS;
  let gate: SemanticFrameGate = { ...options.gate };
  let layoutChangedAtMs = Number.NEGATIVE_INFINITY;
  let current: SemanticMotionFrame | null = null;
  const stats = emptyStats();

  function reject(reason: FrameRejectReason, field?: string): FrameAcceptance {
    stats.rejected++;
    stats.byReason[reason]++;
    if (field !== undefined) stats.lastMalformedField = field;
    return field === undefined
      ? { accepted: false, reason }
      : { accepted: false, reason, field };
  }

  return {
    get current() {
      return current;
    },
    get stats() {
      return stats;
    },
    get gate() {
      return gate;
    },

    accept(frame, nowMs): FrameAcceptance {
      // Structural validation FIRST: no field of an unvalidated frame may be
      // compared, stored, or forwarded (see module note).
      const bad = validateSemanticFrame(frame);
      if (bad !== null) return reject('malformed', bad);

      if (frame.sessionId !== gate.sessionId) return reject('session');
      if (frame.sessionGeneration !== gate.sessionGeneration) {
        return reject('session_generation');
      }
      if (gate.scriptCompileHash && frame.scriptCompileHash !== gate.scriptCompileHash) {
        // Includes the empty-string case: an omitted hash is an incomplete
        // identity claim, not a licence to skip the check.
        return reject('script_hash');
      }

      let tolerated: FrameAcceptance['tolerated'];
      if (frame.layoutGeneration !== gate.layoutGeneration) {
        // Newer than us: the control side claims a layout change we never
        // published. Our generation only advances locally, so this frame is not
        // describing any geometry we have ever had.
        if (frame.layoutGeneration > gate.layoutGeneration) {
          return reject('layout_generation');
        }
        if (nowMs - layoutChangedAtMs < graceMs) {
          return reject('layout_generation');
        }
        tolerated = 'layout_generation';
      }

      // Epoch is the authority counter: a newer epoch supersedes revision
      // history, an older one is a late frame from a superseded timeline.
      if (stats.lastEpoch !== null) {
        if (frame.epoch < stats.lastEpoch) return reject('epoch');
        if (frame.epoch === stats.lastEpoch) {
          if (stats.lastRevision !== null && frame.revision <= stats.lastRevision) {
            return reject('revision');
          }
        }
      }

      current = frame;
      stats.accepted++;
      stats.lastAcceptedAtMs = nowMs;
      stats.lastRevision = frame.revision;
      stats.lastEpoch = frame.epoch;
      if (tolerated) stats.toleratedStaleLayout++;
      return tolerated ? { accepted: true, tolerated } : { accepted: true };
    },

    setGate(patch, nowMs) {
      const nextLayout = patch.layoutGeneration;
      if (nextLayout !== undefined && nextLayout !== gate.layoutGeneration) {
        layoutChangedAtMs = nowMs;
      }
      gate = { ...gate, ...patch };
    },

    reset() {
      current = null;
      stats.lastRevision = null;
      stats.lastEpoch = null;
    },
  };
}
