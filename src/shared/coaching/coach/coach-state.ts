/**
 * §27. Assembly of {@link CoachRailState} — the only coaching payload that
 * crosses into the stage window.
 *
 * §2.1 / Rule 1 is enforced by omission and it is worth being explicit about
 * what that means here: this module has **no import of, reference to, or
 * argument for** a scroll offset, cursor index, unit id, section id, or motion
 * directive. It cannot move the script because it has nothing to move it with.
 * If a future requirement appears to need one, the requirement belongs in the
 * tracking specification, not in this file.
 *
 * The builder also owns the two things the stage refuses to do for us: a
 * strictly increasing `stageRevision`, and a bounded `ribbonEvents` array
 * ("Bounded by the producer; the stage does not trim").
 */
import type {
  CoachGutterMark,
  DeliveryScoreState,
  CoachRailMode,
  CoachRailModules,
  CoachRailState,
  CoachRailTip,
  CoachRibbonEvent,
  FillerDisplayState,
  MicrophoneCoachState,
  PaceDisplayState,
  VarietyDisplayState,
} from '../../contracts/coaching';
import type { Uuid } from '../../contracts/core';

/** §44.4: the ribbon shows the last 30 seconds. */
export const RIBBON_WINDOW_MS = 30_000;
/** Hard cap regardless of the window, so a pathological take cannot grow it. */
export const RIBBON_MAX_EVENTS = 120;

export interface CoachRailInputs {
  sessionId: Uuid;
  takePassId: string;
  mode: CoachRailMode;
  visible: boolean;
  mirrored: boolean;
  reducedMotion: boolean;
  pace: PaceDisplayState;
  variety: VarietyDisplayState;
  fillers: FillerDisplayState;
  microphone: MicrophoneCoachState;
  /** §9.1: at most one. `null` is the ordinary case (§2.6). */
  activeTip: CoachRailTip | null;
  ribbonEvents: readonly CoachRibbonEvent[];
  /** Audio clock. Windows the ribbon and is published so the stage need not estimate it. */
  audioTimeMs: number;
  /** §11 marks for already-read lines. Ignored unless the mode enables them. */
  gutterMarks?: readonly CoachGutterMark[];
  /**
   * The delivery score. Omitted or `null` means scoring is not running for this
   * take, which the rail must not confuse with a score that exists and is still
   * warming up.
   */
  score?: DeliveryScoreState | null;
  /**
   * §6.6 custom-mode module toggles. Required when `mode` is `'custom'`;
   * ignored otherwise, because the named modes define their own flags.
   */
  customModules?: Partial<CoachRailModules>;
}

const ALL_OFF: CoachRailModules = {
  paceNumber: false,
  paceStatus: false,
  paceSparkline: false,
  targetDurationStatus: false,
  varietyScore: false,
  varietyLabel: false,
  fillerCount: false,
  fillerRibbon: false,
  gutterMarks: false,
  liveTips: false,
  deliveryScore: false,
};

/**
 * §6.1–§6.6. The single authoritative reading of each mode.
 *
 * This lives on the producer so there is one interpretation rather than one
 * per consumer. The stage receives the resolved flags and renders them; it
 * never decides what a mode means, which is what previously made `custom`
 * indistinguishable from `coach` on the glass.
 */
export function resolveRailModules(
  mode: CoachRailMode,
  custom?: Partial<CoachRailModules>,
): CoachRailModules {
  switch (mode) {
    // §6.1 / §6.5: no live rail. Critical microphone and transcription faults
    // still reach the user through the app's system-notice mechanism, which is
    // not the rail — so nothing is enabled here.
    case 'off':
    case 'review_only':
      return { ...ALL_OFF };
    // §6.2: pace and critical alerts only — no fillers, no variety, no tips.
    case 'minimal':
      return { ...ALL_OFF, paceNumber: true, paceStatus: true, targetDurationStatus: true };
    // §6.3: the default.
    case 'coach':
      return {
        ...ALL_OFF,
        paceNumber: true,
        paceStatus: true,
        targetDurationStatus: true,
        varietyLabel: true,
        fillerCount: true,
        fillerRibbon: true,
        liveTips: true,
        deliveryScore: true,
      };
    // §6.4: everything in Coach plus the numeric score, sparkline and marks.
    case 'studio':
      return {
        paceNumber: true,
        paceStatus: true,
        paceSparkline: true,
        targetDurationStatus: true,
        varietyScore: true,
        varietyLabel: true,
        fillerCount: true,
        fillerRibbon: true,
        gutterMarks: true,
        liveTips: true,
        deliveryScore: true,
      };
    // §6.6: start from nothing and enable exactly what the user chose. Starting
    // from Coach would silently re-enable a module the user had turned off.
    case 'custom':
      return { ...ALL_OFF, ...custom };
  }
}

/**
 * §27.4. Keep the trailing window, drop other take passes, cap the count.
 * Oldest first, matching the contract.
 */
export function boundRibbon(
  events: readonly CoachRibbonEvent[],
  audioTimeMs: number,
  takePassId: string,
  windowMs: number = RIBBON_WINDOW_MS,
  maxEvents: number = RIBBON_MAX_EVENTS,
): CoachRibbonEvent[] {
  const cutoff = audioTimeMs - windowMs;
  const kept = events.filter((event) => event.takePassId === takePassId && event.endMs >= cutoff);
  kept.sort((a, b) => a.startMs - b.startMs);
  return kept.length <= maxEvents ? kept : kept.slice(kept.length - maxEvents);
}

/**
 * Emits monotonically increasing snapshots for one session. The stage rejects
 * a non-increasing revision as stale, so the counter must never restart —
 * including across take passes, which is why it lives on the builder and not
 * on the per-take policy.
 */
export class CoachRailStateBuilder {
  private revision = 0;

  constructor(private readonly sessionId: Uuid) {}

  get lastRevision(): number {
    return this.revision;
  }

  build(inputs: CoachRailInputs): CoachRailState {
    if (inputs.sessionId !== this.sessionId) {
      // A snapshot for a different session would be rejected on arrival;
      // producing one is a programming error, not a runtime condition.
      throw new Error('coach rail snapshot built for a foreign session');
    }
    this.revision += 1;
    const activeTip = inputs.activeTip;
    const modules = resolveRailModules(inputs.mode, inputs.customModules);
    return {
      schemaVersion: 1,
      stageRevision: this.revision,
      sessionId: inputs.sessionId,
      takePassId: inputs.takePassId,
      mode: inputs.mode,
      modules,
      audioTimeMs: inputs.audioTimeMs,
      visible: inputs.visible,
      mirrored: inputs.mirrored,
      reducedMotion: inputs.reducedMotion,
      pace: inputs.pace,
      variety: inputs.variety,
      fillers: inputs.fillers,
      microphone: inputs.microphone,
      // §9.1 and §5.4: a tip from another take pass is not shown, even if the
      // policy somehow still held it.
      activeTip:
        activeTip !== null && activeTip.takePassId === inputs.takePassId
          ? { ...activeTip, interpolations: { ...activeTip.interpolations } }
          : null,
      ribbonEvents: boundRibbon(inputs.ribbonEvents, inputs.audioTimeMs, inputs.takePassId),
      // §11.3: marks from an earlier pass over the same line must not be
      // conflated with this one, and the feature stays empty when disabled
      // rather than shipping data the stage is not allowed to draw.
      gutterMarks: modules.gutterMarks
        ? (inputs.gutterMarks ?? []).filter((mark) => mark.takePassId === inputs.takePassId)
        : [],
      // Withheld rather than zeroed when the mode disables it: a score of 0 is
      // a judgement, and "not scored" is not a judgement.
      score: modules.deliveryScore ? (inputs.score ?? null) : null,
    };
  }
}

/** §27.1. The honest "we do not know yet" pace tile — `null`, never `0`. */
export function initialPaceState(targetLowWpm: number, targetHighWpm: number): PaceDisplayState {
  return {
    wpm: null,
    confidence: 0,
    state: 'learning',
    targetLowWpm,
    targetHighWpm,
    targetDurationMs: null,
    projectedFinishDeltaMs: null,
    recentSeries: [],
  };
}

/** §27.2. */
export function initialVarietyState(targetLow: number, targetHigh: number): VarietyDisplayState {
  return {
    level: null,
    confidence: 0,
    state: 'learning',
    targetLow,
    targetHigh,
    pitchSpanSemitones: null,
    energyRangeDb: null,
  };
}

/** §8.4. */
export function initialFillerState(): FillerDisplayState {
  return {
    confirmedCount: 0,
    confirmedLast20s: 0,
    confirmedLast60s: 0,
    dominantForm: null,
    degraded: false,
  };
}

/** §12.7. */
export function initialMicrophoneState(): MicrophoneCoachState {
  return {
    status: 'learning',
    levelDbfs: null,
    snrDb: null,
    sustained: false,
    transcriptionDegraded: false,
  };
}
