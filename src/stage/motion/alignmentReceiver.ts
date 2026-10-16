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
 * THE ESTIMATOR, AND THE SIGN THAT WAS WRONG
 * ---------------------------------------------------------------------------
 * A snapshot produced at audio time `A` reaches the stage at wall time
 * `w = (A - trueOffset) + deliveryDelay`, so
 *
 *     sample = A - w = trueOffset - deliveryDelay
 *
 * Delivery delay is never negative, which puts a CEILING on the samples, not a
 * floor: the best sample is the largest one. This used to take the lifetime
 * MINIMUM on the stated reasoning that delay pushed samples up — it pushes them
 * down — so one slow delivery pinned the clock behind for the rest of the take.
 * A single 1 s stall left the display permanently ~3 words late, and nothing
 * recovered it because a lifetime minimum only ever falls.
 *
 * So: the maximum, over a bounded WINDOW rather than the whole session. A
 * lifetime maximum has the mirror-image failure — the offset legitimately falls
 * when capture stalls and the audio clock stops while wall time does not, and a
 * lifetime maximum would keep predicting from a moment the session never
 * reached. A window recovers from both.
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
  /**
   * Let go of the current snapshot WITHOUT forgetting how far the feed got.
   *
   * `reset` also clears the `seq` high-water mark, which re-opens the door to a
   * snapshot this receiver has already consumed — and the separate stage window
   * is handed the same alignment snapshot again on every live-sync revision.
   * Released with `reset`, that copy was accepted as new, so a move the stage
   * had already spent came back and was spent again.
   */
  release(): void;
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

/**
 * How much history the clock estimate considers.
 *
 * Long enough to span several snapshots (they arrive ~1/s) so one slow delivery
 * is outvoted; short enough that a genuine change in the audio-to-wall
 * relationship — a capture stall — is forgotten within a few seconds rather
 * than held for the rest of the take.
 */
const CLOCK_WINDOW_MS = 8_000;

export function createAlignmentReceiver(sessionGeneration = 0): AlignmentReceiver {
  let generation = sessionGeneration;
  let current: AlignmentSnapshot | null = null;
  let receivedAtMs: number | null = null;
  /**
   * Recent `audioMs − wallMs` samples, newest last. The estimate is their
   * maximum; the window is what lets it come back down when the audio clock
   * genuinely falls behind wall time.
   */
  let offsetSamples: Array<{ atMs: number; offsetMs: number }> = [];
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

      offsetSamples.push({ atMs: nowMs, offsetMs: snapshot.atAudioMs - nowMs });
      const cutoff = nowMs - CLOCK_WINDOW_MS;
      // Always keep the newest sample, however old the window makes it look:
      // a feed quieter than the window is still the only evidence there is.
      while (offsetSamples.length > 1 && offsetSamples[0]!.atMs < cutoff) {
        offsetSamples.shift();
      }
      return { accepted: true };
    },

    audioNowMs(nowMs) {
      if (offsetSamples.length === 0) return null;
      let best = offsetSamples[0]!.offsetMs;
      for (const sample of offsetSamples) {
        if (sample.offsetMs > best) best = sample.offsetMs;
      }
      return nowMs + best;
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
      offsetSamples = [];
      /*
       * The COUNTERS go too, not just `lastSeq`.
       *
       * These describe the feed, and the feed is a property of the SESSION —
       * which is the unit this method is given, and the only one it can see.
       * One window can serve a second session (Present again opens one), and
       * the engine that owns this receiver survives the change. Carried
       * forward, the counts stop answering the question anybody asks of them: a
       * session that rejected everything early would keep supplying the
       * "dominant" rejection reason for a later, healthy one — and, worse in
       * the other direction, a single acceptance from the earlier session would
       * make the next one's all-rejected feed look partly healthy, which is
       * precisely the reading this instrument exists to make impossible.
       *
       * NOT per take PASS. A retake ("restart paragraph") opens a new pass
       * inside the same session and never changes the generation, so its counts
       * continue. That is the honest scope: nothing tells this receiver a pass
       * began, and the feed it is describing did not restart either.
       */
      stats.accepted = 0;
      stats.rejected = 0;
      stats.byReason.malformed = 0;
      stats.byReason.session_generation = 0;
      stats.byReason.stale = 0;
      stats.lastMalformedField = null;
      stats.lastAcceptedAtMs = null;
      stats.lastSeq = null;
    },

    reset() {
      current = null;
      receivedAtMs = null;
      offsetSamples = [];
      stats.lastSeq = null;
    },

    release() {
      current = null;
      receivedAtMs = null;
      offsetSamples = [];
    },
  };
}
