/**
 * A deliberately *good* delivery, so every test states its own deviation.
 *
 * Not a test file — no assertions here. Each field sits comfortably inside the
 * §8 "Conversational Authority" band, which means the baseline fixture scores
 * 100 on every available dimension and any number below 100 in a test is
 * traceable to the one knob that test turned.
 */
import type {
  FillerEvent,
  FillerKind,
  MicrophoneCoachState,
  PaceDisplayState,
  PitchReliability,
} from '../../../../src/shared/contracts/coaching';
import type { DeliveryEvidence, ScoredPause } from '../../../../src/shared/coaching/score/evidence';

export function paceState(overrides: Partial<PaceDisplayState> = {}): PaceDisplayState {
  return {
    wpm: 155,
    confidence: 0.9,
    state: 'on_target',
    targetLowWpm: 135,
    targetHighWpm: 175,
    targetDurationMs: null,
    projectedFinishDeltaMs: null,
    recentSeries: [],
    ...overrides,
  };
}

export function microphone(overrides: Partial<MicrophoneCoachState> = {}): MicrophoneCoachState {
  return {
    status: 'ok',
    levelDbfs: -20,
    snrDb: 28,
    sustained: false,
    transcriptionDegraded: false,
    ...overrides,
  };
}

export function reliability(overrides: Partial<PitchReliability> = {}): PitchReliability {
  return {
    usable: true,
    reliableFrameFraction: 0.9,
    usableVoicedMs: 60_000,
    referenceF0Hz: 120,
    reason: 'ok',
    ...overrides,
  };
}

/**
 * Pauses spread through the window so no speech run exceeds ~5 s and the P90
 * pause sits near 600 ms — comfortably inside §8's clause/sentence rows.
 */
export function healthyPauses(nowMs: number, windowMs = 30_000): ScoredPause[] {
  const pauses: ScoredPause[] = [];
  for (let start = nowMs - windowMs + 5_000; start < nowMs; start += 5_000) {
    pauses.push({ startMs: start, endMs: start + 600 });
  }
  return pauses;
}

export function filler(overrides: Partial<FillerEvent> & { kind: FillerKind }): FillerEvent {
  return {
    eventId: `filler-${overrides.audioStartMs ?? 0}-${overrides.kind}`,
    normalizedForm: 'um',
    displayForm: 'um',
    confidence: 'confirmed',
    evidenceSources: ['realtime'],
    audioStartMs: 0,
    audioEndMs: 200,
    timingConfidence: 0.9,
    scriptAnchorTokenId: null,
    takePassId: 'pass-1',
    authoredIntentional: false,
    countedLive: true,
    ...overrides,
  };
}

export interface FixtureOverrides {
  audioTimeMs?: number;
  fillerEvents?: readonly FillerEvent[];
  pauses?: readonly ScoredPause[];
  pace?: Partial<PaceDisplayState>;
  microphone?: Partial<MicrophoneCoachState>;
  pitchReliability?: Partial<PitchReliability>;
  pitch?: Partial<DeliveryEvidence['pitch']>;
  energy?: Partial<DeliveryEvidence['energy']>;
  cadence?: Partial<DeliveryEvidence['cadence']>;
  rates?: Partial<DeliveryEvidence['rates']>;
  terminalRushRatio?: number | null;
  alignmentConfidence?: number;
  suppressed?: boolean;
  voicedMsInWindow?: number;
  deliveryMsInWindow?: number;
}

export function evidenceAt(nowMs: number, overrides: FixtureOverrides = {}): DeliveryEvidence {
  const windowMs = 30_000;
  const deliveryMsInWindow = overrides.deliveryMsInWindow ?? Math.min(windowMs, nowMs);
  // A 20% pause ratio: inside §8's 12–28% row.
  const voicedMsInWindow = overrides.voicedMsInWindow ?? deliveryMsInWindow * 0.8;
  return {
    audioTimeMs: nowMs,
    takePassId: 'pass-1',
    pace: paceState(overrides.pace),
    rates: { audibleWpm: 155, contentWpm: 150, articulationWpm: 190, ...overrides.rates },
    terminalRushRatio: overrides.terminalRushRatio === undefined ? 1.02 : overrides.terminalRushRatio,
    suppressed: overrides.suppressed ?? false,
    voicedMsInWindow,
    deliveryMsInWindow,
    cadence: {
      runOnCount: 0,
      choppyPauseCount: 0,
      cadenceBalance: 0.9,
      longestBreathGroupMs: 5_000,
      eligibleBoundaries: 8,
      shapedBoundaries: 8,
      ...overrides.cadence,
    },
    alignmentConfidence: overrides.alignmentConfidence ?? 0.9,
    pitch: {
      frameCount: 900,
      coveredMs: 18_000,
      referenceF0Hz: 120,
      spanSemitones: 7,
      iqrSemitones: 3.5,
      motionSemitonesPerSecond: 2.5,
      contourTurnsPerMinute: 40,
      phraseFinalMovementSemitones: -1.2,
      ...overrides.pitch,
    },
    energy: {
      frameCount: 900,
      rangeDb: 10,
      phraseContrastDb: 6,
      narrowLevelRatio: 0.3,
      clippedFrameRatio: 0,
      degraded: false,
      ...overrides.energy,
    },
    pitchReliability: reliability(overrides.pitchReliability),
    fillerEvents: overrides.fillerEvents ?? [],
    pauses: overrides.pauses ?? healthyPauses(nowMs, windowMs),
    microphone: microphone(overrides.microphone),
  };
}
