/**
 * Layer B (§16.2). The detector is fed real frame streams; nothing here hands
 * it a pre-built "run" and then asserts the run came back.
 *
 * The negative cases carry the weight: §16.2's whole point is that a sustained
 * vowel is not automatically "um", so a normal voiced word must produce
 * nothing even though it is voiced, between pauses, and the right length.
 */
import { describe, expect, it } from 'vitest';
import { AcousticCandidateDetector } from '../../../../src/shared/coaching/disfluency/acoustic-candidate-detector';
import { ACOUSTIC_ONLY_CONFIDENCE_CEILING } from '../../../../src/shared/coaching/disfluency/types';
import type { AudioFrameFeatures } from '../../../../src/shared/contracts/coaching';

const FRAME_MS = 20;

function baseFrame(audioTimeMs: number): AudioFrameFeatures {
  return {
    audioTimeMs,
    rmsDbfs: -24,
    peakDbfs: -12,
    clippingRatio: 0,
    noiseFloorDbfs: -60,
    estimatedSnrDb: 24,
    speechProbability: 0,
    voicedProbability: 0,
    f0Hz: null,
    f0Confidence: 0,
    spectralFlux: 0,
    zeroCrossingRate: 0.1,
    processorDropout: false,
  };
}

interface RunSpec {
  durationMs: number;
  /** Base pitch, Hz. */
  f0Hz: number;
  /** Peak-to-peak pitch movement across the run, Hz. */
  f0MovementHz: number;
  spectralFlux: number;
  dropout?: boolean;
}

function pushSilence(detector: AcousticCandidateDetector, fromMs: number, durationMs: number): number {
  let time = fromMs;
  for (; time < fromMs + durationMs; time += FRAME_MS) {
    detector.pushFrame({ ...baseFrame(time), spectralFlux: 0.01 });
  }
  return time;
}

function pushVoiced(detector: AcousticCandidateDetector, fromMs: number, spec: RunSpec): number {
  let time = fromMs;
  let index = 0;
  const frames = Math.round(spec.durationMs / FRAME_MS);
  for (; time < fromMs + spec.durationMs; time += FRAME_MS, index++) {
    // A deterministic triangular pitch contour, so "moving pitch" is moving
    // and "flat pitch" is flat — no randomness anywhere in this suite.
    const phase = frames <= 1 ? 0 : (index / (frames - 1)) * 2 - 1;
    detector.pushFrame({
      ...baseFrame(time),
      speechProbability: 0.95,
      voicedProbability: 0.9,
      f0Hz: spec.f0Hz + phase * (spec.f0MovementHz / 2),
      f0Confidence: 0.9,
      spectralFlux: spec.spectralFlux,
      processorDropout: spec.dropout === true,
    });
  }
  return time;
}

/** Normal speech, which also trains the rolling spectral-flux median. */
function pushNormalSpeech(detector: AcousticCandidateDetector, fromMs: number, durationMs = 1_000): number {
  return pushVoiced(detector, fromMs, {
    durationMs,
    f0Hz: 130,
    f0MovementHz: 40,
    spectralFlux: 1,
  });
}

describe('hesitation detection (§16.2)', () => {
  it('flags a long, flat, low-movement vowel between pauses', () => {
    const detector = new AcousticCandidateDetector();
    let time = pushNormalSpeech(detector, 0, 2_000);
    time = pushSilence(detector, time, 300);
    const hesitationStart = time;
    time = pushVoiced(detector, time, {
      durationMs: 400,
      f0Hz: 120,
      f0MovementHz: 1,
      spectralFlux: 0.15,
    });
    time = pushSilence(detector, time, 300);
    pushNormalSpeech(detector, time, 500);

    const candidates = detector.drainCandidates();
    expect(candidates).toHaveLength(1);
    const candidate = candidates[0];
    expect(candidate?.startMs).toBe(hesitationStart);
    expect(candidate?.features.durationMs).toBe(400);
    expect(candidate?.features.lowLexicalProgress).toBe(true);
    // §16.2: acoustic evidence alone may never carry a high-severity claim.
    expect(candidate!.score).toBeLessThanOrEqual(ACOUSTIC_ONLY_CONFIDENCE_CEILING);
    expect(candidate!.score).toBeGreaterThanOrEqual(0.4);
    expect(detector.hasHesitation(hesitationStart + 100, hesitationStart + 200)).toBe(true);
  });

  it('ignores an ordinary word of the same length between the same pauses', () => {
    const detector = new AcousticCandidateDetector();
    let time = pushNormalSpeech(detector, 0, 2_000);
    time = pushSilence(detector, time, 300);
    // Same duration and position as the hesitation above; only the pitch
    // contour and spectral movement differ.
    time = pushVoiced(detector, time, {
      durationMs: 400,
      f0Hz: 130,
      f0MovementHz: 45,
      spectralFlux: 1.1,
    });
    time = pushSilence(detector, time, 300);
    pushNormalSpeech(detector, time, 500);

    expect(detector.drainCandidates()).toEqual([]);
  });

  it('ignores a vowel that runs longer than a hesitation plausibly does', () => {
    const detector = new AcousticCandidateDetector();
    let time = pushNormalSpeech(detector, 0, 2_000);
    time = pushSilence(detector, time, 300);
    time = pushVoiced(detector, time, {
      durationMs: 1_500,
      f0Hz: 120,
      f0MovementHz: 1,
      spectralFlux: 0.15,
    });
    pushSilence(detector, time, 300);
    detector.flush(time + 300);
    expect(detector.drainCandidates()).toEqual([]);
  });

  it('treats a processor dropout as unmeasured rather than as a hesitation', () => {
    const detector = new AcousticCandidateDetector();
    let time = pushNormalSpeech(detector, 0, 2_000);
    time = pushSilence(detector, time, 300);
    time = pushVoiced(detector, time, {
      durationMs: 400,
      f0Hz: 120,
      f0MovementHz: 1,
      spectralFlux: 0.15,
      dropout: true,
    });
    time = pushSilence(detector, time, 300);
    pushNormalSpeech(detector, time, 500);

    expect(detector.drainCandidates()).toEqual([]);
  });

  it('scores lower when words were being produced across the region', () => {
    const build = (withProgress: boolean): number => {
      const detector = new AcousticCandidateDetector();
      let time = pushNormalSpeech(detector, 0, 2_000);
      time = pushSilence(detector, time, 300);
      if (withProgress) detector.noteLexicalProgress(time + 200);
      time = pushVoiced(detector, time, {
        durationMs: 400,
        f0Hz: 120,
        f0MovementHz: 1,
        spectralFlux: 0.15,
      });
      time = pushSilence(detector, time, 300);
      pushNormalSpeech(detector, time, 500);
      return detector.drainCandidates()[0]?.score ?? 0;
    };
    expect(build(true)).toBeLessThan(build(false));
  });

  it('requires silence on at least one side', () => {
    const detector = new AcousticCandidateDetector();
    // A flat, low-movement stretch in the *middle* of continuous voicing is
    // not a hesitation; it is a held note or a steady syllable.
    let time = pushNormalSpeech(detector, 0, 2_000);
    time = pushVoiced(detector, time, {
      durationMs: 400,
      f0Hz: 120,
      f0MovementHz: 1,
      spectralFlux: 0.15,
    });
    time = pushNormalSpeech(detector, time, 500);
    detector.flush(time);
    expect(detector.drainCandidates()).toEqual([]);
  });
});

describe('speech-run boundaries', () => {
  it('exposes speech starts for acoustic sentence segmentation', () => {
    const detector = new AcousticCandidateDetector();
    detector.observeSpeechInterval({
      startMs: 1_000,
      endMs: 3_000,
      voicedMs: 1_800,
      silenceMs: 200,
      meanSnrDb: 20,
      takePassId: 'take-1',
    });
    detector.observeSpeechInterval({
      startMs: 5_000,
      endMs: 6_000,
      voicedMs: 900,
      silenceMs: 100,
      meanSnrDb: 20,
      takePassId: 'take-1',
    });
    expect(detector.boundaryStartsMs(0, 4_000)).toEqual([1_000]);
    expect(detector.boundaryStartsMs(0, 10_000)).toEqual([1_000, 5_000]);
  });
});
