/**
 * Injected shapes for the coaching integrator (§5.2, §5.4, §12.2).
 *
 * ---------------------------------------------------------------------------
 * RULE 1 — THE INTEGRATOR CANNOT MOVE THE SCRIPT.
 * ---------------------------------------------------------------------------
 * Nothing in `coaching/integration` imports from `shared/tracking`,
 * `shared/semantic`, a store, the DOM, or Tauri. The only outputs are a
 * {@link CoachRailState} handed to an injected sink and a {@link CoachDiagnostics}
 * snapshot. There is no scroll offset, cursor index, unit id, section id or
 * navigation directive anywhere in this directory — the same structural
 * enforcement `coaching/coach` uses, extended to the layer that drives it.
 *
 * Everything the orchestrator cannot compute for itself — the alignment cursor,
 * the active span, the retake state — arrives as *host state* pushed in by the
 * session store. It is read, never written back.
 *
 * ---------------------------------------------------------------------------
 * RULE 3 — THE AUDIO CLOCK IS THE ONLY CLOCK.
 * ---------------------------------------------------------------------------
 * {@link AudioClock} is the only source of "now" in orchestration logic. There
 * is no `Date.now()` and no `performance.now()` on any decision path here. A
 * wall clock exists in exactly one place — {@link CoachingOrchestratorDeps.wallClockMs},
 * used only to time an analyzer pass and a Luna round trip for §37 — because
 * §5.4 permits arrival time for latency measurement and for nothing else.
 */
import type {
  CoachCandidate,
  CoachRailMode,
  CoachRailModules,
  CoachRailState,
  CoachingSettings,
  DeliveryStyle,
  FillerDisplayState,
  MicrophoneCoachState,
  PaceDisplayState,
  ScriptProgress,
  VarietyDisplayState,
} from '../../contracts/coaching';
import type { Uuid } from '../../contracts/core';
import type { CoachObserverTransport } from '../coach/luna-observer';
import type { CoachingLanes } from './lanes';
import type { CoachLiveState } from '../coach/tip-policy';
import type { CadenceMetrics, PauseLocation } from '../prosody/cadence-analyzer';
import type { PaceRates } from '../pace/pace-analyzer';
import type { LunaCoachRequest } from '../../contracts/coaching';

/**
 * §5.4. The monotonic audio clock, injected so a test drives it deterministically
 * and so no module below this one can reach for a wall clock by accident.
 *
 * The orchestrator also advances its own notion of now from frame stamps; the
 * clock is what answers "how late is it" when frames have stopped arriving.
 */
export interface AudioClock {
  nowMs(): number;
}

/**
 * §12.2 cadences. Analysis is per frame (20 ms), aggregation is every 100 ms,
 * and the rail publishes every 200 ms **or on a material state change**.
 *
 * Injectable in whole so a test can collapse or stretch the schedule without
 * simulating real time, and so a slower machine can be tuned without editing
 * the orchestrator.
 */
export interface CoachingSchedule {
  /** §12.2 analysis frame, ms. Informational here; frames arrive stamped. */
  frameMs: number;
  /** §12.2 aggregation update, ms. */
  aggregationIntervalMs: number;
  /** §12.2 rail publication, ms. A material change publishes sooner. */
  publicationIntervalMs: number;
}

export const DEFAULT_COACHING_SCHEDULE: CoachingSchedule = {
  frameMs: 20,
  aggregationIntervalMs: 100,
  publicationIntervalMs: 200,
};

/**
 * The lanes, as failure-isolation units.
 *
 * A lane is the smallest thing worth disabling on its own: `audio` failing
 * takes the microphone tile with it but leaves the transcript-driven filler
 * count alone, and vice versa.
 */
export type CoachingLaneId =
  | 'audio'
  | 'pace'
  | 'prosody'
  | 'cadence'
  | 'disfluency'
  | 'fidelity'
  | 'coach'
  | 'luna';

export interface CoachingLaneFailure {
  lane: CoachingLaneId;
  /** What the orchestrator was doing, e.g. `'frame'`, `'aggregate'`. */
  phase: string;
  error: unknown;
  /** Audio-clock time of the failure (§5.4). */
  audioTimeMs: number;
  /** Consecutive failures for this lane in the current take pass. */
  failureCount: number;
  /** True when this failure took the lane out of service. */
  disabled: boolean;
}

/**
 * State the orchestrator reads but can never produce: it belongs to the
 * tracking engine, the take machinery, and the UI.
 *
 * Pushed rather than pulled so the session store keeps one obvious write path,
 * and read *live* at every use — the Luna observer's `liveContext` is built out
 * of these fields at answer-application time, which is the whole point of
 * §23.1's staleness rules.
 */
export interface CoachingHostState {
  /** §5.4. Bumping this invalidates every piece of evidence taken before it. */
  trackingEpoch: number;
  /** §5.4. The current take pass. Change it through `beginTakePass`. */
  takePassId: string;
  /** Realtime commit ordinal for evidence derived from the transcript. */
  commitSequence: number | null;
  /** 0–1 alignment confidence. Gates the choppy pattern and ordinary tips. */
  alignmentConfidence: number;
  reacquiring: boolean;
  commandActive: boolean;
  retakeState: 'none' | 'pending' | 'reversing' | 'settling';
  /** §26.5. The authored **span** the presenter is on. Never a token id. */
  activeScriptSpanId: string | null;
  /** §9.4. Sentence boundary, natural pause, or settled motion. */
  safeMoment: boolean;
  /** §14.8: at least one sentence boundary since the pace condition began. */
  sentenceBoundaryPassed: boolean;
  /** §14.8: tracking is catching up after a transcript delay. */
  trackingCatchingUp: boolean;
  /** §14.8: the presenter is deliberately reading a marked fast section. */
  authoredFastSection: boolean;
  /** §14.8: reflective line, list, quotation, retake — no "lift the pace" tip. */
  suppressSlowTip: boolean;
  /** §17.9: list, disclaimer, quotation, or an authored directive. */
  suppressVarietyCoaching: boolean;
  /** §14.10 alignment cursor, or `null` when the engine has nothing to say. */
  scriptProgress: ScriptProgress | null;
  /** §14.10 authored target duration for the script, ms, or `null`. */
  targetDurationMs: number | null;
  /** §17.9 completed sentences this take pass. */
  completedSentences: number;
  /** Whether the rail is currently shown. Never reflows the script (§7.1). */
  visible: boolean;
  mirrored: boolean;
  reducedMotion: boolean;
  /** §19.4 `<!-- cc:coach off -->` spans. Candidates inside them are refused. */
  coachingDisabledSpanIds: ReadonlySet<string>;
  /**
   * §11. Authored token id → line key, supplied by the script compiler.
   *
   * Gutter marks are *script*-indexed and this module must not guess at line
   * layout, so the mapping is injected. `undefined` means "each token is its
   * own line" — the correct degenerate case, which never merges two lines by
   * accident.
   */
  lineForToken?: (scriptAnchorTokenId: string) => string;
  /**
   * §18.2. Where a silence sits relative to the authored text.
   *
   * Supplied by the caller because pause *location* is an alignment fact.
   * Without it the orchestrator does not offer derived pauses to the cadence
   * lane at all: a pause we cannot locate is not evidence of choppy delivery,
   * and claiming `uncertain` for every inter-utterance gap would manufacture
   * exactly the §18.5 finding the lane's default-shut gate exists to prevent.
   */
  pauseLocation?: (pause: { startMs: number; endMs: number }) => {
    location: PauseLocation;
    explained?: boolean;
  };
  /** §22. The 1–3 authored sentences around the active span, for Luna. */
  authoredSpans: LunaCoachRequest['authoredSpans'];
  scriptId: Uuid;
  scriptRevision: number;
  language: string;
}

/** The starting host state: knows nothing, claims nothing. */
export function initialHostState(scriptId: Uuid, takePassId: string): CoachingHostState {
  return {
    trackingEpoch: 0,
    takePassId,
    commitSequence: null,
    // §18.5 and §21 both gate on this, and both must gate *shut* until the
    // tracking engine says otherwise.
    alignmentConfidence: 0,
    reacquiring: false,
    commandActive: false,
    retakeState: 'none',
    activeScriptSpanId: null,
    safeMoment: false,
    sentenceBoundaryPassed: false,
    trackingCatchingUp: false,
    authoredFastSection: false,
    suppressSlowTip: false,
    suppressVarietyCoaching: false,
    scriptProgress: null,
    targetDurationMs: null,
    completedSentences: 0,
    visible: true,
    mirrored: false,
    reducedMotion: false,
    coachingDisabledSpanIds: new Set<string>(),
    authoredSpans: [],
    scriptId,
    scriptRevision: 0,
    language: 'en',
  };
}

/**
 * Everything the orchestrator measured this pass, whether or not the rail is
 * allowed to show it.
 *
 * §6.1/§6.5 require `off` and `review_only` to keep analysing while publishing
 * nothing live, and a subsystem that "ran" with no observable result is
 * indistinguishable from one that did nothing. This is the observable result.
 */
export interface CoachingTelemetry {
  audioTimeMs: number;
  takePassId: string;
  mode: CoachRailMode;
  modules: CoachRailModules;
  pace: PaceDisplayState;
  rates: PaceRates;
  variety: VarietyDisplayState;
  fillers: FillerDisplayState;
  microphone: MicrophoneCoachState;
  cadence: CadenceMetrics;
  /** Candidates alive in the registry right now. */
  activeCandidates: readonly CoachCandidate[];
  /** Lanes currently out of service (§5.2). */
  disabledLanes: readonly CoachingLaneId[];
  /** Aggregation passes completed this take pass. */
  aggregationPasses: number;
  /** Rail snapshots published this session. `0` in `off` / `review_only`. */
  publications: number;
}

export interface CoachingOrchestratorDeps {
  sessionId: Uuid;
  /** §5.4. The only clock on any decision path. */
  audioClock: AudioClock;
  settings: CoachingSettings;
  /** Initial host state; update it with `setHostState`. */
  host: CoachingHostState;
  /**
   * The stage sink. Called **only** when the mode publishes a live rail, and
   * never at frame rate (§12.2).
   */
  publish: (state: CoachRailState) => void;
  schedule?: Partial<CoachingSchedule>;
  /** §20.3. Omit and no Luna observer is created; every local lane is unaffected. */
  lunaTransport?: CoachObserverTransport;
  lunaMode?: 'standard' | 'enhanced';
  /** The session's existing semantic budget. `true` vetoes every call (§20.3). */
  isBudgetExhausted?: () => boolean;
  maxLunaRequestsPerTake?: number;
  /** §5.2. Notified whenever a lane throws, disabled or not. */
  onLaneFailure?: (failure: CoachingLaneFailure) => void;
  /**
   * §5.2. Consecutive throws a lane is allowed before it is taken out of
   * service for the rest of the take pass. Default 1 — a lane that threw is in
   * an unknown internal state, and stale telemetry is worse than a blank tile.
   */
  laneFailureLimit?: number;
  /**
   * §37 only. Wall-clock milliseconds, used to time an analyzer pass and a Luna
   * round trip. Never consulted for any decision. Defaults to `performance.now`
   * where it exists and to a constant otherwise, so a node test is deterministic
   * without stubbing anything.
   */
  wallClockMs?: () => number;
  /**
   * Replace individual lane instances. Type-only import, so this creates no
   * runtime dependency from the shapes onto the lane classes.
   */
  lanes?: Partial<CoachingLanes>;
}

/** §6.6. Resolve the settings' module toggles into the rail's flag set. */
export function railModulesFromSettings(settings: CoachingSettings): Partial<CoachRailModules> {
  return {
    paceNumber: settings.modules.paceNumber,
    paceStatus: settings.modules.paceStatus,
    // §30 has no sparkline toggle: the sparkline is a Studio affordance (§6.4)
    // and `custom` therefore never enables it. Stated here rather than guessed
    // at by the stage, which is the whole reason the flags are resolved.
    paceSparkline: false,
    targetDurationStatus: settings.modules.targetDurationStatus,
    varietyScore: settings.modules.varietyScore,
    // §30 has one variety toggle and the rail has two. The label is the weaker
    // claim of the pair, so it follows the score rather than being invented.
    varietyLabel: settings.modules.varietyScore,
    fillerCount: settings.modules.fillerCount,
    fillerRibbon: settings.modules.fillerRibbon,
    gutterMarks: settings.modules.inlineGutterMarks,
    deliveryScore: settings.modules.deliveryScore,
    liveTips: settings.modules.liveTips,
  };
}

/** §22. The live state block, as both the policy and Luna read it. */
export function liveStateFrom(
  host: CoachingHostState,
  microphone: MicrophoneCoachState,
): CoachLiveState {
  return {
    alignmentConfidence: host.alignmentConfidence,
    commandActive: host.commandActive,
    retakeState: host.retakeState,
    reacquiring: host.reacquiring,
    microphoneHealthy: microphone.status === 'ok' || microphone.status === 'learning',
  };
}

/** §20. The Luna profile block. `custom` and `off` map onto the nearest live mode. */
export function lunaProfileFrom(settings: CoachingSettings): LunaCoachRequest['profile'] {
  const coachingMode: 'minimal' | 'coach' | 'studio' =
    settings.mode === 'minimal' ? 'minimal' : settings.mode === 'studio' ? 'studio' : 'coach';
  return {
    coachingMode,
    deliveryStyle: settings.deliveryStyle,
    targetWpmLow: settings.targetWpmLow,
    targetWpmHigh: settings.targetWpmHigh,
    targetVarietyLow: settings.targetVarietyLow,
    targetVarietyHigh: settings.targetVarietyHigh,
    liveTipFrequency: settings.liveTipFrequency,
  };
}

export type { CoachingSettings, DeliveryStyle };
