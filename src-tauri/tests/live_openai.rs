//! Live OpenAI smoke test — the first time CandidCue's OpenAI integration runs
//! against the real `api.openai.com`. This exercises the ACTUAL production code
//! (`candidcue_lib::openai::OpenAiClient`), not a reimplementation, so a passing
//! run proves the real request/response plumbing, not a fixture's.
//!
//! GATED — never runs in the normal suite. Both must hold:
//!   * `CANDIDCUE_LIVE_OPENAI=1`
//!   * `OPENAI_API_KEY` present in the environment (read only at runtime)
//! With either missing, the single test skips cleanly (no network, no cost),
//! so `cargo test` behaves exactly as before.
//!
//! Runner:
//!   CANDIDCUE_LIVE_OPENAI=1 cargo test --test live_openai -- --nocapture
//!
//! Key hygiene: the key is read via `std::env::var`, wrapped in `SecretString`,
//! and sent only to `api.openai.com`. It is never printed, logged, or written.
//!
//! What is covered, in order (a handful of calls, a few cents at most):
//!   1. Key validation via the real `validate_key` path (`GET /v1/models`).
//!   2. Ephemeral credential mint (`POST /v1/realtime/client_secrets`) — the
//!      release-blocker path. The highest-value assertion is that
//!      `expires_at_epoch_ms` is a *millisecond* timestamp in the future, the
//!      exact invariant the seconds-vs-ms bug violated.
//!   3. One structured `/v1/responses` call round-tripped through the real
//!      `parse_structured`.
//!
//! The app's configured models (`gpt-realtime-whisper`, `gpt-5.6-luna`) were
//! once treated as unreleased: their presence was reported, never asserted, so
//! that a missing future model could not turn the build red. Both now resolve
//! on the live `/v1/models` list, so that hedge has become a way for the suite
//! to pass while the app is unusable — if the configured transcription model
//! disappeared, every session would fail to start and this file would still be
//! green. Their presence is therefore ASSERTED now, and the credential mint runs
//! against the CONFIGURED model rather than a discovered stand-in, so what the
//! test proves is what the app actually does.
//!
//! `POST /v1/responses` is covered in depth by the sibling
//! `live_openai_responses.rs`; the single structured call kept here is a
//! smoke check that the three endpoints work together in one run.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use candidcue_lib::openai::{
    OpenAiClient, TranscriptionCredentialConfig, API_BASE_URL, DEFAULT_COMMAND_MODEL,
    DEFAULT_SEMANTIC_MODEL, DEFAULT_TRANSCRIPTION_MODEL,
};
use candidcue_lib::openai::responses::{build_structured_body, StructuredRequestSpec};
use candidcue_lib::openai::semantic::{
    classification_schema, parse_structured, SemanticAssistResult, CLASSIFY_INSTRUCTION,
};
use candidcue_lib::secrets::SecretString;
use serde_json::json;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock is after the epoch")
        .as_millis() as i64
}

/// Returns the API key iff this layer is opted-in AND a key is present.
/// `None` means "skip cleanly".
fn gate() -> Option<String> {
    if std::env::var("CANDIDCUE_LIVE_OPENAI").ok().as_deref() != Some("1") {
        return None;
    }
    match std::env::var("OPENAI_API_KEY") {
        Ok(key) if key.trim().len() >= 20 => Some(key),
        _ => None,
    }
}

/// Raw `GET /v1/models`, used only for model discovery + reporting (the model
/// list `validate_key` inspects but does not expose). Uses the production HTTP
/// client. Returns the set of available model ids, or empty on any failure.
async fn list_model_ids(http: &reqwest::Client, key: &SecretString) -> Vec<String> {
    let response = http
        .get(format!("{API_BASE_URL}/models"))
        .bearer_auth(key.expose())
        .send()
        .await;
    let Ok(response) = response else {
        return Vec::new();
    };
    if !response.status().is_success() {
        return Vec::new();
    }
    let body: serde_json::Value = response.json().await.unwrap_or_else(|_| json!({}));
    body["data"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|m| m["id"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn live_openai_smoke() {
    let Some(key_raw) = gate() else {
        println!(
            "\n[live_openai] SKIP — set CANDIDCUE_LIVE_OPENAI=1 and OPENAI_API_KEY to run \
             (no network, no cost when skipped)."
        );
        return;
    };

    let key = SecretString::new(key_raw);
    // The true production constructor: base_url = https://api.openai.com/v1.
    let client = OpenAiClient::new();

    println!("\n================ CandidCue live OpenAI smoke test ================");

    // --- Phase 1: key validation (real production path) -------------------
    let validation = client.validate_key(&key).await;
    let key_accepted = validation.status.starts_with("valid");
    println!(
        "[1] validate_key         status={} realtimeModelAvailable={} commandModelAvailable={}",
        validation.status, validation.realtime_model_available, validation.command_model_available
    );
    if let Some(message) = &validation.message {
        println!("    message: {message}");
    }

    // Configured-model resolution.
    let available = list_model_ids(client.http(), &key).await;
    println!("    live /v1/models returned {} model ids", available.len());
    let resolves = |id: &str| available.iter().any(|m| m == id);
    println!("    configured-model resolution against the live list:");
    for (label, id) in [
        ("transcription (DEFAULT_TRANSCRIPTION_MODEL)", DEFAULT_TRANSCRIPTION_MODEL),
        ("command       (DEFAULT_COMMAND_MODEL)", DEFAULT_COMMAND_MODEL),
        ("semantic      (DEFAULT_SEMANTIC_MODEL)", DEFAULT_SEMANTIC_MODEL),
    ] {
        println!(
            "      {:<44} {:<22} -> {}",
            label,
            id,
            if resolves(id) { "PRESENT" } else { "ABSENT" }
        );
    }

    // --- Phase 2: ephemeral credential mint (release-blocker path) --------
    // Against the CONFIGURED model: a stand-in would prove the plumbing while
    // leaving the model the app actually ships entirely unexercised.
    let mint_model = DEFAULT_TRANSCRIPTION_MODEL;
    println!("[2] mint credential      using configured realtime model `{mint_model}`");

    let before_ms = now_ms();
    let mint = client
        .create_transcription_credential(
            &key,
            TranscriptionCredentialConfig {
                model: Some(mint_model.to_string()),
                language: Some("en".to_string()),
                delay: None,
                expires_seconds: Some(600),
                // Keep the mint minimal and model-agnostic for the smoke test.
                request_logprobs: Some(false),
            },
        )
        .await;
    let after_ms = now_ms();

    let credential = match mint {
        Ok(cred) => {
            let delta_ms = cred.expires_at_epoch_ms - after_ms;
            println!(
                "    mint OK  value.len={} sessionType={} generation={}",
                cred.value.len(),
                cred.session_type,
                cred.credential_generation
            );
            println!(
                "    expires_at_epoch_ms={} (now≈{}, delta={} ms ≈ {} s in the future)",
                cred.expires_at_epoch_ms,
                after_ms,
                delta_ms,
                delta_ms / 1000
            );
            Some(cred)
        }
        Err(err) => {
            println!("    mint FAILED code={} against the configured model", err.code());
            None
        }
    };

    // --- Phase 3: one structured /v1/responses call -----------------------
    // Also the configured model. Every other structured operation is covered in
    // `live_openai_responses.rs`.
    let responses_model = DEFAULT_SEMANTIC_MODEL;
    println!("[3] structured /responses using configured semantic model `{responses_model}`");

    // Tiny, bounded classification payload; the strict schema forces the model
    // to emit every field, and the real `parse_structured` must accept it.
    let payload = json!({
        "recentTranscript": "So today we're going to talk about pricing.",
        "candidates": [
            { "candidateId": "cand_a", "text": "Today we'll talk about pricing." },
            { "candidateId": "cand_b", "text": "Let's look at the live demo." }
        ],
        "requestId": "live_smoke_1",
        "semanticEpoch": 0,
        "transcriptRevision": 0,
        "candidateSetHash": "live"
    });
    let spec = StructuredRequestSpec {
        model: responses_model.to_string(),
        instructions: CLASSIFY_INSTRUCTION.to_string(),
        schema_name: "semantic_assist_result".to_string(),
        schema: classification_schema(),
        stable_context: None,
        dynamic_payload: payload,
        reasoning_effort: "low".to_string(),
        // Generous so reasoning tokens don't force `status: incomplete`.
        max_output_tokens: 2_000,
        prompt_cache_key: None,
    };
    let body = build_structured_body(&spec);
    let structured = client
        .execute_responses(
            &key,
            "classify_semantic_tracking_window",
            "live_smoke_1",
            body,
            Duration::from_secs(30),
        )
        .await;

    let structured_ok = match &structured {
        Ok((envelope, latency_ms)) => {
            match parse_structured::<SemanticAssistResult>(envelope) {
                Ok(result) => {
                    println!(
                        "    /responses OK latency={latency_ms}ms — parse_structured accepted: \
                         relation={:?} confidence={:.2} shouldInfluenceTracking={}",
                        result.relation, result.confidence, result.should_influence_tracking
                    );
                    true
                }
                Err(err) => {
                    println!(
                        "    /responses returned but parse_structured REJECTED it: code={}",
                        err.code()
                    );
                    false
                }
            }
        }
        Err(err) => {
            println!("    /responses FAILED code={} against the configured model", err.code());
            false
        }
    };

    // --- Human-readable summary ------------------------------------------
    println!("\n---------------------------- SUMMARY ----------------------------");
    println!("  key valid ................. {}", if key_accepted { "YES" } else { "NO" });
    println!(
        "  configured models resolve . transcription={} command={} semantic={}",
        resolves(DEFAULT_TRANSCRIPTION_MODEL),
        resolves(DEFAULT_COMMAND_MODEL),
        resolves(DEFAULT_SEMANTIC_MODEL)
    );
    match &credential {
        Some(cred) => println!(
            "  credential mint ........... OK (model `{mint_model}`, expiry delta {} ms)",
            cred.expires_at_epoch_ms - after_ms
        ),
        None => println!("  credential mint ........... FAILED (model `{mint_model}`, see above)"),
    }
    println!(
        "  structured /responses ..... {} (model `{responses_model}`)",
        if structured_ok { "OK" } else { "FAILED" }
    );
    println!("=================================================================\n");

    // --- Assertions -------------------------------------------------------
    // Phase 1: the key itself must be accepted.
    assert!(
        key_accepted,
        "OPENAI_API_KEY was not accepted (status={}); expected a `valid*` status",
        validation.status
    );

    // Every configured model must actually exist. `validate_key` folds this
    // into its status string, so without an explicit check a retired model
    // would leave this test green while no session could start.
    for (label, id) in [
        ("DEFAULT_TRANSCRIPTION_MODEL", DEFAULT_TRANSCRIPTION_MODEL),
        ("DEFAULT_COMMAND_MODEL", DEFAULT_COMMAND_MODEL),
        ("DEFAULT_SEMANTIC_MODEL", DEFAULT_SEMANTIC_MODEL),
    ] {
        assert!(
            resolves(id),
            "{label} is `{id}`, which the live /v1/models list does not contain — the app is \
             configured against a model this account cannot use"
        );
    }

    // …and `validate_key` must agree, since that verdict is what gates the
    // Settings screen.
    assert_eq!(
        validation.status, "valid_ready",
        "with every configured model present, validate_key must report `valid_ready`"
    );
    assert!(validation.realtime_model_available && validation.command_model_available);

    // Phase 2: THE highest-value assertion — the release-blocker invariant.
    let cred = credential.expect("credential mint must succeed for the smoke test to be meaningful");
    assert!(!cred.value.is_empty(), "minted client secret must be non-empty");
    // `expires_at_epoch_ms` must be a millisecond timestamp in the future:
    // strictly after 'now', and within 24h (a seconds value forwarded as-is
    // would land ~50 years in the PAST — the exact bug this guards).
    assert!(
        cred.expires_at_epoch_ms > before_ms,
        "expires_at_epoch_ms ({}) must be in the future (> {}); a raw seconds value would be far in the past",
        cred.expires_at_epoch_ms,
        before_ms
    );
    assert!(
        cred.expires_at_epoch_ms < before_ms + 24 * 60 * 60 * 1000,
        "expires_at_epoch_ms ({}) must be within 24h of now ({}); a double-scaled ms value would be absurdly far out",
        cred.expires_at_epoch_ms,
        before_ms
    );

    // Phase 3: the strict schema must round-trip through the real parser.
    assert!(
        structured_ok,
        "structured /v1/responses call did not round-trip through parse_structured (model `{responses_model}`)"
    );
}
