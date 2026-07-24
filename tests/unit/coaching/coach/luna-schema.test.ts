/**
 * §23 structured output and the wire-shape parser.
 *
 * The load-bearing test here is the copy boundary: a response carrying
 * model-authored prose in an unexpected field must be rejected *by name*, and
 * the prose must not survive into the parsed object. A parser that returned a
 * constant would fail the round-trip test; one that returned the input
 * unchanged would fail the additional-property test.
 */
import { describe, expect, it } from 'vitest';
import {
  COACH_DECISION_RESPONSE_FORMAT,
  COACH_OBSERVER_SYSTEM_PROMPT,
  LUNA_REASON_CODES,
  LUNA_TIP_CODES,
  parseCoachDecision,
} from '../../../../src/shared/coaching/coach';
import { decision } from './fixtures';

describe('§23 response format', () => {
  it('is strict with additionalProperties disabled and every field required', () => {
    expect(COACH_DECISION_RESPONSE_FORMAT.name).toBe('candidcue_live_coach_decision_v1');
    expect(COACH_DECISION_RESPONSE_FORMAT.strict).toBe(true);
    expect(COACH_DECISION_RESPONSE_FORMAT.schema.additionalProperties).toBe(false);
    expect([...COACH_DECISION_RESPONSE_FORMAT.schema.required].sort()).toEqual(
      Object.keys(COACH_DECISION_RESPONSE_FORMAT.schema.properties).sort(),
    );
  });

  it('enumerates exactly the §23 tip and reason codes', () => {
    expect(LUNA_TIP_CODES).toContain('NONE');
    expect(LUNA_TIP_CODES).toHaveLength(17);
    // The contract's narrower Luna set: system and positive codes are absent.
    expect(LUNA_TIP_CODES).not.toContain('MIC_CLIPPING');
    expect(LUNA_TIP_CODES).not.toContain('POSITIVE_PACE');
    expect(LUNA_REASON_CODES).toHaveLength(11);
    expect(LUNA_REASON_CODES).toContain('NO_ACTIONABLE_ISSUE');
  });

  it('§21: the system prompt keeps the authority boundaries verbatim', () => {
    expect(COACH_OBSERVER_SYSTEM_PROMPT).toContain('silence is valid and usually preferred');
    expect(COACH_OBSERVER_SYSTEM_PROMPT).toContain('You do not generate the user-facing tip text');
    expect(COACH_OBSERVER_SYSTEM_PROMPT).toContain(
      'You do not control scrolling, script position, navigation',
    );
    expect(COACH_OBSERVER_SYSTEM_PROMPT).toContain('Choose no more than one tip');
  });
});

describe('parseCoachDecision — wire shape', () => {
  it('accepts and rebuilds a well-formed snake_case decision', () => {
    const result = parseCoachDecision(decision());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.tip_code).toBe('PACE_EASE_BACK');
    expect(result.decision.evidence_ids).toEqual(['ev-1']);
    // Rebuilt, not aliased: mutating the parse result cannot touch the input.
    const source = decision();
    const parsed = parseCoachDecision(source);
    if (parsed.ok) parsed.decision.evidence_ids.push('injected');
    expect(source.evidence_ids).toEqual(['ev-1']);
  });

  it('rejects a camelCase payload — the wire shape is snake_case on purpose', () => {
    const camel = {
      decision: 'candidate',
      tipCode: 'PACE_EASE_BACK',
      confidence: 0.8,
      evidenceIds: ['ev-1'],
      scope: 'current_phrase',
      reasonCode: 'HIGH_VALUE_LOCAL_PATTERN',
      validForMs: 5_000,
    };
    const result = parseCoachDecision(camel);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('additional_property:tipCode');
  });

  it.each([
    [{ decision: 'maybe' }, 'decision_out_of_schema'],
    [{ tip_code: 'BE_MORE_CONFIDENT' }, 'tip_code_out_of_schema'],
    [{ confidence: 1.4 }, 'confidence_out_of_range'],
    [{ confidence: 'high' }, 'confidence_out_of_range'],
    [{ evidence_ids: 'ev-1' }, 'evidence_ids_out_of_schema'],
    [{ evidence_ids: [42] }, 'evidence_ids_out_of_schema'],
    [{ scope: 'whole_take' }, 'scope_out_of_schema'],
    [{ reason_code: 'BECAUSE_I_SAID_SO' }, 'reason_code_out_of_schema'],
    [{ valid_for_ms: 1.5 }, 'valid_for_ms_out_of_schema'],
    [{ valid_for_ms: -1 }, 'valid_for_ms_out_of_schema'],
  ])('rejects %o for the stated reason', (patch, reason) => {
    const result = parseCoachDecision({ ...decision(), ...patch });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(reason);
  });

  it.each([null, undefined, 'a string', 42, ['array']])('rejects %o as not an object', (raw) => {
    const result = parseCoachDecision(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not_an_object');
  });
});

describe('the copy boundary', () => {
  const PROSE = 'You sound nervous — try to relax and slow down, you are doing great!';

  it.each(['message', 'tip_text', 'explanation', 'coaching_copy', 'note'])(
    'rejects model prose smuggled in a %s field',
    (field) => {
      const result = parseCoachDecision({ ...decision(), [field]: PROSE });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe(`additional_property:${field}`);
      // Nothing of the prose survives the rejection.
      expect(JSON.stringify(result)).not.toContain('nervous');
    },
  );

  it('drops prose even when the rest of the payload is perfect', () => {
    const raw = { ...decision(), rationale: PROSE };
    const result = parseCoachDecision(raw);
    expect(result.ok).toBe(false);
    // The identical payload without the extra field is accepted, which proves
    // the extra field — not some other defect — caused the rejection.
    expect(parseCoachDecision(decision()).ok).toBe(true);
  });

  it('carries no free-text field at all in an accepted decision', () => {
    const result = parseCoachDecision(decision());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const values = Object.values(result.decision).flat();
    for (const value of values) {
      if (typeof value !== 'string') continue;
      // Every string in the decision is an enum member or an opaque id.
      expect(value.includes(' ')).toBe(false);
    }
  });
});
