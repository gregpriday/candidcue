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
    /// Calibrated teleprompter rigs (§52). See [`OpticalSettings`].
    #[serde(default)]
    pub optical: OpticalSettings,
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
            optical: OpticalSettings::default(),
        }
    }
}

/// Calibrated teleprompter rigs, and which one is in force on each panel.
///
/// ## Why this is here and not in localStorage
///
/// It was in localStorage — the whole optical section was, including every
/// measured viewing distance and lens placement. That is user-created data
/// produced by physically measuring a room, and WebView storage is not a place
/// to keep it: it is cleared by the OS under pressure, wiped by a "clear
/// website data" action the user does not associate with an app, quota-limited,
/// and — since the writes were wrapped in a `try` that swallowed everything —
/// capable of failing silently. The 1.0 readiness review called this out
/// directly: clearing WebView storage erased calibrated rigs, and a
/// `display_profiles` SQLite table that described itself as the durable
/// backstop had no callers at all. (Migration 0004 dropped it.)
///
/// It lives in the settings document rather than in that table because the
/// document already has every property this needs and the table has none of
/// them: it is revisioned with optimistic concurrency, written
/// transactionally, and included in an export. A second store would have been a
/// second authority, which is the defect being fixed rather than a fix for it.
///
/// ## Why the values are opaque JSON
///
/// Rust does not interpret a rig. The frontend's `normalizeOpticalProfile` is
/// the validator — it knows the field ranges, the framing presets and the lens
/// placements, and it DROPS a rig that no longer normalises rather than
/// repairing it, because a picker offering a calibration the resolver would
/// refuse is worse than an empty one. Restating those rules here would create
/// two definitions of a valid rig that nothing forces to agree.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct OpticalSettings {
    /// Has this document taken ownership of the calibrations yet?
    ///
    /// The authority marker, and it exists because "does Rust hold any rigs?"
    /// is the wrong question. Using a non-empty `profiles` map as the test
    /// meant an EMPTY one read as "not authoritative yet" — so deleting your
    /// last calibration made the document look unmigrated, the stale
    /// localStorage copy became authoritative again, and the rig you just
    /// deleted came back and was re-adopted.
    ///
    /// `false` for every document written before the move, which is exactly
    /// the set that still needs the one-time migration. Once it is `true` this
    /// document is the answer, empty or not.
    #[serde(default)]
    pub migrated: bool,
    /// `opticalRigKey(displayFingerprint, rigName)` → the rig document.
    pub profiles: std::collections::BTreeMap<String, serde_json::Value>,
    /// Display fingerprint → the name of the rig in force on that panel.
    pub active_rig: std::collections::BTreeMap<String, String>,
    /// Display fingerprint → how a prompter take on that panel is mirrored.
    ///
    /// Mirroring is a fact about the glass in front of ONE panel, and it used
    /// to be a single `stageBehavior.horizontalMirror` for every panel — so a
    /// take that fell back to the laptop when the Elgato was unplugged read
    /// backwards, and calibrating a desk rig switched the glass rig's mirror
    /// off. A panel with no entry is not mirrored.
    ///
    /// `None` is "never written", and it is a different claim from an empty
    /// map for the same reason `migrated` exists: the frontend carries the old
    /// global switch onto the glass exactly once, and an empty map has to read
    /// as "the operator turned every mirror off", not "nobody has moved it
    /// yet". Replaced rather than merged on write — see `REPLACED_MAPS`.
    ///
    /// Each entry is `{ horizontal, vertical }`, kept opaque for the reason the
    /// rigs are: the frontend validates it (an axis is on only when it is
    /// literally `true`), and a typed entry here would let one malformed pair
    /// fail the whole document's deserialisation.
    pub panel_mirror: Option<std::collections::BTreeMap<String, serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct GeneralSettings {
    /// 'library' | 'last_script' (Appendix A.1).
    pub open_to: String,
    pub autosave_debounce_ms: u32,
    pub revision_interval_minutes: u32,
    pub words_per_minute_estimate: u32,
    /*
     * No `update_check`. It was a String defaulting to "daily" that nothing
     * scheduled and nothing read — a persisted claim that the app checks for
     * updates every day, in a build with no updater at all. CandidCue 1.0
     * updates manually (docs/updates.md).
     *
     * Removing it is safe for documents already on disk: serde ignores unknown
     * fields, so an existing settings row carrying `updateCheck` still
     * deserialises and simply drops it on the next write.
     */
    pub analytics_enabled: bool,
    /*
     * No `save_transcript` either. It was the transcript retention window
     * (spec §36.2): takes stopped writing transcripts (#214), the setting left
     * Settings (#215), and the storage it governed went with #217. A document
     * written before that still carries `saveTranscript` until its next save,
     * and is tolerated for the same reason as `updateCheck`.
     */
}

impl Default for GeneralSettings {
    fn default() -> Self {
        Self {
            open_to: "library".into(),
            autosave_debounce_ms: 600,
            revision_interval_minutes: 5,
            words_per_minute_estimate: 130,
            analytics_enabled: false,
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
    /// No longer a choice — this build is tuned to decode with exactly one
    /// recogniser, which the user installs from Welcome or from Settings ›
    /// Speech rather than receiving in the app bundle (`model_store::resolve`;
    /// stock builds ship no model bytes at all).
    ///
    /// Still persisted and still reported, so a diagnostics bundle can name the
    /// recogniser this installation is CONFIGURED with. Note what that is not:
    /// nothing stamps the model onto a session row, so it cannot answer "what
    /// heard this take?" about a take recorded months ago. Answering that would
    /// take per-session provenance, which does not exist yet.
    pub transcription_model: String,
    /// BCP-47 tag, e.g. `en-US`.
    ///
    /// Honoured when this build can FOLLOW it and repaired when it cannot,
    /// which takes two questions rather than a constant: the selected
    /// recogniser has to transcribe it and the alignment engine has to have a
    /// normalisation profile for it. Both are facts about the build, and they
    /// do not give the same answer — the shipped bundle is bilingual (`zh-en`,
    /// a fact the code denied for long enough to be worth stating here), while
    /// the engine normalises English alone and has no Chinese. The two overlap
    /// on English alone. See `migrate_in_place`.
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
            transcription_model: crate::speech::default_model().id.into(),
            language: default_language().into(),
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

    /*
     * The recogniser and the language are ONE choice (§153).
     *
     * `migrate_in_place` repairs an incoherent pair on READ, which is right for
     * a document a previous build wrote — the user should not lose a session
     * because an old value cannot be honoured. It is the wrong answer for a
     * WRITE: a patch that sets a language this recogniser cannot serve, or a
     * recogniser this build cannot load, should fail where it was issued rather
     * than succeed and be silently rewritten the next time settings are read.
     * Accepting it is how the settings screen ends up showing one language
     * while the session declares another.
     *
     * Both halves are checked against the same tables the picker offers from,
     * so a value `select_speech_language` produced always passes and a value
     * nothing offers never does. `get_settings` migrates before this ever runs
     * on a merge, so an old document reaches here already repaired.
     */
    let Some(model) = crate::speech::model_by_id(&settings.audio.transcription_model) else {
        return Err(AppError::invalid_input(
            "Setting audio.transcriptionModel names a recogniser this version cannot load.",
        )
        .with_detail("field", "audio.transcriptionModel"));
    };
    let followable = cc_align::AlignmentLanguage::from_bcp47(settings.audio.language.trim())
        .is_some_and(|language| model.serves_language(language.primary_subtag()));
    if !followable {
        return Err(AppError::invalid_input(
            "Setting audio.language names a language this recogniser cannot follow.",
        )
        .with_detail("field", "audio.language"));
    }
    Ok(())
}

/// The recogniser a settings document selects.
///
/// The one conversion from the persisted string to a loadable model, shared by
/// every speech command so that "which model is this take using?" has exactly
/// one answer. Anything this build cannot load resolves to the default rather
/// than failing: the value is repaired on read anyway, and a take should not
/// refuse to start because a stale string outlived the build that wrote it.
pub fn selected_model(settings: &AppSettings) -> &'static crate::speech::BundledModel {
    resolve_model(settings.audio.transcription_model.as_str())
}

/// Recursive JSON merge: objects merge key-by-key, everything else replaces.
/// Sections whose maps a patch REPLACES rather than merges into.
///
/// `merge_json` recurses into objects, which is right for a settings document
/// made of named scalars: a patch mentions the two fields it changes and says
/// nothing about the other forty.
///
/// It is wrong for a map whose KEYS are the data. `optical.profiles` is keyed
/// by rig, so a merge can only ever add or update one — a rig the user deleted
/// is simply not mentioned by the patch, and therefore survives. Deleting a rig
/// is precisely what the delete button is for, and a calibration that comes
/// back from the dead is worse than one that was never saved: the picker offers
/// a measurement of a room the presenter has left.
///
/// So these paths are emptied before the merge runs, which makes the patch's
/// value the whole value. Named explicitly rather than inferred from shape,
/// because "this object is a map" is not something a JSON document says.
///
/// `panelMirror` is keyed by panel for the same reason, though nothing deletes
/// an entry today — a panel turned unmirrored is written `false`, not removed.
/// It is here so that a map the frontend sends is the whole answer either way.
const REPLACED_MAPS: [(&str, &str); 3] = [
    ("optical", "profiles"),
    ("optical", "activeRig"),
    ("optical", "panelMirror"),
];

fn clear_replaced_maps(base: &mut serde_json::Value, patch: &serde_json::Value) {
    for (section, key) in REPLACED_MAPS {
        // Only when the patch actually carries a new value for it. A patch that
        // says nothing about rigs must not delete them.
        if patch.get(section).and_then(|s| s.get(key)).is_none() {
            continue;
        }
        if let Some(existing) = base.get_mut(section).and_then(|s| s.get_mut(key)) {
            *existing = serde_json::json!({});
        }
    }
}

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

/// The language a fresh install starts in.
///
/// The selected model's own, rather than a constant beside it. A fallback that
/// does not track the model it is falling back to is exactly how the app ended
/// up insisting on English at a recogniser that also transcribes Chinese.
pub fn default_language() -> &'static str {
    crate::speech::default_model().default_language
}

/// The recogniser to record, given whatever a previous build persisted.
///
/// Anything this build cannot load is replaced rather than honoured. The value
/// on disk has twice now named a hosted service the app no longer talks to, and
/// each time the stale string was forwarded to something that rejected it.
///
/// It cannot be forwarded anywhere any more, because there is nothing to
/// forward it to. What it still is, is the value diagnostics report and
/// Settings displays — so WITHOUT this repair a build would name a hosted
/// recogniser while an on-device Zipformer did the listening, which is a lie in
/// the one artefact whose whole job is to be believed. `get_settings` runs this
/// on every read, so what a consumer sees is already repaired; only the row on
/// disk stays stale until the next write.
///
/// The test is now catalogue MEMBERSHIP rather than equality with one constant.
/// The two agree exactly while one model ships, and they stop agreeing the
/// moment a second one does — at which point equality would start throwing away
/// a choice the user had made rather than repairing one the build cannot serve.
/// Membership deliberately says nothing about whether the model's files are
/// healthy on this machine: a broken bundle is the speech engine's status to
/// report, not a reason to rewrite what the user picked.
fn resolve_model(requested: &str) -> &'static crate::speech::BundledModel {
    crate::speech::model_by_id(requested).unwrap_or_else(crate::speech::default_model)
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
    let model = resolve_model(settings.audio.transcription_model.as_str());
    if model.id != settings.audio.transcription_model {
        tracing::info!(
            "settings: replacing unsupported transcription model {:?} with {:?}",
            settings.audio.transcription_model,
            model.id
        );
        settings.audio.transcription_model = model.id.to_string();
    }

    // Previous builds offered Spanish, French, German and Portuguese, because
    // the hosted service transcribed them. A persisted `es-ES` is a setting
    // this build cannot honour and must not keep claiming — a diagnostics
    // bundle reporting that a take was transcribed in Spanish, by a recogniser
    // with no Spanish in it, sends whoever reads it after the wrong problem.
    //
    // Honoured only if BOTH halves of following can serve it, because a
    // teleprompter that transcribes a language it cannot align is not following
    // in that language, it is guessing in it.
    //
    // The first question goes to the ALIGNMENT ENGINE: does it have a
    // normalisation profile for this tag? Asked of the engine's own table
    // rather than a literal `starts_with("en")` here, so it needs no editing as
    // that table grows. A profile is a normalisation capability and not a
    // verdict, so a language that gains one is still repaired until the second
    // half says yes too. That is the design: the bar in
    // `cc_bench::language_gate` is a measurement of a MODEL on a corpus, and it
    // is the model table that records the verdict. `from_bcp47` is also what
    // canonicalises the persisted string:
    // it resolves the PRIMARY subtag, so `en_GB` and `en-gibberish-` are still
    // English while `english` and `eng` — which the old prefix test waved
    // through — are not tags at all and resolve to nothing.
    //
    // The second goes to the RESOLVED MODEL rather than to a hardcoded `en`,
    // because the prefix test was wrong in that direction too: it could only
    // ever describe one recogniser, and the shipped one is bilingual. Repairing
    // a setting the recogniser cannot serve is worth doing; overwriting one it
    // can is losing the user's choice on a build that happened to be sure.
    //
    // The conjunction now bites from BOTH directions, which is what makes it a
    // conjunction rather than a formality:
    //
    // * `zh-CN` — the model transcribes Chinese and the engine has no Chinese
    //   profile, so the script would be compiled as English, and `language.rs`
    //   says plainly that CJK needs a real tokenizer before whitespace
    //   segmentation means anything. Keeping the tag would buy a true claim
    //   about the transcript and a false one about the glass.
    // * `fr-FR`, `de-DE`, `es-ES` — both halves say no. The engine has no
    //   profile for them, and no recogniser this build can LOAD speaks them:
    //   no entry in `cc_stt::models` serves them, because that table's tuning
    //   is measured and no `blank_penalty` sweep has been run for a recogniser
    //   in any of them. Keeping one of these tags would claim a French take
    //   from a recogniser with no French in it.
    //
    // Each stops biting on its own terms — Chinese when it earns a profile, the
    // other three when they earn a profile AND a sweep and a corpus earn them
    // a model — and each stops by itself, with no string comparison here to
    // remember to edit.
    let followable = cc_align::AlignmentLanguage::from_bcp47(settings.audio.language.trim())
        .is_some_and(|language| model.serves_language(language.primary_subtag()));
    if !followable {
        let fallback = model.default_language;
        tracing::info!(
            "settings: replacing language {:?}, which {:?} and the alignment engine cannot both serve, with {:?}",
            settings.audio.language,
            model.id,
            fallback
        );
        settings.audio.language = fallback.to_string();
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
    clear_replaced_maps(&mut base, &patch);
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
    /// An upgrading installation must not keep claiming a recogniser this
    /// build cannot run.
    ///
    /// The settings document is a JSON blob that survives a provider change,
    /// and this field has now named three different things: two hosted models
    /// in turn, then the bundled recogniser. Twice the stale value was
    /// forwarded to something that rejected it. It cannot be forwarded
    /// anywhere any more, but it IS what diagnostics report, and a bundle
    /// claiming a take was transcribed by a service the build cannot reach
    /// sends whoever reads it after the wrong problem.
    ///
    /// The literals below are the actual strings sitting in real settings
    /// documents on disk. They are data, not a live dependency.
    #[test]
    fn a_recogniser_name_this_build_cannot_load_is_rewritten() {
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
                crate::speech::default_model().id,
                "{stale:?} must be rewritten"
            );
        }
    }

    /// Every model the build ships is one it may keep.
    ///
    /// The repair used to be equality with a single constant, which is the same
    /// thing while one model ships and stops being the same thing the day two
    /// do — silently rewriting the user's choice back to the first one.
    #[test]
    fn a_recogniser_this_build_does_ship_is_left_alone() {
        for model in crate::speech::bundled_models() {
            let mut settings = AppSettings::default();
            settings.audio.transcription_model = model.id.to_string();
            settings.audio.language = model.default_language.to_string();
            migrate_in_place(&mut settings);
            assert_eq!(
                settings.audio.transcription_model, model.id,
                "{} must survive",
                model.id
            );
        }
    }

    /// A language this build cannot FOLLOW is repaired; one it can is left
    /// alone.
    ///
    /// The two halves fail for different reasons, and both are here because the
    /// gate is a conjunction. Spanish, French, German and Portuguese were
    /// offered against a hosted service that transcribed them, and the bundled
    /// recogniser does not — nor does the engine have a profile for any of
    /// them, so they fail both halves.
    ///
    /// Chinese fails the other half, and is worth reading twice because it
    /// looks like a regression and is not. The shipped bundle is `zh-en` and
    /// roughly 4000 of its 5000 tokens are CJK, so a Chinese take would be
    /// transcribed perfectly well; it is the ALIGNMENT ENGINE that has no
    /// Chinese profile, and `align/mod.rs` would compile the script as English.
    /// Keeping `zh-CN` would buy a true claim about the transcript and a false
    /// one about the glass. The day `AlignmentLanguage` gains a Chinese variant
    /// the tag becomes honourable, this loop starts failing, and moving the
    /// entry across is the whole of the change.
    #[test]
    fn a_language_this_build_cannot_follow_is_rewritten() {
        let shipped = crate::speech::default_model();
        for stale in [
            // The recogniser has none of these.
            "es-ES", "fr-FR", "de-DE", "es", "fr", "de", "pt-BR", "enochian", "",
            // The recogniser has these; the engine does not.
            "zh", "zh-CN", "zh-Hans-CN",
        ] {
            let mut settings = AppSettings::default();
            settings.audio.language = stale.to_string();
            migrate_in_place(&mut settings);
            assert_eq!(
                settings.audio.language, shipped.default_language,
                "{stale:?} must go"
            );
        }
        // A locale both halves serve is the user's to keep.
        for kept in ["en-GB", "en-AU", "en-US"] {
            let mut settings = AppSettings::default();
            settings.audio.language = kept.to_string();
            migrate_in_place(&mut settings);
            assert_eq!(settings.audio.language, kept, "{kept} must survive");
        }
    }

    /// The engine half of the gate resolves a tag rather than matching a
    /// prefix, which is a deliberate tightening: these all begin with `en` and
    /// survived the old check, but none is a BCP-47 tag.
    #[test]
    fn a_language_that_is_not_a_tag_is_normalised_even_when_it_looks_english() {
        for sloppy in ["english", "eng", "EN GB"] {
            let mut settings = AppSettings::default();
            settings.audio.language = sloppy.to_string();
            migrate_in_place(&mut settings);
            assert_eq!(
                settings.audio.language,
                default_language(),
                "{sloppy} is not a tag the recogniser can be handed"
            );
        }
        // Case and separator variation IS still English, though — and so is a
        // tag with a subtag nobody recognises. `from_bcp47` resolves the
        // PRIMARY subtag; it is not a BCP-47 validator, and a region it has
        // never heard of does not make the language less English. It is also
        // what the model half is then asked about, so an underscore the
        // recogniser's own tag matching would have choked on never reaches it.
        for ok in ["EN-US", "en_GB", "en-gibberish-"] {
            let mut settings = AppSettings::default();
            settings.audio.language = ok.to_string();
            migrate_in_place(&mut settings);
            assert_eq!(settings.audio.language, ok, "{ok} must survive");
        }
    }

    /// Repair is idempotent: reading settings twice must not keep rewriting
    /// them. `migrate_in_place` runs on every load, so a value it does not
    /// settle on would churn the document forever.
    #[test]
    fn repairing_twice_changes_nothing_the_second_time() {
        let mut settings = AppSettings::default();
        settings.audio.transcription_model = "inworld/inworld-stt-1".to_string();
        settings.audio.language = "fr-FR".to_string();
        migrate_in_place(&mut settings);
        let once = settings.clone();
        migrate_in_place(&mut settings);
        assert_eq!(settings.audio, once.audio);
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

    /// A settings document written before the sidecar was removed still carries
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
        // corrected; the model's default is "en-US" and the UI offers only
        // valid choices, so this is a value the user re-picks, not one to
        // silently rewrite.
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

        assert_eq!(settings.audio.transcription_model, crate::speech::default_model().id);
        // And the settings the user actually chose are untouched.
        assert_eq!(settings.audio.vad_sensitivity, 0.8);
    }

    #[test]
    fn a_supported_model_is_left_exactly_as_it_was() {
        let mut settings = AppSettings::default();
        settings.audio.transcription_model = crate::speech::default_model().id.into();
        migrate_in_place(&mut settings);
        assert_eq!(settings.audio.transcription_model, crate::speech::default_model().id);
    }

    /// A fresh install must name the recogniser it actually ships and a
    /// language that recogniser serves — the two facts a diagnostics bundle
    /// reports about a take before anyone has changed anything.
    ///
    /// The engine has to have a profile for it too, and that is not the same
    /// assertion. `migrate_in_place` falls back to the resolved model's
    /// `default_language`, so a model whose default the engine cannot normalise
    /// would leave every install persisting a language the stage cannot follow
    /// — repaired to itself on every load, so nothing would ever complain.
    #[test]
    fn audio_defaults_name_the_bundled_model_and_a_locale_it_serves() {
        let audio = AppSettings::default().audio;
        let shipped = crate::speech::default_model();
        assert_eq!(audio.transcription_model, shipped.id);
        assert_eq!(audio.language, shipped.default_language);
        assert!(shipped.serves_language(&audio.language));
        assert!(cc_align::AlignmentLanguage::from_bcp47(&audio.language).is_some());
        assert!(audio.language.contains('-'), "a BCP-47 tag, not a bare subtag");
    }

    /// The same requirement as the defaults test above, asked of the whole
    /// catalogue rather than only the model that happens to ship first.
    ///
    /// `migrate_in_place` falls back to the RESOLVED model's
    /// `default_language`, and the resolved model is whichever one the settings
    /// document names — so every entry in `bundled_models()`, not just
    /// `default_model()`, supplies a fallback to somebody. If a model's own
    /// default fails either half of the conjunction, that fallback is
    /// unfollowable: the migration would rewrite the language to a value the
    /// next load rejects for exactly the same reason, repairing it to itself on
    /// every start. Nothing errors, nothing surfaces, and the stage simply
    /// never follows for anyone who selected that recogniser.
    ///
    /// So the invariant belongs to the catalogue: adding a model whose default
    /// language this build cannot align has to fail here, at the point where
    /// the model is added, rather than at a take.
    #[test]
    fn every_bundled_model_defaults_to_a_language_this_build_can_follow() {
        for model in crate::speech::bundled_models() {
            let language = cc_align::AlignmentLanguage::from_bcp47(model.default_language)
                .unwrap_or_else(|| {
                    panic!(
                        "model {:?} defaults to {:?}, which the alignment engine has no profile for",
                        model.id, model.default_language
                    )
                });
            assert!(
                model.serves_language(language.primary_subtag()),
                "model {:?} defaults to {:?}, which it does not transcribe (it serves {:?})",
                model.id,
                model.default_language,
                model.languages
            );
        }
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

    /// Per-panel mirroring (#206) is replaced whole, and "never written" stays
    /// tellable from "written empty".
    ///
    /// A merge would keep a panel the patch no longer mentions, which is the
    /// rig-resurrection defect `REPLACED_MAPS` exists for. And the frontend's
    /// one-time move of the old global switch keys off `None`: if an empty map
    /// collapsed to `None` on the round trip, an operator who switched every
    /// panel's mirror off would have the old global carried back onto the
    /// glass at the next launch.
    #[test]
    fn panel_mirror_is_replaced_whole_and_empty_is_not_absent() {
        let stored: AppSettings = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "optical": { "migrated": true, "profiles": {}, "activeRig": {} }
        }))
        .expect("a document from before per-panel mirroring still loads");
        assert_eq!(stored.optical.panel_mirror, None, "absent reads as never written");
        let nulled: AppSettings = serde_json::from_value(serde_json::json!({
            "optical": { "panelMirror": null }
        }))
        .expect("an explicit null still loads");
        assert_eq!(nulled.optical.panel_mirror, None, "and so does null");

        let mut base = serde_json::to_value(&stored).expect("serializes");
        let first = serde_json::json!({ "optical": { "panelMirror": {
            "glass": { "horizontal": true, "vertical": false },
            "laptop": { "horizontal": false, "vertical": false }
        } } });
        clear_replaced_maps(&mut base, &first);
        merge_json(&mut base, &first);
        let mut base = serde_json::to_value(
            serde_json::from_value::<AppSettings>(base).expect("deserializes"),
        )
        .expect("serializes");

        let second = serde_json::json!({ "optical": { "panelMirror": {
            "glass": { "horizontal": true, "vertical": true }
        } } });
        clear_replaced_maps(&mut base, &second);
        merge_json(&mut base, &second);
        let merged: AppSettings = serde_json::from_value(base).expect("deserializes");
        let map = merged.optical.panel_mirror.as_ref().expect("written");
        assert_eq!(map.len(), 1, "the panel the patch left out is gone");
        assert_eq!(
            map["glass"],
            serde_json::json!({ "horizontal": true, "vertical": true })
        );

        let mut base = serde_json::to_value(&merged).expect("serializes");
        let emptied = serde_json::json!({ "optical": { "panelMirror": {} } });
        clear_replaced_maps(&mut base, &emptied);
        merge_json(&mut base, &emptied);
        let merged: AppSettings = serde_json::from_value(base).expect("deserializes");
        assert_eq!(
            merged.optical.panel_mirror,
            Some(std::collections::BTreeMap::new()),
            "an empty map is an answer, not an absence"
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

    /// The same rule one level down: a retired field inside a section that is
    /// still very much alive.
    ///
    /// `general.updateCheck` was a String defaulting to `"daily"` that nothing
    /// ever scheduled and nothing ever read. It went with the rest of the
    /// updater surface when CandidCue 1.0 settled on manual updates
    /// (docs/updates.md), and every settings document written before that
    /// still has it on disk.
    ///
    /// The test above covers a whole removed SECTION, which `AppSettings`
    /// tolerates by not using `deny_unknown_fields`. This covers a removed
    /// FIELD, which `GeneralSettings` tolerates for the same reason — and they
    /// are separate derives, so adding `deny_unknown_fields` to the inner
    /// struct alone would break this while leaving the section test green. A
    /// user who upgrades would lose their words-per-minute estimate and their
    /// open-to preference because of one key nobody reads.
    #[test]
    fn a_document_carrying_the_removed_update_check_field_still_loads() {
        let stored = serde_json::json!({
            "schemaVersion": 1,
            "general": {
                "openTo": "last_script",
                "wordsPerMinuteEstimate": 155,
                "updateCheck": "daily",
            },
        });

        let settings: AppSettings = serde_json::from_value(stored)
            .expect("a document carrying the retired updateCheck field still loads");

        assert_eq!(settings.general.open_to, "last_script");
        assert_eq!(
            settings.general.words_per_minute_estimate, 155,
            "the settings beside the retired key must survive the upgrade"
        );
        assert!(validate(&settings).is_ok());

        // And it must not come back on the way out: the next write drops it.
        let written = serde_json::to_value(&settings).expect("serializes");
        assert!(
            written["general"].get("updateCheck").is_none(),
            "the retired field must not be written back out"
        );
    }

    /// #217: the transcript retention window, retired the same way.
    ///
    /// Every settings document a pre-#217 build wrote carries
    /// `general.saveTranscript`, with whatever window the presenter chose —
    /// and `validate` used to REJECT anything outside its five values, so a
    /// leftover check would turn a stale key into a document that cannot be
    /// saved. Each value, including one no build ever offered, must load with
    /// the settings around it intact, validate, and be gone on the way out.
    #[test]
    fn a_document_carrying_the_removed_save_transcript_field_still_loads() {
        for retention in ["off", "1d", "7d", "30d", "forever", "90d"] {
            let stored = serde_json::json!({
                "schemaVersion": 1,
                "general": {
                    "openTo": "last_script",
                    "wordsPerMinuteEstimate": 155,
                    "revisionIntervalMinutes": 12,
                    "saveTranscript": retention,
                },
            });

            let settings: AppSettings = serde_json::from_value(stored)
                .unwrap_or_else(|e| panic!("saveTranscript {retention:?} must still load: {e}"));

            assert_eq!(settings.general.open_to, "last_script");
            assert_eq!(settings.general.words_per_minute_estimate, 155);
            assert_eq!(settings.general.revision_interval_minutes, 12);
            assert!(validate(&settings).is_ok(), "saveTranscript {retention:?} must validate");

            let written = serde_json::to_value(&settings).expect("serializes");
            assert!(
                written["general"].get("saveTranscript").is_none(),
                "the retired field must not be written back out"
            );
        }
    }
}
