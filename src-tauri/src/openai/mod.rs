//! OpenAI REST client (spec §44.7): key validation, short-lived client
//! secret creation for the webview's WebRTC transcription connection, Luna
//! structured requests, vocabulary analysis. Stub — construction only.

#![allow(dead_code)]

/// Default live transcription model (non-negotiable decision 5).
pub const DEFAULT_TRANSCRIPTION_MODEL: &str = "gpt-realtime-whisper";
/// Command interpretation model for ambiguous natural-language commands.
pub const DEFAULT_COMMAND_MODEL: &str = "gpt-5.6-luna";

pub const API_BASE_URL: &str = "https://api.openai.com/v1";

pub struct OpenAiClient {
    http: reqwest::Client,
}

impl OpenAiClient {
    pub fn new() -> Self {
        Self {
            http: reqwest::Client::new(),
        }
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }
}

impl Default for OpenAiClient {
    fn default() -> Self {
        Self::new()
    }
}
