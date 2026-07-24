/**
 * §12.7 / §25.1 through the integrator: the `system_critical` band reaches the
 * glass, retires, and can be raised again.
 *
 * `MicrophoneCandidateSource` had no caller anywhere, so the highest-priority
 * band in the subsystem was unreachable by construction — the health tile
 * existed, the alert copy existed, and nothing joined them. Every assertion
 * below fails against an orchestrator that skips `micCandidates.update`.
 */
import { describe, expect, it } from 'vitest';

import { TakeHarness } from './harness';

/** A frame whose peak is at full scale — §12.7.1 clipping evidence. */
const CLIPPED = { peakDbfs: 0, clippingRatio: 0.05 } as const;

describe('coaching integration — microphone alerts', () => {
  it('raises MIC_CLIPPING once a sustained episode exists, and not before', () => {
    const harness = new TakeHarness();
    // §12.7: a judgement needs a second of observed audio first.
    harness.speak(1_500);
    expect(harness.latest()?.activeTip).toBeNull();
    expect(harness.latest()?.microphone.status).toBe('ok');

    // §12.7.1: "Do not react to a single isolated clipped sample." One frame
    // moves the hold and nothing else.
    harness.speak(20, CLIPPED);
    harness.settle(0);
    expect(harness.latest()?.microphone.status).toBe('ok');

    harness.speak(400, CLIPPED);
    const rail = harness.latest();
    expect(rail?.microphone.status).toBe('clipping');
    expect(rail?.microphone.sustained).toBe(true);
    expect(rail?.activeTip?.code).toBe('MIC_CLIPPING');
    expect(rail?.activeTip?.severity).toBe('critical');
    // §25: a code and an authored key, never model or analyzer prose.
    expect(rail?.activeTip?.textKey).toBe('coach.tip.MIC_CLIPPING');
  });

  it('retires the alert after its display window and raises it again for a new episode', () => {
    const harness = new TakeHarness();
    harness.speak(1_500);
    harness.speak(400, CLIPPED);

    const first = harness.latest()?.activeTip;
    expect(first?.code).toBe('MIC_CLIPPING');
    const firstTipId = first?.tipId as string;
    const maximumDisplayMs = first?.maximumDisplayMs as number;

    // Clean audio for longer than the tip's own display window, which is also
    // longer than the §25.1 cooldown and the episode gap.
    harness.speak(maximumDisplayMs + 2_000);
    expect(harness.latest()?.microphone.status).toBe('ok');
    expect(harness.latest()?.activeTip).toBeNull();

    // §26.3: a recurrence is a *new evidence cluster*, so the alert may be
    // raised again rather than being a once-per-take event.
    harness.speak(400, CLIPPED);
    const second = harness.latest()?.activeTip;
    expect(second?.code).toBe('MIC_CLIPPING');
    expect(second?.tipId).not.toBe(firstTipId);
  });

  it('draws the closed clipping episode on the ribbon', () => {
    const harness = new TakeHarness();
    harness.speak(1_500);
    harness.speak(400, CLIPPED);
    harness.speak(1_000);

    const clipping = harness.latest()?.ribbonEvents.filter((event) => event.type === 'clipping');
    expect(clipping?.length).toBe(1);
    expect((clipping?.[0]?.endMs ?? 0) - (clipping?.[0]?.startMs ?? 0)).toBeGreaterThan(0);
  });

  it('reports a lost device as disconnected rather than as a quiet microphone', () => {
    const harness = new TakeHarness();
    harness.speak(1_500);
    harness.orchestrator.noteMicrophoneDisconnected(true);
    harness.silence(400);

    const rail = harness.latest();
    expect(rail?.microphone.status).toBe('disconnected');
    expect(rail?.activeTip?.code).toBe('MIC_DISCONNECTED');
  });
});
