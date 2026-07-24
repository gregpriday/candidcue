//! Typed application settings stored in SQLite (spec §47.9), with defaults
//! from Appendix A. A single versioned row keyed `app` in the `settings`
//! table carries the whole document plus a monotonically increasing
//! `settingsRevision` (spec §48.2).

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::errors::AppError;
use crate::util::now_iso;

pub const SETTINGS_KEY: &str = "app";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub schema_version: u32,
    pub general: GeneralSettings,
    pub editor: EditorSettings,
    pub stage_behavior: StageBehaviorSettings,
    pub audio: AudioSettings,
    pub commands: CommandSettings,
    pub following: FollowingSettings,
    pub coaching: CoachingSettings,
    pub listener: ListenerSettings,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            schema_version: 1,
            general: GeneralSettings::default(),
            editor: EditorSettings::default(),
            stage_behavior: StageBehaviorSettings::default(),
            audio: AudioSettings::default(),
            commands: CommandSettings::default(),
            following: FollowingSettings::default(),
            coaching: CoachingSettings::default(),
            listener: ListenerSettings::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct GeneralSettings {
    /// 'library' | 'last_script' (Appendix A.1).
    pub open_to: String,
    pub autosave_debounce_ms: u32,
    pub revision_interval_minutes: u32,
    pub words_per_minute_estimate: u32,
    /// 'off' | 'launch' | 'daily' | 'weekly'.
    pub update_check: String,
    pub analytics_enabled: bool,
    /// 'off' | '1d' | '7d' | '30d' | 'forever' (spec §36.2).
    pub save_transcript: String,
}

impl Default for GeneralSettings {
    fn default() -> Self {
        Self {
            open_to: "library".into(),
            autosave_debounce_ms: 600,
            revision_interval_minutes: 5,
            words_per_minute_estimate: 130,
            update_check: "daily".into(),
            analytics_enabled: false,
            save_transcript: "off".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct EditorSettings {
    pub font_size_px: u32,
    pub line_height: f64,
    /// 'source' | 'split_right' | 'preview'.
    pub preview_position: String,
    pub word_wrap: bool,
    pub read_headings: bool,
    pub read_image_alt_text: bool,
    /// 'hidden' | 'subtle' | 'prominent'.
    pub show_cues_on_stage: String,
    /// 'hidden' | 'dim'.
    pub show_silent_blocks_on_stage: String,
}

impl Default for EditorSettings {
    fn default() -> Self {
        Self {
            font_size_px: 15,
            line_height: 1.6,
            preview_position: "split_right".into(),
            word_wrap: true,
            read_headings: false,
            read_image_alt_text: false,
            show_cues_on_stage: "subtle".into(),
            show_silent_blocks_on_stage: "dim".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct StageBehaviorSettings {
    /// 'voice' | 'manual' | 'fixed'.
    pub prompt_mode: String,
    pub manual_wheel_multiplier: f64,
    pub fixed_speed_wpm: u32,
    pub pointer_hide_delay_seconds: f64,
    pub manual_move_tracking_grace_seconds: f64,
    /// 'off' | 'subtle'.
    pub stage_acknowledgement: String,
    pub horizontal_mirror: bool,
    pub keep_screen_awake: bool,
    pub blank_color: String,
}

impl Default for StageBehaviorSettings {
    fn default() -> Self {
        Self {
            prompt_mode: "voice".into(),
            manual_wheel_multiplier: 1.0,
            fixed_speed_wpm: 130,
            pointer_hide_delay_seconds: 1.5,
            manual_move_tracking_grace_seconds: 2.5,
            stage_acknowledgement: "subtle".into(),
            horizontal_mirror: false,
            keep_screen_awake: true,
            blank_color: "#000000".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AudioSettings {
    pub transcription_model: String,
    pub language: String,
    /// 'minimal' | 'low' | 'balanced' | 'accurate' (Appendix A.6).
    pub delay_profile: String,
    pub soft_pause_auto_disconnect_minutes: u32,
}

impl Default for AudioSettings {
    fn default() -> Self {
        Self {
            transcription_model: crate::openai::DEFAULT_TRANSCRIPTION_MODEL.into(),
            language: "en".into(),
            delay_profile: "low".into(),
            soft_pause_auto_disconnect_minutes: 10,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CommandSettings {
    pub wake_phrase: String,
    /// 'strict' | 'double_gate' | 'push_to_command'.
    pub wake_mode: String,
    pub luna_fallback: bool,
    pub command_model: String,
}

impl Default for CommandSettings {
    fn default() -> Self {
        Self {
            wake_phrase: "CandidCue".into(),
            wake_mode: "strict".into(),
            luna_fallback: true,
            command_model: crate::openai::DEFAULT_COMMAND_MODEL.into(),
        }
    }
}

/// Smooth-following controls (companion specification §47). These are
/// understandable choices, not control-system parameters: the frontend
/// resolves them into a versioned `SmoothFollowProfile` (§55) in
/// `src/control/lib/follow-profiles.ts`.
///
/// They live in Rust because they change how a session behaves and how much
/// OpenAI usage it may incur, so they must outlive frontend local storage.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct FollowingSettings {
    /// 'calm' | 'balanced' | 'responsive' (§47.1).
    pub feel: String,
    /// 'less' | 'balanced' | 'more' (§47.3).
    pub voice_lead: String,
    /// 'local_only' | 'balanced' | 'enhanced' (§35, §47.4).
    pub intelligence_mode: String,
    /// 'conversational' | 'balanced' | 'exact' (§45, §47.5).
    pub fidelity_mode: String,
    /// 'off' | 'control' | 'stage_and_control' (§47.6).
    pub coaching_display: String,
    /// Versioned motion-profile family id; matches
    /// `DEFAULT_SMOOTH_FOLLOW_PROFILE.id` in
    /// `src/shared/contracts/smooth-follow.ts`.
    pub motion_profile_id: String,
    /// Optional per-session semantic-assist request cap (§42.1). `None` means
    /// no cap — CandidCue does not invent a limit on the user's own key.
    pub semantic_request_limit: Option<u32>,
    /// Reveals the Live diagnostics timeline (§64); off by default (§15.2).
    pub developer_diagnostics: bool,
}

impl Default for FollowingSettings {
    fn default() -> Self {
        Self {
            feel: "balanced".into(),
            voice_lead: "balanced".into(),
            intelligence_mode: "balanced".into(),
            fidelity_mode: "balanced".into(),
            coaching_display: "control".into(),
            motion_profile_id: "default-v1".into(),
            semantic_request_limit: None,
            developer_diagnostics: false,
        }
    }
}

/// Live-coaching controls (companion specification §30).
///
/// These live in Rust rather than in the frontend's localStorage overlay for
/// two reasons that the following settings only half share:
///
/// - `precision_transcription_mode` (§29.3) decides whether the coaching
///   subsystem makes additional OpenAI transcription calls on the user's key,
///   so it must be readable by the side that bills it and must survive a
///   frontend profile reset;
/// - `post_take_report_enabled` and `retain_audio_recording_enabled` are
///   **retention consents** (§32.2). A consent that can be lost and silently
///   re-defaulted is not a consent.
///
/// Every enum is validated in `validate` below, so a malformed patch cannot
/// leave a session in an unknown coaching mode.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CoachingSettings {
    /// 'off' | 'minimal' | 'coach' | 'studio' | 'review_only' | 'custom' (§6).
    pub mode: String,
    /// 'calm' | 'natural' | 'conversational' | 'expressive' | 'broadcast' | 'custom' (§17.6).
    pub delivery_style: String,
    /// §14.6 preset id, or 'custom' when the WPM pair below is user-authored.
    pub pace_preset: String,
    pub target_wpm_low: u32,
    pub target_wpm_high: u32,
    /// §17.5 variety scale, 0–100.
    pub target_variety_low: u32,
    pub target_variety_high: u32,
    /// §30.1. `None` means "no target duration" — distinct from zero, which
    /// would read as a budget that is blown before the take starts.
    pub target_duration_seconds: Option<u32>,
    /// 'low' | 'normal' | 'high' (§26.1).
    pub live_tip_frequency: String,
    /// §29.3 cost modes: 'off' | 'on_candidates' | 'full' | 'review_only'.
    /// Anything other than 'off' spends the user's OpenAI key.
    pub precision_transcription_mode: String,
    /// 'strict' | 'broad' (§30.2).
    pub filler_detection_scope: String,
    /// The speaker's own filler vocabulary. Deliberately uncapped.
    pub custom_filler_words: Vec<String>,
    pub track_repeated_openers: bool,
    pub positive_reinforcement_enabled: bool,
    /// §32.2 consent: saved coaching measurements.
    pub post_take_report_enabled: bool,
    /// §32.2 consent: saved audio. Off by default; audio is memory-only (§32.1).
    pub retain_audio_recording_enabled: bool,
    /// §17.7. Persistent personal calibration is opt-in and local.
    pub personal_calibration_enabled: bool,
    /// §30.1 "reset personal calibration", recorded as a tombstone: wall-clock
    /// epoch **milliseconds** of the last reset. Any calibration learned before
    /// this instant is invalid. Wall clock is correct — this compares two
    /// persisted records, never audio evidence (§5.4 applies to evidence).
    pub personal_calibration_reset_at_epoch_ms: Option<i64>,
    pub goals: CoachingGoals,
    /// §7.6 rail text scale, 0.8–1.5.
    pub rail_text_scale: f64,
    pub modules: CoachingModules,
}

impl Default for CoachingSettings {
    fn default() -> Self {
        Self {
            mode: "coach".into(),                     // §6.3 "Coach — default"
            delivery_style: "natural".into(),
            pace_preset: "natural_presentation".into(), // §14.6 "broad default"
            target_wpm_low: 115,
            target_wpm_high: 160,
            target_variety_low: 45,
            target_variety_high: 75,
            target_duration_seconds: None,
            live_tip_frequency: "normal".into(),
            // §32.1: coaching sends bounded extra audio only when asked to.
            precision_transcription_mode: "off".into(),
            filler_detection_scope: "strict".into(),
            custom_filler_words: Vec::new(),
            track_repeated_openers: false,
            positive_reinforcement_enabled: false, // §25.6
            post_take_report_enabled: false,       // §32.1 metrics are session-only
            retain_audio_recording_enabled: false, // §32.1 audio stays in memory
            personal_calibration_enabled: false,   // §17.7 opt-in
            personal_calibration_reset_at_epoch_ms: None,
            goals: CoachingGoals::default(),
            rail_text_scale: 1.0,
            modules: CoachingModules::default(),
        }
    }
}

/// §30.4. Goals influence tips and the post-take review, never script
/// tracking. `None`/`false` is "not a goal" — an absent goal must never read
/// as a threshold nobody chose.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CoachingGoals {
    pub max_fillers_per_minute: Option<f64>,
    pub max_fillers_per_hundred_words: Option<f64>,
    pub pace_within_target_range: bool,
    pub finish_within_target_duration: bool,
    pub variety_within_target_band: bool,
}

/// §6.6 module flags. Read by `custom` mode; the named modes derive their own.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CoachingModules {
    pub pace_number: bool,
    pub pace_status: bool,
    pub target_duration_status: bool,
    pub variety_score: bool,
    pub filler_count: bool,
    pub filler_ribbon: bool,
    pub inline_gutter_marks: bool,
    pub live_tips: bool,
    /// The 0-100 delivery score (Realtime Speaking Score report §11.1).
    pub delivery_score: bool,
}

impl Default for CoachingModules {
    fn default() -> Self {
        // The §6.3 Coach set, matching `MODE_MODULE_PRESETS.coach` in
        // `src/control/lib/coaching-profiles.ts`.
        Self {
            pace_number: true,
            pace_status: true,
            target_duration_status: true,
            variety_score: false,
            filler_count: true,
            filler_ribbon: true,
            inline_gutter_marks: false,
            delivery_score: true,
            live_tips: true,
        }
    }
}

/// Listener defaults (spec §37, §46.7) — the values every new session starts
/// from, before the display profile for the chosen monitor is applied.
///
/// This struct used to be one of two settings structures for one feature. It
/// declared `scale`, `crossfadeMs`, `softPause`, `hardPause` and `hideOnBlank`,
/// none of which had a mapping on the TypeScript side (`listener` was typed as
/// an opaque `Record<string, unknown>`), while the UI kept a separate
/// `listeners` section in a localStorage overlay. The two have been reconciled
/// into this one, Rust-owned, and the adapter is
/// `src/control/services/settings-listener.ts`.
///
/// What was deleted, and why — each of these had no reader and duplicated a
/// decision another mechanism already owns:
///   - `scale`: the Listener's size is per-display framing, and lives in the
///     display profile's `ListenerGeometry` (which persists it already).
///   - `crossfadeMs`: not a user choice. The stage varies its blend for reduced
///     motion and for §61 frame pressure, and a persisted number would fight
///     both; it stays a constant in `ListenerLayer.svelte`.
///   - `softPause` / `hardPause`: whether the loop freezes is carried per
///     directive on the stage `freeze` command, decided by the session.
///   - `hideOnBlank`: carried per directive as `keepListener` on the stage
///     `blank` command, for the same reason.
///
/// The units are the units the UI shows — dim as a percentage, not an opacity.
/// The one Listener bug this area has shipped was an inverted conversion on a
/// persisted value, so the conversions that remain are the ones that earn it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ListenerSettings {
    /// Pack preselected in Preflight, when `autoplay` is on. `None` = ask.
    pub default_pack_id: Option<String>,
    /// Preselect `default_pack_id` and enable the Listener for a new session.
    pub autoplay: bool,
    /// 0-80, percent. The stage renders `opacity: 1 - dimPercent/100`.
    pub dim_percent: f64,
    /// 0-24, CSS pixels.
    pub blur_px: f64,
    /// 0-1, the CSS `saturate()` factor. 0.85 is the look the stage shipped.
    pub saturation: f64,
}

impl Default for ListenerSettings {
    fn default() -> Self {
        Self {
            default_pack_id: None,
            autoplay: true,
            dim_percent: 40.0,
            blur_px: 0.0,
            saturation: 0.85,
        }
    }
}

/// Matches the `Revisioned<T>` contract in `src/shared/contracts/core.ts`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionedSettings {
    pub revision: i64,
    pub value: AppSettings,
}

fn in_range_f(value: f64, min: f64, max: f64) -> bool {
    value >= min && value <= max
}

/// Validate against the Appendix A ranges we enforce in Rust. Returns a
/// recoverable validation error naming the offending field.
pub fn validate(settings: &AppSettings) -> Result<(), AppError> {
    let checks: [(&str, bool); 10] = [
        (
            "general.autosaveDebounceMs",
            (250..=2000).contains(&settings.general.autosave_debounce_ms),
        ),
        (
            "general.revisionIntervalMinutes",
            (1..=30).contains(&settings.general.revision_interval_minutes),
        ),
        (
            "general.wordsPerMinuteEstimate",
            (70..=220).contains(&settings.general.words_per_minute_estimate),
        ),
        ("editor.fontSizePx", (11..=24).contains(&settings.editor.font_size_px)),
        ("editor.lineHeight", in_range_f(settings.editor.line_height, 1.2, 2.0)),
        (
            "stageBehavior.manualWheelMultiplier",
            in_range_f(settings.stage_behavior.manual_wheel_multiplier, 0.25, 4.0),
        ),
        (
            "stageBehavior.fixedSpeedWpm",
            (30..=300).contains(&settings.stage_behavior.fixed_speed_wpm),
        ),
        // The ranges are the ranges the Preflight sliders offer. They used to
        // disagree with them in both directions — `opacityAfterDim <= 0.75`
        // rejected a dim of 0, and `blurPx <= 12` rejected the top half of a
        // slider that goes to 24 — so a value the UI could produce was a value
        // Rust would refuse to store.
        ("listener.dimPercent", in_range_f(settings.listener.dim_percent, 0.0, 80.0)),
        ("listener.blurPx", in_range_f(settings.listener.blur_px, 0.0, 24.0)),
        ("listener.saturation", in_range_f(settings.listener.saturation, 0.0, 1.0)),
    ];
    for (field, ok) in checks {
        if !ok {
            return Err(AppError::invalid_input(format!(
                "Setting {field} is outside its allowed range."
            ))
            .with_detail("field", field));
        }
    }
    let allowed_transcript = ["off", "1d", "7d", "30d", "forever"];
    if !allowed_transcript.contains(&settings.general.save_transcript.as_str()) {
        return Err(AppError::invalid_input(
            "Setting general.saveTranscript must be off, 1d, 7d, 30d, or forever.",
        ));
    }

    // Following settings (companion §47): closed vocabularies, validated here
    // so a malformed patch cannot leave a session in an unknown assist mode.
    let following_enums: [(&str, &str, &[&str]); 5] = [
        (
            "following.feel",
            settings.following.feel.as_str(),
            &["calm", "balanced", "responsive"],
        ),
        (
            "following.voiceLead",
            settings.following.voice_lead.as_str(),
            &["less", "balanced", "more"],
        ),
        (
            "following.intelligenceMode",
            settings.following.intelligence_mode.as_str(),
            &["local_only", "balanced", "enhanced"],
        ),
        (
            "following.fidelityMode",
            settings.following.fidelity_mode.as_str(),
            &["conversational", "balanced", "exact"],
        ),
        (
            "following.coachingDisplay",
            settings.following.coaching_display.as_str(),
            &["off", "control", "stage_and_control"],
        ),
    ];
    for (field, value, allowed) in following_enums {
        if !allowed.contains(&value) {
            return Err(
                AppError::invalid_input(format!("Setting {field} must be one of: {}.", allowed.join(", ")))
                    .with_detail("field", field),
            );
        }
    }
    if settings.following.motion_profile_id.trim().is_empty() {
        return Err(AppError::invalid_input(
            "Setting following.motionProfileId must name a motion profile.",
        )
        .with_detail("field", "following.motionProfileId"));
    }
    // `None` means "no cap"; a stored cap of zero would silently disable assist.
    if settings.following.semantic_request_limit == Some(0) {
        return Err(AppError::invalid_input(
            "Setting following.semanticRequestLimit must be at least 1, or absent for no limit.",
        )
        .with_detail("field", "following.semanticRequestLimit"));
    }

    validate_coaching(&settings.coaching)?;
    Ok(())
}

/// Companion §30. Closed vocabularies and ordered ranges, validated in Rust so
/// a hand-written patch cannot leave the coaching subsystem in a state no
/// analyzer knows how to read — including an inverted target band, which would
/// make every pace and variety comparison simultaneously "too high" and "too
/// low".
fn validate_coaching(coaching: &CoachingSettings) -> Result<(), AppError> {
    let enums: [(&str, &str, &[&str]); 6] = [
        (
            "coaching.mode",
            coaching.mode.as_str(),
            &["off", "minimal", "coach", "studio", "review_only", "custom"],
        ),
        (
            "coaching.deliveryStyle",
            coaching.delivery_style.as_str(),
            &[
                "calm",
                "natural",
                "conversational",
                "expressive",
                "broadcast",
                "custom",
            ],
        ),
        (
            "coaching.pacePreset",
            coaching.pace_preset.as_str(),
            &[
                "calm_explainer",
                "natural_presentation",
                "conversational_camera",
                "energetic_short_form",
                "custom",
            ],
        ),
        (
            "coaching.liveTipFrequency",
            coaching.live_tip_frequency.as_str(),
            &["low", "normal", "high"],
        ),
        (
            "coaching.precisionTranscriptionMode",
            coaching.precision_transcription_mode.as_str(),
            &["off", "on_candidates", "full", "review_only"],
        ),
        (
            "coaching.fillerDetectionScope",
            coaching.filler_detection_scope.as_str(),
            &["strict", "broad"],
        ),
    ];
    for (field, value, allowed) in enums {
        if !allowed.contains(&value) {
            return Err(AppError::invalid_input(format!(
                "Setting {field} must be one of: {}.",
                allowed.join(", ")
            ))
            .with_detail("field", field));
        }
    }

    let ranges: [(&str, bool); 4] = [
        (
            "coaching.targetWpmLow",
            (60..=260).contains(&coaching.target_wpm_low),
        ),
        (
            "coaching.targetWpmHigh",
            (60..=260).contains(&coaching.target_wpm_high),
        ),
        (
            "coaching.targetVarietyLow",
            coaching.target_variety_low <= 100,
        ),
        (
            "coaching.targetVarietyHigh",
            coaching.target_variety_high <= 100,
        ),
    ];
    for (field, ok) in ranges {
        if !ok {
            return Err(AppError::invalid_input(format!(
                "Setting {field} is outside its allowed range."
            ))
            .with_detail("field", field));
        }
    }
    if coaching.target_wpm_high <= coaching.target_wpm_low {
        return Err(AppError::invalid_input(
            "Setting coaching.targetWpmHigh must be greater than coaching.targetWpmLow.",
        )
        .with_detail("field", "coaching.targetWpmHigh"));
    }
    if coaching.target_variety_high <= coaching.target_variety_low {
        return Err(AppError::invalid_input(
            "Setting coaching.targetVarietyHigh must be greater than coaching.targetVarietyLow.",
        )
        .with_detail("field", "coaching.targetVarietyHigh"));
    }
    // `None` is "no target"; a stored zero would be a budget already blown.
    if coaching.target_duration_seconds == Some(0) {
        return Err(AppError::invalid_input(
            "Setting coaching.targetDurationSeconds must be at least 1 second, or absent for no target.",
        )
        .with_detail("field", "coaching.targetDurationSeconds"));
    }
    if !in_range_f(coaching.rail_text_scale, 0.8, 1.5) {
        return Err(
            AppError::invalid_input("Setting coaching.railTextScale is outside its allowed range.")
                .with_detail("field", "coaching.railTextScale"),
        );
    }
    for (field, goal) in [
        (
            "coaching.goals.maxFillersPerMinute",
            coaching.goals.max_fillers_per_minute,
        ),
        (
            "coaching.goals.maxFillersPerHundredWords",
            coaching.goals.max_fillers_per_hundred_words,
        ),
    ] {
        if let Some(value) = goal {
            if !(value.is_finite() && value > 0.0) {
                return Err(AppError::invalid_input(format!(
                    "Setting {field} must be greater than zero, or absent when it is not a goal."
                ))
                .with_detail("field", field));
            }
        }
    }
    // No cap on `custom_filler_words`: these are the speaker's own habits and
    // CandidCue has no basis for deciding the twenty-first one does not count.
    // Blank entries are rejected, because a blank filler matches everything.
    if coaching
        .custom_filler_words
        .iter()
        .any(|word| word.trim().is_empty())
    {
        return Err(AppError::invalid_input(
            "Setting coaching.customFillerWords must not contain a blank entry.",
        )
        .with_detail("field", "coaching.customFillerWords"));
    }
    Ok(())
}

/// Recursive JSON merge: objects merge key-by-key, everything else replaces.
fn merge_json(base: &mut serde_json::Value, patch: &serde_json::Value) {
    match (base, patch) {
        (serde_json::Value::Object(base_map), serde_json::Value::Object(patch_map)) => {
            for (key, patch_value) in patch_map {
                if patch_value.is_null() {
                    base_map.remove(key);
                } else {
                    merge_json(
                        base_map.entry(key.clone()).or_insert(serde_json::Value::Null),
                        patch_value,
                    );
                }
            }
        }
        (base_slot, patch_value) => *base_slot = patch_value.clone(),
    }
}

pub async fn get_settings(pool: &SqlitePool) -> Result<RevisionedSettings, AppError> {
    let row: Option<(String, i64)> =
        sqlx::query_as("SELECT value_json, revision FROM settings WHERE key = ?")
            .bind(SETTINGS_KEY)
            .fetch_optional(pool)
            .await?;
    match row {
        Some((json, revision)) => {
            let value: AppSettings = serde_json::from_str(&json)
                .unwrap_or_default();
            Ok(RevisionedSettings { revision, value })
        }
        None => {
            let value = AppSettings::default();
            let json = serde_json::to_string(&value)
                .map_err(|e| AppError::Internal(format!("settings serialize: {e}")))?;
            sqlx::query(
                "INSERT INTO settings (key, value_json, revision, updated_at)
                 VALUES (?, ?, 1, ?)
                 ON CONFLICT(key) DO NOTHING",
            )
            .bind(SETTINGS_KEY)
            .bind(&json)
            .bind(now_iso())
            .execute(pool)
            .await?;
            Ok(RevisionedSettings { revision: 1, value })
        }
    }
}

pub async fn update_settings(
    pool: &SqlitePool,
    expected_revision: i64,
    patch: serde_json::Value,
) -> Result<RevisionedSettings, AppError> {
    let current = get_settings(pool).await?;
    if current.revision != expected_revision {
        return Err(AppError::stale_revision(expected_revision, current.revision));
    }

    let mut base = serde_json::to_value(&current.value)
        .map_err(|e| AppError::Internal(format!("settings serialize: {e}")))?;
    merge_json(&mut base, &patch);
    let merged: AppSettings = serde_json::from_value(base)
        .map_err(|e| AppError::invalid_input("Settings patch has an invalid shape.")
            .with_log(format!("settings patch deserialize: {e}")))?;
    validate(&merged)?;

    let json = serde_json::to_string(&merged)
        .map_err(|e| AppError::Internal(format!("settings serialize: {e}")))?;
    let next_revision = current.revision + 1;
    let updated = sqlx::query(
        "UPDATE settings SET value_json = ?, revision = ?, updated_at = ?
         WHERE key = ? AND revision = ?",
    )
    .bind(&json)
    .bind(next_revision)
    .bind(now_iso())
    .bind(SETTINGS_KEY)
    .bind(expected_revision)
    .execute(pool)
    .await?;
    if updated.rows_affected() == 0 {
        return Err(AppError::stale_revision(expected_revision, next_revision));
    }

    /*
     * §32.2 / §36.2. A retention toggle that is off must remove what earlier
     * sessions stored, not merely stop future writes.
     *
     * `enforce_transcript_retention` already implemented that rule, but it was
     * only ever called at startup (`app.rs`), so turning retention off deleted
     * nothing until the next launch — the setting said "not kept" while the
     * rows were still there, for as long as the app stayed open. Enforcing it
     * on write closes that window.
     *
     * It runs after the document is committed, so a failed write can never
     * delete anything, and its outcome is deliberately not folded into this
     * function's error: the settings change genuinely did persist. The count is
     * dropped rather than reported because nothing displays it; a failure is
     * logged by the caller's error path if the query itself fails.
     */
    crate::sessions::enforce_transcript_retention(pool, &merged.general.save_transcript).await?;

    Ok(RevisionedSettings {
        revision: next_revision,
        value: merged,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_validate() {
        assert!(validate(&AppSettings::default()).is_ok());
    }

    #[test]
    fn following_defaults_match_the_specified_defaults() {
        let following = AppSettings::default().following;
        assert_eq!(following.intelligence_mode, "balanced");
        assert_eq!(following.fidelity_mode, "balanced");
        // §47.6: conservative default — no stage coaching until testing shows it helps.
        assert_eq!(following.coaching_display, "control");
        assert_eq!(following.semantic_request_limit, None);
        assert!(!following.developer_diagnostics);
    }

    #[test]
    fn rejects_unknown_following_enum_values() {
        let mut settings = AppSettings::default();
        settings.following.intelligence_mode = "psychic".into();
        assert!(validate(&settings).is_err());
    }

    #[test]
    fn rejects_a_zero_semantic_request_limit() {
        let mut settings = AppSettings::default();
        settings.following.semantic_request_limit = Some(0);
        assert!(validate(&settings).is_err());
        settings.following.semantic_request_limit = Some(1);
        assert!(validate(&settings).is_ok());
    }

    #[test]
    fn a_document_without_a_following_section_deserializes_to_defaults() {
        let json = serde_json::json!({ "schemaVersion": 1 });
        let settings: AppSettings = serde_json::from_value(json).expect("defaults fill in");
        assert_eq!(settings.following, FollowingSettings::default());
    }

    /// The "migration" for §30: the settings document is a JSON blob in a
    /// generic `settings` table, so there is no DDL to change — the upgrade
    /// path is serde's container-level `default`. That is only true while every
    /// field has a default, which is what this asserts. A document written by
    /// today's build must come back with the whole coaching section rather than
    /// failing to deserialize and silently resetting *every* setting through
    /// `unwrap_or_default()` in `get_settings`.
    #[test]
    fn a_document_without_a_coaching_section_deserializes_to_defaults() {
        let json = serde_json::json!({ "schemaVersion": 1 });
        let settings: AppSettings = serde_json::from_value(json).expect("defaults fill in");
        assert_eq!(settings.coaching, CoachingSettings::default());
        assert!(validate(&settings).is_ok());
    }

    /// §32.1/§32.2: both retention consents, and the mode that spends the
    /// user's API key, default to the quiet side.
    #[test]
    fn coaching_privacy_defaults_are_the_safe_side() {
        let coaching = AppSettings::default().coaching;
        assert!(!coaching.retain_audio_recording_enabled);
        assert!(!coaching.post_take_report_enabled);
        assert_eq!(coaching.precision_transcription_mode, "off");
        assert!(!coaching.personal_calibration_enabled);
        assert_eq!(coaching.personal_calibration_reset_at_epoch_ms, None);
        assert_eq!(coaching.mode, "coach");
    }

    #[test]
    fn rejects_unknown_coaching_enum_values() {
        for (field, value) in [
            ("mode", "vibes"),
            ("deliveryStyle", "shouty"),
            ("pacePreset", "auctioneer"),
            ("liveTipFrequency", "constant"),
            ("precisionTranscriptionMode", "maybe"),
            ("fillerDetectionScope", "everything"),
        ] {
            let mut settings = AppSettings::default();
            match field {
                "mode" => settings.coaching.mode = value.into(),
                "deliveryStyle" => settings.coaching.delivery_style = value.into(),
                "pacePreset" => settings.coaching.pace_preset = value.into(),
                "liveTipFrequency" => settings.coaching.live_tip_frequency = value.into(),
                "precisionTranscriptionMode" => {
                    settings.coaching.precision_transcription_mode = value.into()
                }
                _ => settings.coaching.filler_detection_scope = value.into(),
            }
            assert!(
                validate(&settings).is_err(),
                "coaching.{field} = {value} must be rejected"
            );
        }
    }

    /// An inverted band is simultaneously "too fast" and "too slow" for every
    /// comparison downstream, so it is a hard error rather than a silent swap.
    #[test]
    fn rejects_inverted_target_bands() {
        let mut settings = AppSettings::default();
        settings.coaching.target_wpm_low = 180;
        settings.coaching.target_wpm_high = 120;
        assert!(validate(&settings).is_err());

        let mut settings = AppSettings::default();
        settings.coaching.target_variety_high = settings.coaching.target_variety_low;
        assert!(validate(&settings).is_err());
    }

    /// §30.4: "not a goal" is `None`, never `Some(0)` — a zero-filler-per-minute
    /// goal read as a threshold would fail on the first "um" of every take.
    #[test]
    fn rejects_a_non_positive_goal_threshold() {
        let mut settings = AppSettings::default();
        settings.coaching.goals.max_fillers_per_minute = Some(0.0);
        assert!(validate(&settings).is_err());
        settings.coaching.goals.max_fillers_per_minute = Some(3.0);
        assert!(validate(&settings).is_ok());
        settings.coaching.goals.max_fillers_per_minute = None;
        assert!(validate(&settings).is_ok());
    }

    #[test]
    fn rejects_a_zero_target_duration_but_accepts_none() {
        let mut settings = AppSettings::default();
        settings.coaching.target_duration_seconds = Some(0);
        assert!(validate(&settings).is_err());
        settings.coaching.target_duration_seconds = Some(90);
        assert!(validate(&settings).is_ok());
        settings.coaching.target_duration_seconds = None;
        assert!(validate(&settings).is_ok());
    }

    /// No arbitrary cap on the user's own vocabulary — only blanks, which would
    /// match everything, are refused.
    #[test]
    fn accepts_an_arbitrarily_long_custom_filler_list_but_no_blank_entry() {
        let mut settings = AppSettings::default();
        settings.coaching.custom_filler_words =
            (0..500).map(|i| format!("filler{i}")).collect();
        assert!(validate(&settings).is_ok());

        settings.coaching.custom_filler_words = vec!["um".into(), "   ".into()];
        assert!(validate(&settings).is_err());
    }

    /// Clearing an optional coaching value must survive the patch merge.
    /// `merge_json` removes a key whose patch value is null, and the
    /// container-level `default` then refills it — which is only a *clear* while
    /// the field's default is `None`.
    #[test]
    fn a_null_patch_value_clears_an_optional_coaching_field() {
        let mut base = serde_json::to_value(AppSettings {
            coaching: CoachingSettings {
                target_duration_seconds: Some(300),
                personal_calibration_reset_at_epoch_ms: Some(1_700_000_000_000),
                ..CoachingSettings::default()
            },
            ..AppSettings::default()
        })
        .expect("serializes");

        merge_json(
            &mut base,
            &serde_json::json!({
                "coaching": {
                    "targetDurationSeconds": null,
                    "personalCalibrationResetAtEpochMs": null,
                }
            }),
        );
        let merged: AppSettings = serde_json::from_value(base).expect("deserializes");
        assert_eq!(merged.coaching.target_duration_seconds, None);
        assert_eq!(merged.coaching.personal_calibration_reset_at_epoch_ms, None);
    }
}
