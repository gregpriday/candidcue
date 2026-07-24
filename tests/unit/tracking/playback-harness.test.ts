/**
 * Deterministic playback harness over the Appendix D corpus
 * (companion §66, §66.1, §69, §83–§87).
 *
 * These are the acceptance gates, not micro-unit tests: each scenario replays
 * a whole recorded interaction and asserts the golden expectations plus the
 * §69 metric set. `prohibitedSectionJumpCount` is a release blocker (§69.7).
 */
import { describe, expect, it } from 'vitest';
import {
  checkGoldenExpectations,
  runPlayback,
  type PlaybackScenario,
} from '../../../src/shared/tracking/playback-harness';
import {
  allPlaybackScenarios,
  scenarioBriefAdlib,
  scenarioCommandToOtherChapter,
  scenarioDistantCollision,
  scenarioLargeWithinSectionSkip,
  scenarioPreviousSentenceRetake,
  scenarioSmoothRead,
} from '../../fixtures/alignment/playback-scenarios';

function run(scenario: PlaybackScenario) {
  const result = runPlayback(scenario);
  return { result, failures: checkGoldenExpectations(scenario, result) };
}

describe('playback harness: universal invariants (companion §66.1, §69)', () => {
  for (const scenario of allPlaybackScenarios()) {
    it(`${scenario.id} — ${scenario.description}`, () => {
      const { result, failures } = run(scenario);
      expect(failures, failures.join('\n')).toEqual([]);

      const { metrics } = result;
      // §69.7 — release blocker.
      expect(metrics.prohibitedSectionJumpCount).toBe(0);
      // §26.1 frame contract.
      expect(metrics.framesMonotone).toBe(true);
      expect(metrics.framesFinite).toBe(true);
      expect(metrics.frameCount).toBeGreaterThan(0);
      // §69.1 — every label must be met.
      expect(metrics.correctPositionRate).toBe(1);
      // The engine must actually have produced explanations (§65).
      expect(result.records.length).toBeGreaterThan(0);
    });
  }
});

describe('D.1 smooth read (§83)', () => {
  it('moves continuously and never jumps, retakes, or gets lost', () => {
    const { result } = run(scenarioSmoothRead());
    expect(result.metrics.behaviorsSeen).toContain('normal');
    expect(result.metrics.falseRetakeCount).toBe(0);
    expect(result.metrics.falseSkipCount).toBe(0);
    expect(result.metrics.timeToAcquireMs).not.toBeNull();
    expect(result.metrics.sectionsVisited).toEqual(['h0']);

    // §3.1: the estimate advances between transcript events, not only on them.
    const tickFrames = result.frames.filter((f) => f.behavior !== 'acquire');
    expect(tickFrames.length).toBeGreaterThan(result.records.length);
    let maxUnit = -Infinity;
    let monotone = true;
    for (const frame of result.frames) {
      if (frame.estimatedUnit < maxUnit - 1e-6) monotone = false;
      maxUnit = Math.max(maxUnit, frame.estimatedUnit);
    }
    expect(monotone, 'a clean forward read must never move backward').toBe(true);
  });
});

describe('D.2 brief ad-lib (§85)', () => {
  it('drift is bounded, speech alone does not consume script, and it settles', () => {
    const { result } = run(scenarioBriefAdlib());
    expect(result.metrics.behaviorsSeen).toContain('adlib');

    // §19.2 step 4 / A.1: never coast beyond one rendered line.
    const budget =
      result.engine.smoothProfile.prediction.maxCoastUnits *
      result.engine.profile.unitsPerRenderedLine;
    expect(result.metrics.maxHoldDriftUnits).toBeLessThanOrEqual(budget + 1e-6);

    // §19.2 step 3: the schedule reaches a settle, it does not creep forever.
    const held = result.frames.filter((f) => f.state === 'adlib_hold' || f.state === 'uncertain');
    expect(held.length).toBeGreaterThan(0);
    const last = held[held.length - 1];
    expect(Math.abs(last?.velocityUnitsPerSecond ?? 1)).toBeLessThan(0.6);

    // §69.3: the tracker recovered once the presenter returned.
    expect(result.metrics.timeToReturnMs).not.toBeNull();
  });
});

describe('D.4 distant phrase collision (§86, §69.7)', () => {
  it('the remote candidate is seen, rejected, and never executed', () => {
    const { result } = run(scenarioDistantCollision());
    expect(result.metrics.prohibitedSectionJumpCount).toBe(0);
    expect(result.metrics.sectionsVisited).toEqual(['h0']);
    // The gate fired: the candidate reached diagnostics but not the cursor.
    const blocked = result.records.filter((r) => r.sectionGate === 'blocked');
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked.some((r) => r.blockedReason === 'prohibited_non_contiguous')).toBe(true);
    for (const frame of result.frames) expect(frame.sectionId).toBe('h0');
  });
});

describe('D.5 previous-sentence retake (§87)', () => {
  it('commits one controlled reverse and does not bounce', () => {
    const { result } = run(scenarioPreviousSentenceRetake());
    const retakes = result.records.filter((r) => r.behavior === 'retake');
    expect(retakes.length).toBe(1); // one commit, no oscillation

    const retake = retakes[0];
    expect(retake).toBeDefined();
    if (retake === undefined) return;
    expect(retake.toTokenIndex).toBeLessThan(retake.fromTokenIndex); // actually backward
    expect(['rewind', 'reanchor']).toContain(retake.visualDisposition);
    expect(retake.authority).toBe('ordinary');

    // §21.4: the epoch advanced, so the superseded take's late events are
    // rejected rather than dragging the cursor forward again.
    expect(result.engine.semanticEpoch).toBeGreaterThan(0);
    const after = result.frames.filter((f) => f.epoch === result.engine.semanticEpoch);
    expect(after.length).toBeGreaterThan(0);
  });

  it('a delayed completion from the old take cannot undo the retake (§21.4)', () => {
    const scenario = scenarioPreviousSentenceRetake();
    const result = runPlayback(scenario);
    const committedAfterRetake = result.engine.cursor.committedTokenIndex;

    // Replay the *pre-retake* item's completion late. It carries no new items,
    // so the stale-evidence guard must reject it.
    const lateEvents = scenario.actions
      .filter((a) => a.kind === 'transcript' && a.event.type === 'completed')
      .slice(0, 3);
    for (const action of lateEvents) {
      if (action.kind !== 'transcript') continue;
      result.engine.handleTranscriptEvent({ ...action.event, receivedAtMs: 90_000 });
    }
    expect(result.engine.cursor.committedTokenIndex).toBeLessThanOrEqual(
      committedAfterRetake + 3,
    );
  });
});

describe('D.6 large within-section skip (§86)', () => {
  it('re-anchors to the destination instead of racing through the gap', () => {
    const { result } = run(scenarioLargeWithinSectionSkip());
    const skips = result.records.filter(
      (r) => r.behavior === 'large_skip' || r.behavior === 'small_skip',
    );
    expect(skips.length).toBeGreaterThan(0);
    const skip = skips[skips.length - 1];
    expect(skip).toBeDefined();
    if (skip === undefined) return;
    // Final evidence gate (§20.3 step 1) and eligibility (§20.3 step 3).
    expect(skip.finalEvidence).toBe(true);
    expect(skip.fromSectionId).toBe(skip.toSectionId);
    expect(['catch_up', 'reanchor']).toContain(skip.visualDisposition);
    expect(result.metrics.prohibitedSectionJumpCount).toBe(0);
  });
});

describe('D.7 command to another chapter (§56.1)', () => {
  it('remote navigation is immediate, authorized, and epoch-stamped', () => {
    const { result } = run(scenarioCommandToOtherChapter());
    const commands = result.records.filter((r) => r.behavior === 'command_navigation');
    expect(commands.length).toBe(1);
    expect(commands[0]?.authority).toBe('command');
    // The section change is authorized, so it is not a prohibited jump.
    expect(result.metrics.prohibitedSectionJumpCount).toBe(0);
    expect(result.metrics.sectionsVisited).toContain('h2');
    expect(result.engine.semanticEpoch).toBeGreaterThan(0);

    // A command directive rode a frame so the stage can perform the re-anchor.
    const directives = result.frames
      .map((f) => f.transition)
      .filter((t) => t !== undefined && t.reason === 'command_navigation');
    expect(directives.length).toBeGreaterThan(0);
    // Idempotency: one directive id, however many frames carried it (§53).
    expect(new Set(directives.map((t) => t?.id)).size).toBe(1);
  });

  it('masked command speech never moves the cursor on its own (§51 step 3)', () => {
    const scenario = scenarioCommandToOtherChapter();
    // Drop the authoritative move: the masked command phrase alone must do
    // nothing, even though it names a distant heading.
    scenario.actions = scenario.actions.filter((a) => a.kind !== 'move');
    scenario.labels = [];
    scenario.expectBehaviors = [];
    const result = runPlayback(scenario);
    expect(result.metrics.prohibitedSectionJumpCount).toBe(0);
    expect(result.engine.sectionGraph.sectionIdAt(result.engine.cursor.committedTokenIndex)).toBe(
      'h0',
    );
  });
});

describe('harness determinism (§66)', () => {
  it('two runs of the same scenario produce identical traces', () => {
    const a = runPlayback(scenarioSmoothRead());
    const b = runPlayback(scenarioSmoothRead());
    expect(b.cursorAfterAction).toEqual(a.cursorAfterAction);
    expect(b.stateAfterAction).toEqual(a.stateAfterAction);
    expect(b.frames.map((f) => f.estimatedUnit)).toEqual(a.frames.map((f) => f.estimatedUnit));
    expect(b.metrics).toEqual(a.metrics);
  });
});
