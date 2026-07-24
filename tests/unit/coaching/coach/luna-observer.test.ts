/**
 * §22 request assembly, §23.1 local validation, §23.2 failure behaviour,
 * §20.3 scheduling.
 *
 * The §23.1 block is the important one. Each case mutates exactly **one** field
 * of an input that is otherwise accepted, and asserts the specific rejection
 * name. `expectAcceptedBaseline()` runs inside every case, so a rejection that
 * happened for a different reason — or a validator that rejected everything —
 * fails rather than passing as "no tip appeared".
 */
import { describe, expect, it, vi } from 'vitest';
import {
  COACH_REQUEST_BOUNDS,
  LunaCoachObserver,
  buildCoachRequest,
  shouldConsultLuna,
  validateCoachDecision,
  type CoachDecisionExpectation,
  type CoachObserverResponse,
  type CoachRequestInput,
  type DecisionRejection,
} from '../../../../src/shared/coaching/coach';
import type { LunaCoachRequest } from '../../../../src/shared/contracts/coaching';
import { EPOCH, TAKE, candidate, coachRequest, decision, liveState } from './fixtures';

/* ---------------------------------------------------------------------------
 * §23.1
 * ------------------------------------------------------------------------- */

function expectation(overrides: Partial<CoachDecisionExpectation> = {}): CoachDecisionExpectation {
  return {
    request: coachRequest(),
    audioTimeMs: 11_000,
    currentTrackingEpoch: EPOCH,
    currentTakePassId: TAKE,
    state: liveState(),
    mode: 'coach',
    deliveryStyle: 'natural',
    candidates: [candidate()],
    ...overrides,
  };
}

/** The control: this exact input produces a tip. */
function expectAcceptedBaseline(): void {
  const result = validateCoachDecision(decision(), expectation());
  expect(result.ok, 'baseline must be accepted or the rejection cases prove nothing').toBe(true);
  if (!result.ok) return;
  expect(result.selection?.code).toBe('PACE_EASE_BACK');
}

function expectRejection(
  raw: unknown,
  overrides: Partial<CoachDecisionExpectation>,
  reason: DecisionRejection,
): void {
  expectAcceptedBaseline();
  const result = validateCoachDecision(raw, expectation(overrides));
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toBe(reason);
}

describe('§23.1 local response validation', () => {
  it('accepts a well-formed, current, permitted decision', () => {
    const result = validateCoachDecision(decision(), expectation());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.selection).toEqual({
      code: 'PACE_EASE_BACK',
      confidence: 0.8,
      evidenceIds: ['ev-1'],
      scope: 'current_phrase',
      reasonCode: 'HIGH_VALUE_LOCAL_PATTERN',
      validForMs: 5_000,
    });
  });

  it('rejects a response whose tracking epoch is old', () => {
    expectRejection(decision(), { currentTrackingEpoch: EPOCH + 1 }, 'stale_epoch');
  });

  it('rejects a response from a previous take pass', () => {
    expectRejection(decision(), { currentTakePassId: 'take-2' }, 'stale_take_pass');
  });

  it('rejects a response that arrived after validUntilAudioTimeMs (§20.5)', () => {
    // One millisecond inside the window is still applied…
    const inside = validateCoachDecision(decision(), expectation({ audioTimeMs: 14_000 }));
    expect(inside.ok).toBe(true);
    // …and one millisecond outside it is not.
    expectRejection(decision(), { audioTimeMs: 14_001 }, 'past_valid_until');
  });

  it("rejects a response whose own valid_for_ms has expired", () => {
    // validUntil pushed out so only the model's own claim can expire.
    const request: LunaCoachRequest = coachRequest({ validUntilAudioTimeMs: 999_999 });
    expectAcceptedBaseline();

    const stillValid = validateCoachDecision(
      decision({ valid_for_ms: 1_000 }),
      expectation({ request, audioTimeMs: 11_000 }),
    );
    expect(stillValid.ok).toBe(true);

    const expired = validateCoachDecision(
      decision({ valid_for_ms: 999 }),
      expectation({ request, audioTimeMs: 11_000 }),
    );
    expect(expired.ok).toBe(false);
    if (expired.ok) return;
    expect(expired.reason).toBe('valid_for_expired');
  });

  it('rejects a decision that disagrees with its own tip code, both ways', () => {
    expectRejection(
      decision({ decision: 'candidate', tip_code: 'NONE' }),
      {},
      'decision_tip_code_disagreement',
    );
    expectRejection(
      decision({ decision: 'none', tip_code: 'PACE_EASE_BACK' }),
      {},
      'decision_tip_code_disagreement',
    );
  });

  it('rejects a candidate decision that cites no evidence', () => {
    expectRejection(decision({ evidence_ids: [] }), {}, 'evidence_ids_required');
  });

  it('rejects an evidence id the local layer never produced', () => {
    expectRejection(decision({ evidence_ids: ['ev-invented'] }), {}, 'unknown_evidence_id');
  });

  it('rejects evidence a local deterministic rule already invalidated', () => {
    expectRejection(
      decision(),
      { invalidatedEvidenceIds: new Set(['ev-1']) },
      'locally_invalidated_evidence',
    );
    // The same set naming a different id does not block it.
    const other = validateCoachDecision(
      decision(),
      expectation({ invalidatedEvidenceIds: new Set(['ev-other']) }),
    );
    expect(other.ok).toBe(true);
  });

  it('rejects evidence whose stamp belongs to another epoch', () => {
    const stale = candidate({ stamp: { ...candidate().stamp, trackingEpoch: EPOCH - 1 } });
    expectRejection(decision(), { candidates: [stale] }, 'stale_evidence');
  });

  it('rejects evidence whose stamp belongs to another take pass', () => {
    const stale = candidate({ stamp: { ...candidate().stamp, takePassId: 'take-0' } });
    expectRejection(decision(), { candidates: [stale] }, 'stale_evidence');
  });

  it('rejects a code the local candidate types do not admit', () => {
    // A pace candidate cannot authorize a critical-number alert.
    expectRejection(
      decision({ tip_code: 'CRITICAL_NUMBER', confidence: 0.95 }),
      {},
      'code_not_permitted_by_candidates',
    );
    // With the matching candidate present, the same code is admitted — proving
    // the rejection was about admissibility and not about the code itself.
    const fidelity = candidate({ type: 'critical_number_mismatch', localConfidence: 0.95 });
    const allowed = validateCoachDecision(
      decision({ tip_code: 'CRITICAL_NUMBER', confidence: 0.95 }),
      expectation({ candidates: [fidelity] }),
    );
    expect(allowed.ok).toBe(true);
  });

  it('rejects confidence below the per-code floor, at the boundary', () => {
    // PACE_EASE_BACK floor is 0.6.
    const atFloor = validateCoachDecision(decision({ confidence: 0.6 }), expectation());
    expect(atFloor.ok).toBe(true);
    expectRejection(decision({ confidence: 0.59 }), {}, 'confidence_below_code_floor');
  });

  it('applies a *higher* floor to the critical codes', () => {
    const fidelity = candidate({ type: 'critical_name_mismatch', localConfidence: 0.95 });
    const below = validateCoachDecision(
      decision({ tip_code: 'CRITICAL_NAME', confidence: 0.84 }),
      expectation({ candidates: [fidelity] }),
    );
    expect(below.ok).toBe(false);
    if (below.ok) return;
    expect(below.reason).toBe('confidence_below_code_floor');

    const atFloor = validateCoachDecision(
      decision({ tip_code: 'CRITICAL_NAME', confidence: 0.85 }),
      expectation({ candidates: [fidelity] }),
    );
    expect(atFloor.ok).toBe(true);
  });

  it.each([
    ['a voice command is active', { commandActive: true }],
    ['a retake is pending', { retakeState: 'pending' as const }],
    ['tracking is reacquiring', { reacquiring: true }],
    ['the microphone is unhealthy', { microphoneHealthy: false }],
    ['alignment confidence is low', { alignmentConfidence: 0.2 }],
  ])('rejects an ordinary code while %s', (_label, statePatch) => {
    expectRejection(decision(), { state: liveState(statePatch) }, 'suppressed_by_state');
  });

  it('§2.6: a "none" decision validates successfully with no selection', () => {
    const result = validateCoachDecision(
      decision({ decision: 'none', tip_code: 'NONE', reason_code: 'NO_ACTIONABLE_ISSUE' }),
      expectation(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.selection).toBeNull();
  });

  it('rejects a system code even when it is otherwise well formed', () => {
    // MIC_CLIPPING is not in LunaCoachTipCode, so the schema catches it first —
    // and that is the point: Luna has no path to a local acoustic claim.
    const result = validateCoachDecision(
      { ...decision(), tip_code: 'MIC_CLIPPING' },
      expectation({ candidates: [candidate({ type: 'system_mic_clipping' })] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('tip_code_out_of_schema');
  });
});

/* ---------------------------------------------------------------------------
 * §22
 * ------------------------------------------------------------------------- */

function requestInput(overrides: Partial<CoachRequestInput> = {}): CoachRequestInput {
  const template = coachRequest();
  return {
    sessionId: template.sessionId,
    scriptId: template.scriptId,
    scriptRevision: template.scriptRevision,
    trackingEpoch: EPOCH,
    takePassId: TAKE,
    requestAudioTimeMs: 10_000,
    language: 'en',
    state: liveState(),
    profile: template.profile,
    authoredSpans: [],
    speech: template.speech,
    metrics: template.metrics,
    candidates: [candidate()],
    ...overrides,
  };
}

describe('§22 request assembly', () => {
  it('sets validUntilAudioTimeMs so a late answer is discarded, not applied', () => {
    const request = buildCoachRequest(requestInput());
    expect(request.validUntilAudioTimeMs).toBe(
      10_000 + COACH_REQUEST_BOUNDS.defaultValidityMs,
    );
    // And the validator actually enforces it.
    const late = validateCoachDecision(
      decision(),
      expectation({ request, audioTimeMs: request.validUntilAudioTimeMs + 1 }),
    );
    expect(late.ok).toBe(false);
  });

  it('bounds authored spans, speech, and candidates (§20.4)', () => {
    const request = buildCoachRequest(
      requestInput({
        authoredSpans: Array.from({ length: 9 }, (_, index) => ({
          spanId: `span-${index}`,
          text: 'x'.repeat(2_000),
          criticalTokens: Array.from({ length: 30 }, (_, i) => `t${i}`),
          emphasisTokens: Array.from({ length: 30 }, (_, i) => `e${i}`),
          punctuationClass: 'strong' as const,
          coachingDisabled: false,
        })),
        speech: {
          finalText: 'y'.repeat(5_000),
          provisionalTail: 'z'.repeat(5_000),
          finalAudioStartMs: 0,
          finalAudioEndMs: 9_000,
        },
        candidates: Array.from({ length: 20 }, (_, index) =>
          candidate({ evidenceId: `ev-${index}`, spokenFragment: 'w'.repeat(900) }),
        ),
      }),
    );

    expect(request.authoredSpans).toHaveLength(COACH_REQUEST_BOUNDS.maxAuthoredSpans);
    expect(request.authoredSpans[0]?.text.length).toBe(COACH_REQUEST_BOUNDS.maxAuthoredSpanChars);
    expect(request.authoredSpans[0]?.criticalTokens).toHaveLength(
      COACH_REQUEST_BOUNDS.maxCriticalTokens,
    );
    expect(request.speech.finalText.length).toBe(COACH_REQUEST_BOUNDS.maxFinalTextChars);
    expect(request.speech.provisionalTail.length).toBe(
      COACH_REQUEST_BOUNDS.maxProvisionalTailChars,
    );
    expect(request.candidates).toHaveLength(COACH_REQUEST_BOUNDS.maxCandidates);
    expect(request.candidates[0]?.spokenFragment.length).toBe(
      COACH_REQUEST_BOUNDS.maxFragmentChars,
    );
  });

  it('keeps the tail of the transcript, not the head', () => {
    const request = buildCoachRequest(
      requestInput({
        speech: {
          finalText: `${'old '.repeat(600)}the newest words`,
          provisionalTail: '',
          finalAudioStartMs: 0,
          finalAudioEndMs: 9_000,
        },
      }),
    );
    expect(request.speech.finalText.endsWith('the newest words')).toBe(true);
  });

  it('carries evidence ids and stamps through to the wire candidates', () => {
    const request = buildCoachRequest(requestInput());
    expect(request.candidates[0]).toMatchObject({
      evidenceId: 'ev-1',
      type: 'pace_too_fast',
      audioStartMs: 1_000,
      audioEndMs: 9_000,
    });
  });
});

describe('§20.2 when to consult Luna', () => {
  it('never calls for a lone acoustic measurement', () => {
    expect(shouldConsultLuna([])).toBe(false);
    expect(shouldConsultLuna([candidate({ type: 'pace_too_fast' })])).toBe(false);
    expect(shouldConsultLuna([candidate({ type: 'low_variety' })])).toBe(false);
  });

  it('calls when semantic judgement or arbitration is actually needed', () => {
    expect(shouldConsultLuna([candidate({ type: 'contextual_filler' })])).toBe(true);
    expect(shouldConsultLuna([candidate({ type: 'material_meaning_change' })])).toBe(true);
    expect(
      shouldConsultLuna([
        candidate({ evidenceId: 'a', type: 'pace_too_fast' }),
        candidate({ evidenceId: 'b', type: 'low_variety' }),
      ]),
    ).toBe(true);
  });
});

/* ---------------------------------------------------------------------------
 * §20.3 / §23.2
 * ------------------------------------------------------------------------- */

function observerWith(
  classify: (request: LunaCoachRequest) => Promise<CoachObserverResponse>,
  deps: Partial<ConstructorParameters<typeof LunaCoachObserver>[0]> = {},
) {
  const cancel = vi.fn();
  const observer = new LunaCoachObserver({
    transport: { classify, cancel },
    ...deps,
  });
  return { observer, cancel };
}

describe('§20.3 scheduling', () => {
  const ok = async (): Promise<CoachObserverResponse> => ({ result: decision() });

  it('coalesces for the configured window before issuing', () => {
    const classify = vi.fn(ok);
    const { observer } = observerWith(classify);
    observer.observe(requestInput({ requestAudioTimeMs: 0 }));
    expect(observer.tick(799)).toBe(false);
    expect(classify).not.toHaveBeenCalled();
    expect(observer.tick(800)).toBe(true);
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('holds to one request every three seconds', async () => {
    const classify = vi.fn(ok);
    const { observer } = observerWith(classify);
    observer.observe(requestInput({ requestAudioTimeMs: 0 }));
    expect(observer.tick(1_000)).toBe(true);
    await observer.settle();

    observer.observe(requestInput({ requestAudioTimeMs: 1_000 }));
    expect(observer.tick(3_999)).toBe(false);
    expect(observer.tick(4_000)).toBe(true);
    expect(classify).toHaveBeenCalledTimes(2);
  });

  it('stops at twelve requests per minute in standard mode', async () => {
    const classify = vi.fn(ok);
    const { observer } = observerWith(classify);
    for (let i = 0; i < 20; i++) {
      const at = i * 3_100;
      observer.observe(requestInput({ requestAudioTimeMs: at - 1_000 }));
      observer.tick(at);
      await observer.settle();
    }
    expect(classify.mock.calls.length).toBe(12);
  });

  it('never calls when the shared budget is exhausted', () => {
    const classify = vi.fn(ok);
    const { observer } = observerWith(classify, { isBudgetExhausted: () => true });
    observer.observe(requestInput({ requestAudioTimeMs: 0 }));
    expect(observer.tick(5_000)).toBe(false);
    expect(classify).not.toHaveBeenCalled();
    expect(observer.getDiagnostics().availability).toBe('budget_exhausted');
  });

  it('stops at the per-take request ceiling', async () => {
    const classify = vi.fn(ok);
    const { observer } = observerWith(classify, { maxRequestsPerTake: 2 });
    for (let i = 0; i < 5; i++) {
      const at = i * 4_000;
      observer.observe(requestInput({ requestAudioTimeMs: at - 1_000 }));
      observer.tick(at);
      await observer.settle();
    }
    expect(classify).toHaveBeenCalledTimes(2);
    expect(observer.getDiagnostics().availability).toBe('budget_exhausted');
  });

  it('discards an answer that arrives after cancellation', async () => {
    const gate: { resolve?: (value: CoachObserverResponse) => void } = {};
    const onSelection = vi.fn();
    const { observer } = observerWith(
      () =>
        new Promise<CoachObserverResponse>((r) => {
          gate.resolve = r;
        }),
      { onSelection },
    );
    observer.observe(requestInput({ requestAudioTimeMs: 0 }));
    expect(observer.tick(1_000)).toBe(true);

    observer.cancelAll(); // retake, epoch change, take end
    gate.resolve?.({ result: decision() });
    await observer.settle();
    expect(onSelection).not.toHaveBeenCalled();
  });
});

describe('§23.2 refusal and API failure produce no tip', () => {
  it('treats a refusal as a rejection, not a tip, and never reads its text', () => {
    const { observer } = observerWith(async () => ({ result: null }));
    const result = observer.applyResponse(
      { result: null, refusal: 'I cannot help with evaluating a person like that.' },
      expectation(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('model_refusal');
    expect(JSON.stringify(result)).not.toContain('cannot help');
    expect(observer.getDiagnostics().refusals).toBe(1);
  });

  it('produces no tip for a malformed body', () => {
    const onSelection = vi.fn();
    const { observer } = observerWith(async () => ({ result: null }), { onSelection });
    const result = observer.applyResponse({ result: { garbage: true } }, expectation());
    expect(result.ok).toBe(false);
    expect(onSelection).not.toHaveBeenCalled();
  });

  it.each([
    ['NETWORK_TIMEOUT', 'degraded_timeout'],
    ['RATE_LIMITED', 'degraded_rate_limited'],
    ['QUOTA_EXHAUSTED', 'degraded_quota'],
    ['SOMETHING_ELSE', 'degraded_unavailable'],
  ])('backs off after a %s failure without emitting anything', async (code, availability) => {
    const onSelection = vi.fn();
    const { observer } = observerWith(
      () => Promise.reject(Object.assign(new Error('boom'), { code })),
      { onSelection },
    );
    observer.observe(requestInput({ requestAudioTimeMs: 0 }));
    observer.tick(1_000);
    await observer.settle();

    expect(onSelection).not.toHaveBeenCalled();
    const diagnostics = observer.getDiagnostics();
    expect(diagnostics.failures).toBe(1);
    expect(diagnostics.availability).toBe(availability);

    // A backoff is in force: the next observation does not fire immediately…
    observer.observe(requestInput({ requestAudioTimeMs: 1_000 }));
    expect(observer.tick(2_000)).toBe(false);
    // …and it does fire once the backoff has elapsed.
    observer.observe(requestInput({ requestAudioTimeMs: 100_000 }));
    expect(observer.tick(500_000)).toBe(true);
  });

  it('emits the validated selection on success', async () => {
    const onSelection = vi.fn();
    const { observer } = observerWith(async () => ({ result: decision() }), { onSelection });
    observer.observe(requestInput({ requestAudioTimeMs: 0 }));
    expect(observer.tick(1_000)).toBe(true);
    await observer.settle();
    expect(onSelection).toHaveBeenCalledTimes(1);
    expect(onSelection.mock.calls[0]?.[0]).toMatchObject({ code: 'PACE_EASE_BACK' });
  });
});
