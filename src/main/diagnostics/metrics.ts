/**
 * Per-turn metrics collection and aggregation (spec §23.4).
 *
 * `MetricsCollector` accumulates one `TurnMetrics` record per interview turn and
 * produces a session-level summary on demand. The summary surfaces the timing
 * distribution operators care about (average and p95 think time) along with
 * tallies that reveal degraded behaviour: how often endpointing was manual vs.
 * automatic, how often a fallback path or forced cut fired, and how often TTS
 * or the audio device failed.
 *
 * The collector is pure in-memory and side-effect free; callers own when to
 * flush or persist the aggregate.
 */

import type { EndpointReason } from '@shared/domain';

/**
 * Timing, sizing, and outcome metrics for a single interview turn (spec §23.4).
 *
 * All `*Ms` latencies are nullable because a stage may be skipped (e.g. no
 * cleanup model configured) or may have failed before recording a duration.
 * `null` is treated as "not measured" and excluded from timing aggregates.
 */
export interface TurnMetrics {
  sessionId: string;
  turnId: string;

  /** Time to finalise the speech-to-text transcript after speech ended. */
  sttFinalizeMs: number | null;
  /** Time spent in transcript cleanup. */
  cleanupMs: number | null;
  /** Time spent in the moderation check. */
  moderationMs: number | null;
  /** Time to generate the next question from the model. */
  questionGenerationMs: number | null;
  /** Time spent repairing an invalid/over-long generated question, if any. */
  questionRepairMs: number | null;
  /** Time spent synthesising question audio (TTS). */
  ttsMs: number | null;
  /** Time spent preloading the speaking stage media. */
  stagePreloadMs: number | null;
  /**
   * End-to-end "think time" between the answer ending and the next question
   * being ready. This is the headline latency aggregated into avg/p95.
   */
  totalThinkTimeMs: number | null;

  /** Word count of the generated question. */
  questionWords: number | null;
  /** Duration of the synthesised question audio. */
  questionAudioMs: number | null;

  /** Why the answer turn ended (manual/automatic/timeout/recovery). */
  endpointReason: EndpointReason;

  /** Speaking clip ids selected for the question's media plan. */
  speakingClipIds: string[];
  /** Playback rates applied to each selected speaking clip. */
  playbackRate: number[];

  /** True when any fallback path was used (cached opening, fallback bank, ...). */
  fallbackUsed: boolean;

  /** Non-fatal errors recorded during the turn (codes or messages). */
  errors: string[];
}

/** Session-level rollup produced by `MetricsCollector.aggregate()` (spec §23.4). */
export interface MetricsAggregate {
  /** Number of turns recorded. */
  count: number;
  /** Mean of non-null `totalThinkTimeMs` values, rounded; 0 when none. */
  avgThinkMs: number;
  /** 95th-percentile think time over non-null values; 0 when none. */
  p95ThinkMs: number;
  /** Turns ended manually by the operator. */
  manualEndpoints: number;
  /** Turns ended by automatic endpointing. */
  automaticEndpoints: number;
  /** Turns where the transcript-cleanup fallback path was taken. */
  cleanupFallbacks: number;
  /** Turns where a model fallback (cache/bank/operator) was taken. */
  modelFallbacks: number;
  /** Turns where TTS failed. */
  ttsFailures: number;
  /** Turns ended by a forced cut. */
  forcedCuts: number;
  /** Turns interrupted by an audio device fault. */
  deviceInterruptions: number;
}

/**
 * Error markers recognised in `TurnMetrics.errors` when computing failure
 * tallies. Matching is case-insensitive substring containment so callers can
 * push richer messages (e.g. "tts_failure: inworld timeout") and still be
 * counted. Keep these aligned with the codes producers actually emit.
 */
const ERROR_MARKERS = {
  cleanupFallback: 'cleanup_fallback',
  modelFallback: 'model_fallback',
  ttsFailure: 'tts_failure',
  forcedCut: 'forced_cut',
  deviceInterruption: 'device_interruption',
} as const;

/** True when any entry in `errors` contains `marker` (case-insensitive). */
function hasMarker(errors: readonly string[], marker: string): boolean {
  const needle = marker.toLowerCase();
  return errors.some((e) => e.toLowerCase().includes(needle));
}

/**
 * Compute the p95 of `values` using nearest-rank: the value at index
 * `ceil(0.95 * n) - 1` of the ascending-sorted, non-null set. Returns 0 for an
 * empty set so the aggregate never produces NaN.
 */
function percentile95(values: readonly number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(0.95 * n) - 1;
  // Clamp into [0, n-1] for safety; ceil(0.95*n)-1 is already in range for n>=1.
  const index = Math.min(Math.max(rank, 0), n - 1);
  return sorted[index] as number;
}

export class MetricsCollector {
  private readonly turns: TurnMetrics[] = [];

  /** Append a turn's metrics. The record is stored by reference (callers should not mutate). */
  record(turn: TurnMetrics): void {
    this.turns.push(turn);
  }

  /** Number of turns recorded so far. */
  size(): number {
    return this.turns.length;
  }

  /**
   * Roll up all recorded turns into a session-level summary. Safe on empty
   * input: every numeric field is 0 (never NaN).
   */
  aggregate(): MetricsAggregate {
    const count = this.turns.length;

    // Collect non-null think times for the timing distribution.
    const thinkTimes: number[] = [];
    let manualEndpoints = 0;
    let automaticEndpoints = 0;
    let cleanupFallbacks = 0;
    let modelFallbacks = 0;
    let ttsFailures = 0;
    let forcedCuts = 0;
    let deviceInterruptions = 0;

    for (const turn of this.turns) {
      if (turn.totalThinkTimeMs !== null) {
        thinkTimes.push(turn.totalThinkTimeMs);
      }

      if (turn.endpointReason === 'manual') manualEndpoints += 1;
      else if (turn.endpointReason === 'automatic') automaticEndpoints += 1;

      const errors = turn.errors;
      if (hasMarker(errors, ERROR_MARKERS.cleanupFallback)) cleanupFallbacks += 1;
      // A model fallback is signalled either by an explicit error marker or by
      // the structural `fallbackUsed` flag (cached opening / fallback bank).
      if (turn.fallbackUsed || hasMarker(errors, ERROR_MARKERS.modelFallback)) {
        modelFallbacks += 1;
      }
      if (hasMarker(errors, ERROR_MARKERS.ttsFailure)) ttsFailures += 1;
      if (hasMarker(errors, ERROR_MARKERS.forcedCut)) forcedCuts += 1;
      if (hasMarker(errors, ERROR_MARKERS.deviceInterruption)) deviceInterruptions += 1;
    }

    const avgThinkMs =
      thinkTimes.length === 0
        ? 0
        : Math.round(thinkTimes.reduce((sum, v) => sum + v, 0) / thinkTimes.length);

    return {
      count,
      avgThinkMs,
      p95ThinkMs: percentile95(thinkTimes),
      manualEndpoints,
      automaticEndpoints,
      cleanupFallbacks,
      modelFallbacks,
      ttsFailures,
      forcedCuts,
      deviceInterruptions,
    };
  }
}
