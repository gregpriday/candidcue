/**
 * Transcript and tracking contracts (spec Appendix C.4) — final transcript
 * items feed the deterministic alignment engine in the tracking worker,
 * which emits revisioned tracking snapshots.
 */
import type { Uuid } from './core';

export interface TokenLogprob {
  token: string;
  logprob: number;
}

export interface FinalTranscriptItem {
  sessionGeneration: number;
  itemId: string;
  commitSequence: number;
  audioStartMs: number;
  audioEndMs: number;
  transcript: string;
  tokens: TranscriptToken[];
  logprobs?: TokenLogprob[];
}

export interface TranscriptToken {
  surface: string;
  normalized: string;
  confidence?: number;
  startMs?: number;
  endMs?: number;
}

export type TrackingState =
  | 'following'
  | 'holding'
  | 'searching'
  | 'retake_candidate'
  | 'command_pending'
  | 'paused'
  | 'reconnecting';

export interface TrackingSnapshot {
  schemaVersion: 1;
  revision: number;
  sessionId: Uuid;
  sessionGeneration: number;
  stageGeneration: number;
  scriptId: Uuid;
  tokenIndex: number;
  committedTokenIndex: number;
  blockId: string;
  sentenceId: string;
  confidence: number;
  state: TrackingState;
  provisional: boolean;
  movement: 'hold' | 'advance' | 'skip' | 'retake' | 'command' | 'manual';
  sourceItemIds: string[];
  generatedAtMs: number;
}
