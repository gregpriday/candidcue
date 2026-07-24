/**
 * v1 → v2 state and behavior mapping (companion §17, §52).
 *
 * The v1 engine's seven-state machine (`TrackingState`) still drives the
 * control Live screen and every existing snapshot consumer, so it is retained
 * exactly as it was. This module *projects* it onto the richer thirteen-state
 * `TrackingStateV2` plus the `TrackingBehavior` vocabulary the stage motion
 * controller needs, using the extra context the v2 layer already computes
 * (acquisition, correction class, active transition, ad-lib schedule phase).
 *
 * Keeping the mapping in one pure function means the two state machines can
 * never silently disagree, and the projection itself is unit-testable.
 */
import type { TrackingState } from '../contracts/tracking';
import type { TrackingBehavior, TrackingStateV2 } from '../contracts/smooth-follow';
import type { CorrectionClass } from './alignment-v2';
import type { MovementKind } from './types';

export interface BehaviorContext {
  /** v1 state after the decision was applied. */
  state: TrackingState;
  movement: MovementKind;
  /** False until the engine has ever committed a position (§17.1). */
  acquired: boolean;
  /** True when the decision came from provisional text only. */
  provisional: boolean;
  /** Correction class of the winning candidate (§25.1, A.3). */
  correction: CorrectionClass;
  /** A transition directive is currently active. */
  activeTransition: 'none' | 'settle' | 'catch_up' | 'rewind' | 'reanchor' | 'reset';
  /** Who authorized this emission (§56.1). Only a real navigation is 'command'/'manual'. */
  authority: 'ordinary' | 'command' | 'manual';
  /** Milliseconds since the last confident lock. */
  msSinceConfident: number;
  /** Prediction horizon for the current confidence (§24.6). */
  horizonMs: number;
  /** Speech is arriving but does not explain the script (§19.1). */
  offScript: boolean;
  /** The engine just committed a retake at this decision. */
  retakeCommitted: boolean;
  /** Confidence of the winning candidate. */
  confidence: number;
  /** Locked-confidence threshold from the profile. */
  lockedThreshold: number;
  /** Soft-evidence threshold from the profile. */
  softThreshold: number;
}

export interface BehaviorProjection {
  state: TrackingStateV2;
  behavior: TrackingBehavior;
}

export function projectBehavior(context: BehaviorContext): BehaviorProjection {
  return {
    state: projectState(context),
    behavior: projectBehaviorKind(context),
  };
}

/** Companion §17. */
export function projectState(context: BehaviorContext): TrackingStateV2 {
  switch (context.state) {
    case 'paused':
      return 'paused';
    case 'reconnecting':
      return 'reconnecting';
    case 'command_pending':
      return 'command_pending';
    case 'retake_candidate':
      return 'retake_pending';
    case 'searching':
      // Appendix E overrides §31.14 twice over. The executable search never
      // leaves the current section, so v1's "global search" is LOST_LOCAL —
      // *unless* the best candidate is still sitting near the cursor, which is
      // the §19.1 ad-lib signature (speech continues, but it is not script)
      // rather than a genuine loss of position.
      return context.offScript ? 'adlib_hold' : 'lost_local';
    default:
      break;
  }

  // Authorized discontinuities outrank the ordinary projection (§17.8–§17.9).
  if (context.activeTransition === 'reanchor') return 'reanchoring';
  if (context.activeTransition === 'rewind') return 'rewinding';
  if (context.activeTransition === 'catch_up') return 'catching_up';

  if (!context.acquired) return 'acquiring';

  if (context.state === 'holding') {
    return context.offScript ? 'adlib_hold' : 'uncertain';
  }

  // FOLLOWING with fresh evidence; COASTING inside the prediction horizon;
  // UNCERTAIN once the horizon lapses (§17.2–§17.4).
  if (context.movement === 'skip' && context.correction === 'catch_up') return 'catching_up';
  if (context.msSinceConfident > context.horizonMs) {
    return context.offScript ? 'adlib_hold' : 'coasting';
  }
  if (context.confidence > 0 && context.confidence < context.softThreshold) return 'uncertain';
  return 'following';
}

/** Companion §52. */
export function projectBehaviorKind(context: BehaviorContext): TrackingBehavior {
  // Authority, not movement kind: `setCommandPending` also emits a 'command'
  // movement, and freezing for a pending command is not navigation.
  if (context.authority === 'command') return 'command_navigation';
  if (context.authority === 'manual') return 'manual_navigation';
  if (!context.acquired) return 'acquire';
  if (context.state === 'searching') return context.offScript ? 'adlib' : 'lost';
  if (context.retakeCommitted || context.movement === 'retake') return 'retake';
  if (context.state === 'retake_candidate') return 'retake_candidate';

  if (context.movement === 'skip') {
    return context.correction === 'reanchor' ? 'large_skip' : 'small_skip';
  }

  if (context.movement === 'hold') {
    return context.offScript ? 'adlib' : 'minor_variation';
  }

  // `advance` means the local continuity path succeeded, so it is never
  // labelled a jump however far it moved (§20.1 "do not label it a jump").
  // Only v1's `skip` movement — a correction beyond the ordinary forward
  // distance — becomes small_skip/large_skip above.
  if (context.confidence >= context.lockedThreshold) return 'normal';
  if (context.confidence >= context.softThreshold) {
    // Lexically thin but positionally consistent — the paraphrase band.
    return 'paraphrase';
  }
  return 'minor_variation';
}

/**
 * Was the presenter returning to script after an off-script stretch?
 * Reported as `return` (§52) so the stage can accelerate gently (§19.3).
 */
export function isReturnToScript(previous: TrackingStateV2, next: TrackingStateV2): boolean {
  const wasOff = previous === 'adlib_hold' || previous === 'lost_local' || previous === 'uncertain';
  const isOn = next === 'following' || next === 'catching_up';
  return wasOff && isOn;
}
