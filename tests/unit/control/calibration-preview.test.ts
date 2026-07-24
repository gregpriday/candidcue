/**
 * §30.3 calibration preview — the readings, and the readings it refuses.
 *
 * The interesting assertions here are the negative ones. A preview that shows
 * a number for everything is easy to write and impossible to trust: §12.7.4
 * says there is no absolute loudness measurement, and §17.5 says a variety
 * score must not be fabricated from the remaining features when pitch
 * reliability is insufficient. Both of those are properties of *what this
 * module declines to return*, so they are tested as such.
 */
import { describe, expect, it } from 'vitest';
import {
  INITIAL_CALIBRATION,
  LEVEL_ADVICE,
  LEVEL_LABEL,
  MIN_SAMPLE_SPEAKING_MS,
  MIN_SAMPLE_WORDS,
  PITCH_CONFIDENCE_LABEL,
  PITCH_CONFIDENCE_TOO_LOW,
  PITCH_NOT_MEASURED_HERE,
  ROOM_LABEL,
  countSampleWords,
  headroomRatio,
  levelVerdict,
  pitchConfidenceVerdict,
  reduceCalibration,
  roomVerdict,
  samplePace,
  samplePaceShortfall,
  type CalibrationState,
} from '../../../src/control/lib/calibration-preview';
import type { AudioLevelSnapshot } from '../../../src/shared/contracts';

function frame(overrides: Partial<AudioLevelSnapshot> & { generatedAtMs: number }): AudioLevelSnapshot {
  return {
    rms: 0.3,
    peak: 0.5,
    noiseFloor: 0.02,
    speaking: true,
    clipped: false,
    signalPresent: true,
    ...overrides,
  };
}

/** `count` frames, 90 ms apart, from `startMs`. */
function feed(
  state: CalibrationState,
  count: number,
  startMs = 1000,
  overrides: Partial<AudioLevelSnapshot> = {},
): CalibrationState {
  let next = state;
  for (let i = 0; i < count; i += 1) {
    next = reduceCalibration(next, frame({ ...overrides, generatedAtMs: startMs + i * 90 }));
  }
  return next;
}

describe('calibration accumulation', () => {
  it('counts voiced time only while speech is present', () => {
    let state = feed(INITIAL_CALIBRATION, 20, 1000, { speaking: true });
    const voiced = state.speakingMs;
    state = feed(state, 20, 1000 + 20 * 90, { speaking: false });
    expect(state.speakingMs).toBe(voiced);
    expect(state.listeningMs).toBeGreaterThan(voiced);
  });

  it('does not count a stalled gap as speech', () => {
    // A tab throttle, a device change, a hitch — a five-second gap between two
    // frames is not five seconds of speech, and counting it would halve every
    // pace the preview reports.
    let state = reduceCalibration(INITIAL_CALIBRATION, frame({ generatedAtMs: 1000 }));
    state = reduceCalibration(state, frame({ generatedAtMs: 6000 }));
    expect(state.speakingMs).toBe(0);
  });

  it('latches a clip so a momentary distortion is still reported', () => {
    let state = feed(INITIAL_CALIBRATION, 5);
    state = reduceCalibration(state, frame({ generatedAtMs: 2000, clipped: true }));
    state = feed(state, 5, 2090);
    expect(state.everClipped).toBe(true);
  });
});

describe('§12.7.4 — level is relative, never a decibel figure', () => {
  it('describes level in words, and none of them is a number with dB after it', () => {
    for (const label of Object.values(LEVEL_LABEL)) {
      expect(label).not.toMatch(/\bdB\b/i);
      expect(label).not.toMatch(/\d/);
    }
    for (const advice of Object.values(LEVEL_ADVICE)) {
      expect(advice).not.toMatch(/\bdB\b/i);
      expect(advice).not.toMatch(/\bSPL\b/i);
    }
    for (const label of Object.values(ROOM_LABEL)) {
      expect(label).not.toMatch(/\bdB\b/i);
    }
  });

  it('grades the level from the relative magnitude it actually has', () => {
    expect(levelVerdict(INITIAL_CALIBRATION, null)).toBe('no_signal');
    expect(levelVerdict(feed(INITIAL_CALIBRATION, 5, 1000, { rms: 0.05 }), null)).toBe('very_quiet');
    expect(levelVerdict(feed(INITIAL_CALIBRATION, 5, 1000, { rms: 0.35 }), null)).toBe('good');
    expect(levelVerdict(feed(INITIAL_CALIBRATION, 5, 1000, { rms: 0.95 }), null)).toBe('hot');
    expect(levelVerdict(feed(INITIAL_CALIBRATION, 5, 1000, { clipped: true }), null)).toBe(
      'clipping',
    );
  });

  it('reports the room as a ratio of two relative levels, not as a level', () => {
    const quiet = feed(INITIAL_CALIBRATION, 5, 1000, { rms: 0.4, noiseFloor: 0.01 });
    expect(headroomRatio(quiet)).toBeCloseTo(40, 0);
    expect(roomVerdict(quiet)).toBe('quiet');

    const noisy = feed(INITIAL_CALIBRATION, 5, 1000, { rms: 0.3, noiseFloor: 0.2 });
    expect(roomVerdict(noisy)).toBe('noisy');
  });
});

describe('sample pace is measured, never estimated', () => {
  const READ = 'CandidCue is following my voice and this is a longer neutral test sentence to read';

  it('refuses a pace until there is enough voiced time AND enough words', () => {
    expect(countSampleWords(READ)).toBeGreaterThanOrEqual(MIN_SAMPLE_WORDS);

    // Plenty of words, barely any speech: four words in a second is not a pace.
    const brief = feed(INITIAL_CALIBRATION, 10); // ~0.8 s
    expect(brief.speakingMs).toBeLessThan(MIN_SAMPLE_SPEAKING_MS);
    expect(samplePace(brief, READ)).toBeNull();
    expect(samplePaceShortfall(brief, READ)).toContain('more second');

    // Plenty of speech, barely any words.
    const long = feed(INITIAL_CALIBRATION, 120); // ~10.7 s
    expect(samplePace(long, 'um')).toBeNull();
    expect(samplePaceShortfall(long, 'um')).toContain('more word');
  });

  it('reports articulation wpm, and says so, once the sample supports it', () => {
    const state = feed(INITIAL_CALIBRATION, 120); // ~10.7 s of speech
    const pace = samplePace(state, READ);
    expect(pace).not.toBeNull();
    // 15 words over ~10.7 s ≈ 84 wpm. The value is the measurement, not a
    // rounded-up encouragement.
    expect(pace!.wordCount).toBe(countSampleWords(READ));
    expect(pace!.articulationWpm).toBe(
      Math.round((pace!.wordCount / (state.speakingMs / 1000)) * 60),
    );
  });

  it('nothing at all yet reads as "start the test", not as zero', () => {
    expect(samplePaceShortfall(INITIAL_CALIBRATION, '')).toContain('Start the microphone test');
  });
});

describe('§17.5 — no fabricated variety', () => {
  it('distinguishes "no pitch source" from "the source is unsure"', () => {
    expect(pitchConfidenceVerdict(null)).toBe('unavailable');
    expect(pitchConfidenceVerdict(0.1)).toBe('too_low');
    expect(pitchConfidenceVerdict(0.5)).toBe('usable');
    expect(pitchConfidenceVerdict(0.9)).toBe('strong');
  });

  it('says what it cannot measure in a sentence, not with a dash', () => {
    // A dash reads as zero to some people, and a fabricated zero is exactly
    // the failure §17.5 forbids.
    expect(PITCH_NOT_MEASURED_HERE).toMatch(/Not measured/);
    expect(PITCH_NOT_MEASURED_HERE.length).toBeGreaterThan(40);
    expect(PITCH_CONFIDENCE_TOO_LOW).toMatch(/only once it has evidence/);
    expect(PITCH_CONFIDENCE_LABEL.unavailable).not.toMatch(/\d/);
  });
});
