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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ListenerSettings {
    pub opacity_after_dim: f64,
    pub saturation: f64,
    pub blur_px: f64,
    pub scale: f64,
    pub crossfade_ms: u32,
    /// 'continue' | 'freeze'.
    pub soft_pause: String,
    /// 'continue' | 'freeze'.
    pub hard_pause: String,
    pub hide_on_blank: bool,
}

impl Default for ListenerSettings {
    fn default() -> Self {
        Self {
            opacity_after_dim: 0.22,
            saturation: 0.55,
            blur_px: 1.5,
            scale: 1.0,
            crossfade_ms: 160,
            soft_pause: "continue".into(),
            hard_pause: "freeze".into(),
            hide_on_blank: true,
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
        (
            "listener.opacityAfterDim",
            in_range_f(settings.listener.opacity_after_dim, 0.0, 0.75),
        ),
        ("listener.blurPx", in_range_f(settings.listener.blur_px, 0.0, 12.0)),
        (
            "listener.crossfadeMs",
            (80..=400).contains(&settings.listener.crossfade_ms),
        ),
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
}
