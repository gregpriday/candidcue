//! TEMPORARY PROBE — answers issue #164's two measurement questions.
//!
//! 1. Are `timestamps` segment-relative or stream-absolute?
//! 2. Is a token timestamp the token's onset or its end?
//!
//! Run: cargo run --release -p cc-stt --example probe_timestamps -- <a.wav> <b.wav>
//!
//! One WORD per file when measuring onset-vs-end (`CC_PROBE_TRIM=1`): trimming
//! gives the outer boundary of each file, so a file holding a whole sentence
//! pins only its first word's onset and its last word's end. `say -o w.wav
//! --data-format=LEI16@24000 banana` per word, then let this concatenate them
//! with an exact gap — that is what makes every onset known.
//!
//! Builds the recogniser directly rather than through `LocalRecognizer` because
//! the raw `RecognizerResult` has to be read at EVERY `get_result()`, and the
//! session only reads it at one point.

use std::path::{Path, PathBuf};

use cc_stt::local::{ModelFiles, TOKENS_FILE};
use cc_stt::models::default_model;
use sherpa_onnx::{OnlineRecognizer, OnlineRecognizerConfig};

/// PCM16 samples out of a `say`-produced WAV, by walking the RIFF chunks
/// rather than assuming a 44-byte header — `say` does not always write one.
fn wav_pcm16(path: &Path) -> (Vec<f32>, u32) {
    let bytes = std::fs::read(path).expect("read wav");
    assert_eq!(&bytes[0..4], b"RIFF", "not a RIFF file: {}", path.display());

    let mut pos = 12;
    let mut sample_rate = 0u32;
    loop {
        let id = &bytes[pos..pos + 4];
        let size = u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into().unwrap()) as usize;
        let body = pos + 8;
        if id == b"fmt " {
            sample_rate = u32::from_le_bytes(bytes[body + 4..body + 8].try_into().unwrap());
        }
        if id == b"data" {
            let samples = bytes[body..body + size]
                .chunks_exact(2)
                .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
                .collect();
            return (samples, sample_rate);
        }
        pos = body + size + (size & 1);
    }
}

fn model_dir() -> PathBuf {
    // `CC_MODEL_DIR` lets a worktree borrow the main checkout's fetched graphs —
    // the bundle is gitignored, so a fresh worktree has an empty models/ tree.
    if let Ok(dir) = std::env::var("CC_MODEL_DIR") {
        return PathBuf::from(dir);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../src-tauri")
        .join(default_model().resource_dir)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    assert!(!args.is_empty(), "usage: probe_timestamps <wav> [<wav>...]");

    let dir = model_dir();
    let files = ModelFiles::detect(&dir).expect("model bundle detects");
    let path = |f: &str| Some(dir.join(f).to_string_lossy().into_owned());

    let tuning = default_model().tuning;
    let mut sys = OnlineRecognizerConfig::default();
    sys.model_config.transducer.encoder = path(&files.encoder);
    sys.model_config.transducer.decoder = path(&files.decoder);
    sys.model_config.transducer.joiner = path(&files.joiner);
    sys.model_config.tokens = path(TOKENS_FILE);
    if let Some(bpe) = &files.bpe_vocab {
        sys.model_config.bpe_vocab = path(bpe);
    }
    sys.model_config.num_threads = 1;
    sys.model_config.provider = Some("cpu".into());
    sys.model_config.debug = false;
    sys.decoding_method = Some("greedy_search".into());
    sys.enable_endpoint = true;
    sys.rule1_min_trailing_silence = tuning.rule1_min_trailing_silence;
    sys.rule2_min_trailing_silence = tuning.rule2_min_trailing_silence;
    sys.rule3_min_utterance_length = tuning.rule3_min_utterance_length;
    sys.blank_penalty = tuning.blank_penalty;
    sys.max_active_paths = 4;

    let recognizer = OnlineRecognizer::create(&sys).expect("recogniser loads");
    let stream = recognizer.create_stream();

    // One continuous stream: utterance, silence, utterance. The default 2 s gap
    // is above rule2 (1.2 s) so it forces an endpoint — that is what reaches a
    // second segment. `CC_PROBE_GAP_MS` below rule2 keeps it all in segment 0.
    //
    // `CC_PROBE_TRIM=1` strips each file's own leading/trailing silence first,
    // so the gap is exact and every word's true onset is known to the ms. That
    // is what makes the onset-vs-end question answerable.
    let gap_ms: usize = std::env::var("CC_PROBE_GAP_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(2000);
    let trim = std::env::var("CC_PROBE_TRIM").is_ok();
    let lead_ms: usize = std::env::var("CC_PROBE_LEAD_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    let mut all: Vec<f32> = Vec::new();
    let mut rate = 0;
    let mut boundaries_ms: Vec<(f64, f64)> = Vec::new();
    for (i, arg) in args.iter().enumerate() {
        let (mut samples, sr) = wav_pcm16(Path::new(arg));
        // Every input has to share a rate: the whole concatenation is fed at
        // ONE rate, so a stray 16 kHz file would silently re-date every
        // boundary already measured off the files before it.
        assert!(
            rate == 0 || rate == sr,
            "{arg} is {sr} Hz but an earlier file was {rate} Hz — the measurement \
             would be against the wrong clock"
        );
        rate = sr;
        if trim {
            // 1/1000 of full scale — `say` pads generously with true digital
            // silence, so anything above the noise floor is the word itself.
            let loud = |s: &f32| s.abs() > 0.001;
            let first = samples
                .iter()
                .position(loud)
                .unwrap_or_else(|| panic!("{arg} is silent — there is no onset to measure"));
            let last = samples.iter().rposition(loud).expect("a loud sample exists");
            samples = samples[first..=last].to_vec();
        }
        if i == 0 && lead_ms > 0 {
            all.extend(std::iter::repeat_n(0.0, sr as usize * lead_ms / 1000));
        }
        if i > 0 {
            all.extend(std::iter::repeat_n(0.0, sr as usize * gap_ms / 1000));
        }
        let start_ms = (all.len() as f64) * 1000.0 / sr as f64;
        all.extend_from_slice(&samples);
        let end_ms = (all.len() as f64) * 1000.0 / sr as f64;
        boundaries_ms.push((start_ms, end_ms));
        println!(
            "# utterance {i}: {} => TRUE audio {start_ms:.0}..{end_ms:.0} ms",
            Path::new(arg).file_stem().unwrap().to_string_lossy()
        );
    }
    println!("# sample_rate={rate}  total={:.0} ms", all.len() as f64 * 1000.0 / rate as f64);
    println!("# rule2_min_trailing_silence={} s", tuning.rule2_min_trailing_silence);
    println!();

    let chunk = (rate as usize) / 10; // 100 ms, the app's frame size
    let mut fed = 0usize;
    let mut last_dump = String::new();

    for slice in all.chunks(chunk) {
        stream.accept_waveform(rate as i32, slice);
        fed += slice.len();
        let audio_ms = fed as f64 * 1000.0 / rate as f64;

        while recognizer.is_ready(&stream) {
            recognizer.decode(&stream);
        }

        if let Some(r) = recognizer.get_result(&stream) {
            let text = r.text.trim();
            if !text.is_empty() {
                // Only print when something moved, so the log is readable.
                let dump = format!("{}|{:?}", text, r.timestamps);
                if dump != last_dump {
                    last_dump = dump;
                    println!(
                        "audio={audio_ms:8.0}  segment={:?}  start_time={:?}  is_final={}",
                        r.segment, r.start_time, r.is_final
                    );
                    println!("   text: {text}");
                    println!("   tokens:     {:?}", r.tokens);
                    println!("   timestamps: {:?}", r.timestamps);
                    if let (Some(ts), Some(st)) = (&r.timestamps, r.start_time) {
                        let abs: Vec<String> = ts
                            .iter()
                            .map(|t| format!("{:.0}", (st + t) as f64 * 1000.0))
                            .collect();
                        let raw: Vec<String> =
                            ts.iter().map(|t| format!("{:.0}", *t as f64 * 1000.0)).collect();
                        println!("   raw_ms:            [{}]", raw.join(", "));
                        println!("   start_time+ts_ms:  [{}]", abs.join(", "));
                    }
                    println!();
                }
            }
        }

        if recognizer.is_endpoint(&stream) {
            println!(">>> ENDPOINT at audio={audio_ms:.0} ms — resetting\n");
            recognizer.reset(&stream);
            last_dump.clear();
        }
    }

    stream.input_finished();
    while recognizer.is_ready(&stream) {
        recognizer.decode(&stream);
    }
    if let Some(r) = recognizer.get_result(&stream) {
        println!("FINAL  segment={:?}  start_time={:?}", r.segment, r.start_time);
        println!("   text: {}", r.text.trim());
        println!("   tokens:     {:?}", r.tokens);
        println!("   timestamps: {:?}", r.timestamps);
    }
    println!("\n# ground truth boundaries (ms): {boundaries_ms:?}");
}
