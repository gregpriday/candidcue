/**
 * The negative cases, which are the ones an assembly layer gets wrong quietly.
 *
 * §2.6 makes silence the *expected* outcome of most windows, so "the rail said
 * nothing" is only evidence of correctness when it is paired with proof that
 * the subsystem was running at the time. Every test below asserts both halves.
 */
import { describe, expect, it } from 'vitest';

import { TakeHarness, prose } from './harness';

describe('coaching integration — silence is the default (§2.6)', () => {
  it('shows no tip at all for a clean, on-target take', () => {
    const harness = new TakeHarness();
    // Five sentences at ~150 WPM: inside the 115–160 natural band, no fillers,
    // clean audio, no dropouts.
    for (let index = 0; index < 5; index += 1) harness.say(prose(15), 6_000);

    expect(harness.published.length).toBeGreaterThan(0);
    expect(harness.published.every((state) => state.activeTip === null)).toBe(true);
    expect(harness.orchestrator.diagnostics().tipsShown).toBe(0);
    // …and the subsystem was demonstrably awake while saying nothing.
    expect(harness.orchestrator.telemetry().aggregationPasses).toBeGreaterThan(100);
    expect(harness.latest()?.pace.wpm).not.toBeNull();
    expect(harness.latest()?.fillers.confirmedCount).toBe(0);
    // …including the prosody lane, which is *in band* rather than gated off.
    // Without this the "no variety tip" half of the claim would pass simply
    // because the tile never produced a number.
    expect(harness.latest()?.variety.level).not.toBeNull();
    expect(harness.latest()?.variety.state).toBe('balanced');
  });

  it('produces no tips and no rail traffic for a completely silent take', () => {
    const harness = new TakeHarness();
    harness.silence(20_000);

    expect(harness.orchestrator.diagnostics().tipsProposed).toBe(0);
    expect(harness.published.every((state) => state.activeTip === null)).toBe(true);
    // §27.1: `null`, never `0`. Zero is a different claim.
    expect(harness.latest()?.pace.wpm).toBeNull();
    expect(harness.latest()?.pace.state).toMatch(/learning|paused/u);
  });
});

describe('coaching integration — mode gating (§6)', () => {
  it('publishes nothing in `off` while still doing the analysis', () => {
    const harness = new TakeHarness({ settings: { mode: 'off' } });
    harness.speak(1_500);
    harness.speak(400, { peakDbfs: 0, clippingRatio: 0.05 });
    for (let index = 0; index < 3; index += 1) harness.say('um we should start here', 2_000);

    // §6.1: no live rail. Not a stale one, not an empty one — none.
    expect(harness.published).toHaveLength(0);
    expect(harness.orchestrator.lastRailState()).toBeNull();

    // …and the analysis ran anyway: the microphone was measured, the fillers
    // were counted, and the pass timing was recorded.
    const telemetry = harness.orchestrator.telemetry();
    expect(telemetry.aggregationPasses).toBeGreaterThan(50);
    expect(telemetry.microphone.status).not.toBe('learning');
    expect(telemetry.fillers.confirmedCount).toBe(3);
    expect(harness.orchestrator.diagnostics().analyzerMeanCostMs).toBeGreaterThan(0);
    // §6.1: every module flag is off, so a consumer of the telemetry cannot
    // mistake "measured" for "showable".
    expect(Object.values(telemetry.modules).every((flag) => flag === false)).toBe(true);
  });

  it('publishes nothing in `review_only` but keeps the evidence for the report', () => {
    const harness = new TakeHarness({ settings: { mode: 'review_only' } });
    for (let index = 0; index < 3; index += 1) harness.say('um we should start here', 2_000);

    expect(harness.published).toHaveLength(0);
    // §6.5: the take is fully analysed; only the *live* interruption is absent.
    const telemetry = harness.orchestrator.telemetry();
    expect(telemetry.fillers.confirmedCount).toBe(3);
    // The candidate that would have become a tip exists and was simply never
    // admitted to the glass.
    expect(telemetry.activeCandidates.some((c) => c.type === 'filler_cluster')).toBe(true);
    expect(harness.orchestrator.diagnostics().tipsShown).toBe(0);
  });

  it('admits only critical bands in `minimal`', () => {
    const harness = new TakeHarness({ settings: { mode: 'minimal' } });
    for (let index = 0; index < 3; index += 1) harness.say('um we should start here', 2_000);
    // §6.2: pace and critical alerts only. A filler cluster is neither.
    expect(harness.published.every((state) => state.activeTip === null)).toBe(true);
    expect(harness.latest()?.modules.fillerCount).toBe(false);
    expect(harness.latest()?.modules.paceNumber).toBe(true);

    harness.speak(1_500);
    harness.speak(400, { peakDbfs: 0, clippingRatio: 0.05 });
    // …but a microphone fault still reaches the presenter.
    expect(harness.latest()?.activeTip?.code).toBe('MIC_CLIPPING');
  });

  it('resolves `custom` from the user module flags rather than falling back to coach', () => {
    const harness = new TakeHarness({
      settings: {
        mode: 'custom',
        modules: {
          paceNumber: true,
          paceStatus: true,
          targetDurationStatus: false,
          varietyScore: false,
          fillerCount: false,
          fillerRibbon: false,
          inlineGutterMarks: false,
          liveTips: false,
        },
      },
    });
    for (let index = 0; index < 3; index += 1) harness.say('um we should start here', 2_000);

    const rail = harness.latest();
    expect(rail?.modules.fillerCount).toBe(false);
    expect(rail?.modules.liveTips).toBe(false);
    expect(rail?.modules.paceNumber).toBe(true);
    // §30: telemetry keeps running when `liveTips` is off; the tip is
    // suppressed, not the measurement.
    expect(rail?.fillers.confirmedCount).toBe(3);
    expect(rail?.activeTip).toBeNull();
  });
});
