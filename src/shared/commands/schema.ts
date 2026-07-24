/**
 * Strict command validation and allow-listed execution policy
 * (spec §33.8–§33.9, G.8). Every action — local or Luna — passes through
 * `validateCommandAction` and `decideExecution` before anything runs.
 */
import type { CommandAction } from '../contracts/commands';
import type { NavigationTarget } from '../contracts/compiler';
import { DEFAULT_COMMAND_BOUNDS, type CommandBounds } from './settings';

export type CommandActionName = CommandAction['action'];

/** Allow-list of executable actions (spec §33.8 enum + documented additions). */
export const ALLOWED_ACTIONS: ReadonlySet<CommandActionName> = new Set<CommandActionName>([
  'start', 'pause', 'resume', 'hard_pause', 'stop',
  'go_to_target', 'next_section', 'previous_section',
  'move_relative', 'restart_unit', 'set_font_size', 'adjust_font_size',
  'set_margins', 'toggle_mirror', 'blank_stage', 'unblank_stage',
  'set_listener', 'adjust_reading_band', 'set_scroll_mode',
  'adjust_margins', 'set_cue_visibility', 'adjust_listener_opacity',
  'set_scroll_speed', 'adjust_scroll_speed', 'retake', 'mark_checkpoint',
  'set_coaching_rail',
  'unknown',
]);

export interface ValidationContext {
  navigationTargets: readonly NavigationTarget[];
  bounds?: CommandBounds;
}

export type ValidationResult =
  | { ok: true; action: CommandAction }
  | { ok: false; reason: string };

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Validate and normalize a `CommandAction`. Numeric settings are clamped to
 * safe configured ranges (§34.4); nonexistent targets are rejected (§33.8).
 */
export function validateCommandAction(
  action: CommandAction,
  context: ValidationContext,
): ValidationResult {
  const bounds = context.bounds ?? DEFAULT_COMMAND_BOUNDS;
  if (!ALLOWED_ACTIONS.has(action.action)) {
    return { ok: false, reason: 'action_not_allowed' };
  }
  switch (action.action) {
    case 'go_to_target': {
      const exists = context.navigationTargets.some((t) => t.id === action.targetId);
      return exists ? { ok: true, action } : { ok: false, reason: 'unknown_target' };
    }
    case 'move_relative': {
      if (!finite(action.amount) || action.amount <= 0) {
        return { ok: false, reason: 'invalid_amount' };
      }
      return {
        ok: true,
        action: { ...action, amount: clamp(Math.round(action.amount), 1, 20) },
      };
    }
    case 'set_font_size':
      if (!finite(action.valuePx)) return { ok: false, reason: 'invalid_value' };
      return {
        ok: true,
        action: { ...action, valuePx: clamp(action.valuePx, bounds.fontSizeMinPx, bounds.fontSizeMaxPx) },
      };
    case 'adjust_font_size':
      if (!finite(action.deltaSteps) || action.deltaSteps === 0) {
        return { ok: false, reason: 'invalid_value' };
      }
      return { ok: true, action: { ...action, deltaSteps: clamp(Math.round(action.deltaSteps), -5, 5) } };
    case 'set_margins':
      if (!finite(action.valuePercent)) return { ok: false, reason: 'invalid_value' };
      return {
        ok: true,
        action: {
          ...action,
          valuePercent: clamp(action.valuePercent, bounds.marginsMinPercent, bounds.marginsMaxPercent),
        },
      };
    case 'adjust_margins':
    case 'adjust_listener_opacity':
    case 'adjust_scroll_speed':
      if (!finite(action.deltaPercent) || action.deltaPercent === 0) {
        return { ok: false, reason: 'invalid_value' };
      }
      return { ok: true, action: { ...action, deltaPercent: clamp(action.deltaPercent, -50, 50) } };
    case 'adjust_reading_band':
      if (!finite(action.deltaPercent) || action.deltaPercent === 0) {
        return { ok: false, reason: 'invalid_value' };
      }
      return { ok: true, action: { ...action, deltaPercent: clamp(action.deltaPercent, -25, 25) } };
    case 'set_scroll_speed':
      if (!finite(action.wordsPerMinute)) return { ok: false, reason: 'invalid_value' };
      return {
        ok: true,
        action: {
          ...action,
          wordsPerMinute: clamp(action.wordsPerMinute, bounds.scrollWpmMin, bounds.scrollWpmMax),
        },
      };
    case 'unknown':
      return { ok: true, action };
    default:
      return { ok: true, action };
  }
}

/* ---------------------------------------------------------------------------
 * Execution policy (spec §33.9, G.8).
 * ------------------------------------------------------------------------- */

export interface ExecutionState {
  /** Realtime session state: hard pause closes mic + session (§34.1). */
  hardPaused: boolean;
  /** A take is currently being recorded (confirm "stop", §33.9). */
  takeInProgress: boolean;
  /** User setting: confirm stop while a take is in progress. */
  confirmStopDuringTake: boolean;
}

export type ExecutionDecision =
  | { decision: 'execute' }
  | { decision: 'confirm'; reason: string }
  | { decision: 'reject'; reason: string };

const IMMEDIATE_ACTIONS: ReadonlySet<CommandActionName> = new Set<CommandActionName>([
  'start', 'resume', 'pause', 'hard_pause',
  'next_section', 'previous_section', 'move_relative', 'restart_unit',
  'go_to_target', 'set_font_size', 'adjust_font_size', 'set_margins',
  'adjust_margins', 'adjust_reading_band', 'toggle_mirror',
  'set_listener', 'adjust_listener_opacity', 'blank_stage', 'unblank_stage',
  'set_cue_visibility', 'set_scroll_mode', 'set_scroll_speed',
  'adjust_scroll_speed', 'retake', 'mark_checkpoint',
  // Display-only, reversible, and touches nothing positional — safe to apply
  // without confirmation, like the other stage-appearance commands.
  'set_coaching_rail',
]);

export function decideExecution(
  action: CommandAction,
  state: ExecutionState,
  requiresConfirmation: boolean,
): ExecutionDecision {
  if (action.action === 'unknown') {
    return { decision: 'reject', reason: 'unknown_action' };
  }
  if (action.action === 'resume' && state.hardPaused) {
    // §34.1: a voice command cannot resume from hard pause — mic is closed.
    return { decision: 'reject', reason: 'hard_paused' };
  }
  if (action.action === 'stop') {
    if (state.takeInProgress && state.confirmStopDuringTake) {
      return { decision: 'confirm', reason: 'stop_during_take' }; // §33.9
    }
    return { decision: 'execute' };
  }
  if (requiresConfirmation) {
    // §33.9: low-confidence/ambiguous duplicate targets confirm in control.
    return { decision: 'confirm', reason: 'ambiguous_target' };
  }
  if (IMMEDIATE_ACTIONS.has(action.action)) {
    return { decision: 'execute' };
  }
  return { decision: 'reject', reason: 'not_allow_listed' };
}
