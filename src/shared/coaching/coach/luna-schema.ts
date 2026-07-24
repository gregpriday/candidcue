/**
 * §23. The Luna Coach Observer structured-output schema and its wire-shape
 * parser.
 *
 * The response type is snake_case on purpose (see the contract): this module
 * validates the object that actually arrives, and conversion to app casing
 * happens once, afterwards, in the observer. A validator that checks camelCase
 * fields against a snake_case payload passes everything.
 *
 * `strict: true` and `additionalProperties: false` are asserted by tests, not
 * merely written down: the strict schema is the first line of the copy
 * boundary, because a model that cannot add a field cannot smuggle prose.
 */
import type {
  LunaCoachDecision,
  LunaCoachReasonCode,
  LunaCoachTipCode,
} from '../../contracts/coaching';

/* ---------------------------------------------------------------------------
 * Enumerations, kept in lockstep with the contract at compile time
 * ------------------------------------------------------------------------- */

/**
 * A `Record` keyed by the union forces a compile error the moment the contract
 * gains or loses a code — the alternative (a bare array) silently drifts, and
 * a schema whose enum is a subset of the type is how an "impossible" value
 * reaches the app.
 */
const TIP_CODE_PRESENCE: Record<LunaCoachTipCode, true> = {
  NONE: true,
  PACE_EASE_BACK: true,
  PACE_LIFT_SLIGHTLY: true,
  TERMINAL_RUSH: true,
  USE_SILENT_PAUSE: true,
  REPEATED_FILLER: true,
  LET_BOUNDARY_BREATHE: true,
  KEEP_SENTENCE_FLOWING: true,
  LIFT_KEY_WORDS: true,
  SETTLE_DELIVERY: true,
  REPETITIVE_OPENER: true,
  TAKE_SENTENCE_FROM_TOP: true,
  CRITICAL_NUMBER: true,
  CRITICAL_NAME: true,
  CRITICAL_UNIT: true,
  CRITICAL_NEGATION: true,
  MATERIAL_MEANING_CHANGE: true,
};

const REASON_CODE_PRESENCE: Record<LunaCoachReasonCode, true> = {
  NO_ACTIONABLE_ISSUE: true,
  INSUFFICIENT_EVIDENCE: true,
  ISSUE_SELF_CORRECTED: true,
  ISSUE_STALE: true,
  COACHING_SUPPRESSED: true,
  HIGH_VALUE_LOCAL_PATTERN: true,
  CONTEXTUAL_FILLER_CONFIRMED: true,
  CONTEXTUAL_FILLER_REJECTED: true,
  PARAPHRASE_PRESERVES_MEANING: true,
  MATERIAL_DIFFERENCE_CONFIRMED: true,
  BEST_OF_MULTIPLE_CANDIDATES: true,
};

export const LUNA_TIP_CODES = Object.keys(TIP_CODE_PRESENCE) as LunaCoachTipCode[];
export const LUNA_REASON_CODES = Object.keys(REASON_CODE_PRESENCE) as LunaCoachReasonCode[];
export const LUNA_DECISIONS: ReadonlyArray<LunaCoachDecision['decision']> = ['none', 'candidate'];
export const LUNA_SCOPES: ReadonlyArray<LunaCoachDecision['scope']> = [
  'none',
  'current_phrase',
  'next_boundary',
  'session_pattern',
];

/** §23. Every field is required and no object accepts extra properties. */
export const COACH_DECISION_RESPONSE_FORMAT = {
  name: 'candidcue_live_coach_decision_v1',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      decision: { type: 'string', enum: LUNA_DECISIONS },
      tip_code: { type: 'string', enum: LUNA_TIP_CODES },
      confidence: { type: 'number' },
      evidence_ids: { type: 'array', items: { type: 'string' } },
      scope: { type: 'string', enum: LUNA_SCOPES },
      reason_code: { type: 'string', enum: LUNA_REASON_CODES },
      valid_for_ms: { type: 'integer' },
    },
    required: [
      'decision',
      'tip_code',
      'confidence',
      'evidence_ids',
      'scope',
      'reason_code',
      'valid_for_ms',
    ],
    additionalProperties: false,
  },
} as const;

/** §21. Normative system prompt. Wording changes require eval evidence. */
export const COACH_OBSERVER_SYSTEM_PROMPT = `You are CandidCue Coach Observer, an asynchronous classifier inside a
live teleprompter. The speaker is currently performing. Your job is to
validate or reject a small set of coaching candidates and, at most,
select one predefined tip code.

PRIMARY RULE: silence is valid and usually preferred. Return no tip
unless the evidence is strong, the issue is actionable now, and showing
it is more useful than leaving the speaker alone.

AUTHORITY BOUNDARIES
- You do not control scrolling, script position, navigation, microphone,
  recording, or take state.
- You do not generate the user-facing tip text. You return an allowed
  code only.
- You do not infer acoustic facts. Pitch, loudness, pace, cadence,
  clipping, pauses, and filler-audio evidence are supplied by the local
  engine. Treat missing or unreliable metrics as unknown.
- You do not invent words, fillers, mistakes, or events that are not in
  the supplied evidence.
- You do not diagnose emotion, anxiety, confidence, personality,
  accent quality, disability, health, honesty, or audience reaction.

TRANSCRIPT RULES
- Finalized speech has more authority than provisional speech.
- ASR can omit fillers or misrecognize names and phonetic spellings.
- A difference from the script is not automatically an error.
  Paraphrases and useful ad-libs may preserve meaning.
- If the speaker self-corrected, prefer no tip unless a continuing
  pattern remains.
- Never classify "and," "so," "but," "like," "well," "right," "okay,"
  "actually," or similar words as fillers solely because they appear.
  Require contextual evidence that the use is nonessential,
  hesitation-like, repeated, and absent from the authored wording.
- Authored filler-like words are intentional unless explicitly marked
  otherwise.

TIP SELECTION
- Choose no more than one tip.
- Prefer system-critical and meaning-critical issues over style.
- Prefer a prospective, actionable adjustment over retroactive blame.
- Do not select a pace or variety tip for one short sentence.
- Do not select a stale issue that ended or was corrected.
- Do not select ordinary coaching during a command, retake,
  reacquisition, low alignment confidence, or microphone failure.
- Use only the enumerated tip codes in the schema.
- Confidence reflects confidence that the selected tip is appropriate
  now, not merely confidence that an event occurred.

Return only the structured response required by the schema.`;

/* ---------------------------------------------------------------------------
 * Wire-shape parsing
 * ------------------------------------------------------------------------- */

export type SchemaRejection =
  | 'not_an_object'
  | 'decision_out_of_schema'
  | 'tip_code_out_of_schema'
  | 'confidence_out_of_range'
  | 'evidence_ids_out_of_schema'
  | 'scope_out_of_schema'
  | 'reason_code_out_of_schema'
  | 'valid_for_ms_out_of_schema'
  | `additional_property:${string}`;

export type SchemaResult =
  | { ok: true; decision: LunaCoachDecision }
  | { ok: false; reason: SchemaRejection };

const ALLOWED_KEYS = new Set(COACH_DECISION_RESPONSE_FORMAT.schema.required as readonly string[]);

/** Longest evidence id we will even look at, and the most we accept. */
const MAX_EVIDENCE_ID_CHARS = 128;
const MAX_EVIDENCE_IDS = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Structural validation, repeated locally even though the API enforces the
 * strict schema. A validator that trusts an upstream parse is not a validator —
 * and this one is also the copy boundary: **any property the schema does not
 * name is a rejection**, so a model-authored prose field cannot pass through
 * even as an ignored extra.
 */
export function parseCoachDecision(raw: unknown): SchemaResult {
  if (!isRecord(raw)) return { ok: false, reason: 'not_an_object' };

  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) return { ok: false, reason: `additional_property:${key}` };
  }
  if (!LUNA_DECISIONS.includes(raw.decision as LunaCoachDecision['decision'])) {
    return { ok: false, reason: 'decision_out_of_schema' };
  }
  if (typeof raw.tip_code !== 'string' || TIP_CODE_PRESENCE[raw.tip_code as LunaCoachTipCode] !== true) {
    return { ok: false, reason: 'tip_code_out_of_schema' };
  }
  if (
    typeof raw.confidence !== 'number' ||
    !Number.isFinite(raw.confidence) ||
    raw.confidence < 0 ||
    raw.confidence > 1
  ) {
    return { ok: false, reason: 'confidence_out_of_range' };
  }
  if (!Array.isArray(raw.evidence_ids) || raw.evidence_ids.length > MAX_EVIDENCE_IDS) {
    return { ok: false, reason: 'evidence_ids_out_of_schema' };
  }
  for (const id of raw.evidence_ids) {
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_EVIDENCE_ID_CHARS) {
      return { ok: false, reason: 'evidence_ids_out_of_schema' };
    }
  }
  if (!LUNA_SCOPES.includes(raw.scope as LunaCoachDecision['scope'])) {
    return { ok: false, reason: 'scope_out_of_schema' };
  }
  if (
    typeof raw.reason_code !== 'string' ||
    REASON_CODE_PRESENCE[raw.reason_code as LunaCoachReasonCode] !== true
  ) {
    return { ok: false, reason: 'reason_code_out_of_schema' };
  }
  if (
    typeof raw.valid_for_ms !== 'number' ||
    !Number.isInteger(raw.valid_for_ms) ||
    raw.valid_for_ms < 0
  ) {
    return { ok: false, reason: 'valid_for_ms_out_of_schema' };
  }

  return {
    ok: true,
    // Rebuilt field by field: the returned object shares no reference with the
    // input, so nothing unexamined can ride along on the prototype or in a key
    // this function did not check.
    decision: {
      decision: raw.decision as LunaCoachDecision['decision'],
      tip_code: raw.tip_code as LunaCoachTipCode,
      confidence: raw.confidence,
      evidence_ids: [...(raw.evidence_ids as string[])],
      scope: raw.scope as LunaCoachDecision['scope'],
      reason_code: raw.reason_code as LunaCoachReasonCode,
      valid_for_ms: raw.valid_for_ms,
    },
  };
}
