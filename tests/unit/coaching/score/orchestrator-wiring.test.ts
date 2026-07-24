/**
 * The score reaching the rail, through the real orchestrator and the real lanes.
 *
 * This file exists because of the defect class the orchestrator's own header
 * describes: a surface every author assumed someone else would call.
 * `DeliveryScoreEngine` could be perfect and completely inert — the engine's own
 * suite would stay green while `CoachRailState.score` was `null` on every
 * snapshot the presenter ever saw. So each assertion here is about a value that
 * only exists because the engine was actually driven by a live take.
 */
import { describe, expect, it } from 'vitest';
import { TakeHarness, prose } from '../integration/harness';

describe('the delivery score reaches the rail', () => {
  it('publishes a score built from a real take, not a null placeholder', () => {
    const harness = new TakeHarness();
    for (let index = 0; index < 8; index += 1) harness.say(prose(14), 5_000);
    harness.orchestrator.tick();

    const rail = harness.latest();
    expect(rail).not.toBeNull();
    expect(rail?.modules.deliveryScore).toBe(true);
    const score = rail?.score ?? null;
    expect(score).not.toBeNull();
    if (score === null) return;

    // The dimensions are the contract's seven, and the audio dimensions have
    // real evidence behind them — which is only true if the pace, prosody,
    // cadence and disfluency lanes all reached the engine.
    expect(score.dimensions).toHaveLength(7);
    const available = score.dimensions.filter((entry) => entry.score !== null);
    expect(available.length).toBeGreaterThan(0);
    expect(score.rawScore).not.toBeNull();
    expect(score.rawScore as number).toBeGreaterThan(0);
    expect(score.rawScore as number).toBeLessThanOrEqual(100);

    // The three dimensions this build cannot measure stay unavailable even at
    // the end of a healthy take: `null`, never 0 and never 100.
    for (const name of ['emphasis', 'clarity', 'consistency'] as const) {
      const entry = score.dimensions.find((candidate) => candidate.dimension === name);
      expect(entry?.score).toBeNull();
    }
  });

  it('counts words through the orchestrator, so a filler rate is computable', () => {
    const harness = new TakeHarness();
    for (let index = 0; index < 8; index += 1) harness.say(prose(14), 5_000);
    harness.orchestrator.tick();
    const fluency = harness
      .latest()
      ?.score?.dimensions.find((entry) => entry.dimension === 'fluency');
    // Without the `noteSpokenWords` hook there are no words, every per-100-word
    // rate is unavailable, and fluency would be permanently null on every take.
    expect(fluency?.score).not.toBeNull();
    expect(fluency?.confidence as number).toBeGreaterThan(0);
  });

  it('withholds the score entirely in a mode that has no score module', () => {
    const harness = new TakeHarness({ settings: { mode: 'minimal' } });
    for (let index = 0; index < 6; index += 1) harness.say(prose(14), 5_000);
    harness.orchestrator.tick();
    const rail = harness.latest();
    expect(rail?.modules.deliveryScore).toBe(false);
    // §6.2: withheld rather than zeroed. "Not scored" is not a judgement.
    expect(rail?.score).toBeNull();
    // And it is genuinely being *computed* the whole time — the same
    // distinction `telemetry()` draws for every other lane.
    expect(harness.orchestrator.deliveryScore()).not.toBeNull();
  });

  it('starts a new take pass without inheriting the previous score', () => {
    const harness = new TakeHarness();
    for (let index = 0; index < 8; index += 1) harness.say(prose(14), 5_000);
    harness.orchestrator.tick();
    expect(harness.orchestrator.deliveryScore()?.rawScore).not.toBeNull();

    harness.orchestrator.beginTakePass('take-2', harness.audioMs);
    // Immediately, before a single frame of the new pass: the previous take's
    // number must not be readable for even one aggregation cycle. A stale score
    // on the glass is indistinguishable from a live one.
    expect(harness.orchestrator.deliveryScore()).toBeNull();

    harness.orchestrator.tick();
    const fresh = harness.orchestrator.deliveryScore();
    // Everything the previous pass measured is gone: no words, no drift ring,
    // no smoothed value. The rail shows "Listening…", not the last take's 84.
    expect(fresh?.displayScore ?? null).toBeNull();
    expect(fresh?.tier).toBe('warming_up');
  });

  it('routes a recording fault to confidence and never to the number', () => {
    const harness = new TakeHarness();
    for (let index = 0; index < 8; index += 1) harness.say(prose(14), 5_000);
    harness.orchestrator.tick();
    const healthy = harness.orchestrator.deliveryScore();
    expect(healthy?.rawScore).not.toBeNull();
    expect(healthy?.displayScore).not.toBeNull();

    // §12.7. The device goes away. Nothing about the delivery just measured has
    // changed, so the score must not change either — only how far it is
    // trusted, and therefore whether it is shown at all.
    harness.orchestrator.noteMicrophoneDisconnected(true);
    // The health monitor recomputes on a frame, so the take has to keep
    // running for the loss to be seen at all.
    harness.silence(400);
    harness.orchestrator.tick();
    const lost = harness.orchestrator.deliveryScore();
    expect(Math.abs((lost?.rawScore as number) - (healthy?.rawScore as number))).toBeLessThan(1);
    expect(lost?.confidence).toBe(0);
    expect(lost?.tier).toBe('warming_up');
    expect(lost?.displayScore ?? null).toBeNull();
  });
});
