/**
 * A synthesized take, driven through the real orchestrator and the real lanes.
 *
 * Nothing here stubs a lane. The point of these tests is that the *assembly*
 * works: every lane in this subsystem already had a green suite while the seams
 * between them did nothing at all, so a harness that substituted a lane would
 * reproduce exactly the blind spot it exists to close.
 *
 * The clock is fake, the frames are synthetic, and the transcript is authored
 * by the test — but the VAD, the speech clock, the microphone monitor, the pace
 * state machine, the filler tracker, the candidate registry and the tip policy
 * are all the shipping objects.
 */
import {
  CoachingOrchestrator,
  FIRST_TAKE_PASS_ORDINAL,
  initialHostState,
  takePassIdFor,
  type AudioClock,
  type CoachingHostState,
  type CoachingLaneFailure,
  type CoachingOrchestratorDeps,
} from '../../../../src/shared/coaching/integration';
import type {
  AudioFrameFeatures,
  CoachRailState,
  CoachingSettings,
} from '../../../../src/shared/contracts/coaching';
import type { Uuid } from '../../../../src/shared/contracts/core';
import type {
  AuthoredSpanContext,
  RealtimeTranscriptItem,
} from '../../../../src/shared/coaching/disfluency/types';
import type {
  SpokenSegment,
  SpokenWord,
} from '../../../../src/shared/coaching/pace/token-timing';

export const FRAME_MS = 20;
export const SESSION_ID = '2f8a1c4e-3b7d-4f2a-9c1e-5d6b7a8c9e01' as Uuid;
export const SCRIPT_ID = '9d1e2f3a-4b5c-4d6e-8f90-1a2b3c4d5e6f' as Uuid;
/**
 * The first take pass of {@link SESSION_ID}, minted through the one
 * authoritative scheme rather than written out — a harness that spelled its own
 * id would let the lanes drift again without a test noticing.
 */
export const TAKE = takePassIdFor(SESSION_ID, FIRST_TAKE_PASS_ORDINAL);

export class FakeAudioClock implements AudioClock {
  ms = 0;

  nowMs(): number {
    return this.ms;
  }
}

/** §30. A complete settings record; every test names only what it cares about. */
export function makeSettings(overrides: Partial<CoachingSettings> = {}): CoachingSettings {
  return {
    mode: 'coach',
    deliveryStyle: 'natural',
    pacePreset: 'natural_presentation',
    targetWpmLow: 115,
    targetWpmHigh: 160,
    targetVarietyLow: 45,
    targetVarietyHigh: 75,
    targetDurationSeconds: null,
    liveTipFrequency: 'normal',
    precisionTranscriptionMode: 'on_candidates',
    fillerDetectionScope: 'strict',
    customFillerWords: [],
    trackRepeatedOpeners: false,
    positiveReinforcementEnabled: false,
    postTakeReportEnabled: true,
    retainAudioRecordingEnabled: false,
    personalCalibrationEnabled: false,
    personalCalibrationResetAtEpochMs: null,
    goals: {
      maxFillersPerMinute: null,
      maxFillersPerHundredWords: null,
      paceWithinTargetRange: false,
      finishWithinTargetDuration: false,
      varietyWithinTargetBand: false,
    },
    railTextScale: 1,
    modules: {
      paceNumber: true,
      paceStatus: true,
      targetDurationStatus: true,
      varietyScore: true,
      fillerCount: true,
      fillerRibbon: true,
      inlineGutterMarks: false,
      liveTips: true,
      deliveryScore: true,
    },
    ...overrides,
  };
}

export function makeHost(overrides: Partial<CoachingHostState> = {}): CoachingHostState {
  return {
    ...initialHostState(SCRIPT_ID, TAKE),
    // A settled, trusted presenter: the tests that care about the gates set
    // them back down explicitly.
    alignmentConfidence: 0.9,
    safeMoment: true,
    sentenceBoundaryPassed: true,
    ...overrides,
  };
}

/** One 20 ms analysis frame. `speaking` drives the VAD above/below threshold. */
export function frameAt(
  audioTimeMs: number,
  speaking: boolean,
  overrides: Partial<AudioFrameFeatures> = {},
): AudioFrameFeatures {
  return {
    audioTimeMs,
    // Pitch and loudness both move, because a constant would put the variety
    // tile permanently at `very_steady` and quietly remove a whole lane from
    // every test that used this fixture.
    rmsDbfs: speaking ? -20 + 5 * Math.sin(audioTimeMs / 900) : -70,
    peakDbfs: speaking ? -10 : -60,
    clippingRatio: 0,
    noiseFloorDbfs: -70,
    estimatedSnrDb: speaking ? 25 : 2,
    speechProbability: speaking ? 0.92 : 0.02,
    voicedProbability: speaking ? 0.88 : 0,
    f0Hz: speaking ? 140 + 37 * Math.sin(audioTimeMs / 500) : null,
    f0Confidence: speaking ? 0.9 : 0,
    spectralFlux: speaking ? 0.4 : 0.02,
    zeroCrossingRate: 0.05,
    processorDropout: false,
    ...overrides,
  };
}

export interface HarnessOptions {
  settings?: Partial<CoachingSettings>;
  host?: Partial<CoachingHostState>;
  deps?: Partial<CoachingOrchestratorDeps>;
}

export class TakeHarness {
  readonly clock = new FakeAudioClock();
  readonly published: CoachRailState[] = [];
  readonly laneFailures: CoachingLaneFailure[] = [];
  readonly orchestrator: CoachingOrchestrator;

  /** Audio-clock time of the next frame's first sample. */
  audioMs = 0;
  private wall = 0;
  private segmentCounter = 0;

  constructor(options: HarnessOptions = {}) {
    const deps: CoachingOrchestratorDeps = {
      sessionId: SESSION_ID,
      audioClock: this.clock,
      settings: makeSettings(options.settings),
      host: makeHost(options.host),
      publish: (state) => this.published.push(state),
      // §37 only; monotonic and deterministic so a latency assertion is stable.
      wallClockMs: () => (this.wall += 1),
      onLaneFailure: (failure) => this.laneFailures.push(failure),
      ...options.deps,
    };
    this.orchestrator = new CoachingOrchestrator(deps);
  }

  /** Pump `durationMs` of frames. Returns the audio time after the last one. */
  pump(durationMs: number, speaking: boolean, overrides: Partial<AudioFrameFeatures> = {}): number {
    const frames = Math.round(durationMs / FRAME_MS);
    for (let index = 0; index < frames; index += 1) {
      const frame = frameAt(this.audioMs, speaking, overrides);
      this.audioMs += FRAME_MS;
      this.clock.ms = this.audioMs;
      this.orchestrator.handleFrame(frame);
    }
    return this.audioMs;
  }

  speak(durationMs: number, overrides: Partial<AudioFrameFeatures> = {}): number {
    return this.pump(durationMs, true, overrides);
  }

  silence(durationMs: number, overrides: Partial<AudioFrameFeatures> = {}): number {
    return this.pump(durationMs, false, overrides);
  }

  /**
   * Speak `text` over `durationMs`, let the VAD close the run, then deliver the
   * finalized transcript — the order a real session produces, because a commit
   * lands after endpointing.
   *
   * Returns the audio interval the words occupied, so a test can talk about it.
   */
  say(
    text: string,
    durationMs: number,
    options: { spanId?: string | null; trailingSilenceMs?: number } = {},
  ): { startMs: number; endMs: number; item: RealtimeTranscriptItem } {
    const startMs = this.audioMs;
    const endMs = this.speak(durationMs);
    this.silence(options.trailingSilenceMs ?? 600);
    this.segmentCounter += 1;
    const segmentId = `seg-${this.segmentCounter}`;
    const item: RealtimeTranscriptItem = {
      itemId: segmentId,
      commitSequence: this.segmentCounter,
      audioStartMs: startMs,
      audioEndMs: endMs,
      text,
      turnStart: this.segmentCounter === 1,
    };
    const segment: SpokenSegment = {
      segmentId,
      words: spokenWords(text, options.spanId ?? null),
      audioStartMs: startMs,
      audioEndMs: endMs,
      final: true,
      commitSequence: this.segmentCounter,
      takePassId: this.orchestrator.hostState().takePassId,
      confidence: 0.95,
    };
    this.orchestrator.noteTranscriptSegment(segment);
    this.orchestrator.noteFinalTranscript(item, authoredSpan(options.spanId ?? null));
    // §17.9 counts completed sentences, and the count is the caller's because
    // it comes from alignment. A harness that never advanced it would leave the
    // variety-tip gate permanently shut and hide the lane from every test.
    this.orchestrator.setHostState({ completedSentences: this.segmentCounter });
    // A transcript arriving between two frames is not itself a clock tick. The
    // aggregation pass runs on the audio clock (§12.2), so a few more frames
    // have to arrive before what the commit changed reaches the rail.
    this.settle();
    return { startMs, endMs, item };
  }

  /** Pump enough silent frames for an aggregation and a publication to land. */
  settle(durationMs = 300): void {
    this.silence(durationMs);
  }

  latest(): CoachRailState | null {
    return this.published[this.published.length - 1] ?? null;
  }
}

/** The authored material aligned to a transcript item. Empty text fails closed. */
export function authoredSpan(
  spanId: string | null,
  overrides: Partial<AuthoredSpanContext> = {},
): AuthoredSpanContext {
  return {
    spanId,
    scriptAnchorTokenId: spanId === null ? null : `${spanId}-t0`,
    text: '',
    ...overrides,
  };
}

/** Words as the coaching layer sees them — not rendered Markdown tokens. */
export function spokenWords(text: string, spanId: string | null): SpokenWord[] {
  return text
    .split(/\s+/u)
    .filter((word) => word.length > 0)
    .map((word) => ({
      text: word.replace(/[^\p{L}\p{N}']/gu, ''),
      excluded: false,
      confirmedFiller: false,
      repetition: false,
      endsSentence: /[.!?]$/u.test(word),
      scriptSpanId: spanId,
    }));
}

/**
 * N words of filler-free prose.
 *
 * Deliberately all monosyllables and all distinct within a cycle: token timing
 * is distributed by a syllable estimate (§14.3), so mixed word lengths make the
 * synthetic sentence genuinely end faster than it started and the terminal-rush
 * analyzer — correctly — fires. A "clean take" fixture has to be clean in the
 * dimensions it claims to be clean in.
 */
export function prose(wordCount: number): string {
  const vocabulary = [
    'we',
    'set',
    'the',
    'plan',
    'and',
    'then',
    'ship',
    'code',
    'with',
    'care',
    'each',
    'week',
    'from',
    'here',
    'on',
    'out',
  ];
  const out: string[] = [];
  for (let index = 0; index < wordCount; index += 1) {
    out.push(vocabulary[index % vocabulary.length] as string);
  }
  return `${out.join(' ')}.`;
}
