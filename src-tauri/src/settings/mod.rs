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
    /// The shape a take OPENS in: 'prompter' | 'reader' (§ reader-mode spec).
    ///
    /// ------------------------------------------------------------------------
    /// WHY `Option`, WHEN EVERY OTHER FIELD HERE HAS A PLAIN DEFAULT
    /// ------------------------------------------------------------------------
    /// This setting used to live only in the frontend's localStorage overlay,
    /// where a cleared browser store silently returned a reader to prompter. It
    /// moved here so it outlives that store — but the move has to carry the
    /// existing answer across, and that needs "never chosen" to stay tellable
    /// from "chosen prompter" exactly once. A defaulted `String` collapses the
    /// two, so every document written before the move would claim `prompter`
    /// and overwrite the preference it was supposed to inherit.
    ///
    /// `None` therefore means "ask the overlay"; the frontend adopts whatever it
    /// finds there (see `migrateStageMode` in settings-types.ts) and the first
    /// explicit choice pins the answer here for good.
    pub presentation_mode: Option<String>,
    /// Where a reader-mode take last had its window, in LOGICAL (CSS) pixels.
    ///
    /// Logical rather than physical because the frame outlives the rig it was
    /// measured on: a window saved on a 2x panel and restored against a 1x one
    /// would come back at half the size it was left at. Rust converts on the way
    /// in and out, so the stored numbers mean the same thing on every display.
    ///
    /// Only read when `general.restoreWindows` is on, and only for reader mode —
    /// prompter mode has no bounds of its own to remember, it fills whichever
    /// monitor the window is already on.
    pub reader_frame: Option<crate::windows::ReaderFrame>,
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
            // See the field docs: absent is not the same claim as 'prompter'.
            presentation_mode: None,
            reader_frame: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AudioSettings {
    /// Which recogniser is doing the listening.
    ///
    /// No longer a choice — the model is bundled and there is exactly one — but
    /// still persisted and still reported, because "what heard this take?" is a
    /// question a diagnostics bundle has to be able to answer about a session
    /// recorded months ago on a build that may have shipped a different model.
    pub transcription_model: String,
    /// BCP-47 tag, e.g. `en-US`. The bundled model is English-only.
    pub language: String,
    pub soft_pause_auto_disconnect_minutes: u32,
    /// Local voice-detection sensitivity, 0-1, 0.5 = the Appendix A.6 defaults
    /// (spec §28.4). Resolved into a `VadConfig` override by
    /// `vadConfigForSensitivity` in src/control/services/audio/defaults.ts.
    ///
    /// This no longer gates what is sent: the recogniser does its own
    /// endpointing, and nothing the local detector decides can stop a word
    /// reaching it. It drives the *meter* — the "is it hearing me" readout in
    /// Preflight and on the stage — which is why it survived the removal of
    /// client-side turn detection and why it is still worth persisting: a room's
    /// mic tuning that a cleared browser store silently returns to neutral is a
    /// tuning the presenter would rediscover mid-take.
    pub vad_sensitivity: f64,
}

impl Default for AudioSettings {
    fn default() -> Self {
        Self {
            transcription_model: crate::speech::MODEL_NAME.into(),
            language: DEFAULT_LANGUAGE.into(),
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
            fidelity_mode: "balanced".into(),
            motion_profile_id: "default-v1".into(),
            developer_diagnostics: false,
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
    let checks: [(&str, bool); 8] = [
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
    ];
    for (field, ok) in checks {
        if !ok {
            return Err(AppError::invalid_input(format!(
                "Setting {field} is outside its allowed range."
            ))
            .with_detail("field", field));
        }
    }
    // The shape a take opens in. Checked only when it has been chosen: `None`
    // is the legitimate "never chosen, ask the overlay" state, not a bad value.
    if let Some(mode) = settings.stage_behavior.presentation_mode.as_deref() {
        if mode != "prompter" && mode != "reader" {
            return Err(AppError::invalid_input(
                "Setting stageBehavior.presentationMode must be prompter or reader.",
            )
            .with_detail("field", "stageBehavior.presentationMode"));
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
    let following_enums: [(&str, &str, &[&str]); 2] = [
        (
            "following.feel",
            settings.following.feel.as_str(),
            &["calm", "balanced", "responsive"],
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

/// The only language the bundled recogniser transcribes.
pub const DEFAULT_LANGUAGE: &str = "en-US";

/// The recogniser to record, given whatever a previous build persisted.
///
/// Anything that is not the model this build ships is replaced rather than
/// honoured. The value on disk has twice now named a service the app no longer
/// talks to — first a realtime provider's model, then Inworld's — and each time
/// the stale string was forwarded to something that rejected it.
///
/// It cannot be forwarded anywhere any more, because there is nothing to
/// forward it to; but it is still reported in diagnostics and still shown in
/// Settings, and a build that claims to be running `inworld/inworld-stt-1` while
/// an on-device Zipformer does the listening is a lie in the one artefact whose
/// whole job is to be believed.
fn resolve_model(requested: &str) -> String {
    match requested.trim() {
        model if model == crate::speech::MODEL_NAME => model.to_string(),
        _ => crate::speech::MODEL_NAME.to_string(),
    }
}

/// Repair values that a previous build wrote and this one cannot honour.
///
/// The settings document is a JSON blob, so an upgrade in place keeps whatever
/// was there — which is right for every setting the user chose and wrong for
/// one that names a service the app no longer talks to.
///
/// Corrected on read rather than left to a caller to remember: the value is
/// re-derived every time the document loads, so an installation that never
/// writes settings again is still fixed.
fn migrate_in_place(settings: &mut AppSettings) {
    let resolved = resolve_model(settings.audio.transcription_model.as_str());
    if resolved != settings.audio.transcription_model {
        tracing::info!(
            "settings: replacing unsupported transcription model {:?} with {:?}",
            settings.audio.transcription_model,
            resolved
        );
        settings.audio.transcription_model = resolved;
    }

    // Previous builds offered Spanish, French, German and Portuguese, because
    // the hosted service transcribed them. The bundled model is English-only,
    // so a persisted `es-ES` is a setting the app cannot honour and must not
    // keep claiming — a diagnostics bundle that reports a take was transcribed
    // in Spanish, by an English-only recogniser, sends whoever reads it after
    // the wrong problem.
    if !settings
        .audio
        .language
        .trim()
        .to_ascii_lowercase()
        .starts_with("en")
    {
        tracing::info!(
            "settings: replacing unsupported language {:?} with {:?}",
            settings.audio.language,
            DEFAULT_LANGUAGE
        );
        settings.audio.language = DEFAULT_LANGUAGE.to_string();
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
    /// An upgrading installation must not keep claiming a recogniser this
    /// build cannot run.
    ///
    /// The settings document is a JSON blob that survives a provider change,
    /// and this field has now named three different things: a realtime
    /// provider's model, then Inworld's, then the bundled recogniser. Twice
    /// the stale value was forwarded to something that rejected it. It cannot
    /// be forwarded anywhere any more, but it IS what diagnostics report, and
    /// a bundle claiming a take was transcribed by a service the build cannot
    /// reach sends whoever reads it after the wrong problem.
    #[test]
    fn a_stale_recogniser_name_is_rewritten_to_the_one_that_ships() {
        for stale in [
            "inworld/inworld-stt-1",
            "gpt-realtime-whisper",
            "streaming-zipformer-en-20M-int8",
            "",
        ] {
            let mut settings = AppSettings::default();
            settings.audio.transcription_model = stale.to_string();
            migrate_in_place(&mut settings);
            assert_eq!(
                settings.audio.transcription_model,
                crate::speech::MODEL_NAME,
                "{stale:?} must be rewritten"
            );
        }
    }

    /// The bundled recogniser is English-only; earlier builds offered four
    /// other languages against a hosted service that served them.
    #[test]
    fn a_language_the_recogniser_cannot_serve_is_rewritten() {
        for stale in ["es-ES", "fr-FR", "de-DE", "pt-BR"] {
            let mut settings = AppSettings::default();
            settings.audio.language = stale.to_string();
            migrate_in_place(&mut settings);
            assert_eq!(settings.audio.language, DEFAULT_LANGUAGE, "{stale} must go");
        }
        // An English locale the user chose deliberately is left alone.
        for kept in ["en-GB", "en-AU", "en-US"] {
            let mut settings = AppSettings::default();
            settings.audio.language = kept.to_string();
            migrate_in_place(&mut settings);
            assert_eq!(settings.audio.language, kept, "{kept} must survive");
        }
    }

    use super::*;

    #[test]
    fn defaults_validate() {
        assert!(validate(&AppSettings::default()).is_ok());
    }

    #[test]
    fn following_defaults_match_the_specified_defaults() {
        let following = AppSettings::default().following;
        assert_eq!(following.feel, "balanced");
        assert_eq!(following.fidelity_mode, "balanced");
        assert!(!following.developer_diagnostics);
    }

    #[test]
    fn rejects_unknown_following_enum_values() {
        let mut settings = AppSettings::default();
        settings.following.fidelity_mode = "psychic".into();
        assert!(validate(&settings).is_err());
    }

    /// Absent is not the same claim as `prompter`, and the whole migration off
    /// the frontend's localStorage overlay rests on that distinction: a document
    /// written before the move must be able to say "I have no opinion" so the
    /// frontend can adopt whatever the overlay already held. A defaulted
    /// `String` would collapse the two and overwrite the preference.
    #[test]
    fn presentation_mode_starts_unchosen() {
        assert_eq!(StageBehaviorSettings::default().presentation_mode, None);
        let json = serde_json::json!({ "schemaVersion": 1 });
        let settings: AppSettings = serde_json::from_value(json).expect("defaults fill in");
        assert_eq!(settings.stage_behavior.presentation_mode, None);
        assert_eq!(settings.stage_behavior.reader_frame, None);
    }

    #[test]
    fn presentation_mode_accepts_only_the_two_shapes() {
        for mode in ["prompter", "reader"] {
            let mut settings = AppSettings::default();
            settings.stage_behavior.presentation_mode = Some(mode.into());
            assert!(validate(&settings).is_ok(), "{mode} must be accepted");
        }
        let mut settings = AppSettings::default();
        settings.stage_behavior.presentation_mode = Some("picture-in-picture".into());
        assert!(validate(&settings).is_err());
    }

    /// The frame round-trips as logical pixels, in the camelCase the IPC
    /// boundary and the settings document share.
    #[test]
    fn a_reader_frame_round_trips() {
        let json = serde_json::json!({
            "schemaVersion": 1,
            "stageBehavior": {
                "presentationMode": "reader",
                "readerFrame": { "x": 120.0, "y": 90.0, "width": 860.0, "height": 600.0 },
            },
        });
        let settings: AppSettings = serde_json::from_value(json).expect("frame loads");
        let frame = settings
            .stage_behavior
            .reader_frame
            .expect("the frame survives deserialization");
        assert_eq!(frame.width, 860.0);
        assert_eq!(frame.height, 600.0);
        assert!(validate(&settings).is_ok());

        let round_tripped = serde_json::to_value(&settings).expect("serializes");
        assert_eq!(
            round_tripped["stageBehavior"]["readerFrame"]["x"],
            serde_json::json!(120.0),
        );
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

        assert_eq!(settings.audio.transcription_model, crate::speech::MODEL_NAME);
        // And the settings the user actually chose are untouched.
        assert_eq!(settings.audio.vad_sensitivity, 0.8);
    }

    #[test]
    fn a_supported_model_is_left_exactly_as_it_was() {
        let mut settings = AppSettings::default();
        settings.audio.transcription_model = crate::speech::MODEL_NAME.into();
        migrate_in_place(&mut settings);
        assert_eq!(settings.audio.transcription_model, crate::speech::MODEL_NAME);
    }

    /// The Inworld defaults are the ones the streaming config frame is built
    /// from, so a typo here is a session that connects and transcribes nothing.
    #[test]
    fn audio_defaults_name_an_inworld_model_and_locale() {
        let audio = AppSettings::default().audio;
        assert_eq!(audio.transcription_model, crate::speech::MODEL_NAME);
        assert_eq!(audio.language, DEFAULT_LANGUAGE);
        assert!(audio.language.contains('-'), "Inworld wants a BCP-47 tag");
    }

    /// A null patch value resets a field to its default. `merge_json` removes
    /// the key outright, and the container-level `default` then refills it —
    /// so "clear this" and "put it back the way it shipped" are the same act.
    ///
    /// This used to be asserted through `listener.defaultPackId`, the only
    /// `Option<T>` in the tree, where the refill happened to land on `None`.
    /// The Listener is gone; the merge behaviour it was covering is not, so
    /// the test moved to a field that still exists rather than leaving with it.
    #[test]
    fn a_null_patch_value_restores_a_fields_default() {
        let mut base = serde_json::to_value(AppSettings {
            stage_behavior: StageBehaviorSettings {
                blank_color: "#123456".into(),
                ..StageBehaviorSettings::default()
            },
            ..AppSettings::default()
        })
        .expect("serializes");

        merge_json(
            &mut base,
            &serde_json::json!({ "stageBehavior": { "blankColor": null } }),
        );
        assert!(
            base["stageBehavior"].get("blankColor").is_none(),
            "a null patch removes the key rather than storing a null"
        );

        let merged: AppSettings = serde_json::from_value(base).expect("deserializes");
        assert_eq!(
            merged.stage_behavior.blank_color,
            StageBehaviorSettings::default().blank_color,
            "and the container default refills what the patch removed"
        );
    }

    /// §106: the Listener was removed, but settings documents already on disk
    /// still carry its `listener` section. `AppSettings` does not (and must not)
    /// use `deny_unknown_fields`, so those documents keep loading and every
    /// other setting the user chose survives.
    ///
    /// The alternative is `unwrap_or_default()` in `get_settings` silently
    /// resetting the whole document because one retired key is still on disk —
    /// the same failure this file already guards against for the OpenAI-era
    /// keys above.
    #[test]
    fn a_document_carrying_the_removed_listener_section_still_loads() {
        let stored = serde_json::json!({
            "schemaVersion": 1,
            "editor": { "fontSizePx": 19 },
            "listener": {
                "defaultPackId": "mira",
                "autoplay": true,
                "dimPercent": 40.0,
                "blurPx": 0.0,
                "saturation": 0.85,
                "keepWhenBlanked": true,
            },
        });

        let settings: AppSettings =
            serde_json::from_value(stored).expect("a document with a listener section still loads");

        assert_eq!(settings.editor.font_size_px, 19, "surviving keys are kept");
        assert!(validate(&settings).is_ok());
    }
}
