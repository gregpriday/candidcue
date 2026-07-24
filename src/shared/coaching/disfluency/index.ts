/**
 * Layered filler / disfluency detection (§15, §16, §29).
 *
 * Public surface of the disfluency subsystem. Consumers should import from
 * here; the shared *contract* types (`FillerEvent`, `FillerDisplayState`,
 * `CoachCandidate`, …) come from `src/shared/contracts/coaching.ts` and are
 * deliberately not re-exported, so there is exactly one place they are
 * defined.
 */
export {
  AcousticCandidateDetector,
  type AcousticCandidateOptions,
} from './acoustic-candidate-detector';
export {
  CONTEXTUAL_CONFIRM_CONFIDENCE,
  CONTEXTUAL_QUOTE_CONFIDENCE,
  classifyContextual,
  type ContextualEvidence,
  type ContextualVerdict,
} from './contextual-classifier';
export {
  DEFAULT_FILLER_CANDIDATE_CONFIG,
  generateFillerCandidates,
  type FillerCandidateConfig,
  type FillerCandidateInput,
} from './filler-candidates';
export {
  FillerLexicon,
  createFillerLexicon,
  type FillerLexiconOptions,
  type StrictFillerEntry,
} from './filler-lexicon';
export { FillerTracker, type FillerTrackerOptions } from './filler-tracker';
export {
  PRECISION_CHUNK_BOUNDS,
  PrecisionTranscriptionQueue,
  type EnqueueOutcome,
  type PermanentTranscriptionError,
  type PrecisionQueueDiagnostics,
  type PrecisionQueueOptions,
} from './precision-transcriber';
export {
  RealtimeFillerDetector,
  type AcousticEvidenceLookup,
  type OpenerObservation,
  type RealtimeDetectionResult,
  type RealtimeFillerDetectorOptions,
} from './realtime-filler-detector';
export {
  alignSequences,
  reconcilePrecisionResult,
  type AlignmentOp,
  type ReconcileInput,
} from './transcript-reconciler';
export {
  ACOUSTIC_ONLY_CONFIDENCE_CEILING,
  EVENT_IDENTITY_QUANTUM_MS,
  PRECISION_PRIORITY_RANK,
  UNLOCALIZED_TIMING_CONFIDENCE,
  fillerEventId,
  hasCredibleTiming,
  isCountableDisfluency,
  isCountableFiller,
  isUnlocalized,
  stableId,
  stampFor,
  type AcousticHesitationCandidate,
  type AuthoredSpanContext,
  type FillerDetection,
  type PrecisionChunkPriority,
  type PrecisionChunkRequest,
  type PrecisionCostMode,
  type PrecisionDropReason,
  type PrecisionDropRecord,
  type PrecisionTranscriptResult,
  type PrecisionTranscriptionClient,
  type ProvisionalFillerHint,
  type RealtimeTranscriptItem,
  type ReconciliationOutcome,
  type TakeIdentity,
  type TimingEvidence,
  type WordTiming,
} from './types';
export {
  applyPauseBoundaries,
  excerptAround,
  tokenizeUtterance,
  type UtteranceToken,
} from './utterance';
