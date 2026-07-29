//! Grok (xAI) speech-to-text — the app's only speech provider.
//!
//! ---------------------------------------------------------------------------
//! WHY THE SOCKET LIVES IN RUST
//! ---------------------------------------------------------------------------
//! Grok authenticates a streaming session with an `Authorization: Bearer`
//! **header**, and xAI's own documentation is explicit that the key must never
//! reach client-side code. The browser `WebSocket` constructor cannot set
//! headers at all, so the renderer could not hold this connection even if we
//! wanted it to, and the entire session lives here.
//!
//! That is a better boundary anyway: the key never crosses into JavaScript, and
//! the renderer's job shrinks to capturing PCM and forwarding frames.
//!
//! ---------------------------------------------------------------------------
//! WHAT WE BUY FROM THIS PROVIDER
//! ---------------------------------------------------------------------------
//! Server-side endpointing, and finality in more than one tier. Grok reports
//! `is_final` for a chunk of speech that will not be revised and `speech_final`
//! for the end of an utterance, so a long sentence stops being provisional
//! while it is still being spoken rather than only when it ends. It also
//! decides where an utterance ends from the audio itself, with a configurable
//! silence window — there is no client commit and no local speech gate. The
//! provider before last left turn boundaries to the client, which meant a
//! browser audio graph, a noise-floor calibration and a threshold: three
//! independent ways to produce a connected session that heard nothing, and all
//! three did. None of that machinery exists here.
//!
//! The one obligation this creates: **audio must keep flowing**. Server VAD
//! decides speech has stopped by observing silence, so a client that simply
//! stops sending frames never receives its final transcript. A live microphone
//! supplies that silence naturally; [`stream::SessionHandle::stop`] sends an
//! explicit `Finalize` for the case where it does not.
//!
//! ---------------------------------------------------------------------------
//! NO MODEL ID
//! ---------------------------------------------------------------------------
//! There is deliberately no model setting here. The streaming endpoint takes no
//! `model` parameter — the session is configured entirely by URL query, and a
//! model name is not one of the keys it accepts. The previous build carried a
//! `transcriptionModel` setting for exactly this purpose and it caused a real
//! outage: a settings document written by a still-earlier provider named a
//! model this one had never heard of, the take forwarded it, and the socket
//! reconnected seven times in twelve seconds. A setting that is written,
//! displayed and ignored is worse than no setting, so it is gone rather than
//! retained and quietly dropped.

use serde::{Deserialize, Serialize};

use crate::errors::AppError;
use crate::secrets::SecretString;

pub mod stream;

/// Bidirectional streaming transcription.
pub const STREAM_URL: &str = "wss://api.x.ai/v1/stt";
/// What the wire wants: a primary subtag, no region.
pub const DEFAULT_LANGUAGE: &str = "en";
/// What the language PICKER offers and Settings stores: a BCP-47 tag, because
/// "English (United States)" is what a presenter recognises. Narrowed to
/// [`DEFAULT_LANGUAGE`] by [`primary_subtag`] at the moment the URL is built,
/// so the two never have to agree anywhere else.
pub const DEFAULT_LANGUAGE_TAG: &str = "en-US";

/// The one sample rate the app captures, streams and validates at.
///
/// Pinned rather than negotiated: the renderer resamples its capture graph to
/// this, `sample_rate` on the session URL declares it, and the audio-clock
/// arithmetic in [`stream`] converts byte counts to milliseconds with it. Three
/// places that must agree, so there is one constant. 24 kHz is one of the six
/// rates Grok accepts natively, so nothing resamples on the way in.
pub const SAMPLE_RATE_HZ: u32 = 24_000;

/// Grok caps custom vocabulary at 100 terms of 50 characters.
///
/// Enforced before the URL is built rather than at the call site, because
/// exceeding it is a connect-time rejection and not a degraded take: the terms
/// ride on the URL that OPENS the socket, so a 101st term does not weaken the
/// bias — it prevents the session.
pub const MAX_KEYTERMS: usize = 100;
pub const MAX_KEYTERM_CHARS: usize = 50;

/// Everything the session URL declares.
///
/// Unlike the config frame this replaced, these are query parameters on the
/// upgrade request — which means a bad value is not a mid-take error but a
/// refused connection, and it means the vocabulary cannot be revised without
/// dropping the socket.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SttConfig {
    pub sample_rate_hz: u32,
    /// Primary language subtag (`en`), not BCP-47 (`en-US`). See
    /// [`primary_subtag`].
    pub language: String,
    pub interim_results: bool,
    /// Silence (ms) before an utterance is called final.
    pub endpointing_ms: u32,
    pub vad_threshold: f64,
    /// End-of-turn confidence threshold. `None` leaves Smart Turn off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub smart_turn: Option<f64>,
    /// Custom vocabulary (`keyterm`): a soft bias towards the terms this script
    /// uses, built by [`cc_align::extract_terms`] from its spoken tokens.
    ///
    /// Sent once, on the URL that opens the socket — including the one that
    /// opens every RECONNECT, since the configuration is fixed for the life of
    /// the connection. That is also why the vocabulary is a whole-script list
    /// rather than a window around the reader: there is no way to revise it
    /// without dropping the connection, and dropping the connection mid-take
    /// costs more than any bias could return.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub keyterms: Vec<String>,
}

impl Default for SttConfig {
    fn default() -> Self {
        Self {
            sample_rate_hz: SAMPLE_RATE_HZ,
            language: DEFAULT_LANGUAGE.to_string(),
            interim_results: true,
            /*
             * 300 ms rather than the service default of 10 ms.
             *
             * At 10 ms every breath ends an utterance, which floods the ledger
             * with fragments and throws away the accumulated context that makes
             * a long sentence track. 300 ms is comfortably longer than an
             * inter-word gap in read delivery and comfortably shorter than a
             * deliberate beat for emphasis — which is the pause a teleprompter
             * must not mistake for the end of a thought.
             */
            endpointing_ms: 300,
            vad_threshold: 0.08,
            smart_turn: None,
            keyterms: Vec::new(),
        }
    }
}

impl SttConfig {
    /// The full `wss://` URL for this configuration.
    ///
    /// Percent-encoding is done by hand for the fields that can contain
    /// anything — a key term is drawn from a user's script and may hold spaces,
    /// ampersands or non-ASCII, any of which would otherwise truncate the query
    /// string and silently change the session's configuration into one nobody
    /// asked for.
    pub fn stream_url(&self) -> String {
        let mut url = format!(
            "{STREAM_URL}?sample_rate={}&encoding=pcm&interim_results={}&endpointing={}&vad_threshold={}",
            self.sample_rate_hz, self.interim_results, self.endpointing_ms, self.vad_threshold
        );
        if !self.language.is_empty() {
            url.push_str(&format!("&language={}", encode_query(&self.language)));
        }
        if let Some(threshold) = self.smart_turn {
            url.push_str(&format!("&smart_turn={threshold}"));
        }
        for term in self.sanitised_keyterms() {
            url.push_str(&format!("&keyterm={}", encode_query(&term)));
        }
        url
    }

    /// The vocabulary actually sent: trimmed, deduplicated, over-long terms
    /// dropped, and capped at the provider's limit.
    pub fn sanitised_keyterms(&self) -> Vec<String> {
        let mut seen = std::collections::HashSet::new();
        self.keyterms
            .iter()
            .map(|term| term.trim())
            .filter(|term| !term.is_empty() && term.chars().count() <= MAX_KEYTERM_CHARS)
            .filter(|term| seen.insert(term.to_lowercase()))
            .take(MAX_KEYTERMS)
            .map(str::to_string)
            .collect()
    }
}

/// Narrow a BCP-47 tag to the primary subtag Grok wants (`en-US` → `en`).
///
/// The app's language picker offers regional variants because they are what a
/// presenter recognises, and the stored value stays BCP-47. Grok rejects the
/// regional form, so the narrowing happens here — once, at the wire — rather
/// than by changing what the UI is allowed to offer.
pub fn primary_subtag(language: &str) -> String {
    language
        .split(['-', '_'])
        .next()
        .unwrap_or("")
        .to_lowercase()
}

fn encode_query(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
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

/// Managed state: the live stream, if one is running. Exactly one streaming
/// session may exist at a time — a take owns the microphone, and a second
/// session would bill for audio nobody is reading.
pub struct SttClient {
    session: std::sync::Mutex<Option<stream::SessionHandle>>,
    next_generation: std::sync::atomic::AtomicU64,
}

impl Default for SttClient {
    fn default() -> Self {
        Self::new()
    }
}

impl SttClient {
    pub fn new() -> Self {
        Self {
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

    /// Try the key by opening the REAL streaming socket and closing it.
    ///
    /// A round-trip rather than a shape check: the failure this guards against
    /// is a key that looks perfectly well-formed and has been revoked, which is
    /// indistinguishable from a good one until something asks the service.
    ///
    /// Deliberately the streaming endpoint and not the batch one. The rule this
    /// follows is the one the microphone test learned the hard way: a
    /// diagnostic that exercises a different configuration from the thing it is
    /// diagnosing is worse than no diagnostic, because it is believed. The two
    /// endpoints have separate permissions, and a real 403 seen during
    /// development read `"Your newly created team doesn't have any credits or
    /// licenses yet"` — an account-level refusal that a batch call might well
    /// have answered differently. No audio is sent, so this costs nothing but
    /// the upgrade.
    pub async fn validate_key(&self, key: &SecretString) -> KeyValidationResult {
        match stream::probe(key, &SttConfig::default()).await {
            Ok(()) => KeyValidationResult::of("valid"),
            Err(err) => match err.status {
                Some(401) | Some(403) => KeyValidationResult::with_message("invalid", err.message),
                Some(429) => KeyValidationResult::of("quota"),
                Some(_) => KeyValidationResult::with_message("provider_error", err.message),
                // No status at all: DNS failure, TLS failure, connection
                // refused, timeout. Reported as network rather than as a bad
                // key, because telling somebody their key is wrong when the
                // wifi is off sends them to regenerate a key that was fine.
                None => KeyValidationResult::of("network_error"),
            },
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
        config: SttConfig,
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
            .expect("stt session poisoned")
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
        let guard = self.session.lock().expect("stt session poisoned");
        match guard.as_ref() {
            Some(session) if session.generation == generation => session.push_audio(pcm),
            _ => Ok(()),
        }
    }

    /// End the session: send `Finalize` so the last utterance is finalized
    /// rather than stranded, then close.
    pub fn stop_stream(&self, generation: u64) {
        let mut guard = self.session.lock().expect("stt session poisoned");
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
            .expect("stt session poisoned")
            .as_ref()
            .map(|session| session.generation)
    }
}

/// Pull the human-readable half out of an xAI error body.
///
/// The shape seen live is `{"code": <sentence>, "error": <sentence>}`, where
/// `error` is the one that says what to do about it. We never construct a
/// message containing a key.
pub(crate) fn provider_message(body: &str) -> Option<String> {
    let parsed = serde_json::from_str::<serde_json::Value>(body).ok()?;
    for key in ["error", "message", "code"] {
        if let Some(text) = parsed.get(key).and_then(|v| v.as_str()) {
            if !text.trim().is_empty() {
                return Some(text.trim().to_string());
            }
        }
    }
    parsed
        .pointer("/error/message")
        .and_then(|v| v.as_str())
        .map(str::to_string)
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
    fn the_url_carries_every_configured_field() {
        // These parameter names were verified against the live endpoint. A
        // rename would not fail loudly — an unknown query key is ignored, and
        // the session would quietly run on the service's defaults.
        let url = SttConfig::default().stream_url();
        assert!(url.starts_with("wss://api.x.ai/v1/stt?"));
        assert!(url.contains("sample_rate=24000"));
        assert!(url.contains("encoding=pcm"));
        assert!(url.contains("interim_results=true"));
        assert!(url.contains("endpointing=300"));
        assert!(url.contains("language=en"));
        // A session with no script — the microphone test — must send exactly
        // the URL it sent before custom vocabulary existed.
        assert!(!url.contains("keyterm="));
        assert!(!url.contains("smart_turn="));
    }

    #[test]
    fn a_script_vocabulary_rides_on_the_session_url() {
        let config = SttConfig {
            keyterms: vec!["RustLight Games".into(), "three thirty".into()],
            ..SttConfig::default()
        };
        let url = config.stream_url();
        assert!(url.contains("keyterm=RustLight%20Games"));
        assert!(url.contains("keyterm=three%20thirty"));
    }

    /// A term is drawn from a user's script, so it can hold anything. An
    /// unescaped `&` would end the parameter and turn the rest of the
    /// vocabulary into query keys the service ignores — a silently weaker bias
    /// on exactly the scripts that need it most.
    #[test]
    fn key_terms_cannot_truncate_the_query_string() {
        let config = SttConfig {
            keyterms: vec!["A&B".into(), "50% off".into(), "Dagný".into()],
            ..SttConfig::default()
        };
        let url = config.stream_url();
        assert!(url.contains("keyterm=A%26B"));
        assert!(url.contains("keyterm=50%25%20off"));
        assert!(!url.contains("keyterm=A&B"));
    }

    #[test]
    fn key_terms_are_capped_deduplicated_and_length_filtered() {
        let config = SttConfig {
            keyterms: {
                let mut terms = vec![
                    "alpha".to_string(),
                    "ALPHA".to_string(), // duplicate, case-folded
                    "x".repeat(51),      // over the provider's per-term limit
                    "   ".to_string(),   // whitespace only
                ];
                terms.extend((0..120).map(|i| format!("term{i}")));
                terms
            },
            ..SttConfig::default()
        };
        let sent = config.sanitised_keyterms();
        assert_eq!(sent.len(), MAX_KEYTERMS);
        assert_eq!(sent[0], "alpha");
        assert!(!sent.iter().any(|t| t.chars().count() > MAX_KEYTERM_CHARS));
        assert!(!sent.iter().any(|t| t.trim().is_empty()));
    }

    #[test]
    fn bcp47_is_narrowed_to_the_primary_subtag() {
        assert_eq!(primary_subtag("en-US"), "en");
        assert_eq!(primary_subtag("en"), "en");
        assert_eq!(primary_subtag("pt-BR"), "pt");
        assert_eq!(primary_subtag(""), "");
    }

    #[test]
    fn a_permission_failure_reports_the_actionable_half() {
        // The exact body a live 403 returned during development.
        let body = r#"{"code":"The caller does not have permission to execute the specified operation","error":"Your newly created team doesn't have any credits or licenses yet."}"#;
        assert_eq!(
            provider_message(body).unwrap(),
            "Your newly created team doesn't have any credits or licenses yet."
        );
    }

    #[test]
    fn base64_frames_decode_or_are_refused() {
        use base64::Engine as _;
        let pcm: Vec<u8> = (0..512u16).flat_map(|s| s.to_le_bytes()).collect();
        let encoded = base64::engine::general_purpose::STANDARD.encode(&pcm);
        assert_eq!(decode_base64(&encoded).unwrap(), pcm);
        assert!(decode_base64("not base64!!").is_err());
    }
}
