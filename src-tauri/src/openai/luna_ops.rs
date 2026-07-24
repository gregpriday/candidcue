//! Luna command interpretation and vocabulary analysis.
//!
//! Primary spec Appendix E.5 (`interpret_command`, bounded function call) and
//! E.6 (`analyze_vocabulary`, strict structured output), §26.5–§26.7.
//!
//! Both are one-shot, `store: false`, no conversation history, and no request
//! body logging. The TypeScript layer re-validates every result against the
//! live document (`validateLunaResult` in `src/shared/commands/luna.ts`).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::responses::{
    extract_function_arguments, normalize_reasoning_effort, semantic_response_invalid,
    ToolRequestSpec,
};
use super::semantic::SemanticRequestOptions;
use crate::errors::AppError;

pub const COMMAND_FUNCTION_NAME: &str = "control_candidcue";

pub const COMMAND_INSTRUCTION: &str = "Interpret only a CandidCue teleprompter command. Use the provided action schema. \
Never invent a target: every navigation target must appear in the supplied list. \
Return action \"unknown\" when the request is ambiguous, out of scope, or refers to \
content that does not exist. Return only the bounded function call.";

pub const VOCABULARY_INSTRUCTION: &str = "Given candidate terms extracted from a teleprompter script and brief context, \
identify only genuinely unusual names, brands, acronyms, technical terms, \
numbers, and likely speech-to-text variants. Do not rewrite the script. Do not \
add ordinary words. Return the strict schema. A transcript alias is a possible \
recognition variant, not a recommended spelling.";

// ---------------------------------------------------------------------------
// E.5 — command interpretation
// ---------------------------------------------------------------------------

/// Rust twin of `LunaCommandRequest` (src/shared/commands/luna.ts). Only the
/// fields Rust needs are typed; the rest ride along for the prompt text.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LunaCommandRequest {
    pub candidate_id: String,
    pub context_revision: i64,
    /// Command speech only — never unrelated transcript (primary §33.12).
    pub command_text: String,
    pub scroll_mode: String,
    #[serde(default)]
    pub position: Value,
    #[serde(default)]
    pub nearby_targets: Vec<NearbyTarget>,
    #[serde(default)]
    pub outline: Vec<OutlineEntry>,
    #[serde(default)]
    pub bounds: Value,
    /// The strict function schema authored in TypeScript (§33.8, verbatim).
    pub schema: LunaFunctionSchema,
    pub instruction: String,
    #[serde(flatten)]
    pub options: SemanticRequestOptions,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NearbyTarget {
    pub id: String,
    #[serde(rename = "type")]
    pub target_type: String,
    pub label: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct OutlineEntry {
    pub level: i32,
    pub title: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LunaFunctionSchema {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub parameters: Value,
}

/// The raw structured output (snake_case, matching `LunaRawResult` in TS).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LunaRawResult {
    pub action: String,
    #[serde(default)]
    pub target_type: Option<String>,
    #[serde(default)]
    pub target_value: Option<String>,
    #[serde(default)]
    pub direction: Option<String>,
    #[serde(default)]
    pub amount: Option<f64>,
    #[serde(default)]
    pub unit: Option<String>,
    pub confidence: f64,
    pub requires_confirmation: bool,
}

/// Render the bounded user message for a command request (E.5). Contains the
/// command phrase and the eligible target list only.
pub fn build_command_user_text(request: &LunaCommandRequest) -> String {
    let targets = request
        .nearby_targets
        .iter()
        .map(|t| format!("{} ({}, id={})", t.label, t.target_type, t.id))
        .collect::<Vec<_>>()
        .join("; ");
    let outline = request
        .outline
        .iter()
        .map(|o| format!("{}{}", "#".repeat(o.level.clamp(1, 6) as usize), o.title))
        .collect::<Vec<_>>()
        .join(" / ");
    let mut text = format!(
        "Command: {}\nScroll mode: {}\nTargets: {}",
        request.command_text, request.scroll_mode, targets
    );
    if !outline.is_empty() {
        text.push_str(&format!("\nOutline: {outline}"));
    }
    text.push_str(&format!("\n{}", request.instruction));
    text
}

/// Strict Structured Outputs requires every declared property to appear in
/// `required` and `additionalProperties: false` on every object.
///
/// DEVIATION (documented): the verbatim §33.8 schema in
/// `src/shared/commands/luna.ts` lists only three properties in `required`
/// while declaring eight. Sending it unchanged with `strict: true` is rejected
/// by the API. The optional properties are already nullable
/// (`"type": ["string", "null"]`), so promoting them to required preserves the
/// authored contract exactly — `null` remains the "not supplied" value.
pub fn normalize_strict_schema(schema: &Value) -> Value {
    let mut normalized = schema.clone();
    let Some(object) = normalized.as_object_mut() else {
        return normalized;
    };
    if object.get("type").and_then(Value::as_str) != Some("object") {
        return normalized;
    }
    object.insert("additionalProperties".into(), Value::Bool(false));
    let keys: Vec<String> = object
        .get("properties")
        .and_then(Value::as_object)
        .map(|p| p.keys().cloned().collect())
        .unwrap_or_default();
    if !keys.is_empty() {
        object.insert(
            "required".into(),
            Value::Array(keys.into_iter().map(Value::String).collect()),
        );
    }
    if let Some(properties) = object.get_mut("properties").and_then(Value::as_object_mut) {
        for value in properties.values_mut() {
            if value.get("type").and_then(Value::as_str) == Some("object") {
                *value = normalize_strict_schema(value);
            }
        }
    }
    normalized
}

pub fn build_command_spec(model: &str, request: &LunaCommandRequest) -> ToolRequestSpec {
    ToolRequestSpec {
        model: model.to_string(),
        instructions: COMMAND_INSTRUCTION.to_string(),
        user_text: build_command_user_text(request),
        function_name: request.schema.name.clone(),
        function_description: request
            .schema
            .description
            .clone()
            .unwrap_or_else(|| "Return one bounded CandidCue command.".to_string()),
        parameters: normalize_strict_schema(&request.schema.parameters),
        reasoning_effort: normalize_reasoning_effort(request.options.reasoning_effort.as_deref()),
        max_output_tokens: request.options.max_output_tokens.unwrap_or(300).clamp(64, 2_048),
        prompt_cache_key: request.options.prompt_cache_key.clone(),
    }
}

/// Structural validation of the raw command result (E.5 validation pass 1).
/// The domain pass runs in TypeScript against the live document.
pub fn parse_command_result(envelope: &Value, function_name: &str) -> Result<LunaRawResult, AppError> {
    let arguments = extract_function_arguments(envelope, function_name)
        .ok_or_else(|| semantic_response_invalid("missing_function_call"))?;
    let parsed: LunaRawResult = serde_json::from_str(&arguments)
        .map_err(|_| semantic_response_invalid("command_out_of_schema"))?;
    if !parsed.confidence.is_finite() || !(0.0..=1.0).contains(&parsed.confidence) {
        return Err(semantic_response_invalid("confidence_out_of_range"));
    }
    if parsed.action.is_empty() || parsed.action.len() > 64 {
        return Err(semantic_response_invalid("action_length"));
    }
    if let Some(amount) = parsed.amount {
        if !amount.is_finite() {
            return Err(semantic_response_invalid("amount_not_finite"));
        }
    }
    Ok(parsed)
}

// ---------------------------------------------------------------------------
// E.6 — vocabulary analysis
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabularyRequest {
    #[serde(default = "default_language")]
    pub language: String,
    pub candidates: Vec<VocabularyCandidate>,
    #[serde(default)]
    pub existing_dictionary: Vec<Value>,
    #[serde(flatten)]
    pub options: SemanticRequestOptions,
}

fn default_language() -> String {
    "en".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VocabularyCandidate {
    pub surface: String,
    #[serde(default)]
    pub contexts: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VocabularyTerm {
    pub surface: String,
    pub canonical_spoken: String,
    pub aliases: Vec<String>,
    pub category: String,
    pub importance: f64,
    pub case_sensitive: bool,
    pub notes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VocabularyAnalysis {
    pub terms: Vec<VocabularyTerm>,
}

/// Strict result schema, verbatim from primary Appendix E.6.
pub fn vocabulary_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["terms"],
        "properties": {
            "terms": {
                "type": "array",
                "maxItems": 300,
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                        "surface", "canonical_spoken", "aliases",
                        "category", "importance", "case_sensitive", "notes"
                    ],
                    "properties": {
                        "surface": { "type": "string", "maxLength": 200 },
                        "canonical_spoken": { "type": "string", "maxLength": 300 },
                        "aliases": {
                            "type": "array", "maxItems": 12,
                            "items": { "type": "string", "maxLength": 200 }
                        },
                        "category": { "type": "string", "enum": [
                            "person", "place", "brand", "acronym", "technical", "number", "other"
                        ]},
                        "importance": { "type": "number", "minimum": 0, "maximum": 1 },
                        "case_sensitive": { "type": "boolean" },
                        "notes": { "type": "string", "maxLength": 300 }
                    }
                }
            }
        }
    })
}

/// Bounded input object (E.6): candidates plus brief context only.
pub fn build_vocabulary_payload(request: &VocabularyRequest) -> Value {
    let candidates: Vec<Value> = request
        .candidates
        .iter()
        .take(300)
        .map(|c| {
            json!({
                "surface": c.surface,
                "contexts": c.contexts.iter().take(3).collect::<Vec<_>>(),
            })
        })
        .collect();
    json!({
        "language": request.language,
        "candidates": candidates,
        "existing_dictionary": request.existing_dictionary.iter().take(300).collect::<Vec<_>>(),
    })
}

const VOCABULARY_CATEGORIES: [&str; 7] = [
    "person", "place", "brand", "acronym", "technical", "number", "other",
];

/// Post-parse validation: terms must correspond to supplied candidates and
/// stay inside the schema's declared ranges. Invented surfaces are discarded
/// rather than repaired (§26.5: model output is labelled generated, never
/// trusted as authority).
pub fn validate_vocabulary(
    analysis: VocabularyAnalysis,
    request: &VocabularyRequest,
) -> Result<VocabularyAnalysis, AppError> {
    if analysis.terms.len() > 300 {
        return Err(semantic_response_invalid("too_many_terms"));
    }
    let known: std::collections::HashSet<&str> = request
        .candidates
        .iter()
        .map(|c| c.surface.as_str())
        .collect();
    let mut seen = std::collections::HashSet::new();
    let mut terms = Vec::with_capacity(analysis.terms.len());
    for mut term in analysis.terms {
        if !known.contains(term.surface.as_str()) {
            continue; // invented surface — discard
        }
        if !seen.insert(term.surface.clone()) {
            continue; // duplicate — keep the first
        }
        if !term.importance.is_finite() || !(0.0..=1.0).contains(&term.importance) {
            return Err(semantic_response_invalid("importance_out_of_range"));
        }
        if !VOCABULARY_CATEGORIES.contains(&term.category.as_str()) {
            return Err(semantic_response_invalid("category_out_of_schema"));
        }
        term.aliases.truncate(12);
        term.aliases.retain(|a| !a.is_empty() && a.chars().count() <= 200);
        terms.push(term);
    }
    Ok(VocabularyAnalysis { terms })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command_request() -> LunaCommandRequest {
        serde_json::from_value(json!({
            "candidateId": "cand_1",
            "contextRevision": 12,
            "commandText": "take me back to the pricing close",
            "scrollMode": "voice",
            "position": { "blockId": "b1", "sentenceId": "s1", "tokenIndex": 40 },
            "nearbyTargets": [
                { "id": "t_pricing", "type": "heading", "label": "Pricing" },
                { "id": "t_demo", "type": "heading", "label": "Demo" }
            ],
            "outline": [{ "level": 1, "title": "Demo" }],
            "bounds": {},
            "schema": {
                "name": "control_candidcue",
                "description": "Interpret a bounded teleprompter command.",
                "strict": true,
                "parameters": { "type": "object", "additionalProperties": false }
            },
            "instruction": "Return unknown rather than inventing a result."
        }))
        .expect("request deserializes")
    }

    #[test]
    fn command_user_text_contains_only_bounded_context() {
        let text = build_command_user_text(&command_request());
        assert!(text.contains("take me back to the pricing close"));
        assert!(text.contains("t_pricing"));
        assert!(text.starts_with("Command: "));
    }

    #[test]
    fn command_spec_uses_a_single_forced_tool_call() {
        let spec = build_command_spec("gpt-5.6-luna", &command_request());
        assert_eq!(spec.function_name, "control_candidcue");
        let body = super::super::responses::build_tool_body(&spec);
        assert_eq!(body["tool_choice"]["name"], "control_candidcue");
        assert_eq!(body["parallel_tool_calls"], false);
        assert_eq!(body["store"], false);
    }

    #[test]
    fn parses_and_range_checks_command_results() {
        let envelope = json!({
            "output": [{
                "type": "function_call",
                "name": "control_candidcue",
                "arguments": r#"{"action":"go_to_target","target_type":"heading",
                    "target_value":"t_pricing","direction":null,"amount":null,"unit":null,
                    "confidence":0.9,"requires_confirmation":false}"#
            }]
        });
        let parsed = parse_command_result(&envelope, "control_candidcue").unwrap();
        assert_eq!(parsed.action, "go_to_target");
        assert_eq!(parsed.target_value.as_deref(), Some("t_pricing"));

        let bad = json!({
            "output": [{
                "type": "function_call",
                "name": "control_candidcue",
                "arguments": r#"{"action":"go_to_target","confidence":7,"requires_confirmation":false}"#
            }]
        });
        assert!(parse_command_result(&bad, "control_candidcue").is_err());
        assert!(parse_command_result(&json!({ "output": [] }), "control_candidcue").is_err());
    }

    #[test]
    fn strict_schema_normalization_promotes_every_property_to_required() {
        let schema = json!({
            "type": "object",
            "required": ["action", "confidence", "requires_confirmation"],
            "properties": {
                "action": { "type": "string" },
                "target_type": { "type": ["string", "null"] },
                "amount": { "type": ["number", "null"] },
                "confidence": { "type": "number" },
                "requires_confirmation": { "type": "boolean" }
            }
        });
        let normalized = normalize_strict_schema(&schema);
        let required: Vec<&str> = normalized["required"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(required.len(), 5);
        for key in ["action", "target_type", "amount", "confidence", "requires_confirmation"] {
            assert!(required.contains(&key), "missing {key}");
        }
        assert_eq!(normalized["additionalProperties"], false);
        // Nullable typing is preserved, so `null` is still "not supplied".
        assert_eq!(normalized["properties"]["target_type"]["type"][1], "null");
    }

    #[test]
    fn strict_schema_normalization_leaves_non_objects_alone() {
        let schema = json!({ "type": "string" });
        assert_eq!(normalize_strict_schema(&schema), schema);
    }

    #[test]
    fn vocabulary_payload_stays_bounded() {
        let request: VocabularyRequest = serde_json::from_value(json!({
            "language": "en",
            "candidates": [
                { "surface": "RuinWeave", "contexts": ["a", "b", "c", "d", "e"] }
            ],
            "existingDictionary": []
        }))
        .unwrap();
        let payload = build_vocabulary_payload(&request);
        assert_eq!(payload["candidates"][0]["contexts"].as_array().unwrap().len(), 3);
        assert_eq!(payload["language"], "en");
    }

    #[test]
    fn vocabulary_validation_discards_invented_surfaces() {
        let request: VocabularyRequest = serde_json::from_value(json!({
            "candidates": [{ "surface": "CandidCue", "contexts": [] }]
        }))
        .unwrap();
        let analysis = VocabularyAnalysis {
            terms: vec![
                VocabularyTerm {
                    surface: "CandidCue".into(),
                    canonical_spoken: "Candid Cue".into(),
                    aliases: vec!["candy cue".into()],
                    category: "brand".into(),
                    importance: 0.96,
                    case_sensitive: true,
                    notes: "Application name".into(),
                },
                VocabularyTerm {
                    surface: "NeverExtracted".into(),
                    canonical_spoken: "never".into(),
                    aliases: vec![],
                    category: "other".into(),
                    importance: 0.5,
                    case_sensitive: false,
                    notes: String::new(),
                },
            ],
        };
        let validated = validate_vocabulary(analysis, &request).unwrap();
        assert_eq!(validated.terms.len(), 1);
        assert_eq!(validated.terms[0].surface, "CandidCue");
    }

    #[test]
    fn vocabulary_validation_rejects_bad_ranges_and_categories() {
        let request: VocabularyRequest = serde_json::from_value(json!({
            "candidates": [{ "surface": "X", "contexts": [] }]
        }))
        .unwrap();
        let make = |importance: f64, category: &str| VocabularyAnalysis {
            terms: vec![VocabularyTerm {
                surface: "X".into(),
                canonical_spoken: "ex".into(),
                aliases: vec![],
                category: category.into(),
                importance,
                case_sensitive: false,
                notes: String::new(),
            }],
        };
        assert!(validate_vocabulary(make(1.5, "brand"), &request).is_err());
        assert!(validate_vocabulary(make(0.5, "spaceship"), &request).is_err());
        assert!(validate_vocabulary(make(0.5, "brand"), &request).is_ok());
    }

    #[test]
    fn vocabulary_schema_is_strict() {
        let schema = vocabulary_schema();
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(schema["properties"]["terms"]["maxItems"], 300);
    }
}
