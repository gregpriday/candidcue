/**
 * The delivery scoring engine (Speaking Score report §9).
 *
 * The 0–100 speaking score the presenter sees in the coaching rail: a
 * confidence-weighted model over the measurements the pace, prosody, cadence
 * and disfluency lanes already produce. It measures nothing itself.
 */
export {
  atLeast,
  atMost,
  bandScore,
  clampScore,
  distanceFromBand,
  type TargetBand,
} from './band';
export {
  CONFIDENCE_TIER_THRESHOLDS,
  CONVERSATIONAL_AUTHORITY,
  DEFAULT_DELIVERY_SCORE_OPTIONS,
  DELIVERY_PROFILE_VERSION,
  type DeliveryScoreOptions,
  type DeliveryTargetProfile,
} from './profile';
export {
  combineDimensions,
  scoreDimension,
  weightedQuantile,
  type DimensionResult,
  type OverallScore,
  type SubmetricSample,
} from './dimension';
export {
  calibrationMaturityFrom,
  combineConfidence,
  confidenceTier,
  coverageFrom,
  ramp,
  signalQualityFrom,
  type ConfidenceComponents,
} from './confidence';
export { advanceDisplayScore, applyScoreRateCap, smoothTowards } from './smoothing';
export {
  PaceDriftTracker,
  TranscriptEvidenceLedger,
  type DeliveryEvidence,
  type ScoredPause,
} from './evidence';
export {
  buildSubmetrics,
  countConfirmed,
  longestRunMsInWindow,
  pauseDurationP90,
  SOURCEABLE_WEIGHT,
  UNSOURCED_SUBMETRICS,
  type DeliveryScoreMemory,
} from './submetrics';
export {
  DeliveryScoreEngine,
  type DeliveryScoreEngineOptions,
  type DeliveryScoreSnapshot,
} from './engine';
