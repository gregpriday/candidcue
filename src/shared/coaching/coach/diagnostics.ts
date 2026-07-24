/**
 * §37. Assembly of {@link CoachDiagnostics}.
 *
 * The contract described the shape; nothing built one. Two of its fields had no
 * instrumentation anywhere (`analyzerMeanCostMs`, and the worklet's dropped
 * frames had no path off the audio thread), one had raw samples but no mean
 * (`lunaMeanLatencyMs`), and the tip ratio the contract advertises as "the one
 * that tells you the rail is too chatty" would have been wrong on day one
 * because `tipsSuppressed` counted the ranking losers.
 *
 * ---------------------------------------------------------------------------
 * WHY A COLLECTOR RATHER THAN A BAG OF NUMBERS
 * ---------------------------------------------------------------------------
 * Every number here is produced by a different lane, and a diagnostics record
 * assembled ad hoc at a call site is one where a field silently stays zero
 * forever — which is what happened. The collector names each source, so an
 * un-fed input is an obviously missing call rather than a plausible zero.
 *
 * Wall-clock time is legitimate here and *only* here (§5.4): latency is
 * measured from `requestAudioTimeMs` to application, and that gap is the one
 * thing the audio clock cannot describe.
 */
import type { CoachDiagnostics } from '../../contracts/coaching';
import type { CoachObserverDiagnostics } from './luna-observer';

/** A rolling mean that never stores more than it needs. */
class RollingMean {
  private sum = 0;
  private count = 0;

  add(value: number): void {
    if (!Number.isFinite(value)) return;
    this.sum += value;
    this.count += 1;
  }

  get mean(): number {
    return this.count === 0 ? 0 : this.sum / this.count;
  }

  get samples(): number {
    return this.count;
  }

  reset(): void {
    this.sum = 0;
    this.count = 0;
  }
}

/** §37 counters the precision-transcription queue owns. */
export interface PrecisionCounters {
  queued: number;
  completed: number;
  dropped: number;
}

/** §37 counters the tip policy owns. See `CoachTipPolicy.getCounters()`. */
export interface TipCounters {
  proposed: number;
  shown: number;
  suppressed: number;
  /**
   * Ranking losers. Deliberately *not* folded into `suppressed`: a proposal
   * that lost to a more important one in the same window is not the rail being
   * too chatty, and counting it as such inverts the signal the ratio exists
   * for.
   */
  notSelected: number;
}

/**
 * Collects §37 telemetry across the subsystem's lanes.
 *
 * One instance per session. Nothing here influences behaviour; a collector that
 * is never fed produces zeros, which is why each input is a named method rather
 * than an optional field on a snapshot call.
 */
export class CoachDiagnosticsCollector {
  private droppedFrames = 0;
  private readonly analyzerCostMs = new RollingMean();
  private readonly lunaLatencyMs = new RollingMean();
  private precision: PrecisionCounters = { queued: 0, completed: 0, dropped: 0 };
  private tips: TipCounters = { proposed: 0, shown: 0, suppressed: 0, notSelected: 0 };
  private lunaRequests = 0;
  private lunaResponses = 0;
  private lunaRejected = 0;

  reset(): void {
    this.droppedFrames = 0;
    this.analyzerCostMs.reset();
    this.lunaLatencyMs.reset();
    this.precision = { queued: 0, completed: 0, dropped: 0 };
    this.tips = { proposed: 0, shown: 0, suppressed: 0, notSelected: 0 };
    this.lunaRequests = 0;
    this.lunaResponses = 0;
    this.lunaRejected = 0;
  }

  /**
   * §12.4. Frames the worklet reported as dropped.
   *
   * The worklet counts them on the audio thread and has no way to report them
   * itself — it must not touch IPC (§12.1) — so the count rides out on the
   * message it already sends and is folded in here. `WorkletCoreDiagnostics`
   * reports a running total, so this takes the total and not a delta.
   */
  noteDroppedFrameTotal(total: number): void {
    if (total > this.droppedFrames) this.droppedFrames = total;
  }

  /**
   * One analyzer aggregation pass, ms. The caller times its own pass, because
   * only it knows where the pass begins and ends; a timer inside this module
   * would measure the wrong thing and look authoritative doing it.
   */
  noteAnalyzerPass(costMs: number): void {
    this.analyzerCostMs.add(costMs);
  }

  /**
   * §37. Wall-clock latency from `requestAudioTimeMs` to answer application.
   *
   * Recorded per applied answer rather than derived from the observer's raw
   * `latencySamplesMs`, which are transport-reported and miss the queueing and
   * validation either side of the call.
   */
  noteLunaLatency(latencyMs: number): void {
    this.lunaLatencyMs.add(latencyMs);
  }

  /** Fold the observer's own counters in. Idempotent: these are totals. */
  noteObserver(diagnostics: Pick<CoachObserverDiagnostics, 'requests' | 'responses' | 'rejected'>): void {
    this.lunaRequests = diagnostics.requests;
    this.lunaResponses = diagnostics.responses;
    this.lunaRejected = diagnostics.rejected;
  }

  notePrecision(counters: PrecisionCounters): void {
    this.precision = { ...counters };
  }

  noteTips(counters: TipCounters): void {
    this.tips = { ...counters };
  }

  /** How many analyzer passes the mean rests on. A mean of one is not a mean. */
  get analyzerSampleCount(): number {
    return this.analyzerCostMs.samples;
  }

  get lunaLatencySampleCount(): number {
    return this.lunaLatencyMs.samples;
  }

  snapshot(): CoachDiagnostics {
    return {
      droppedFrameCount: this.droppedFrames,
      analyzerMeanCostMs: this.analyzerCostMs.mean,
      lunaRequests: this.lunaRequests,
      lunaResponses: this.lunaResponses,
      lunaRejected: this.lunaRejected,
      lunaMeanLatencyMs: this.lunaLatencyMs.mean,
      precisionQueued: this.precision.queued,
      precisionCompleted: this.precision.completed,
      precisionDropped: this.precision.dropped,
      tipsProposed: this.tips.proposed,
      tipsShown: this.tips.shown,
      tipsSuppressed: this.tips.suppressed,
    };
  }
}

/**
 * The mean of the observer's transport-reported latency samples, or `0`.
 *
 * The observer keeps the raw samples and nothing computed a mean from them, so
 * the contract's `lunaMeanLatencyMs` had a source and no consumer. Exposed
 * separately from the collector because it answers a narrower question —
 * "how slow is the API" rather than "how late is an answer by the time it is
 * applied" — and conflating the two is how a latency number stops meaning
 * anything.
 */
export function meanLunaTransportLatencyMs(diagnostics: CoachObserverDiagnostics): number {
  const samples = diagnostics.latencySamplesMs;
  if (samples.length === 0) return 0;
  let total = 0;
  for (const sample of samples) total += sample;
  return total / samples.length;
}

/**
 * §37. The ratio the contract calls out: shown ÷ proposed.
 *
 * `null` when nothing has been proposed, because `0/0` is not "the rail is
 * quiet" — it is "no take has happened".
 */
export function tipDisplayRatio(diagnostics: CoachDiagnostics): number | null {
  if (diagnostics.tipsProposed === 0) return null;
  return diagnostics.tipsShown / diagnostics.tipsProposed;
}
