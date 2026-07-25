//! Live `POST /v1/responses` coverage — every Luna operation CandidCue ships,
//! executed against the real `api.openai.com` with the app's OWN builders and
//! the app's OWN parsers/validators. Sibling of `live_openai.rs`, which covers
//! `GET /v1/models` and `POST /v1/realtime/client_secrets`.
//!
//! GATED — never runs in the normal suite. Both must hold:
//!   * `CANDIDCUE_LIVE_OPENAI=1`
//!   * `OPENAI_API_KEY` present in the environment (read only at runtime)
//! With either missing every test skips cleanly: no network, no cost, so
//! `cargo test` behaves exactly as before.
//!
//! Runner:
//!   CANDIDCUE_LIVE_OPENAI=1 cargo test --test live_openai_responses -- --nocapture
//!
//! Key hygiene: the key is read via `std::env::var`, wrapped in `SecretString`,
//! and sent only to `api.openai.com`. It is never printed, logged, or written —
//! including in failure messages, which carry only `AppError::code()` and the
//! provider's own schema-validation text, never a request header.
//!
//! ## The defect class this file exists to catch
//!
//! Strict Structured Outputs is a *server-side* contract. OpenAI requires,
//! recursively, `additionalProperties: false` on every object and EVERY
//! declared property listed in `required`, and it rejects `reasoning.effort`
//! values the target model does not implement. None of that is observable from
//! a unit test: a schema can be well-formed JSON Schema, satisfy every local
//! assertion, and still take a hard 400 from the live endpoint — at which point
//! the feature is not degraded, it is dead. Every assertion here therefore runs
//! a real request through the shipped builder and feeds the real response to
//! the shipped validator.
//!
//! Two findings this file pins permanently:
//!   * `reasoning.effort: "minimal"` is a 400 on the configured semantic model
//!     (`gpt-5.6-luna` accepts `none | low | medium | high | xhigh`). It used to
//!     sit in `ALLOWED_SEMANTIC_REASONING_EFFORTS`, so a caller preferring it
//!     would have killed every semantic call. `rejects_unsupported_reasoning_effort`
//!     asserts the API still rejects it and that the app can no longer emit it.
//!   * the §33.8 command schema authored in TypeScript lists 3 of its 8
//!     properties in `required`, which the API rejects outright.
//!     `normalize_strict_schema` is the only thing standing between that schema
//!     and a dead voice-command path — `normalize_strict_schema_is_load_bearing`
//!     proves the un-normalized form really is rejected AND that the normalized
//!     form really is accepted, in the same run.
//!
//! ## NOT covered here, deliberately
//!
//! `POST /v1/realtime/calls` (`src/control/services/realtime/webrtcTransport.ts`)
//! is the WebRTC SDP exchange. It requires a browser `RTCPeerConnection` to
//! produce a real SDP offer with a live audio track, and answers with SDP that
//! is only meaningful to that same peer connection. There is no honest way to
//! exercise it from a Rust integration test — a hand-rolled SDP string would
//! assert nothing about the code that ships. It stays uncovered here and is
//! reached only through the browser-driven E2E journey.

use std::time::Duration;

use candidcue_lib::openai::luna_ops::{
    self, LunaCommandRequest, VocabularyAnalysis, VocabularyRequest,
};
use candidcue_lib::openai::responses::{
    build_structured_body, build_tool_body, normalize_timeout_ms, StructuredRequestSpec,
    ALLOWED_SEMANTIC_REASONING_EFFORTS, DEFAULT_SEMANTIC_TIMEOUT_MS,
};
use candidcue_lib::openai::semantic::{
    self, SemanticAssistResult, SemanticClassificationRequest, SemanticLandmarkPreparationResult,
    SemanticLandmarkRetrievalResult, SemanticPreparationRequest, SemanticRequestOptions,
    SemanticRetrievalRequest,
};
use candidcue_lib::openai::{OpenAiClient, DEFAULT_COMMAND_MODEL, DEFAULT_SEMANTIC_MODEL};
use candidcue_lib::secrets::SecretString;
use serde_json::{json, Value};

/// Every live call is given a wide ceiling so a slow-but-correct response is a
/// pass, not a flake. This is NOT the production timeout — production uses
/// `timeout_for` / `DEFAULT_SEMANTIC_TIMEOUT_MS`, and
/// `production_default_budgets_are_sufficient` reports the real latency against
/// that budget rather than letting this generous value hide a regression.
const LIVE_TIMEOUT: Duration = Duration::from_secs(60);

/// Returns a live client + key iff this layer is opted-in AND a key is present.
/// `None` means "skip cleanly".
fn gate(test: &str) -> Option<(OpenAiClient, SecretString)> {
    let opted_in = std::env::var("CANDIDCUE_LIVE_OPENAI").ok().as_deref() == Some("1");
    let key = std::env::var("OPENAI_API_KEY").ok().filter(|k| k.trim().len() >= 20);
    match (opted_in, key) {
        (true, Some(key)) => Some((OpenAiClient::new(), SecretString::new(key))),
        _ => {
            println!(
                "[{test}] SKIP — set CANDIDCUE_LIVE_OPENAI=1 and OPENAI_API_KEY to run \
                 (no network, no cost when skipped)."
            );
            None
        }
    }
}

/// The §33.8 command function schema, verbatim from
/// `src/shared/commands/luna.ts`. It is authored in TypeScript and arrives over
/// IPC, so the test deserializes it the same way `interpret_command` does
/// rather than reconstructing it in Rust — a divergence between the two would
/// otherwise be invisible here, which is the whole point of testing it.
fn control_candidcue_schema() -> Value {
    json!({
        "name": "control_candidcue",
        "description": "Interpret a bounded teleprompter command.",
        "strict": true,
        "parameters": {
            "type": "object",
            "additionalProperties": false,
            "required": ["action", "confidence", "requires_confirmation"],
            "properties": {
                "action": { "type": "string", "enum": [
                    "start", "pause", "resume", "hard_pause", "stop",
                    "go_to_target", "next_section", "previous_section",
                    "move_relative", "restart_unit", "set_font_size",
                    "adjust_font_size", "set_margins", "toggle_mirror",
                    "blank_stage", "unblank_stage", "set_listener",
                    "adjust_reading_band", "set_scroll_mode", "unknown"
                ]},
                "target_type": { "type": ["string", "null"], "enum": [
                    "heading", "take", "sentence", "paragraph",
                    "beginning", "end", "phrase", null
                ]},
                "target_value": { "type": ["string", "null"] },
                "direction": { "type": ["string", "null"], "enum": [
                    "forward", "backward", "up", "down", null
                ]},
                "amount": { "type": ["number", "null"] },
                "unit": { "type": ["string", "null"], "enum": [
                    "sentence", "paragraph", "section", "percent", "point", null
                ]},
                "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
                "requires_confirmation": { "type": "boolean" }
            }
        }
    })
}

fn command_request() -> LunaCommandRequest {
    serde_json::from_value(json!({
        "candidateId": "live_cmd_1",
        "contextRevision": 12,
        // Deliberately NOT the repo's usual "take me back to the pricing close"
        // fixture. Against a target list whose only heading is labelled
        // "Pricing", the live model reads "the pricing close" as naming a
        // sub-part that does not exist and returns `unknown` — which is what
        // COMMAND_INSTRUCTION explicitly asks for, so it is correct behaviour
        // rather than a transport fault. Asserting on it would make this test a
        // referendum on prompt wording instead of on the API round-trip, so the
        // phrasing here is one that names a supplied target directly.
        "commandText": "take me back to pricing",
        "scrollMode": "voice",
        "position": { "blockId": "b1", "sentenceId": "s1", "tokenIndex": 40 },
        "nearbyTargets": [
            { "id": "t_pricing", "type": "heading", "label": "Pricing" },
            { "id": "t_demo", "type": "heading", "label": "Demo" }
        ],
        "outline": [{ "level": 1, "title": "Demo" }],
        "bounds": {},
        "schema": control_candidcue_schema(),
        "instruction": "Return unknown rather than inventing a result. \
                        Every navigation target must be one of the supplied ids."
    }))
    .expect("the §33.8 request envelope deserializes")
}

// ---------------------------------------------------------------------------
// 1. Command interpretation — the forced strict tool call (Appendix E.5)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn interpret_command_round_trips_a_real_function_call() {
    let Some((client, key)) = gate("interpret_command") else {
        return;
    };

    let request = command_request();
    // The shipped builder, including `normalize_strict_schema`.
    let spec = luna_ops::build_command_spec(DEFAULT_COMMAND_MODEL, &request);
    let body = build_tool_body(&spec);

    let (envelope, latency_ms) = client
        .execute_responses(&key, "interpret_command", "live_cmd_1", body, LIVE_TIMEOUT)
        .await
        .unwrap_or_else(|err| panic!("live tool call failed: code={}", err.code()));

    // The shipped parser, over the real response.
    let result = luna_ops::parse_command_result(&envelope, &spec.function_name)
        .unwrap_or_else(|err| panic!("parse_command_result rejected a real response: code={}", err.code()));

    println!(
        "[interpret_command] {latency_ms}ms action={} targetType={:?} targetValue={:?} confidence={:.2}",
        result.action, result.target_type, result.target_value, result.confidence
    );

    // Content sanity, not just shape: the model was asked to navigate to a
    // named heading, so the action must be a real member of the enum the
    // schema advertises — a schema that silently allowed free text would show
    // up here.
    let actions = spec.parameters["properties"]["action"]["enum"]
        .as_array()
        .expect("normalized parameters keep the action enum");
    assert!(
        actions.iter().any(|a| a == &json!(result.action)),
        "action `{}` is not a member of the schema's enum",
        result.action
    );
    assert!(
        (0.0..=1.0).contains(&result.confidence),
        "confidence {} outside the unit interval",
        result.confidence
    );
    // A navigation command must not come back as `unknown` for an unambiguous
    // phrase naming a target that IS in the list — that would mean the bounded
    // prompt built by `build_command_user_text` is not conveying the targets.
    assert_eq!(
        result.action, "go_to_target",
        "the model could not resolve an unambiguous command against a supplied target list"
    );
    // `mapLunaAction` in src/shared/commands/luna.ts accepts either the target
    // id or its label and resolves the label locally, so the contract this test
    // has to hold is "the value names a supplied target", not "the value is an
    // id". Anything else is the invented target §33.8 forbids.
    let target = result
        .target_value
        .as_deref()
        .expect("go_to_target must carry a target value");
    assert!(
        ["t_pricing", "Pricing"].contains(&target),
        "model returned target `{target}`, which is neither the id nor the label of a supplied target"
    );
}

/// `normalize_strict_schema` is not cosmetic. Proven both directions in one
/// run so neither half can rot into a vacuous pass.
#[tokio::test]
async fn normalize_strict_schema_is_load_bearing() {
    let Some((client, key)) = gate("normalize_strict_schema") else {
        return;
    };

    let request = command_request();
    let raw_parameters = request.schema.parameters.clone();
    let normalized = luna_ops::normalize_strict_schema(&raw_parameters);

    // --- the un-normalized schema must be REJECTED by the live API ---------
    let mut rejected_spec = luna_ops::build_command_spec(DEFAULT_COMMAND_MODEL, &request);
    rejected_spec.parameters = raw_parameters.clone();
    let rejection = client
        .execute_responses(
            &key,
            "interpret_command",
            "live_cmd_raw",
            build_tool_body(&rejected_spec),
            LIVE_TIMEOUT,
        )
        .await;
    let error = rejection
        .err()
        .expect("the API must reject a schema that omits 5 of 8 properties from `required`");
    println!(
        "[normalize_strict_schema] un-normalized §33.8 schema rejected as expected: code={}",
        error.code()
    );
    // A 400 maps to PROVIDER_UNAVAILABLE with the status attached; the point is
    // that it did not succeed, and that it is not an auth/quota failure that
    // would make this assertion pass for the wrong reason.
    assert!(
        !matches!(error.code(), "AUTH_KEY_INVALID" | "QUOTA_EXHAUSTED" | "RATE_LIMITED"),
        "rejection must come from schema validation, not from auth or quota: code={}",
        error.code()
    );

    // --- the normalized schema must be ACCEPTED ---------------------------
    let mut accepted_spec = luna_ops::build_command_spec(DEFAULT_COMMAND_MODEL, &request);
    accepted_spec.parameters = normalized.clone();
    let (envelope, _) = client
        .execute_responses(
            &key,
            "interpret_command",
            "live_cmd_normalized",
            build_tool_body(&accepted_spec),
            LIVE_TIMEOUT,
        )
        .await
        .unwrap_or_else(|err| {
            panic!("the NORMALIZED schema was also rejected: code={}", err.code())
        });
    assert!(
        luna_ops::parse_command_result(&envelope, &accepted_spec.function_name).is_ok(),
        "normalized schema produced a response the shipped parser cannot read"
    );

    // And the normalization really is what changed: every declared property is
    // now required, which is precisely what the API complained about.
    let declared = normalized["properties"].as_object().expect("properties survive");
    let required = normalized["required"].as_array().expect("required is populated");
    assert_eq!(
        declared.len(),
        required.len(),
        "strict mode requires every declared property to be listed in `required`"
    );
    assert_eq!(normalized["additionalProperties"], json!(false));
}

// ---------------------------------------------------------------------------
// 2. The four semantic structured operations (companion C.3/C.4)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn classification_round_trips_through_the_shipped_validator() {
    let Some((client, key)) = gate("classify") else {
        return;
    };

    let request: SemanticClassificationRequest = serde_json::from_value(json!({
        "requestId": "live_assist_1",
        "semanticEpoch": 7,
        "transcriptRevision": 993,
        "candidateSetHash": "7c32",
        "payload": {
            "requestId": "live_assist_1",
            "semanticEpoch": 7,
            "transcriptRevision": 993,
            "candidateSetHash": "7c32",
            "recentTranscript": "So today we're going to talk about what this actually costs.",
            "candidates": [
                { "candidateId": "cand_a", "text": "Today we'll talk about pricing.", "kind": "current" },
                { "candidateId": "cand_b", "text": "Let's look at the live demo.", "kind": "forward" }
            ]
        }
    }))
    .expect("classification request deserializes");

    // Production builder with the production default token budget.
    let spec = semantic::structured_spec(
        DEFAULT_SEMANTIC_MODEL,
        semantic::CLASSIFY_INSTRUCTION,
        "semantic_assist_result",
        semantic::classification_schema(),
        request.payload.clone(),
        &request.options,
        320,
    );
    let (envelope, latency_ms) = client
        .execute_responses(
            &key,
            "classify_semantic_tracking_window",
            &request.request_id,
            build_structured_body(&spec),
            LIVE_TIMEOUT,
        )
        .await
        .unwrap_or_else(|err| panic!("live classification failed: code={}", err.code()));

    let result: SemanticAssistResult = semantic::parse_structured(&envelope)
        .unwrap_or_else(|err| panic!("parse_structured rejected a real response: code={}", err.code()));
    semantic::validate_classification(&result, &request)
        .unwrap_or_else(|err| panic!("validate_classification rejected a real response: code={}", err.code()));

    println!(
        "[classify] {latency_ms}ms relation={:?} selected={:?} influence={} confidence={:.2}",
        result.relation, result.selected_candidate_id, result.should_influence_tracking, result.confidence
    );

    // Content sanity: the identity fields are echoed (already enforced by
    // `validate_classification`) and the model actually engaged with the
    // candidates rather than emitting a degenerate default.
    assert_eq!(result.request_id, "live_assist_1");
    if let Some(id) = result.selected_candidate_id.as_deref() {
        assert!(
            matches!(id, "cand_a" | "cand_b"),
            "model selected `{id}`, which was never supplied — it invented a location"
        );
    }
}

#[tokio::test]
async fn retrieval_round_trips_through_the_shipped_validator() {
    let Some((client, key)) = gate("retrieve") else {
        return;
    };

    let request: SemanticRetrievalRequest = serde_json::from_value(json!({
        "requestId": "live_retrieve_1",
        "semanticEpoch": 2,
        "transcriptRevision": 41,
        "landmarkSetHash": "lm7",
        "payload": {
            "requestId": "live_retrieve_1",
            "semanticEpoch": 2,
            "transcriptRevision": 41,
            "landmarkSetHash": "lm7",
            "recentSpeech": "so what it costs is forty nine dollars every month",
            "landmarks": [
                { "landmarkId": "lm_price", "proposition": "The plan costs $49 per month." },
                { "landmarkId": "lm_demo", "proposition": "A live demo of the editor follows." }
            ]
        }
    }))
    .expect("retrieval request deserializes");

    let spec = semantic::structured_spec(
        DEFAULT_SEMANTIC_MODEL,
        semantic::RETRIEVE_INSTRUCTION,
        "semantic_landmark_retrieval_result",
        semantic::retrieval_schema(),
        request.payload.clone(),
        &request.options,
        256,
    );
    let (envelope, latency_ms) = client
        .execute_responses(
            &key,
            "retrieve_semantic_landmarks",
            &request.request_id,
            build_structured_body(&spec),
            LIVE_TIMEOUT,
        )
        .await
        .unwrap_or_else(|err| panic!("live retrieval failed: code={}", err.code()));

    let result: SemanticLandmarkRetrievalResult = semantic::parse_structured(&envelope)
        .unwrap_or_else(|err| panic!("parse_structured rejected a real response: code={}", err.code()));
    semantic::validate_retrieval(&result, &request)
        .unwrap_or_else(|err| panic!("validate_retrieval rejected a real response: code={}", err.code()));

    println!(
        "[retrieve] {latency_ms}ms relation={:?} landmarks={:?} confidence={:.2}",
        result.relation, result.candidate_landmark_ids, result.confidence
    );

    // §37.3: the operation may only nominate landmark ids that were supplied.
    // An invented id would be a schema-legal response that must never happen.
    for id in &result.candidate_landmark_ids {
        assert!(
            matches!(id.as_str(), "lm_price" | "lm_demo"),
            "model nominated `{id}`, which was never supplied"
        );
    }
    // The speech is a near-verbatim restatement of `lm_price`; if the model
    // returns nothing at all the bounded payload is not reaching it.
    assert!(
        result.candidate_landmark_ids.iter().any(|id| id == "lm_price"),
        "expected the $49/month landmark to be nominated for near-verbatim speech, got {:?}",
        result.candidate_landmark_ids
    );
}

#[tokio::test]
async fn preparation_round_trips_through_the_shipped_validator() {
    let Some((client, key)) = gate("prepare") else {
        return;
    };

    let request: SemanticPreparationRequest = serde_json::from_value(json!({
        "requestId": "live_prepare_1",
        "scriptCompileHash": "sc_live_1",
        "sectionId": "section_pricing",
        "payload": {
            "requestId": "live_prepare_1",
            "scriptCompileHash": "sc_live_1",
            "sectionId": "section_pricing",
            "spans": [
                { "spanId": "span_1", "text": "We raised the price to $49 a month in March." },
                { "spanId": "span_2", "text": "No existing customer pays more than they did last year." }
            ]
        }
    }))
    .expect("preparation request deserializes");

    let spec = semantic::structured_spec(
        DEFAULT_SEMANTIC_MODEL,
        semantic::PREPARE_INSTRUCTION,
        "semantic_landmark_preparation_result",
        semantic::preparation_schema(),
        request.payload.clone(),
        &request.options,
        4_096,
    );
    let (envelope, latency_ms) = client
        .execute_responses(
            &key,
            "prepare_semantic_landmarks",
            &request.request_id,
            build_structured_body(&spec),
            LIVE_TIMEOUT,
        )
        .await
        .unwrap_or_else(|err| panic!("live preparation failed: code={}", err.code()));

    let result: SemanticLandmarkPreparationResult = semantic::parse_structured(&envelope)
        .unwrap_or_else(|err| panic!("parse_structured rejected a real response: code={}", err.code()));
    semantic::validate_preparation(&result, &request)
        .unwrap_or_else(|err| panic!("validate_preparation rejected a real response: code={}", err.code()));

    println!(
        "[prepare] {latency_ms}ms annotations={} first={:?}",
        result.annotations.len(),
        result.annotations.first().map(|a| a.proposition.as_str())
    );

    // The preparation schema is the only one with a nested object inside an
    // array (`criticalTerms`), so an empty result would leave the deepest part
    // of the strict-schema contract untested.
    assert!(
        !result.annotations.is_empty(),
        "preparation returned no annotations for two supplied spans"
    );
    for annotation in &result.annotations {
        assert!(
            matches!(annotation.span_id.as_str(), "span_1" | "span_2"),
            "model annotated `{}`, an id that was never supplied",
            annotation.span_id
        );
        assert!(!annotation.proposition.is_empty());
    }
    // `span_1` carries a number, a currency amount and a date; the deepest
    // nested object in any shipped schema must actually be populated.
    let span_1 = result
        .annotations
        .iter()
        .find(|a| a.span_id == "span_1")
        .expect("span_1 annotated");
    assert!(
        !span_1.critical_terms.is_empty(),
        "no critical terms extracted from a span containing a price and a date — \
         the nested `criticalTerms` object never round-tripped"
    );
}

#[tokio::test]
async fn coaching_decision_round_trips_against_the_strict_schema() {
    let Some((client, key)) = gate("coach") else {
        return;
    };

    // The coaching path parses into an opaque `Value` in Rust (the TypeScript
    // observer re-validates), so the strict schema is the ONLY gate on this
    // call — which makes a live check of it the only check there is.
    let payload = json!({
        "requestId": "live_coach_1",
        "recentSpeech": "um so um the the pricing is um it's forty nine",
        "metrics": { "wpm": 118, "fillerCount": 4, "windowMs": 6000 },
        "candidates": [
            { "evidenceId": "ev_1", "tipCode": "REPEATED_FILLER", "detail": "4 fillers in 6s" }
        ]
    });
    let options = SemanticRequestOptions::default();
    let spec = semantic::structured_spec(
        DEFAULT_SEMANTIC_MODEL,
        semantic::COACH_INSTRUCTION,
        "coach_decision",
        semantic::coaching_decision_schema(),
        payload,
        &options,
        256,
    );
    let (envelope, latency_ms) = client
        .execute_responses(
            &key,
            "classify_coaching_window",
            "live_coach_1",
            build_structured_body(&spec),
            LIVE_TIMEOUT,
        )
        .await
        .unwrap_or_else(|err| panic!("live coaching call failed: code={}", err.code()));

    let decision: Value = semantic::parse_structured(&envelope)
        .unwrap_or_else(|err| panic!("parse_structured rejected a real response: code={}", err.code()));

    println!(
        "[coach] {latency_ms}ms decision={} tip={} reason={} evidence={}",
        decision["decision"], decision["tip_code"], decision["reason_code"], decision["evidence_ids"]
    );

    // Every required key must be present and inside its declared enum — the
    // schema promised it and nothing else on the Rust side checks.
    let schema = semantic::coaching_decision_schema();
    for required in schema["required"].as_array().expect("required list") {
        let field = required.as_str().expect("field name");
        let value = decision
            .get(field)
            .unwrap_or_else(|| panic!("strict response is missing required field `{field}`"));
        if let Some(allowed) = schema["properties"][field]["enum"].as_array() {
            assert!(
                allowed.contains(value),
                "field `{field}` came back as {value}, outside its declared enum"
            );
        }
    }
    // §23: an evidence id may only ever be one the caller supplied.
    for id in decision["evidence_ids"].as_array().expect("evidence_ids is an array") {
        assert_eq!(id, &json!("ev_1"), "model cited an evidence id it was never given");
    }
}

// ---------------------------------------------------------------------------
// 3. Vocabulary extraction (Appendix E.6)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn vocabulary_analysis_round_trips_through_the_shipped_validator() {
    let Some((client, key)) = gate("vocabulary") else {
        return;
    };

    let request: VocabularyRequest = serde_json::from_value(json!({
        "language": "en",
        "candidates": [
            { "surface": "CandidCue", "contexts": ["CandidCue follows your voice while you present."] },
            { "surface": "SLO", "contexts": ["We hold a 99.9% SLO on the stage window."] },
            { "surface": "the", "contexts": ["the price is right"] }
        ],
        "existingDictionary": []
    }))
    .expect("vocabulary request deserializes");

    let payload = luna_ops::build_vocabulary_payload(&request);
    let spec = semantic::structured_spec(
        DEFAULT_SEMANTIC_MODEL,
        luna_ops::VOCABULARY_INSTRUCTION,
        "vocabulary_analysis",
        luna_ops::vocabulary_schema(),
        payload,
        &request.options,
        4_096,
    );
    let (envelope, latency_ms) = client
        .execute_responses(
            &key,
            "analyze_vocabulary",
            "live_vocab_1",
            build_structured_body(&spec),
            LIVE_TIMEOUT,
        )
        .await
        .unwrap_or_else(|err| panic!("live vocabulary call failed: code={}", err.code()));

    let analysis: VocabularyAnalysis = semantic::parse_structured(&envelope)
        .unwrap_or_else(|err| panic!("parse_structured rejected a real response: code={}", err.code()));
    let validated = luna_ops::validate_vocabulary(analysis, &request)
        .unwrap_or_else(|err| panic!("validate_vocabulary rejected a real response: code={}", err.code()));

    println!(
        "[vocabulary] {latency_ms}ms terms={:?}",
        validated
            .terms
            .iter()
            .map(|t| (t.surface.as_str(), t.category.as_str(), t.importance))
            .collect::<Vec<_>>()
    );

    // The whole point of the operation: it must find the unusual terms and it
    // must not invent surfaces. `validate_vocabulary` silently DISCARDS
    // invented surfaces, so a test that only checked "no unknown surface
    // survived" would pass even if the model returned nothing but garbage.
    assert!(
        !validated.terms.is_empty(),
        "no vocabulary terms survived validation for an obviously unusual candidate set"
    );
    assert!(
        validated.terms.iter().any(|t| t.surface == "CandidCue"),
        "a brand name in the candidate list was not identified, got {:?}",
        validated.terms.iter().map(|t| &t.surface).collect::<Vec<_>>()
    );
    for term in &validated.terms {
        assert!((0.0..=1.0).contains(&term.importance));
        assert!(!term.canonical_spoken.is_empty());
    }
}

// ---------------------------------------------------------------------------
// 4. Request-parameter policy against the live model
// ---------------------------------------------------------------------------

/// Every effort in `ALLOWED_SEMANTIC_REASONING_EFFORTS` must be one the model
/// actually implements, and the one that is NOT (`minimal`) must still be
/// rejected — so the constant can never quietly grow it back.
#[tokio::test]
async fn rejects_unsupported_reasoning_effort() {
    let Some((client, key)) = gate("reasoning_effort") else {
        return;
    };

    let probe = |effort: &str| StructuredRequestSpec {
        model: DEFAULT_SEMANTIC_MODEL.to_string(),
        instructions: "Reply with the required structured result.".to_string(),
        schema_name: "effort_probe".to_string(),
        schema: json!({
            "type": "object",
            "additionalProperties": false,
            "properties": { "ok": { "type": "boolean" } },
            "required": ["ok"]
        }),
        stable_context: None,
        dynamic_payload: json!({ "reply": "set ok to true" }),
        reasoning_effort: effort.to_string(),
        max_output_tokens: 64,
        prompt_cache_key: None,
    };

    for effort in ALLOWED_SEMANTIC_REASONING_EFFORTS {
        let outcome = client
            .execute_responses(
                &key,
                "classify_semantic_tracking_window",
                &format!("live_effort_{effort}"),
                build_structured_body(&probe(effort)),
                LIVE_TIMEOUT,
            )
            .await;
        let (envelope, latency_ms) = outcome.unwrap_or_else(|err| {
            panic!(
                "ALLOWED_SEMANTIC_REASONING_EFFORTS advertises `{effort}` but the live model \
                 rejected it: code={} — every semantic call using it would fail",
                err.code()
            )
        });
        let value: Value = semantic::parse_structured(&envelope)
            .unwrap_or_else(|err| panic!("effort `{effort}` produced an unparseable result: code={}", err.code()));
        println!("[effort] `{effort}` accepted in {latency_ms}ms -> {value}");
        assert!(value.get("ok").is_some());
    }

    // The regression the constant was fixed for. Sent explicitly — the app can
    // no longer emit it, so this is the only way to keep the finding pinned.
    let mut unsupported = probe("low");
    unsupported.reasoning_effort = "minimal".to_string();
    let error = client
        .execute_responses(
            &key,
            "classify_semantic_tracking_window",
            "live_effort_minimal",
            build_structured_body(&unsupported),
            LIVE_TIMEOUT,
        )
        .await
        .err()
        .expect(
            "`minimal` is expected to remain unsupported on the configured model; if the provider \
             has started accepting it, re-evaluate ALLOWED_SEMANTIC_REASONING_EFFORTS",
        );
    println!("[effort] `minimal` rejected by the live model as expected: code={}", error.code());
    assert!(
        !matches!(error.code(), "AUTH_KEY_INVALID" | "QUOTA_EXHAUSTED" | "RATE_LIMITED"),
        "rejection must come from parameter validation, not auth or quota: code={}",
        error.code()
    );
    assert!(
        !ALLOWED_SEMANTIC_REASONING_EFFORTS.contains(&"minimal"),
        "the app must not be able to emit an effort the live model rejects"
    );
}

/// The shipped defaults have to be usable, not merely well-formed: reasoning
/// tokens count against `max_output_tokens`, so a budget that is too small
/// turns every call into `status: incomplete` — which `execute_responses`
/// converts to an error and the caller discards. And a request slower than
/// `DEFAULT_SEMANTIC_TIMEOUT_MS` is cancelled before it can be used.
#[tokio::test]
async fn production_default_budgets_are_sufficient() {
    let Some((client, key)) = gate("default_budgets") else {
        return;
    };

    let payload = json!({
        "requestId": "live_budget_1",
        "semanticEpoch": 0,
        "transcriptRevision": 5,
        "candidateSetHash": "bh",
        "recentTranscript": "So today we're going to talk about what this actually costs.",
        "candidates": [
            { "candidateId": "cand_a", "text": "Today we'll talk about pricing.", "kind": "current" },
            { "candidateId": "cand_b", "text": "Let's look at the live demo.", "kind": "forward" }
        ]
    });
    let request: SemanticClassificationRequest = serde_json::from_value(json!({
        "requestId": "live_budget_1",
        "semanticEpoch": 0,
        "transcriptRevision": 5,
        "candidateSetHash": "bh",
        "payload": payload
    }))
    .expect("request deserializes");

    // Exactly what `classify_semantic_tracking_window` builds, including the
    // 320-token default and the clamped `low` effort.
    let spec = semantic::structured_spec(
        DEFAULT_SEMANTIC_MODEL,
        semantic::CLASSIFY_INSTRUCTION,
        "semantic_assist_result",
        semantic::classification_schema(),
        request.payload.clone(),
        &request.options,
        320,
    );
    assert_eq!(spec.max_output_tokens, 320, "default token budget changed");
    assert_eq!(spec.reasoning_effort, "low", "default effort changed");

    let (envelope, latency_ms) = client
        .execute_responses(
            &key,
            "classify_semantic_tracking_window",
            &request.request_id,
            build_structured_body(&spec),
            LIVE_TIMEOUT,
        )
        .await
        .unwrap_or_else(|err| {
            panic!(
                "the SHIPPED default budget produced a failure: code={} — if this is \
                 `incomplete:max_output_tokens`, 320 tokens is not enough for a `low`-effort \
                 reasoning call and every production classification is being discarded",
                err.code()
            )
        });

    // `execute_responses` already rejects `incomplete`, so reaching here proves
    // the budget held. Parse anyway: the budget is only "sufficient" if the
    // answer is usable.
    let result: SemanticAssistResult = semantic::parse_structured(&envelope)
        .unwrap_or_else(|err| panic!("default-budget response was unparseable: code={}", err.code()));
    semantic::validate_classification(&result, &request).expect("default-budget response validates");

    let usage = candidcue_lib::openai::responses::extract_usage(&envelope);
    let budget = normalize_timeout_ms(None);
    println!(
        "[budgets] {latency_ms}ms (production timeout budget {budget}ms / \
         DEFAULT_SEMANTIC_TIMEOUT_MS {DEFAULT_SEMANTIC_TIMEOUT_MS}ms) \
         outputTokens={} reasoningTokens={} of max {}",
        usage.output_tokens, usage.reasoning_tokens, spec.max_output_tokens
    );

    assert_eq!(budget, DEFAULT_SEMANTIC_TIMEOUT_MS);
    assert!(
        usage.output_tokens > 0,
        "usage was not reported, so the cost accounting in §42.2 has nothing to work with"
    );
    assert!(
        (usage.output_tokens as u32) < spec.max_output_tokens,
        "a minimal classification used {} of its {} token budget — the production default has no \
         headroom and a slightly longer answer will come back `incomplete`",
        usage.output_tokens,
        spec.max_output_tokens
    );
    // Reported, not asserted: real-world latency varies with provider load, and
    // a slow afternoon must not turn the build red. A number consistently above
    // the budget is a genuine finding to act on, though.
    if latency_ms > DEFAULT_SEMANTIC_TIMEOUT_MS {
        println!(
            "[budgets] WARNING: {latency_ms}ms exceeded the {DEFAULT_SEMANTIC_TIMEOUT_MS}ms \
             production timeout — a live session would have cancelled this request."
        );
    }
}
