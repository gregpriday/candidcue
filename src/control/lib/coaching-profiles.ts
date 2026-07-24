/**
 * Live-coaching option catalogue, defaults and clamping (companion §30).
 *
 * The same relationship `lib/follow-profiles.ts` has with §47: the panel binds
 * to *understandable choices*, and every preset resolves here into the numeric
 * bands the analyzers consume (§14.6 pace, §17.6 variety). Nothing in this
 * module talks to Tauri, so both directions of the settings adapter and every
 * label in the panel are unit-testable without a runtime.
 *
 * Copy that the specification writes out verbatim — the four filler-detection
 * labels of §30.2 — is reproduced verbatim. It exists to state the cost and
 * recall trade-off honestly, and paraphrasing it is how that gets lost.
 */
import type {
  CoachRailMode,
  CoachingGoals,
  CoachingSettings,
  DeliveryStyle,
  FillerDetectionScope,
  PaceTargetPreset,
  PrecisionTranscriptionMode,
} from '../../shared/contracts';

export interface CoachingOption<T extends string> {
  value: T;
  label: string;
  description: string;
}

/* ---------------------------------------------------------------------------
 * §6 coaching modes
 * ------------------------------------------------------------------------- */

export const COACHING_MODES: readonly CoachRailMode[] = [
  'off',
  'minimal',
  'coach',
  'studio',
  'review_only',
  'custom',
];

export const COACHING_MODE_OPTIONS: Array<CoachingOption<CoachRailMode>> = [
  {
    value: 'off',
    label: 'Off',
    description:
      'No coaching rail and no analysis. Critical microphone and transcription failures still reach you through the usual system notices.',
  },
  {
    value: 'minimal',
    label: 'Minimal',
    description:
      'Pace and critical problems only — no filler ribbon, no variety, no ordinary tips.',
  },
  {
    value: 'coach',
    label: 'Coach',
    description:
      'The default. Pace, one actionable tip when it is warranted, this take’s confirmed filler count, a subtle event ribbon and microphone alerts.',
  },
  {
    value: 'studio',
    label: 'Studio',
    description:
      'Everything in Coach plus the numeric variety score, a pace sparkline, a fuller ribbon and more frequent — still bounded — coaching.',
  },
  {
    value: 'review_only',
    label: 'Review only',
    description:
      'Nothing live except critical alerts. Everything you have enabled is still measured and waiting in the post-take report.',
  },
  {
    value: 'custom',
    label: 'Custom',
    description: 'Choose the individual modules yourself.',
  },
];

/**
 * §6. The module flags a named mode implies. `custom` is the only mode that
 * reads the stored flags, so switching to a named mode and back must not
 * destroy the custom set — the panel keeps `modules` untouched and the rail
 * resolves them through `railModulesFromSettings`.
 */
export const MODE_MODULE_PRESETS: Record<
  Exclude<CoachRailMode, 'custom'>,
  CoachingSettings['modules']
> = {
  off: {
    paceNumber: false,
    paceStatus: false,
    targetDurationStatus: false,
    varietyScore: false,
    fillerCount: false,
    fillerRibbon: false,
    inlineGutterMarks: false,
    liveTips: false,
    deliveryScore: false,
  },
  minimal: {
    paceNumber: true,
    paceStatus: true,
    targetDurationStatus: false,
    varietyScore: false,
    fillerCount: false,
    fillerRibbon: false,
    inlineGutterMarks: false,
    liveTips: false,
    deliveryScore: false,
  },
  coach: {
    paceNumber: true,
    paceStatus: true,
    targetDurationStatus: true,
    varietyScore: false,
    fillerCount: true,
    fillerRibbon: true,
    inlineGutterMarks: false,
    liveTips: true,
    deliveryScore: true,
  },
  studio: {
    paceNumber: true,
    paceStatus: true,
    targetDurationStatus: true,
    varietyScore: true,
    fillerCount: true,
    fillerRibbon: true,
    inlineGutterMarks: true,
    liveTips: true,
    deliveryScore: true,
  },
  review_only: {
    paceNumber: false,
    paceStatus: false,
    targetDurationStatus: false,
    varietyScore: false,
    fillerCount: false,
    fillerRibbon: false,
    inlineGutterMarks: false,
    liveTips: false,
    deliveryScore: false,
  },
};

/* ---------------------------------------------------------------------------
 * §14.6 pace target presets
 * ------------------------------------------------------------------------- */

export const PACE_PRESETS: readonly PaceTargetPreset[] = [
  'calm_explainer',
  'natural_presentation',
  'conversational_camera',
  'energetic_short_form',
  'custom',
];

/** §14.6, verbatim bands. `custom` carries no band — the user's numbers stand. */
export const PACE_PRESET_BANDS: Record<
  Exclude<PaceTargetPreset, 'custom'>,
  { lowWpm: number; highWpm: number }
> = {
  calm_explainer: { lowWpm: 110, highWpm: 145 },
  natural_presentation: { lowWpm: 115, highWpm: 160 },
  conversational_camera: { lowWpm: 130, highWpm: 170 },
  energetic_short_form: { lowWpm: 150, highWpm: 190 },
};

export const PACE_PRESET_OPTIONS: Array<CoachingOption<PaceTargetPreset>> = [
  {
    value: 'calm_explainer',
    label: 'Calm explainer',
    description: '110–145 wpm. Reflective, instructional, premium presentation.',
  },
  {
    value: 'natural_presentation',
    label: 'Natural presentation',
    description: '115–160 wpm. The broad default.',
  },
  {
    value: 'conversational_camera',
    label: 'Conversational camera',
    description: '130–170 wpm. Direct-to-camera delivery.',
  },
  {
    value: 'energetic_short_form',
    label: 'Energetic short-form',
    description: '150–190 wpm. Fast, concise social and video content.',
  },
  {
    value: 'custom',
    label: 'Custom',
    description: 'Your own range, for an exact production requirement.',
  },
];

/** Absolute bounds on a hand-authored pace range. Rust validates the same pair. */
export const PACE_WPM_MIN = 60;
export const PACE_WPM_MAX = 260;
/** A band narrower than this cannot be held by any real speaker. */
export const PACE_WPM_MIN_SPAN = 5;

/* ---------------------------------------------------------------------------
 * §17.6 vocal style → variety band
 * ------------------------------------------------------------------------- */

export const DELIVERY_STYLES: readonly DeliveryStyle[] = [
  'calm',
  'natural',
  'conversational',
  'expressive',
  'broadcast',
  'custom',
];

/**
 * §17.6, provisional bands on CandidCue's own 0–100 variety scale.
 *
 * `DeliveryStyle` splits §17.6's "Natural / conversational" row into two
 * values, so both map onto that row's band; the difference between them is the
 * label the speaker recognises, not a different measurement.
 */
export const STYLE_VARIETY_BANDS: Record<
  Exclude<DeliveryStyle, 'custom'>,
  { low: number; high: number }
> = {
  calm: { low: 35, high: 60 },
  natural: { low: 45, high: 75 },
  conversational: { low: 45, high: 75 },
  expressive: { low: 55, high: 85 },
  broadcast: { low: 40, high: 65 },
};

export const DELIVERY_STYLE_OPTIONS: Array<CoachingOption<DeliveryStyle>> = [
  {
    value: 'calm',
    label: 'Calm / authoritative',
    description: 'Controlled and steady, with selective emphasis. Variety target 35–60.',
  },
  {
    value: 'natural',
    label: 'Natural',
    description: 'Noticeable movement without performance exaggeration. Variety target 45–75.',
  },
  {
    value: 'conversational',
    label: 'Conversational',
    description: 'The same band as Natural, described the way a direct-to-camera read feels.',
  },
  {
    value: 'expressive',
    label: 'Expressive / story',
    description: 'Larger pitch, energy and tempo contrasts. Variety target 55–85.',
  },
  {
    value: 'broadcast',
    label: 'Broadcast / neutral',
    description: 'Polished consistency with clear sentence shaping. Variety target 40–65.',
  },
  {
    value: 'custom',
    label: 'Custom',
    description: 'Your own variety band, chosen for the production.',
  },
];

export const VARIETY_MIN = 0;
export const VARIETY_MAX = 100;
export const VARIETY_MIN_SPAN = 5;

/* ---------------------------------------------------------------------------
 * §29.3 / §30.2 filler detection
 * ------------------------------------------------------------------------- */

export const PRECISION_MODES: readonly PrecisionTranscriptionMode[] = [
  'off',
  'on_candidates',
  'full',
  'review_only',
];

/**
 * §30.2's copy, verbatim, attached to the mode it describes.
 *
 * "Basic" is `off` and "Precision" is the other three. The specification gives
 * one Precision paragraph for what §29.3 splits into three cost modes, so the
 * shared paragraph is the description and each mode adds the one sentence that
 * distinguishes it — including, per §29.3, that Full precision spends the
 * user's own API key on every eligible chunk.
 */
export const PRECISION_MODE_OPTIONS: Array<CoachingOption<PrecisionTranscriptionMode>> = [
  {
    value: 'off',
    label: 'Basic',
    description:
      'Uses the live transcript and local audio cues. Fast and inexpensive, but some fillers may be missed.',
  },
  {
    value: 'on_candidates',
    label: 'Precision — on candidates',
    description:
      'Runs short audio segments through an additional verbatim transcription pass. Better filler and false-start detection, with extra API usage and a small delay. Only segments that sounded ambiguous are sent.',
  },
  {
    value: 'full',
    label: 'Precision — full',
    description:
      'Runs short audio segments through an additional verbatim transcription pass. Better filler and false-start detection, with extra API usage and a small delay. Every eligible speech segment is sent, which makes additional OpenAI transcription calls on your API key throughout the take.',
  },
  {
    value: 'review_only',
    label: 'Precision — after the take',
    description:
      'Runs short audio segments through an additional verbatim transcription pass. Better filler and false-start detection, with extra API usage and a small delay. Segments are sent after the take or during idle moments, so nothing competes with the live rail.',
  },
];

export const FILLER_SCOPES: readonly FillerDetectionScope[] = ['strict', 'broad'];

/** §30.2, verbatim. */
export const FILLER_SCOPE_OPTIONS: Array<CoachingOption<FillerDetectionScope>> = [
  {
    value: 'strict',
    label: 'Strict only',
    description: 'Counts clear fillers such as “um,” “uh,” “er,” and “erm.”',
  },
  {
    value: 'broad',
    label: 'Broad',
    description:
      'Also evaluates contextual phrases such as “you know,” “like,” and repeated sentence openers. Contextual items require higher confidence.',
  },
];

export const TIP_FREQUENCIES = ['low', 'normal', 'high'] as const;

export const TIP_FREQUENCY_OPTIONS: Array<CoachingOption<'low' | 'normal' | 'high'>> = [
  { value: 'low', label: 'Rarely', description: 'Only when something really needs saying.' },
  { value: 'normal', label: 'Normal', description: 'The default cadence.' },
  {
    value: 'high',
    label: 'Often',
    description: 'More tips, still bounded by the rail’s cooldowns.',
  },
];

/* ---------------------------------------------------------------------------
 * Custom filler words (§30.1)
 * ------------------------------------------------------------------------- */

/**
 * Normalize a user's filler list: trimmed, lower-cased, de-duplicated, order
 * preserved.
 *
 * There is deliberately **no cap**. These are the speaker's own habits and
 * CandidCue has no basis for deciding that the twenty-first one does not
 * count. The panel reports the count for information only.
 */
export function normalizeFillerWords(words: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of words) {
    const word = raw.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!word || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
  }
  return out;
}

/** Split the comma-separated field the panel edits. */
export function parseFillerWords(text: string): string[] {
  return normalizeFillerWords(text.split(','));
}

export function formatFillerWords(words: readonly string[]): string {
  return words.join(', ');
}

/* ---------------------------------------------------------------------------
 * Target duration (§30.1)
 * ------------------------------------------------------------------------- */

/**
 * Parse "3:30", "3m30", "210" (seconds) or "3.5" (minutes) into seconds.
 *
 * Returns `null` for empty or unparseable input, which is the same value as
 * "no target". `0` is deliberately impossible: a zero-second budget is blown
 * before the take starts, and would show a permanent overrun.
 */
export function parseTargetDuration(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const clock = /^(\d{1,3}):([0-5]?\d)$/.exec(trimmed);
  if (clock) {
    const seconds = Number(clock[1]) * 60 + Number(clock[2]);
    return seconds > 0 ? seconds : null;
  }
  const bare = Number(trimmed);
  if (!Number.isFinite(bare) || bare <= 0) return null;
  // A bare number is minutes — the unit a script's length is discussed in.
  return Math.round(bare * 60);
}

/** "3:30", or an empty string when there is no target. */
export function formatTargetDuration(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return '';
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

/* ---------------------------------------------------------------------------
 * Defaults (§30, §32.1)
 * ------------------------------------------------------------------------- */

export function defaultCoachingGoals(): CoachingGoals {
  return {
    maxFillersPerMinute: null,
    maxFillersPerHundredWords: null,
    paceWithinTargetRange: false,
    finishWithinTargetDuration: false,
    varietyWithinTargetBand: false,
  };
}

export function defaultCoachingSettings(): CoachingSettings {
  return {
    mode: 'coach', // §6.3 "Coach — default"
    deliveryStyle: 'natural',
    pacePreset: 'natural_presentation', // §14.6 "broad default"
    targetWpmLow: PACE_PRESET_BANDS.natural_presentation.lowWpm,
    targetWpmHigh: PACE_PRESET_BANDS.natural_presentation.highWpm,
    targetVarietyLow: STYLE_VARIETY_BANDS.natural.low,
    targetVarietyHigh: STYLE_VARIETY_BANDS.natural.high,
    targetDurationSeconds: null,
    liveTipFrequency: 'normal',
    // §32.1: coaching sends bounded extra audio only when the user asks it to.
    precisionTranscriptionMode: 'off',
    fillerDetectionScope: 'strict',
    customFillerWords: [],
    trackRepeatedOpeners: false,
    positiveReinforcementEnabled: false, // §25.6
    postTakeReportEnabled: false, // §32.1 metrics are session-only unless asked
    retainAudioRecordingEnabled: false, // §32.1/§32.2 — audio stays memory-only
    personalCalibrationEnabled: false, // §17.7 opt-in
    personalCalibrationResetAtEpochMs: null,
    goals: defaultCoachingGoals(),
    railTextScale: 1,
    modules: { ...MODE_MODULE_PRESETS.coach },
  };
}

/* ---------------------------------------------------------------------------
 * Clamping
 * ------------------------------------------------------------------------- */

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** A goal threshold, or `null` when the goal is not set. Never a bare 0. */
function goalThreshold(value: unknown, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.min(max, Math.round(value * 10) / 10);
}

/** The band a preset implies, or the user's own numbers under `custom`. */
export function resolvedPaceBand(settings: CoachingSettings): { lowWpm: number; highWpm: number } {
  if (settings.pacePreset === 'custom') {
    return { lowWpm: settings.targetWpmLow, highWpm: settings.targetWpmHigh };
  }
  return PACE_PRESET_BANDS[settings.pacePreset];
}

export function resolvedVarietyBand(settings: CoachingSettings): { low: number; high: number } {
  if (settings.deliveryStyle === 'custom') {
    return { low: settings.targetVarietyLow, high: settings.targetVarietyHigh };
  }
  return STYLE_VARIETY_BANDS[settings.deliveryStyle];
}

/**
 * Coerce any partial/untrusted document into a valid `CoachingSettings`.
 *
 * Ordering matters: a preset's band wins over stored numbers, because the
 * preset is what the user chose and the numbers are only authoritative under
 * `custom`. A document that says "Calm explainer, 150–190 wpm" is a document
 * whose numbers were written by an older build.
 */
export function clampCoaching(
  value: Partial<CoachingSettings> | undefined | null,
): CoachingSettings {
  const defaults = defaultCoachingSettings();
  if (!value) return defaults;

  const mode = pick(value.mode, COACHING_MODES, defaults.mode);
  const pacePreset = pick(value.pacePreset, PACE_PRESETS, defaults.pacePreset);
  const deliveryStyle = pick(value.deliveryStyle, DELIVERY_STYLES, defaults.deliveryStyle);

  let lowWpm: number;
  let highWpm: number;
  if (pacePreset === 'custom') {
    lowWpm = num(value.targetWpmLow, defaults.targetWpmLow, PACE_WPM_MIN, PACE_WPM_MAX);
    highWpm = num(value.targetWpmHigh, defaults.targetWpmHigh, PACE_WPM_MIN, PACE_WPM_MAX);
    if (highWpm < lowWpm + PACE_WPM_MIN_SPAN) highWpm = lowWpm + PACE_WPM_MIN_SPAN;
    if (highWpm > PACE_WPM_MAX) {
      highWpm = PACE_WPM_MAX;
      lowWpm = Math.min(lowWpm, PACE_WPM_MAX - PACE_WPM_MIN_SPAN);
    }
  } else {
    ({ lowWpm, highWpm } = PACE_PRESET_BANDS[pacePreset]);
  }

  let varietyLow: number;
  let varietyHigh: number;
  if (deliveryStyle === 'custom') {
    varietyLow = num(value.targetVarietyLow, defaults.targetVarietyLow, VARIETY_MIN, VARIETY_MAX);
    varietyHigh = num(
      value.targetVarietyHigh,
      defaults.targetVarietyHigh,
      VARIETY_MIN,
      VARIETY_MAX,
    );
    if (varietyHigh < varietyLow + VARIETY_MIN_SPAN) varietyHigh = varietyLow + VARIETY_MIN_SPAN;
    if (varietyHigh > VARIETY_MAX) {
      varietyHigh = VARIETY_MAX;
      varietyLow = Math.min(varietyLow, VARIETY_MAX - VARIETY_MIN_SPAN);
    }
  } else {
    const band = STYLE_VARIETY_BANDS[deliveryStyle];
    varietyLow = band.low;
    varietyHigh = band.high;
  }

  const duration = value.targetDurationSeconds;
  const targetDurationSeconds =
    typeof duration === 'number' && Number.isFinite(duration) && duration > 0
      ? Math.round(Math.min(6 * 60 * 60, duration))
      : null;

  const resetAt = value.personalCalibrationResetAtEpochMs;
  const personalCalibrationResetAtEpochMs =
    typeof resetAt === 'number' && Number.isFinite(resetAt) && resetAt > 0
      ? Math.round(resetAt)
      : null;

  const goals: Partial<CoachingGoals> = value.goals ?? {};
  const modules: Partial<CoachingSettings['modules']> = value.modules ?? {};
  const defaultModules = defaults.modules;

  return {
    mode,
    deliveryStyle,
    pacePreset,
    targetWpmLow: lowWpm,
    targetWpmHigh: highWpm,
    targetVarietyLow: varietyLow,
    targetVarietyHigh: varietyHigh,
    targetDurationSeconds,
    liveTipFrequency: pick(value.liveTipFrequency, TIP_FREQUENCIES, defaults.liveTipFrequency),
    precisionTranscriptionMode: pick(
      value.precisionTranscriptionMode,
      PRECISION_MODES,
      defaults.precisionTranscriptionMode,
    ),
    fillerDetectionScope: pick(
      value.fillerDetectionScope,
      FILLER_SCOPES,
      defaults.fillerDetectionScope,
    ),
    customFillerWords: Array.isArray(value.customFillerWords)
      ? normalizeFillerWords(value.customFillerWords.filter((w) => typeof w === 'string'))
      : defaults.customFillerWords,
    trackRepeatedOpeners: bool(value.trackRepeatedOpeners, defaults.trackRepeatedOpeners),
    positiveReinforcementEnabled: bool(
      value.positiveReinforcementEnabled,
      defaults.positiveReinforcementEnabled,
    ),
    postTakeReportEnabled: bool(value.postTakeReportEnabled, defaults.postTakeReportEnabled),
    // A non-boolean here reads as off. This is a retention consent: the safe
    // side of "I could not understand the stored value" is "do not keep audio".
    retainAudioRecordingEnabled: bool(value.retainAudioRecordingEnabled, false),
    personalCalibrationEnabled: bool(
      value.personalCalibrationEnabled,
      defaults.personalCalibrationEnabled,
    ),
    personalCalibrationResetAtEpochMs,
    goals: {
      maxFillersPerMinute: goalThreshold(goals.maxFillersPerMinute, 60),
      maxFillersPerHundredWords: goalThreshold(goals.maxFillersPerHundredWords, 100),
      paceWithinTargetRange: bool(goals.paceWithinTargetRange, false),
      finishWithinTargetDuration: bool(goals.finishWithinTargetDuration, false),
      varietyWithinTargetBand: bool(goals.varietyWithinTargetBand, false),
    },
    railTextScale: num(value.railTextScale, defaults.railTextScale, 0.8, 1.5),
    modules: {
      paceNumber: bool(modules.paceNumber, defaultModules.paceNumber),
      paceStatus: bool(modules.paceStatus, defaultModules.paceStatus),
      targetDurationStatus: bool(modules.targetDurationStatus, defaultModules.targetDurationStatus),
      varietyScore: bool(modules.varietyScore, defaultModules.varietyScore),
      fillerCount: bool(modules.fillerCount, defaultModules.fillerCount),
      fillerRibbon: bool(modules.fillerRibbon, defaultModules.fillerRibbon),
      inlineGutterMarks: bool(modules.inlineGutterMarks, defaultModules.inlineGutterMarks),
      liveTips: bool(modules.liveTips, defaultModules.liveTips),
      deliveryScore: bool(modules.deliveryScore, defaultModules.deliveryScore),
    },
  };
}

/* ---------------------------------------------------------------------------
 * §32.2 retention statement
 * ------------------------------------------------------------------------- */

/**
 * §32.2 "The UI must state exactly what is retained."
 *
 * Deliberately the same shape and the same rule as
 * `shared/coaching/review/report-store.ts`'s `retentionStatement`: one line per
 * consent, always, whatever the combination. That function states what a
 * *finished take* kept; this one states what the *settings* will keep, before
 * a take exists. Two policies would be one policy too many, so the wording of
 * each line matches its counterpart there.
 *
 * The transcript consent is `privacy.saveTranscript` (§36.2), which is a
 * retention *window* rather than a boolean and lives with the other Rust-owned
 * privacy settings; it is passed in so this panel can state all three.
 */
export function coachingRetentionLines(
  settings: Pick<CoachingSettings, 'postTakeReportEnabled' | 'retainAudioRecordingEnabled'>,
  transcriptRetention: string,
): string[] {
  const transcriptOn = transcriptRetention !== 'off';
  return [
    settings.postTakeReportEnabled
      ? 'Your coaching measurements are saved on this device, in CandidCue’s database.'
      : 'Your coaching measurements are not saved. They exist only while the take is open.',
    transcriptOn
      ? `The transcript of what you said is saved on this device (${transcriptRetention === 'forever' ? 'kept until you delete it' : `kept for ${transcriptRetention}`}).`
      : 'The transcript is not saved, and words heard but not scripted are not kept.',
    settings.retainAudioRecordingEnabled
      ? 'A recording of your voice is written to this device, in CandidCue’s application data folder. It is never uploaded anywhere except the live transcription your session already uses.'
      : 'No audio is saved. Audio stays in memory for the length of the take and is discarded.',
  ];
}
