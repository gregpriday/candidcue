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
import type {
  CoachRailState,
  CoachRailTip,
  CoachRibbonEvent,
  CoachRibbonEventType,
} from '../../../src/shared/contracts/coaching';

export function railState(overrides: Partial<CoachRailState> = {}): CoachRailState {
  const mode = overrides.mode ?? 'coach';
  return {
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
