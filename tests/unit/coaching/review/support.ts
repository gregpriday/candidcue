/**
 * Fixture builders for the post-take review tests.
 *
 * These builders deliberately do **not** compute anything the modules under
 * test compute. Every fixture is chosen so the right answer is known by
 * arithmetic done here in the test file — 12 fillers over 900 words is 1.33 per
 * hundred whatever `session-summary.ts` happens to do — and the assertions name
 * the number, never `toBeGreaterThan(0)`.
 */
import type { FillerEvent, FillerKind } from '../../../../src/shared/contracts/coaching';
import type { CadenceMetrics } from '../../../../src/shared/coaching/prosody/cadence-analyzer';
import type {
  BoundaryRecord,
  CoachingSessionRecord,
  CriticalFindingRecord,
  MicrophoneSessionRecord,
  PaceSample,
  ReviewScript,
  ReviewTargetProfile,
  ReviewVersions,
  ShownTipRecord,
  TakePassRecord,
  TerminalRushRecord,
  VarietySample,
} from '../../../../src/shared/coaching/review/types';

export const TEST_PROFILE: ReviewTargetProfile = {
  deliveryStyle: 'natural',
  targetWpmLow: 115,
  targetWpmHigh: 160,
  targetVarietyLow: 40,
  targetVarietyHigh: 70,
  targetDurationMs: null,
  terminalRushRatioThreshold: 1.25,
};

export const TEST_VERSIONS: ReviewVersions = {
  coachingSchemaVersion: 1,
  algorithmVersion: 'alg-1',
  tipPolicyVersion: 'tip-1',
  lunaPromptVersion: 'luna-1',
  transcriptionModels: ['gpt-realtime-mini'],
  precisionTranscriptionActive: false,
};

export const EMPTY_CADENCE: CadenceMetrics = {
  runOnCount: 0,
  choppyPauseCount: 0,
  cadenceBalance: null,
  longestBreathGroupMs: 0,
  eligibleBoundaries: 0,
  shapedBoundaries: 0,
};

export const EMPTY_MICROPHONE: MicrophoneSessionRecord = {
  spans: [],
  levelSamples: [],
  transcriptionDegradedMs: 0,
};

let fillerSeq = 0;

export function makeFiller(options: {
  atMs: number;
  durationMs?: number;
  kind?: FillerKind;
  normalizedForm?: string;
  displayForm?: string | null;
  confidence?: FillerEvent['confidence'];
  takePassId?: string;
  authoredIntentional?: boolean;
  scriptAnchorTokenId?: string | null;
  timingConfidence?: number;
}): FillerEvent {
  fillerSeq += 1;
  const kind = options.kind ?? 'strict_vocalized';
  return {
    eventId: `fil_${fillerSeq}`,
    kind,
    normalizedForm: options.normalizedForm ?? 'um',
    displayForm:
      options.displayForm !== undefined
        ? options.displayForm
        : kind === 'strict_vocalized'
          ? (options.normalizedForm ?? 'um')
          : null,
    confidence: options.confidence ?? 'confirmed',
    evidenceSources: ['realtime'],
    audioStartMs: options.atMs,
    audioEndMs: options.atMs + (options.durationMs ?? 300),
    timingConfidence: options.timingConfidence ?? 0.9,
    scriptAnchorTokenId: options.scriptAnchorTokenId ?? null,
    takePassId: options.takePassId ?? 'pass-1',
    authoredIntentional: options.authoredIntentional ?? false,
    countedLive: true,
  };
}

export interface PassOptions {
  takePassId?: string;
  passOrdinal?: number;
  startMs?: number;
  endMs?: number;
  voicedMs?: number;
  internalPauseMs?: number;
  unmeasuredSpans?: TakePassRecord['time']['unmeasuredSpans'];
  audibleWords?: number;
  contentWords?: number;
  fillers?: readonly FillerEvent[];
  paceSamples?: readonly PaceSample[];
  varietySamples?: readonly VarietySample[];
  boundaries?: readonly BoundaryRecord[];
  terminalRushSentences?: readonly TerminalRushRecord[];
  cadence?: CadenceMetrics;
  tipsShown?: readonly ShownTipRecord[];
  criticalFindings?: readonly CriticalFindingRecord[];
  coveredSpanIds?: readonly string[];
  projectedTotalMs?: number | null;
  pauses?: TakePassRecord['pauses'];
  scriptPositions?: TakePassRecord['scriptPositions'];
  speechIntervals?: TakePassRecord['speechIntervals'];
  transcript?: TakePassRecord['transcript'];
}

export function makePass(options: PassOptions = {}): TakePassRecord {
  const startMs = options.startMs ?? 0;
  const endMs = options.endMs ?? 360_000;
  return {
    takePassId: options.takePassId ?? 'pass-1',
    passOrdinal: options.passOrdinal ?? 1,
    time: {
      startMs,
      endMs,
      voicedMs: options.voicedMs ?? 300_000,
      internalPauseMs: options.internalPauseMs ?? 45_000,
      unmeasuredSpans: options.unmeasuredSpans ?? [],
    },
    words: {
      audibleWords: options.audibleWords ?? 900,
      contentWords: options.contentWords ?? 880,
    },
    speechIntervals: options.speechIntervals ?? [],
    paceSamples: options.paceSamples ?? [],
    varietySamples: options.varietySamples ?? [],
    scriptPositions: options.scriptPositions ?? [],
    fillers: options.fillers ?? [],
    pauses: options.pauses ?? [],
    boundaries: options.boundaries ?? [],
    terminalRushSentences: options.terminalRushSentences ?? [],
    cadence: options.cadence ?? EMPTY_CADENCE,
    emphasis: [],
    tipsShown: options.tipsShown ?? [],
    criticalFindings: options.criticalFindings ?? [],
    coveredSpanIds: options.coveredSpanIds ?? [],
    projectedTotalMs: options.projectedTotalMs ?? null,
    transcript: options.transcript ?? null,
  };
}

export function makeRecord(
  passes: readonly TakePassRecord[],
  overrides: Partial<CoachingSessionRecord> = {},
): CoachingSessionRecord {
  return {
    schemaVersion: 1,
    sessionId: 'session-1',
    scriptId: 'script-1',
    scriptRevision: 3,
    startedAtIso: '2026-07-01T09:00:00.000Z',
    endedAtIso: '2026-07-01T09:06:00.000Z',
    versions: TEST_VERSIONS,
    profile: TEST_PROFILE,
    consent: { saveReport: true, saveTranscript: false, saveAudio: false },
    passes,
    microphone: EMPTY_MICROPHONE,
    audio: { available: false, reason: 'recording_not_enabled' },
    ...overrides,
  };
}

/** A three-passage script whose token ids are trivially predictable. */
export const TEST_SCRIPT: ReviewScript = {
  scriptId: 'script-1',
  scriptRevision: 3,
  passages: [
    {
      spanId: 'span-a',
      tokenIds: ['t1', 't2', 't3'],
      text: 'We shipped the release on Tuesday.',
      paragraphIndex: 0,
      sentenceIndex: 0,
    },
    {
      spanId: 'span-b',
      tokenIds: ['t4', 't5', 't6'],
      text: 'Adoption reached forty percent in the first week.',
      paragraphIndex: 0,
      sentenceIndex: 1,
    },
    {
      spanId: 'span-c',
      tokenIds: ['t7', 't8'],
      text: 'That is where we go next.',
      paragraphIndex: 1,
      sentenceIndex: 0,
    },
  ],
};
