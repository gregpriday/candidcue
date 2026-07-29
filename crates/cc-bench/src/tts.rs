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

use std::path::PathBuf;
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::plan::{GoldTimeline, GoldWord, Performance};

pub const SAMPLE_RATE: u32 = 24_000;
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
            // commentary). The wrapper pins it to verbatim reading; verified
            // via the provider sync endpoint that the wrapper itself is not
            // spoken.
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
    key: String,
    cache_dir: PathBuf,
}

impl Synthesizer {
    pub fn new(cache_dir: PathBuf) -> anyhow::Result<Self> {
        let key = std::env::var("FAL_KEY")
            .map_err(|_| anyhow::anyhow!("FAL_KEY not set in the environment"))?;
        std::fs::create_dir_all(&cache_dir)?;
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
        let cache_key = {
            use std::collections::hash_map::DefaultHasher;
            use std::hash::{Hash, Hasher};
            let mut h = DefaultHasher::new();
            (engine.slug(), voice_index, text).hash(&mut h);
            format!("{}-{:016x}.pcm", engine.slug(), h.finish())
        };
        let cache_path = self.cache_dir.join(&cache_key);
        if let Ok(cached) = std::fs::read(&cache_path) {
            return Ok(cached);
        }

        let response = self
            .http
            .post(engine.endpoint())
            .header("Authorization", format!("Key {}", self.key))
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
        std::fs::write(&cache_path, &pcm)?;
        Ok(pcm)
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
    let mut pcm: Vec<u8> = Vec::new();
    let mut gold = GoldTimeline::default();
    push_silence(&mut pcm, LEAD_IN_MS);

    let mut pause_idx = 0usize;
    let mut vp_idx = 0usize;

    for &(seg_start, seg_end) in &performance.segments {
        // Pauses and viewport hints scheduled before this segment.
        while pause_idx < performance.pauses.len()
            && performance.pauses[pause_idx].0 <= seg_start
        {
            push_silence(&mut pcm, performance.pauses[pause_idx].1);
            pause_idx += 1;
        }
        let clip_start_ms = pcm.len() as f64 / BYTES_PER_MS;
        while vp_idx < performance.viewports.len()
            && performance.viewports[vp_idx].0 <= seg_start
        {
            let (_, first, last) = performance.viewports[vp_idx];
            gold.viewport_hints.push((clip_start_ms, first, last));
            vp_idx += 1;
        }

        let words: Vec<&str> = performance.words[seg_start..seg_end]
            .iter()
            .map(|w| w.text.as_str())
            .collect();
        let text = format!("{}.", words.join(" "));
        let clip = synth.clip(engine, &text, voice_index).await?;
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
