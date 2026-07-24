/**
 * Tracking worker message protocol (spec §45.4, companion §46/§50.4).
 *
 * The worker is initialized once with the compact `TrackingDocument`
 * projection and an alignment profile, then consumes transcript events and
 * emits revisioned snapshots, state changes, and diagnostics. The command
 * router runs in the control frontend (spec §45.5), so masking/pending
 * messages let it exclude command phrases from alignment (G.1).
 *
 * Companion additions (Appendix E "§46 IPC"):
 *   - `initialize` accepts a `SmoothFollowProfile` alongside the v1 profile;
 *   - `tick` advances the continuous estimate between transcript events;
 *   - `semantic_assist` feeds bounded Luna evidence into the beam scorer;
 *   - `set_layout_generation` acknowledges a rebuilt stage line map;
 *   - `semantic_frame` carries `SemanticMotionFrame` out at 15–30 Hz;
 *   - `movement_decision` carries the "why did it move?" record (§65).
 *
 * Every v1 message and every v1 outbound type is unchanged, so existing
 * control-side consumers keep working without modification.
 *
 * ## Time domains (companion §9.1)
 *
 * Inbound `nowMs`, `receivedAtMs`, `audioStartMs`, `audioEndMs` and the
 * sidecar's `receivedAtMs` are all stamps on the **control window's clock**.
 * The worker converts them into the session domain at the boundary
 * (`SessionClock`), so `sessionTimeMs = 0` at `initialize` and no downstream
 * value can move backwards when the host's wall clock does.
 *
 * The producer stamps are therefore load-bearing — they carry the *intervals*
 * the engine measures pace and staleness against — but they are no longer what
 * anything is ordered on. A producer is free to keep sending `Date.now()`; it
 * must not assume the value it sent is the value the worker used.
 */
import type { NavigationTarget } from '../contracts/compiler';
import type { AssistSchedulingContext } from '../semantic/types';
import type { SemanticMotionFrame } from '../contracts/smooth-follow';
import type { TrackingSnapshot, TrackingState } from '../contracts/tracking';
import type { MovementDecisionRecord } from './decision-log';
import type { PartialSmoothFollowProfile, TrackingProfile } from './profile';
import type { SemanticAssistEvidence } from './semantic-assist';
import type { AlignmentDiagnostic, TrackingDocument, TranscriptEvent } from './types';

export interface TrackingSessionInit {
  sessionId: string;
  sessionGeneration: number;
  stageGeneration: number;
  /** Companion §7.2 — the stage's current layout generation, if known. */
  layoutGeneration?: number;
}

export type TrackingWorkerInbound =
  | {
      type: 'initialize';
      document: TrackingDocument;
      profile?: Partial<TrackingProfile>;
      /** Companion §55 versioned smooth-follow configuration. */
      smoothProfile?: PartialSmoothFollowProfile;
      session: TrackingSessionInit;
      nowMs: number;
    }
  | { type: 'transcript_event'; event: TranscriptEvent }
  | { type: 'manual_move'; target: NavigationTarget; revision: number; nowMs: number }
  | { type: 'command_move'; target: NavigationTarget; revision: number; nowMs: number }
  | { type: 'move_to_token'; tokenIndex: number; movement: 'manual' | 'command'; nowMs: number }
  | { type: 'mask_items'; itemIds: string[] }
  | { type: 'release_items'; itemIds: string[] }
  | { type: 'set_command_pending'; pending: boolean; nowMs: number }
  | { type: 'pause'; nowMs: number }
  | { type: 'resume'; nowMs: number }
  | { type: 'reset'; nowMs: number }
  /**
   * Companion §26.1: advance the continuous estimate and emit a frame when
   * one is due. The control window drives this from its animation loop so the
   * worker never reads a clock of its own.
   */
  | { type: 'tick'; nowMs: number }
  /**
   * Companion §40: bounded semantic evidence from the Luna sidecar. The
   * sidecar owns scheduling and the network call; this message only delivers
   * relations over candidate ids the local aligner already supplied, and the
   * beam clamps their influence to `alignment.semanticInfluenceMax`.
   */
  | { type: 'semantic_assist'; evidence: SemanticAssistEvidence }
  /** Companion §7.2: the stage rebuilt its line map. */
  | { type: 'set_layout_generation'; generation: number; nowMs: number };

export type TrackingWorkerOutbound =
  | { type: 'ready'; sessionGeneration: number }
  | { type: 'snapshot'; snapshot: TrackingSnapshot }
  | { type: 'state_change'; state: TrackingState }
  | { type: 'diagnostic'; diagnostic: AlignmentDiagnostic }
  /**
   * Companion §37.1 — the local aligner's post-section-gate candidate set and
   * the state the Luna sidecar schedules against.
   *
   * This is the *inverse* of `semantic_assist`: the worker offers candidates,
   * the sidecar ranks them, and the ranking comes back bounded. Without it the
   * sidecar has no input at all and no semantic assist can ever happen.
   *
   * Rate-limited inside the engine by `profile.semanticContextIntervalMs`
   * (2 Hz) and emitted only on finalized evidence — it is NOT a per-event
   * message and must never become one (§63).
   */
  | { type: 'semantic_context'; revision: number; context: AssistSchedulingContext }
  /** Companion §26.1 — the stage's motion input. */
  | { type: 'semantic_frame'; frame: SemanticMotionFrame }
  /** Companion §65 — developer diagnostics, text-free. */
  | { type: 'movement_decision'; record: MovementDecisionRecord }
  | { type: 'error'; code: 'not_initialized' | 'bad_message'; message: string };
