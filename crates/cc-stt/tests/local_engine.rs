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

/// Where the shipped model's weights live in a dev checkout.
///
/// Asked of the CATALOGUE rather than written out here. This used to name
/// `models/zipformer-en-20m` directly, and when the bundled model was replaced
/// the directory stopped existing — so every test in this file started skipping
/// and kept reporting success. The one suite that exercises the real recogniser
/// through the real code path went dark for a whole model swap and said `ok`
/// the entire time.
///
/// It was then a SEARCH for any directory that happened to validate, which
/// fixed the staleness and introduced a worse problem: on a machine holding a
/// second bundle it would test THAT one and report it as the shipped model.
/// Deriving the path from `default_model()` cannot go stale — replacing the
/// model moves this with it — and cannot wander onto a different bundle.
fn model_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../src-tauri")
        .join(default_model().resource_dir)
}

/// The shipped model's directory, or `None` when the weights were never
/// fetched.
///
/// The skip is for a clean clone that has not run `pnpm models:fetch`, and it
/// is deliberately narrow: only a directory with no graphs in it at all counts
/// as "not fetched". A directory that HAS graphs but does not detect is a
/// broken bundle, and this panics rather than skipping — silently skipping a
/// broken model is precisely the failure this file exists to prevent, and it
/// has happened here before.
fn require_model() -> Option<PathBuf> {
    let dir = model_dir();
    let graphs = std::fs::read_dir(&dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .ends_with(".onnx")
                })
                .count()
        })
        .unwrap_or(0);
    if graphs == 0 {
        eprintln!(
            "SKIPPING {}: no model in {} (run `pnpm models:fetch`)",
            module_path!(),
            dir.display()
        );
        return None;
    }
    if let Err(detail) = LocalSttConfig::for_model(default_model(), &dir).validate() {
        panic!(
            "{} holds {graphs} ONNX graph(s) but is not a loadable bundle — a half-fetched \
             model must fail here rather than skip: {detail}",
            dir.display()
        );
    }
    Some(dir)
}

/// 24 kHz mono PCM16 silence, the app's capture format.
fn silence_pcm16(ms: usize) -> Vec<u8> {
    vec![0u8; (24_000 * 2 * ms) / 1000]
}

/// Synthesise `phrase` as 24 kHz mono PCM16 with macOS `say`.
///
/// Returns `None` anywhere `say` is not available, so this file still runs
/// green on a machine that is not a Mac. It is the only way to get real speech
/// in here: the benchmark corpus commits event logs and gold timelines, never
/// audio, so there is no fixture to read.
fn speech_pcm16(phrase: &str) -> Option<Vec<u8>> {
    let dir = std::env::temp_dir().join(format!("cc-stt-say-{}", std::process::id()));
    std::fs::create_dir_all(&dir).ok()?;

    // Unique per CALL, not per phrase. Tests in this file run in parallel and
    // two of them speak the same sentence; naming the file after the phrase
    // had them writing, reading and deleting one path at once, which failed
    // roughly every other run.
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let wav = dir.join(format!("{n}.wav"));

    let status = std::process::Command::new("say")
        .args(["-v", "Samantha", "-r", "150", "--data-format=LEI16@24000", "-o"])
        .arg(&wav)
        .arg(phrase)
        .status()
        .ok()?;
    if !status.success() {
        return None;
    }

    let bytes = std::fs::read(&wav).ok()?;
    let _ = std::fs::remove_file(&wav);
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" {
        return None;
    }

    // Walk the RIFF chunks rather than assuming a 44-byte header — `say` writes
    // more than the minimum, so a fixed offset lands mid-header and the
    // "speech" turns into noise the model silently fails to transcribe.
    let mut pos = 12;
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let size = u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into().ok()?) as usize;
        let body = pos + 8;
        if id == b"data" {
            return bytes.get(body..body + size).map(|d| d.to_vec());
        }
        pos = body + size + (size & 1);
    }
    None
}

/// Feed `pcm` the way the app does: 100 ms at a time.
///
/// Not a detail. `push_pcm16` drains and then asks `is_endpoint` ONCE per call,
/// and the endpoint only trips a few hundred ms into the silence that follows
/// an utterance — so handing over a whole gap plus the next utterance in two
/// big pushes steps straight over the window where it would have fired, and the
/// take never splits. The app feeds 100 ms frames off the microphone; a test
/// that feeds it differently is testing a different thing.
fn push_in_frames(session: &mut cc_stt::local::LocalSession<'_>, pcm: &[u8], frames: &mut Vec<SttFrame>) {
    // 100 ms of 24 kHz mono PCM16, and an even byte count so no sample splits.
    const FRAME_BYTES: usize = 24_000 * 2 / 10;
    for slice in pcm.chunks(FRAME_BYTES) {
        session.push_pcm16(slice, 24_000, &mut |f| frames.push(f));
    }
}

/// Every word time in a frame, with the frame's own clock, or `None` when the
/// frame carries no timing.
fn timed(frame: &SttFrame) -> Option<(&Vec<cc_stt::WordTime>, f64)> {
    match frame {
        SttFrame::Partial {
            word_times: Some(w),
            audio_ms,
            ..
        } => Some((w, *audio_ms)),
        SttFrame::Final {
            word_times: Some(w),
            audio_end_ms,
            ..
        } => Some((w, *audio_end_ms)),
        _ => None,
    }
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

/// Real speech, through the real model, must arrive with per-word timing
/// attached — and that timing must sit inside the utterance it belongs to.
///
/// Deliberately STRUCTURAL. It asserts nothing about exact milliseconds,
/// because the exact values are a property of this model's emission lag rather
/// than of this code, and a test that pinned them would fail on a model swap
/// for a reason that is not a regression. What it does prove is the thing that
/// silently broke before: that the frames reach a consumer with timing on them
/// at all. `word_times` failing closed to `None` is invisible from the outside
/// — the transcript still arrives, perfectly — so without this the whole
/// feature could stop working and every other test here would stay green.
#[test]
fn real_speech_arrives_with_per_word_timing_inside_its_own_utterance() {
    let Some(dir) = require_model() else { return };
    let Some(speech) = speech_pcm16("The quick brown fox jumps over the lazy dog") else {
        eprintln!("SKIPPING {}: `say` is unavailable", module_path!());
        return;
    };
    let recognizer =
        LocalRecognizer::load(&LocalSttConfig::for_model(default_model(), dir)).expect("model loads");

    let mut frames = Vec::new();
    let mut session = recognizer.session(3);
    push_in_frames(&mut session, &speech, &mut frames);
    session.finish(&mut |f| frames.push(f));

    let item_start = frames
        .iter()
        .find_map(|f| match f {
            SttFrame::ItemStarted { audio_start_ms, .. } => Some(*audio_start_ms),
            _ => None,
        })
        .unwrap_or_else(|| panic!("real speech produced no utterance: {frames:?}"));

    let timed_frames: Vec<_> = frames.iter().filter_map(timed).collect();
    assert!(
        !timed_frames.is_empty(),
        "no frame carried word timing — the recogniser reports it and we are dropping it again: {frames:?}"
    );

    for (words, frame_ms) in &timed_frames {
        assert!(!words.is_empty(), "a timed frame with no words: {words:?}");
        let mut previous = f64::NEG_INFINITY;
        for word in words.iter() {
            assert!(
                !word.text.is_empty(),
                "an empty word came back: {words:?}"
            );
            assert!(
                !word.text.contains('\u{2581}') && !word.text.starts_with(' '),
                "the sub-word boundary marker leaked into a word: {:?}",
                word.text
            );
            assert!(
                word.start_ms.is_finite(),
                "a non-finite word clock: {word:?}"
            );
            assert!(
                word.start_ms >= item_start - f64::EPSILON,
                "word {:?} at {} predates the utterance it is in ({item_start})",
                word.text,
                word.start_ms
            );
            assert!(
                word.start_ms <= frame_ms + f64::EPSILON,
                "word {:?} at {} is dated after the audio that produced it ({frame_ms})",
                word.text,
                word.start_ms
            );
            assert!(
                word.start_ms >= previous,
                "word clocks stepped backwards inside one frame: {words:?}"
            );
            previous = word.start_ms;
        }
    }

    // The final is the frame the ledger treats as authoritative, and it is
    // built from cached state rather than a fresh result — the one place this
    // could plausibly arrive empty.
    let last_final = frames
        .iter()
        .rev()
        .find(|f| matches!(f, SttFrame::Final { .. }))
        .expect("a finished session closes its utterance");
    assert!(
        timed(last_final).is_some(),
        "the final carried no timing: {last_final:?}"
    );
}

/// Timing must be dated against the segment it came from.
///
/// A second utterance decodes in a NEW segment whose offsets restart near
/// zero, so an implementation that forgets to lift them by the segment's origin
/// produces a second item whose words are all dated to the top of the take.
/// That is invisible in a single-utterance test, which is exactly how the
/// earlier probe missed it.
#[test]
fn a_second_utterance_is_timed_against_its_own_segment() {
    let Some(dir) = require_model() else { return };
    let (Some(one), Some(two)) = (
        speech_pcm16("The quick brown fox jumps over the lazy dog"),
        speech_pcm16("Pack my box with five dozen liquor jugs"),
    ) else {
        eprintln!("SKIPPING {}: `say` is unavailable", module_path!());
        return;
    };

    let recognizer =
        LocalRecognizer::load(&LocalSttConfig::for_model(default_model(), dir)).expect("model loads");

    let mut frames = Vec::new();
    let mut session = recognizer.session(4);
    push_in_frames(&mut session, &one, &mut frames);
    // Comfortably past this model's 1.2 s endpoint rule, so the decoder resets
    // and the next utterance really is a second segment.
    push_in_frames(&mut session, &silence_pcm16(2_000), &mut frames);
    push_in_frames(&mut session, &two, &mut frames);
    session.finish(&mut |f| frames.push(f));

    let starts: Vec<f64> = frames
        .iter()
        .filter_map(|f| match f {
            SttFrame::ItemStarted { audio_start_ms, .. } => Some(*audio_start_ms),
            _ => None,
        })
        .collect();
    assert!(
        starts.len() >= 2,
        "the gap did not split the take into two utterances: {frames:?}"
    );

    let second_start = starts[1];
    let second_item_words: Vec<_> = frames
        .iter()
        .skip_while(|f| !matches!(f, SttFrame::ItemStarted { audio_start_ms, .. } if *audio_start_ms == second_start))
        .filter_map(timed)
        .collect();
    assert!(
        !second_item_words.is_empty(),
        "the second utterance carried no timing: {frames:?}"
    );

    for (words, _) in &second_item_words {
        for word in words.iter() {
            assert!(
                word.start_ms >= second_start - f64::EPSILON,
                "word {:?} of the SECOND utterance is dated {} — before that utterance began \
                 ({second_start}). Segment-relative offsets were not lifted onto the audio clock.",
                word.text,
                word.start_ms
            );
        }
    }
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
