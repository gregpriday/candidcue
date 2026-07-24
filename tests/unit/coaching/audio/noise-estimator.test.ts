/**
 * §12.5. The noise floor is the one estimator whose failure is silent: if it
 * trains on speech it climbs to the talker's level, SNR collapses, and the
 * whole coaching rail goes quiet while every component still "works".
 *
 * These tests feed levels in dBFS that are known by construction and assert
 * the floor lands on them (or refuses to), so an estimator that returned a
 * constant, or that ignored the `isSpeech` flag, fails.
 */
import { describe, expect, it } from 'vitest';
import { NoiseFloorEstimator } from '../../../../src/shared/coaching/audio/noise-estimator';

const FRAME_MS = 20;

function feed(
  estimator: NoiseFloorEstimator,
  levelDbfs: number,
  frames: number,
  isSpeech = false,
): number {
  let last = 0;
  for (let i = 0; i < frames; i += 1) last = estimator.update(levelDbfs, isSpeech);
  return last;
}

describe('NoiseFloorEstimator', () => {
  it('converges on a steady room level', () => {
    const estimator = new NoiseFloorEstimator({ frameMs: FRAME_MS });
    feed(estimator, -55, 200); // 4 s of steady -55 dBFS room tone
    expect(estimator.valueDbfs).toBeCloseTo(-55, 1);
    expect(estimator.primed).toBe(true);
  });

  it('NEVER trains on speech frames (§12.5)', () => {
    const estimator = new NoiseFloorEstimator({ frameMs: FRAME_MS });
    feed(estimator, -60, 100); // quiet room
    expect(estimator.valueDbfs).toBeCloseTo(-60, 1);

    // 30 s of continuous loud speech. If a single one of these frames trained
    // the floor it would drag toward -20 and SNR would collapse.
    feed(estimator, -20, 1500, true);
    expect(estimator.valueDbfs).toBeCloseTo(-60, 1);
    expect(NoiseFloorEstimator.snrDb(-20, estimator.valueDbfs)).toBeCloseTo(40, 1);
  });

  it('rises slowly and falls quickly (asymmetric, §12.5 "adapt slowly")', () => {
    const rising = new NoiseFloorEstimator({ frameMs: FRAME_MS });
    feed(rising, -60, 100);
    feed(rising, -40, 50); // 1 s of louder room
    const riseAfter1s = rising.valueDbfs;

    const falling = new NoiseFloorEstimator({ frameMs: FRAME_MS });
    feed(falling, -40, 100);
    feed(falling, -60, 50); // 1 s of quieter room
    const fallAfter1s = falling.valueDbfs;

    // 20 dB step, one second of it, in both directions.
    expect(riseAfter1s - -60).toBeLessThan(6); // moved <6 dB up: slow
    expect(-40 - fallAfter1s).toBeGreaterThan(14); // moved >14 dB down: fast
  });

  it('reports the floor used for this frame, so SNR is an exact identity', () => {
    const estimator = new NoiseFloorEstimator({ frameMs: FRAME_MS });
    feed(estimator, -55, 100);
    const floorForFrame = estimator.update(-56, false);
    // The returned value is the pre-update floor, not the post-update one.
    expect(floorForFrame).not.toBe(estimator.valueDbfs);
    expect(NoiseFloorEstimator.snrDb(-30, floorForFrame)).toBeCloseTo(-30 - floorForFrame, 10);
  });

  it('does not claim a fictitious SNR on the first frame of a take', () => {
    const estimator = new NoiseFloorEstimator({ frameMs: FRAME_MS });
    const floor = estimator.update(-50, false);
    // Without priming this would be -100 dBFS and report a 50 dB SNR.
    expect(floor).toBeCloseTo(-50, 6);
    expect(NoiseFloorEstimator.snrDb(-50, floor)).toBe(0);
  });

  it('keeps SNR positive-or-zero, never negative (Rule 2 sign convention)', () => {
    expect(NoiseFloorEstimator.snrDb(-70, -50)).toBe(0);
    expect(NoiseFloorEstimator.snrDb(-30, -50)).toBe(20);
  });

  it('caps the floor so a broken take cannot make everything unmeasurable', () => {
    const estimator = new NoiseFloorEstimator({ frameMs: FRAME_MS, maximumFloorDbfs: -30 });
    feed(estimator, -5, 5000);
    expect(estimator.valueDbfs).toBeLessThanOrEqual(-30);
  });

  it('recovers from a floor primed on speech, instead of wedging forever', () => {
    const estimator = new NoiseFloorEstimator({ frameMs: FRAME_MS });
    // The take starts mid-sentence: priming sees nothing but -30 dBFS speech.
    feed(estimator, -30, 10);
    expect(estimator.valueDbfs).toBeCloseTo(-30, 1);
    // SNR now reads 0, so every frame is classified as speech and the floor
    // would never be corrected without the leak.
    expect(NoiseFloorEstimator.snrDb(-30, estimator.valueDbfs)).toBe(0);

    feed(estimator, -30, 60 * 50, true); // 60 s of continuous speech
    // The leak stops once there is a workable VAD margin, and no further.
    expect(estimator.valueDbfs).toBeCloseTo(-30 - NoiseFloorEstimator.LEAK_GUARD_DB, 0);
    expect(NoiseFloorEstimator.snrDb(-30, estimator.valueDbfs)).toBeGreaterThanOrEqual(11);
  });

  it('does NOT leak when the floor is healthy', () => {
    const estimator = new NoiseFloorEstimator({ frameMs: FRAME_MS });
    feed(estimator, -60, 100); // real room at -60
    feed(estimator, -20, 60 * 50, true); // 60 s of speech well above it
    expect(estimator.valueDbfs).toBeCloseTo(-60, 1);
  });

  it('resets to an unprimed state', () => {
    const estimator = new NoiseFloorEstimator({ frameMs: FRAME_MS });
    feed(estimator, -45, 100);
    estimator.reset();
    expect(estimator.primed).toBe(false);
    expect(estimator.update(-70, false)).toBeCloseTo(-70, 6);
  });
});
