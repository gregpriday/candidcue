//! On-device streaming STT: sherpa-onnx + a streaming Zipformer transducer.
//!
//! This is the engine the app ships. It replaces a websocket to a paid service
//! with ~43 MB of model files on disk, and it emits the *same* [`SttFrame`]
//! stream the Inworld client did — which is the whole point. The alignment
//! engine, the replay harness and the evaluator are all written against that
//! protocol, so swapping the recogniser underneath is a controlled experiment
//! rather than a rewrite.
//!
//! Two things about this model are worth knowing before reading the code:
//!
//! * It writes **UPPERCASE, unpunctuated** text. Nothing downstream cares —
//!   `cc_align::normalize` folds case and strips punctuation — but it means
//!   the raw transcript is not something to show a presenter.
//! * It is a *streaming* transducer, not a windowed encoder-decoder. A new
//!   hypothesis is available roughly every time enough frames have arrived,
//!   which on this machine is far more often than the ~1 s Inworld partial
//!   cadence. We emit on every CHANGE rather than on a timer: the engine costs
//!   ~90 µs an event, and earlier evidence is the entire product.
//!
//! Utterance identity is minted here exactly as the Inworld client minted it —
//! ids are `"{generation}-{ordinal}"` — so a captured log from either source is
//! indistinguishable to the replay harness.

use std::path::PathBuf;

use sherpa_onnx::{OnlineRecognizer, OnlineRecognizerConfig, OnlineStream};

use crate::SttFrame;

/// The four files a streaming transducer needs. INT8 encoder and joiner with
/// an FP32 decoder is the combination the upstream INT8 example uses; the
/// decoder is 2 MB and quantising it buys nothing.
pub const ENCODER_FILE: &str = "encoder-epoch-99-avg-1.int8.onnx";
pub const DECODER_FILE: &str = "decoder-epoch-99-avg-1.onnx";
pub const JOINER_FILE: &str = "joiner-epoch-99-avg-1.int8.onnx";
pub const TOKENS_FILE: &str = "tokens.txt";

/// Every file the recogniser loads, in load order. Used to validate a bundle
/// before trying to start a take — a missing file should be a clear error at
/// the top of a session, not a null pointer from the C library.
pub const MODEL_FILES: [&str; 4] = [ENCODER_FILE, DECODER_FILE, JOINER_FILE, TOKENS_FILE];

/// Tuning knobs for the local recogniser.
///
/// The endpoint rules are the load-bearing ones. sherpa's own defaults are
/// zero for all three (see `OnlineRecognizerConfig::default`), which disables
/// the rules rather than applying the documented values, so they must be set
/// explicitly or `enable_endpoint` silently does nothing.
#[derive(Debug, Clone)]
pub struct LocalSttConfig {
    /// Directory holding the four files in [`MODEL_FILES`].
    pub model_dir: PathBuf,
    /// Inference threads. One is the right starting point for a 20M model —
    /// scheduling overhead can swamp the parallelism.
    pub num_threads: i32,
    /// ONNX Runtime execution provider: `cpu` | `coreml` | `cuda` | `directml`.
    ///
    /// Left at `cpu`, and that is a measurement rather than an oversight.
    ///
    /// Two facts decide it. First, the prebuilt runtime the `sherpa-onnx` crate
    /// links has **no CoreML provider compiled in** — `libonnxruntime.a` for
    /// macOS arm64 contains zero CoreML symbols, and asking for it logs
    /// "CoreML is for Apple only since onnxruntime>=1.15. Fallback to cpu!"
    /// and runs on the CPU anyway, at timings identical to `cpu`. Getting a
    /// real GPU path means building sherpa-onnx from source with the provider
    /// enabled and pointing `SHERPA_ONNX_LIB_DIR` at it.
    ///
    /// Second, and the reason that is not worth doing: this model decodes at a
    /// real-time factor of ~0.017 on one thread — 1.7% of a single core, ~280 ms
    /// of compute for 16.7 s of speech. There is no headroom problem to solve,
    /// and a GPU path would add a host↔device copy to every 100 ms chunk to
    /// accelerate work that is already noise. The knob exists so a future model
    /// that *does* need it is a config change rather than a code change.
    pub provider: String,
    /// `greedy_search` | `modified_beam_search`. Greedy is the speed-first
    /// choice and is what the benchmark numbers were taken with.
    pub decoding_method: String,
    /// Trailing silence that ends an utterance with nothing decoded yet.
    pub rule1_min_trailing_silence: f32,
    /// Trailing silence that ends an utterance after speech. The one that
    /// matters: it decides how long a presenter's dramatic pause can be
    /// before the take is cut into two utterances.
    pub rule2_min_trailing_silence: f32,
    /// Hard cap on a single utterance, seconds.
    pub rule3_min_utterance_length: f32,
}

impl Default for LocalSttConfig {
    fn default() -> Self {
        Self {
            model_dir: PathBuf::new(),
            // Two threads: measured 227 ms vs 284 ms for 16.7 s of speech at
            // one. Both are far under budget, and past two the returns are
            // small enough not to be worth the cores during a take.
            num_threads: 2,
            provider: "cpu".to_string(),
            decoding_method: "greedy_search".to_string(),
            // Upstream's documented defaults for this model. rule2 at 1.2 s is
            // close to Inworld's measured end-of-turn behaviour, which keeps
            // utterance granularity comparable between the two recognisers.
            rule1_min_trailing_silence: 2.4,
            rule2_min_trailing_silence: 1.2,
            rule3_min_utterance_length: 20.0,
        }
    }
}

impl LocalSttConfig {
    pub fn with_model_dir(dir: impl Into<PathBuf>) -> Self {
        Self {
            model_dir: dir.into(),
            ..Self::default()
        }
    }

    /// Check every model file is present, returning the first that is not.
    ///
    /// Worth calling before a take: `OnlineRecognizer::create` answers a
    /// missing file with a null pointer and no reason.
    pub fn validate(&self) -> Result<(), String> {
        for file in MODEL_FILES {
            let path = self.model_dir.join(file);
            if !path.is_file() {
                return Err(format!("missing STT model file: {}", path.display()));
            }
        }
        Ok(())
    }
}

/// A loaded model. Expensive to build (~200 ms), cheap to create streams from,
/// and `Send + Sync`, so the app loads it once and keeps it resident.
pub struct LocalRecognizer {
    inner: OnlineRecognizer,
}

impl LocalRecognizer {
    pub fn load(config: &LocalSttConfig) -> Result<Self, String> {
        config.validate()?;
        let path = |file: &str| Some(config.model_dir.join(file).to_string_lossy().into_owned());

        let mut sys = OnlineRecognizerConfig::default();
        sys.model_config.transducer.encoder = path(ENCODER_FILE);
        sys.model_config.transducer.decoder = path(DECODER_FILE);
        sys.model_config.transducer.joiner = path(JOINER_FILE);
        sys.model_config.tokens = path(TOKENS_FILE);
        sys.model_config.num_threads = config.num_threads;
        sys.model_config.provider = Some(config.provider.clone());
        sys.model_config.debug = false;
        sys.decoding_method = Some(config.decoding_method.clone());
        sys.enable_endpoint = true;
        sys.rule1_min_trailing_silence = config.rule1_min_trailing_silence;
        sys.rule2_min_trailing_silence = config.rule2_min_trailing_silence;
        sys.rule3_min_utterance_length = config.rule3_min_utterance_length;

        OnlineRecognizer::create(&sys)
            .map(|inner| Self { inner })
            .ok_or_else(|| {
                format!(
                    "sherpa-onnx could not load the model in {}",
                    config.model_dir.display()
                )
            })
    }

    /// Begin one take. `generation` is minted into the item ids exactly as the
    /// app's session generation was on the websocket path.
    pub fn session(&self, generation: u64) -> LocalSession<'_> {
        LocalSession {
            recognizer: &self.inner,
            stream: self.inner.create_stream(),
            generation,
            ordinal: 0,
            open_item: None,
            last_text: String::new(),
            samples_fed: 0,
            sample_rate: 0,
            started: std::time::Instant::now(),
            last_emitted_ms: 0.0,
        }
    }
}

/// One take's worth of streaming state.
///
/// The audio clock is the count of samples handed to the recogniser, which is
/// the same definition the websocket client used (bytes sent to the socket).
/// That equivalence is what lets timing metrics be compared across the two.
pub struct LocalSession<'a> {
    recognizer: &'a OnlineRecognizer,
    stream: OnlineStream,
    generation: u64,
    ordinal: u64,
    open_item: Option<String>,
    last_text: String,
    samples_fed: u64,
    sample_rate: u32,
    started: std::time::Instant,
    /// Audio-clock time of the most recent frame emitted, so the stream this
    /// session produces is monotonic. See [`LocalSession::publish`].
    last_emitted_ms: f64,
}

impl LocalSession<'_> {
    /// Audio-clock milliseconds consumed so far.
    pub fn audio_ms(&self) -> f64 {
        if self.sample_rate == 0 {
            return 0.0;
        }
        self.samples_fed as f64 * 1000.0 / self.sample_rate as f64
    }

    fn wall_ms(&self) -> f64 {
        self.started.elapsed().as_secs_f64() * 1000.0
    }

    /// Feed interleaved PCM16 little-endian bytes at `sample_rate`.
    ///
    /// sherpa resamples internally, so the true capture rate should be passed
    /// rather than forcing the device to 16 kHz — plenty of interfaces only
    /// offer 44.1/48 kHz reliably.
    pub fn push_pcm16(
        &mut self,
        bytes: &[u8],
        sample_rate: u32,
        emit: &mut impl FnMut(SttFrame),
    ) {
        let samples: Vec<f32> = bytes
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
            .collect();
        self.push_samples(&samples, sample_rate, emit);
    }

    /// Feed mono `f32` samples in `[-1, 1]` at `sample_rate`.
    pub fn push_samples(
        &mut self,
        samples: &[f32],
        sample_rate: u32,
        emit: &mut impl FnMut(SttFrame),
    ) {
        if samples.is_empty() {
            return;
        }
        self.sample_rate = sample_rate;
        self.samples_fed += samples.len() as u64;
        self.stream.accept_waveform(sample_rate as i32, samples);
        self.drain(emit);
    }

    /// Decode everything the recogniser is ready for, then publish whatever
    /// changed and close the utterance if the endpoint rules fired.
    fn drain(&mut self, emit: &mut impl FnMut(SttFrame)) {
        while self.recognizer.is_ready(&self.stream) {
            self.recognizer.decode(&self.stream);
        }
        self.publish(emit);

        // Endpointing is only meaningful once the pending frames are decoded,
        // which is why this follows the loop rather than sharing it.
        if self.recognizer.is_endpoint(&self.stream) {
            self.close_item(emit);
            self.recognizer.reset(&self.stream);
        }
    }

    /// Emit a partial if the hypothesis moved. Opens the utterance on the
    /// first non-empty text — silence must not mint an item, or a take that
    /// starts with a throat-clear gets an empty utterance before the first
    /// word.
    fn publish(&mut self, emit: &mut impl FnMut(SttFrame)) {
        let Some(result) = self.recognizer.get_result(&self.stream) else {
            return;
        };
        let text = result.text.trim().to_string();
        if text.is_empty() || text == self.last_text {
            return;
        }

        let audio_ms = self.audio_ms();
        let item_id = match &self.open_item {
            Some(id) => id.clone(),
            None => {
                let id = format!("{}-{}", self.generation, self.ordinal);
                self.ordinal += 1;
                self.open_item = Some(id.clone());
                // `start_time` is where the recogniser believes this segment
                // began, which is a truer utterance start than "when the first
                // hypothesis surfaced" — the model needs acoustic context
                // before it commits to a word.
                //
                // CLAMPED into [last emitted, now], because it is the one
                // number here that can point BACKWARDS: sherpa dates a segment
                // from before the endpoint that closed the previous one, so a
                // raw `start_time` can precede the `Final` just emitted. The
                // engine happens to guard its evidence clock with a `.max()`,
                // but it still timestamps the snapshot with whatever arrives,
                // and a stream that steps backwards is not what the hosted
                // client produced — it dated items from the current audio
                // clock. Keeping the sequence monotonic keeps the two
                // recognisers comparable, which is the entire point of the
                // shared protocol.
                let audio_start_ms = result
                    .start_time
                    .map(|s| s as f64 * 1000.0)
                    .unwrap_or(audio_ms)
                    .clamp(self.last_emitted_ms, audio_ms);
                self.last_emitted_ms = audio_start_ms;
                emit(SttFrame::ItemStarted {
                    item_id: id.clone(),
                    ordinal: self.ordinal - 1,
                    audio_start_ms,
                });
                id
            }
        };

        self.last_text = text.clone();
        self.last_emitted_ms = self.last_emitted_ms.max(audio_ms);
        emit(SttFrame::Partial {
            item_id,
            text,
            audio_ms,
            wall_ms: self.wall_ms(),
        });
    }

    /// Close the open utterance, if any, with the last hypothesis as its final.
    fn close_item(&mut self, emit: &mut impl FnMut(SttFrame)) {
        let Some(item_id) = self.open_item.take() else {
            // Endpoint on silence: reset the decoder, mint nothing.
            self.last_text.clear();
            return;
        };
        let text = std::mem::take(&mut self.last_text);
        self.last_emitted_ms = self.last_emitted_ms.max(self.audio_ms());
        emit(SttFrame::Final {
            item_id,
            text,
            audio_end_ms: self.audio_ms(),
            wall_ms: self.wall_ms(),
        });
    }

    /// End the take: flush the encoder's trailing context, publish the last
    /// hypothesis and close the open utterance.
    ///
    /// The websocket client had to send `endTurn` for the same reason — server
    /// VAD never sees silence from a stream that simply stopped.
    pub fn finish(&mut self, emit: &mut impl FnMut(SttFrame)) {
        self.stream.input_finished();
        while self.recognizer.is_ready(&self.stream) {
            self.recognizer.decode(&self.stream);
            self.publish(emit);
        }
        self.publish(emit);
        self.close_item(emit);
        emit(SttFrame::Closed {});
    }
}

/// Stream a whole PCM16 buffer through the local recogniser at `pace` ×
/// real time, in `frame_ms` slices.
///
/// This is the offline twin of the app's capture loop, and it is what the
/// benchmark harness uses. `pace = 1.0` is the honest setting: the model is
/// ~16× faster than real time here, so streaming faster would report partial
/// latencies no presenter will ever see.
pub fn stream_pcm16(
    recognizer: &LocalRecognizer,
    pcm: &[u8],
    sample_rate: u32,
    frame_ms: u64,
    pace: f64,
    mut emit: impl FnMut(SttFrame),
) {
    let mut session = recognizer.session(1);
    let frame_bytes = (sample_rate as usize * 2 * frame_ms as usize / 1000) & !1;
    let frame_interval = std::time::Duration::from_secs_f64(frame_ms as f64 / 1000.0 / pace);
    let start = std::time::Instant::now();

    let mut offset = 0usize;
    let mut frame_index = 0u32;
    while offset < pcm.len() {
        let end = (offset + frame_bytes).min(pcm.len());
        session.push_pcm16(&pcm[offset..end], sample_rate, &mut emit);
        offset = end;
        frame_index += 1;

        // Sleep to the schedule rather than by a fixed step, so decode time is
        // absorbed by the interval instead of accumulating into drift.
        let due = frame_interval * frame_index;
        if let Some(remaining) = due.checked_sub(start.elapsed()) {
            std::thread::sleep(remaining);
        }
    }
    session.finish(&mut emit);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_model_file_names_itself() {
        let config = LocalSttConfig::with_model_dir("/nonexistent/model/dir");
        let error = config.validate().unwrap_err();
        assert!(error.contains(ENCODER_FILE), "{error}");
    }

    #[test]
    fn endpoint_rules_are_set_rather_than_left_at_sherpas_zeroes() {
        // Regression guard: `enable_endpoint` alone does nothing, because
        // sherpa's own defaults for all three rules are 0.0.
        let config = LocalSttConfig::default();
        assert!(config.rule2_min_trailing_silence > 0.0);
        assert!(config.rule1_min_trailing_silence > 0.0);
        assert!(config.rule3_min_utterance_length > 0.0);
    }
}
