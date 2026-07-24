/// <reference lib="webworker" />
/**
 * Tracking worker shell — the deterministic local alignment engine runs off
 * the UI thread (spec §42.1, non-negotiable decision 7: no LLM decides the
 * user's script position). Instantiate from the control window with:
 *
 *   new Worker(new URL('../workers/tracking.worker.ts', import.meta.url), { type: 'module' })
 */
import type { FinalTranscriptItem, TrackingSnapshot } from '../shared/contracts';

export interface TrackingConfigureRequest {
  type: 'configure';
  sessionId: string;
  sessionGeneration: number;
  stageGeneration: number;
  scriptId: string;
  /** Tracking profile settings JSON (spec Appendix A.7). */
  profile: Record<string, number>;
}

export interface TrackingTranscriptRequest {
  type: 'transcript';
  item: FinalTranscriptItem;
}

export interface TrackingResetRequest {
  type: 'reset';
  tokenIndex: number;
}

export interface TrackingSnapshotResponse {
  type: 'snapshot';
  snapshot: TrackingSnapshot;
}

export type TrackingWorkerRequest =
  | TrackingConfigureRequest
  | TrackingTranscriptRequest
  | TrackingResetRequest;
export type TrackingWorkerResponse = TrackingSnapshotResponse;

self.onmessage = (event: MessageEvent<TrackingWorkerRequest>) => {
  const request = event.data;
  switch (request.type) {
    case 'configure':
    case 'transcript':
    case 'reset':
      // Stub: the alignment engine lands here. No snapshots are emitted yet.
      break;
  }
};

export {};
