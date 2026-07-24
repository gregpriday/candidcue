/**
 * Layer B — local acoustic hesitation candidates (§16.2).
 *
 * This layer is deliberately the weakest of the three. §16.2: "a generic
 * sustained vowel is not automatically 'um'". So an acoustic candidate may
 * corroborate a lexical detection, request a precision chunk, or draw a hollow
 * marker — and nothing else. Its score is hard-capped at
 * {@link ACOUSTIC_ONLY_CONFIDENCE_CEILING} at the single place it is produced,
 * so no downstream arithmetic can accidentally let audio alone drive a
 * high-severity critique.
 *
 * Everything here is frame-driven off `AudioFrameFeatures.audioTimeMs`: the
 * detector has no clock of its own and never reads wall time (contract Rule 3).
 */
import type { AudioFrameFeatures, SpeechInterval } from '../../contracts/coaching';
import type { AcousticHesitationCandidate } from './types';
import { ACOUSTIC_ONLY_CONFIDENCE_CEILING } from './types';

export interface AcousticCandidateOptions {
  /** Frame duration used when the stream has a gap, ms. */
  frameDurationMs?: number;
  /** A hesitation vowel is longer than a syllable and shorter than a word run. */
  minDurationMs?: number;
  maxDurationMs?: number;
  /** Maximum pitch standard deviation across the run, semitones. */
  maxPitchStabilitySemitones?: number;
  /** Maximum mean spectral flux relative to the recent speech median. */
  maxSpectralMovementRatio?: number;
  /** Minimum SNR for the region to be measurable at all, dB. */
  minSnrDb?: number;
  /** Silence needed on at least one side for the run to read as hesitation, ms. */
  minAdjacentPauseMs?: number;
  /** Minimum score to emit. */
  minScore?: number;
  /** How long candidates stay available to `hasHesitation`, ms. */
  retentionMs?: number;
}

const DEFAULTS: Required<AcousticCandidateOptions> = {
  frameDurationMs: 20,
  minDurationMs: 150,
  maxDurationMs: 900,
  maxPitchStabilitySemitones: 1,
  maxSpectralMovementRatio: 0.7,
  minSnrDb: 6,
  minAdjacentPauseMs: 120,
  minScore: 0.4,
  retentionMs: 120_000,
};

const VOICED_SPEECH_PROBABILITY = 0.5;
const VOICED_PROBABILITY = 0.5;
const F0_CONFIDENCE = 0.5;

interface VoicedRun {
  startMs: number;
  endMs: number;
  f0Values: number[];
  fluxValues: number[];
  snrValues: number[];
  dropout: boolean;
  leadingPauseMs: number;
}

export class AcousticCandidateDetector {
  private readonly options: Required<AcousticCandidateOptions>;
  private run: VoicedRun | null = null;
  /** Finalized but not yet emitted: waiting to learn its trailing pause. */
  private pending: VoicedRun | null = null;
  private lastVoicedEndMs: number | null = null;
  private lastFrameTimeMs: number | null = null;
  private fluxHistory: number[] = [];
  private lexicalProgressMs: number[] = [];
  private drained: AcousticHesitationCandidate[] = [];
  private recent: AcousticHesitationCandidate[] = [];
  private speechStarts: number[] = [];
  private sequence = 0;

  constructor(options: AcousticCandidateOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  reset(): void {
    this.run = null;
    this.pending = null;
    this.lastVoicedEndMs = null;
    this.lastFrameTimeMs = null;
    this.fluxHistory = [];
    this.lexicalProgressMs = [];
    this.drained = [];
    this.recent = [];
    this.speechStarts = [];
  }

  /** §12.5. Speech-run boundaries double as sentence boundaries for §16.4. */
  observeSpeechInterval(interval: SpeechInterval): void {
    this.speechStarts.push(interval.startMs);
    const cutoff = interval.endMs - this.options.retentionMs;
    this.speechStarts = this.speechStarts.filter((startMs) => startMs >= cutoff);
  }

  /**
   * §16.2 "low lexical progress despite continued voicing" — the caller notes
   * the audio time of each finalized token so a long voiced run that produced
   * no words scores higher than one that produced three.
   */
  noteLexicalProgress(audioTimeMs: number): void {
    this.lexicalProgressMs.push(audioTimeMs);
    const cutoff = audioTimeMs - this.options.retentionMs;
    this.lexicalProgressMs = this.lexicalProgressMs.filter((time) => time >= cutoff);
  }

  pushFrame(frame: AudioFrameFeatures): void {
    const frameMs = this.frameDurationFor(frame);
    const frameEndMs = frame.audioTimeMs + frameMs;
    this.lastFrameTimeMs = frame.audioTimeMs;

    const voiced =
      frame.speechProbability >= VOICED_SPEECH_PROBABILITY &&
      frame.voicedProbability >= VOICED_PROBABILITY;

    if (voiced) {
      if (!this.run) {
        // A new voiced run starts: the previous pending run now knows how much
        // silence followed it and can be judged.
        this.finalizePending(frame.audioTimeMs);
        this.run = {
          startMs: frame.audioTimeMs,
          endMs: frameEndMs,
          f0Values: [],
          fluxValues: [],
          snrValues: [],
          dropout: false,
          leadingPauseMs:
            this.lastVoicedEndMs === null ? Number.POSITIVE_INFINITY : frame.audioTimeMs - this.lastVoicedEndMs,
        };
      }
      const run = this.run;
      run.endMs = frameEndMs;
      if (frame.f0Hz !== null && frame.f0Confidence >= F0_CONFIDENCE) run.f0Values.push(frame.f0Hz);
      run.fluxValues.push(frame.spectralFlux);
      run.snrValues.push(frame.estimatedSnrDb);
      if (frame.processorDropout) run.dropout = true;
      this.fluxHistory.push(frame.spectralFlux);
      if (this.fluxHistory.length > 500) this.fluxHistory.shift();
      return;
    }

    if (this.run) {
      this.lastVoicedEndMs = this.run.endMs;
      // Only one run can wait at a time; an unjudged older one is discarded
      // rather than accumulated (this buffer is bounded by construction).
      this.finalizePending(this.run.startMs);
      this.pending = this.run;
      this.run = null;
    }
  }

  /**
   * Close out any run still waiting for its trailing pause — call at take end
   * or when the VAD reports a long silence.
   */
  flush(atAudioMs: number): void {
    if (this.run) {
      this.lastVoicedEndMs = this.run.endMs;
      this.finalizePending(this.run.startMs);
      this.pending = this.run;
      this.run = null;
    }
    this.finalizePending(atAudioMs);
  }

  /** Candidates detected since the last drain. */
  drainCandidates(): AcousticHesitationCandidate[] {
    const out = this.drained;
    this.drained = [];
    return out;
  }

  /** §16.2 corroboration lookup used by the tracker and the classifier. */
  hasHesitation(startMs: number, endMs: number): boolean {
    return this.recent.some(
      (candidate) => candidate.startMs < endMs && candidate.endMs > startMs,
    );
  }

  /** The overlapping hesitation region, for §16.3.4 timing snap. */
  hesitationRegion(startMs: number, endMs: number): { startMs: number; endMs: number } | null {
    const hit = this.recent.find(
      (candidate) => candidate.startMs < endMs && candidate.endMs > startMs,
    );
    return hit ? { startMs: hit.startMs, endMs: hit.endMs } : null;
  }

  /** Speech-run starts inside a window, for acoustic sentence segmentation. */
  boundaryStartsMs(startMs: number, endMs: number): readonly number[] {
    return this.speechStarts.filter((time) => time >= startMs && time <= endMs);
  }

  /** All retained candidates, oldest first. */
  retainedCandidates(): readonly AcousticHesitationCandidate[] {
    return this.recent;
  }

  /* ----------------------------------------------------------------------- */

  private frameDurationFor(frame: AudioFrameFeatures): number {
    if (this.lastFrameTimeMs === null) return this.options.frameDurationMs;
    const delta = frame.audioTimeMs - this.lastFrameTimeMs;
    return delta > 0 && delta <= this.options.frameDurationMs * 4 ? delta : this.options.frameDurationMs;
  }

  private finalizePending(nextVoicedStartMs: number): void {
    const run = this.pending;
    if (!run) return;
    this.pending = null;
    const trailingPauseMs = Math.max(0, nextVoicedStartMs - run.endMs);
    const candidate = this.evaluate(run, trailingPauseMs);
    if (!candidate) return;
    this.drained.push(candidate);
    this.recent.push(candidate);
    const cutoff = candidate.endMs - this.options.retentionMs;
    this.recent = this.recent.filter((entry) => entry.endMs >= cutoff);
  }

  private evaluate(run: VoicedRun, trailingPauseMs: number): AcousticHesitationCandidate | null {
    const durationMs = run.endMs - run.startMs;
    if (run.dropout) return null; // §12.4: a dropout is unmeasured, not silence.
    if (durationMs < this.options.minDurationMs || durationMs > this.options.maxDurationMs) return null;

    const meanSnrDb = mean(run.snrValues);
    if (meanSnrDb < this.options.minSnrDb) return null;

    const leadingPauseMs = Number.isFinite(run.leadingPauseMs) ? run.leadingPauseMs : this.options.minAdjacentPauseMs;
    if (
      leadingPauseMs < this.options.minAdjacentPauseMs &&
      trailingPauseMs < this.options.minAdjacentPauseMs
    ) {
      return null;
    }

    const pitchStabilitySemitones = pitchStability(run.f0Values);
    if (pitchStabilitySemitones === null) return null;
    if (pitchStabilitySemitones > this.options.maxPitchStabilitySemitones) return null;

    const medianFlux = median(this.fluxHistory);
    const spectralMovementRatio = medianFlux === 0 ? 1 : mean(run.fluxValues) / medianFlux;
    if (spectralMovementRatio > this.options.maxSpectralMovementRatio) return null;

    const lowLexicalProgress = !this.lexicalProgressMs.some(
      (time) => time >= run.startMs && time <= run.endMs,
    );

    // Score: conservative base, small additive evidence, hard ceiling. The
    // base alone is below `minScore`, so at least two corroborating features
    // are always required — one flat vowel is not a filler (§16.2).
    let score = 0.25;
    if (pitchStabilitySemitones <= this.options.maxPitchStabilitySemitones / 2) score += 0.1;
    if (spectralMovementRatio <= this.options.maxSpectralMovementRatio / 2) score += 0.1;
    if (leadingPauseMs >= this.options.minAdjacentPauseMs && trailingPauseMs >= this.options.minAdjacentPauseMs) {
      score += 0.1;
    }
    if (lowLexicalProgress) score += 0.15;
    score = Math.min(ACOUSTIC_ONLY_CONFIDENCE_CEILING, score);
    if (score < this.options.minScore) return null;

    this.sequence += 1;
    return {
      candidateId: `ac_${run.startMs}_${this.sequence}`,
      startMs: run.startMs,
      endMs: run.endMs,
      score,
      features: {
        durationMs,
        pitchStabilitySemitones,
        spectralMovementRatio,
        meanSnrDb,
        leadingPauseMs: Number.isFinite(run.leadingPauseMs) ? run.leadingPauseMs : 0,
        trailingPauseMs,
        lowLexicalProgress,
      },
    };
  }
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  return (((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2);
}

/**
 * §13.3. Pitch movement is only meaningful speaker-relative, so stability is
 * the standard deviation of semitone offsets from the run's own median —
 * never an absolute Hz spread, which would call a low voice "stable" and a
 * high voice "moving" for the same physical gesture.
 */
function pitchStability(f0Values: readonly number[]): number | null {
  const usable = f0Values.filter((value) => value > 0);
  // Fewer than five reliable frames is not a pitch measurement.
  if (usable.length < 5) return null;
  const reference = median(usable);
  if (reference <= 0) return null;
  const semitones = usable.map((value) => 12 * Math.log2(value / reference));
  const centre = mean(semitones);
  const variance = mean(semitones.map((value) => (value - centre) ** 2));
  return Math.sqrt(variance);
}
