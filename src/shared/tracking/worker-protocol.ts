/**
 * Tracking worker message protocol (spec §45.4).
 *
 * The worker is initialized once with the compact `TrackingDocument`
 * projection and an alignment profile, then consumes transcript events and
 * emits revisioned snapshots, state changes, and diagnostics. The command
 * router runs in the control frontend (spec §45.5), so masking/pending
 * messages let it exclude command phrases from alignment (G.1).
 */
import type { NavigationTarget } from '../contracts/compiler';
import type { TrackingSnapshot, TrackingState } from '../contracts/tracking';
import type { TrackingProfile } from './profile';
import type { AlignmentDiagnostic, TrackingDocument, TranscriptEvent } from './types';

export interface TrackingSessionInit {
  sessionId: string;
  sessionGeneration: number;
  stageGeneration: number;
}

export type TrackingWorkerInbound =
  | {
      type: 'initialize';
      document: TrackingDocument;
      profile?: Partial<TrackingProfile>;
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
  | { type: 'reset'; nowMs: number };

export type TrackingWorkerOutbound =
  | { type: 'ready'; sessionGeneration: number }
  | { type: 'snapshot'; snapshot: TrackingSnapshot }
  | { type: 'state_change'; state: TrackingState }
  | { type: 'diagnostic'; diagnostic: AlignmentDiagnostic }
  | { type: 'error'; code: 'not_initialized' | 'bad_message'; message: string };
