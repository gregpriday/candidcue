/**
 * §5.2. "The stage must continue scrolling smoothly even if every coaching
 * process fails."
 *
 * The orchestrator cannot make the stage scroll — that is Rule 1 — so what it
 * owes §5.2 is narrower and testable: a throw inside one lane must not reach
 * the frame pump, must not stop the other lanes, and must not leave a stale
 * number on the glass pretending to be live.
 */
import { describe, expect, it } from 'vitest';

import { SESSION_ID, TakeHarness, prose } from './harness';
import { takePassIdFor } from '../../../../src/shared/coaching/integration';
import { PaceAnalyzer } from '../../../../src/shared/coaching/pace/pace-analyzer';
import { VarietyAnalyzer } from '../../../../src/shared/coaching/prosody/variety-score';
import { MicrophoneHealthMonitor } from '../../../../src/shared/coaching/audio/microphone-health';

class ExplodingPace extends PaceAnalyzer {
  override update(): never {
    throw new Error('pace lane exploded');
  }
}

class ExplodingVariety extends VarietyAnalyzer {
  override update(): never {
    throw new Error('prosody lane exploded');
  }
}

class ExplodingMicrophone extends MicrophoneHealthMonitor {
  override process(): never {
    throw new Error('audio lane exploded');
  }
}

describe('coaching integration — lane failure isolation (§5.2)', () => {
  it('keeps every other lane running when the pace lane throws', () => {
    const harness = new TakeHarness({ deps: { lanes: { pace: new ExplodingPace() } } });
    for (let index = 0; index < 3; index += 1) harness.say('um we should start here', 2_000);
    harness.speak(1_500);
    harness.speak(400, { peakDbfs: 0, clippingRatio: 0.05 });

    // The failure was reported, once, and took the lane out of service.
    expect(harness.laneFailures.some((failure) => failure.lane === 'pace')).toBe(true);
    expect(harness.laneFailures[0]?.disabled).toBe(true);
    expect(harness.orchestrator.telemetry().disabledLanes).toContain('pace');

    // …and nothing else stopped. The session kept publishing, the microphone
    // alert still reached the glass, and the filler count is still real.
    const rail = harness.latest();
    expect(rail).not.toBeNull();
    expect(rail?.activeTip?.code).toBe('MIC_CLIPPING');
    expect(rail?.fillers.confirmedCount).toBe(3);
    // Exactly one lane went down. (Variety has no *number* yet — this take is
    // shorter than §17.7's calibration window — but the lane is running.)
    expect(harness.orchestrator.telemetry().disabledLanes).toEqual(['pace']);

    // §27.1: the disabled tile says "unknown", not the last number it managed
    // to compute. A frozen WPM is indistinguishable from a live one.
    expect(rail?.pace.wpm).toBeNull();
    expect(rail?.pace.state).toBe('learning');
  });

  it('keeps the pace number when the prosody lane throws', () => {
    const harness = new TakeHarness({ deps: { lanes: { variety: new ExplodingVariety() } } });
    for (let index = 0; index < 4; index += 1) harness.say(prose(15), 6_000);

    expect(harness.orchestrator.telemetry().disabledLanes).toEqual(['prosody']);
    const rail = harness.latest();
    expect(rail?.pace.wpm).not.toBeNull();
    expect(rail?.variety.level).toBeNull();
    expect(rail?.variety.state).toBe('learning');
  });

  it('survives a lane that throws on every single frame', () => {
    const harness = new TakeHarness({
      deps: { lanes: { microphone: new ExplodingMicrophone() } },
    });
    // 6 000 frames' worth of audio through a lane that throws on each one.
    for (let index = 0; index < 3; index += 1) harness.say(prose(15), 6_000);

    // The guard disables on the first throw, so the lane is called once and
    // then skipped — the failure list does not grow with the frame count.
    expect(harness.laneFailures).toHaveLength(1);
    expect(harness.laneFailures[0]?.lane).toBe('audio');
    expect(harness.latest()?.microphone.status).toBe('learning');
    expect(harness.latest()?.pace.wpm).not.toBeNull();
  });

  it('restores a disabled lane on a new take pass', () => {
    const harness = new TakeHarness({ deps: { lanes: { variety: new ExplodingVariety() } } });
    harness.say(prose(15), 6_000);
    expect(harness.orchestrator.telemetry().disabledLanes).toEqual(['prosody']);

    harness.orchestrator.beginTakePass(2, harness.audioMs);
    // The lane is given another chance — and immediately throws again, which is
    // the honest outcome for a lane that is genuinely broken.
    expect(harness.orchestrator.telemetry().disabledLanes).toEqual([]);
    harness.say(prose(15), 6_000);
    expect(harness.orchestrator.telemetry().disabledLanes).toEqual(['prosody']);
    expect(harness.latest()?.takePassId).toBe(takePassIdFor(SESSION_ID, 2));
  });

  it('does not let a throwing stage sink stop the subsystem', () => {
    const harness = new TakeHarness({
      deps: {
        publish: () => {
          throw new Error('stage transport is gone');
        },
      },
    });
    for (let index = 0; index < 2; index += 1) harness.say(prose(15), 6_000);

    // The sink is the session store's, not a lane: it is not disabled, and the
    // orchestrator keeps measuring regardless.
    expect(harness.laneFailures).toHaveLength(0);
    expect(harness.orchestrator.lastRailState()?.pace.wpm).not.toBeNull();
  });
});
