/**
 * §19.4 / §19.5 — turning authored script directives into coaching facts.
 *
 * The compiler resolves `<!-- cc:… -->` comments and `coach:` front matter to
 * span ids and validated values (`CompiledScript.coaching`). This module is the
 * other half of that seam: it decides what those values *mean* to the analyzers,
 * and it is the only place that decision is written down.
 *
 * ---------------------------------------------------------------------------
 * WHY THE MAPPING IS INDIRECT
 * ---------------------------------------------------------------------------
 * `cc:pace 150-190` does not retune the pace band. §14.7's band lives in the
 * analyzer's profile and carries hysteresis and dwell state across updates;
 * swapping it mid-take would make the state machine's history describe a band
 * that no longer exists. What §14.8 *does* offer is exactly the pair of
 * suppressions an authored pace annotation is asking for — "do not tell me to
 * slow down, I meant this" and "do not tell me to lift the pace, I meant this"
 * — so an authored band is compared against the session's band and expressed
 * through those.
 *
 * The consequence is worth stating plainly: an authored band that sits *inside*
 * the session's band changes nothing, because there is nothing to suppress. The
 * author asked for a pace the settings already consider on target.
 */
import type {
  CoachDirectiveStyle,
  CoachFrontMatter,
  CompiledCoachingDirectives,
} from '../../contracts';
import type { CoachingSettings } from '../../contracts/coaching';
import { PACE_TARGET_BANDS } from '../pace/pace-analyzer';
import { RESTRAINED_STYLES } from '../prosody/variety-score';

/**
 * The host-state facts a compiled script implies, indexed by authored span.
 *
 * Every set is keyed by {@link SentenceUnit} id, which is what the coaching
 * subsystem means by a *script span* and what `activeScriptSpanId` carries.
 */
export interface ScriptDirectiveMap {
  /** §19.4 `cc:coach off`. No coaching evidence may be raised for these. */
  coachingDisabledSpanIds: ReadonlySet<string>;
  /** §17.9. A restrained authored style is an authored variety directive. */
  suppressVarietySpanIds: ReadonlySet<string>;
  /** §14.8. The author asked for a slower read than the session targets. */
  suppressSlowTipSpanIds: ReadonlySet<string>;
  /** §14.8. The author asked for a faster read than the session targets. */
  authoredFastSpanIds: ReadonlySet<string>;
  /** §15.5 `cc:filler intentional`. Authored disfluency, not a mistake. */
  intentionalFillerSpanIds: ReadonlySet<string>;
}

const NO_SPANS: ReadonlySet<string> = new Set<string>();

export const EMPTY_SCRIPT_DIRECTIVES: ScriptDirectiveMap = {
  coachingDisabledSpanIds: NO_SPANS,
  suppressVarietySpanIds: NO_SPANS,
  suppressSlowTipSpanIds: NO_SPANS,
  authoredFastSpanIds: NO_SPANS,
  intentionalFillerSpanIds: NO_SPANS,
};

/** The pace band a span asks for, from an explicit range or a named style. */
function bandFor(span: {
  paceLowWpm?: number;
  paceHighWpm?: number;
  style?: CoachDirectiveStyle;
}): { lowWpm: number; highWpm: number } | null {
  if (span.paceLowWpm !== undefined && span.paceHighWpm !== undefined) {
    return { lowWpm: span.paceLowWpm, highWpm: span.paceHighWpm };
  }
  if (span.style) return PACE_TARGET_BANDS[span.style];
  return null;
}

/**
 * Resolve compiled directives against the session's effective targets.
 *
 * `targets` must be the settings the session will actually run with — apply
 * {@link applyCoachFrontMatter} first, or a script that moves its own band in
 * front matter will be measured against the band it just replaced.
 */
export function resolveScriptDirectives(
  coaching: CompiledCoachingDirectives | null | undefined,
  targets: Pick<CoachingSettings, 'targetWpmLow' | 'targetWpmHigh'>,
): ScriptDirectiveMap {
  const spans = coaching?.spans ?? [];
  if (spans.length === 0) return EMPTY_SCRIPT_DIRECTIVES;

  const coachingDisabledSpanIds = new Set<string>();
  const suppressVarietySpanIds = new Set<string>();
  const suppressSlowTipSpanIds = new Set<string>();
  const authoredFastSpanIds = new Set<string>();
  const intentionalFillerSpanIds = new Set<string>();

  for (const span of spans) {
    if (span.coachingOff === true) coachingDisabledSpanIds.add(span.spanId);
    if (span.fillerIntentional === true) intentionalFillerSpanIds.add(span.spanId);
    if (span.style && RESTRAINED_STYLES.has(span.style)) {
      suppressVarietySpanIds.add(span.spanId);
    }
    const band = bandFor(span);
    if (!band) continue;
    // `>=` / `<=` rather than `>` / `<`: an authored band that reaches the
    // session's own edge is already a claim about that edge, and the author
    // who wrote it is not asking to be told about it.
    if (band.highWpm >= targets.targetWpmHigh) authoredFastSpanIds.add(span.spanId);
    if (band.lowWpm <= targets.targetWpmLow) suppressSlowTipSpanIds.add(span.spanId);
  }

  return {
    coachingDisabledSpanIds,
    suppressVarietySpanIds,
    suppressSlowTipSpanIds,
    authoredFastSpanIds,
    intentionalFillerSpanIds,
  };
}

/**
 * Overlay §19.5 `coach:` front matter onto the persisted coaching settings.
 *
 * Front matter wins for this script, because it *is* the author's decision
 * about this script — with two deliberate exceptions that it may not touch at
 * all, and which are therefore absent from {@link CoachFrontMatter}:
 *
 *  - `precisionTranscriptionMode`, because it spends the user's own API budget;
 *  - `retainAudioRecordingEnabled`, because it decides whether audio is kept.
 *
 * A script file may arrive from anywhere. Nothing that costs money or retains
 * a recording is settable from one.
 */
export function applyCoachFrontMatter(
  settings: CoachingSettings,
  frontMatter: CoachFrontMatter | null | undefined,
): CoachingSettings {
  if (!frontMatter) return settings;
  const next: CoachingSettings = { ...settings };
  if (frontMatter.mode !== undefined) next.mode = frontMatter.mode;
  if (frontMatter.style !== undefined) next.deliveryStyle = frontMatter.style;
  if (frontMatter.targetWpm) {
    next.targetWpmLow = frontMatter.targetWpm[0];
    next.targetWpmHigh = frontMatter.targetWpm[1];
    // §14.6: explicit numbers are by definition not one of the named presets.
    next.pacePreset = 'custom';
  }
  if (frontMatter.targetVariety) {
    next.targetVarietyLow = frontMatter.targetVariety[0];
    next.targetVarietyHigh = frontMatter.targetVariety[1];
  }
  if (frontMatter.targetDurationSeconds !== undefined) {
    next.targetDurationSeconds = frontMatter.targetDurationSeconds;
  }
  if (frontMatter.fillerDetection !== undefined) {
    next.fillerDetectionScope = frontMatter.fillerDetection;
  }
  if (frontMatter.liveTips !== undefined) next.liveTipFrequency = frontMatter.liveTips;
  if (frontMatter.positiveFeedback !== undefined) {
    next.positiveReinforcementEnabled = frontMatter.positiveFeedback;
  }
  return next;
}
