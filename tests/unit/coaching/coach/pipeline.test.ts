/**
 * End-to-end: Luna decision → local validation → policy → `CoachRailState`.
 *
 * The unit tests prove each gate. This file proves they are actually wired
 * together in that order, which is the failure the individual suites cannot
 * see: a validator that is never called, or a tip built from something other
 * than the authored catalog.
 */
import { describe, expect, it } from 'vitest';
import {
  CoachRailStateBuilder,
  CoachTipPolicy,
  initialFillerState,
  initialMicrophoneState,
  initialPaceState,
  initialVarietyState,
  renderTipText,
  validateCoachDecision,
  type CoachDecisionExpectation,
} from '../../../../src/shared/coaching/coach';
import type { CoachRailState } from '../../../../src/shared/contracts/coaching';
import type { Uuid } from '../../../../src/shared/contracts/core';
import { EPOCH, TAKE, candidate, coachRequest, context, decision, liveState } from './fixtures';

const SESSION = '11111111-1111-4111-8111-111111111111' as Uuid;
const PROSE = 'Honestly you sound anxious; take a breath and stop saying um so much.';

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

/** The whole loop, in the order the product runs it. */
function runLoop(raw: unknown, exp = expectation()): CoachRailState {
  const policy = new CoachTipPolicy();
  const builder = new CoachRailStateBuilder(SESSION);
  const validation = validateCoachDecision(raw, exp);

  if (validation.ok && validation.selection !== null) {
    policy.propose(
      [
        {
          candidate: exp.candidates[0]!,
          source: 'luna_validated',
          lunaConfidence: validation.selection.confidence,
        },
      ],
      context({ audioTimeMs: exp.audioTimeMs }),
    );
  }

  return builder.build({
    sessionId: SESSION,
    takePassId: TAKE,
    mode: 'coach',
    visible: true,
    mirrored: false,
    reducedMotion: false,
    pace: initialPaceState(115, 160),
    variety: initialVarietyState(45, 75),
    fillers: initialFillerState(),
    microphone: initialMicrophoneState(),
    activeTip: policy.getActiveTip(),
    ribbonEvents: [],
    audioTimeMs: exp.audioTimeMs,
  });
}

describe('accepted decision', () => {
  it('produces one tip whose copy comes from the authored catalog', () => {
    const state = runLoop(decision());
    expect(state.activeTip).not.toBeNull();
    expect(state.activeTip?.code).toBe('PACE_EASE_BACK');
    expect(state.activeTip?.textKey).toBe('coach.tip.PACE_EASE_BACK');
    expect(state.activeTip?.source).toBe('luna_validated');
    expect(state.activeTip?.interpolations).toEqual({});
    expect(
      renderTipText({
        code: 'PACE_EASE_BACK',
        textKey: state.activeTip!.textKey,
        interpolations: {},
      }),
    ).toBe('Ease back slightly');
  });
});

describe('the copy boundary, end to end', () => {
  it('lets nothing of a prose field reach the rail', () => {
    const state = runLoop({ ...decision(), coach_message: PROSE });
    expect(state.activeTip).toBeNull();
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain('anxious');
    expect(serialized).not.toContain('breath');
    expect(serialized).not.toContain(PROSE);
  });

  it('ignores prose even when the decision itself is acceptable', () => {
    // Same decision, plus prose: the prose alone flips the outcome, which is
    // what proves the strict parse is on the live path and not bypassed.
    expect(runLoop(decision()).activeTip).not.toBeNull();
    expect(runLoop({ ...decision(), rationale: PROSE }).activeTip).toBeNull();
  });
});

describe('§2.6 silence', () => {
  it('renders a complete, quiet rail when Luna returns none', () => {
    const state = runLoop(
      decision({ decision: 'none', tip_code: 'NONE', reason_code: 'NO_ACTIONABLE_ISSUE' }),
    );
    expect(state.activeTip).toBeNull();
    // The telemetry tiles are still present and still honest.
    expect(state.pace.state).toBe('learning');
    expect(state.pace.wpm).toBeNull();
    expect(state.visible).toBe(true);
    expect(state.stageRevision).toBe(1);
  });
});

describe('a late answer is discarded, not applied', () => {
  it('shows nothing when the answer lands past validUntilAudioTimeMs', () => {
    const late = expectation({ audioTimeMs: coachRequest().validUntilAudioTimeMs + 1 });
    expect(runLoop(decision(), late).activeTip).toBeNull();
    // The same answer inside the window does produce a tip.
    expect(runLoop(decision(), expectation({ audioTimeMs: 13_999 })).activeTip).not.toBeNull();
  });

  it('shows nothing when the epoch moved while the answer was in flight', () => {
    expect(runLoop(decision(), expectation({ currentTrackingEpoch: EPOCH + 1 })).activeTip).toBeNull();
  });
});
