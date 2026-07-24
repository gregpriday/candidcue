//! OpenAI Responses API transport for Luna operations.
//!
//! Companion spec §38 (API request policy), §41 (prompt caching and request
//! construction), §57 (data handling); primary Appendix E.5/E.6.
//!
//! Hard rules enforced here:
//!
//! * every request carries `store: false` — nothing is retained server side;
//! * **no request body is ever logged** (see [`redacted_request_log`], and the
//!   `no_request_body_is_logged` / `log_call_sites_never_reference_bodies`
//!   tests below);
//! * requests are bounded by an explicit per-call timeout and may be cancelled
//!   by request id through the in-flight registry;
//! * usage and prompt-cache metadata are extracted for local cost estimates.
//!
//! Wire shape verified against the current Responses API (2026-07-24):
//! structured outputs use `text.format = { type: "json_schema", name, strict,
//! schema }`, reasoning effort uses `reasoning.effort`, prompt caching is
//! automatic over stable prefixes and steered with `prompt_cache_key`, and
//! usage reports `input_tokens_details.cached_tokens`.

use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

use crate::errors::{AppError, ErrorCategory, RecoveryAction};
use crate::secrets::SecretString;

use super::{map_provider_status, map_transport_error, read_capped, OpenAiClient};

/// Default per-request timeout. Short enough that a late result would already
/// be stale for tracking (companion A.4 "Timeout").
pub const DEFAULT_SEMANTIC_TIMEOUT_MS: u64 = 2_500;
/// Upper bound accepted from the frontend for any Luna operation.
pub const MAX_SEMANTIC_TIMEOUT_MS: u64 = 30_000;

/// Reasoning efforts the semantic sidecar is allowed to request (companion
/// §38.1: start at `low`, evaluate lower settings; never medium/high for
/// continuous tracking classification).
pub const ALLOWED_SEMANTIC_REASONING_EFFORTS: [&str; 3] = ["none", "minimal", "low"];

// ---------------------------------------------------------------------------
// Usage / cache metadata
// ---------------------------------------------------------------------------

/// Token usage for one Luna call (companion §71 metrics, §42.2 budget).
#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LunaUsage {
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_tokens: u64,
    pub total_tokens: u64,
}

/// Prompt-cache metadata surfaced for local diagnostics (companion §41).
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PromptCacheMetadata {
    pub cached_input_tokens: u64,
    pub cache_hit: bool,
    /// `cached_input_tokens / input_tokens`, `0.0` when there was no input.
    pub cache_hit_ratio: f64,
    pub prompt_cache_key: Option<String>,
}

impl PromptCacheMetadata {
    pub fn from_usage(usage: &LunaUsage, prompt_cache_key: Option<String>) -> Self {
        let ratio = if usage.input_tokens == 0 {
            0.0
        } else {
            usage.cached_input_tokens as f64 / usage.input_tokens as f64
        };
        Self {
            cached_input_tokens: usage.cached_input_tokens,
            cache_hit: usage.cached_input_tokens > 0,
            cache_hit_ratio: ratio,
            prompt_cache_key,
        }
    }
}

// ---------------------------------------------------------------------------
// Request construction (companion §41)
// ---------------------------------------------------------------------------

/// A strict Structured-Outputs request.
///
/// Field order matters for prompt caching: the stable instruction and schema
/// come first, an optional stable section context second, and the dynamic,
/// candidate-bounded payload last (companion §41).
#[derive(Debug, Clone)]
pub struct StructuredRequestSpec {
    pub model: String,
    /// Stable instruction prefix. Static text only — never transcript.
    pub instructions: String,
    pub schema_name: String,
    pub schema: Value,
    /// Optional stable per-section context, placed before the dynamic payload.
    pub stable_context: Option<String>,
    /// Dynamic bounded payload; always the final input message.
    pub dynamic_payload: Value,
    pub reasoning_effort: String,
    pub max_output_tokens: u32,
    pub prompt_cache_key: Option<String>,
}

/// Build the `POST /v1/responses` body for a strict structured-output call.
pub fn build_structured_body(spec: &StructuredRequestSpec) -> Value {
    let mut input = Vec::with_capacity(2);
    if let Some(context) = spec.stable_context.as_ref() {
        input.push(json!({
            "role": "developer",
            "content": [{ "type": "input_text", "text": context }],
        }));
    }
    input.push(json!({
        "role": "user",
        "content": [{ "type": "input_text", "text": spec.dynamic_payload.to_string() }],
    }));

    let mut body = json!({
        "model": spec.model,
        // §57.2 / primary §33.12: never retained by the provider.
        "store": false,
        "instructions": spec.instructions,
        "input": input,
        "text": {
            "format": {
                "type": "json_schema",
                "name": spec.schema_name,
                "strict": true,
                "schema": spec.schema,
            }
        },
        "reasoning": { "effort": spec.reasoning_effort },
        "max_output_tokens": spec.max_output_tokens,
    });
    if let Some(key) = spec.prompt_cache_key.as_ref() {
        body["prompt_cache_key"] = json!(key);
    }
    body
}

/// A strict function-calling request (primary Appendix E.5).
#[derive(Debug, Clone)]
pub struct ToolRequestSpec {
    pub model: String,
    pub instructions: String,
    pub user_text: String,
    pub function_name: String,
    pub function_description: String,
    pub parameters: Value,
    pub reasoning_effort: String,
    pub max_output_tokens: u32,
    pub prompt_cache_key: Option<String>,
}

/// Build the `POST /v1/responses` body for a single bounded tool call.
pub fn build_tool_body(spec: &ToolRequestSpec) -> Value {
    let mut body = json!({
        "model": spec.model,
        "store": false,
        "instructions": spec.instructions,
        "input": [{
            "role": "user",
            "content": [{ "type": "input_text", "text": spec.user_text }],
        }],
        "tools": [{
            "type": "function",
            "name": spec.function_name,
            "description": spec.function_description,
            "strict": true,
            "parameters": spec.parameters,
        }],
        "tool_choice": { "type": "function", "name": spec.function_name },
        "parallel_tool_calls": false,
        "reasoning": { "effort": spec.reasoning_effort },
        "max_output_tokens": spec.max_output_tokens,
    });
    if let Some(key) = spec.prompt_cache_key.as_ref() {
        body["prompt_cache_key"] = json!(key);
    }
    body
}

/// Clamp a caller-supplied reasoning effort to the allowed classification set.
pub fn normalize_reasoning_effort(requested: Option<&str>) -> String {
    match requested {
        Some(value) if ALLOWED_SEMANTIC_REASONING_EFFORTS.contains(&value) => value.to_string(),
        _ => "low".to_string(),
    }
}

/// Clamp a caller-supplied timeout into the permitted band.
pub fn normalize_timeout_ms(requested: Option<u64>) -> u64 {
    requested
        .unwrap_or(DEFAULT_SEMANTIC_TIMEOUT_MS)
        .clamp(250, MAX_SEMANTIC_TIMEOUT_MS)
}

// ---------------------------------------------------------------------------
// Response accessors
// ---------------------------------------------------------------------------

pub fn response_status(envelope: &Value) -> &str {
    envelope.get("status").and_then(Value::as_str).unwrap_or("")
}

pub fn incomplete_reason(envelope: &Value) -> Option<&str> {
    envelope
        .get("incomplete_details")
        .and_then(|d| d.get("reason"))
        .and_then(Value::as_str)
}

/// Extract the assistant's `output_text`, preferring the convenience field and
/// falling back to walking the typed `output` array.
pub fn extract_output_text(envelope: &Value) -> Option<String> {
    if let Some(text) = envelope.get("output_text").and_then(Value::as_str) {
        if !text.is_empty() {
            return Some(text.to_string());
        }
    }
    let output = envelope.get("output")?.as_array()?;
    let mut collected = String::new();
    for item in output {
        if item.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let Some(content) = item.get("content").and_then(Value::as_array) else {
            continue;
        };
        for part in content {
            if part.get("type").and_then(Value::as_str) == Some("output_text") {
                if let Some(text) = part.get("text").and_then(Value::as_str) {
                    collected.push_str(text);
                }
            }
        }
    }
    (!collected.is_empty()).then_some(collected)
}

/// Extract a refusal message, if the model refused instead of answering.
pub fn extract_refusal(envelope: &Value) -> Option<String> {
    let output = envelope.get("output")?.as_array()?;
    for item in output {
        let content = item.get("content").and_then(Value::as_array)?;
        for part in content {
            if part.get("type").and_then(Value::as_str) == Some("refusal") {
                return part
                    .get("refusal")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
        }
    }
    None
}

/// Extract the JSON `arguments` string of the named function call.
pub fn extract_function_arguments(envelope: &Value, name: &str) -> Option<String> {
    let output = envelope.get("output")?.as_array()?;
    for item in output {
        let kind = item.get("type").and_then(Value::as_str);
        if kind != Some("function_call") && kind != Some("custom_tool_call") {
            continue;
        }
        if item.get("name").and_then(Value::as_str) != Some(name) {
            continue;
        }
        if let Some(arguments) = item.get("arguments").and_then(Value::as_str) {
            return Some(arguments.to_string());
        }
    }
    None
}

pub fn extract_usage(envelope: &Value) -> LunaUsage {
    let Some(usage) = envelope.get("usage") else {
        return LunaUsage::default();
    };
    let number = |value: Option<&Value>| value.and_then(Value::as_u64).unwrap_or(0);
    LunaUsage {
        input_tokens: number(usage.get("input_tokens")),
        cached_input_tokens: number(
            usage
                .get("input_tokens_details")
                .and_then(|d| d.get("cached_tokens")),
        ),
        output_tokens: number(usage.get("output_tokens")),
        reasoning_tokens: number(
            usage
                .get("output_tokens_details")
                .and_then(|d| d.get("reasoning_tokens")),
        ),
        total_tokens: number(usage.get("total_tokens")),
    }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// The provider answered, but the answer is unusable. Never repaired through a
/// second model call (companion C.4).
pub fn semantic_response_invalid(reason: &str) -> AppError {
    AppError::structured(
        "PROVIDER_UNAVAILABLE",
        ErrorCategory::Provider,
        "Luna returned a result CandidCue could not use.",
        true,
    )
    .with_action(RecoveryAction::Retry)
    .with_detail("semanticFailure", "invalid_response")
    .with_detail("reason", reason)
    .with_log(format!("luna response rejected: {reason}"))
}

/// The request was cancelled locally (epoch change, retake commit, session end).
pub fn semantic_cancelled() -> AppError {
    AppError::structured(
        "PROVIDER_UNAVAILABLE",
        ErrorCategory::Provider,
        "The semantic request was superseded.",
        true,
    )
    .with_detail("semanticFailure", "cancelled")
    .with_log("luna request cancelled locally")
}

pub fn semantic_timeout() -> AppError {
    AppError::structured(
        "NETWORK_TIMEOUT",
        ErrorCategory::Network,
        "Luna did not answer in time.",
        true,
    )
    .with_action(RecoveryAction::Retry)
    .with_detail("semanticFailure", "timeout")
    .with_log("luna request timed out")
}

/// The only log line ever emitted for a Luna request. Contains no payload:
/// operation, model, opaque request id, and byte/token counts only (§57.3).
pub fn redacted_request_log(
    operation: &str,
    model: &str,
    request_id: &str,
    request_bytes: usize,
) -> String {
    format!(
        "luna op={operation} model={model} requestId={request_id} requestBytes={request_bytes}"
    )
}

/// The only log line ever emitted for a Luna response (§57.3).
pub fn redacted_response_log(
    operation: &str,
    request_id: &str,
    status: &str,
    usage: &LunaUsage,
    latency_ms: u64,
) -> String {
    format!(
        "luna op={operation} requestId={request_id} status={status} latencyMs={latency_ms} \
         inputTokens={} cachedInputTokens={} outputTokens={} reasoningTokens={}",
        usage.input_tokens, usage.cached_input_tokens, usage.output_tokens, usage.reasoning_tokens
    )
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

impl OpenAiClient {
    /// Register a cancellation slot for `request_id`, replacing (and firing)
    /// any previous holder of the same id.
    fn register_inflight(&self, request_id: &str) -> tokio::sync::oneshot::Receiver<()> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let mut guard = self.inflight.lock().expect("inflight registry poisoned");
        if let Some(previous) = guard.insert(request_id.to_string(), tx) {
            let _ = previous.send(());
        }
        rx
    }

    fn clear_inflight(&self, request_id: &str) {
        let mut guard = self.inflight.lock().expect("inflight registry poisoned");
        guard.remove(request_id);
    }

    /// Cancel an in-flight Luna request by id (companion §36.5). Returns true
    /// when a matching request was registered. Correctness never depends on
    /// cancellation succeeding — stale checks remain mandatory.
    pub fn cancel_semantic_request(&self, request_id: &str) -> bool {
        let sender = {
            let mut guard = self.inflight.lock().expect("inflight registry poisoned");
            guard.remove(request_id)
        };
        match sender {
            Some(tx) => {
                let _ = tx.send(());
                true
            }
            None => false,
        }
    }

    /// Number of currently registered in-flight semantic requests.
    pub fn inflight_semantic_count(&self) -> usize {
        self.inflight.lock().expect("inflight registry poisoned").len()
    }

    /// Cancel every in-flight semantic request (session end, script change).
    pub fn cancel_all_semantic_requests(&self) -> usize {
        let drained: Vec<_> = {
            let mut guard = self.inflight.lock().expect("inflight registry poisoned");
            guard.drain().map(|(_, tx)| tx).collect()
        };
        let count = drained.len();
        for tx in drained {
            let _ = tx.send(());
        }
        count
    }

    /// Execute one Responses API call with an explicit timeout and local
    /// cancellation. Returns the parsed envelope; never logs the body.
    pub async fn execute_responses(
        &self,
        key: &SecretString,
        operation: &str,
        request_id: &str,
        body: Value,
        timeout: Duration,
    ) -> Result<(Value, u64), AppError> {
        let url = format!("{}/responses", self.base_url);
        let serialized = serde_json::to_vec(&body)
            .map_err(|_| AppError::Internal("luna request serialization failed".into()))?;

        tracing::debug!(
            target: "candidcue::openai",
            "{}",
            redacted_request_log(operation, self.capabilities.semantic_model.as_str(), request_id, serialized.len())
        );

        let cancel = self.register_inflight(request_id);
        let started = std::time::Instant::now();

        let request = self
            .http
            .post(&url)
            .bearer_auth(key.expose())
            .header("content-type", "application/json")
            .body(serialized);

        let call = async {
            let response = request.send().await.map_err(map_transport_error)?;
            let status = response.status();
            let bytes = read_capped(response).await;
            if !status.is_success() {
                return Err(map_provider_status(status.as_u16(), bytes.as_deref()));
            }
            let bytes = bytes.ok_or_else(|| semantic_response_invalid("empty_or_oversized_body"))?;
            serde_json::from_slice::<Value>(&bytes)
                .map_err(|_| semantic_response_invalid("unparseable_envelope"))
        };

        let outcome = tokio::select! {
            biased;
            _ = cancel => Err(semantic_cancelled()),
            result = tokio::time::timeout(timeout, call) => match result {
                Ok(inner) => inner,
                Err(_) => Err(semantic_timeout()),
            },
        };

        self.clear_inflight(request_id);
        let latency_ms = started.elapsed().as_millis() as u64;

        let envelope = outcome?;
        let usage = extract_usage(&envelope);
        tracing::debug!(
            target: "candidcue::openai",
            "{}",
            redacted_response_log(operation, request_id, response_status(&envelope), &usage, latency_ms)
        );

        if let Some(refusal) = extract_refusal(&envelope) {
            let _ = refusal;
            return Err(semantic_response_invalid("model_refusal"));
        }
        if response_status(&envelope) == "incomplete" {
            let reason = incomplete_reason(&envelope).unwrap_or("unknown");
            return Err(semantic_response_invalid(&format!("incomplete:{reason}")));
        }

        Ok((envelope, latency_ms))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_spec() -> StructuredRequestSpec {
        StructuredRequestSpec {
            model: "gpt-5.6-luna".into(),
            instructions: "You classify how a presenter's recent speech relates to candidates."
                .into(),
            schema_name: "semantic_assist_result".into(),
            schema: json!({ "type": "object", "additionalProperties": false }),
            stable_context: Some("Section: Launching the product".into()),
            dynamic_payload: json!({ "recent_final_transcript": "confidential words here" }),
            reasoning_effort: "low".into(),
            max_output_tokens: 320,
            prompt_cache_key: Some("script-abc:classify".into()),
        }
    }

    #[test]
    fn structured_body_matches_current_responses_api_shape() {
        let body = build_structured_body(&sample_spec());
        assert_eq!(body["model"], "gpt-5.6-luna");
        assert_eq!(body["store"], false);
        assert_eq!(body["text"]["format"]["type"], "json_schema");
        assert_eq!(body["text"]["format"]["strict"], true);
        assert_eq!(body["text"]["format"]["name"], "semantic_assist_result");
        assert_eq!(body["reasoning"]["effort"], "low");
        assert_eq!(body["max_output_tokens"], 320);
        assert_eq!(body["prompt_cache_key"], "script-abc:classify");
        // No tools on the semantic path (companion §38).
        assert!(body.get("tools").is_none());
        // Legacy Chat Completions fields must not appear.
        assert!(body.get("response_format").is_none());
        assert!(body.get("max_tokens").is_none());
    }

    #[test]
    fn structured_body_puts_dynamic_payload_last_for_cache_prefixes() {
        let body = build_structured_body(&sample_spec());
        let input = body["input"].as_array().expect("input array");
        assert_eq!(input.len(), 2);
        assert_eq!(input[0]["role"], "developer");
        assert_eq!(input[1]["role"], "user");
        let dynamic = input[1]["content"][0]["text"].as_str().unwrap();
        assert!(dynamic.contains("confidential words here"));
    }

    #[test]
    fn tool_body_matches_appendix_e5() {
        let body = build_tool_body(&ToolRequestSpec {
            model: "gpt-5.6-luna".into(),
            instructions: "Interpret only a CandidCue teleprompter command.".into(),
            user_text: "Command: take me back to the pricing close".into(),
            function_name: "control_candidcue".into(),
            function_description: "Return one bounded CandidCue command.".into(),
            parameters: json!({ "type": "object" }),
            reasoning_effort: "low".into(),
            max_output_tokens: 200,
            prompt_cache_key: None,
        });
        assert_eq!(body["store"], false);
        assert_eq!(body["tools"][0]["type"], "function");
        assert_eq!(body["tools"][0]["strict"], true);
        assert_eq!(body["tool_choice"]["type"], "function");
        assert_eq!(body["tool_choice"]["name"], "control_candidcue");
        assert_eq!(body["parallel_tool_calls"], false);
        assert!(body.get("prompt_cache_key").is_none());
    }

    #[test]
    fn reasoning_effort_and_timeout_are_clamped() {
        assert_eq!(normalize_reasoning_effort(Some("minimal")), "minimal");
        assert_eq!(normalize_reasoning_effort(Some("none")), "none");
        // Medium/high are prohibited for continuous classification (§38.1).
        assert_eq!(normalize_reasoning_effort(Some("high")), "low");
        assert_eq!(normalize_reasoning_effort(None), "low");
        assert_eq!(normalize_timeout_ms(None), DEFAULT_SEMANTIC_TIMEOUT_MS);
        assert_eq!(normalize_timeout_ms(Some(1)), 250);
        assert_eq!(normalize_timeout_ms(Some(10_000_000)), MAX_SEMANTIC_TIMEOUT_MS);
    }

    #[test]
    fn extracts_output_text_from_typed_output_array() {
        let envelope = json!({
            "status": "completed",
            "output": [
                { "type": "reasoning", "summary": [] },
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [{ "type": "output_text", "text": "{\"relation\":\"paraphrase\"}" }]
                }
            ]
        });
        assert_eq!(
            extract_output_text(&envelope).as_deref(),
            Some("{\"relation\":\"paraphrase\"}")
        );
    }

    #[test]
    fn extracts_function_call_arguments() {
        let envelope = json!({
            "status": "completed",
            "output": [{
                "type": "function_call",
                "name": "control_candidcue",
                "arguments": "{\"action\":\"next_section\"}"
            }]
        });
        assert_eq!(
            extract_function_arguments(&envelope, "control_candidcue").as_deref(),
            Some("{\"action\":\"next_section\"}")
        );
        assert!(extract_function_arguments(&envelope, "other").is_none());
    }

    #[test]
    fn extracts_usage_including_cached_input_tokens() {
        let envelope = json!({
            "usage": {
                "input_tokens": 1200,
                "input_tokens_details": { "cached_tokens": 1024 },
                "output_tokens": 40,
                "output_tokens_details": { "reasoning_tokens": 16 },
                "total_tokens": 1240
            }
        });
        let usage = extract_usage(&envelope);
        assert_eq!(usage.input_tokens, 1200);
        assert_eq!(usage.cached_input_tokens, 1024);
        assert_eq!(usage.reasoning_tokens, 16);
        let cache = PromptCacheMetadata::from_usage(&usage, Some("k".into()));
        assert!(cache.cache_hit);
        assert!((cache.cache_hit_ratio - 1024.0 / 1200.0).abs() < 1e-9);
    }

    #[test]
    fn missing_usage_yields_zeroed_metadata() {
        let usage = extract_usage(&json!({}));
        assert_eq!(usage, LunaUsage::default());
        let cache = PromptCacheMetadata::from_usage(&usage, None);
        assert!(!cache.cache_hit);
        assert_eq!(cache.cache_hit_ratio, 0.0);
    }

    #[test]
    fn detects_incomplete_and_refusal_responses() {
        let incomplete = json!({
            "status": "incomplete",
            "incomplete_details": { "reason": "max_output_tokens" }
        });
        assert_eq!(response_status(&incomplete), "incomplete");
        assert_eq!(incomplete_reason(&incomplete), Some("max_output_tokens"));

        let refused = json!({
            "status": "completed",
            "output": [{
                "type": "message",
                "content": [{ "type": "refusal", "refusal": "I can't help with that." }]
            }]
        });
        assert!(extract_refusal(&refused).is_some());
    }

    /// §57.3 / deliverable 3: request bodies never reach a log line.
    #[test]
    fn no_request_body_is_logged() {
        let spec = sample_spec();
        let body = build_structured_body(&spec);
        let serialized = serde_json::to_vec(&body).unwrap();
        let line = redacted_request_log(
            "classify_semantic_tracking_window",
            &spec.model,
            "assist_184",
            serialized.len(),
        );
        assert!(!line.contains("confidential words here"));
        assert!(!line.contains("Launching the product"));
        assert!(!line.contains("You classify"));
        assert!(line.contains("requestBytes="));

        let response_line = redacted_response_log(
            "classify_semantic_tracking_window",
            "assist_184",
            "completed",
            &LunaUsage {
                input_tokens: 900,
                cached_input_tokens: 512,
                output_tokens: 30,
                reasoning_tokens: 8,
                total_tokens: 930,
            },
            140,
        );
        assert!(!response_line.contains("confidential"));
        assert!(response_line.contains("cachedInputTokens=512"));
    }

    /// Structural guard: no logging call site in the openai module may
    /// reference a request/response body or transcript variable.
    #[test]
    fn log_call_sites_never_reference_bodies() {
        const SOURCES: [(&str, &str); 4] = [
            ("responses.rs", include_str!("responses.rs")),
            ("semantic.rs", include_str!("semantic.rs")),
            ("luna_ops.rs", include_str!("luna_ops.rs")),
            ("mod.rs", include_str!("mod.rs")),
        ];
        const FORBIDDEN: [&str; 6] = [
            "body",
            "payload",
            "transcript",
            "dynamic",
            "candidate_text",
            "user_text",
        ];
        for (name, source) in SOURCES {
            let lines: Vec<&str> = source.lines().collect();
            for (index, line) in lines.iter().enumerate() {
                if !line.trim_start().starts_with("tracing::") {
                    continue;
                }
                // Join the whole macro invocation so multi-line call sites are
                // inspected in full, not just their first line.
                let mut invocation = String::new();
                let mut depth = 0i32;
                for candidate in &lines[index..] {
                    invocation.push_str(candidate);
                    invocation.push(' ');
                    depth += candidate.matches('(').count() as i32;
                    depth -= candidate.matches(')').count() as i32;
                    if depth <= 0 {
                        break;
                    }
                }
                for needle in FORBIDDEN {
                    assert!(
                        !invocation.contains(needle),
                        "{name}:{} logs a forbidden token `{needle}`: {invocation}",
                        index + 1
                    );
                }
            }
        }
    }

    #[tokio::test]
    async fn cancellation_registry_tracks_and_fires() {
        let client = OpenAiClient::with_base_url("http://127.0.0.1:1/v1".into());
        assert_eq!(client.inflight_semantic_count(), 0);
        assert!(!client.cancel_semantic_request("missing"));

        let rx = client.register_inflight("assist_1");
        assert_eq!(client.inflight_semantic_count(), 1);
        assert!(client.cancel_semantic_request("assist_1"));
        assert_eq!(client.inflight_semantic_count(), 0);
        assert!(rx.await.is_ok(), "cancellation signal must be delivered");
    }

    #[tokio::test]
    async fn cancel_all_drains_the_registry() {
        let client = OpenAiClient::with_base_url("http://127.0.0.1:1/v1".into());
        let a = client.register_inflight("a");
        let b = client.register_inflight("b");
        assert_eq!(client.cancel_all_semantic_requests(), 2);
        assert_eq!(client.inflight_semantic_count(), 0);
        assert!(a.await.is_ok());
        assert!(b.await.is_ok());
    }

    #[tokio::test]
    async fn request_times_out_without_blocking_forever() {
        // 203.0.113.0/24 is TEST-NET-3: guaranteed non-routable.
        let client = OpenAiClient::with_base_url("http://203.0.113.1:9/v1".into());
        let key = SecretString::new("sk-test".into());
        let error = client
            .execute_responses(
                &key,
                "classify_semantic_tracking_window",
                "assist_timeout",
                json!({ "model": "gpt-5.6-luna" }),
                Duration::from_millis(300),
            )
            .await
            .expect_err("unroutable host must fail");
        assert!(matches!(
            error.code(),
            "NETWORK_TIMEOUT" | "NETWORK_OFFLINE" | "PROVIDER_UNAVAILABLE"
        ));
        // The in-flight slot is always released.
        assert_eq!(client.inflight_semantic_count(), 0);
    }
}
