/**
 * Fixtures for the Coaching Rail tests.
 *
 * Built on the real producer helpers (`initialPaceState` and friends) rather
 * than on hand-written literals, so a change to what the producer considers a
 * correct pre-evidence state fails these tests instead of silently diverging
 * from them.
 */
import {
  initialFillerState,
  initialMicrophoneState,
  initialPaceState,
  initialVarietyState,
  resolveRailModules,
} from '../../../src/shared/coaching/coach/coach-state';
import {
  DELIVERY_SCORE_WEIGHTS,
  type CoachRailState,
  type CoachRailTip,
  type CoachRibbonEvent,
  type CoachRibbonEventType,
  type DeliveryDimension,
  type DeliveryScoreState,
  type DimensionScore,
} from '../../../src/shared/contracts/coaching';

export function railState(overrides: Partial<CoachRailState> = {}): CoachRailState {
  const mode = overrides.mode ?? 'coach';
  const state: CoachRailState = {
    schemaVersion: 1,
    stageRevision: 1,
    sessionId: 'session-1',
    takePassId: 'pass-1',
    mode,
    // Resolved through the real producer, so a mode whose meaning changes is
    // reflected here rather than pinned to a stale hand-written literal.
    modules: resolveRailModules(mode),
    audioTimeMs: 0,
    visible: true,
    mirrored: false,
    reducedMotion: false,
    pace: initialPaceState(115, 160),
    variety: initialVarietyState(40, 75),
    fillers: initialFillerState(),
    microphone: initialMicrophoneState(),
    activeTip: null,
    ribbonEvents: [],
    gutterMarks: [],
    // Not scored by default. Tests that care about the score opt in, so a
    // fixture default can never be mistaken for a real measurement.
    score: null,
    ...overrides,
  };
  // The producer bounds the ribbon against its own `audioTimeMs` and stamps
  // every tip and pace sample from the same clock, so a real snapshot can never
  // carry evidence from *after* the time it claims to describe. A fixture that
  // did would be testing a payload the producer cannot emit — so unless a test
  // states a time deliberately (which is how the clock's own behaviour is
  // exercised), the fixture derives one that is consistent with its evidence.
  return overrides.audioTimeMs === undefined
    ? { ...state, audioTimeMs: newestEvidenceMs(state) }
    : state;
}

function newestEvidenceMs(state: CoachRailState): number {
  let newest = 0;
  const consider = (value: number | null | undefined): void => {
    if (typeof value === 'number' && Number.isFinite(value) && value > newest) newest = value;
  };
  for (const event of state.ribbonEvents) consider(event.endMs);
  consider(state.activeTip?.createdAudioTimeMs);
  const series = state.pace.recentSeries;
  consider(series[series.length - 1]?.audioTimeMs);
  return newest;
}

/**
 * A delivery score with deliberately *distinctive* dimension figures.
 *
 * §11.2 forbids the seven dimension scores on the glass, and the cheapest way
 * to prove they never arrive is to make each one a number that could not have
 * come from anywhere else on the rail. Nothing here shares a value with the
 * pace target, the variety band, or the display score.
 */
export function deliveryScore(overrides: Partial<DeliveryScoreState> = {}): DeliveryScoreState {
  const DISTINCTIVE: Record<DeliveryDimension, number> = {
    pace: 31,
    pausing: 33,
    variety: 37,
    emphasis: 39,
    fluency: 41,
    clarity: 43,
    consistency: 47,
  };
  const dimensions: DimensionScore[] = (
    Object.keys(DELIVERY_SCORE_WEIGHTS) as DeliveryDimension[]
  ).map((dimension) => ({
    dimension,
    score: DISTINCTIVE[dimension],
    confidence: 0.71,
    weight: DELIVERY_SCORE_WEIGHTS[dimension],
  }));
  return {
    displayScore: 84,
    // Deliberately far from `displayScore`: diagnostics only, and a rail that
    // ever printed it would be caught by the digits rather than by the field.
    rawScore: 57,
    confidence: 0.62,
    tier: 'usable',
    dimensions,
    weakestDimension: 'pace',
    trend: 'steady',
    ...overrides,
  };
}

export function tip(overrides: Partial<CoachRailTip> = {}): CoachRailTip {
  return {
    tipId: 'tip-1',
    code: 'USE_SILENT_PAUSE',
    textKey: 'coach.tip.USE_SILENT_PAUSE',
    interpolations: {},
    severity: 'gentle',
    priority: 65,
    createdAudioTimeMs: 10_000,
    evidenceStartMs: 8_000,
    evidenceEndMs: 10_000,
    earliestDisplayMs: 10_000,
    expiresAudioTimeMs: 16_000,
    minimumDisplayMs: 2_500,
    maximumDisplayMs: 4_500,
    cooldownKey: 'filler',
    trackingEpoch: 1,
    takePassId: 'pass-1',
    scriptAnchorTokenId: null,
    evidenceIds: ['e1'],
    source: 'local',
    ...overrides,
  };
}

export function ribbonEvent(
  type: CoachRibbonEventType,
  startMs: number,
  endMs: number,
  overrides: Partial<CoachRibbonEvent> = {},
): CoachRibbonEvent {
  return {
    eventId: `${type}-${startMs}`,
    type,
    startMs,
    endMs,
    confidence: 1,
    takePassId: 'pass-1',
    ...overrides,
  };
}
