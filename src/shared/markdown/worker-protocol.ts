/**
 * Compiler worker message protocol (spec §45.3).
 *
 * The UI tags every request with `editorRevision`; the worker compiles the
 * latest queued request only (latest wins) and answers older or cancelled
 * requests with `compile_superseded`. Results from stale revisions must
 * also be discarded on the UI side.
 */
import type { CompileOptions, CompiledScript } from '../contracts';

export interface CompileRequestMessage {
  type: 'compile';
  /** Monotonic per-worker request tag chosen by the caller. */
  requestId: number;
  /** Editor buffer revision this source snapshot came from. */
  editorRevision: number;
  scriptId: string;
  source: string;
  options: CompileOptions;
  /**
   * User dictionary snapshot (spec §45.3). Reserved for the vocabulary
   * merge step; the pure compiler does not consume it yet.
   */
  dictionary?: string[];
  /** Incremental compiles currently fall back to a full compile. */
  operation: 'full' | 'incremental';
}

export interface CancelRequestMessage {
  type: 'cancel';
  /** Cancel one pending request, or all pending when omitted. */
  requestId?: number;
}

export type CompilerWorkerRequest = CompileRequestMessage | CancelRequestMessage;

export interface CompileResultMessage {
  type: 'compile_result';
  requestId: number;
  editorRevision: number;
  script: CompiledScript;
  durationMs: number;
}

export interface CompileSupersededMessage {
  type: 'compile_superseded';
  requestId: number;
  editorRevision: number;
  /** The newer request that displaced this one, when applicable. */
  supersededBy?: number;
}

export interface CompileErrorMessage {
  type: 'compile_error';
  requestId: number;
  editorRevision: number;
  message: string;
}

export type CompilerWorkerResponse =
  | CompileResultMessage
  | CompileSupersededMessage
  | CompileErrorMessage;
