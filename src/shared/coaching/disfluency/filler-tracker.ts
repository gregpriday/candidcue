/**
 * The disfluency pipeline's event store and confidence ladder (§16.5, §27.3).
 *
 * Layer A proposes; this module decides. It holds every detection for the
 * current take pass and is the only place `confidence` changes.
 *
 * **probable → confirmed** requires all three of §16.5, and nothing else:
 *
 * 1. a **final** transcript — Realtime or precision — contains the event;
 * 2. contextual classification passes (trivial for `um`, the full §16.4 gate
 *    for `like`, local hesitation evidence for `hmm`/`mm`/`ah` per §15.1);
 * 3. timing is credible ({@link hasCredibleTiming}).
 *
 * Local audio is deliberately **not** a fourth requirement. It supplies term 2
 * for the conditional strict forms and may veto term 3, but its absence never
 * blocks a confirmation: a rail that reads "FILLERS 0" through a take full of
 * them because the audio worklet never started is a silent lie, which is worse
 * than a visibly degraded tile.
 *
 * **probable/confirmed → rejected** when a precision transcript covering the
 * same audio does not contain the form, or when Luna rejects it.
 *
 * `countedLive` is set at *publish* time, not at confirmation time, and never
 * cleared. That is what makes a later demotion honest: the total the presenter
 * reads corrects downward, while the record still says "this one was on the
 * glass". Rewriting history instead would make the post-take report disagree
 * with what the presenter actually saw during the take.
 *
 * No clock is read here. Every window is measured against an audio time the
 * caller supplies.
 */
import type {
  CoachCandidate,
  FillerDisplayState,
  FillerEvent,
  SpeechInterval,
} from '../../contracts/coaching';
import { AcousticCandidateDetector } from './acoustic-candidate-detector';
import { CONTEXTUAL_CONFIRM_CONFIDENCE } from './contextual-classifier';
import {
  DEFAULT_FILLER_CANDIDATE_CONFIG,
  generateFillerCandidates,
  type FillerCandidateConfig,
} from './filler-candidates';
import { createFillerLexicon, type FillerLexicon, type FillerLexiconOptions } from './filler-lexicon';
import {
  RealtimeFillerDetector,
  type AcousticEvidenceLookup,
  type OpenerObservation,
} from './realtime-filler-detector';
import { reconcilePrecisionResult } from './transcript-reconciler';
import type {
  AcousticHesitationCandidate,
  AuthoredSpanContext,
  FillerDetection,
  PrecisionTranscriptResult,
  ProvisionalFillerHint,
  RealtimeTranscriptItem,
  ReconciliationOutcome,
  TakeIdentity,
  TimingEvidence,
} from './types';
import { hasCredibleTiming, isCountableFiller } from './types';
import type { UtteranceToken } from './utterance';

export interface FillerTrackerOptions {
  take: TakeIdentity;
  takeStartAudioMs?: number;
  lexicon?: FillerLexicon;
  lexiconOptions?: FillerLexiconOptions;
  acoustics?: AcousticEvidenceLookup;
  candidateConfig?: Partial<FillerCandidateConfig>;
  /** §12.6 / §30: precision transcription available. Drives `degraded`. */
  precisionEnabled?: boolean;
  /** How long detections and intervals are retained, ms. */
  retentionMs?: number;
  /** Fraction of a detection a speech interval must cover to corroborate it. */
  speechCoverageRatio?: number;
}

const DEFAULT_RETENTION_MS = 180_000;
/** Hard cap on retained detections; a take pass never legitimately exceeds it. */
const MAX_RETAINED_DETECTIONS = 2_000;

export class FillerTracker {
  private readonly lexicon: FillerLexicon;
  private readonly detector: RealtimeFillerDetector;
  private readonly candidateConfig: FillerCandidateConfig;
  private readonly retentionMs: number;
  private readonly speechCoverageRatio: number;
  private acoustics: AcousticEvidenceLookup;

  private take: TakeIdentity;
  private takeStartAudioMs: number;
  private precisionEnabled: boolean;
  private transcriptionDegraded = false;

  private detections = new Map<string, FillerDetection>();
  private openers: OpenerObservation[] = [];
  private speechIntervals: SpeechInterval[] = [];
  /**
   * Audio time the local VAD has reported through, or `null` when no local
   * audio has arrived at all. See {@link hasCredibleTiming}.
   */
  private vadObservedUpToMs: number | null = null;
  private recentTokens: UtteranceToken[] = [];
  private positiveStreakEmitted = false;
  private hadFillersEarlier = false;
  /**
   * §26.5. Events this tracker stopped believing since the last drain.
   *
   * Every demotion path writes here — the late-VAD timing reassessment, a
   * precision transcript that revised the event away, and a Luna rejection —
   * so a caller has one place to ask "what changed?" rather than three.
   * Without it the correction was visible on the tile (the count drops) but
   * invisible to the policy, and a tip built on the demoted event stayed up.
   */
  private revisedEventIds = new Set<string>();

  constructor(options: FillerTrackerOptions) {
    this.lexicon = options.lexicon ?? createFillerLexicon(options.lexiconOptions ?? {});
    this.acoustics = options.acoustics ?? new AcousticCandidateDetector();
    this.detector = new RealtimeFillerDetector({
      lexicon: this.lexicon,
      acoustics: this.acoustics,
    });
    this.candidateConfig = { ...DEFAULT_FILLER_CANDIDATE_CONFIG, ...(options.candidateConfig ?? {}) };
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.speechCoverageRatio = options.speechCoverageRatio ?? 0.6;
    this.take = options.take;
    this.takeStartAudioMs = options.takeStartAudioMs ?? 0;
    this.precisionEnabled = options.precisionEnabled ?? false;
  }

  /** A new take pass or a new tracking epoch invalidates everything held. */
  setTake(take: TakeIdentity, takeStartAudioMs: number): void {
    this.take = take;
    this.takeStartAudioMs = takeStartAudioMs;
    this.detections.clear();
    this.openers = [];
    this.speechIntervals = [];
    this.vadObservedUpToMs = null;
    this.recentTokens = [];
    this.positiveStreakEmitted = false;
    this.hadFillersEarlier = false;
    this.revisedEventIds.clear();
    this.detector.reset();
  }

  setPrecisionEnabled(enabled: boolean): void {
    this.precisionEnabled = enabled;
  }

  /** §25.1: the Realtime transcription path itself is struggling. */
  setTranscriptionDegraded(degraded: boolean): void {
    this.transcriptionDegraded = degraded;
  }

  setAcoustics(acoustics: AcousticEvidenceLookup): void {
    this.acoustics = acoustics;
    this.detector.setAcoustics(acoustics);
  }

  /* --------------------------------------------------------------------- */

  observeProvisional(
    item: RealtimeTranscriptItem,
    authored: AuthoredSpanContext,
  ): ProvisionalFillerHint[] {
    return this.detector.observeProvisional(item, authored);
  }

  /** §16.1. Detect on a finalized item and store the resulting probables. */
  observeFinalTranscript(
    item: RealtimeTranscriptItem,
    authored: AuthoredSpanContext,
  ): FillerEvent[] {
    const result = this.detector.observeFinal(item, authored, this.take);
    this.recentTokens.push(...result.tokens);
    this.openers.push(...result.openers);
    const created: FillerEvent[] = [];
    for (const detection of result.detections) {
      const existing = this.detections.get(detection.event.eventId);
      if (existing) continue; // §29.2 identity: one event per utterance.
      this.detections.set(detection.event.eventId, detection);
      this.tryPromote(detection);
      created.push(detection.event);
    }
    this.trim(item.audioEndMs);
    return created;
  }

  /**
   * §12.5. A closed speech run, and the local view §16.5's timing term is
   * judged against. Its role is to *veto* a filler the VAD says landed in
   * silence — not to license one. Once the VAD has reported through a region,
   * silence there is a real contradiction; before that, it has simply not
   * spoken yet (see {@link hasCredibleTiming}).
   */
  observeSpeechInterval(interval: SpeechInterval): void {
    if (interval.takePassId !== this.take.takePassId) return;
    this.speechIntervals.push(interval);
    this.vadObservedUpToMs = Math.max(this.vadObservedUpToMs ?? interval.endMs, interval.endMs);
    this.reassessTiming();
    for (const detection of this.detections.values()) this.tryPromote(detection);
    this.trim(interval.endMs);
  }

  /**
   * §12.5 / §16.5 conjunct 3. The VAD has processed local audio through
   * `audioTimeMs`, whether or not a run closed there.
   *
   * `observeSpeechInterval` advances the same watermark, but only ever to the
   * *end of a closed run* — and a run closes on a silence gap. So the region
   * the VAD had already scanned and found silent read as "the VAD has not got
   * here yet", and {@link hasCredibleTiming} took its permissive branch across
   * exactly the audio where it should have been strictest.
   *
   * That matters because of where hallucinated fillers come from: a
   * transcription model invents an "um" during *silence*, and a Realtime commit
   * carries roughly 420 ms of endpoint tail past the last speech. Both land in
   * the window this heartbeat closes. Without it the event was permissively
   * confirmed, the tile counted it, and the *next* interval close demoted it —
   * so the presenter watched the number tick up and then back down.
   *
   * The VAD runs 20 ms frames and is always ahead of a commit, so a caller
   * folding local audio in should call this as it goes; the permissive branch
   * then means what it was documented to mean — "no local audio at all" —
   * rather than "no local audio since the last gap".
   */
  noteVadObservedThrough(audioTimeMs: number): void {
    if (this.vadObservedUpToMs !== null && audioTimeMs <= this.vadObservedUpToMs) return;
    this.vadObservedUpToMs = audioTimeMs;
    this.reassessTiming();
  }

  /** §16.2. A hesitation-like region; promotes the forms that need one. */
  observeAcousticCandidate(candidate: AcousticHesitationCandidate): void {
    for (const detection of this.detections.values()) {
      if (
        detection.event.audioStartMs < candidate.endMs &&
        detection.event.audioEndMs > candidate.startMs
      ) {
        this.tryPromote(detection);
      }
    }
  }

  /**
   * §16.3.4. Apply a delayed verbatim result. The result is mapped back onto
   * the audio interval it describes; nothing here is stamped with the moment
   * it arrived.
   */
  applyPrecisionResult(
    result: PrecisionTranscriptResult,
    authored: AuthoredSpanContext,
  ): ReconciliationOutcome {
    const empty: ReconciliationOutcome = {
      created: [],
      promoted: [],
      demoted: [],
      deduplicated: [],
      corroborated: [],
    };
    // §23.1: evidence from another take pass or epoch describes a different
    // performance and must be discarded, however good it is.
    if (result.takePassId !== this.take.takePassId) return empty;
    if (result.trackingEpoch !== this.take.trackingEpoch) return empty;

    const outcome = reconcilePrecisionResult({
      result,
      realtimeTokens: this.recentTokens,
      existing: [...this.detections.values()],
      authored,
      take: this.take,
      lexicon: this.lexicon,
      acoustics: this.acoustics,
    });

    for (const detection of outcome.created) {
      if (this.detections.has(detection.event.eventId)) continue;
      // The reconciler establishes conjuncts 1 and 2 (a verbatim final
      // transcript, plus the §16.4 gate for contextual tokens). Conjunct 3 is
      // the tracker's to check, because only it holds the VAD view.
      if (!hasCredibleTiming(detection.event, this.timingEvidence())) {
        detection.event.confidence = 'probable';
      }
      this.detections.set(detection.event.eventId, detection);
    }
    for (const eventId of outcome.promoted) {
      this.applyConfidence(eventId, 'confirmed', 'precision_transcript');
    }
    for (const eventId of outcome.demoted) {
      this.applyConfidence(eventId, 'rejected', 'precision_transcript');
      this.revisedEventIds.add(eventId);
    }
    for (const eventId of [...outcome.deduplicated, ...outcome.corroborated]) {
      this.addEvidenceSource(eventId, 'precision_transcript');
    }
    return outcome;
  }

  /**
   * §23. Luna may only classify what the local layer already proposed. It can
   * confirm or reject a contextual classification; it can never invent an
   * event, which is why this takes an existing id and nothing else.
   */
  applyLunaVerdict(eventId: string, verdict: 'confirmed' | 'rejected'): boolean {
    if (!this.detections.has(eventId)) return false;
    this.applyConfidence(eventId, verdict, 'luna');
    if (verdict === 'rejected') this.revisedEventIds.add(eventId);
    return true;
  }

  /**
   * §26.5. Take the events demoted or rejected since the last call, and clear
   * the buffer.
   *
   * Drained rather than observed so the caller cannot miss one by subscribing
   * late, and so the tracker holds no callback into the coach layer — the
   * disfluency lane knows nothing about tips, and it stays that way.
   *
   * The intended wiring, in the integrator that owns both objects:
   *
   * ```ts
   * for (const eventId of tracker.drainRevisedEventIds()) {
   *   for (const evidenceId of registry.invalidateByContributingEvent(eventId, 'demoted_to_probable')) {
   *     policy.cancel('evidence_revised', { evidenceId });
   *   }
   *   policy.cancel('evidence_revised', { evidenceId: eventId });
   * }
   * ```
   *
   * The second `cancel` covers a tip already on the glass whose candidate the
   * registry has since pruned: the policy also matches against the tip's own
   * `contributingEventIds`.
   */
  drainRevisedEventIds(): string[] {
    const ids = [...this.revisedEventIds];
    this.revisedEventIds.clear();
    return ids;
  }

  /* --------------------------------------------------------------------- */

  /** §27.3. Publishes the tile state and records what the presenter saw. */
  publishDisplayState(nowAudioMs: number): FillerDisplayState {
    const state = this.peekDisplayState(nowAudioMs);
    for (const detection of this.detections.values()) {
      if (isCountableFiller(detection.event)) {
        detection.event.countedLive = true;
        this.hadFillersEarlier = true;
      }
    }
    return state;
  }

  /** The same state without the `countedLive` side effect. */
  peekDisplayState(nowAudioMs: number): FillerDisplayState {
    const countable = [...this.detections.values()].filter((detection) =>
      isCountableFiller(detection.event),
    );
    const strictForms = new Map<string, number>();
    for (const detection of countable) {
      if (detection.event.kind !== 'strict_vocalized') continue;
      strictForms.set(detection.canonicalForm, (strictForms.get(detection.canonicalForm) ?? 0) + 1);
    }
    let dominantForm: string | null = null;
    let dominantCount = 0;
    for (const [form, count] of strictForms) {
      if (count > dominantCount) {
        dominantCount = count;
        dominantForm = this.lexicon.displayFormFor(form);
      }
    }

    return {
      confirmedCount: countable.length,
      confirmedLast20s: countable.filter(
        (detection) => detection.event.audioEndMs > nowAudioMs - 20_000,
      ).length,
      confirmedLast60s: countable.filter(
        (detection) => detection.event.audioEndMs > nowAudioMs - 60_000,
      ).length,
      dominantForm,
      degraded: !this.precisionEnabled || this.transcriptionDegraded,
    };
  }

  /** §16.7 pattern candidates for the scheduler. */
  candidates(nowAudioMs: number): CoachCandidate[] {
    const lastCountableFillerEndMs = this.lastCountableFillerEndMs();
    const produced = generateFillerCandidates({
      detections: [...this.detections.values()],
      openers: this.openers,
      nowAudioMs,
      take: this.take,
      lexicon: this.lexicon,
      config: this.candidateConfig,
      lastCountableFillerEndMs,
      takeStartAudioMs: this.takeStartAudioMs,
      hadFillersEarlier: this.hadFillersEarlier,
    });

    // §16.8: the positive streak may appear at most once per stretch of clean
    // delivery; a new filler re-arms it.
    return produced.filter((candidate) => {
      if (candidate.type !== 'positive_filler_streak') return true;
      if (this.positiveStreakEmitted) return false;
      this.positiveStreakEmitted = true;
      return true;
    });
  }

  /* --------------------------------------------------------------------- */

  events(): FillerEvent[] {
    return [...this.detections.values()]
      .map((detection) => detection.event)
      .sort((a, b) => a.audioStartMs - b.audioStartMs);
  }

  detectionList(): FillerDetection[] {
    return [...this.detections.values()];
  }

  openerObservations(): readonly OpenerObservation[] {
    return this.openers;
  }

  /* --------------------------------------------------------------------- */

  /**
   * §16.5 conjunct 3 is re-checked when local audio arrives late.
   *
   * Without this the ladder would depend on *arrival order*: a transcript that
   * beat the VAD would confirm on the permissive branch and stay confirmed
   * even once the VAD reported silence across the same interval, while the
   * identical evidence in the opposite order would not. The event drops back
   * to `probable` — not `rejected`, because a timing contradiction is not the
   * §16.5 claim that a legitimate word was spoken — so the count corrects
   * while `countedLive` still records what the presenter saw.
   *
   * A precision transcript or Luna outranks the local timing check.
   */
  private reassessTiming(): void {
    const evidence = this.timingEvidence();
    for (const detection of this.detections.values()) {
      const event = detection.event;
      if (event.confidence !== 'confirmed') continue;
      if (
        event.evidenceSources.includes('precision_transcript') ||
        event.evidenceSources.includes('luna')
      ) {
        continue;
      }
      if (hasCredibleTiming(event, evidence)) continue;
      event.confidence = 'probable';
      // §26.5: the count is about to correct downward. Anything the scheduler
      // built on this event must come down with it.
      this.revisedEventIds.add(event.eventId);
      // The veto is itself local-audio evidence about this event.
      this.addEvidenceSource(event.eventId, 'local_audio');
    }
  }

  /**
   * §16.5's three-part conjunction, evaluated in one place:
   *
   * 1. **final lexical evidence** — `detection.finalEvidence`;
   * 2. **contextual classification passes** — {@link classificationPasses};
   * 3. **timing is credible** — {@link hasCredibleTiming}.
   *
   * All three are required, and each is a separately named, separately
   * testable term. Local audio is *not* a fourth requirement: it supplies term
   * 2 for the conditional strict forms and can veto term 3, but its absence
   * never blocks a confirmation.
   */
  private tryPromote(detection: FillerDetection): void {
    const event = detection.event;
    if (event.confidence !== 'probable') return;
    // §15.3 / §2.4: an opener is a session pattern, never a filler. Excluded
    // here *and* by kind in `isCountableFiller`, so relaxing the promotion
    // rule cannot open a back door into the presenter's total.
    if (event.kind === 'repetitive_opener') return;
    if (!detection.finalEvidence) return;

    const classifiedBy = this.classificationPasses(detection);
    if (classifiedBy === null) return;
    if (!hasCredibleTiming(event, this.timingEvidence())) return;

    this.applyConfidence(event.eventId, 'confirmed', classifiedBy);
  }

  /**
   * §16.5 conjunct 2. Returns the evidence source that satisfied it, or `null`.
   *
   * The asymmetry here is the point (contract note on `FillerEvent`): an "um"
   * in a final transcript is settled by the lexicon, while a "like" has to get
   * past the §16.4 veto/structure/repetition gate first, which is where the
   * §2.4 work lives.
   */
  private classificationPasses(
    detection: FillerDetection,
  ): FillerEvent['evidenceSources'][number] | null {
    const event = detection.event;
    if (detection.requiresHesitationEvidence) {
      // §15.1: `hmm` / `mm` / `ah` are fillers only when used to hesitate, and
      // only local audio can say whether they were.
      return this.acoustics.hasHesitation(event.audioStartMs, event.audioEndMs)
        ? 'local_audio'
        : null;
    }
    if (event.kind === 'contextual') {
      return detection.contextScore >= CONTEXTUAL_CONFIRM_CONFIDENCE ? 'realtime' : null;
    }
    return 'realtime';
  }

  /**
   * The local-audio view §16.5's timing term is judged against. The VAD is the
   * timing authority (§12.5) *when it has spoken*; `vadObservedUpToMs` is what
   * distinguishes "the VAD reported silence here" from "the VAD has not
   * reached here yet".
   */
  private timingEvidence(): TimingEvidence {
    return {
      speechIntervals: this.speechIntervals,
      vadObservedUpToMs: this.vadObservedUpToMs,
      coverageRatio: this.speechCoverageRatio,
    };
  }

  private applyConfidence(
    eventId: string,
    confidence: 'confirmed' | 'rejected',
    source: FillerEvent['evidenceSources'][number],
  ): void {
    const detection = this.detections.get(eventId);
    if (!detection) return;
    detection.event.confidence = confidence;
    this.addEvidenceSource(eventId, source);
    if (confidence === 'confirmed' && isCountableFiller(detection.event)) {
      this.positiveStreakEmitted = false;
    }
  }

  private addEvidenceSource(
    eventId: string,
    source: FillerEvent['evidenceSources'][number],
  ): void {
    const detection = this.detections.get(eventId);
    if (!detection) return;
    if (!detection.event.evidenceSources.includes(source)) {
      detection.event.evidenceSources.push(source);
    }
  }

  private lastCountableFillerEndMs(): number | null {
    let latest: number | null = null;
    for (const detection of this.detections.values()) {
      if (!isCountableFiller(detection.event)) continue;
      if (latest === null || detection.event.audioEndMs > latest) latest = detection.event.audioEndMs;
    }
    return latest;
  }

  private trim(nowAudioMs: number): void {
    const cutoff = nowAudioMs - this.retentionMs;
    this.speechIntervals = this.speechIntervals.filter((interval) => interval.endMs >= cutoff);
    this.recentTokens = this.recentTokens.filter((token) => token.endMs >= cutoff);
    this.openers = this.openers.filter((opener) => opener.audioEndMs >= cutoff);
    // Detections are *not* trimmed by age: `confirmedCount` is a per-take-pass
    // total, and expiring events would quietly walk the presenter's number
    // backwards on a long take. They are bounded by count instead, and cleared
    // wholesale by `setTake`.
    if (this.detections.size > MAX_RETAINED_DETECTIONS) {
      const ordered = [...this.detections.entries()].sort(
        (a, b) => a[1].event.audioStartMs - b[1].event.audioStartMs,
      );
      for (const [eventId] of ordered.slice(0, this.detections.size - MAX_RETAINED_DETECTIONS)) {
        this.detections.delete(eventId);
      }
    }
  }
}
