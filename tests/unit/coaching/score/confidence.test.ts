/**
 * §9.7 evidence confidence, §9.8's provisional/final ramp, the §8 drift ring
 * and the §9.6 smoothing and rate cap.
 *
 * These are the parts of the model that decide whether a number is *shown*
 * rather than what it is, so every threshold is asserted at the published
 * boundary rather than "somewhere around" it.
 */
import { describe, expect, it } from 'vitest';
import {
  calibrationMaturityFrom,
  combineConfidence,
  confidenceTier,
  coverageFrom,
  ramp,
  signalQualityFrom,
} from '../../../../src/shared/coaching/score/confidence';
import {
  PaceDriftTracker,
  TranscriptEvidenceLedger,
} from '../../../../src/shared/coaching/score/evidence';
import {
  advanceDisplayScore,
  applyScoreRateCap,
  smoothTowards,
} from '../../../../src/shared/coaching/score/smoothing';
import { DEFAULT_DELIVERY_SCORE_OPTIONS } from '../../../../src/shared/coaching/score/profile';
import { microphone, reliability } from './evidence-fixture';

const OPTIONS = DEFAULT_DELIVERY_SCORE_OPTIONS;

describe('§9.7 tiers sit on the published thresholds', () => {
  it('maps each boundary exactly as the table writes it', () => {
    expect(confidenceTier(0)).toBe('warming_up');
    expect(confidenceTier(0.3499)).toBe('warming_up');
    expect(confidenceTier(0.35)).toBe('estimated');
    expect(confidenceTier(0.5499)).toBe('estimated');
    expect(confidenceTier(0.55)).toBe('usable');
    expect(confidenceTier(0.75)).toBe('usable');
    expect(confidenceTier(0.7501)).toBe('confident');
    expect(confidenceTier(1)).toBe('confident');
  });
});

describe('§9.7 coverage', () => {
  it('is the weakest of voiced audio and words, not their average', () => {
    // Plenty of audio, no words at all: coverage is zero, not one half.
    expect(coverageFrom(30_000, 0, OPTIONS)).toBe(0);
    expect(coverageFrom(0, 100, OPTIONS)).toBe(0);
    expect(coverageFrom(OPTIONS.coverageVoicedMs, OPTIONS.coverageWords, OPTIONS)).toBe(1);
  });

  it('ramps linearly to the Appendix A warm-up figures', () => {
    // Half of 3 000 ms and half of 8 words.
    expect(coverageFrom(1_500, 4, OPTIONS)).toBeCloseTo(0.5, 10);
  });
});

describe('§15 signal quality is where a recording fault lands', () => {
  it('never returns a value that could be mistaken for a score', () => {
    for (const status of ['ok', 'learning', 'low_level', 'noisy', 'clipping'] as const) {
      const quality = signalQualityFrom(microphone({ status }), reliability());
      expect(quality).toBeGreaterThan(0);
      expect(quality).toBeLessThanOrEqual(1);
    }
  });

  it('zeroes only when there is no signal to judge', () => {
    expect(signalQualityFrom(microphone({ status: 'no_signal' }), reliability())).toBe(0);
    expect(signalQualityFrom(microphone({ status: 'disconnected' }), reliability())).toBe(0);
  });

  it('orders the faults by how much evidence they destroy', () => {
    const ok = signalQualityFrom(microphone({ status: 'ok' }), reliability());
    const noisy = signalQualityFrom(microphone({ status: 'noisy' }), reliability());
    const clipping = signalQualityFrom(microphone({ status: 'clipping' }), reliability());
    expect(ok).toBe(1);
    expect(noisy).toBeLessThan(ok);
    expect(clipping).toBeLessThan(noisy);
  });

  it('discounts, rather than zeroes, when pitch is unusable', () => {
    const usable = signalQualityFrom(microphone(), reliability({ usable: true }));
    const unusable = signalQualityFrom(
      microphone(),
      reliability({ usable: false, reason: 'competing_audio' }),
    );
    expect(unusable).toBeLessThan(usable);
    expect(unusable).toBeGreaterThan(0);
  });
});

describe('§8.1 calibration maturity', () => {
  it('starts at the floor rather than at zero', () => {
    expect(calibrationMaturityFrom(0, OPTIONS)).toBeCloseTo(OPTIONS.calibrationFloor, 10);
  });

  it('reaches one only after enough of this speaker has been heard', () => {
    expect(calibrationMaturityFrom(OPTIONS.calibrationVoicedMs, OPTIONS)).toBe(1);
    expect(calibrationMaturityFrom(OPTIONS.calibrationVoicedMs / 2, OPTIONS)).toBeCloseTo(
      OPTIONS.calibrationFloor + (1 - OPTIONS.calibrationFloor) * 0.5,
      10,
    );
  });

  it('keeps an uncalibrated speaker out of the confident tier', () => {
    const uncalibrated = combineConfidence(1, 1, 1, calibrationMaturityFrom(0, OPTIONS));
    expect(uncalibrated.overall).toBeCloseTo(OPTIONS.calibrationFloor, 10);
    expect(confidenceTier(uncalibrated.overall)).toBe('usable');
  });
});

describe('C = coverage × quality × stability × calibration', () => {
  it('multiplies rather than averages, so any one zero suppresses the score', () => {
    expect(combineConfidence(0, 1, 1, 1).overall).toBe(0);
    expect(combineConfidence(1, 0, 1, 1).overall).toBe(0);
    expect(combineConfidence(0.8, 0.9, 0.7, 0.6).overall).toBeCloseTo(0.8 * 0.9 * 0.7 * 0.6, 10);
  });
});

describe('§9.8 the transcript ledger', () => {
  function ledger(): TranscriptEvidenceLedger {
    return new TranscriptEvidenceLedger(OPTIONS);
  }

  it('replaces a provisional tail rather than stacking it', () => {
    const book = ledger();
    book.note(1_000, 4, false);
    book.note(1_200, 6, false);
    book.note(1_400, 9, false);
    expect(book.wordsInWindow(2_000)).toBe(9);
  });

  it('clears the provisional overlay when the final arrives', () => {
    const book = ledger();
    book.note(1_000, 5, false);
    book.note(1_000, 6, true);
    // 6, not 11: the corrected count replaces the provisional one.
    expect(book.wordsInWindow(2_000)).toBe(6);
  });

  it('gives provisional evidence the low confidence §9.8 asks for', () => {
    const book = ledger();
    book.note(1_000, 10, false);
    expect(book.stability(1_000)).toBeCloseTo(OPTIONS.provisionalEvidenceConfidence, 10);
  });

  it('raises a final segment gradually across the 0.5–1.5 s window', () => {
    const book = ledger();
    book.note(1_000, 10, true);
    const floor = OPTIONS.provisionalEvidenceConfidence;
    // Before the ramp begins it is still only provisional-grade evidence.
    expect(book.stability(1_000)).toBeCloseTo(floor, 10);
    expect(book.stability(1_500)).toBeCloseTo(floor, 10);
    // Halfway through the ramp.
    expect(book.stability(2_000)).toBeCloseTo(floor + (1 - floor) * 0.5, 10);
    // And fully trusted at the far end — never before it.
    expect(book.stability(2_500)).toBe(1);
    expect(book.stability(9_000)).toBe(1);
  });

  it('weights maturity by word count, not by segment count', () => {
    const book = ledger();
    book.note(1_000, 90, true); // old and trusted
    book.note(9_000, 10, true); // brand new
    const floor = OPTIONS.provisionalEvidenceConfidence;
    expect(book.stability(9_000)).toBeCloseTo((90 * 1 + 10 * floor) / 100, 10);
  });

  it('reports full stability when there are no words, leaving coverage to say so', () => {
    expect(ledger().stability(5_000)).toBe(1);
  });

  it('windows by audio time, not by arrival', () => {
    const book = ledger();
    book.note(1_000, 40, true);
    book.note(40_000, 20, true);
    expect(book.wordsInWindow(40_000)).toBe(20);
    expect(book.wordsInWindow(20_000)).toBe(40);
  });
});

describe('§8 pace drift', () => {
  it('says nothing until it has a series', () => {
    const tracker = new PaceDriftTracker(30);
    tracker.note(0, 150);
    tracker.note(1_000, 150);
    expect(tracker.drift()).toBeNull();
    tracker.note(2_000, 150);
    expect(tracker.drift()).toBe(0);
  });

  it('samples at most once a second', () => {
    const tracker = new PaceDriftTracker(30);
    for (let now = 0; now < 3_000; now += 100) tracker.note(now, 150);
    expect(tracker.spanMs()).toBe(2_000);
  });

  it('measures the largest excursion from the median, not the endpoints', () => {
    const tracker = new PaceDriftTracker(30);
    // 150, 150, 180, 150, 150 — a spike that returns. A slope would call this
    // perfectly steady; §8's tolerance band does not.
    for (const [index, wpm] of [150, 150, 180, 150, 150].entries()) {
      tracker.note(index * 1_000, wpm);
    }
    expect(tracker.drift()).toBeCloseTo(30 / 150, 10);
  });

  it('ignores an absent rate rather than recording a zero', () => {
    const tracker = new PaceDriftTracker(30);
    tracker.note(0, 150);
    tracker.note(1_000, null);
    tracker.note(2_000, 150);
    tracker.note(3_000, 150);
    expect(tracker.drift()).toBe(0);
  });

  it('keeps only the configured number of samples', () => {
    const tracker = new PaceDriftTracker(5);
    for (let index = 0; index < 20; index += 1) tracker.note(index * 1_000, 150);
    expect(tracker.spanMs()).toBe(4_000);
  });
});

describe('§9.6 smoothing and the rate cap', () => {
  it('moves exactly half way across one half-life', () => {
    expect(smoothTowards(0, 100, 8_000, 8_000)).toBeCloseTo(50, 10);
    expect(smoothTowards(0, 100, 16_000, 8_000)).toBeCloseTo(75, 10);
  });

  it('adopts the first value rather than smoothing from nothing', () => {
    expect(smoothTowards(null, 84, 100, 8_000)).toBe(84);
  });

  it('is driven by elapsed time, not by call count', () => {
    const oneStep = smoothTowards(0, 100, 1_000, 8_000);
    let stepwise: number | null = 0;
    for (let index = 0; index < 10; index += 1) stepwise = smoothTowards(stepwise, 100, 100, 8_000);
    expect(stepwise as number).toBeCloseTo(oneStep, 10);
  });

  it('caps movement at the configured points per second', () => {
    expect(applyScoreRateCap(50, 100, 1_000, 2.5)).toBe(52.5);
    expect(applyScoreRateCap(50, 0, 1_000, 2.5)).toBe(47.5);
    expect(applyScoreRateCap(50, 100, 2_000, 2.5)).toBe(55);
    // Inside the cap the target is adopted exactly.
    expect(applyScoreRateCap(50, 51, 1_000, 2.5)).toBe(51);
  });

  it('adopts the first displayed value whole', () => {
    expect(applyScoreRateCap(null, 84, 1_000, 2.5)).toBe(84);
  });

  it('applies both stages and clamps the result', () => {
    const advanced = advanceDisplayScore({ smoothed: 100, display: 100 }, -50, 1_000, 8_000, 2.5);
    expect(advanced.display).toBe(97.5);
    expect(advanced.smoothed).toBeLessThan(100);
    expect(advanced.smoothed).toBeGreaterThan(80);
  });
});

describe('ramp', () => {
  it('is flat outside its bounds and linear between them', () => {
    expect(ramp(-1, 0, 10)).toBe(0);
    expect(ramp(0, 0, 10)).toBe(0);
    expect(ramp(5, 0, 10)).toBe(0.5);
    expect(ramp(10, 0, 10)).toBe(1);
    expect(ramp(99, 0, 10)).toBe(1);
  });
});
