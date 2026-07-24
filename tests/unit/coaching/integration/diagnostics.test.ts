/**
 * §37 through the integrator, plus the end-of-take path.
 *
 * `CoachDiagnosticsCollector`'s header is explicit that "a collector that is
 * never fed produces zeros, which is why each input is a named method": two of
 * its fields had no instrumentation anywhere and the tip ratio would have been
 * wrong on day one. These tests are the proof that each named method has a
 * caller.
 */
import { describe, expect, it } from 'vitest';

import { TakeHarness, prose } from './harness';
import { tipDisplayRatio } from '../../../../src/shared/coaching/coach/diagnostics';

describe('coaching integration — diagnostics (§37)', () => {
  it('feeds the worklet dropped-frame total, the analyzer cost and the tip counters', () => {
    const harness = new TakeHarness();
    harness.speak(1_500);
    harness.speak(400, { peakDbfs: 0, clippingRatio: 0.05 });
    // `WorkletCoreDiagnostics` reports a running total, not a delta.
    harness.orchestrator.noteWorkletDiagnostics({ droppedFrameCount: 7 });
    harness.orchestrator.noteWorkletDiagnostics({ droppedFrameCount: 3 });
    harness.orchestrator.notePrecisionCounters({ queued: 4, completed: 3, dropped: 1 });
    harness.speak(400);

    const diagnostics = harness.orchestrator.diagnostics();
    // A total, so the lower late report does not walk the number backwards.
    expect(diagnostics.droppedFrameCount).toBe(7);
    expect(diagnostics.analyzerMeanCostMs).toBeGreaterThan(0);
    expect(diagnostics.precisionQueued).toBe(4);
    expect(diagnostics.precisionDropped).toBe(1);
    // §37: proposed and shown are both real, so the ratio means something.
    expect(diagnostics.tipsProposed).toBeGreaterThan(0);
    expect(diagnostics.tipsShown).toBe(1);
    expect(tipDisplayRatio(diagnostics)).not.toBeNull();
  });

  it('closes the open run and clears the glass at the end of a take', () => {
    const harness = new TakeHarness();
    harness.speak(1_500);
    harness.speak(400, { peakDbfs: 0, clippingRatio: 0.05 });
    expect(harness.latest()?.activeTip?.code).toBe('MIC_CLIPPING');

    const publishedBefore = harness.published.length;
    harness.orchestrator.endTake();

    // §26.5 `take_ended` cancels everything held, and one last snapshot goes out
    // so the stage is not left rendering a tip about a take that is over.
    expect(harness.published.length).toBe(publishedBefore + 1);
    expect(harness.latest()?.activeTip).toBeNull();
  });

  it('removes a command from delivery time and marks the silence unmeasured', () => {
    const withCommand = new TakeHarness();
    const withoutCommand = new TakeHarness();

    for (const harness of [withCommand, withoutCommand]) {
      harness.say(prose(15), 6_000);
      const from = harness.audioMs;
      if (harness === withCommand) {
        // §14.5/§18.2: two seconds of audio that carries no delivery claim.
        harness.orchestrator.noteUnmeasured(from, from + 2_000, 'command');
      }
      harness.silence(2_000);
      harness.say(prose(15), 6_000);
    }

    const withSnapshot = withCommand.orchestrator.laneBundle().clock.snapshot();
    const withoutSnapshot = withoutCommand.orchestrator.laneBundle().clock.snapshot();
    // §14.1: delivery time is elapsed audio minus unmeasured. A command is
    // removed from it; the presenter's deliberate pauses are not.
    expect(withSnapshot.unmeasuredMs).toBeGreaterThanOrEqual(2_000);
    expect(withoutSnapshot.unmeasuredMs).toBe(0);
    expect(withSnapshot.deliveryMs).toBeCloseTo(withoutSnapshot.deliveryMs - 2_000, 0);
    // §12.5's honest limit, checked rather than assumed: the accounting is an
    // inequality, never an identity.
    expect(
      withSnapshot.voicedMs + withSnapshot.internalPauseMs + withSnapshot.unmeasuredMs,
    ).toBeLessThanOrEqual(withSnapshot.audioTimeMs);
  });
});
