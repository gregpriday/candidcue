//! Luna semantic sidecar operations (companion §37–§41, Appendix C).
//!
//! Three operations, each with a strict JSON schema (Appendix C.3) and an
//! authoritative post-parse validator (Appendix C.4):
//!
//! * `classify_semantic_tracking_window` — ranks locally supplied candidates;
//! * `retrieve_semantic_landmarks` — opens exact candidate windows only;
//! * `prepare_semantic_landmarks` — offline annotation of a prepared section.
//!
//! Rust owns identity validation (request id / epoch / revision / hash) and
//! range validation. The TypeScript scheduler performs the remaining domain
//! checks it alone can make (candidate existence, section eligibility,
//! relation/direction compatibility) before any evidence reaches the aligner.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::responses::{
    extract_output_text, extract_usage, normalize_reasoning_effort,
    normalize_timeout_ms, semantic_response_invalid, LunaUsage, PromptCacheMetadata,
    StructuredRequestSpec,
};
use crate::errors::AppError;

// ---------------------------------------------------------------------------
// Stable instructions (companion C.1) — cacheable prefixes, static text only.
// ---------------------------------------------------------------------------

pub const CLASSIFY_INSTRUCTION: &str = "You classify how a presenter's recent speech relates to a small set of eligible \
nearby teleprompter script candidates. Select only a supplied candidate ID. \
Never invent a location. Return unresolved rather than guessing. A candidate \
marked retake may be selected only when the speech clearly restarts or corrects \
recent material. A candidate marked forward may be selected for a paraphrase or \
within-section skip. Classify ad-lib speech without advancing. Identify critical \
changes only for negation, numbers, important names, omitted clauses, or meaning. \
Return only the required structured result.";

pub const RETRIEVE_INSTRUCTION: &str = "You are given concise propositions describing passages of the presenter's current \
teleprompter section, each with an opaque landmark ID. Given the presenter's recent \
speech, return at most three supplied landmark IDs that plausibly describe what they \
are saying now. Only return IDs that appear in the request. Returning an empty array \
is correct and preferred when the speech is an ad-lib or the match is unclear. You \
never choose a reading position; you only nominate passages for local verification. \
Return only the required structured result.";

pub const PREPARE_INSTRUCTION: &str = "You annotate teleprompter script spans for later semantic retrieval. For each \
supplied span ID, write one concise proposition describing what the span asserts, \
a few topic labels, the critical terms a presenter must not change (names, numbers, \
negations, dates, currency, meaning), plausible conversational paraphrase aliases, \
and how exactly the span should be delivered. Annotate only the supplied span IDs. \
Never invent an ID, never rewrite the script, and never return token positions. \
Return only the required structured result.";

// ---------------------------------------------------------------------------
// Strict schemas (companion C.3, verbatim)
// ---------------------------------------------------------------------------

pub fn classification_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "schemaVersion": { "type": "integer", "enum": [1] },
            "requestId": { "type": "string", "minLength": 1, "maxLength": 128 },
            "semanticEpoch": { "type": "integer", "minimum": 0 },
            "transcriptRevision": { "type": "integer", "minimum": 0 },
            "candidateSetHash": { "type": "string", "minLength": 1, "maxLength": 256 },
            "relation": { "type": "string", "enum": [
                "near_exact", "paraphrase", "adlib", "return_to_script",
                "restart", "self_correction", "forward_skip", "unresolved"
            ]},
            "selectedCandidateId": { "anyOf": [
                { "type": "string", "minLength": 1, "maxLength": 128 },
                { "type": "null" }
            ]},
            "selectedCandidateConfidence": { "type": "number", "minimum": 0, "maximum": 1 },
            "transcriptCoverage": { "type": "number", "minimum": 0, "maximum": 1 },
            "candidateCoverage": { "type": "number", "minimum": 0, "maximum": 1 },
            "shouldInfluenceTracking": { "type": "boolean" },
            "criticalMismatch": { "type": "string", "enum": [
                "none", "negation", "number", "name",
                "meaning_change", "omitted_clause", "uncertain"
            ]},
            "coachTipCode": { "type": "string", "enum": [
                "none", "critical_word_changed", "number_changed",
                "name_changed", "meaningful_omission", "restart_detected"
            ]},
            "confidence": { "type": "number", "minimum": 0, "maximum": 1 }
        },
        "required": [
            "schemaVersion", "requestId", "semanticEpoch", "transcriptRevision",
            "candidateSetHash", "relation", "selectedCandidateId",
            "selectedCandidateConfidence", "transcriptCoverage", "candidateCoverage",
            "shouldInfluenceTracking", "criticalMismatch", "coachTipCode", "confidence"
        ]
    })
}

pub fn retrieval_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "schemaVersion": { "type": "integer", "enum": [1] },
            "requestId": { "type": "string", "minLength": 1, "maxLength": 128 },
            "semanticEpoch": { "type": "integer", "minimum": 0 },
            "transcriptRevision": { "type": "integer", "minimum": 0 },
            "landmarkSetHash": { "type": "string", "minLength": 1, "maxLength": 256 },
            "relation": { "type": "string", "enum": [
                "likely_current_passage", "likely_forward_within_section",
                "likely_retake", "adlib", "unresolved"
            ]},
            "candidateLandmarkIds": {
                "type": "array", "minItems": 0, "maxItems": 3,
                "items": { "type": "string", "minLength": 1, "maxLength": 128 }
            },
            "confidence": { "type": "number", "minimum": 0, "maximum": 1 }
        },
        "required": [
            "schemaVersion", "requestId", "semanticEpoch", "transcriptRevision",
            "landmarkSetHash", "relation", "candidateLandmarkIds", "confidence"
        ]
    })
}

pub fn preparation_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "schemaVersion": { "type": "integer", "enum": [1] },
            "requestId": { "type": "string", "minLength": 1, "maxLength": 128 },
            "scriptCompileHash": { "type": "string", "minLength": 1, "maxLength": 256 },
            "sectionId": { "type": "string", "minLength": 1, "maxLength": 256 },
            "annotations": {
                "type": "array",
                "maxItems": 128,
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "spanId": { "type": "string", "minLength": 1, "maxLength": 128 },
                        "proposition": { "type": "string", "minLength": 1, "maxLength": 240 },
                        "topicLabels": {
                            "type": "array", "maxItems": 6,
                            "items": { "type": "string", "minLength": 1, "maxLength": 64 }
                        },
                        "criticalTerms": {
                            "type": "array", "maxItems": 16,
                            "items": {
                                "type": "object",
                                "additionalProperties": false,
                                "properties": {
                                    "kind": { "type": "string", "enum": [
                                        "name", "number", "negation", "date", "currency", "meaning"
                                    ]},
                                    "canonical": { "type": "string", "minLength": 1, "maxLength": 160 }
                                },
                                "required": ["kind", "canonical"]
                            }
                        },
                        "conversationalAliases": {
                            "type": "array", "maxItems": 12,
                            "items": { "type": "string", "minLength": 1, "maxLength": 160 }
                        },
                        "exactness": { "type": "string", "enum": ["flexible", "balanced", "exact"] }
                    },
                    "required": [
                        "spanId", "proposition", "topicLabels",
                        "criticalTerms", "conversationalAliases", "exactness"
                    ]
                }
            }
        },
        "required": ["schemaVersion", "requestId", "scriptCompileHash", "sectionId", "annotations"]
    })
}

// ---------------------------------------------------------------------------
// Result types (companion §39)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AssistRelation {
    NearExact,
    Paraphrase,
    Adlib,
    ReturnToScript,
    Restart,
    SelfCorrection,
    ForwardSkip,
    Unresolved,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CriticalMismatch {
    None,
    Negation,
    Number,
    Name,
    MeaningChange,
    OmittedClause,
    Uncertain,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CoachTipCode {
    None,
    CriticalWordChanged,
    NumberChanged,
    NameChanged,
    MeaningfulOmission,
    RestartDetected,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SemanticAssistResult {
    pub schema_version: u8,
    pub request_id: String,
    pub semantic_epoch: u64,
    pub transcript_revision: u64,
    pub candidate_set_hash: String,
    pub relation: AssistRelation,
    pub selected_candidate_id: Option<String>,
    pub selected_candidate_confidence: f64,
    pub transcript_coverage: f64,
    pub candidate_coverage: f64,
    pub should_influence_tracking: bool,
    pub critical_mismatch: CriticalMismatch,
    pub coach_tip_code: CoachTipCode,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RetrievalRelation {
    LikelyCurrentPassage,
    LikelyForwardWithinSection,
    LikelyRetake,
    Adlib,
    Unresolved,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SemanticLandmarkRetrievalResult {
    pub schema_version: u8,
    pub request_id: String,
    pub semantic_epoch: u64,
    pub transcript_revision: u64,
    pub landmark_set_hash: String,
    pub relation: RetrievalRelation,
    pub candidate_landmark_ids: Vec<String>,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CriticalTermKind {
    Name,
    Number,
    Negation,
    Date,
    Currency,
    Meaning,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CriticalTerm {
    pub kind: CriticalTermKind,
    pub canonical: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Exactness {
    Flexible,
    Balanced,
    Exact,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LandmarkAnnotation {
    pub span_id: String,
    pub proposition: String,
    pub topic_labels: Vec<String>,
    pub critical_terms: Vec<CriticalTerm>,
    pub conversational_aliases: Vec<String>,
    pub exactness: Exactness,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SemanticLandmarkPreparationResult {
    pub schema_version: u8,
    pub request_id: String,
    pub script_compile_hash: String,
    pub section_id: String,
    pub annotations: Vec<LandmarkAnnotation>,
}

// ---------------------------------------------------------------------------
// Request envelopes accepted from the TypeScript scheduler (camelCase)
// ---------------------------------------------------------------------------

/// Shared knobs every semantic request may override within clamped bounds.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticRequestOptions {
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    #[serde(default)]
    pub max_output_tokens: Option<u32>,
    #[serde(default)]
    pub prompt_cache_key: Option<String>,
    /// Optional stable per-section context placed before the dynamic payload.
    #[serde(default)]
    pub stable_context: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticClassificationRequest {
    pub request_id: String,
    pub semantic_epoch: u64,
    pub transcript_revision: u64,
    pub candidate_set_hash: String,
    /// Bounded, candidate-only payload built by the scheduler (companion C.2).
    pub payload: Value,
    #[serde(flatten)]
    pub options: SemanticRequestOptions,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticRetrievalRequest {
    pub request_id: String,
    pub semantic_epoch: u64,
    pub transcript_revision: u64,
    pub landmark_set_hash: String,
    pub payload: Value,
    #[serde(flatten)]
    pub options: SemanticRequestOptions,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticPreparationRequest {
    pub request_id: String,
    pub script_compile_hash: String,
    pub section_id: String,
    pub payload: Value,
    #[serde(flatten)]
    pub options: SemanticRequestOptions,
}

/// Uniform envelope returned to the scheduler for every semantic operation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticOperationResponse<T: Serialize> {
    pub result: T,
    pub usage: LunaUsage,
    pub cache: PromptCacheMetadata,
    pub latency_ms: u64,
    pub model: String,
}

// ---------------------------------------------------------------------------
// Post-parse validation (companion C.4)
// ---------------------------------------------------------------------------

fn unit_interval(value: f64, field: &str) -> Result<(), AppError> {
    if !value.is_finite() || !(0.0..=1.0).contains(&value) {
        return Err(semantic_response_invalid(&format!("{field}_out_of_range")));
    }
    Ok(())
}

/// Identity + range validation for a classification result. Domain checks that
/// require the candidate set (existence, direction compatibility, section
/// eligibility) are completed by the TypeScript validator.
pub fn validate_classification(
    result: &SemanticAssistResult,
    request: &SemanticClassificationRequest,
) -> Result<(), AppError> {
    if result.schema_version != 1 {
        return Err(semantic_response_invalid("schema_version_mismatch"));
    }
    if result.request_id != request.request_id {
        return Err(semantic_response_invalid("request_id_mismatch"));
    }
    if result.semantic_epoch != request.semantic_epoch {
        return Err(semantic_response_invalid("semantic_epoch_mismatch"));
    }
    if result.transcript_revision != request.transcript_revision {
        return Err(semantic_response_invalid("transcript_revision_mismatch"));
    }
    if result.candidate_set_hash != request.candidate_set_hash {
        return Err(semantic_response_invalid("candidate_set_hash_mismatch"));
    }
    unit_interval(result.confidence, "confidence")?;
    unit_interval(
        result.selected_candidate_confidence,
        "selectedCandidateConfidence",
    )?;
    unit_interval(result.transcript_coverage, "transcriptCoverage")?;
    unit_interval(result.candidate_coverage, "candidateCoverage")?;
    if result.should_influence_tracking && result.selected_candidate_id.is_none() {
        return Err(semantic_response_invalid("influence_without_candidate"));
    }
    if let Some(id) = result.selected_candidate_id.as_ref() {
        if id.is_empty() || id.len() > 128 {
            return Err(semantic_response_invalid("candidate_id_length"));
        }
    }
    Ok(())
}

pub fn validate_retrieval(
    result: &SemanticLandmarkRetrievalResult,
    request: &SemanticRetrievalRequest,
) -> Result<(), AppError> {
    if result.schema_version != 1 {
        return Err(semantic_response_invalid("schema_version_mismatch"));
    }
    if result.request_id != request.request_id {
        return Err(semantic_response_invalid("request_id_mismatch"));
    }
    if result.semantic_epoch != request.semantic_epoch {
        return Err(semantic_response_invalid("semantic_epoch_mismatch"));
    }
    if result.transcript_revision != request.transcript_revision {
        return Err(semantic_response_invalid("transcript_revision_mismatch"));
    }
    if result.landmark_set_hash != request.landmark_set_hash {
        return Err(semantic_response_invalid("landmark_set_hash_mismatch"));
    }
    unit_interval(result.confidence, "confidence")?;
    if result.candidate_landmark_ids.len() > 3 {
        return Err(semantic_response_invalid("too_many_landmarks"));
    }
    let mut seen = std::collections::HashSet::new();
    for id in &result.candidate_landmark_ids {
        if id.is_empty() || id.len() > 128 {
            return Err(semantic_response_invalid("landmark_id_length"));
        }
        if !seen.insert(id.as_str()) {
            return Err(semantic_response_invalid("duplicate_landmark_id"));
        }
    }
    Ok(())
}

pub fn validate_preparation(
    result: &SemanticLandmarkPreparationResult,
    request: &SemanticPreparationRequest,
) -> Result<(), AppError> {
    if result.schema_version != 1 {
        return Err(semantic_response_invalid("schema_version_mismatch"));
    }
    if result.request_id != request.request_id {
        return Err(semantic_response_invalid("request_id_mismatch"));
    }
    if result.script_compile_hash != request.script_compile_hash {
        return Err(semantic_response_invalid("script_compile_hash_mismatch"));
    }
    if result.section_id != request.section_id {
        return Err(semantic_response_invalid("section_id_mismatch"));
    }
    if result.annotations.len() > 128 {
        return Err(semantic_response_invalid("too_many_annotations"));
    }
    let mut seen = std::collections::HashSet::new();
    for annotation in &result.annotations {
        if !seen.insert(annotation.span_id.as_str()) {
            return Err(semantic_response_invalid("duplicate_span_id"));
        }
        if annotation.proposition.is_empty() || annotation.proposition.chars().count() > 240 {
            return Err(semantic_response_invalid("proposition_length"));
        }
        if annotation.topic_labels.len() > 6
            || annotation.critical_terms.len() > 16
            || annotation.conversational_aliases.len() > 12
        {
            return Err(semantic_response_invalid("annotation_array_overflow"));
        }
    }
    Ok(())
}

/// Parse the model's structured text into `T`, rejecting anything the strict
/// schema should have prevented (companion C.4: discard, never repair).
pub fn parse_structured<T: serde::de::DeserializeOwned>(envelope: &Value) -> Result<T, AppError> {
    let text = extract_output_text(envelope)
        .ok_or_else(|| semantic_response_invalid("missing_output_text"))?;
    serde_json::from_str::<T>(&text).map_err(|_| semantic_response_invalid("out_of_schema"))
}

/// Assemble the envelope returned to the scheduler.
pub fn operation_response<T: Serialize>(
    result: T,
    envelope: &Value,
    latency_ms: u64,
    model: &str,
    prompt_cache_key: Option<String>,
) -> SemanticOperationResponse<T> {
    let usage = extract_usage(envelope);
    let cache = PromptCacheMetadata::from_usage(&usage, prompt_cache_key);
    SemanticOperationResponse {
        result,
        usage,
        cache,
        latency_ms,
        model: model.to_string(),
    }
}

/// Build the structured request spec for one semantic operation.
pub fn structured_spec(
    model: &str,
    instruction: &str,
    schema_name: &str,
    schema: Value,
    payload: Value,
    options: &SemanticRequestOptions,
    default_max_output_tokens: u32,
) -> StructuredRequestSpec {
    StructuredRequestSpec {
        model: model.to_string(),
        instructions: instruction.to_string(),
        schema_name: schema_name.to_string(),
        schema,
        stable_context: options.stable_context.clone(),
        dynamic_payload: payload,
        reasoning_effort: normalize_reasoning_effort(options.reasoning_effort.as_deref()),
        max_output_tokens: options
            .max_output_tokens
            .unwrap_or(default_max_output_tokens)
            .clamp(64, 8_192),
        prompt_cache_key: options.prompt_cache_key.clone(),
    }
}

pub fn timeout_for(options: &SemanticRequestOptions) -> std::time::Duration {
    std::time::Duration::from_millis(normalize_timeout_ms(options.timeout_ms))
}

#[cfg(test)]
mod tests {
    use super::super::responses::build_structured_body;
    use super::*;

    fn classification_request() -> SemanticClassificationRequest {
        SemanticClassificationRequest {
            request_id: "assist_184".into(),
            semantic_epoch: 7,
            transcript_revision: 993,
            candidate_set_hash: "7c32".into(),
            payload: json!({}),
            options: SemanticRequestOptions::default(),
        }
    }

    fn good_result() -> SemanticAssistResult {
        SemanticAssistResult {
            schema_version: 1,
            request_id: "assist_184".into(),
            semantic_epoch: 7,
            transcript_revision: 993,
            candidate_set_hash: "7c32".into(),
            relation: AssistRelation::Paraphrase,
            selected_candidate_id: Some("cand_a".into()),
            selected_candidate_confidence: 0.82,
            transcript_coverage: 0.7,
            candidate_coverage: 0.65,
            should_influence_tracking: true,
            critical_mismatch: CriticalMismatch::None,
            coach_tip_code: CoachTipCode::None,
            confidence: 0.79,
        }
    }

    #[test]
    fn accepts_a_well_formed_classification() {
        assert!(validate_classification(&good_result(), &classification_request()).is_ok());
    }

    #[test]
    fn rejects_identity_mismatches() {
        let request = classification_request();
        for mutate in [
            (|r: &mut SemanticAssistResult| r.request_id = "other".into()) as fn(&mut _),
            |r: &mut SemanticAssistResult| r.semantic_epoch = 8,
            |r: &mut SemanticAssistResult| r.transcript_revision = 1,
            |r: &mut SemanticAssistResult| r.candidate_set_hash = "zzzz".into(),
            |r: &mut SemanticAssistResult| r.schema_version = 2,
        ] {
            let mut result = good_result();
            mutate(&mut result);
            assert!(validate_classification(&result, &request).is_err());
        }
    }

    #[test]
    fn rejects_out_of_range_confidences() {
        let request = classification_request();
        let mut result = good_result();
        result.confidence = 1.4;
        assert!(validate_classification(&result, &request).is_err());
        let mut result = good_result();
        result.transcript_coverage = -0.1;
        assert!(validate_classification(&result, &request).is_err());
        let mut result = good_result();
        result.selected_candidate_confidence = f64::NAN;
        assert!(validate_classification(&result, &request).is_err());
    }

    #[test]
    fn rejects_influence_without_a_selected_candidate() {
        let mut result = good_result();
        result.selected_candidate_id = None;
        result.should_influence_tracking = true;
        assert!(validate_classification(&result, &classification_request()).is_err());
    }

    #[test]
    fn parse_structured_rejects_unknown_and_missing_fields() {
        // Extra property — strict schema violation.
        let envelope = json!({
            "output_text": r#"{"schemaVersion":1,"requestId":"a","semanticEpoch":1,
              "transcriptRevision":1,"candidateSetHash":"h","relation":"adlib",
              "selectedCandidateId":null,"selectedCandidateConfidence":0,
              "transcriptCoverage":0,"candidateCoverage":0,"shouldInfluenceTracking":false,
              "criticalMismatch":"none","coachTipCode":"none","confidence":0.1,
              "scrollToToken":42}"#
        });
        assert!(parse_structured::<SemanticAssistResult>(&envelope).is_err());

        // Unknown enum member.
        let envelope = json!({ "output_text": r#"{"relation":"teleport"}"# });
        assert!(parse_structured::<SemanticAssistResult>(&envelope).is_err());

        // No output at all.
        assert!(parse_structured::<SemanticAssistResult>(&json!({})).is_err());
    }

    #[test]
    fn retrieval_rejects_oversized_and_duplicate_id_sets() {
        let request = SemanticRetrievalRequest {
            request_id: "r1".into(),
            semantic_epoch: 2,
            transcript_revision: 5,
            landmark_set_hash: "lm".into(),
            payload: json!({}),
            options: SemanticRequestOptions::default(),
        };
        let base = SemanticLandmarkRetrievalResult {
            schema_version: 1,
            request_id: "r1".into(),
            semantic_epoch: 2,
            transcript_revision: 5,
            landmark_set_hash: "lm".into(),
            relation: RetrievalRelation::LikelyCurrentPassage,
            candidate_landmark_ids: vec!["a".into(), "b".into()],
            confidence: 0.5,
        };
        assert!(validate_retrieval(&base, &request).is_ok());

        let mut too_many = base.clone();
        too_many.candidate_landmark_ids =
            vec!["a".into(), "b".into(), "c".into(), "d".into()];
        assert!(validate_retrieval(&too_many, &request).is_err());

        let mut duplicated = base.clone();
        duplicated.candidate_landmark_ids = vec!["a".into(), "a".into()];
        assert!(validate_retrieval(&duplicated, &request).is_err());
    }

    #[test]
    fn preparation_rejects_duplicate_span_ids() {
        let request = SemanticPreparationRequest {
            request_id: "p1".into(),
            script_compile_hash: "sc".into(),
            section_id: "section_launch".into(),
            payload: json!({}),
            options: SemanticRequestOptions::default(),
        };
        let annotation = LandmarkAnnotation {
            span_id: "span_1".into(),
            proposition: "Start with customers who already trust you.".into(),
            topic_labels: vec!["launch".into()],
            critical_terms: vec![],
            conversational_aliases: vec![],
            exactness: Exactness::Balanced,
        };
        let result = SemanticLandmarkPreparationResult {
            schema_version: 1,
            request_id: "p1".into(),
            script_compile_hash: "sc".into(),
            section_id: "section_launch".into(),
            annotations: vec![annotation.clone(), annotation],
        };
        assert!(validate_preparation(&result, &request).is_err());
    }

    #[test]
    fn schemas_are_strict_and_closed() {
        for schema in [classification_schema(), retrieval_schema(), preparation_schema()] {
            assert_eq!(schema["additionalProperties"], false);
            assert!(schema["required"].as_array().unwrap().len() >= 5);
        }
        let retrieval = retrieval_schema();
        assert_eq!(retrieval["properties"]["candidateLandmarkIds"]["maxItems"], 3);
    }

    #[test]
    fn structured_spec_applies_policy_bounds() {
        let options = SemanticRequestOptions {
            timeout_ms: Some(999_999),
            reasoning_effort: Some("high".into()),
            max_output_tokens: Some(1),
            prompt_cache_key: Some("k".into()),
            stable_context: None,
        };
        let spec = structured_spec(
            "gpt-5.6-luna",
            CLASSIFY_INSTRUCTION,
            "semantic_assist_result",
            classification_schema(),
            json!({}),
            &options,
            320,
        );
        assert_eq!(spec.reasoning_effort, "low");
        assert_eq!(spec.max_output_tokens, 64);
        assert_eq!(timeout_for(&options).as_millis(), 30_000);
        let body = build_structured_body(&spec);
        assert_eq!(body["store"], false);
    }
}
