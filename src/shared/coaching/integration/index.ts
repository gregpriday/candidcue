/**
 * The coaching integrator (§12.2).
 *
 * One class drives the six lanes: `CoachingOrchestrator`. It is pure and
 * dependency-injected — no Tauri, no `getUserMedia`, no store, no DOM — so the
 * session store's job is to construct it, feed it frames and transcript, push
 * host state, and forward the `CoachRailState` it publishes.
 */
export { CoachingOrchestrator } from './orchestrator';
export {
  FIRST_TAKE_PASS_ORDINAL,
  nextTakePassOrdinal,
  normalizeTakePassOrdinal,
  parseTakePassId,
  takePassIdFor,
} from '../take-pass';
export {
  MAX_AUTHORED_SPAN_SENTENCES,
  authoredSpanWindow,
  buildAuthoredSpans,
} from './authored-spans';
export { LaneGuard, type LaneGuardOptions } from './lane-guard';
export {
  PauseDeriver,
  type DerivedPause,
  type PauseDeriverOptions,
} from './pause-derivation';
export {
  createCoachingLanes,
  type CoachingLanes,
  type CoachingLanesOptions,
} from './lanes';
export {
  EMPTY_SCRIPT_DIRECTIVES,
  applyCoachFrontMatter,
  resolveScriptDirectives,
  type ScriptDirectiveMap,
} from './script-directives';
export {
  DEFAULT_COACHING_SCHEDULE,
  initialHostState,
  liveStateFrom,
  lunaProfileFrom,
  railModulesFromSettings,
  type AudioClock,
  type CoachingHostState,
  type CoachingLaneFailure,
  type CoachingLaneId,
  type CoachingOrchestratorDeps,
  type CoachingSchedule,
  type CoachingTelemetry,
} from './types';
