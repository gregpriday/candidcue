//! The on-device recogniser, exercised against the real bundled model.
//!
//! Skips cleanly when the model has not been fetched (`pnpm models:fetch`), so
//! a clean clone still runs a green suite — but on a developer machine, where
//! the model is present because the app is being built, these run for real.
//!
//! What they are for: the C library answers a bad configuration with a null
//! pointer and a silent fallback, so "it compiled" says very little. The
//! failure mode this whole crate exists to prevent is a session that opens,
//! accepts audio, reports perfect health and emits no transcript.

use std::path::PathBuf;

use cc_stt::local::{LocalRecognizer, LocalSttConfig};
use cc_stt::models::default_model;
use cc_stt::SttFrame;

/// Find the bundled model, whichever one this build ships.
///
/// Deliberately a SEARCH rather than a hard-coded path. It used to name
/// `models/zipformer-en-20m` directly, and when the bundled model was replaced
/// the directory stopped existing — so every test in this file started
/// skipping and kept reporting success. The one suite that exercises the real
/// recogniser through the real code path went dark for a whole model swap and
/// said `ok` the entire time.
fn model_dir() -> Option<PathBuf> {
    let models = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../src-tauri/models");
    let mut candidates: Vec<PathBuf> = std::fs::read_dir(&models)
        .ok()?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    // Sorted so a machine holding two model bundles picks the same one twice.
    candidates.sort();
    candidates
        .into_iter()
        .find(|dir| LocalSttConfig::for_model(default_model(), dir).validate().is_ok())
}

/// The skip is for a clean clone that has not run `pnpm models:fetch`. On a
/// machine that HAS fetched a model, skipping silently is the failure this
/// whole file exists to prevent, so say so loudly enough to be noticed.
fn require_model() -> Option<PathBuf> {
    match model_dir() {
        Some(dir) => Some(dir),
        None => {
            eprintln!(
                "SKIPPING {}: no usable model under src-tauri/models (run `pnpm models:fetch`)",
                module_path!()
            );
            None
        }
    }
}

/// 24 kHz mono PCM16 silence, the app's capture format.
fn silence_pcm16(ms: usize) -> Vec<u8> {
    vec![0u8; (24_000 * 2 * ms) / 1000]
}

#[test]
fn the_bundled_model_loads_and_a_session_closes_cleanly() {
    let Some(dir) = require_model() else { return };
    let recognizer =
        LocalRecognizer::load(&LocalSttConfig::for_model(default_model(), dir)).expect("model loads");

    let mut frames = Vec::new();
    let mut session = recognizer.session(7);
    session.push_pcm16(&silence_pcm16(500), 24_000, &mut |f| frames.push(f));
    session.finish(&mut |f| frames.push(f));

    // Silence must not mint an utterance. A take that opens on a throat-clear
    // and produces an empty item before the first word would hand the ledger
    // an utterance the presenter never spoke.
    assert!(
        !frames
            .iter()
            .any(|f| matches!(f, SttFrame::ItemStarted { .. } | SttFrame::Partial { .. })),
        "silence produced a transcript: {frames:?}"
    );
    assert!(
        matches!(frames.last(), Some(SttFrame::Closed {})),
        "a finished session must close: {frames:?}"
    );
}

#[test]
fn the_audio_clock_counts_what_it_was_given_regardless_of_rate() {
    let Some(dir) = require_model() else { return };
    let recognizer =
        LocalRecognizer::load(&LocalSttConfig::for_model(default_model(), dir)).expect("model loads");

    // The clock is "audio consumed", which is what the alignment engine times
    // every prediction against. It must follow the samples handed over, not the
    // model's internal 16 kHz feature rate — the recogniser resamples, and a
    // clock that silently reported resampled time would mis-time every frame
    // by 1.5× on this app's own capture format.
    let mut session = recognizer.session(1);
    session.push_pcm16(&silence_pcm16(1_000), 24_000, &mut |_| {});
    assert!(
        (session.audio_ms() - 1_000.0).abs() < 1.0,
        "expected ~1000 ms of audio clock, got {}",
        session.audio_ms()
    );

    let mut session = recognizer.session(1);
    session.push_pcm16(&vec![0u8; 16_000 * 2], 16_000, &mut |_| {});
    assert!(
        (session.audio_ms() - 1_000.0).abs() < 1.0,
        "expected ~1000 ms at 16 kHz too, got {}",
        session.audio_ms()
    );
}

#[test]
fn a_missing_model_is_refused_by_name_rather_than_by_a_null_pointer() {
    let config = LocalSttConfig::for_model(default_model(), "/definitely/not/a/model");
    let error = match LocalRecognizer::load(&config) {
        Ok(_) => panic!("a model directory that does not exist must not load"),
        Err(error) => error,
    };
    assert!(
        error.contains("/definitely/not/a/model"),
        "the error must name what it could not find: {error}"
    );
}
