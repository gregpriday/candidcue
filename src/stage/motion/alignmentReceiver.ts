/**
 * The stage's gate on incoming alignment snapshots, and its audio clock.
 *
 * ---------------------------------------------------------------------------
 * WHY THE STAGE NEEDS A CLOCK AT ALL
 * ---------------------------------------------------------------------------
 * `alignmentDisplayAt` is a function of AUDIO-clock time — milliseconds of
 * audio the session has sent, which is what the engine's lag model was
 * calibrated against. The stage runs on `performance.now()` and has never seen
 * a byte of audio. So it estimates: every snapshot carries the audio time it
 * was produced at, and between snapshots the stage advances that reading by
 * elapsed wall time.
 *
 * That estimate is sound because the two clocks run at the same rate whenever
 * audio is flowing — the session streams 100 ms of audio every 100 ms — and
 * because the estimate is only ever used inside a bounded prediction horizon,
 * so an error cannot accumulate. Where they DIVERGE is precisely where the
 * horizon has already expired: if capture stalls, the audio clock stops while
 * wall time does not, and the estimate runs ahead. Past `maxPredictionMs` that
 * makes no difference at all, because the horizon is clamped and the display
 * stops advancing either way.
 *
 * The offset is taken as the MINIMUM observed sample rather than the latest.
 * Each sample is `trueOffset + deliveryDelay`, and delivery delay is never
 * negative, so the samples have a hard floor and the minimum converges onto it
 * instead of tracking whichever snapshot happened to cross the window boundary
 * slowest.
 *
 * ---------------------------------------------------------------------------
 * THE STAGE DOES NOT TRUST WHAT IT IS SENT
 * ---------------------------------------------------------------------------
 * Snapshots arrive over an event channel from another process. The motion plant
 * is persistent for the life of the session, so a single `NaN` would poison
 * every later frame permanently. Everything is validated structurally before
 * acceptance, and rejections are counted rather than logged per snapshot.
 */
import {
  isAlignmentSnapshot,
  validateAlignmentSnapshot,
  type AlignmentSnapshot,
} from '../../shared/contracts';

export type SnapshotRejectReason = 'malformed' | 'session_generation' | 'stale';

export interface AlignmentReceiverStats {
  accepted: number;
  rejected: number;
  byReason: Record<SnapshotRejectReason, number>;
  /** Field name of the most recent structural rejection — diagnostics only. */
  lastMalformedField: string | null;
  lastAcceptedAtMs: number | null;
  lastSeq: number | null;
}

export interface SnapshotAcceptance {
  accepted: boolean;
  reason?: SnapshotRejectReason;
  field?: string;
}

export interface AlignmentReceiver {
  readonly current: AlignmentSnapshot | null;
  readonly stats: AlignmentReceiverStats;
  /** The generation this receiver will accept snapshots for. */
  readonly sessionGeneration: number;
  accept(snapshot: unknown, nowMs: number): SnapshotAcceptance;
  /**
   * Best estimate of the session's audio clock at wall time `nowMs`, or null
   * before the first snapshot has arrived — there is nothing to anchor an
   * estimate to until then, and guessing would be worse than holding.
   */
  audioNowMs(nowMs: number): number | null;
  /** How long ago the current snapshot arrived. `Infinity` when there is none. */
  ageMs(nowMs: number): number;
  setSession(sessionGeneration: number): void;
  reset(): void;
}

function emptyStats(): AlignmentReceiverStats {
  return {
    accepted: 0,
    rejected: 0,
    byReason: { malformed: 0, session_generation: 0, stale: 0 },
    lastMalformedField: null,
    lastAcceptedAtMs: null,
    lastSeq: null,
  };
}

export function createAlignmentReceiver(sessionGeneration = 0): AlignmentReceiver {
  let generation = sessionGeneration;
  let current: AlignmentSnapshot | null = null;
  let receivedAtMs: number | null = null;
  /** audioMs − wallMs, the minimum sample seen this session. */
  let clockOffsetMs: number | null = null;
  const stats = emptyStats();

  function reject(reason: SnapshotRejectReason, field?: string): SnapshotAcceptance {
    stats.rejected++;
    stats.byReason[reason]++;
    if (field !== undefined) stats.lastMalformedField = field;
    return field === undefined ? { accepted: false, reason } : { accepted: false, reason, field };
  }

  return {
    get current() {
      return current;
    },
    get stats() {
      return stats;
    },
    get sessionGeneration() {
      return generation;
    },

    accept(snapshot, nowMs): SnapshotAcceptance {
      // Structural validation FIRST: no field of an unvalidated payload may be
      // compared, stored, or forwarded.
      const bad = validateAlignmentSnapshot(snapshot);
      if (bad !== null) return reject('malformed', bad);
      if (!isAlignmentSnapshot(snapshot)) return reject('malformed', 'snapshot');

      if (snapshot.sessionGeneration !== generation) return reject('session_generation');
      // `seq` is monotone per session, so anything not strictly newer is a
      // duplicate or a reordered delivery — either way it describes a past the
      // display has already moved through.
      if (stats.lastSeq !== null && snapshot.seq <= stats.lastSeq) return reject('stale');

      current = snapshot;
      receivedAtMs = nowMs;
      stats.accepted++;
      stats.lastAcceptedAtMs = nowMs;
      stats.lastSeq = snapshot.seq;

      const sample = snapshot.atAudioMs - nowMs;
      clockOffsetMs = clockOffsetMs === null ? sample : Math.min(clockOffsetMs, sample);
      return { accepted: true };
    },

    audioNowMs(nowMs) {
      if (clockOffsetMs === null) return null;
      return nowMs + clockOffsetMs;
    },

    ageMs(nowMs) {
      return receivedAtMs === null ? Number.POSITIVE_INFINITY : nowMs - receivedAtMs;
    },

    setSession(next) {
      if (next === generation) return;
      generation = next;
      // A new take is a new audio clock starting at zero; carrying the old
      // offset forward would place every prediction minutes into the future.
      current = null;
      receivedAtMs = null;
      clockOffsetMs = null;
      stats.lastSeq = null;
    },

    reset() {
      current = null;
      receivedAtMs = null;
      clockOffsetMs = null;
      stats.lastSeq = null;
    },
  };
}
