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

/// Is there a speech synthesiser on this machine at all — macOS `say`, or on
/// Windows the System.Speech engine every desktop edition ships?
///
/// The ONLY sanctioned reason to skip a speech test. Separated from synthesis
/// itself on purpose: "this machine has no synthesiser" is a skip, and "the
/// synthesiser is here and it failed" is a FAILURE. Collapsing both into one
/// `Option` is how a suite ends up reporting success while running no
/// assertions, which this file has been bitten by before — every test in it
/// once skipped silently through an entire model swap and said `ok` the whole
/// time.
fn synthesizer_available() -> bool {
    let mut probe = if cfg!(windows) {
        let mut command = std::process::Command::new("powershell");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Add-Type -AssemblyName System.Speech; \
             if ((New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices().Count -eq 0) { exit 1 }",
        ]);
        command
    } else {
        let mut command = std::process::Command::new("say");
        command.arg("-v").arg("?");
        command
    };
    probe
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Synthesise `phrase` as 24 kHz mono PCM16 with the machine's synthesiser.
///
/// PANICS on any failure. Callers gate on [`synthesizer_available`] first, so
/// by the time this runs, a synthesiser exists and anything going wrong is a
/// broken machine or a broken helper — neither of which may be reported as a
/// passing test. It is
/// the only way to get real speech in here: the benchmark corpus commits event
/// logs and gold timelines, never audio, so there is no fixture to read.
fn speech_pcm16(phrase: &str) -> Vec<u8> {
    let dir = std::env::temp_dir().join(format!("cc-stt-say-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("a writable temp directory");

    // Unique per CALL, not per phrase. Tests in this file run in parallel and
    // two of them speak the same sentence; naming the file after the phrase
    // had them writing, reading and deleting one path at once, which failed
    // roughly every other run.
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let wav = dir.join(format!("{n}.wav"));

    // No voice named: naming one makes the test depend on that voice being
    // installed, and Samantha is removable. The default voice is whatever the
    // machine has, which is all this needs.
    let status = if cfg!(windows) {
        // System.Speech writes the same 24 kHz mono PCM16 the app captures.
        // The phrase and path travel in the environment rather than the
        // command line, so no phrase can be read as PowerShell.
        std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Add-Type -AssemblyName System.Speech; \
                 $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; \
                 $f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000, \
                   [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, \
                   [System.Speech.AudioFormat.AudioChannel]::Mono); \
                 $s.SetOutputToWaveFile($env:CC_STT_WAV, $f); \
                 $s.Speak($env:CC_STT_PHRASE); $s.Dispose()",
            ])
            .env("CC_STT_WAV", &wav)
            .env("CC_STT_PHRASE", phrase)
            .status()
            .expect("PowerShell runs")
    } else {
        std::process::Command::new("say")
            .args(["-r", "150", "--data-format=LEI16@24000", "-o"])
            .arg(&wav)
            .arg(phrase)
            .status()
            .expect("`say` runs")
    };
    assert!(status.success(), "speech synthesis failed on {phrase:?}");

    let bytes = std::fs::read(&wav).expect("the synthesiser wrote a file");
    let _ = std::fs::remove_file(&wav);
    let pcm = wave_pcm16_24k_mono(&bytes);

    // A header that parses but contains no audio would make every assertion
    // below run against silence and pass by doing nothing.
    assert!(
        pcm.len() > 24_000,
        "the synthesiser produced under 0.5 s of audio for {phrase:?} — {} bytes",
        pcm.len()
    );
    assert!(
        pcm.chunks_exact(2)
            .any(|s| i16::from_le_bytes([s[0], s[1]]).abs() > 500),
        "the synthesiser produced silence for {phrase:?}"
    );
    pcm
}

/// The `data` chunk of a WAVE file, having checked it really is the mono
/// 24 kHz PCM16 the caller is about to claim it is.
///
/// Validated rather than assumed: a stereo or float RIFF fed through as PCM16
/// is noise, and noise that happens to hallucinate a transcript would make the
/// structural assertions pass on audio nobody spoke.
fn wave_pcm16_24k_mono(bytes: &[u8]) -> Vec<u8> {
    assert!(bytes.len() >= 12, "truncated RIFF");
    assert_eq!(&bytes[0..4], b"RIFF", "not a RIFF file");
    assert_eq!(&bytes[8..12], b"WAVE", "RIFF but not WAVE");

    // Walk the chunks rather than assuming a 44-byte header — `say` writes more
    // than the minimum, so a fixed offset lands mid-header and the "speech"
    // turns into noise the model silently fails to transcribe.
    let mut pos = 12;
    let mut seen_fmt = false;
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let size = u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into().unwrap()) as usize;
        let body = pos + 8;

        if id == b"fmt " {
            assert!(size >= 16 && body + 16 <= bytes.len(), "truncated fmt chunk");
            let read16 = |at: usize| u16::from_le_bytes(bytes[at..at + 2].try_into().unwrap());
            let read32 = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
            assert_eq!(read16(body), 1, "not integer PCM");
            assert_eq!(read16(body + 2), 1, "not mono");
            assert_eq!(read32(body + 4), 24_000, "not 24 kHz");
            assert_eq!(read16(body + 14), 16, "not 16-bit");
            seen_fmt = true;
        }
        if id == b"data" {
            assert!(seen_fmt, "a data chunk before any fmt chunk");
            let data = bytes
                .get(body..body + size)
                .unwrap_or_else(|| panic!("data chunk declares {size} bytes it does not have"));
            assert!(data.len() % 2 == 0, "an odd byte count for 16-bit samples");
            return data.to_vec();
        }
        pos = body + size + (size & 1);
    }
    panic!("no data chunk in the WAVE file");
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

/// Every word time in a frame, with the frame's own clock and item, or `None`
/// when the frame carries no timing.
fn timed(frame: &SttFrame) -> Option<(&str, &Vec<cc_stt::WordTime>, f64)> {
    match frame {
        SttFrame::Partial {
            item_id,
            word_times: Some(w),
            audio_ms,
            ..
        } => Some((item_id, w, *audio_ms)),
        SttFrame::Final {
            item_id,
            word_times: Some(w),
            audio_end_ms,
            ..
        } => Some((item_id, w, *audio_end_ms)),
        _ => None,
    }
}

/// The transcript a frame carries, whatever kind of frame it is.
fn frame_text(frame: &SttFrame) -> Option<&str> {
    match frame {
        SttFrame::Partial { text, .. } | SttFrame::Final { text, .. } => Some(text),
        _ => None,
    }
}

/// `(item_id, audio_start_ms)` for every utterance, in order.
fn item_starts(frames: &[SttFrame]) -> Vec<(String, f64)> {
    frames
        .iter()
        .filter_map(|f| match f {
            SttFrame::ItemStarted {
                item_id,
                audio_start_ms,
                ..
            } => Some((item_id.clone(), *audio_start_ms)),
            _ => None,
        })
        .collect()
}

/// Assert the timing on one item is internally consistent.
///
/// `words` deliberately takes the whole vector so an EMPTY one fails here
/// rather than making a caller's `for` loop run zero assertions and pass.
#[track_caller]
fn assert_timing_is_sound(words: &[cc_stt::WordTime], item_start: f64, frame_ms: f64, text: &str) {
    assert!(
        !words.is_empty(),
        "a frame claimed timing but listed no words: {text:?}"
    );

    let mut previous = f64::NEG_INFINITY;
    for word in words {
        assert!(!word.text.is_empty(), "an empty word came back: {words:?}");
        assert!(
            !word.text.contains('\u{2581}') && !word.text.starts_with(' '),
            "the sub-word boundary marker leaked into a word: {:?}",
            word.text
        );
        assert!(word.start_ms.is_finite(), "a non-finite word clock: {word:?}");
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

    // The words must BE the transcript, not merely plausible strings with
    // plausible clocks. Whitespace-insensitive because the reconstruction
    // attaches punctuation to the word it follows and the transcript spaces it.
    let squashed = |s: &str| s.chars().filter(|c| !c.is_whitespace()).collect::<String>();
    let rebuilt: String = squashed(&words.iter().map(|w| w.text.clone()).collect::<String>());
    assert_eq!(
        rebuilt,
        squashed(text),
        "the timed words do not spell the frame's own transcript"
    );
}

/// #258, against the real graphs rather than synthetic ones.
///
/// The shipped bundle must pass the check that stands in front of onnxruntime,
/// and the same bundle with its decoder cut in half, or replaced by noise of
/// the same length, must be refused by `validate` AND by `load` before the C
/// library reads a byte of it. If the check ever lets one through, this test
/// does not fail politely — the test process aborts, which is the bug.
///
/// The undamaged graphs are linked rather than copied: `detect` follows
/// links, and copying 150 MB of encoder per run would prove nothing extra.
/// Symlinks on Unix; hard links on Windows, where a symlink needs a privilege
/// an ordinary account does not have and a hard link on NTFS does not.
#[test]
fn a_damaged_copy_of_the_shipped_bundle_is_refused_rather_than_loaded() {
    let Some(dir) = require_model() else { return };
    let files = cc_stt::local::ModelFiles::detect(&dir).unwrap();
    files.check_graphs(&dir).expect("the shipped graphs must pass the envelope check");

    let decoder = std::fs::read(dir.join(&files.decoder)).unwrap();
    let mut state: u32 = 0x2545_f491;
    let noise: Vec<u8> = (0..decoder.len())
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            (state >> 11) as u8
        })
        .collect();

    for (label, damaged) in [("cut", &decoder[..decoder.len() / 2]), ("noise", &noise[..])] {
        // Per process, so two checkouts running the suite at once cannot
        // delete each other's copy.
        let copy = std::env::temp_dir()
            .join(format!("cc-stt-damaged-shipped-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&copy);
        std::fs::create_dir_all(&copy).unwrap();
        for entry in std::fs::read_dir(&dir).unwrap().flatten() {
            let name = entry.file_name();
            if name.to_string_lossy() != files.decoder {
                #[cfg(unix)]
                std::os::unix::fs::symlink(entry.path(), copy.join(&name)).unwrap();
                // A hard link cannot cross volumes — a model on D: with the
                // temp directory on C: — so that case copies instead.
                #[cfg(windows)]
                std::fs::hard_link(entry.path(), copy.join(&name))
                    .or_else(|_| std::fs::copy(entry.path(), copy.join(&name)).map(drop))
                    .unwrap();
            }
        }
        std::fs::write(copy.join(&files.decoder), damaged).unwrap();

        let config = LocalSttConfig::for_model(default_model(), &copy);
        let error = config.validate().expect_err(label);
        assert!(error.contains(&files.decoder), "{label}: {error}");
        let error = LocalRecognizer::load(&config).err().expect(label);
        assert!(error.contains("not a readable ONNX model"), "{label}: {error}");
        let _ = std::fs::remove_dir_all(&copy);
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
    if !synthesizer_available() {
        eprintln!("SKIPPING {}: no speech synthesiser on this machine", module_path!());
        return;
    }
    let speech = speech_pcm16("The quick brown fox jumps over the lazy dog");
    let recognizer =
        LocalRecognizer::load(&LocalSttConfig::for_model(default_model(), dir)).expect("model loads");

    let mut frames = Vec::new();
    let mut session = recognizer.session(3);
    push_in_frames(&mut session, &speech, &mut frames);
    session.finish(&mut |f| frames.push(f));

    let starts = item_starts(&frames);
    assert!(
        !starts.is_empty(),
        "real speech produced no utterance: {frames:?}"
    );
    let start_of = |id: &str| {
        starts
            .iter()
            .find(|(item, _)| item == id)
            .map(|(_, at)| *at)
            .unwrap_or_else(|| panic!("a frame for {id} with no ItemStarted: {frames:?}"))
    };

    // Bound to the item each frame actually belongs to. Checking every frame
    // against the FIRST item's start would let a take that split into two
    // utterances pass while the first one carried no timing at all.
    let mut timed_frames = 0;
    for frame in &frames {
        let Some((item_id, words, frame_ms)) = timed(frame) else {
            continue;
        };
        timed_frames += 1;
        assert_timing_is_sound(
            words,
            start_of(item_id),
            frame_ms,
            frame_text(frame).unwrap_or_default(),
        );
    }
    assert!(
        timed_frames > 0,
        "no frame carried word timing — the recogniser reports it and we are dropping it again: {frames:?}"
    );

    // Several words were spoken, so several words must be separately timed. One
    // word, or several sharing a clock, would satisfy every check above while
    // carrying no more information than the item clock we already had.
    let (_, final_words, _) = frames
        .iter()
        .rev()
        .find(|f| matches!(f, SttFrame::Final { .. }))
        .and_then(timed)
        // The final is the frame the ledger treats as authoritative, and it is
        // built from cached state rather than a fresh result — the one place
        // this could plausibly arrive empty.
        .unwrap_or_else(|| panic!("the final carried no timing: {frames:?}"));
    assert!(
        final_words.len() >= 4,
        "a nine-word sentence produced {} timed words: {final_words:?}",
        final_words.len()
    );
    let distinct = final_words
        .iter()
        .map(|w| w.start_ms.to_bits())
        .collect::<std::collections::HashSet<_>>();
    assert!(
        distinct.len() >= 4,
        "the words share {} distinct clocks — this is item-level timing wearing a word-level shape: {final_words:?}",
        distinct.len()
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
    if !synthesizer_available() {
        eprintln!("SKIPPING {}: no speech synthesiser on this machine", module_path!());
        return;
    }
    let one = speech_pcm16("The quick brown fox jumps over the lazy dog");
    let two = speech_pcm16("Pack my box with five dozen liquor jugs");

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

    let starts = item_starts(&frames);
    assert!(
        starts.len() >= 2,
        "the gap did not split the take into two utterances: {frames:?}"
    );
    // By id, not by clock. Item starts are monotonic but not strictly so, and
    // selecting on an f64 would silently pick the earlier of two that tie.
    let (second_id, second_start) = starts[1].clone();

    let second_words: Vec<_> = frames
        .iter()
        .filter_map(timed)
        .filter(|(item_id, _, _)| *item_id == second_id)
        .collect();
    assert!(
        !second_words.is_empty(),
        "the second utterance carried no timing: {frames:?}"
    );

    for (_, words, _) in &second_words {
        assert!(
            !words.is_empty(),
            "the second utterance claimed timing but listed no words: {frames:?}"
        );
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

    // The assertion above CANNOT fail on its own, and that is the point of this
    // one. `reconstruct` floors every word at the item start, which is the very
    // number being compared against — so an implementation that dated the
    // second segment from zero would have every word clamped up to
    // `second_start` and sail through. What that bug actually destroys is
    // RESOLUTION: the words collapse onto the floor and stop being distinct.
    // Requiring spread is the only way to see it.
    let (_, last_words, _) = second_words
        .last()
        .expect("checked non-empty above");
    let distinct = last_words
        .iter()
        .map(|w| w.start_ms.to_bits())
        .collect::<std::collections::HashSet<_>>();
    assert!(
        distinct.len() >= 3,
        "the second utterance's words hold only {} distinct clocks ({last_words:?}) — they have \
         collapsed onto the item start, which is what dating a new segment from zero looks like \
         after clamping",
        distinct.len()
    );
    assert!(
        last_words.iter().any(|w| w.start_ms > second_start + 1.0),
        "every word of the second utterance sits exactly on its item start: {last_words:?}"
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
