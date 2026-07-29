//! Live check that a custom vocabulary is ACCEPTED by the session URL.
//!
//! This is the cheap half of testing `keyterm`, and the half that guards the
//! expensive failure. The terms ride on the URL that OPENS the socket, so a
//! vocabulary the gateway dislikes does not degrade a take — the upgrade is
//! refused and there is no take at all. Every shape `cc_align::vocab::sanitize`
//! is willing to emit is exercised here against the real service, on a second
//! and a half of silence, for a fraction of a cent.
//!
//! The previous provider validated the term text itself, so a deliberately
//! invalid character was a meaningful negative control. That control is gone
//! on purpose: `SttConfig::stream_url` percent-encodes every term, so no
//! character can reach the gateway as syntax. What can still break a session
//! is COUNT and LENGTH, which is what the second test covers.
//!
//! Gated on `GROK_API_KEY`: skipped, loudly, when there is no key.

use cc_stt::{SttConfig, SttFrame, MAX_KEYTERMS, SAMPLE_RATE_HZ};
use tokio::sync::mpsc;

/// A second and a half of silence — enough audio for the service to accept the
/// stream and answer, not enough to be worth transcribing.
fn silence() -> Vec<u8> {
    vec![0u8; (SAMPLE_RATE_HZ as usize * 2 * 3) / 2]
}

/// Run a session carrying `keyterms` and return everything that went wrong.
///
/// A connect-time refusal surfaces as an `Err` from `stream_pcm`, not as an
/// `Error` frame, because the URL is rejected before there is a socket to
/// carry frames — so both are collected.
async fn errors_for(keyterms: Vec<String>) -> Vec<String> {
    let key = std::env::var("GROK_API_KEY").expect("checked by the caller");
    let (tx, mut rx) = mpsc::unbounded_channel();
    let config = SttConfig {
        keyterms,
        ..SttConfig::default()
    };
    let pcm = silence();
    let streamer = cc_stt::stream_pcm(&key, &config, &pcm, 100, 4.0, tx);
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
    let (stream, mut messages) = tokio::join!(streamer, collector);
    if let Err(err) = stream {
        messages.push(err);
    }
    messages
}

#[tokio::test]
async fn every_shape_the_sanitiser_emits_is_accepted() {
    if std::env::var("GROK_API_KEY").is_err() {
        eprintln!("SKIP: GROK_API_KEY not set — live config check not run");
        return;
    }
    // One term per character class the extractor can produce.
    let keyterms = vec![
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
        // Deliberately included: percent-encoding must make these inert rather
        // than letting them terminate the query string.
        "build v2#final".to_string(),
        "A&B Testing".to_string(),
    ];
    let errors = errors_for(keyterms).await;
    assert!(
        errors.is_empty(),
        "the service rejected a vocabulary the sanitiser considers safe: {errors:?}"
    );
}

/// A full vocabulary must still open a socket.
///
/// This is the failure the cap exists to prevent, and the only one that can
/// still take a take out entirely: the terms are URL parameters, so a
/// vocabulary large enough to blow a header limit is refused at the upgrade.
/// A script long enough to yield 100 distinct terms is entirely ordinary.
#[tokio::test]
async fn a_full_hundred_term_vocabulary_still_opens_a_session() {
    if std::env::var("GROK_API_KEY").is_err() {
        eprintln!("SKIP: GROK_API_KEY not set — live config check not run");
        return;
    }
    // Over the cap and over the length limit on purpose: what reaches the wire
    // is whatever `sanitised_keyterms` allows through, and this asserts the
    // service accepts exactly that.
    let mut keyterms: Vec<String> = (0..MAX_KEYTERMS + 40)
        .map(|i| format!("Keyterm Number {i}"))
        .collect();
    keyterms.push("x".repeat(80));

    let errors = errors_for(keyterms).await;
    assert!(
        errors.is_empty(),
        "a capped vocabulary was still refused — the cap or the encoding is wrong: {errors:?}"
    );
}
