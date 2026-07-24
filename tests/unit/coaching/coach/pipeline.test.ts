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
  LunaCoachObserver,
  initialFillerState,
  initialMicrophoneState,
  initialPaceState,
  initialVarietyState,
  renderTipText,
  validateCoachDecision,
  type CoachDecisionExpectation,
  type CoachDecisionSelection,
  type CoachObserverResponse,
  type DecisionRejection,
} from '../../../../src/shared/coaching/coach';
import type { CoachRailState } from '../../../../src/shared/contracts/coaching';
import type { Uuid } from '../../../../src/shared/contracts/core';
import {
  EPOCH,
  TAKE,
  candidate,
  coachRequest,
  context,
  decision,
  liveState,
  requestInput,
} from './fixtures';

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

/* ---------------------------------------------------------------------------
 * §23.1 staleness, driven through the real `observe → tick → transport → apply`
 * path.
 *
 * These used to hand-build a `CoachDecisionExpectation` with a late clock or a
 * moved epoch and call `validateCoachDecision` directly. That proves the
 * validator — which is worth proving, and the observer suite does it — but it
 * cannot prove the product property these tests are *named* for, and at the
 * time it was false: `issue()` built its expectation from issue-time values, so
 * `audioTimeMs` was frozen at the moment the request went out and
 * `currentTrackingEpoch` was copied off the request itself. Nothing the
 * transport did afterwards, however long it took, could be observed.
 *
 * So the transport here is deliberately deferred: the request is issued, the
 * *world* then moves (clock, epoch), and only then does the answer arrive.
 * ------------------------------------------------------------------------- */

interface Deferred {
  observer: LunaCoachObserver;
  live: { audioTimeMs: number; trackingEpoch: number; takePassId: string };
  resolve: (response: CoachObserverResponse) => void;
  selections: CoachDecisionSelection[];
  rejections: DecisionRejection[];
}

/** Issues one request and hands back the levers to move the world with. */
function issuedRequest(input = requestInput()): Deferred {
  const live = { audioTimeMs: input.requestAudioTimeMs, trackingEpoch: EPOCH, takePassId: TAKE };
  const selections: CoachDecisionSelection[] = [];
  const rejections: DecisionRejection[] = [];
  let resolve: ((response: CoachObserverResponse) => void) | null = null;

  const observer = new LunaCoachObserver({
    transport: {
      classify: () =>
        new Promise<CoachObserverResponse>((r) => {
          resolve = r;
        }),
      cancel: () => {},
    },
    liveContext: () => live,
    onSelection: (selection) => selections.push(selection),
    onRejection: (reason) => rejections.push(reason),
  });

  observer.observe(input);
  // Past the coalesce window: the request actually goes out.
  const issued = observer.tick(input.requestAudioTimeMs + 900);
  expect(issued, 'the request must be issued or the test proves nothing').toBe(true);
  expect(resolve).not.toBeNull();

  return {
    observer,
    live,
    resolve: resolve as unknown as (response: CoachObserverResponse) => void,
    selections,
    rejections,
  };
}

/** Renders whatever the observer selected, through the policy and the builder. */
function railFor(selections: readonly CoachDecisionSelection[], audioTimeMs: number): CoachRailState {
  const policy = new CoachTipPolicy();
  const builder = new CoachRailStateBuilder(SESSION);
  for (const selection of selections) {
    policy.propose(
      [{ candidate: candidate(), source: 'luna_validated', lunaConfidence: selection.confidence }],
      context({ audioTimeMs }),
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
    audioTimeMs,
  });
}

describe('a late answer is discarded, not applied', () => {
  it('applies an answer that arrives inside the request’s validity window', async () => {
    const run = issuedRequest();
    // 1.1 s of transport latency: well inside the 4 s window.
    run.live.audioTimeMs = 12_000;
    run.resolve({ result: decision() });
    await run.observer.settle();

    expect(run.rejections).toEqual([]);
    expect(run.selections.map((s) => s.code)).toEqual(['PACE_EASE_BACK']);
    expect(railFor(run.selections, run.live.audioTimeMs).activeTip).not.toBeNull();
  });

  it('discards an answer whose transport latency pushed it past validUntilAudioTimeMs', async () => {
    const run = issuedRequest();
    // Same request, same answer; the only difference is that the round trip
    // took long enough for the audio clock to leave the window.
    run.live.audioTimeMs = 14_001;
    run.resolve({ result: decision() });
    await run.observer.settle();

    expect(run.rejections).toEqual(['past_valid_until']);
    expect(run.selections).toEqual([]);
    expect(railFor(run.selections, run.live.audioTimeMs).activeTip).toBeNull();
  });

  it('discards an answer whose own valid_for_ms elapsed in transport', async () => {
    const run = issuedRequest();
    // The model claimed the answer was good for 1 s from the request time.
    run.live.audioTimeMs = 11_500;
    run.resolve({ result: decision({ valid_for_ms: 1_000 }) });
    await run.observer.settle();

    expect(run.rejections).toEqual(['valid_for_expired']);
    expect(run.selections).toEqual([]);
  });

  it('discards an answer when the epoch moved while it was in flight', async () => {
    const run = issuedRequest();
    // A re-anchor that did not go through `cancelAll` — the case the epoch
    // check exists for, and the one it could not previously see.
    run.live.trackingEpoch = EPOCH + 1;
    run.live.audioTimeMs = 11_000;
    run.resolve({ result: decision() });
    await run.observer.settle();

    expect(run.rejections).toEqual(['stale_epoch']);
    expect(run.selections).toEqual([]);
    expect(railFor(run.selections, run.live.audioTimeMs).activeTip).toBeNull();
  });

  it('discards an answer when the take pass changed while it was in flight', async () => {
    const run = issuedRequest();
    run.live.takePassId = 'take-2';
    run.live.audioTimeMs = 11_000;
    run.resolve({ result: decision() });
    await run.observer.settle();

    expect(run.rejections).toEqual(['stale_take_pass']);
    expect(run.selections).toEqual([]);
  });

  it('discards an answer citing evidence a local rule invalidated in flight', async () => {
    const run = issuedRequest();
    run.live.audioTimeMs = 11_000;
    // §23.1's last bullet: the demotion happens *while* the request is out,
    // which is the only time it can happen at all.
    (run.live as { invalidatedEvidenceIds?: ReadonlySet<string> }).invalidatedEvidenceIds = new Set([
      'ev-1',
    ]);
    run.resolve({ result: decision() });
    await run.observer.settle();

    expect(run.rejections).toEqual(['locally_invalidated_evidence']);
    expect(run.selections).toEqual([]);
  });
});
