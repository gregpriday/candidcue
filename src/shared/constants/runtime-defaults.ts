/** Tunable runtime timings and limits (spec §12.5). Single source of truth. */
export const RUNTIME_DEFAULTS = {
  sttFinalizeDeadlineMs: 1500,
  transcriptCleanupDeadlineMs: 2000,
  moderationDeadlineMs: 1500,
  nextQuestionDeadlineMs: 6000,
  ttsDeadlineMs: 4000,
  stagePreloadDeadlineMs: 1000,
  postSpeechMicGuardMs: 250,
  endpointInitialSilenceMs: 900,
  endpointCommitSilenceMs: 1700,
  endpointHardSilenceMs: 5000,
  preRollMs: 400,
  maxTurnAudioMinutes: 20,
  maxQuestionWords: 42,
  targetQuestionWordsMin: 20,
  targetQuestionWordsMax: 35,
  maxQuestionAudioMs: 15000,
  questionAudioHardCeilingMs: 16000,
  /**
   * Hard safety multiplier on the soft targetQuestionCount. A model that keeps
   * asking (never returns `complete`) is forced to close once answered questions
   * reach ceil(targetQuestionCount * factor) — a backstop behind the model's own
   * termination, not a change to the soft target (issue #17).
   */
  questionCountHardCapFactor: 1.5,
  defaultWordsPerSecond: 2.7,
} as const;

export interface EndpointThresholds {
  minSilenceBeforeClassificationMs: number;
  commitProbability: number;
  minTotalSilenceMs: number;
}

export const ENDPOINT_THRESHOLDS: Record<'conservative' | 'balanced', EndpointThresholds> = {
  conservative: {
    minSilenceBeforeClassificationMs: 1200,
    commitProbability: 0.9,
    minTotalSilenceMs: 1900,
  },
  balanced: {
    minSilenceBeforeClassificationMs: 900,
    commitProbability: 0.82,
    minTotalSilenceMs: 1500,
  },
};

export const RETRY_POLICY = {
  transientHttpStatuses: [408, 409, 429, 500, 502, 503, 504],
  maxAttempts: 2,
  baseDelayMs: 300,
  maxDelayMs: 1500,
  jitter: true,
} as const;

export const MODEL_DEFAULTS = {
  interviewerModel: 'gpt-5.5',
  projectPreparationModel: 'gpt-5.5',
  cleanupModel: 'gpt-5.4-mini',
  endpointModel: 'gpt-5.4-nano',
  repairModel: 'gpt-5.4-mini',
  moderationModel: 'omni-moderation-latest',
} as const;

export const INWORLD_DEFAULTS = {
  sttModel: 'inworld/inworld-stt-1',
  ttsModel: 'inworld-tts-2',
  ttsSampleRate: 24000,
  sttSampleRate: 16000,
} as const;

export const MEDIA_DEFAULTS = {
  speakingPlaybackRateMin: 0.92,
  speakingPlaybackRateMax: 1.08,
  transitionMs: 100,
  maxSpeakingClipsPerQuestion: 2,
} as const;

/**
 * STOPGAP: average minutes per question, used only to translate an
 * `approximate_duration` interview target into an approximate question count.
 * A real elapsed-time budget (driving the interview off wall-clock duration
 * rather than a derived count) is deferred.
 */
export const APPROX_MINUTES_PER_QUESTION = 2;

export const PROJECT_LIMITS = {
  recentTurnCount: 6,
  maxConsecutiveFollowUps: 2,
  rollingSummaryMaxWords: 1500,
} as const;

/**
 * Weak continuation signal for the deterministic endpoint guard. Never decides
 * an endpoint on its own (spec §14.3).
 */
export const CONTINUATION_WORDS: readonly string[] = [
  'and', 'but', 'because', 'so', 'which', 'that', 'the', 'a', 'an', 'to',
  'for', 'with', 'or', 'nor', 'yet', 'if', 'when', 'while', 'as',
];

export const CONTINUATION_PHRASES: readonly string[] = [
  'first of all', 'the reason is', 'what happened was', 'for example',
  'one thing', 'another thing', 'the point is',
];

/** Internal terms a question must not surface to the user (spec §16.14). */
export const INTERNAL_TERMS: readonly string[] = [
  'coverage id', 'coverage item', 'system prompt', 'prompt version',
  'rolling summary', 'source ref', 'generation id', 'state machine',
  'orchestrator', 'zod', 'fallback bank',
];
