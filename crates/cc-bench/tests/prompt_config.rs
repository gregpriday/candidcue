//! Live check that a vocabulary config frame is ACCEPTED.
//!
//! This is the cheap half of testing `transcribeConfig.prompts`, and the half
//! that guards the expensive failure. The config frame leads the socket, so a
//! term the gateway dislikes does not degrade a take — it returns
//! `INVALID_ARGUMENT` and there is no take at all. Every punctuation mark
//! `cc_align::vocab::sanitize` is willing to emit is exercised here against the
//! real service, on a second of silence, for a fraction of a cent.
//!
//! Gated on `INWORLD_API_KEY`: it is skipped, loudly, when there is no key.

use cc_stt::inworld::TranscribeConfig;
use cc_stt::{SttFrame, SAMPLE_RATE_HZ};
use tokio::sync::mpsc;

/// A second and a half of silence — enough audio for the service to accept the
/// stream and answer, not enough to be worth transcribing.
fn silence() -> Vec<u8> {
    vec![0u8; (SAMPLE_RATE_HZ as usize * 2 * 3) / 2]
}

async fn errors_for(prompts: Vec<String>) -> Vec<String> {
    let key = std::env::var("INWORLD_API_KEY").expect("checked by the caller");
    let (tx, mut rx) = mpsc::unbounded_channel();
    let config = TranscribeConfig {
        prompts,
        ..TranscribeConfig::default()
    };
    let pcm = silence();
    let streamer = cc_stt::inworld::stream_pcm(&key, &config, &pcm, 100, 4.0, tx);
    let collector = async {
        let mut messages = Vec::new();
        while let Some(frame) = rx.recv().await {
            match frame {
                SttFrame::Error { message } => messages.push(message),
                SttFrame::Closed {} => break,
                _ => {}
            }
        }
        messages
    };
    let (stream, messages) = tokio::join!(streamer, collector);
    // A transport failure is not the same as a rejected config, and reporting
    // one as the other would turn a flaky network into a false verdict about
    // the sanitiser.
    if let Err(err) = stream {
        panic!("stream failed before the service could answer: {err}");
    }
    messages
}

#[tokio::test]
async fn every_punctuation_mark_the_sanitiser_emits_is_accepted() {
    if std::env::var("INWORLD_API_KEY").is_err() {
        eprintln!("SKIP: INWORLD_API_KEY not set — live config check not run");
        return;
    }
    // One term per character class the allowlist permits, plus the shapes the
    // extractor actually produces.
    let prompts = vec![
        "RustLight Games".to_string(),
        "twenty-seven".to_string(),
        "2.4 million dollars".to_string(),
        "nine fifteen".to_string(),
        "3.2".to_string(),
        "24kHz".to_string(),
        "9:00".to_string(),
        "Dagný Þorvaldsdóttir".to_string(),
        "Siobhán Ó Faoláin".to_string(),
        "nobody's".to_string(),
        "Anne-Marie Okonkwo, again".to_string(),
    ];
    let errors = errors_for(prompts).await;
    assert!(
        errors.is_empty(),
        "the service rejected a vocabulary the sanitiser considers safe: {errors:?}"
    );
}

/// The negative control.
///
/// Without it, the test above proves only that nothing went wrong — which is
/// also what it would print if the service ignored `prompts` entirely, the way
/// this service is documented to ignore unknown config keys. A `#` must be
/// REJECTED for "accepted" to carry information.
#[tokio::test]
async fn a_character_outside_the_allowlist_is_rejected() {
    if std::env::var("INWORLD_API_KEY").is_err() {
        eprintln!("SKIP: INWORLD_API_KEY not set — live config check not run");
        return;
    }
    let errors = errors_for(vec!["build v2#final".to_string()]).await;
    assert!(
        !errors.is_empty(),
        "the gateway accepted `#`, so it is not validating `prompts` at all — \
         the sanitiser's allowlist may be stricter than it needs to be, and \
         `every_punctuation_mark_the_sanitiser_emits_is_accepted` proves nothing"
    );
}
