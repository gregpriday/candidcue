/**
 * Shared builders for the coach-layer tests.
 *
 * Deliberately *not* a `.test.ts` file so vitest does not collect it. Every
 * builder produces an input that would otherwise succeed, so a test that
 * changes one field proves that field caused the outcome.
 */
import type {
  CoachCandidate,
  CoachCandidateType,
  LunaCoachDecision,
  LunaCoachRequest,
} from '../../../../src/shared/contracts/coaching';
import type {
  CoachLiveState,
  CoachPolicyContext,
  CoachRequestInput,
} from '../../../../src/shared/coaching/coach';

export const EPOCH = 7;
export const TAKE = 'take-1';

export function candidate(overrides: Partial<CoachCandidate> = {}): CoachCandidate {
  const type: CoachCandidateType = overrides.type ?? 'pace_too_fast';
  return {
    evidenceId: 'ev-1',
    type,
    localConfidence: 0.9,
    stamp: {
      audioStartMs: 1_000,
      audioEndMs: 9_000,
      commitSequence: 4,
      trackingEpoch: EPOCH,
      takePassId: TAKE,
      ...overrides.stamp,
    },
    scriptSpanId: 'span-3',
    scriptAnchorTokenId: null,
    contributingEventIds: [],
    detailCode: 'sustained',
    spokenFragment: 'we shipped it last week',
    authoredFragment: 'we shipped it last week',
    finalEvidence: true,
    ...overrides,
  };
}

export function liveState(overrides: Partial<CoachLiveState> = {}): CoachLiveState {
  return {
    alignmentConfidence: 0.9,
    commandActive: false,
    retakeState: 'none',
    reacquiring: false,
    microphoneHealthy: true,
    ...overrides,
  };
}

/** A context in which an ordinary tip is admissible. */
export function context(overrides: Partial<CoachPolicyContext> = {}): CoachPolicyContext {
  return {
    audioTimeMs: 10_000,
    mode: 'coach',
    trackingEpoch: EPOCH,
    takePassId: TAKE,
    deliveryStyle: 'natural',
    liveTipFrequency: 'normal',
    coachingEnabled: true,
    liveTipsEnabled: true,
    positiveReinforcementEnabled: false,
    state: liveState(overrides.state),
    safeMoment: true,
    activeScriptSpanId: 'span-3',
    ...overrides,
  };
}

export function coachRequest(overrides: Partial<LunaCoachRequest> = {}): LunaCoachRequest {
  return {
    schemaVersion: '1.0',
    sessionId: '11111111-1111-4111-8111-111111111111',
    scriptId: '22222222-2222-4222-8222-222222222222',
    scriptRevision: 3,
    trackingEpoch: EPOCH,
    takePassId: TAKE,
    requestAudioTimeMs: 10_000,
    validUntilAudioTimeMs: 14_000,
    language: 'en',
    state: liveState(),
    profile: {
      coachingMode: 'coach',
      deliveryStyle: 'natural',
      targetWpmLow: 115,
      targetWpmHigh: 160,
      targetVarietyLow: 45,
      targetVarietyHigh: 75,
      liveTipFrequency: 'normal',
    },
    authoredSpans: [],
    speech: {
      finalText: 'we shipped it last week',
      provisionalTail: '',
      finalAudioStartMs: 1_000,
      finalAudioEndMs: 9_000,
    },
    metrics: {
      displayWpm: 180,
      paceState: 'fast',
      pacePersistenceMs: 8_000,
      terminalRushRatio: null,
      varietyLevel: 60,
      varietyState: 'balanced',
      varietyPersistenceMs: 20_000,
      cadenceBalance: null,
      runOnCount: 0,
      choppyPauseCount: 0,
      confirmedFillersLast20s: 0,
      confirmedFillersLast60s: 0,
    },
    candidates: [],
    ...overrides,
  };
}

/**
 * The observer's input, matching {@link coachRequest}.
 *
 * Shared rather than per-file so a test that drives the real `observe → tick →
 * transport → apply` path uses the same values as the ones that hand-build an
 * expectation, and a divergence between the two shows up as a failure instead
 * of as a test that quietly proves nothing.
 */
export function requestInput(overrides: Partial<CoachRequestInput> = {}): CoachRequestInput {
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

/** A decision that {@link validateCoachDecision} accepts as-is. */
export function decision(overrides: Partial<LunaCoachDecision> = {}): LunaCoachDecision {
  return {
    decision: 'candidate',
    tip_code: 'PACE_EASE_BACK',
    confidence: 0.8,
    evidence_ids: ['ev-1'],
    scope: 'current_phrase',
    reason_code: 'HIGH_VALUE_LOCAL_PATTERN',
    valid_for_ms: 5_000,
    ...overrides,
  };
}
