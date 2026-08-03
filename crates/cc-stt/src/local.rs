//! On-device streaming STT: sherpa-onnx + a streaming Zipformer transducer.
//!
//! This is the engine the app ships, and the only one: model files on disk, no
//! network. It emits the [`SttFrame`] protocol the alignment engine, the replay
//! harness and the evaluator are all written against, which is what lets the
//! recogniser be changed underneath as a controlled experiment rather than a
//! rewrite — and what keeps the frozen corpora under `bench/runs*/` readable.
//!
//! Two things about the shipping model are worth knowing before reading the
//! code:
//!
//! * It emits **punctuation and true case**. The first bundled model did not
//!   (UPPERCASE, unpunctuated), and nothing downstream cared either way —
//!   `cc_align::normalize` folds case and strips punctuation before matching.
//! * It is a *streaming* transducer, not a windowed encoder-decoder. A new
//!   hypothesis is available roughly every time enough frames have arrived —
//!   far more often than the ~1 s partial cadence the captured corpora were
//!   recorded at. We emit on every CHANGE rather than on a timer: the engine
//!   costs ~90 µs an event, and earlier evidence is the entire product.
//!
//! The bundle is not fixed: [`ModelFiles::detect`] works out how a given one
//! names its graphs, because upstream is not consistent and ships no manifest.
//!
//! Utterance identity is minted here in the shape the replay corpora already
//! hold — ids are `"{generation}-{ordinal}"` — so a log captured today and one
//! captured before this module existed are indistinguishable to the harness.

use std::path::PathBuf;

use sherpa_onnx::{OnlineRecognizer, OnlineRecognizerConfig, OnlineStream};

use crate::{SttFrame, WordTime};

/// The token table. Every sherpa transducer bundle names this the same.
pub const TOKENS_FILE: &str = "tokens.txt";

/// How a bundle names its three graphs.
///
/// Upstream is not consistent about this and there is no manifest to ask, so
/// the layout is DETECTED rather than assumed: the LibriSpeech-era bundles use
/// `encoder-epoch-99-avg-1.int8.onnx`, the 2026 x-asr bundles use a plain
/// `encoder.int8.onnx`. Hard-coding one set means the other fails to load with
/// a null pointer and no reason.
///
/// Detection reads the directory and matches on SHAPE — role prefix plus
/// precision suffix — rather than against a list of names seen so far. The list
/// was the more cautious-looking option and it was the wrong one: it appeared
/// to work right up until it met a bundle nobody had added, and the Apache-2.0
/// French model (`encoder-epoch-29-avg-9-with-averaged-model.int8.onnx`) is
/// exactly that bundle. A rule that admits an unseen name is testable against
/// the naming convention; a list can only ever be tested against itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelFiles {
    pub encoder: String,
    pub decoder: String,
    pub joiner: String,
    /// A SentencePiece **`.vocab`** beside the tokens, if the bundle ships one.
    ///
    /// Deliberately NOT `bpe.model`, which several bundles ship instead. The
    /// two are different formats: sherpa's `bpe_vocab` wants the two-column
    /// text vocabulary, and `bpe.model` is the binary SentencePiece model.
    /// Handing over the binary is silently accepted under greedy decoding —
    /// nothing reads it — and then fails to do anything useful the day someone
    /// turns on the hotword path it exists for. A capability that is wired up
    /// wrong is worse than one that is absent, because it looks done.
    pub bpe_vocab: Option<String>,
}

/// Which precision to take when a bundle ships a role at both.
///
/// Per role rather than per bundle, because the right answer differs by role
/// and always has — see the two call sites in [`ModelFiles::detect`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Precision {
    /// Quantised: `<stem>.int8.onnx`.
    Int8,
    /// Unquantised: `<stem>.onnx`.
    ///
    /// Only these two, deliberately. Upstream also publishes `.fp16.onnx` for
    /// some families, and such a file is REFUSED here rather than treated as
    /// unquantised — its stem would be `encoder.fp16`, which is not a role.
    /// That is the wanted answer: half precision on the CPU provider this app
    /// pins is not a configuration any of its numbers were taken with, and
    /// loading one silently would mean benchmarking a recogniser nobody had
    /// measured. Refusing says so, and the error lists what the directory
    /// holds.
    Fp32,
}

impl ModelFiles {
    /// Work out how this bundle names things, or say what is missing.
    ///
    /// One pass over the directory, because the alternative is a `is_file`
    /// syscall per candidate name and the candidate names are no longer
    /// enumerable.
    ///
    /// INT8 is preferred for the encoder and joiner where both precisions are
    /// present: it is what the benchmark numbers were taken with, and the FP32
    /// encoder is twice the size for accuracy this application spends on
    /// nothing. The decoder goes the other way — see below.
    pub fn detect(dir: &std::path::Path) -> Result<Self, String> {
        let entries = std::fs::read_dir(dir)
            .map_err(|err| format!("could not read the model directory {}: {err}", dir.display()))?;

        // Two lists: the graphs that name a role, and every `.onnx` file the
        // directory holds. The second exists for the error message. When a role
        // is missing it is almost always because a bundle was half-extracted or
        // the path is one level off, and "there is no encoder here, but there
        // IS an enc.onnx" ends that search immediately — where a list filtered
        // down to recognised names would have said the directory was empty.
        let mut graphs: Vec<(String, Precision)> = Vec::new();
        let mut onnx_files: Vec<String> = Vec::new();
        let mut has_tokens = false;
        let mut has_bpe_vocab = false;
        for entry in entries.flatten() {
            // `entry.path().is_file()` FOLLOWS symlinks; `entry.file_type()`
            // does not, and reports a symlinked graph as "not a file". The
            // enumerated-list version tested `dir.join(name).is_file()`, so a
            // model directory assembled out of symlinks — an ordinary way to
            // point a dev build at a bundle already on disk — has always
            // worked and must keep working.
            if !entry.path().is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            match name.as_str() {
                TOKENS_FILE => has_tokens = true,
                "bpe.vocab" => has_bpe_vocab = true,
                _ => {}
            }
            // Precision is classified BEFORE role, so that the `.int8` infix is
            // stripped from the stem rather than left for the role match to
            // trip over.
            let classified = name
                .strip_suffix(".int8.onnx")
                .map(|stem| (stem, Precision::Int8))
                .or_else(|| {
                    name.strip_suffix(".onnx")
                        .map(|stem| (stem, Precision::Fp32))
                });
            if let Some((stem, precision)) = classified {
                if role_of(stem).is_some() {
                    graphs.push((name.clone(), precision));
                }
                onnx_files.push(name);
            }
        }

        // `read_dir` yields entries in whatever order the filesystem hands
        // over — not sorted, and not stable between machines. Sorting makes an
        // ambiguous bundle resolve the same way twice, which matters because
        // the alternative is a model that loads differently on the presenter's
        // machine than on the one the benchmark ran on.
        //
        // SHORTEST NAME FIRST, then lexicographic. Not an aesthetic choice: the
        // enumerated list this replaced put the bare `encoder.int8.onnx` ahead
        // of `encoder-epoch-99-avg-1.int8.onnx`, and plain lexicographic order
        // reverses that, because `-` sorts before `.`. A directory holding both
        // would quietly start loading a different graph than it used to. Least
        // qualified name wins, which is the same rule the list encoded.
        //
        // Between two equally-qualified names it is deterministic and nothing
        // more. There is no universally better graph among, say, a `left-64`
        // and a `left-128` variant of the same checkpoint, and no manifest to
        // ask — so this picks one repeatably rather than pretending to judge.
        let by_length_then_name =
            |left: &String, right: &String| left.len().cmp(&right.len()).then_with(|| left.cmp(right));
        graphs.sort_by(|(left, _), (right, _)| by_length_then_name(left, right));
        onnx_files.sort();

        let pick = |role: &str, preferred: Precision| -> Result<String, String> {
            let of_role = |precision: Precision| {
                graphs
                    .iter()
                    .find(|(name, found)| *found == precision && role_of_name(name) == Some(role))
                    .map(|(name, _)| name.clone())
            };
            let fallback = match preferred {
                Precision::Int8 => Precision::Fp32,
                Precision::Fp32 => Precision::Int8,
            };
            of_role(preferred).or_else(|| of_role(fallback)).ok_or_else(|| {
                let found = if onnx_files.is_empty() {
                    "none".to_string()
                } else {
                    onnx_files.join(", ")
                };
                format!(
                    "no {role} found in {} (expected {role}.onnx, {role}.int8.onnx or a \
                     {role}-*.onnx variant; the ONNX files present are: {found})",
                    dir.display()
                )
            })
        };

        let encoder = pick("encoder", Precision::Int8)?;
        // The decoder stays FP32 by preference: it is small, and quantising it
        // buys nothing measurable.
        let decoder = pick("decoder", Precision::Fp32)?;
        let joiner = pick("joiner", Precision::Int8)?;
        if !has_tokens {
            return Err(format!("missing {TOKENS_FILE} in {}", dir.display()));
        }
        let bpe_vocab = has_bpe_vocab.then(|| "bpe.vocab".to_string());
        Ok(Self {
            encoder,
            decoder,
            joiner,
            bpe_vocab,
        })
    }
}

/// The three graph roles, in the order a bundle is searched for them.
const ROLES: [&str; 3] = ["encoder", "decoder", "joiner"];

/// Which graph a filename stem describes, if any.
///
/// The stem must be the bare role or the role followed by `-`. The hyphen is
/// load-bearing, and upstream naming is the reason. `encoder_adaptor.onnx` ships
/// in the FunASR-nano bundles and is an auxiliary adapter, NOT the acoustic
/// encoder; `decoder_joint-model.onnx` ships in the NeMo transducer bundles and
/// is a fused decoder+joiner this crate cannot drive at all. A bare
/// `starts_with` would load both as though they were the graph they are named
/// after. Requiring the hyphen refuses them.
///
/// It also refuses `encoder_prepared.onnx` from the RKNN conversion archives,
/// which IS an encoder — an accepted cost, because the refusal is loud and
/// names every ONNX file in the directory, whereas loading the wrong graph is
/// silent right up until a take produces nothing.
fn role_of(stem: &str) -> Option<&'static str> {
    ROLES
        .into_iter()
        .find(|role| stem == *role || stem.strip_prefix(role).is_some_and(|rest| rest.starts_with('-')))
}

/// [`role_of`] for a whole filename, re-deriving the stem.
fn role_of_name(name: &str) -> Option<&'static str> {
    let stem = name
        .strip_suffix(".int8.onnx")
        .or_else(|| name.strip_suffix(".onnx"))?;
    role_of(stem)
}

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
    /// Penalty subtracted from the blank symbol's score at each step.
    ///
    /// The single most valuable knob on this model, and the one that most
    /// clearly shows why word error rate is the wrong thing to tune for here.
    ///
    /// The model's worst habit is emitting blank over roughly the first five
    /// words of a stream, which are then lost for good — that is what made the
    /// first lock slow. A positive penalty makes blank less attractive, so the
    /// decoder commits to a token where it would otherwise have skipped.
    ///
    /// Swept on the Tier-B corpus, WER gets steadily WORSE as this rises while
    /// following gets BETTER, up to a clear optimum at 3.0:
    ///
    /// | blank_penalty | first_lock | recovery_p95 | within5 | p95   | WER   |
    /// |---------------|-----------|--------------|---------|-------|-------|
    /// | 0.0           | 3.10 s    | 4.35 s       | 92.26   | 7.40  | 19.3% |
    /// | 2.0           | 2.40 s    | 4.35 s       | 92.55   | 7.25  | 19.4% |
    /// | **3.0**       | **2.10 s**| **3.60 s**   | **92.74** | **6.99** | 20.1% |
    /// | 5.0           | 2.10 s    | 3.60 s       | 91.84   | 7.92  | 24.7% |
    /// | 6.0           | 2.10 s    | 3.60 s       | 90.69   | 9.03  | 31.2% |
    ///
    /// A recogniser that guesses more is a worse transcriber and a better
    /// position sensor, because a wrong word inside a correct run costs the
    /// tracker nothing while a missing word costs it evidence. Past 3.0 the
    /// guesses stop being anchored to anything and every metric turns.
    ///
    /// Re-swept when the bundled model changed, because a decoder constant
    /// tuned against one model is not evidence about another. The shipping
    /// x-asr model agrees, and reproduces the same inversion:
    ///
    /// | blank_penalty | within5 | freeze | WER   |
    /// |---|---|---|---|
    /// | 0.0 | 93.21 | 3.66% | 9.4%  |
    /// | 1.5 | 93.86 | 3.67% | 10.0% |
    /// | **3.0** | **94.03** | **3.33%** | 10.9% |
    pub blank_penalty: f32,
    /// Decoding beam width, used only by `modified_beam_search`.
    pub max_active_paths: i32,
    /// Milliseconds of silence fed to the decoder before a take's first real
    /// sample, to give the encoder acoustic context it would otherwise not
    /// have when the first word arrives.
    ///
    /// This model loses roughly the first five words of a stream — measured,
    /// and not an artefact of chunked feeding: decoding a whole fixture in one
    /// call loses them too. A streaming Zipformer needs left context before it
    /// will commit to a token, and at the very start of a session it has none,
    /// so the opening of a take is decoded from nothing and discarded.
    ///
    /// The primed silence is fed to the recogniser but NOT counted on the audio
    /// clock, because the clock is the contract with the alignment engine: it
    /// means "how much of the presenter's audio has been heard", and silence
    /// this side of the microphone is not that.
    pub prime_ms: u32,
}

/// The knobs that are a property of the MODEL rather than of the machine.
///
/// Deliberately has no [`Default`], and that absence is the whole point. These
/// values are measurements, and a measurement taken against one model is not
/// evidence about another — the doc comments on the corresponding
/// [`LocalSttConfig`] fields carry the sweeps that produced them. When they
/// were reachable through a default, every caller silently got one model's
/// numbers no matter which bundle it had opened, and that is not a mistake the
/// type system was helping with. It is now: a config cannot be built without
/// naming whose tuning it is using.
///
/// Every bundled model declares its own in [`crate::models`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LocalModelTuning {
    /// See [`LocalSttConfig::rule1_min_trailing_silence`].
    pub rule1_min_trailing_silence: f32,
    /// See [`LocalSttConfig::rule2_min_trailing_silence`].
    pub rule2_min_trailing_silence: f32,
    /// See [`LocalSttConfig::rule3_min_utterance_length`].
    pub rule3_min_utterance_length: f32,
    /// See [`LocalSttConfig::blank_penalty`] — the sweep tables are there.
    pub blank_penalty: f32,
    /// See [`LocalSttConfig::prime_ms`].
    pub prime_ms: u32,
}

impl LocalSttConfig {
    /// A config for one model directory, tuned as that model was measured.
    ///
    /// The tuning is a parameter rather than a default because it belongs to
    /// the bundle in `model_dir`; see [`LocalModelTuning`]. Everything else
    /// here is a property of the machine doing the decoding, not of the model,
    /// so it is chosen once and the same for every bundle.
    pub fn new(dir: impl Into<PathBuf>, tuning: LocalModelTuning) -> Self {
        Self {
            model_dir: dir.into(),
            // Two threads: measured 227 ms vs 284 ms for 16.7 s of speech at
            // one. Both are far under budget, and past two the returns are
            // small enough not to be worth the cores during a take.
            num_threads: 2,
            provider: "cpu".to_string(),
            decoding_method: "greedy_search".to_string(),
            rule1_min_trailing_silence: tuning.rule1_min_trailing_silence,
            rule2_min_trailing_silence: tuning.rule2_min_trailing_silence,
            rule3_min_utterance_length: tuning.rule3_min_utterance_length,
            blank_penalty: tuning.blank_penalty,
            max_active_paths: 4,
            prime_ms: tuning.prime_ms,
        }
    }

    /// A config for one of the models this build ships.
    ///
    /// The overwhelmingly common case, and the one that cannot get the tuning
    /// wrong: the model says where it lives and how it was measured.
    pub fn for_model(model: &crate::models::BundledModel, dir: impl Into<PathBuf>) -> Self {
        Self::new(dir, model.tuning)
    }

    /// Check every model file is present, returning the first that is not.
    ///
    /// Worth calling before a take: `OnlineRecognizer::create` answers a
    /// missing file with a null pointer and no reason.
    pub fn validate(&self) -> Result<(), String> {
        ModelFiles::detect(&self.model_dir).map(|_| ())
    }
}

/// A loaded model. Expensive to build (~200 ms), cheap to create streams from,
/// and `Send + Sync`, so the app loads it once and keeps it resident.
pub struct LocalRecognizer {
    inner: OnlineRecognizer,
    /// Carried from the config it was loaded with, so that [`Self::session`]
    /// primes the way the model it actually holds was measured.
    ///
    /// It used to be the caller's job to remember this, and the caller did not:
    /// the app asked a freshly built default what the priming should be, which
    /// answered for whichever model happened to be first in the crate rather
    /// than for the one resident in memory. Load-time and session-time tuning
    /// reaching different answers is not a bug worth being able to have.
    prime_ms: u32,
}

impl LocalRecognizer {
    pub fn load(config: &LocalSttConfig) -> Result<Self, String> {
        let files = ModelFiles::detect(&config.model_dir)?;
        let path = |file: &str| Some(config.model_dir.join(file).to_string_lossy().into_owned());

        let mut sys = OnlineRecognizerConfig::default();
        sys.model_config.transducer.encoder = path(&files.encoder);
        sys.model_config.transducer.decoder = path(&files.decoder);
        sys.model_config.transducer.joiner = path(&files.joiner);
        sys.model_config.tokens = path(TOKENS_FILE);
        if let Some(bpe) = &files.bpe_vocab {
            sys.model_config.bpe_vocab = path(bpe);
        }
        sys.model_config.num_threads = config.num_threads;
        sys.model_config.provider = Some(config.provider.clone());
        sys.model_config.debug = false;
        sys.decoding_method = Some(config.decoding_method.clone());
        sys.enable_endpoint = true;
        sys.rule1_min_trailing_silence = config.rule1_min_trailing_silence;
        sys.rule2_min_trailing_silence = config.rule2_min_trailing_silence;
        sys.rule3_min_utterance_length = config.rule3_min_utterance_length;
        sys.blank_penalty = config.blank_penalty;
        sys.max_active_paths = config.max_active_paths;

        OnlineRecognizer::create(&sys)
            .map(|inner| Self {
                inner,
                prime_ms: config.prime_ms,
            })
            .ok_or_else(|| {
                format!(
                    "sherpa-onnx could not load the model in {}",
                    config.model_dir.display()
                )
            })
    }

    /// Begin one take, primed as this model's own tuning asks for.
    ///
    /// `generation` is minted into the item ids exactly as the app's session
    /// generation was on the websocket path.
    pub fn session(&self, generation: u64) -> LocalSession<'_> {
        self.session_with(generation, self.prime_ms)
    }

    /// Begin one take, priming the decoder with `prime_ms` of silence first.
    ///
    /// See [`LocalSttConfig::prime_ms`]. The priming is deliberately invisible
    /// to the audio clock and emits nothing: silence cannot produce a
    /// hypothesis, so nothing is published and no utterance is minted.
    pub fn session_with(&self, generation: u64, prime_ms: u32) -> LocalSession<'_> {
        let stream = self.inner.create_stream();
        if prime_ms > 0 {
            // Fed at the model's own feature rate; the samples never reach the
            // clock, so the rate here only has to be one the recogniser accepts.
            let samples = vec![0.0f32; (16_000 * prime_ms as usize) / 1000];
            stream.accept_waveform(16_000, &samples);
            while self.inner.is_ready(&stream) {
                self.inner.decode(&stream);
            }
        }
        LocalSession {
            recognizer: &self.inner,
            stream,
            generation,
            ordinal: 0,
            open_item: None,
            last_text: String::new(),
            samples_fed: 0,
            sample_rate: 0,
            started: std::time::Instant::now(),
            last_emitted_ms: 0.0,
            open_item_start_ms: 0.0,
            prime_offset_ms: prime_ms as f64,
            last_word_times: None,
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
    /// The clock the open item was announced at, and the floor every word time
    /// inside it is held to — a word cannot have been spoken before the
    /// utterance containing it began.
    open_item_start_ms: f64,
    /// How far the recogniser's own clock runs AHEAD of the audio clock.
    ///
    /// Priming feeds the decoder silence that is deliberately invisible to
    /// [`Self::audio_ms`] — the clock means "how much of the presenter's audio
    /// has been heard", and silence this side of the microphone is not that.
    /// sherpa counts it anyway, so every time it reports is late by exactly the
    /// priming, and subtracting it here is what keeps the two clocks the same
    /// clock. Zero for the shipped model, which primes not at all; the knob
    /// exists for the next one, and a systematic offset is not a thing to
    /// discover after a model swap.
    prime_offset_ms: f64,
    /// Word timings for [`Self::last_text`], kept because [`Self::close_item`]
    /// builds its `Final` from the cached text and never asks the recogniser
    /// again. Without this the final — the one frame the ledger treats as
    /// authoritative — would be the only frame with no timing on it.
    last_word_times: Option<Vec<WordTime>>,
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
        if text.is_empty() {
            return;
        }

        let audio_ms = self.audio_ms();

        if text == self.last_text {
            // The hypothesis has not moved, so there is nothing to publish —
            // but the recogniser may still have sharpened the timing under it,
            // and the cache is what the eventual `Final` is built from. Refresh
            // it and stay quiet.
            if let Some(times) = self.word_times(&result, self.open_item_start_ms, audio_ms) {
                self.last_word_times = Some(times);
            }
            return;
        }
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
                    .map(|s| s as f64 * 1000.0 - self.prime_offset_ms)
                    .unwrap_or(audio_ms)
                    .clamp(self.last_emitted_ms, audio_ms);
                self.last_emitted_ms = audio_start_ms;
                self.open_item_start_ms = audio_start_ms;
                emit(SttFrame::ItemStarted {
                    item_id: id.clone(),
                    ordinal: self.ordinal - 1,
                    audio_start_ms,
                });
                id
            }
        };

        // Reconstructed from the SAME result the text came from, so a word
        // vector never describes a hypothesis other than the one beside it.
        // Cleared rather than carried when reconstruction fails: stale timings
        // against fresh text would be a lie the shape of an answer.
        let word_times = self.word_times(&result, self.open_item_start_ms, audio_ms);
        self.last_word_times = word_times.clone();

        self.last_text = text.clone();
        self.last_emitted_ms = self.last_emitted_ms.max(audio_ms);
        emit(SttFrame::Partial {
            item_id,
            text,
            audio_ms,
            wall_ms: self.wall_ms(),
            word_times,
        });
    }

    /// Word timings for one raw result, or `None` when the recogniser did not
    /// give enough to build them honestly.
    ///
    /// `start_time` being absent is a refusal rather than a zero: the offsets
    /// are relative to the segment, so guessing an origin of 0 inside a later
    /// segment would date every word to the top of the take.
    fn word_times(
        &self,
        result: &sherpa_onnx::RecognizerResult,
        floor_ms: f64,
        ceil_ms: f64,
    ) -> Option<Vec<WordTime>> {
        let timestamps = result.timestamps.as_ref()?;
        let segment_start_ms = result.start_time? as f64 * 1000.0 - self.prime_offset_ms;
        crate::word_times::reconstruct(
            &result.tokens,
            timestamps,
            segment_start_ms,
            floor_ms,
            ceil_ms,
        )
    }

    /// Close the open utterance, if any, with the last hypothesis as its final.
    fn close_item(&mut self, emit: &mut impl FnMut(SttFrame)) {
        let Some(item_id) = self.open_item.take() else {
            // Endpoint on silence: reset the decoder, mint nothing.
            self.last_text.clear();
            self.last_word_times = None;
            return;
        };
        let text = std::mem::take(&mut self.last_text);
        self.last_emitted_ms = self.last_emitted_ms.max(self.audio_ms());
        emit(SttFrame::Final {
            item_id,
            text,
            audio_end_ms: self.audio_ms(),
            wall_ms: self.wall_ms(),
            // Taken, not copied: the next utterance decodes in a new segment
            // against a new origin, and inheriting these would date its first
            // words to the previous one.
            word_times: self.last_word_times.take(),
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
#[allow(clippy::too_many_arguments)]
pub fn stream_pcm16(
    recognizer: &LocalRecognizer,
    pcm: &[u8],
    sample_rate: u32,
    frame_ms: u64,
    pace: f64,
    prime_ms: u32,
    mut emit: impl FnMut(SttFrame),
) {
    let mut session = recognizer.session_with(1, prime_ms);
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

    /// A scratch directory holding exactly the named files.
    fn bundle(label: &str, files: &[&str]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("cc-stt-{label}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for name in files {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        dir
    }

    fn tuning() -> LocalModelTuning {
        crate::models::default_model().tuning
    }

    /// A directory that is not there is a different problem from a directory
    /// missing one graph, and saying "no encoder" about a path that does not
    /// exist sends the reader looking for a file in a folder that isn't there.
    #[test]
    fn a_model_directory_that_is_not_there_says_so() {
        let config = LocalSttConfig::new("/nonexistent/model/dir", tuning());
        let error = config.validate().unwrap_err();
        assert!(error.contains("/nonexistent/model/dir"), "{error}");
        assert!(error.contains("could not read"), "{error}");
    }

    /// A missing graph names the role, the directory, and what the directory
    /// actually holds — the last of which is the part that ends the search,
    /// because it is usually a bundle that was half-extracted or a path one
    /// level off.
    #[test]
    fn a_missing_graph_names_the_role_and_what_was_there_instead() {
        let dir = bundle(
            "missing-encoder",
            &["decoder.onnx", "joiner.int8.onnx", TOKENS_FILE],
        );
        let error = ModelFiles::detect(&dir).unwrap_err();
        assert!(error.contains("no encoder found"), "{error}");
        assert!(error.contains(&dir.display().to_string()), "{error}");
        assert!(error.contains("decoder.onnx"), "{error}");
        assert!(error.contains("joiner.int8.onnx"), "{error}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A near-miss is the most useful thing the error can carry, and the one a
    /// list of only-recognised names would drop: a bundle whose encoder is
    /// called something unexpected reads as an empty directory otherwise.
    #[test]
    fn a_missing_graph_reports_onnx_files_that_matched_no_role() {
        let dir = bundle(
            "near-miss",
            &["enc.onnx", "decoder.onnx", "joiner.int8.onnx", TOKENS_FILE],
        );
        let error = ModelFiles::detect(&dir).unwrap_err();
        assert!(error.contains("enc.onnx"), "{error}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_bundle_without_a_token_table_names_it() {
        let dir = bundle(
            "missing-tokens",
            &["encoder.int8.onnx", "decoder.onnx", "joiner.int8.onnx"],
        );
        let error = ModelFiles::detect(&dir).unwrap_err();
        assert!(error.contains(TOKENS_FILE), "{error}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Both bundle layouts must be recognised.
    ///
    /// Upstream names its graphs two different ways with no manifest to ask —
    /// `encoder-epoch-99-avg-1.int8.onnx` in the LibriSpeech-era bundles, a
    /// plain `encoder.int8.onnx` in the 2026 x-asr ones. Hard-coding either set
    /// makes the other fail with a null pointer from the C library and no
    /// reason attached, which is the single most expensive failure mode this
    /// crate has.
    #[test]
    fn either_bundle_layout_is_detected() {
        for (encoder, decoder, joiner) in [
            (
                "encoder-epoch-99-avg-1.int8.onnx",
                "decoder-epoch-99-avg-1.onnx",
                "joiner-epoch-99-avg-1.int8.onnx",
            ),
            ("encoder.int8.onnx", "decoder.onnx", "joiner.int8.onnx"),
        ] {
            let dir = std::env::temp_dir().join(format!("cc-stt-layout-{encoder}"));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            for name in [encoder, decoder, joiner, TOKENS_FILE] {
                std::fs::write(dir.join(name), b"x").unwrap();
            }
            let found = ModelFiles::detect(&dir).expect("layout must be detected");
            assert_eq!(found.encoder, encoder);
            assert_eq!(found.decoder, decoder);
            assert_eq!(found.joiner, joiner);
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// Precision preference is per ROLE, and the decoder goes the other way.
    ///
    /// INT8 wins for the encoder and joiner: it is what the benchmark numbers
    /// were taken with, and the FP32 encoder is twice the size for accuracy
    /// this application spends on nothing. The decoder is small enough that
    /// quantising it buys nothing measurable, so FP32 wins there — and a
    /// bundle shipping all six is the only thing that can prove the two rules
    /// are actually different.
    #[test]
    fn precision_preference_is_role_specific() {
        let dir = bundle(
            "precision",
            &[
                "encoder.onnx",
                "encoder.int8.onnx",
                "decoder.onnx",
                "decoder.int8.onnx",
                "joiner.onnx",
                "joiner.int8.onnx",
                TOKENS_FILE,
            ],
        );
        let found = ModelFiles::detect(&dir).unwrap();
        assert_eq!(found.encoder, "encoder.int8.onnx");
        assert_eq!(found.joiner, "joiner.int8.onnx");
        // The decoder deliberately stays FP32.
        assert_eq!(found.decoder, "decoder.onnx");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Either precision alone is enough — a bundle that ships only the one we
    /// would not have picked still loads.
    #[test]
    fn a_single_precision_bundle_falls_back_to_what_it_ships() {
        let int8_only = bundle(
            "int8-only",
            &[
                "encoder.int8.onnx",
                "decoder.int8.onnx",
                "joiner.int8.onnx",
                TOKENS_FILE,
            ],
        );
        let found = ModelFiles::detect(&int8_only).unwrap();
        assert_eq!(found.decoder, "decoder.int8.onnx");
        let _ = std::fs::remove_dir_all(&int8_only);

        let fp32_only = bundle(
            "fp32-only",
            &["encoder.onnx", "decoder.onnx", "joiner.onnx", TOKENS_FILE],
        );
        let found = ModelFiles::detect(&fp32_only).unwrap();
        assert_eq!(found.encoder, "encoder.onnx");
        assert_eq!(found.joiner, "joiner.onnx");
        let _ = std::fs::remove_dir_all(&fp32_only);
    }

    /// The bundle that made the enumerated list untenable.
    ///
    /// `sherpa-onnx-streaming-zipformer-fr-2023-04-14` is Apache-2.0 and names
    /// its graphs `-epoch-29-avg-9-with-averaged-model`, which matched nothing
    /// in the old list. The failure was a null pointer out of the C library
    /// with no reason attached, and it was not uniform — the Kroko bundles and
    /// the Russian one happened to match, so detection looked like it worked
    /// until it met a model where it didn't.
    ///
    /// The file list is the archive's real contents: it ships BOTH precisions
    /// of all three roles, so this also proves the precision preference on the
    /// bundle that actually broke rather than on a reduced stand-in.
    #[test]
    fn an_epoch_suffix_nobody_enumerated_is_still_detected() {
        let dir = bundle(
            "french-averaged",
            &[
                "encoder-epoch-29-avg-9-with-averaged-model.onnx",
                "encoder-epoch-29-avg-9-with-averaged-model.int8.onnx",
                "decoder-epoch-29-avg-9-with-averaged-model.onnx",
                "decoder-epoch-29-avg-9-with-averaged-model.int8.onnx",
                "joiner-epoch-29-avg-9-with-averaged-model.onnx",
                "joiner-epoch-29-avg-9-with-averaged-model.int8.onnx",
                TOKENS_FILE,
            ],
        );
        let found = ModelFiles::detect(&dir).expect("an unlisted epoch suffix must be detected");
        assert_eq!(
            found.encoder,
            "encoder-epoch-29-avg-9-with-averaged-model.int8.onnx"
        );
        assert_eq!(
            found.decoder,
            "decoder-epoch-29-avg-9-with-averaged-model.onnx"
        );
        assert_eq!(
            found.joiner,
            "joiner-epoch-29-avg-9-with-averaged-model.int8.onnx"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Matching on shape means matching only the shape we mean.
    ///
    /// A role must be the whole stem or be followed by a hyphen. Without that,
    /// `encoder_aux.onnx` is an encoder, and so is anything else somebody drops
    /// in the directory whose name happens to begin with the right letters.
    #[test]
    fn only_onnx_graphs_named_for_a_role_are_candidates() {
        let dir = bundle(
            "decoys",
            &[
                "encoder.int8.onnx",
                "decoder.onnx",
                "joiner.int8.onnx",
                TOKENS_FILE,
                // None of these are graphs this crate may pick, and all but
                // the last two are real filenames from published bundles.
                //
                // `encoder.onnx.data` is the external-weight sidecar the
                // Nemotron and ReazonSpeech packages ship beside a >2 GB graph;
                // `encoder_adaptor.onnx` is FunASR-nano's adapter;
                // `decoder_joint-model.onnx` is NeMo's fused decoder+joiner,
                // which this crate cannot drive at all; `.fp16.onnx` is a
                // precision nothing here was measured at.
                "encoder.onnx.data",
                "encoder_adaptor.onnx",
                "decoder_joint-model.onnx",
                "encoder.fp16.onnx",
                "encoder.json",
                "joinery.onnx",
                "README.md",
            ],
        );
        let found = ModelFiles::detect(&dir).unwrap();
        assert_eq!(found.encoder, "encoder.int8.onnx");
        assert_eq!(found.decoder, "decoder.onnx");
        assert_eq!(found.joiner, "joiner.int8.onnx");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A directory of symlinks is an ordinary way to point a dev build at a
    /// bundle already on disk, and the enumerated-list version followed them
    /// because `Path::is_file` does. Detecting by directory entry does not
    /// unless it is asked to.
    #[cfg(unix)]
    #[test]
    fn graphs_reached_through_a_symlink_are_still_found() {
        let real = bundle(
            "symlink-target",
            &[
                "encoder.int8.onnx",
                "decoder.onnx",
                "joiner.int8.onnx",
                TOKENS_FILE,
            ],
        );
        let linked = std::env::temp_dir().join("cc-stt-symlinked");
        let _ = std::fs::remove_dir_all(&linked);
        std::fs::create_dir_all(&linked).unwrap();
        for name in [
            "encoder.int8.onnx",
            "decoder.onnx",
            "joiner.int8.onnx",
            TOKENS_FILE,
        ] {
            std::os::unix::fs::symlink(real.join(name), linked.join(name)).unwrap();
        }
        let found = ModelFiles::detect(&linked).expect("symlinked graphs must be detected");
        assert_eq!(found.encoder, "encoder.int8.onnx");
        assert_eq!(found.decoder, "decoder.onnx");
        let _ = std::fs::remove_dir_all(&linked);
        let _ = std::fs::remove_dir_all(&real);
    }

    /// `read_dir` returns entries in filesystem order, which is neither sorted
    /// nor stable across machines. An ambiguous bundle must still resolve the
    /// same way every time, or a model loads differently on the presenter's
    /// machine than on the one the benchmark ran on.
    #[test]
    fn an_ambiguous_bundle_resolves_deterministically() {
        let dir = bundle(
            "ambiguous",
            &[
                "encoder-epoch-99-avg-1.int8.onnx",
                "encoder-epoch-10-avg-2.int8.onnx",
                "decoder-epoch-99-avg-1.onnx",
                "decoder-epoch-10-avg-2.onnx",
                "joiner-epoch-99-avg-1.int8.onnx",
                "joiner-epoch-10-avg-2.int8.onnx",
                TOKENS_FILE,
            ],
        );
        let first = ModelFiles::detect(&dir).unwrap();
        for _ in 0..4 {
            assert_eq!(ModelFiles::detect(&dir).unwrap(), first);
        }
        // Equal-length names, so the tie falls to lexicographic order — a rule
        // someone can predict rather than whatever the directory happened to
        // hand over first. All three roles resolve by the same rule, so a
        // bundle named uniformly cannot produce a mixed triplet.
        assert_eq!(first.encoder, "encoder-epoch-10-avg-2.int8.onnx");
        assert_eq!(first.decoder, "decoder-epoch-10-avg-2.onnx");
        assert_eq!(first.joiner, "joiner-epoch-10-avg-2.int8.onnx");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The bare name beats the qualified one, as the enumerated list it
    /// replaced did.
    ///
    /// Plain lexicographic order gets this BACKWARDS — `-` sorts before `.`, so
    /// `encoder-epoch-99-avg-1.int8.onnx` would win — and a directory holding
    /// both would silently start loading a different graph than it used to.
    #[test]
    fn the_least_qualified_name_wins_as_the_enumerated_list_had_it() {
        let dir = bundle(
            "bare-vs-qualified",
            &[
                "encoder.int8.onnx",
                "encoder-epoch-99-avg-1.int8.onnx",
                "decoder.onnx",
                "decoder-epoch-99-avg-1.onnx",
                "joiner.int8.onnx",
                "joiner-epoch-99-avg-1.int8.onnx",
                TOKENS_FILE,
            ],
        );
        let found = ModelFiles::detect(&dir).unwrap();
        assert_eq!(found.encoder, "encoder.int8.onnx");
        assert_eq!(found.decoder, "decoder.onnx");
        assert_eq!(found.joiner, "joiner.int8.onnx");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `bpe.vocab` is optional and `bpe.model` is deliberately not accepted in
    /// its place: sherpa's `bpe_vocab` wants the two-column text vocabulary,
    /// and handing over the binary SentencePiece model is silently accepted
    /// under greedy decoding and then does nothing.
    #[test]
    fn the_bpe_vocabulary_is_optional_and_never_the_binary_model() {
        let without = bundle(
            "bpe-absent",
            &[
                "encoder.int8.onnx",
                "decoder.onnx",
                "joiner.int8.onnx",
                TOKENS_FILE,
                "bpe.model",
            ],
        );
        assert_eq!(ModelFiles::detect(&without).unwrap().bpe_vocab, None);
        let _ = std::fs::remove_dir_all(&without);

        let with = bundle(
            "bpe-present",
            &[
                "encoder.int8.onnx",
                "decoder.onnx",
                "joiner.int8.onnx",
                TOKENS_FILE,
                "bpe.vocab",
            ],
        );
        assert_eq!(
            ModelFiles::detect(&with).unwrap().bpe_vocab.as_deref(),
            Some("bpe.vocab")
        );
        let _ = std::fs::remove_dir_all(&with);
    }

    #[test]
    fn endpoint_rules_are_set_rather_than_left_at_sherpas_zeroes() {
        // Regression guard: `enable_endpoint` alone does nothing, because
        // sherpa's own defaults for all three rules are 0.0. The values now
        // come from the model's own profile, so this asserts the config
        // carries them through rather than that a crate-wide default exists.
        let config = LocalSttConfig::new("/model", tuning());
        assert!(config.rule2_min_trailing_silence > 0.0);
        assert!(config.rule1_min_trailing_silence > 0.0);
        assert!(config.rule3_min_utterance_length > 0.0);
    }

    /// The tuning reaching the config is the model's, not a crate-wide value —
    /// which is the whole reason the crate no longer has one.
    #[test]
    fn a_config_carries_the_tuning_of_the_model_it_names() {
        let model = crate::models::default_model();
        let config = LocalSttConfig::for_model(model, "/model");
        assert_eq!(config.blank_penalty, model.tuning.blank_penalty);
        assert_eq!(config.prime_ms, model.tuning.prime_ms);
        assert_eq!(
            config.rule1_min_trailing_silence,
            model.tuning.rule1_min_trailing_silence
        );
        assert_eq!(
            config.rule2_min_trailing_silence,
            model.tuning.rule2_min_trailing_silence
        );
        assert_eq!(
            config.rule3_min_utterance_length,
            model.tuning.rule3_min_utterance_length
        );
    }

    /// The shipped recogniser is configured EXACTLY as it was before the model
    /// became a runtime value.
    ///
    /// Every number here is written out rather than read back from the
    /// catalogue, and that is the entire point: a test that asks the catalogue
    /// what it says and then agrees with the answer cannot notice the
    /// catalogue changing. These nine values are the ones the benchmark numbers
    /// in `bench/REPORT.md` were taken with, so a diff that moves any of them
    /// invalidates every published figure and should have to say so out loud.
    ///
    /// `blank_penalty` is the one with teeth. `cc-bench` records an occasion
    /// when a bare override silently replaced the tuned value with 0.0 and a
    /// whole corpus was captured with the knob off — the recogniser still
    /// transcribed, every other test still passed, and following was simply
    /// worse.
    #[test]
    fn the_shipped_model_is_configured_exactly_as_it_was_before_the_refactor() {
        let config = LocalSttConfig::for_model(crate::models::default_model(), "/model");
        assert_eq!(config.num_threads, 2);
        assert_eq!(config.provider, "cpu");
        assert_eq!(config.decoding_method, "greedy_search");
        assert_eq!(config.rule1_min_trailing_silence, 2.4);
        assert_eq!(config.rule2_min_trailing_silence, 1.2);
        assert_eq!(config.rule3_min_utterance_length, 20.0);
        assert_eq!(config.blank_penalty, 3.0);
        assert_eq!(config.max_active_paths, 4);
        assert_eq!(config.prime_ms, 0);
    }

    /// Priming is a per-model value that reaches the stream, not just the load.
    ///
    /// Unprovable end to end without weights: building a `LocalRecognizer`
    /// needs the real ONNX graphs, so what is checked here is that a nonzero
    /// tuning survives into the config the recogniser is built from. The
    /// shipped model primes at 0, which means every other test in this file
    /// would pass an implementation that ignored the setting entirely.
    #[test]
    fn a_model_that_primes_carries_its_priming_into_the_config() {
        let tuning = LocalModelTuning {
            prime_ms: 250,
            ..crate::models::default_model().tuning
        };
        assert_eq!(LocalSttConfig::new("/model", tuning).prime_ms, 250);
    }
}
