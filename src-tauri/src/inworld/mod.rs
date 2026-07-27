//! Inworld speech-to-text — the app's only speech provider.
//!
//! ---------------------------------------------------------------------------
//! WHY THE SOCKET LIVES IN RUST
//! ---------------------------------------------------------------------------
//! Inworld authenticates a streaming session with an `Authorization: Basic`
//! **header**. The browser `WebSocket` constructor cannot set headers, and the
//! key-as-query-parameter form the docs describe is rejected by the live
//! service — it completes the HTTP upgrade with a 101 and then answers the
//! config frame with `API key does not exist`, which reads as a healthy socket
//! that transcribes nothing. So the renderer cannot hold this connection even
//! in principle, and the entire session lives here.
//!
//! That is a better boundary anyway: the key never crosses into JavaScript, and
//! the renderer's job shrinks to capturing PCM and forwarding frames.
//!
//! ---------------------------------------------------------------------------
//! WHAT WE BUY FROM THIS PROVIDER
//! ---------------------------------------------------------------------------
//! Server-side endpointing. Inworld reports `speechStarted` / `speechStopped`
//! and returns `isFinal` transcripts from streamed audio with no client commit
//! and no local speech gate. The predecessor provider left turn boundaries to
//! the client, which meant a browser audio graph, a noise-floor calibration and
//! a threshold — three independent ways to produce a connected session that
//! heard nothing, and all three did. None of that machinery exists here.
//!
//! The one obligation this creates: **audio must keep flowing**. Server VAD
//! decides speech has stopped by observing silence, so a client that simply
//! stops sending frames never receives its final transcript. A live microphone
//! supplies that silence naturally; [`stream::SessionHandle::stop`] sends an
//! explicit `endTurn` for the case where it does not.

use serde::{Deserialize, Serialize};

use crate::errors::AppError;
use crate::secrets::SecretString;

pub mod stream;

/// Bidirectional streaming transcription.
pub const STREAM_URL: &str = "wss://api.inworld.ai/stt/v1/transcribe:streamBidirectional";
/// One-shot transcription of a complete clip. Used only to validate a key.
pub const SYNC_URL: &str = "https://api.inworld.ai/stt/v1/transcribe";
pub const DEFAULT_MODEL: &str = "inworld/inworld-stt-1";
pub const DEFAULT_LANGUAGE: &str = "en-US";

/// Every model id this provider will accept for streaming transcription.
///
/// The list exists because of a real failure, not for tidiness. The settings
/// document is a JSON blob that survives a provider change: a user who had
/// used the previous build still had `audio.transcriptionModel:
/// "gpt-realtime-whisper"` on disk, the take sent it, and Inworld answered
/// `code 3, Unsupported model`. The microphone TEST sent no model at all and
/// therefore worked perfectly — so the app appeared healthy everywhere except
/// where it mattered.
pub const SUPPORTED_MODELS: &[&str] = &["inworld/inworld-stt-1"];

/// The model to actually ask for, given whatever was requested.
///
/// Anything this provider does not serve is replaced by the default rather
/// than forwarded. Sending it would open a socket, bill for the attempt, and
/// return an error the presenter cannot act on mid-take — and the value that
/// gets here is a persisted string from a build that may predate this
/// provider entirely, which is exactly the input that must not be trusted.
pub fn resolve_model(requested: Option<&str>) -> String {
    match requested.map(str::trim) {
        Some(model) if SUPPORTED_MODELS.contains(&model) => model.to_string(),
        _ => DEFAULT_MODEL.to_string(),
    }
}

/// The one sample rate the app captures, streams and validates at.
///
/// Pinned rather than negotiated: the renderer resamples its capture graph to
/// this, `sampleRateHertz` in the config frame declares it, and the audio-clock
/// arithmetic in [`stream`] converts byte counts to milliseconds with it. Three
/// places that must agree, so there is one constant.
pub const SAMPLE_RATE_HZ: u32 = 24_000;

/// Inworld's `transcribeConfig`, sent as the first frame of a stream and
/// alongside the audio of a sync request.
///
/// Unknown keys here are silently ignored by the service rather than rejected,
/// which is worth knowing before adding a field and concluding it had an
/// effect: a deliberately bogus config block produced timings identical to a
/// correct one.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeConfig {
    pub model_id: String,
    pub audio_encoding: String,
    pub sample_rate_hertz: u32,
    pub language: String,
    /// Custom vocabulary (`prompts`): a soft bias towards the terms this
    /// script uses, built by [`cc_align::vocab`] from its spoken tokens.
    ///
    /// Sent once, on the config frame that leads the socket — including the
    /// one that leads every RECONNECT, since the config is held for the life
    /// of the session. That is also why the vocabulary is a whole-script list
    /// rather than a window around the reader: there is no way to revise it
    /// without dropping the connection, and dropping the connection mid-take
    /// costs more than any bias could return.
    ///
    /// Omitted when empty rather than sent as `[]`, so the microphone test and
    /// any take without a script produce exactly the frame they always did.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub prompts: Vec<String>,
}

impl Default for TranscribeConfig {
    fn default() -> Self {
        Self {
            model_id: DEFAULT_MODEL.to_string(),
            audio_encoding: "LINEAR16".to_string(),
            sample_rate_hertz: SAMPLE_RATE_HZ,
            language: DEFAULT_LANGUAGE.to_string(),
            prompts: Vec::new(),
        }
    }
}

/// What settings learned by trying the key. Never contains the key.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyValidationResult {
    /// `valid` | `invalid` | `quota` | `network_error` | `provider_error`
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl KeyValidationResult {
    fn of(status: &str) -> Self {
        Self {
            status: status.to_string(),
            message: None,
        }
    }

    fn with_message(status: &str, message: impl Into<String>) -> Self {
        Self {
            status: status.to_string(),
            message: Some(message.into()),
        }
    }
}

/// A RIFF/WAVE container of pure silence, for the validation round-trip.
///
/// The sync endpoint wants the **container**, unlike `audioChunk.content` on
/// the stream which wants headerless samples — feeding it bare samples returns
/// a 500 whose text says nothing about the cause. Silence rather than speech
/// because this call exists to answer "is this key live", and 100 ms is the
/// smallest clip the service reliably accepts.
fn silent_wav(duration_ms: u32) -> Vec<u8> {
    let samples = (SAMPLE_RATE_HZ as u64 * duration_ms as u64 / 1000) as u32;
    let data_bytes = samples * 2;
    let mut wav = Vec::with_capacity(44 + data_bytes as usize);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_bytes).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes()); // PCM fmt chunk size
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
    wav.extend_from_slice(&1u16.to_le_bytes()); // mono
    wav.extend_from_slice(&SAMPLE_RATE_HZ.to_le_bytes());
    wav.extend_from_slice(&(SAMPLE_RATE_HZ * 2).to_le_bytes()); // byte rate
    wav.extend_from_slice(&2u16.to_le_bytes()); // block align
    wav.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_bytes.to_le_bytes());
    wav.resize(44 + data_bytes as usize, 0);
    wav
}

/// Managed state: the HTTP client for validation, and the live stream if one is
/// running. Exactly one streaming session may exist at a time — a take owns the
/// microphone, and a second session would bill for audio nobody is reading.
pub struct InworldClient {
    http: reqwest::Client,
    session: std::sync::Mutex<Option<stream::SessionHandle>>,
    next_generation: std::sync::atomic::AtomicU64,
}

impl Default for InworldClient {
    fn default() -> Self {
        Self::new()
    }
}

impl InworldClient {
    pub fn new() -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .unwrap_or_default(),
            session: std::sync::Mutex::new(None),
            next_generation: std::sync::atomic::AtomicU64::new(1),
        }
    }

    /// The generation of the stream currently running, if any.
    ///
    /// Exists so an alignment session armed AFTER its socket can still bind to
    /// it. Both are async IPC calls from the frontend and their landing order
    /// is not guaranteed, so binding cannot rely on one arriving first.
    pub fn current_generation(&self) -> Option<u64> {
        self.session
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|handle| handle.generation))
    }

    /// Try the key against the sync endpoint and report what happened.
    ///
    /// A real round-trip rather than a shape check: the failure this guards
    /// against is a key that looks perfectly well-formed and has been revoked,
    /// which is indistinguishable from a good one until something asks the
    /// service. Costs 100 ms of billed audio.
    pub async fn validate_key(&self, key: &SecretString) -> KeyValidationResult {
        let body = serde_json::json!({
            "transcribeConfig": TranscribeConfig::default(),
            "audioData": { "content": encode_base64(&silent_wav(100)) },
        });
        let response = self
            .http
            .post(SYNC_URL)
            .header("Authorization", format!("Basic {}", key.expose()))
            .json(&body)
            .send()
            .await;

        let response = match response {
            Ok(response) => response,
            // Connection refused, DNS failure, TLS failure, timeout — all
            // reported as network rather than as a bad key, because telling
            // somebody their key is wrong when the wifi is off sends them to
            // regenerate a key that was fine.
            Err(_) => return KeyValidationResult::of("network_error"),
        };

        match response.status().as_u16() {
            200 => KeyValidationResult::of("valid"),
            // 403 is what a deleted or unknown key actually returns
            // (`code: 7`); 401 is included because it is the conventional
            // answer and costs nothing to accept.
            401 | 403 => KeyValidationResult::with_message("invalid", provider_message(response).await),
            429 => KeyValidationResult::of("quota"),
            _ => KeyValidationResult::with_message("provider_error", provider_message(response).await),
        }
    }

    /// Open a streaming session, replacing any session already running.
    ///
    /// Returns the generation, which stamps every event the session emits and
    /// every audio frame the renderer pushes. Without it, a frame in flight
    /// when a take ends would be appended to the next take's audio, and a
    /// transcript from the old socket would land in the new take's ledger.
    pub fn start_stream<R: tauri::Runtime>(
        &self,
        app: tauri::AppHandle<R>,
        key: SecretString,
        config: TranscribeConfig,
    ) -> u64 {
        let generation = self
            .next_generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        /*
         * Bind the alignment engine to THIS socket, before the task that reads
         * it is spawned.
         *
         * The generation exists nowhere else — it is minted here and stamped on
         * every frame — so this is the only place that can tie the two
         * together. Asking the frontend for it would be asking it to guess, and
         * the guess it made was the SESSION generation: an unrelated counter
         * that routinely disagrees (Preflight's microphone test consumes socket
         * 1, so the first real take runs on socket 2 while the coordinator is
         * still on session 1). Every frame was then dropped on a connection
         * reporting perfect health.
         *
         * Before the spawn, so no frame of the new stream can arrive ahead of
         * the binding.
         */
        crate::align::bind_stream_generation(&app, generation);
        let handle = stream::SessionHandle::spawn(app, generation, key, config);
        let previous = self
            .session
            .lock()
            .expect("inworld session poisoned")
            .replace(handle);
        if let Some(previous) = previous {
            previous.abandon();
        }
        generation
    }

    /// Forward one PCM16 frame. Silently ignores frames stamped with a
    /// generation that is no longer current — that is a late frame from a take
    /// that has ended, not an error worth surfacing.
    pub fn push_audio(&self, generation: u64, pcm: Vec<u8>) -> Result<(), AppError> {
        let guard = self.session.lock().expect("inworld session poisoned");
        match guard.as_ref() {
            Some(session) if session.generation == generation => session.push_audio(pcm),
            _ => Ok(()),
        }
    }

    /// End the session: send `endTurn` so the last utterance is finalized
    /// rather than stranded, then close.
    pub fn stop_stream(&self, generation: u64) {
        let mut guard = self.session.lock().expect("inworld session poisoned");
        let matches = guard
            .as_ref()
            .is_some_and(|session| session.generation == generation);
        if matches {
            if let Some(session) = guard.take() {
                session.stop();
            }
        }
    }

    /// Generation of the live session, if any. Diagnostics only.
    pub fn active_generation(&self) -> Option<u64> {
        self.session
            .lock()
            .expect("inworld session poisoned")
            .as_ref()
            .map(|session| session.generation)
    }
}

/// The provider's own error text, for a settings message that says what went
/// wrong. Inworld redacts the key in its own message (`"bm90***"`), and we
/// never construct one containing a key.
async fn provider_message(response: reqwest::Response) -> String {
    let fallback = "Inworld rejected the request.".to_string();
    let Ok(body) = response.text().await else {
        return fallback;
    };
    serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|value| {
            value
                .get("message")
                .or_else(|| value.pointer("/error/message"))
                .and_then(|message| message.as_str().map(str::to_string))
        })
        .unwrap_or(fallback)
}

pub(crate) fn encode_base64(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

pub(crate) fn decode_base64(text: &str) -> Result<Vec<u8>, AppError> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(text)
        .map_err(|_| AppError::invalid_input("Audio frame was not valid base64."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silent_wav_is_a_parsable_riff_container_of_the_requested_length() {
        // The sync endpoint answers a malformed container with a 500 whose text
        // blames a proxy, so a defect here would surface as "your key is
        // broken" for every user. Cheaper to assert the header arithmetic.
        let wav = silent_wav(100);
        let expected_samples = SAMPLE_RATE_HZ / 10;
        let expected_data = expected_samples * 2;

        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(
            u32::from_le_bytes(wav[40..44].try_into().unwrap()),
            expected_data
        );
        assert_eq!(
            u32::from_le_bytes(wav[4..8].try_into().unwrap()),
            36 + expected_data
        );
        assert_eq!(wav.len(), 44 + expected_data as usize);
        assert!(wav[44..].iter().all(|byte| *byte == 0), "must be silence");
    }

    #[test]
    fn config_defaults_match_the_wire_names_the_service_expects() {
        // Unknown config keys are ignored rather than rejected, so a rename
        // here would not fail loudly — it would quietly fall back to whatever
        // the service defaults to. These are the names verified against the
        // live endpoint.
        let json = serde_json::to_value(TranscribeConfig::default()).unwrap();
        assert_eq!(json["modelId"], DEFAULT_MODEL);
        assert_eq!(json["audioEncoding"], "LINEAR16");
        assert_eq!(json["sampleRateHertz"], SAMPLE_RATE_HZ);
        assert_eq!(json["language"], DEFAULT_LANGUAGE);
        // A session with no script — the microphone test — must send exactly
        // the frame it sent before custom vocabulary existed.
        assert!(json.get("prompts").is_none());
    }

    #[test]
    fn a_script_vocabulary_rides_on_the_config_frame() {
        let config = TranscribeConfig {
            prompts: vec!["RustLight Games".into(), "three thirty".into()],
            ..TranscribeConfig::default()
        };
        let json = serde_json::to_value(config).unwrap();
        assert_eq!(json["prompts"][0], "RustLight Games");
        assert_eq!(json["prompts"][1], "three thirty");
    }

    #[test]
    fn base64_round_trips_pcm_frames() {
        let pcm: Vec<u8> = (0..512u16).flat_map(|s| s.to_le_bytes()).collect();
        assert_eq!(decode_base64(&encode_base64(&pcm)).unwrap(), pcm);
        assert!(decode_base64("not base64!!").is_err());
    }
}
