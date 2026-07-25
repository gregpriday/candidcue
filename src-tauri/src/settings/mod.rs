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
    /// Inworld model id, e.g. `inworld/inworld-stt-1`.
    pub transcription_model: String,
    /// BCP-47 tag as Inworld wants it, e.g. `en-US`.
    pub language: String,
    pub soft_pause_auto_disconnect_minutes: u32,
    /// Local voice-detection sensitivity, 0-1, 0.5 = the Appendix A.6 defaults
    /// (spec §28.4). Resolved into a `VadConfig` override by
    /// `vadConfigForSensitivity` in src/control/services/audio/defaults.ts.
    ///
    /// This no longer gates what is sent: Inworld endpoints server-side, and
    /// nothing the local detector decides can stop a word reaching the
    /// recogniser. It drives the *meter* — the "is it hearing me" readout in
    /// Preflight and on the stage — which is why it survived the removal of
    /// client-side turn detection and why it is still worth persisting: a room's
    /// mic tuning that a cleared browser store silently returns to neutral is a
    /// tuning the presenter would rediscover mid-take.
    pub vad_sensitivity: f64,
}

impl Default for AudioSettings {
    fn default() -> Self {
        Self {
            transcription_model: crate::inworld::DEFAULT_MODEL.into(),
            language: crate::inworld::DEFAULT_LANGUAGE.into(),
            soft_pause_auto_disconnect_minutes: 10,
            // A.6 neutral. Never an extreme: an unreadable or absent value must
            // not silently become the most aggressive VAD on offer.
            vad_sensitivity: 0.5,
        }
    }
}

/// Smooth-following controls (companion specification §47). These are
/// understandable choices, not control-system parameters: the frontend
/// resolves them into a versioned `SmoothFollowProfile` (§55) in
/// `src/control/lib/follow-profiles.ts`.
///
/// They live in Rust because they change how a session behaves, so they must
/// outlive frontend local storage.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct FollowingSettings {
    /// 'calm' | 'balanced' | 'responsive' (§47.1).
    pub feel: String,
    /// 'less' | 'balanced' | 'more' (§47.3).
    pub voice_lead: String,
    /// 'conversational' | 'balanced' | 'exact' (§45, §47.5).
    pub fidelity_mode: String,
    /// Versioned motion-profile family id; matches
    /// `DEFAULT_SMOOTH_FOLLOW_PROFILE.id` in
    /// `src/shared/contracts/smooth-follow.ts`.
    pub motion_profile_id: String,
    /// Reveals the Live diagnostics timeline (§64); off by default (§15.2).
    pub developer_diagnostics: bool,
}

impl Default for FollowingSettings {
    fn default() -> Self {
        Self {
            feel: "balanced".into(),
            voice_lead: "balanced".into(),
            fidelity_mode: "balanced".into(),
            motion_profile_id: "default-v1".into(),
            developer_diagnostics: false,
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
///     directive on the stage `freeze` command, decided by the session. The
///     session does not freeze the Listener on a pause and there is no setting
///     for it — see `toggleBlankStage` in src/control/stores/session.ts.
///   - `hideOnBlank`: carried per directive as `keepListener` on the stage
///     `blank` command, for the same reason. It stays deleted; what replaced it
///     is `keep_when_blanked` below, which differs in the way that matters —
///     the session reads it when it builds the directive.
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
    /// Keep the Listener on screen when the stage is blanked (§37.4, §16.6).
    ///
    /// Blanking hides the script; whether it also hides the person is a real
    /// preference, because the two common reasons to blank pull opposite ways.
    /// Blanking to take the script off a shared screen wants the face gone with
    /// it; blanking between takes on a rig where the Listener is what the
    /// presenter looks at wants the face to stay. Off by default — what shipped.
    ///
    /// The session reads this and puts it on the `blank` directive as
    /// `keepListener`, so the directive stays the single carrier of the decision
    /// and this is only where the default comes from.
    pub keep_when_blanked: bool,
}

impl Default for ListenerSettings {
    fn default() -> Self {
        Self {
            default_pack_id: None,
            autoplay: true,
            dim_percent: 40.0,
            blur_px: 0.0,
            saturation: 0.85,
            keep_when_blanked: false,
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
    let checks: [(&str, bool); 11] = [
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
        // §28.4. The slider is 0-100% in both screens that show it; 0.5 is the
        // A.6 neutral. The range is the range the sliders offer, exactly.
        (
            "audio.vadSensitivity",
            in_range_f(settings.audio.vad_sensitivity, 0.0, 1.0),
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
    let following_enums: [(&str, &str, &[&str]); 3] = [
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
            "following.fidelityMode",
            settings.following.fidelity_mode.as_str(),
            &["conversational", "balanced", "exact"],
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

/// Repair values that a previous build wrote and this one cannot honour.
///
/// The settings document is a JSON blob, so an upgrade in place keeps whatever
/// was there — which is right for every setting the user chose and wrong for
/// one that names a service the app no longer talks to. `audio.transcriptionModel`
/// held the previous provider's model on every upgraded installation, the take
/// forwarded it, and Inworld answered "Unsupported model" while the microphone
/// TEST, which sent no model at all, worked perfectly.
///
/// Corrected on read rather than left to a caller to remember: the value is
/// re-derived every time the document loads, so an installation that never
/// writes settings again is still fixed.
fn migrate_in_place(settings: &mut AppSettings) {
    let resolved = crate::inworld::resolve_model(Some(settings.audio.transcription_model.as_str()));
    if resolved != settings.audio.transcription_model {
        tracing::info!(
            "settings: replacing unsupported transcription model {:?} with {:?}",
            settings.audio.transcription_model,
            resolved
        );
        settings.audio.transcription_model = resolved;
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
            let mut value: AppSettings = serde_json::from_str(&json).unwrap_or_default();
            migrate_in_place(&mut value);
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
        assert_eq!(following.feel, "balanced");
        assert_eq!(following.voice_lead, "balanced");
        assert_eq!(following.fidelity_mode, "balanced");
        assert!(!following.developer_diagnostics);
    }

    #[test]
    fn rejects_unknown_following_enum_values() {
        let mut settings = AppSettings::default();
        settings.following.fidelity_mode = "psychic".into();
        assert!(validate(&settings).is_err());
    }

    #[test]
    fn a_document_without_a_following_section_deserializes_to_defaults() {
        let json = serde_json::json!({ "schemaVersion": 1 });
        let settings: AppSettings = serde_json::from_value(json).expect("defaults fill in");
        assert_eq!(settings.following, FollowingSettings::default());
    }

    /// A settings document written before the switch to Inworld still carries
    /// `coaching`, `commands`, `audio.delayProfile` and the three `following`
    /// keys that went with the semantic sidecar. Serde ignores unknown fields,
    /// so those documents must still load — the alternative is
    /// `unwrap_or_default()` in `get_settings` silently resetting *every*
    /// setting the user has ever chosen because one dead key is still on disk.
    #[test]
    fn a_document_from_the_openai_build_still_loads() {
        let legacy = serde_json::json!({
            "schemaVersion": 1,
            "audio": { "language": "en", "delayProfile": "low", "vadSensitivity": 0.8 },
            "commands": { "wakePhrase": "CandidCue", "lunaFallback": true },
            "coaching": { "mode": "studio", "targetWpmLow": 115 },
            "following": {
                "feel": "calm",
                "intelligenceMode": "enhanced",
                "coachingDisplay": "stage_and_control",
                "semanticRequestLimit": 40,
            },
        });
        let settings: AppSettings = serde_json::from_value(legacy).expect("legacy document loads");

        assert_eq!(settings.following.feel, "calm", "surviving keys are kept");
        assert_eq!(settings.audio.vad_sensitivity, 0.8);
        // The retired `language: "en"` is carried through as-is rather than
        // corrected; Inworld wants "en-US" and the UI offers only valid choices,
        // so this is a value the user re-picks, not one to silently rewrite.
        assert_eq!(settings.audio.language, "en");
        assert!(validate(&settings).is_ok());
    }

    /// The one setting an upgrade must NOT preserve.
    ///
    /// Every other value the user chose survives a provider change; this one
    /// names the service itself. Left alone it produced the worst possible
    /// shape of failure: the microphone test worked (it sent no model) and
    /// every real take failed with "Unsupported model", so the app appeared
    /// healthy exactly where it was being checked.
    #[test]
    fn a_transcription_model_from_the_previous_provider_is_repaired_on_read() {
        let mut settings: AppSettings = serde_json::from_value(serde_json::json!({
            "audio": { "transcriptionModel": "gpt-realtime-whisper", "vadSensitivity": 0.8 },
        }))
        .expect("legacy document loads");
        assert_eq!(settings.audio.transcription_model, "gpt-realtime-whisper");

        migrate_in_place(&mut settings);

        assert_eq!(settings.audio.transcription_model, crate::inworld::DEFAULT_MODEL);
        // And the settings the user actually chose are untouched.
        assert_eq!(settings.audio.vad_sensitivity, 0.8);
    }

    #[test]
    fn a_supported_model_is_left_exactly_as_it_was() {
        let mut settings = AppSettings::default();
        settings.audio.transcription_model = crate::inworld::DEFAULT_MODEL.into();
        migrate_in_place(&mut settings);
        assert_eq!(settings.audio.transcription_model, crate::inworld::DEFAULT_MODEL);
    }

    /// The Inworld defaults are the ones the streaming config frame is built
    /// from, so a typo here is a session that connects and transcribes nothing.
    #[test]
    fn audio_defaults_name_an_inworld_model_and_locale() {
        let audio = AppSettings::default().audio;
        assert_eq!(audio.transcription_model, crate::inworld::DEFAULT_MODEL);
        assert_eq!(audio.language, crate::inworld::DEFAULT_LANGUAGE);
        assert!(audio.language.contains('-'), "Inworld wants a BCP-47 tag");
    }

    /// Clearing an optional value must survive the patch merge. `merge_json`
    /// removes a key whose patch value is null, and the container-level
    /// `default` then refills it — which is only a *clear* while the field's
    /// default is `None`.
    #[test]
    fn a_null_patch_value_clears_an_optional_field() {
        let mut base = serde_json::to_value(AppSettings {
            listener: ListenerSettings {
                default_pack_id: Some("aurora".into()),
                ..ListenerSettings::default()
            },
            ..AppSettings::default()
        })
        .expect("serializes");

        merge_json(
            &mut base,
            &serde_json::json!({ "listener": { "defaultPackId": null } }),
        );
        let merged: AppSettings = serde_json::from_value(base).expect("deserializes");
        assert_eq!(merged.listener.default_pack_id, None);
    }
}
