import { DurationCalibrator } from '@main/interview/duration-calibrator';
import { RUNTIME_DEFAULTS } from '@shared/constants/runtime-defaults';

describe('DurationCalibrator', () => {
  describe('initial rate', () => {
    it('starts at the runtime default words-per-second', () => {
      const calibrator = new DurationCalibrator();
      expect(calibrator.wordsPerSecond).toBe(RUNTIME_DEFAULTS.defaultWordsPerSecond);
    });

    it('accepts an explicit initial rate', () => {
      const calibrator = new DurationCalibrator(3.0);
      expect(calibrator.wordsPerSecond).toBe(3.0);
    });

    it('clamps an out-of-range initial rate into the sane range', () => {
      expect(new DurationCalibrator(100).wordsPerSecond).toBe(4.5);
      expect(new DurationCalibrator(0.1).wordsPerSecond).toBe(1.5);
    });

    it('falls back to the default for a non-finite initial rate', () => {
      expect(new DurationCalibrator(Number.NaN).wordsPerSecond).toBe(
        RUNTIME_DEFAULTS.defaultWordsPerSecond,
      );
    });
  });

  describe('update (EWMA)', () => {
    it('moves toward a faster observed rate but stays weighted to history', () => {
      const calibrator = new DurationCalibrator();
      const prev = calibrator.wordsPerSecond; // 2.7

      // Observe 40 words in 10s => 4.0 wps (faster than history).
      calibrator.update(40, 10_000);

      const observed = 4.0;
      const expected = 0.2 * observed + 0.8 * prev;
      expect(calibrator.wordsPerSecond).toBeCloseTo(expected, 10);

      // It moved up toward the faster rate...
      expect(calibrator.wordsPerSecond).toBeGreaterThan(prev);
      // ...but did not jump all the way (history-weighted 0.8).
      expect(calibrator.wordsPerSecond).toBeLessThan(observed);
    });

    it('moves toward a slower observed rate but stays weighted to history', () => {
      const calibrator = new DurationCalibrator();
      const prev = calibrator.wordsPerSecond; // 2.7

      // Observe 20 words in 10s => 2.0 wps (slower than history).
      calibrator.update(20, 10_000);

      const observed = 2.0;
      const expected = 0.2 * observed + 0.8 * prev;
      expect(calibrator.wordsPerSecond).toBeCloseTo(expected, 10);
      expect(calibrator.wordsPerSecond).toBeLessThan(prev);
      expect(calibrator.wordsPerSecond).toBeGreaterThan(observed);
    });

    it('converges toward a sustained observed rate over many samples', () => {
      const calibrator = new DurationCalibrator();
      for (let i = 0; i < 50; i += 1) {
        // 35 words in 10s => 3.5 wps, repeated.
        calibrator.update(35, 10_000);
      }
      expect(calibrator.wordsPerSecond).toBeCloseTo(3.5, 2);
    });

    it('clamps the rate to the upper bound under extreme fast samples', () => {
      const calibrator = new DurationCalibrator(4.4);
      for (let i = 0; i < 100; i += 1) {
        // 1000 words in 100ms => absurdly fast.
        calibrator.update(1000, 100);
      }
      expect(calibrator.wordsPerSecond).toBeLessThanOrEqual(4.5);
      expect(calibrator.wordsPerSecond).toBeGreaterThanOrEqual(1.5);
    });

    it('clamps the rate to the lower bound under extreme slow samples', () => {
      const calibrator = new DurationCalibrator(1.6);
      for (let i = 0; i < 100; i += 1) {
        // 1 word in 60s => extremely slow.
        calibrator.update(1, 60_000);
      }
      expect(calibrator.wordsPerSecond).toBeGreaterThanOrEqual(1.5);
      expect(calibrator.wordsPerSecond).toBeLessThanOrEqual(4.5);
    });

    it('ignores zero or negative word counts', () => {
      const calibrator = new DurationCalibrator();
      const before = calibrator.wordsPerSecond;
      calibrator.update(0, 10_000);
      calibrator.update(-5, 10_000);
      expect(calibrator.wordsPerSecond).toBe(before);
    });

    it('ignores zero or negative audio durations', () => {
      const calibrator = new DurationCalibrator();
      const before = calibrator.wordsPerSecond;
      calibrator.update(30, 0);
      calibrator.update(30, -1000);
      expect(calibrator.wordsPerSecond).toBe(before);
    });
  });

  describe('estimateMs', () => {
    it('uses the current words-per-second', () => {
      const calibrator = new DurationCalibrator(); // 2.7 wps
      // 27 words / 2.7 wps = 10s = 10000ms.
      expect(calibrator.estimateMs(27)).toBe(10_000);
    });

    it('rounds to the nearest millisecond', () => {
      const calibrator = new DurationCalibrator(3.0);
      // 10 words / 3.0 wps = 3.3333s => 3333ms.
      expect(calibrator.estimateMs(10)).toBe(3333);
    });

    it('reflects the updated rate after calibration', () => {
      const calibrator = new DurationCalibrator();
      const baseline = calibrator.estimateMs(30);

      // Push the rate faster so estimates shrink.
      for (let i = 0; i < 20; i += 1) {
        calibrator.update(40, 10_000); // 4.0 wps
      }
      const faster = calibrator.estimateMs(30);

      expect(calibrator.wordsPerSecond).toBeGreaterThan(
        RUNTIME_DEFAULTS.defaultWordsPerSecond,
      );
      expect(faster).toBeLessThan(baseline);
      // Estimate should match the current rate directly.
      expect(faster).toBe(Math.round((30 / calibrator.wordsPerSecond) * 1000));
    });

    it('returns 0 for zero or negative word counts', () => {
      const calibrator = new DurationCalibrator();
      expect(calibrator.estimateMs(0)).toBe(0);
      expect(calibrator.estimateMs(-10)).toBe(0);
    });
  });
});
