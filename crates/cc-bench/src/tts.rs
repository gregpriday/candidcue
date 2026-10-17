//! Tier-B audio synthesis via fal.ai TTS.
//!
//! Each performance segment (≤12 words, split at paragraph boundaries)
//! becomes one TTS clip. Clips are stitched with real silence for pauses, so
//! the gold word timing inside any clip only ever interpolates across a few
//! seconds of audio — that keeps gold accuracy compatible with the ±2-atom
//! metrics without needing forced alignment.
//!
//! Engines (per Greg): `fal-ai/gemini-3.1-flash-tts`, `fal-ai/qwen-3-tts/
//! text-to-speech/1.7b`, `xai/tts/v1`. Three independent engines double as
//! the spec's held-out-voice requirement. Clips are cached by content hash so
//! reruns don't re-bill.

use std::fs::OpenOptions;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::plan::{GoldTimeline, GoldWord, Performance};

pub const SAMPLE_RATE: u32 = 24_000;
pub const CACHE_DIR_ENV: &str = "CANDIDCUE_TTS_CACHE_DIR";
pub const ALLOW_GENERATION_ENV: &str = "CANDIDCUE_ALLOW_TTS_GENERATION";
const BYTES_PER_MS: f64 = (SAMPLE_RATE as f64 * 2.0) / 1000.0;
/// Silence stitched between segments (natural inter-phrase gap).
const SEGMENT_GAP_MS: u32 = 120;
/// Lead-in before the first word (the app always has some).
const LEAD_IN_MS: u32 = 600;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TtsEngine {
    Gemini,
    Qwen,
    Xai,
}

impl TtsEngine {
    pub fn all() -> [TtsEngine; 3] {
        [TtsEngine::Gemini, TtsEngine::Qwen, TtsEngine::Xai]
    }

    pub fn slug(&self) -> &'static str {
        match self {
            TtsEngine::Gemini => "gemini",
            TtsEngine::Qwen => "qwen",
            TtsEngine::Xai => "xai",
        }
    }

    fn endpoint(&self) -> &'static str {
        match self {
            TtsEngine::Gemini => "https://fal.run/fal-ai/gemini-3.1-flash-tts",
            TtsEngine::Qwen => "https://fal.run/fal-ai/qwen-3-tts/text-to-speech/1.7b",
            TtsEngine::Xai => "https://fal.run/xai/tts/v1",
        }
    }

    fn body(&self, text: &str, voice_index: usize) -> serde_json::Value {
        match self {
            // Gemini's TTS is instruction-following: bare text that LOOKS
            // like an instruction gets performed instead of read ("put a
            // real pause in the middle of this one" → it improvised its own
            // commentary). The wrapper pins it to verbatim reading; verified by
            // transcribing the result that the wrapper itself is not spoken.
            TtsEngine::Gemini => serde_json::json!({
                "prompt": format!(
                    "Read aloud verbatim, word for word, changing nothing: {text}"
                )
            }),
            TtsEngine::Qwen => {
                const VOICES: &[&str] = &["Dylan", "Serena", "Ryan"];
                serde_json::json!({
                    "text": text,
                    "voice": VOICES[voice_index % VOICES.len()],
                })
            }
            TtsEngine::Xai => serde_json::json!({ "text": text }),
        }
    }
}

pub struct Synthesizer {
    http: reqwest::Client,
    key: Option<String>,
    cache_dir: PathBuf,
}

impl Synthesizer {
    pub fn new() -> anyhow::Result<Self> {
        let key = std::env::var("FAL_KEY").ok();
        let cache_dir = shared_cache_dir();
        std::fs::create_dir_all(&cache_dir)?;
        make_private(&cache_dir)?;
        Ok(Self {
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(180))
                .build()?,
            key,
            cache_dir,
        })
    }

    /// Render one clip to raw 24 kHz mono PCM16 (no header). Cached.
    pub async fn clip(
        &self,
        engine: TtsEngine,
        text: &str,
        voice_index: usize,
    ) -> anyhow::Result<Vec<u8>> {
        let cache_key = stable_cache_key(engine, text, voice_index);
        let cache_path = self.cache_dir.join(&cache_key);
        if let Ok(cached) = std::fs::read(&cache_path) {
            return Ok(cached);
        }

        // The cache originally used DefaultHasher. Keep reading those names so
        // the already-paid-for corpus can be moved into the shared cache
        // without regenerating it. Promote a legacy hit to the stable name.
        let legacy_key = {
            use std::collections::hash_map::DefaultHasher;
            use std::hash::{Hash, Hasher};
            let mut h = DefaultHasher::new();
            (engine.slug(), voice_index, text).hash(&mut h);
            format!("{}-{:016x}.pcm", engine.slug(), h.finish())
        };
        if let Ok(cached) = std::fs::read(self.cache_dir.join(legacy_key)) {
            write_new_cache_entry(&cache_path, &cached)?;
            return Ok(cached);
        }

        anyhow::ensure!(
            generation_allowed(),
            "TTS clip is not in the shared cache ({}). Refusing to call fal.ai. \
             Set {ALLOW_GENERATION_ENV}=1 only when you intentionally approve new TTS spend.",
            self.cache_dir.display(),
        );

        // All worktrees use the same cache. Serialize each cache miss across
        // processes, then check again after taking the lock: another benchmark
        // may have paid for and written the clip while this one was waiting.
        let _lock = CacheLock::acquire(&cache_path).await?;
        if let Ok(cached) = std::fs::read(&cache_path) {
            return Ok(cached);
        }
        let key = self
            .key
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("FAL_KEY not set in the environment"))?;

        let response = self
            .http
            .post(engine.endpoint())
            .header("Authorization", format!("Key {key}"))
            .json(&engine.body(text, voice_index))
            .send()
            .await?;
        let status = response.status();
        let payload: serde_json::Value = response.json().await?;
        if !status.is_success() {
            anyhow::bail!("TTS {status}: {payload}");
        }
        let url = payload
            .pointer("/audio/url")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("no audio.url in TTS response: {payload}"))?;
        let audio = self.http.get(url).send().await?.bytes().await?;

        // Whatever the container (mp3 today), ffmpeg turns it into the exact
        // PCM the app's capture path produces.
        // Process-unique tmp names: two overlapping harness invocations on
        // the same cache raced on shared tmp files and fed ffmpeg a path the
        // other process had already cleaned up.
        let pid = std::process::id();
        let tmp_in = self.cache_dir.join(format!("{cache_key}.{pid}.dl"));
        std::fs::write(&tmp_in, &audio)?;
        let tmp_out = self.cache_dir.join(format!("{cache_key}.{pid}.tmp"));
        let status = Command::new("ffmpeg")
            .args([
                "-y",
                "-loglevel",
                "error",
                "-i",
                tmp_in.to_str().unwrap(),
                "-ac",
                "1",
                "-ar",
                "24000",
                "-f",
                "s16le",
                tmp_out.to_str().unwrap(),
            ])
            .status()?;
        anyhow::ensure!(status.success(), "ffmpeg failed for {cache_key}");
        let pcm = std::fs::read(&tmp_out)?;
        let _ = std::fs::remove_file(&tmp_in);
        let _ = std::fs::remove_file(&tmp_out);
        write_new_cache_entry(&cache_path, &pcm)?;
        Ok(pcm)
    }
}

/// One private, machine-wide cache shared by every checkout and worktree.
///
/// The override is useful on non-macOS hosts and in CI, but it must name the
/// cache itself rather than a benchmark work directory.
pub fn shared_cache_dir() -> PathBuf {
    std::env::var_os(CACHE_DIR_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/private/tmp/candidcue-bench/tts-cache"))
}

pub fn shared_rendered_dir() -> PathBuf {
    shared_cache_dir()
        .parent()
        .expect("shared TTS cache has a parent directory")
        .join("tts")
}

fn generation_allowed() -> bool {
    std::env::var(ALLOW_GENERATION_ENV)
        .map(|value| matches!(value.as_str(), "1" | "true" | "yes"))
        .unwrap_or(false)
}

fn stable_cache_key(engine: TtsEngine, text: &str, voice_index: usize) -> String {
    // FNV-1a is deliberately specified here instead of DefaultHasher, whose
    // output Rust does not promise to preserve between toolchains.
    let mut hash = 0xcbf29ce484222325u64;
    let voice = (voice_index as u64).to_le_bytes();
    for bytes in [
        engine.slug().as_bytes(),
        &voice,
        text.as_bytes(),
    ] {
        for byte in bytes {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
        // Length-independent field separator.
        hash ^= 0xff;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{}-v2-{hash:016x}.pcm", engine.slug())
}

/// Publish a clip so that it is never visible half-written.
///
/// `create_new` on the FINAL name excludes a second writer, but it also makes
/// the name visible the instant it is opened — before `write_all`, let alone
/// `sync_all`. A reader taking the unlocked fast path can then read a truncated
/// clip, and a writer killed mid-write leaves a short file that every future run
/// accepts as a hit forever, because `create_new` then refuses to repair it. A
/// truncated clip is not a loud failure either: it is a shorter clip, which
/// silently moves the gold timing every benchmark is scored against.
///
/// So the bytes go to a unique temporary name in the SAME directory (rename is
/// only atomic within a filesystem), are synced, and are then published with a
/// rename. A crash at any point leaves either nothing or a complete file, and a
/// loser of the race simply overwrites with identical content.
fn write_new_cache_entry(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    let directory = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("cache path {} has no parent", path.display()))?;
    // Unique per process and per call: two writers must not share a temp name,
    // or one can rename the other's half-written file into place.
    let unique = format!(
        "{}.{}.{:p}.part",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("clip"),
        std::process::id(),
        bytes.as_ptr(),
    );
    let temporary = directory.join(unique);

    let write = || -> std::io::Result<()> {
        use std::io::Write;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()
    };
    if let Err(error) = write() {
        let _ = std::fs::remove_file(&temporary);
        return Err(anyhow::Error::from(error)
            .context(format!("writing TTS clip to {}", temporary.display())));
    }
    if let Err(error) = std::fs::rename(&temporary, path) {
        let _ = std::fs::remove_file(&temporary);
        // An existing destination is a race we lost, not a failure: the other
        // writer produced the same bytes for the same key.
        if error.kind() != ErrorKind::AlreadyExists {
            return Err(anyhow::Error::from(error)
                .context(format!("publishing TTS clip to {}", path.display())));
        }
    }
    Ok(())
}

fn make_private(path: &Path) -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
        if let Some(parent) = path.parent() {
            std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
        }
    }
    Ok(())
}

struct CacheLock {
    path: PathBuf,
}

impl CacheLock {
    async fn acquire(cache_path: &Path) -> anyhow::Result<Self> {
        let path = cache_path.with_extension("lock");
        let started = std::time::Instant::now();
        loop {
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(_) => return Ok(Self { path }),
                Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                    // fal requests have a 180 s timeout. A ten-minute-old lock
                    // can only be debris from a killed benchmark.
                    let stale = std::fs::metadata(&path)
                        .and_then(|metadata| metadata.modified())
                        .and_then(|modified| modified.elapsed().map_err(std::io::Error::other))
                        .map(|age| age > Duration::from_secs(600))
                        .unwrap_or(false);
                    if stale {
                        let _ = std::fs::remove_file(&path);
                        continue;
                    }
                    anyhow::ensure!(
                        started.elapsed() < Duration::from_secs(600),
                        "timed out waiting for shared TTS cache lock {}",
                        path.display(),
                    );
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                Err(error) => return Err(error.into()),
            }
        }
    }
}

impl Drop for CacheLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// A synthesised performance: stitched PCM plus the gold timeline with real
/// clip-derived word timings.
pub struct SynthesizedRun {
    pub pcm: Vec<u8>,
    pub gold: GoldTimeline,
}

/// Render a whole performance with one engine.
pub async fn synthesize(
    synth: &Synthesizer,
    engine: TtsEngine,
    performance: &Performance,
    voice_index: usize,
) -> anyhow::Result<SynthesizedRun> {
    // Clips first (async), then the same stitching the local voice uses.
    let mut clips = std::collections::HashMap::new();
    for &(seg_start, seg_end) in &performance.segments {
        let text = segment_text(performance, seg_start, seg_end);
        if let std::collections::hash_map::Entry::Vacant(slot) = clips.entry(text) {
            let clip = synth.clip(engine, slot.key(), voice_index).await?;
            slot.insert(clip);
        }
    }
    stitch(performance, |text| {
        clips
            .get(text)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("clip missing for {text}"))
    })
}

fn segment_text(performance: &Performance, seg_start: usize, seg_end: usize) -> String {
    let words: Vec<&str> = performance.words[seg_start..seg_end]
        .iter()
        .map(|w| w.text.as_str())
        .collect();
    format!("{}.", words.join(" "))
}

/// Stitch a performance's segment clips with real silence and build its gold.
fn stitch(
    performance: &Performance,
    mut clip_for: impl FnMut(&str) -> anyhow::Result<Vec<u8>>,
) -> anyhow::Result<SynthesizedRun> {
    let mut pcm: Vec<u8> = Vec::new();
    let mut gold = GoldTimeline::default();
    push_silence(&mut pcm, LEAD_IN_MS);

    let mut pause_idx = 0usize;
    let mut vp_idx = 0usize;

    for &(seg_start, seg_end) in &performance.segments {
        // Pauses and viewport hints scheduled before this segment.
        while pause_idx < performance.pauses.len() && performance.pauses[pause_idx].0 <= seg_start {
            push_silence(&mut pcm, performance.pauses[pause_idx].1);
            pause_idx += 1;
        }
        let clip_start_ms = pcm.len() as f64 / BYTES_PER_MS;
        while vp_idx < performance.viewports.len() && performance.viewports[vp_idx].0 <= seg_start {
            let (_, first, last) = performance.viewports[vp_idx];
            gold.viewport_hints.push((clip_start_ms, first, last));
            vp_idx += 1;
        }

        let words: Vec<&str> = performance.words[seg_start..seg_end]
            .iter()
            .map(|w| w.text.as_str())
            .collect();
        let text = segment_text(performance, seg_start, seg_end);
        let clip = clip_for(&text)?;
        let clip_ms = clip.len() as f64 / BYTES_PER_MS;

        // Word timing inside the clip: proportional to character length —
        // closer to reality than uniform splitting for mixed-length words.
        let total_chars: usize = words.iter().map(|w| w.len() + 2).sum();
        let mut t = clip_start_ms;
        for (i, w) in performance.words[seg_start..seg_end].iter().enumerate() {
            let share = (words[i].len() + 2) as f64 / total_chars as f64;
            let dur = clip_ms * share;
            gold.words.push(GoldWord {
                start_ms: t,
                end_ms: t + dur,
                text: w.text.clone(),
                gold: w.gold.clone(),
                respelled: w.respelled,
            });
            t += dur;
        }

        pcm.extend_from_slice(&clip);
        push_silence(&mut pcm, SEGMENT_GAP_MS);
    }

    // Trailing silence so server VAD closes the last utterance naturally.
    push_silence(&mut pcm, 1_500);
    gold.total_ms = pcm.len() as f64 / BYTES_PER_MS;
    Ok(SynthesizedRun { pcm, gold })
}

fn push_silence(pcm: &mut Vec<u8>, ms: u32) {
    let bytes = (ms as f64 * BYTES_PER_MS) as usize & !1;
    pcm.resize(pcm.len() + bytes, 0);
}

/// The voice macOS `say` renders a run with, standing in for each hosted engine
/// so a local corpus keeps the corpus's mix of three voices.
pub fn say_voice_for(engine: TtsEngine) -> &'static str {
    match engine {
        TtsEngine::Gemini => "Samantha",
        TtsEngine::Qwen => "Daniel",
        TtsEngine::Xai => "Karen",
    }
}

/// One clip rendered by macOS `say`, as 24 kHz mono PCM16 with its leading and
/// trailing silence trimmed. Cached by content hash in the shared cache.
///
/// # Why a local voice at all
///
/// The hosted engines cost money per clip and their audio is not kept, so a
/// corpus can only be re-captured by paying for it again — and every frozen
/// fixture predates the live fields the app now depends on (per-word times and
/// how each utterance closed). `say` is free, local and deterministic, which is
/// what makes it possible to re-decode the SAME audio under a different
/// recogniser setting and attribute the difference to the setting.
///
/// Trimming matters for gold. Gold spreads a clip's duration over its words by
/// character count, so silence `say` pads a clip with would be credited to the
/// first and last words of every segment.
pub fn say_clip(voice: &str, text: &str) -> anyhow::Result<Vec<u8>> {
    let cache_dir = shared_cache_dir();
    std::fs::create_dir_all(&cache_dir)?;
    let mut hash = 0xcbf29ce484222325u64;
    for bytes in [b"say-v1".as_slice(), voice.as_bytes(), text.as_bytes()] {
        for byte in bytes {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
        hash ^= 0xff;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    let cache_path = cache_dir.join(format!("say-{}-{hash:016x}.pcm", voice.to_lowercase()));
    if let Ok(cached) = std::fs::read(&cache_path) {
        return Ok(cached);
    }
    let pid = std::process::id();
    let aiff = cache_dir.join(format!("say-{hash:016x}.{pid}.aiff"));
    let out = cache_dir.join(format!("say-{hash:016x}.{pid}.raw"));
    let status = Command::new("say")
        .args(["-v", voice, "-o", aiff.to_str().unwrap(), "--", text])
        .status()?;
    anyhow::ensure!(status.success(), "say failed for {voice}: {text}");
    let trim = "silenceremove=start_periods=1:start_threshold=-50dB,areverse,\
                silenceremove=start_periods=1:start_threshold=-50dB,areverse";
    let status = Command::new("ffmpeg")
        .args([
            "-y",
            "-loglevel",
            "error",
            "-i",
            aiff.to_str().unwrap(),
            "-af",
            trim,
            "-ac",
            "1",
            "-ar",
            "24000",
            "-f",
            "s16le",
            out.to_str().unwrap(),
        ])
        .status()?;
    anyhow::ensure!(status.success(), "ffmpeg failed trimming a say clip");
    let pcm = std::fs::read(&out)?;
    let _ = std::fs::remove_file(&aiff);
    let _ = std::fs::remove_file(&out);
    write_new_cache_entry(&cache_path, &pcm)?;
    Ok(pcm)
}

/// [`synthesize`], rendered locally by `say` instead of a hosted engine. The
/// stitching and gold arithmetic are the same, so a local run is scored on the
/// same ruler as a hosted one.
pub fn synthesize_say(voice: &str, performance: &Performance) -> anyhow::Result<SynthesizedRun> {
    stitch(performance, |text| say_clip(voice, text))
}

/// Wrap raw PCM in a WAV container (for listening/debugging in the temp dir).
pub fn wav_bytes(pcm: &[u8]) -> Vec<u8> {
    let data = pcm.len() as u32;
    let mut wav = Vec::with_capacity(44 + pcm.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    wav.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data.to_le_bytes());
    wav.extend_from_slice(pcm);
    wav
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::{
        shared_cache_dir, shared_rendered_dir, stable_cache_key, TtsEngine, CACHE_DIR_ENV,
    };

    #[test]
    fn cache_key_is_stable_and_covers_every_input() {
        assert_eq!(
            stable_cache_key(TtsEngine::Gemini, "hello.", 0),
            "gemini-v2-9ed14a01851b0233.pcm",
        );
        assert_ne!(
            stable_cache_key(TtsEngine::Gemini, "hello.", 0),
            stable_cache_key(TtsEngine::Gemini, "hello!", 0),
        );
        assert_ne!(
            stable_cache_key(TtsEngine::Gemini, "hello.", 0),
            stable_cache_key(TtsEngine::Gemini, "hello.", 1),
        );
        assert_ne!(
            stable_cache_key(TtsEngine::Gemini, "hello.", 0),
            stable_cache_key(TtsEngine::Qwen, "hello.", 0),
        );
    }

    #[test]
    fn cache_directory_is_machine_wide() {
        let expected = std::env::var_os(CACHE_DIR_ENV)
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/private/tmp/candidcue-bench/tts-cache"));
        assert_eq!(shared_cache_dir(), expected);
        assert_eq!(
            shared_rendered_dir(),
            expected.parent().unwrap().join("tts"),
        );
    }
}
