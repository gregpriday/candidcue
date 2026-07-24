/**
 * Coaching-settings adapter (companion §30) between the Rust settings document
 * and the UI view.
 *
 * These belong in Rust for the same reason the §47 following settings do, only
 * more so: three of them decide whether OpenAI is called at all
 * (`precisionTranscriptionMode`, §29.3) and two of them are *retention
 * consents* (§32.2). A consent that lived in localStorage would be lost by a
 * profile reset and would silently read as its default — which for audio would
 * mean "keep recording" if the default were ever flipped. They live in
 * `AppSettings.coaching` (src-tauri/src/settings/mod.rs).
 *
 * Both directions are pure functions over plain objects, so the round trip is
 * testable without a Tauri runtime — and it is tested, against the same
 * fixture Rust reads (`tests/fixtures/ipc/coaching-settings-payload.json`).
 */
import { clampCoaching, defaultCoachingSettings } from '../lib/coaching-profiles';
import type { CoachingSettings } from '../../shared/contracts';

/** Camel-cased twin of `settings::CoachingSettings` in Rust. */
export interface RustCoachingGoals {
  maxFillersPerMinute: number | null;
  maxFillersPerHundredWords: number | null;
  paceWithinTargetRange: boolean;
  finishWithinTargetDuration: boolean;
  varietyWithinTargetBand: boolean;
}

export interface RustCoachingModules {
  paceNumber: boolean;
  paceStatus: boolean;
  targetDurationStatus: boolean;
  varietyScore: boolean;
  fillerCount: boolean;
  fillerRibbon: boolean;
  inlineGutterMarks: boolean;
  liveTips: boolean;
}

export interface RustCoachingSettings {
  mode: string;
  deliveryStyle: string;
  pacePreset: string;
  targetWpmLow: number;
  targetWpmHigh: number;
  targetVarietyLow: number;
  targetVarietyHigh: number;
  /** `null` (Rust `None`) means "no target duration" — not zero. */
  targetDurationSeconds: number | null;
  liveTipFrequency: string;
  precisionTranscriptionMode: string;
  fillerDetectionScope: string;
  customFillerWords: string[];
  trackRepeatedOpeners: boolean;
  positiveReinforcementEnabled: boolean;
  postTakeReportEnabled: boolean;
  retainAudioRecordingEnabled: boolean;
  personalCalibrationEnabled: boolean;
  personalCalibrationResetAtEpochMs: number | null;
  goals: RustCoachingGoals;
  railTextScale: number;
  modules: RustCoachingModules;
}

/**
 * Rust → UI. A document written before this section existed yields the
 * defaults; unknown enum values clamp rather than throw, and a value the
 * clamp cannot understand falls to the *safe* side for the two consents.
 */
export function coachingFromRust(
  rust: Partial<RustCoachingSettings> | undefined,
): CoachingSettings {
  if (!rust) return defaultCoachingSettings();
  return clampCoaching({
    mode: rust.mode,
    deliveryStyle: rust.deliveryStyle,
    pacePreset: rust.pacePreset,
    targetWpmLow: rust.targetWpmLow,
    targetWpmHigh: rust.targetWpmHigh,
    targetVarietyLow: rust.targetVarietyLow,
    targetVarietyHigh: rust.targetVarietyHigh,
    targetDurationSeconds: rust.targetDurationSeconds ?? null,
    liveTipFrequency: rust.liveTipFrequency,
    precisionTranscriptionMode: rust.precisionTranscriptionMode,
    fillerDetectionScope: rust.fillerDetectionScope,
    customFillerWords: rust.customFillerWords,
    trackRepeatedOpeners: rust.trackRepeatedOpeners,
    positiveReinforcementEnabled: rust.positiveReinforcementEnabled,
    postTakeReportEnabled: rust.postTakeReportEnabled,
    retainAudioRecordingEnabled: rust.retainAudioRecordingEnabled,
    personalCalibrationEnabled: rust.personalCalibrationEnabled,
    personalCalibrationResetAtEpochMs: rust.personalCalibrationResetAtEpochMs ?? null,
    goals: rust.goals,
    railTextScale: rust.railTextScale,
    modules: rust.modules,
  } as Partial<CoachingSettings>);
}

/**
 * UI → Rust patch. Only the keys present in the patch are emitted, so a
 * concurrent write to another section is never clobbered.
 *
 * `null` is emitted, not dropped: Rust's `merge_json` removes a key whose patch
 * value is null and the container-level `#[serde(default)]` then refills it
 * from `CoachingSettings::default()`. Every nullable field here defaults to
 * `None`, so "clear the target duration" round-trips as a clear. Dropping the
 * key instead would leave the old number in the document and the UI would show
 * a target the user had just removed.
 */
export function coachingToRustPatch(
  patch: Partial<CoachingSettings> | undefined,
): Record<string, unknown> {
  if (!patch) return {};
  const clamped = clampCoaching({ ...defaultCoachingSettings(), ...patch });
  const out: Record<string, unknown> = {};

  if (patch.mode !== undefined) out.mode = clamped.mode;
  if (patch.deliveryStyle !== undefined) out.deliveryStyle = clamped.deliveryStyle;
  if (patch.pacePreset !== undefined) out.pacePreset = clamped.pacePreset;
  // The band travels with whichever control decided it: a preset change moves
  // the numbers, and sending only the preset would leave Rust holding a band
  // that contradicts it until the next full write.
  if (patch.pacePreset !== undefined || patch.targetWpmLow !== undefined) {
    out.targetWpmLow = clamped.targetWpmLow;
  }
  if (patch.pacePreset !== undefined || patch.targetWpmHigh !== undefined) {
    out.targetWpmHigh = clamped.targetWpmHigh;
  }
  if (patch.deliveryStyle !== undefined || patch.targetVarietyLow !== undefined) {
    out.targetVarietyLow = clamped.targetVarietyLow;
  }
  if (patch.deliveryStyle !== undefined || patch.targetVarietyHigh !== undefined) {
    out.targetVarietyHigh = clamped.targetVarietyHigh;
  }
  if (patch.targetDurationSeconds !== undefined) {
    out.targetDurationSeconds = clamped.targetDurationSeconds;
  }
  if (patch.liveTipFrequency !== undefined) out.liveTipFrequency = clamped.liveTipFrequency;
  if (patch.precisionTranscriptionMode !== undefined) {
    out.precisionTranscriptionMode = clamped.precisionTranscriptionMode;
  }
  if (patch.fillerDetectionScope !== undefined) {
    out.fillerDetectionScope = clamped.fillerDetectionScope;
  }
  if (patch.customFillerWords !== undefined) out.customFillerWords = clamped.customFillerWords;
  if (patch.trackRepeatedOpeners !== undefined) {
    out.trackRepeatedOpeners = clamped.trackRepeatedOpeners;
  }
  if (patch.positiveReinforcementEnabled !== undefined) {
    out.positiveReinforcementEnabled = clamped.positiveReinforcementEnabled;
  }
  if (patch.postTakeReportEnabled !== undefined) {
    out.postTakeReportEnabled = clamped.postTakeReportEnabled;
  }
  if (patch.retainAudioRecordingEnabled !== undefined) {
    out.retainAudioRecordingEnabled = clamped.retainAudioRecordingEnabled;
  }
  if (patch.personalCalibrationEnabled !== undefined) {
    out.personalCalibrationEnabled = clamped.personalCalibrationEnabled;
  }
  if (patch.personalCalibrationResetAtEpochMs !== undefined) {
    out.personalCalibrationResetAtEpochMs = clamped.personalCalibrationResetAtEpochMs;
  }
  if (patch.goals !== undefined) out.goals = { ...clamped.goals };
  if (patch.railTextScale !== undefined) out.railTextScale = clamped.railTextScale;
  if (patch.modules !== undefined) out.modules = { ...clamped.modules };

  return out;
}
