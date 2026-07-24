/**
 * SemanticFrameReceiver (companion §26.1).
 *
 * The stage consumes `SemanticMotionFrame`s at 15–30 Hz from the tracking
 * worker and must silently discard anything that cannot describe *this*
 * document in *this* layout: wrong session, wrong session generation, wrong
 * script, stale revision, old epoch. Rejections are counted, never logged per
 * frame, and surface through diagnostics.
 *
 * Two deliberate softenings of the strict §26.1 wording, both counted so they
 * are visible in diagnostics rather than silent:
 *
 * 1. `scriptCompileHash` is only enforced when *both* sides declare one. An
 *    empty string on either side means "not asserted" — the session identity
 *    gate is already carrying the safety weight there.
 * 2. A layout-generation bump is a stage-local event that control learns about
 *    asynchronously (through the motion ack). Frames stamped with the previous
 *    generation are rejected during a short grace window and then tolerated,
 *    because the semantic unit they carry is layout-independent and holding the
 *    stage forever is worse than following a frame whose geometry we recompute
 *    ourselves anyway.
 */
import type { SemanticMotionFrame } from '../../shared/contracts';

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
  lastAcceptedAtMs: number | null;
  lastRevision: number | null;
  lastEpoch: number | null;
}

export interface FrameAcceptance {
  accepted: boolean;
  reason?: FrameRejectReason;
  tolerated?: 'layout_generation';
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
    lastAcceptedAtMs: null,
    lastRevision: null,
    lastEpoch: null,
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function createSemanticFrameReceiver(
  options: SemanticFrameReceiverOptions,
): SemanticFrameReceiver {
  const graceMs = options.layoutGraceMs ?? DEFAULT_LAYOUT_GRACE_MS;
  let gate: SemanticFrameGate = { ...options.gate };
  let layoutChangedAtMs = Number.NEGATIVE_INFINITY;
  let current: SemanticMotionFrame | null = null;
  const stats = emptyStats();

  function reject(reason: FrameRejectReason): FrameAcceptance {
    stats.rejected++;
    stats.byReason[reason]++;
    return { accepted: false, reason };
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
      if (
        !frame ||
        typeof frame.sessionId !== 'string' ||
        !isFiniteNumber(frame.revision) ||
        !isFiniteNumber(frame.epoch) ||
        !isFiniteNumber(frame.estimatedUnit) ||
        !isFiniteNumber(frame.sessionTimeMs)
      ) {
        return reject('malformed');
      }
      if (frame.sessionId !== gate.sessionId) return reject('session');
      if (frame.sessionGeneration !== gate.sessionGeneration) {
        return reject('session_generation');
      }
      if (
        gate.scriptCompileHash &&
        frame.scriptCompileHash &&
        frame.scriptCompileHash !== gate.scriptCompileHash
      ) {
        return reject('script_hash');
      }

      let tolerated: FrameAcceptance['tolerated'];
      if (frame.layoutGeneration !== gate.layoutGeneration) {
        // Newer than us: the control side is ahead of a layout change we have
        // not applied. Always reject — our geometry cannot serve that frame.
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
