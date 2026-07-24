/**
 * §13.2–§13.5. Median filtering, octave repair, the speaker-relative reference,
 * and the reliability gate.
 *
 * Frames are constructed directly here so each input condition is exact; the
 * end-to-end path from real audio through the extractor is covered in
 * `frame-extractor.test.ts` and `vad.test.ts`, and one test at the bottom
 * re-checks the join so this file cannot drift into testing a fiction.
 */
import { describe, expect, it } from 'vitest';
import { PitchTracker, type PitchSample } from '../../../../src/shared/coaching/audio/pitch-tracker';
import { FrameFeatureExtractor } from '../../../../src/shared/coaching/audio/frame-features';
import { speechTimeline } from './signals';
import type { AudioFrameFeatures } from '../../../../src/shared/contracts/coaching';

const FRAME_MS = 20;

function frameAt(
  index: number,
  overrides: Partial<AudioFrameFeatures> = {},
): AudioFrameFeatures {
  return {
    audioTimeMs: index * FRAME_MS,
    rmsDbfs: -22,
    peakDbfs: -8,
    clippingRatio: 0,
    noiseFloorDbfs: -54,
    estimatedSnrDb: 32,
    speechProbability: 0.95,
    voicedProbability: 0.9,
    f0Hz: 200,
    f0Confidence: 0.9,
    spectralFlux: 0.01,
    zeroCrossingRate: 0.02,
    processorDropout: false,
    ...overrides,
  };
}

/** Feed `count` frames starting at `startIndex`; returns the accepted samples. */
function feed(
  tracker: PitchTracker,
  count: number,
  startIndex: number,
  build: (index: number) => Partial<AudioFrameFeatures>,
): PitchSample[] {
  const samples: PitchSample[] = [];
  for (let i = 0; i < count; i += 1) {
    const sample = tracker.process(frameAt(startIndex + i, build(startIndex + i)));
    if (sample) samples.push(sample);
  }
  return samples;
}

describe('median filtering (§13.2)', () => {
  it('rejects a single-frame outlier', () => {
    const tracker = new PitchTracker();
    feed(tracker, 20, 0, () => ({ f0Hz: 200 }));
    // One frame jumps to 260 Hz — a 5-tap median cannot be moved by one sample.
    const samples = feed(tracker, 5, 20, (i) => ({ f0Hz: i === 20 ? 260 : 200 }));
    for (const sample of samples) {
      expect(sample.f0Hz).toBeCloseTo(200, 6);
    }
  });

  it('follows a genuine sustained change', () => {
    const tracker = new PitchTracker();
    feed(tracker, 20, 0, () => ({ f0Hz: 200 }));
    const samples = feed(tracker, 20, 20, () => ({ f0Hz: 240 }));
    expect((samples[samples.length - 1] as PitchSample).f0Hz).toBeCloseTo(240, 6);
  });
});

describe('octave repair (§13.2)', () => {
  it('pulls an isolated octave jump back and flags it', () => {
    const tracker = new PitchTracker();
    feed(tracker, 30, 0, () => ({ f0Hz: 200 }));
    const jump = feed(tracker, 1, 30, () => ({ f0Hz: 400 }));
    const sample = jump[0] as PitchSample;
    expect(sample.octaveCorrected).toBe(true);
    expect(sample.f0Hz).toBeCloseTo(200, 0);
  });

  it('repairs a halving as well as a doubling', () => {
    const tracker = new PitchTracker();
    feed(tracker, 30, 0, () => ({ f0Hz: 200 }));
    const jump = feed(tracker, 1, 30, () => ({ f0Hz: 100 }));
    expect((jump[0] as PitchSample).octaveCorrected).toBe(true);
    expect((jump[0] as PitchSample).f0Hz).toBeCloseTo(200, 0);
  });

  it('accepts a sustained register change instead of fighting it forever', () => {
    const tracker = new PitchTracker();
    feed(tracker, 50, 0, () => ({ f0Hz: 200 }));
    // 600 ms in the upper octave: past the 300 ms sustain window this is the
    // speaker's real register, not a tracking error.
    const samples = feed(tracker, 30, 50, () => ({ f0Hz: 400 }));
    const settled = samples[samples.length - 1] as PitchSample;
    expect(settled.f0Hz).toBeGreaterThan(380);
    expect(settled.octaveCorrected).toBe(false);
  });

  it('does not touch a normal expressive rise (a fifth is not an octave)', () => {
    const tracker = new PitchTracker();
    feed(tracker, 30, 0, () => ({ f0Hz: 200 }));
    const samples = feed(tracker, 10, 30, () => ({ f0Hz: 300 }));
    for (const sample of samples) expect(sample.octaveCorrected).toBe(false);
  });
});

describe('speaker-relative units (§13.3)', () => {
  it('has no reference — and therefore no semitones — before calibration', () => {
    const tracker = new PitchTracker({ calibrationMs: 10_000 });
    const samples = feed(tracker, 100, 0, () => ({ f0Hz: 200 })); // 2 s
    expect(tracker.referenceF0Hz).toBeNull();
    for (const sample of samples) expect(sample.semitones).toBeNull();
  });

  it('learns the reference as the rolling median and reports signed offsets', () => {
    const tracker = new PitchTracker({ calibrationMs: 2000 });
    feed(tracker, 200, 0, () => ({ f0Hz: 200 })); // 4 s at 200 Hz
    expect(tracker.referenceF0Hz as number).toBeCloseTo(200, 0);

    // 224.49 Hz is +2.00 semitones above 200 Hz.
    const up = feed(tracker, 10, 200, () => ({ f0Hz: 224.492 }));
    expect((up[up.length - 1] as PitchSample).semitones as number).toBeCloseTo(2, 1);

    // 178.2 Hz is -2.00 semitones below 200 Hz.
    const down = feed(tracker, 10, 300, () => ({ f0Hz: 178.18 }));
    expect((down[down.length - 1] as PitchSample).semitones as number).toBeCloseTo(-2, 1);
  });
});

describe('no gendered or absolute pitch target (§13.5)', () => {
  it('produces identical semitones and identical reliability for an 85 Hz and a 240 Hz speaker', () => {
    const shape = (index: number): number => {
      // The same relative contour in both cases: ±3 semitones.
      const semitoneOffset = 3 * Math.sin(index / 25);
      return 2 ** (semitoneOffset / 12);
    };

    function runSpeaker(baseHz: number): { semitones: number[]; reason: string; usable: boolean } {
      const tracker = new PitchTracker({ calibrationMs: 2000 });
      const semitones: number[] = [];
      for (let i = 0; i < 900; i += 1) {
        const sample = tracker.process(frameAt(i, { f0Hz: baseHz * shape(i) }));
        if (sample?.semitones !== null && sample !== null) semitones.push(sample.semitones);
      }
      const reliability = tracker.reliability;
      return { semitones, reason: reliability.reason, usable: reliability.usable };
    }

    const low = runSpeaker(85);
    const high = runSpeaker(240);

    expect(low.usable).toBe(true);
    expect(high.usable).toBe(true);
    expect(low.reason).toBe(high.reason);
    expect(low.semitones.length).toBe(high.semitones.length);
    for (let i = 0; i < low.semitones.length; i += 1) {
      expect(low.semitones[i] as number).toBeCloseTo(high.semitones[i] as number, 3);
    }
    // And the span itself is the same: ~6 semitones peak to peak, for both.
    expect(Math.max(...low.semitones) - Math.min(...low.semitones)).toBeCloseTo(
      Math.max(...high.semitones) - Math.min(...high.semitones),
      3,
    );
  });
});

describe('reliability gate (§13.4)', () => {
  it('is unusable until 12 s of voiced audio exists', () => {
    const tracker = new PitchTracker();
    feed(tracker, 400, 0, () => ({})); // 8 s
    const reliability = tracker.reliability;
    expect(reliability.usable).toBe(false);
    expect(reliability.reason).toBe('insufficient_voiced_audio');
    expect(reliability.usableVoicedMs).toBe(8000);

    feed(tracker, 300, 400, () => ({})); // 6 s more => 14 s
    expect(tracker.reliability.usable).toBe(true);
    expect(tracker.reliability.reason).toBe('ok');
  });

  it('reports low SNR rather than a score', () => {
    const tracker = new PitchTracker();
    feed(tracker, 700, 0, () => ({}));
    expect(tracker.reliability.usable).toBe(true);
    feed(tracker, 300, 700, () => ({ estimatedSnrDb: 4 }));
    expect(tracker.reliability.reason).toBe('low_snr');
    expect(tracker.reliability.usable).toBe(false);
  });

  it('reports heavy clipping', () => {
    const tracker = new PitchTracker();
    feed(tracker, 700, 0, () => ({}));
    feed(tracker, 300, 700, () => ({ clippingRatio: 0.2 }));
    expect(tracker.reliability.reason).toBe('clipping');
  });

  it('honours an injected competing-audio detection', () => {
    const tracker = new PitchTracker();
    feed(tracker, 700, 0, () => ({}));
    expect(tracker.reliability.usable).toBe(true);
    tracker.setCompetingAudio(true);
    expect(tracker.reliability.reason).toBe('competing_audio');
  });

  it('reports a low reliable-frame fraction when most speech frames have no f0', () => {
    const tracker = new PitchTracker();
    feed(tracker, 700, 0, () => ({}));
    // 5 s of speech with pitch on only 1 frame in 5: 20 % < the 45 % gate.
    feed(tracker, 300, 700, (i) =>
      i % 5 === 0 ? {} : { f0Hz: null, f0Confidence: 0.1, voicedProbability: 0.1 },
    );
    const reliability = tracker.reliability;
    expect(reliability.reliableFrameFraction).toBeGreaterThan(0.1);
    expect(reliability.reliableFrameFraction).toBeLessThan(0.45);
    expect(reliability.reason).toBe('low_reliable_frame_fraction');
  });

  it('reports octave instability when repair keeps firing', () => {
    const tracker = new PitchTracker();
    feed(tracker, 700, 0, () => ({}));
    // Alternate between the true pitch and its octave; every other frame needs
    // repair, well past the 25 % gate.
    feed(tracker, 300, 700, (i) => ({ f0Hz: i % 2 === 0 ? 200 : 400 }));
    expect(tracker.reliability.reason).toBe('octave_instability');
    expect(tracker.reliability.usable).toBe(false);
  });

  it('never invents a reference or a score when it is not usable', () => {
    const tracker = new PitchTracker();
    const reliability = tracker.reliability;
    expect(reliability.usable).toBe(false);
    expect(reliability.referenceF0Hz).toBeNull();
    expect(reliability.usableVoicedMs).toBe(0);
    expect(reliability.reliableFrameFraction).toBe(0);
  });
});

describe('dropouts are unmeasured, not unvoiced (§12.4)', () => {
  it('contributes to neither the numerator nor the denominator', () => {
    const tracker = new PitchTracker();
    feed(tracker, 700, 0, () => ({}));
    const before = tracker.reliability;
    for (let i = 0; i < 100; i += 1) {
      expect(tracker.process(frameAt(700 + i, { processorDropout: true }))).toBeNull();
    }
    const after = tracker.reliability;
    expect(after.usableVoicedMs).toBe(before.usableVoicedMs);
    expect(after.reliableFrameFraction).toBeCloseTo(before.reliableFrameFraction, 10);
    expect(after.reason).toBe('ok');
  });
});

describe('joins to the real extractor', () => {
  it('tracks a synthesized 196 Hz voice end to end', () => {
    const rate = 48_000;
    const frameSamples = (rate * FRAME_MS) / 1000;
    // Real captures always carry a room floor; a signal with literally zero
    // background would prime the noise estimator on the voice itself.
    const signal = speechTimeline({
      sampleRate: rate,
      durationMs: 4000,
      noiseRms: 0.002,
      segments: [{ startMs: 500, endMs: 4000, f0Hz: 196, rms: 0.08 }],
    });
    const extractor = new FrameFeatureExtractor({ sampleRate: rate, frameMs: FRAME_MS });
    const tracker = new PitchTracker({ calibrationMs: 1000 });
    const scratch = new Float32Array(frameSamples);
    const samples: PitchSample[] = [];

    for (let index = 0; index * frameSamples < signal.length - frameSamples; index += 1) {
      for (let i = 0; i < frameSamples; i += 1) {
        scratch[i] = signal[index * frameSamples + i] as number;
      }
      const sample = tracker.process(extractor.process(scratch, index * FRAME_MS));
      if (sample) samples.push(sample);
    }

    expect(samples.length).toBeGreaterThan(100);
    const settled = samples.slice(60);
    for (const sample of settled) {
      expect(sample.f0Hz).toBeGreaterThan(192);
      expect(sample.f0Hz).toBeLessThan(200);
    }
    expect(tracker.referenceF0Hz as number).toBeCloseTo(196, -0.5);
    // Steady pitch sits at the reference: ~0 semitones, and never null after
    // calibration.
    const last = samples[samples.length - 1] as PitchSample;
    expect(last.semitones as number).toBeCloseTo(0, 1);
  });
});
