/**
 * §12.2. The coaching integrator: the per-frame orchestrator that turns six
 * independently-built lanes into a working subsystem.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * Every lane below this one is built, documented and tested. Nothing drove
 * them. `FillerTracker.noteVadObservedThrough` had no caller, so the VAD veto
 * was inert; `drainRevisedEventIds` had no caller, so §26.5's demotion channel
 * was unreachable; `buildRibbonEvents` and `buildGutterMarks` had no consumer,
 * so the ribbon was permanently empty; `MicrophoneCandidateSource` had no
 * caller, so the highest-priority band in the subsystem could not be raised.
 * Each of those is the same shape of defect the contract's Rule 1a was written
 * about — a surface every author assumed someone else would call.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 * Rule 1: **coaching is advisory and can never move the script.** This module
 * imports nothing from `shared/tracking`, `shared/semantic`, a store, the DOM
 * or Tauri; its only outputs are a {@link CoachRailState} handed to an injected
 * sink and a {@link CoachDiagnostics} snapshot. There is no scroll offset,
 * cursor index, unit id, section id or navigation directive anywhere in it, and
 * there is no method that returns one.
 *
 * Rule 3: **the audio clock is the only clock.** Every decision here is stamped
 * from {@link AudioClock} or from a frame's own `audioTimeMs`. The single
 * wall-clock reader is used for §37 latency and cost only, exactly as §5.4
 * permits.
 *
 * ---------------------------------------------------------------------------
 * CADENCES (§12.2)
 * ---------------------------------------------------------------------------
 * - **analysis**, per 20 ms frame: VAD, microphone health, pitch, energy, the
 *   accounting clock, and the disfluency lane's VAD watermark;
 * - **aggregation**, every 100 ms: analyzers run, candidates are admitted,
 *   Luna is consulted, the policy is proposed to and ticked;
 * - **publication**, every 200 ms *or on a material state change*: one
 *   `CoachRailState` crosses to the stage.
 *
 * The schedule is injected so a test drives it deterministically, and the rail
 * is never published at frame rate.
 */
import {
  COACH_TIP_CATALOG,
  CANDIDATE_TIP_CODE,
} from '../coach/tip-catalog';
import {
  CoachRailStateBuilder,
  RIBBON_WINDOW_MS,
  initialFillerState,
  initialMicrophoneState,
  initialPaceState,
  initialVarietyState,
  resolveRailModules,
  type CoachRailInputs,
} from '../coach/coach-state';
import {
  LunaCoachObserver,
  shouldConsultLuna,
  type CoachDecisionSelection,
  type CoachLiveContext,
  type CoachRequestInput,
  type DecisionRejection,
} from '../coach/luna-observer';
import type { CoachPolicyContext, TipProposal } from '../coach/tip-policy';
import { buildGutterMarks } from '../coach/gutter-marks';
import {
  buildRibbonEvents,
  type RibbonClippingInput,
  type RibbonCriticalInput,
  type RibbonPauseInput,
  type RibbonRetakeInput,
} from '../coach/ribbon';
import type { ClosedSpeechInterval } from '../audio/vad';
import type { WorkletCoreDiagnostics } from '../audio/worklet-core';
import type {
  AuthoredSpanContext,
  PrecisionTranscriptResult,
  RealtimeTranscriptItem,
  TakeIdentity,
} from '../disfluency/types';
import { compareSpanFidelity } from '../fidelity/comparator';
import type { FidelitySpanObservation } from '../fidelity/comparator';
import { observeParaphrase } from '../fidelity/paraphrase';
import type { CoachClockContext } from '../pace/speech-clock';
import type { SpokenSegment } from '../pace/token-timing';
import type { PaceAnalyzerResult } from '../pace/pace-analyzer';
import type {
  BoundaryEvent,
  CadenceMetrics,
  PauseEvent,
} from '../prosody/cadence-analyzer';
import type { VarietyAnalyzerResult } from '../prosody/variety-score';
import type {
  AudioFrameFeatures,
  CoachCandidate,
  CoachDiagnostics,
  CoachGutterMark,
  CoachRailMode,
  CoachRailModules,
  CoachRailState,
  CoachRibbonEvent,
  CoachRibbonEventType,
  FillerDisplayState,
  MicrophoneCoachState,
  PaceDisplayState,
  SpeechInterval,
  VarietyDisplayState,
} from '../../contracts/coaching';
import { LaneGuard } from './lane-guard';
import { createCoachingLanes, type CoachingLanes } from './lanes';
import {
  DEFAULT_COACHING_SCHEDULE,
  liveStateFrom,
  lunaProfileFrom,
  railModulesFromSettings,
  type CoachingHostState,
  type CoachingOrchestratorDeps,
  type CoachingSchedule,
  type CoachingTelemetry,
} from './types';

/** Wall clock for §37 only. Falls back to a constant so node tests are pure. */
function defaultWallClockMs(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof perf?.now === 'function' ? perf.now() : 0;
}

const EMPTY_CADENCE_METRICS: CadenceMetrics = {
  runOnCount: 0,
  choppyPauseCount: 0,
  cadenceBalance: null,
  longestBreathGroupMs: 0,
  eligibleBoundaries: 0,
  shapedBoundaries: 0,
};

/** Bound on the in-flight latency map. A take never legitimately exceeds it. */
const MAX_TRACKED_REQUESTS = 64;

/** §20.4 bound on the accumulated speech context sent to Luna. */
const MAX_FINAL_TEXT_CHARS = 4_000;

export class CoachingOrchestrator {
  private readonly deps: CoachingOrchestratorDeps;
  private readonly schedule: CoachingSchedule;
  private readonly guard: LaneGuard;
  private readonly lanes: CoachingLanes;
  private readonly railBuilder: CoachRailStateBuilder;
  private readonly observer: LunaCoachObserver | null;
  private readonly wallClockMs: () => number;

  private host: CoachingHostState;

  /** Audio-clock now: the later of the injected clock and the newest frame end. */
  private nowMs = 0;
  private lastAggregationMs: number | null = null;
  private lastPublicationMs: number | null = null;
  private lastSignature = '';
  private aggregationPasses = 0;
  private publications = 0;
  private lastRail: CoachRailState | null = null;

  /** Candidates produced between aggregation passes, awaiting admission. */
  private pendingCandidates: CoachCandidate[] = [];
  /** Evidence already offered to the policy, so a candidate is proposed once. */
  private readonly proposedEvidenceIds = new Set<string>();

  /** Ribbon sources, pruned to the §44.4 window at each publication. */
  private closedIntervals: SpeechInterval[] = [];
  private ribbonPauses: RibbonPauseInput[] = [];
  private retakes: RibbonRetakeInput[] = [];
  private criticalMismatches: RibbonCriticalInput[] = [];
  private clippingEpisodes: RibbonClippingInput[] = [];
  private openClippingStartMs: number | null = null;
  private anchoredMarks: Array<{
    scriptAnchorTokenId: string;
    type: CoachRibbonEventType;
    takePassId: string;
  }> = [];

  /** Cached lane outputs, so telemetry and publication agree on one pass. */
  private lastPace: PaceDisplayState;
  private lastPaceResult: PaceAnalyzerResult | null = null;
  private lastVariety: VarietyDisplayState;
  private lastVarietyResult: VarietyAnalyzerResult | null = null;
  private lastFillers: FillerDisplayState = initialFillerState();
  private lastMicrophone: MicrophoneCoachState = initialMicrophoneState();
  private lastCadence: CadenceMetrics = EMPTY_CADENCE_METRICS;

  /** §22 speech context, accumulated from finalized transcript items. */
  private finalText = '';
  private provisionalTail = '';
  private finalAudioStartMs = 0;
  private finalAudioEndMs = 0;

  /** §37. Wall time a request was stamped, keyed by its audio-clock stamp. */
  private readonly requestWallMs = new Map<number, number>();
  /** §20.3. The candidate set the last Luna observation was queued for. */
  private lastObservedSignature = '';

  /** True while the VAD reports an open run, for cadence onset/offset edges. */
  private speaking = false;

  constructor(deps: CoachingOrchestratorDeps) {
    this.deps = deps;
    this.schedule = { ...DEFAULT_COACHING_SCHEDULE, ...deps.schedule };
    this.host = deps.host;
    this.wallClockMs = deps.wallClockMs ?? defaultWallClockMs;
    this.guard = new LaneGuard({
      ...(deps.laneFailureLimit === undefined ? {} : { failureLimit: deps.laneFailureLimit }),
      ...(deps.onLaneFailure === undefined ? {} : { onFailure: deps.onLaneFailure }),
    });
    this.nowMs = deps.audioClock.nowMs();
    this.lanes = createCoachingLanes({
      settings: deps.settings,
      take: this.takeIdentity(),
      takeStartAudioMs: this.nowMs,
      targetDurationMs: this.effectiveTargetDurationMs(),
      frameMs: this.schedule.frameMs,
      ...(deps.lanes === undefined ? {} : { overrides: deps.lanes }),
    });
    this.railBuilder = new CoachRailStateBuilder(deps.sessionId);
    this.lastPace = initialPaceState(deps.settings.targetWpmLow, deps.settings.targetWpmHigh);
    this.lastVariety = initialVarietyState(
      deps.settings.targetVarietyLow,
      deps.settings.targetVarietyHigh,
    );
    this.lanes.clock.start(this.nowMs);
    // §18.5. The gate defaults shut; whatever the host already believes is
    // pushed in immediately rather than waiting for the first boundary.
    this.lanes.cadence.setAlignmentConfidence(this.host.alignmentConfidence);
    this.observer = this.createObserver();
  }

  /* ---------------------------------------------------------------------- */
  /* Identity and host state                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * §14.10. The script's authored target duration.
   *
   * The host's value wins when it has one — a per-script target is more
   * specific than the user's global default — and `CoachingSettings` carries
   * the default in *seconds*, so the conversion happens once, here.
   */
  private effectiveTargetDurationMs(): number | null {
    if (this.host.targetDurationMs !== null) return this.host.targetDurationMs;
    const seconds = this.deps.settings.targetDurationSeconds;
    return seconds === null ? null : seconds * 1_000;
  }

  private takeIdentity(): TakeIdentity {
    return { takePassId: this.host.takePassId, trackingEpoch: this.host.trackingEpoch };
  }

  /** The evidence-stamping context every analyzer takes (§5.4). */
  private clockContext(audioTimeMs: number): CoachClockContext {
    return {
      audioTimeMs,
      trackingEpoch: this.host.trackingEpoch,
      takePassId: this.host.takePassId,
      commitSequence: this.host.commitSequence,
    };
  }

  /**
   * Push host state.
   *
   * An epoch change is a re-established position: §20.5/§26.5 require queued
   * observations to be dropped, in-flight answers disowned, and held tips
   * cancelled, because evidence taken before it describes a different
   * performance.
   */
  setHostState(patch: Partial<CoachingHostState>): void {
    const previousEpoch = this.host.trackingEpoch;
    const previousTarget = this.host.targetDurationMs;
    this.host = { ...this.host, ...patch };

    if (patch.alignmentConfidence !== undefined) {
      // §18.5 item: without this call the choppy pattern can never fire.
      this.guard.runVoid('cadence', 'alignment', this.nowMs, () =>
        this.lanes.cadence.setAlignmentConfidence(this.host.alignmentConfidence),
      );
    }
    if (patch.targetDurationMs !== undefined && patch.targetDurationMs !== previousTarget) {
      this.guard.runVoid('pace', 'target-duration', this.nowMs, () =>
        this.lanes.pace.setTargetDurationMs(this.effectiveTargetDurationMs()),
      );
    }
    if (patch.trackingEpoch !== undefined && patch.trackingEpoch !== previousEpoch) {
      this.handleEpochChange();
    }
  }

  hostState(): Readonly<CoachingHostState> {
    return this.host;
  }

  private handleEpochChange(): void {
    this.observer?.cancelAll();
    this.guard.runVoid('coach', 'epoch', this.nowMs, () => {
      // No cancellation reason names an epoch change; `take_ended` is the only
      // total one, and total is what §20.5 asks for.
      this.lanes.policy.cancel('take_ended');
      this.lanes.registry.reset();
    });
    this.proposedEvidenceIds.clear();
    this.pendingCandidates = [];
    this.lastObservedSignature = '';
    // The disfluency lane's own contract: "A new take pass or a new tracking
    // epoch invalidates everything held."
    this.guard.runVoid('disfluency', 'epoch', this.nowMs, () =>
      this.lanes.fillers.setTake(this.takeIdentity(), this.nowMs),
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Take lifecycle                                                          */
  /* ---------------------------------------------------------------------- */

  /** §11.3. Start a new take pass. Nothing crosses the boundary. */
  beginTakePass(takePassId: string, atAudioMs: number): void {
    this.advanceTo(atAudioMs);
    const previous = this.guard.run(
      'audio',
      'take-pass',
      atAudioMs,
      () => this.lanes.vad.setTakePass(takePassId),
      () => null,
    );
    if (previous !== null) this.foldClosedInterval(previous);

    this.host = { ...this.host, takePassId };
    this.guard.resetForTakePass();

    const now = this.nowMs;
    const lanes = this.lanes;
    this.guard.runVoid('coach', 'take-pass', now, () => {
      lanes.policy.cancel('take_ended');
      lanes.policy.reset();
      lanes.registry.reset();
    });
    this.guard.runVoid('pace', 'take-pass', now, () => {
      lanes.clock.start(now);
      lanes.pace.resetForDiscontinuity();
    });
    this.guard.runVoid('prosody', 'take-pass', now, () => {
      lanes.pitch.reset();
      lanes.energy.reset();
      lanes.variety.reset();
    });
    this.guard.runVoid('cadence', 'take-pass', now, () => {
      lanes.cadence.reset();
      lanes.cadence.setAlignmentConfidence(this.host.alignmentConfidence);
    });
    this.guard.runVoid('audio', 'take-pass', now, () => {
      lanes.microphone.reset();
      lanes.micCandidates.reset();
      lanes.pitchTracker.reset();
      lanes.pauses.reset();
    });
    this.guard.runVoid('disfluency', 'take-pass', now, () =>
      lanes.fillers.setTake(this.takeIdentity(), now),
    );
    this.observer?.cancelAll();

    this.pendingCandidates = [];
    this.proposedEvidenceIds.clear();
    this.closedIntervals = [];
    this.ribbonPauses = [];
    this.retakes = [];
    this.criticalMismatches = [];
    this.clippingEpisodes = [];
    this.openClippingStartMs = null;
    this.anchoredMarks = [];
    this.finalText = '';
    this.provisionalTail = '';
    this.lastObservedSignature = '';
    this.finalAudioStartMs = now;
    this.finalAudioEndMs = now;
    this.speaking = false;
    this.lastPace = initialPaceState(
      this.deps.settings.targetWpmLow,
      this.deps.settings.targetWpmHigh,
    );
    this.lastVariety = initialVarietyState(
      this.deps.settings.targetVarietyLow,
      this.deps.settings.targetVarietyHigh,
    );
    this.lastFillers = initialFillerState();
    this.lastCadence = EMPTY_CADENCE_METRICS;
    this.lastPaceResult = null;
    this.lastVarietyResult = null;
    this.aggregationPasses = 0;
    this.lastAggregationMs = null;
    this.lastPublicationMs = null;
    this.lastSignature = '';
  }

  /**
   * The take ended: close any open run, run one last aggregation so the final
   * seconds are measured, then clear the glass.
   */
  endTake(): void {
    const now = this.currentAudioTimeMs();
    const closed = this.guard.run(
      'audio',
      'end-take',
      now,
      () => this.lanes.vad.flush(),
      () => null,
    );
    if (closed !== null) this.foldClosedInterval(closed);
    this.aggregate(now);
    this.observer?.cancelAll();
    this.guard.runVoid('coach', 'end-take', now, () => this.lanes.policy.cancel('take_ended'));
    this.publish(now, true);
  }

  /* ---------------------------------------------------------------------- */
  /* Clock                                                                   */
  /* ---------------------------------------------------------------------- */

  private advanceTo(audioTimeMs: number): void {
    if (audioTimeMs > this.nowMs) this.nowMs = audioTimeMs;
  }

  /** §5.4. The later of the injected clock and the newest evidence seen. */
  private currentAudioTimeMs(): number {
    const clockNow = this.deps.audioClock.nowMs();
    this.advanceTo(clockNow);
    return this.nowMs;
  }

  /**
   * Drive the schedule without new frames — a silent stretch, or a caller that
   * pumps the orchestrator from its own loop.
   */
  tick(): void {
    const now = this.currentAudioTimeMs();
    this.guard.runVoid('pace', 'tick', now, () => this.lanes.clock.advanceTo(now));
    this.runDuePhases(now);
  }

  private runDuePhases(nowMs: number): void {
    if (
      this.lastAggregationMs === null ||
      nowMs - this.lastAggregationMs >= this.schedule.aggregationIntervalMs
    ) {
      this.lastAggregationMs = nowMs;
      this.aggregate(nowMs);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Analysis — one 20 ms frame (§12.2)                                      */
  /* ---------------------------------------------------------------------- */

  /**
   * Fold one analysis frame in.
   *
   * Cheap by construction: no candidate is generated here, nothing is
   * published, and the aggregation pass only runs when its 100 ms window has
   * elapsed. The lanes are guarded individually so a throw in, say, pitch
   * tracking cannot stop the microphone tile updating.
   */
  handleFrame(frame: AudioFrameFeatures): void {
    const frameEndMs = frame.audioTimeMs + this.schedule.frameMs;
    this.advanceTo(frameEndMs);
    const now = this.nowMs;
    const lanes = this.lanes;

    const closed = this.guard.run(
      'audio',
      'frame',
      now,
      () => {
        lanes.pauses.noteFrame(frame);
        const interval = lanes.vad.process(frame);
        lanes.microphone.process(frame, lanes.vad.speaking);
        lanes.pitchTracker.process(frame);
        return interval;
      },
      () => null,
    );

    this.guard.runVoid('pace', 'frame', now, () => lanes.clock.noteFrame(frame));
    this.guard.runVoid('prosody', 'frame', now, () => {
      lanes.pitch.noteFrame(frame);
      lanes.energy.noteFrame(frame);
    });

    // §16.5 conjunct 3. Every frame, whether or not a run closed here — without
    // this the VAD veto is inert and a hallucinated "um" in the endpoint tail
    // is confirmed, counted, and then demoted a moment later, so the presenter
    // watches the number tick up and back down.
    //
    // A dropout frame does **not** advance the watermark: the VAD reported
    // nothing there, which is a different claim from "the VAD reported silence
    // there", and it is exactly that distinction the watermark exists to keep.
    if (!frame.processorDropout) {
      this.guard.runVoid('disfluency', 'frame', now, () =>
        lanes.fillers.noteVadObservedThrough(frameEndMs),
      );
    }

    this.updateSpeakingEdges(frameEndMs);
    if (closed !== null) this.foldClosedInterval(closed);
    this.runDuePhases(now);
  }

  /**
   * §18.4/§18.6. Cadence needs the *live* edges of a speech run, not the run
   * reported once it closes: run-on detection counts unshaped boundaries
   * *inside* an open run, and a run that only exists retrospectively has none.
   */
  private updateSpeakingEdges(frameEndMs: number): void {
    const lanes = this.lanes;
    const speaking = this.guard.run(
      'audio',
      'speaking',
      frameEndMs,
      () => lanes.vad.speaking,
      () => this.speaking,
    );
    if (speaking === this.speaking) return;
    this.speaking = speaking;
    if (speaking) {
      const startMs = this.guard.run(
        'audio',
        'speaking',
        frameEndMs,
        () => lanes.vad.openIntervalStartMs ?? frameEndMs,
        () => frameEndMs,
      );
      this.guard.runVoid('cadence', 'onset', frameEndMs, () =>
        lanes.cadence.noteSpeechOnset(startMs),
      );
      return;
    }
    this.guard.runVoid('cadence', 'offset', frameEndMs, () =>
      lanes.cadence.noteSpeechEnd(frameEndMs),
    );
    // §17.2. A phrase closed; pitch and energy contrast are per-phrase.
    this.guard.runVoid('prosody', 'phrase-end', frameEndMs, () => {
      lanes.pitch.notePhraseEnd(frameEndMs, lanes.pitchTracker.reliability.referenceF0Hz);
      lanes.energy.notePhraseEnd(frameEndMs);
    });
  }

  /**
   * A closed VAD run: the accounting path, the disfluency lane's timing
   * authority, the ribbon's speech ticks, and the only place a pause can be
   * derived from local audio.
   */
  private foldClosedInterval(closed: ClosedSpeechInterval): void {
    const interval = closed.interval;
    const now = Math.max(this.nowMs, interval.endMs);
    const lanes = this.lanes;

    this.guard.runVoid('pace', 'interval', now, () => lanes.clock.noteSpeechInterval(interval));
    this.guard.runVoid('disfluency', 'interval', now, () =>
      lanes.fillers.observeSpeechInterval(interval),
    );
    if (interval.takePassId === this.host.takePassId) this.closedIntervals.push(interval);

    const derived = this.guard.run(
      'audio',
      'pause',
      now,
      () => lanes.pauses.noteInterval(interval),
      () => null,
    );
    if (derived === null) return;

    // §12.4: a dropout is not a pause. It is never drawn on the ribbon, and it
    // reaches the cadence lane only as `unmeasured`, which excludes it from the
    // choppy pattern.
    if (!derived.unmeasured && derived.takePassId === this.host.takePassId) {
      this.ribbonPauses.push({
        startMs: derived.startMs,
        endMs: derived.endMs,
        takePassId: derived.takePassId,
      });
    }

    const locate = this.host.pauseLocation;
    if (locate === undefined) {
      // §18.5 requires *mid-clause* interruptions, and where a silence sits
      // relative to the authored text is an alignment fact this module does not
      // have. Claiming `uncertain` for every inter-utterance gap would
      // manufacture a choppy-delivery finding out of ordinary sentence
      // boundaries, so with no locator the cadence lane is simply not told.
      return;
    }
    const located = this.guard.run(
      'cadence',
      'pause-location',
      now,
      () => locate({ startMs: derived.startMs, endMs: derived.endMs }),
      () => null,
    );
    if (located === null) return;
    const pause: PauseEvent = {
      startMs: derived.startMs,
      endMs: derived.endMs,
      location: located.location,
      ...(located.explained === undefined ? {} : { explained: located.explained }),
      unmeasured: derived.unmeasured,
    };
    this.notePause(pause);
  }

  /* ---------------------------------------------------------------------- */
  /* Event intake                                                            */
  /* ---------------------------------------------------------------------- */

  /** §37. The worklet's running dropped-frame total, folded in as a total. */
  noteWorkletDiagnostics(diagnostics: Pick<WorkletCoreDiagnostics, 'droppedFrameCount'>): void {
    this.guard.runVoid('coach', 'worklet-diagnostics', this.nowMs, () =>
      this.lanes.diagnostics.noteDroppedFrameTotal(diagnostics.droppedFrameCount),
    );
  }

  /** §37. The precision-transcription queue's own counters. */
  notePrecisionCounters(counters: { queued: number; completed: number; dropped: number }): void {
    this.guard.runVoid('coach', 'precision-counters', this.nowMs, () =>
      this.lanes.diagnostics.notePrecision(counters),
    );
  }

  /**
   * §14.2/§14.3. One transcript segment for the pace lane. Final segments
   * advance the cumulative counts; a provisional segment replaces the overlay.
   */
  noteTranscriptSegment(segment: SpokenSegment): void {
    this.advanceTo(segment.audioEndMs);
    const context = this.clockContext(this.nowMs);
    const candidates = this.guard.run(
      'pace',
      'segment',
      this.nowMs,
      () => this.lanes.pace.ingestSegment(segment, this.lanes.clock, context),
      () => [] as CoachCandidate[],
    );
    this.pendingCandidates.push(...candidates);
  }

  /** §16.1. A finalized Realtime item for the disfluency lane. */
  noteFinalTranscript(item: RealtimeTranscriptItem, authored: AuthoredSpanContext): void {
    this.advanceTo(item.audioEndMs);
    this.guard.runVoid('disfluency', 'final-transcript', this.nowMs, () =>
      this.lanes.fillers.observeFinalTranscript(item, authored),
    );
    this.appendFinalText(item);
  }

  /** §16.1. A provisional tail. Never produces a visible tick, by construction. */
  noteProvisionalTranscript(item: RealtimeTranscriptItem, authored: AuthoredSpanContext): void {
    this.advanceTo(item.audioEndMs);
    this.guard.runVoid('disfluency', 'provisional-transcript', this.nowMs, () =>
      this.lanes.fillers.observeProvisional(item, authored),
    );
    this.provisionalTail = item.text;
  }

  /** §16.3.4. A delayed verbatim result, mapped back onto its own interval. */
  notePrecisionResult(result: PrecisionTranscriptResult, authored: AuthoredSpanContext): void {
    this.guard.runVoid('disfluency', 'precision-result', this.nowMs, () =>
      this.lanes.fillers.applyPrecisionResult(result, authored),
    );
  }

  /** §23. Luna's verdict on a contextual filler the local layer proposed. */
  noteFillerVerdict(eventId: string, verdict: 'confirmed' | 'rejected'): void {
    this.guard.runVoid('disfluency', 'filler-verdict', this.nowMs, () =>
      this.lanes.fillers.applyLunaVerdict(eventId, verdict),
    );
  }

  /**
   * §19/§25.5. One authored span compared against the aligned transcript.
   *
   * Two questions are asked of the same observation and they are different
   * questions: the comparator decides critical-term fidelity locally, and
   * `observeParaphrase` asks whether the span is worth a *materiality*
   * judgement — a lexical claim that only Luna may answer. The paraphrase
   * candidate therefore never reaches the policy from here; see
   * {@link applyLunaSelection}.
   */
  noteFidelitySpan(observation: FidelitySpanObservation): void {
    const now = this.nowMs;
    const candidates = this.guard.run(
      'fidelity',
      'span',
      now,
      () => {
        const comparison = compareSpanFidelity(observation);
        const paraphrase = observeParaphrase(observation);
        return paraphrase.candidate === null
          ? comparison.candidates
          : [...comparison.candidates, paraphrase.candidate];
      },
      () => [] as CoachCandidate[],
    );
    for (const candidate of candidates) {
      this.pendingCandidates.push(candidate);
      if (!candidate.type.startsWith('critical_')) continue;
      // §27.4 / §11: the same discrepancy is a time-indexed ribbon tick and a
      // script-indexed gutter mark, and neither is derived from the other.
      this.criticalMismatches.push({
        evidenceId: candidate.evidenceId,
        startMs: candidate.stamp.audioStartMs,
        endMs: candidate.stamp.audioEndMs,
        takePassId: candidate.stamp.takePassId,
        confidence: candidate.localConfidence,
      });
      if (candidate.scriptAnchorTokenId !== null) {
        this.anchoredMarks.push({
          scriptAnchorTokenId: candidate.scriptAnchorTokenId,
          type: 'critical_mismatch',
          takePassId: candidate.stamp.takePassId,
        });
      }
    }
  }

  /** §18.4. An authored boundary the presenter has just passed. */
  noteBoundary(boundary: BoundaryEvent): void {
    this.advanceTo(boundary.atMs);
    const context = this.clockContext(this.nowMs);
    const candidate = this.guard.run(
      'cadence',
      'boundary',
      this.nowMs,
      () => this.lanes.cadence.noteBoundary(boundary, context),
      () => null,
    );
    if (candidate !== null) this.pendingCandidates.push(candidate);
  }

  /**
   * §18.5. A pause, either derived from VAD gaps by this module or supplied by
   * the caller for a manual or system stop.
   *
   * `unmeasured` is set by the derivation path; a caller reporting a manual
   * pause should set `manual`. Both are excluded from the choppy pattern.
   */
  notePause(pause: PauseEvent): void {
    this.advanceTo(pause.endMs);
    const context = this.clockContext(this.nowMs);
    const candidate = this.guard.run(
      'cadence',
      'pause',
      this.nowMs,
      () => this.lanes.cadence.notePause(pause, context),
      () => null,
    );
    if (candidate !== null) this.pendingCandidates.push(candidate);
  }

  /**
   * §14.5/§18.2. Audio that carries no delivery claim — a manual pause, a
   * command, a retake. Removed from delivery time and marked so any silence
   * spanning it is reported as unmeasured rather than as phrasing.
   */
  noteUnmeasured(
    startMs: number,
    endMs: number,
    reason: 'manual_pause' | 'system_pause' | 'command' | 'retake',
  ): void {
    this.advanceTo(endMs);
    this.guard.runVoid('pace', 'unmeasured', this.nowMs, () =>
      this.lanes.clock.noteUnmeasured(startMs, endMs, reason),
    );
    this.guard.runVoid('audio', 'unmeasured', this.nowMs, () =>
      this.lanes.pauses.noteUnmeasuredSpan(startMs, endMs),
    );
  }

  /** §10. A retake the take machinery committed. Drawn on the ribbon. */
  noteRetake(startMs: number, endMs: number): void {
    this.advanceTo(endMs);
    this.retakes.push({ startMs, endMs, takePassId: this.host.takePassId });
    this.noteUnmeasured(startMs, endMs, 'retake');
    this.guard.runVoid('coach', 'retake', this.nowMs, () =>
      this.lanes.policy.cancel('retake_started'),
    );
  }

  /** §12.7. Device loss. Outranks every acoustic reading. */
  noteMicrophoneDisconnected(disconnected: boolean): void {
    this.guard.runVoid('audio', 'device', this.nowMs, () =>
      this.lanes.microphone.setDisconnected(disconnected),
    );
  }

  /** §25.1. The Realtime transcription path itself is degraded. */
  noteTranscriptionDegraded(degraded: boolean): void {
    this.guard.runVoid('audio', 'transcription', this.nowMs, () =>
      this.lanes.microphone.setTranscriptionDegraded(degraded),
    );
    this.guard.runVoid('disfluency', 'transcription', this.nowMs, () =>
      this.lanes.fillers.setTranscriptionDegraded(degraded),
    );
  }

  /** §13.4. Another voice or media is present; pitch coaching is not usable. */
  noteCompetingAudio(present: boolean): void {
    this.guard.runVoid('audio', 'competing-audio', this.nowMs, () =>
      this.lanes.pitchTracker.setCompetingAudio(present),
    );
  }

  /** §20.4. Keep the tail of finalized speech for the Luna snapshot. */
  private appendFinalText(item: RealtimeTranscriptItem): void {
    const text = item.text.trim();
    if (text.length > 0) {
      this.finalText = `${this.finalText} ${text}`.trim();
      if (this.finalText.length > MAX_FINAL_TEXT_CHARS) {
        this.finalText = this.finalText.slice(this.finalText.length - MAX_FINAL_TEXT_CHARS);
      }
    }
    this.provisionalTail = '';
    if (this.finalAudioStartMs === 0) this.finalAudioStartMs = item.audioStartMs;
    this.finalAudioEndMs = Math.max(this.finalAudioEndMs, item.audioEndMs);
  }

  /* ---------------------------------------------------------------------- */
  /* Aggregation — every 100 ms (§12.2)                                      */
  /* ---------------------------------------------------------------------- */

  private aggregate(nowMs: number): void {
    const startedWallMs = this.wallClockMs();
    this.aggregationPasses += 1;
    const lanes = this.lanes;

    // (1) §26.5 first, before anything new is built: a tip resting on an event
    // the disfluency lane has stopped believing must come down in the same pass
    // the count corrects, not one pass later.
    this.drainDemotions();

    // (2) §12.7 microphone. The tile, then the `system_critical` candidates it
    // justifies — one per *episode*, never one per frame.
    const microphone = this.guard.run(
      'audio',
      'aggregate',
      nowMs,
      () => lanes.microphone.state,
      () => this.lastMicrophone,
    );
    this.lastMicrophone = microphone;
    this.trackClippingEpisode(microphone, nowMs);
    const micCandidates = this.guard.run(
      'audio',
      'aggregate',
      nowMs,
      () =>
        lanes.micCandidates.update(microphone, {
          audioTimeMs: nowMs,
          trackingEpoch: this.host.trackingEpoch,
          takePassId: this.host.takePassId,
        }),
      () => [] as CoachCandidate[],
    );
    this.pendingCandidates.push(...micCandidates);

    // (3) §14 pace.
    const paceResult = this.guard.run(
      'pace',
      'aggregate',
      nowMs,
      () =>
        lanes.pace.update(lanes.clock, {
          context: this.clockContext(nowMs),
          suppressed: this.host.commandActive || this.host.retakeState !== 'none',
          trackingCatchingUp: this.host.trackingCatchingUp,
          authoredFastSection: this.host.authoredFastSection,
          sentenceBoundaryPassed: this.host.sentenceBoundaryPassed,
          suppressSlowTip: this.host.suppressSlowTip,
          scriptProgress: this.host.scriptProgress,
          scriptSpanId: this.host.activeScriptSpanId,
        }),
      () => null,
    );
    if (paceResult !== null) {
      this.lastPaceResult = paceResult;
      this.lastPace = paceResult.display;
      this.pendingCandidates.push(...paceResult.candidates);
    } else if (this.guard.isDisabled('pace')) {
      // §27.1: a disabled lane says "unknown", never its last number.
      this.lastPace = initialPaceState(
        this.deps.settings.targetWpmLow,
        this.deps.settings.targetWpmHigh,
      );
      this.lastPaceResult = null;
    }

    // (4) §13/§17 prosody.
    const varietyResult = this.guard.run(
      'prosody',
      'aggregate',
      nowMs,
      () => {
        const reliability = lanes.pitchTracker.reliability;
        return lanes.variety.update({
          context: this.clockContext(nowMs),
          reliability,
          pitch: lanes.pitch.aggregate(nowMs, reliability),
          energy: lanes.energy.aggregate(nowMs),
          // §17.2 wants phrase-to-phrase WPM variation. The pace lane does not
          // expose per-phrase rates, so the term is declared unavailable and
          // §17.5 redistributes its weight — which is the designed behaviour
          // for a missing feature, and is not the same as scoring it zero.
          tempoVariationCv: null,
          emphasisContrastNorm: null,
          completedSentences: this.host.completedSentences,
          microphoneProblem: microphone.status !== 'ok' && microphone.status !== 'learning',
          suppressVarietyCoaching: this.host.suppressVarietyCoaching,
          scriptSpanId: this.host.activeScriptSpanId,
        });
      },
      () => null,
    );
    if (varietyResult !== null) {
      this.lastVarietyResult = varietyResult;
      this.lastVariety = varietyResult.display;
      this.pendingCandidates.push(...varietyResult.candidates);
    } else if (this.guard.isDisabled('prosody')) {
      this.lastVariety = initialVarietyState(
        this.deps.settings.targetVarietyLow,
        this.deps.settings.targetVarietyHigh,
      );
      this.lastVarietyResult = null;
    }

    // (5) §18 cadence. The alignment gate is re-asserted here as well as on
    // every host update: it defaults shut, and a gate that is only opened from
    // one call site is a gate that quietly stops being opened.
    this.guard.runVoid('cadence', 'aggregate', nowMs, () =>
      lanes.cadence.setAlignmentConfidence(this.host.alignmentConfidence),
    );
    this.lastCadence = this.guard.run(
      'cadence',
      'aggregate',
      nowMs,
      () => lanes.cadence.metrics(nowMs),
      () => (this.guard.isDisabled('cadence') ? EMPTY_CADENCE_METRICS : this.lastCadence),
    );

    // (6) §16 disfluency. `peek` here: `countedLive` is set at *publish* time,
    // because it records what the presenter actually saw.
    this.lastFillers = this.guard.run(
      'disfluency',
      'aggregate',
      nowMs,
      () => lanes.fillers.peekDisplayState(nowMs),
      () => (this.guard.isDisabled('disfluency') ? initialFillerState() : this.lastFillers),
    );
    const fillerCandidates = this.guard.run(
      'disfluency',
      'aggregate',
      nowMs,
      () => lanes.fillers.candidates(nowMs),
      () => [] as CoachCandidate[],
    );
    this.pendingCandidates.push(...fillerCandidates);

    // (7) Admission. §19.4's `<!-- cc:coach off -->` spans are refused here.
    const batch = this.pendingCandidates;
    this.pendingCandidates = [];
    this.guard.runVoid('coach', 'admit', nowMs, () => {
      for (const candidate of batch) {
        lanes.registry.admit(
          candidate,
          this.host.trackingEpoch,
          this.host.takePassId,
          nowMs,
          { coachingDisabledSpanIds: this.host.coachingDisabledSpanIds },
        );
      }
      lanes.registry.prune(nowMs);
    });

    const active = this.guard.run(
      'coach',
      'active',
      nowMs,
      () => lanes.registry.active(this.host.trackingEpoch, this.host.takePassId),
      () => [] as CoachCandidate[],
    );

    // (8) §20.2/§20.3 Luna, for the candidate types that genuinely need
    // semantic judgement and for nothing else.
    this.consultLuna(nowMs, active);

    // (9) §26 proposals, then the display clock.
    this.proposeLocal(nowMs, active);
    this.guard.runVoid('coach', 'tick', nowMs, () => lanes.policy.tick(this.policyContext(nowMs)));

    // (10) §37.
    this.guard.runVoid('coach', 'diagnostics', nowMs, () => {
      lanes.diagnostics.noteTips(lanes.policy.getCounters());
      const observer = this.observer;
      if (observer !== null) lanes.diagnostics.noteObserver(observer.getDiagnostics());
      lanes.diagnostics.noteAnalyzerPass(this.wallClockMs() - startedWallMs);
    });

    this.publish(nowMs, false);
  }

  /**
   * §26.5. The demotion drain, exactly as `FillerTracker.drainRevisedEventIds`
   * documents it.
   *
   * The two `cancel` calls are not redundant. The first cancels tips whose
   * *candidate* the registry still holds; the second covers a tip already on the
   * glass whose candidate has since been pruned, because the policy also
   * matches a cancellation against the tip's own `contributingEventIds`.
   */
  private drainDemotions(): void {
    const lanes = this.lanes;
    const revised = this.guard.run(
      'disfluency',
      'drain',
      this.nowMs,
      () => lanes.fillers.drainRevisedEventIds(),
      () => [] as string[],
    );
    if (revised.length === 0) return;
    this.guard.runVoid('coach', 'drain', this.nowMs, () => {
      for (const eventId of revised) {
        for (const evidenceId of lanes.registry.invalidateByContributingEvent(
          eventId,
          'demoted_to_probable',
        )) {
          lanes.policy.cancel('evidence_revised', { evidenceId });
        }
        lanes.policy.cancel('evidence_revised', { evidenceId: eventId });
      }
    });
  }

  /** §12.7.1. Track clipping as an episode so the ribbon can draw its span. */
  private trackClippingEpisode(microphone: MicrophoneCoachState, nowMs: number): void {
    if (microphone.status === 'clipping') {
      this.openClippingStartMs = this.openClippingStartMs ?? nowMs;
      return;
    }
    const startMs = this.openClippingStartMs;
    if (startMs === null) return;
    this.openClippingStartMs = null;
    this.clippingEpisodes.push({ startMs, endMs: nowMs, takePassId: this.host.takePassId });
  }

  /* ---------------------------------------------------------------------- */
  /* Luna (§20, §22, §23)                                                    */
  /* ---------------------------------------------------------------------- */

  private createObserver(): LunaCoachObserver | null {
    const transport = this.deps.lunaTransport;
    if (transport === undefined) return null;
    return new LunaCoachObserver({
      transport,
      // §23.1. A *live* reader, not values captured at construction. This is
      // the whole of the staleness section: `audioTimeMs`, the epoch and the
      // take pass are read at the moment an answer is about to be applied, and
      // the invalidation set is read then too, because an event is almost
      // always invalidated *while* the request is in flight.
      liveContext: (): CoachLiveContext => ({
        audioTimeMs: this.currentAudioTimeMs(),
        trackingEpoch: this.host.trackingEpoch,
        takePassId: this.host.takePassId,
        state: liveStateFrom(this.host, this.lastMicrophone),
        invalidatedEvidenceIds: this.lanes.registry.invalidatedIds(),
      }),
      ...(this.deps.lunaMode === undefined ? {} : { lunaMode: this.deps.lunaMode }),
      ...(this.deps.isBudgetExhausted === undefined
        ? {}
        : { isBudgetExhausted: this.deps.isBudgetExhausted }),
      ...(this.deps.maxLunaRequestsPerTake === undefined
        ? {}
        : { maxRequestsPerTake: this.deps.maxLunaRequestsPerTake }),
      onSelection: (selection, request) => {
        this.noteLunaLatency(request.requestAudioTimeMs);
        this.applyLunaSelection(selection);
      },
      onRejection: (_reason: DecisionRejection, request) => {
        this.noteLunaLatency(request.requestAudioTimeMs);
      },
    });
  }

  /**
   * §37. Wall-clock latency from `requestAudioTimeMs` to answer application.
   *
   * The one legitimate use of a wall clock in this subsystem, and the reason
   * the request's *audio* stamp is the key: the gap being measured is exactly
   * the one the audio clock cannot describe.
   */
  private noteLunaLatency(requestAudioTimeMs: number): void {
    const issuedAt = this.requestWallMs.get(requestAudioTimeMs);
    if (issuedAt === undefined) return;
    this.requestWallMs.delete(requestAudioTimeMs);
    this.lanes.diagnostics.noteLunaLatency(this.wallClockMs() - issuedAt);
  }

  private consultLuna(nowMs: number, active: readonly CoachCandidate[]): void {
    const observer = this.observer;
    if (observer === null) return;
    this.guard.runVoid('luna', 'observe', nowMs, () => {
      // §20.2: never to compute WPM, never to notice that pitch moved.
      //
      // §20.3 coalesces for 600–1 200 ms, and `observe` replaces the pending
      // observation *and its queue time*. Re-observing on every 100 ms
      // aggregation would therefore push the coalescing deadline forward
      // forever and no request would ever be issued — a rate limiter that
      // limits to zero. So a new observation is queued only when there is
      // genuinely something new to say.
      const signature = active
        .filter((candidate) => shouldConsultLuna([candidate]))
        .map((candidate) => candidate.evidenceId)
        .join(',');
      const changed = signature.length > 0 && signature !== this.lastObservedSignature;
      if (changed || (signature.length > 0 && observer.periodicDue(nowMs))) {
        this.lastObservedSignature = signature;
        observer.observe(this.buildRequestInput(nowMs, active));
        this.requestWallMs.set(nowMs, this.wallClockMs());
        if (this.requestWallMs.size > MAX_TRACKED_REQUESTS) {
          const oldest = this.requestWallMs.keys().next();
          if (!(oldest.done ?? false)) this.requestWallMs.delete(oldest.value);
        }
      }
      observer.tick(nowMs);
    });
  }

  private buildRequestInput(
    nowMs: number,
    active: readonly CoachCandidate[],
  ): CoachRequestInput {
    return {
      sessionId: this.deps.sessionId,
      scriptId: this.host.scriptId,
      scriptRevision: this.host.scriptRevision,
      trackingEpoch: this.host.trackingEpoch,
      takePassId: this.host.takePassId,
      requestAudioTimeMs: nowMs,
      language: this.host.language,
      state: liveStateFrom(this.host, this.lastMicrophone),
      profile: lunaProfileFrom(this.deps.settings),
      authoredSpans: this.host.authoredSpans,
      speech: {
        finalText: this.finalText,
        provisionalTail: this.provisionalTail,
        finalAudioStartMs: this.finalAudioStartMs,
        finalAudioEndMs: this.finalAudioEndMs,
      },
      metrics: {
        displayWpm: this.lastPace.wpm,
        paceState: this.lastPace.state,
        pacePersistenceMs: this.lastPaceResult?.pacePersistenceMs ?? 0,
        terminalRushRatio: this.lastPaceResult?.terminalRushRatio ?? null,
        varietyLevel: this.lastVariety.level,
        varietyState: this.lastVariety.state,
        varietyPersistenceMs: this.lastVarietyResult?.varietyPersistenceMs ?? 0,
        cadenceBalance: this.lastCadence.cadenceBalance,
        runOnCount: this.lastCadence.runOnCount,
        choppyPauseCount: this.lastCadence.choppyPauseCount,
        confirmedFillersLast20s: this.lastFillers.confirmedLast20s,
        confirmedFillersLast60s: this.lastFillers.confirmedLast60s,
      },
      candidates: active,
    };
  }

  /**
   * §23/§25.5. A validated selection becomes a proposal — and only ever with
   * `source: 'luna_validated'`.
   *
   * That is what makes `requiresLunaValidation` mean something: a
   * `material_meaning_change` candidate is never offered locally (see
   * {@link proposeLocal}), so the only path to the glass for the one code the
   * local layer may ask about but not answer runs through here.
   */
  private applyLunaSelection(selection: CoachDecisionSelection): void {
    const nowMs = this.currentAudioTimeMs();
    const active = this.guard.run(
      'coach',
      'luna-selection',
      nowMs,
      () => this.lanes.registry.active(this.host.trackingEpoch, this.host.takePassId),
      () => [] as CoachCandidate[],
    );
    const proposals: TipProposal[] = [];
    for (const evidenceId of selection.evidenceIds) {
      const candidate = active.find((entry) => entry.evidenceId === evidenceId);
      if (candidate === undefined) continue;
      this.proposedEvidenceIds.add(candidate.evidenceId);
      proposals.push({
        ...this.proposalFor(candidate),
        source: 'luna_validated',
        lunaConfidence: selection.confidence,
        lunaScope: selection.scope,
      });
    }
    if (proposals.length === 0) return;
    this.guard.runVoid('coach', 'luna-selection', nowMs, () =>
      this.lanes.policy.propose(proposals, this.policyContext(nowMs)),
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Proposals (§26)                                                         */
  /* ---------------------------------------------------------------------- */

  /**
   * Offer each candidate to the policy once.
   *
   * Codes the catalog marks `requiresLunaValidation` are skipped: the policy
   * would reject them as `requires_semantic_validation` on every pass, which is
   * correct but would make §37's "the rail is too chatty" ratio meaningless by
   * counting a structural rule as a suppression fifty times a second.
   */
  private proposeLocal(nowMs: number, active: readonly CoachCandidate[]): void {
    const proposals: TipProposal[] = [];
    for (const candidate of active) {
      if (this.proposedEvidenceIds.has(candidate.evidenceId)) continue;
      const code = CANDIDATE_TIP_CODE[candidate.type];
      if (COACH_TIP_CATALOG[code].requiresLunaValidation) continue;
      this.proposedEvidenceIds.add(candidate.evidenceId);
      proposals.push({ ...this.proposalFor(candidate), source: 'local' });
    }
    if (proposals.length === 0) return;
    this.guard.runVoid('coach', 'propose', nowMs, () =>
      this.lanes.policy.propose(proposals, this.policyContext(nowMs)),
    );
  }

  /**
   * The safe extras a proposal may carry.
   *
   * `filler` is the analyzer's `detailCode`, which for the disfluency lane is
   * the normalized form; the catalog re-checks it against the §25.3 allowlist,
   * so nothing arbitrary can reach the glass through it. `authoredTerm` is the
   * authored fragment, quoted only under §25.5 and escaped by the catalog.
   */
  private proposalFor(candidate: CoachCandidate): Omit<TipProposal, 'source'> {
    return {
      candidate,
      filler: candidate.detailCode,
      authoredTerm: candidate.authoredFragment,
      persistenceMs: candidate.stamp.audioEndMs - candidate.stamp.audioStartMs,
      scriptAnchorTokenId: candidate.scriptAnchorTokenId,
    };
  }

  private policyContext(nowMs: number): CoachPolicyContext {
    const settings = this.deps.settings;
    const modules = this.railModules();
    return {
      audioTimeMs: nowMs,
      mode: settings.mode,
      trackingEpoch: this.host.trackingEpoch,
      takePassId: this.host.takePassId,
      deliveryStyle: settings.deliveryStyle,
      liveTipFrequency: settings.liveTipFrequency,
      // §6.1: `off` is the master switch, and it cancels rather than merely
      // refuses — a tip already on the glass must come down.
      coachingEnabled: settings.mode !== 'off',
      liveTipsEnabled: modules.liveTips,
      positiveReinforcementEnabled: settings.positiveReinforcementEnabled,
      highFrequency: settings.mode === 'studio',
      state: liveStateFrom(this.host, this.lastMicrophone),
      safeMoment: this.host.safeMoment,
      activeScriptSpanId: this.host.activeScriptSpanId,
    };
  }

  /** §6.6. The mode's resolved flags, `custom` included. */
  private railModules(): CoachRailModules {
    return resolveRailModules(this.deps.settings.mode, this.customModules());
  }

  private customModules(): Partial<CoachRailModules> | undefined {
    return this.deps.settings.mode === 'custom'
      ? railModulesFromSettings(this.deps.settings)
      : undefined;
  }

  /* ---------------------------------------------------------------------- */
  /* Publication — every 200 ms or on a material change (§12.2, §27)          */
  /* ---------------------------------------------------------------------- */

  private publish(nowMs: number, force: boolean): void {
    const mode = this.deps.settings.mode;
    // §6.1/§6.5. Both modes keep analysing — everything above this line ran —
    // and neither puts anything on the glass. Critical microphone and
    // transcription faults reach the user through the app's system-notice path,
    // which is not the rail.
    if (mode === 'off' || mode === 'review_only') return;

    const activeTip = this.guard.run(
      'coach',
      'active-tip',
      nowMs,
      () => this.lanes.policy.getActiveTip(),
      () => null,
    );

    // A "material" change is a change of *state*, not of a number: the pace
    // WPM moves on every pass, and publishing on it would silently restore the
    // frame-rate publication §12.2 forbids.
    const signature = [
      activeTip?.tipId ?? '-',
      this.lastMicrophone.status,
      this.lastMicrophone.sustained ? '1' : '0',
      this.lastMicrophone.transcriptionDegraded ? '1' : '0',
      this.lastPace.state,
      this.lastVariety.state,
      this.lastFillers.confirmedCount,
      this.lastFillers.degraded ? '1' : '0',
      this.host.visible ? '1' : '0',
      this.host.mirrored ? '1' : '0',
      this.host.reducedMotion ? '1' : '0',
    ].join('|');

    const due =
      force ||
      this.lastPublicationMs === null ||
      nowMs - this.lastPublicationMs >= this.schedule.publicationIntervalMs ||
      signature !== this.lastSignature;
    if (!due) return;
    this.lastPublicationMs = nowMs;
    this.lastSignature = signature;

    // §27.3. `countedLive` is set here and only here: it records what the
    // presenter actually saw, so a later demotion corrects the total without
    // rewriting history.
    const fillers = this.guard.run(
      'disfluency',
      'publish',
      nowMs,
      () => this.lanes.fillers.publishDisplayState(nowMs),
      () => this.lastFillers,
    );
    this.lastFillers = fillers;

    this.pruneRibbonSources(nowMs);
    const modules = this.railModules();
    const inputs: CoachRailInputs = {
      sessionId: this.deps.sessionId,
      takePassId: this.host.takePassId,
      mode,
      visible: this.host.visible,
      mirrored: this.host.mirrored,
      reducedMotion: this.host.reducedMotion,
      pace: this.lastPace,
      variety: this.lastVariety,
      fillers,
      microphone: this.lastMicrophone,
      activeTip,
      ribbonEvents: this.buildRibbon(nowMs),
      audioTimeMs: nowMs,
      gutterMarks: modules.gutterMarks ? this.buildGutter() : [],
      ...(this.customModules() === undefined ? {} : { customModules: this.customModules() }),
    };

    const state = this.guard.run(
      'coach',
      'publish',
      nowMs,
      () => this.railBuilder.build(inputs),
      () => null,
    );
    if (state === null) return;
    this.lastRail = state;
    this.publications += 1;
    // The sink is the session store's; a throw in it is not a lane failure and
    // must not be mistaken for one, but it still must not reach the frame pump.
    try {
      this.deps.publish(state);
    } catch {
      /* the stage transport's problem, not the subsystem's */
    }
  }

  private buildRibbon(nowMs: number): CoachRibbonEvent[] {
    return this.guard.run(
      'coach',
      'ribbon',
      nowMs,
      () =>
        buildRibbonEvents(
          {
            speechIntervals: this.closedIntervals,
            fillers: this.guard.run(
              'disfluency',
              'ribbon',
              nowMs,
              () => this.lanes.fillers.events(),
              () => [],
            ),
            // §10: pauses come from the cadence-aware derivation, never from
            // raw gaps — a gap can be a dropout.
            pauses: this.ribbonPauses,
            retakes: this.retakes,
            criticalMismatches: this.criticalMismatches,
            clipping: this.clippingEpisodes,
          },
          this.host.takePassId,
        ),
      () => [] as CoachRibbonEvent[],
    );
  }

  private buildGutter(): CoachGutterMark[] {
    const lineForToken = this.host.lineForToken;
    return this.guard.run(
      'coach',
      'gutter',
      this.nowMs,
      () =>
        buildGutterMarks(
          {
            fillers: this.guard.run(
              'disfluency',
              'gutter',
              this.nowMs,
              () => this.lanes.fillers.events(),
              () => [],
            ),
            anchored: this.anchoredMarks,
            // §11: the token → line map is the script compiler's, so it is
            // injected. Omitted, every token is its own line, which never
            // merges two lines by accident.
            ...(lineForToken === undefined ? {} : { lineForToken }),
          },
          this.host.takePassId,
        ),
      () => [] as CoachGutterMark[],
    );
  }

  /** §33. The rail's own window bounds the payload; this bounds the sources. */
  private pruneRibbonSources(nowMs: number): void {
    const cutoff = nowMs - RIBBON_WINDOW_MS;
    this.closedIntervals = this.closedIntervals.filter((interval) => interval.endMs >= cutoff);
    this.ribbonPauses = this.ribbonPauses.filter((pause) => pause.endMs >= cutoff);
    this.retakes = this.retakes.filter((retake) => retake.endMs >= cutoff);
    this.criticalMismatches = this.criticalMismatches.filter((event) => event.endMs >= cutoff);
    this.clippingEpisodes = this.clippingEpisodes.filter((episode) => episode.endMs >= cutoff);
  }

  /* ---------------------------------------------------------------------- */
  /* Observation                                                             */
  /* ---------------------------------------------------------------------- */

  /** The most recent snapshot handed to the stage, or `null`. */
  lastRailState(): CoachRailState | null {
    return this.lastRail;
  }

  /** §37. */
  diagnostics(): CoachDiagnostics {
    return this.lanes.diagnostics.snapshot();
  }

  /**
   * Everything measured this pass, published or not.
   *
   * This is how `off` and `review_only` are shown to be *analysing* rather than
   * merely silent — the distinction a publication-only surface cannot make.
   */
  telemetry(): CoachingTelemetry {
    return {
      audioTimeMs: this.nowMs,
      takePassId: this.host.takePassId,
      mode: this.deps.settings.mode,
      modules: this.railModules(),
      pace: this.lastPace,
      rates: this.lastPaceResult?.rates ?? {
        audibleWpm: null,
        contentWpm: null,
        articulationWpm: null,
      },
      variety: this.lastVariety,
      fillers: this.lastFillers,
      microphone: this.lastMicrophone,
      cadence: this.lastCadence,
      activeCandidates: this.guard.run(
        'coach',
        'telemetry',
        this.nowMs,
        () => this.lanes.registry.active(this.host.trackingEpoch, this.host.takePassId),
        () => [],
      ),
      disabledLanes: this.guard.disabledLanes(),
      aggregationPasses: this.aggregationPasses,
      publications: this.publications,
    };
  }

  /** Test and review seam: the real lane instances this orchestrator drives. */
  laneBundle(): CoachingLanes {
    return this.lanes;
  }

  /**
   * The Luna observer, or `null` when no transport was injected.
   *
   * Exposed because the observer owns work the orchestrator cannot await for
   * the caller: `settle()` is the only way a test can wait on an in-flight
   * classification, and `getDiagnostics()` carries the §20.3 budget state the
   * session UI reports.
   */
  lunaObserver(): LunaCoachObserver | null {
    return this.observer;
  }

  /** §5.2. Lanes currently out of service. */
  disabledLanes(): readonly string[] {
    return this.guard.disabledLanes();
  }
}

export type { CoachRailMode };
