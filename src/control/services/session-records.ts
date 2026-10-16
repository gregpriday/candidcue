/**
 * Session records (spec §36.1).
 *
 * These commands are registered in src-tauri/src/app.rs and implemented in
 * src-tauri/src/commands/sessions_cmds.rs. Until this service existed nothing in
 * the frontend invoked them, and two guarantees silently did not happen:
 *
 *  - §21.4: `start_session` takes the pre-session revision snapshot in Rust
 *    precisely "so it cannot be skipped by a frontend that forgets to ask" —
 *    and the frontend never asked;
 *  - §43.5: `AppCoordinator::begin_session` is the ONLY writer of the Rust-side
 *    session generation, so it stayed at its `Default` value of 0 while control
 *    stamped every stage payload with 1. `validate_stage_payload_header` then
 *    dropped every tracking snapshot and the stage never moved.
 *
 * Generation ownership: RUST ASSIGNS, CONTROL ADOPTS. `StartSessionInput` has
 * no `sessionGeneration` field — the generation is an output of
 * `coordinator.begin_session()`, returned on the record. Control must use the
 * value it gets back, never propose one. The same applies to the session id:
 * Rust mints the row's uuid, so that is the id the stage and the coordinator
 * agree on.
 */
import { invokeOrMock } from './ipc';
import { newSessionId } from './session';

/** Mirror of `sessions::StartSessionInput` (camelCase over IPC). */
export interface StartSessionRecordInput {
  scriptId: string;
  scriptSourceHash: string;
  mode: 'voice' | 'manual' | 'fixed';
  startTokenIndex?: number;
  compileHash?: string;
}

/** Mirror of `sessions::SessionRecord`. */
export interface SessionRecord {
  id: string;
  /** Assigned by the Rust coordinator — the authority for every stage payload. */
  sessionGeneration: number;
  scriptId: string;
  scriptSourceHash: string;
  startedAt: string;
  endedAt?: string;
  mode: string;
  startTokenIndex: number;
  endTokenIndex?: number;
  durationMs?: number;
  softPauseMs: number;
  commandCount: number;
  retakeCount: number;
  reconnectCount: number;
  manualCorrectionCount: number;
  /*
   * No `estimatedCostUsd`. It was per-take API spend from the hosted
   * transcription era; the column went with the 1.0 schema baseline.
   * Transcription runs on this machine, so a take costs nothing.
   */
  /**
   * False when `general.saveTranscript` is 'off' — fixed at session start.
   * Mirrored because Rust still sends it; the frontend no longer keeps a
   * transcript, so nothing here reads it.
   */
  transcriptRetained: boolean;
}

/** Mirror of `sessions::EndSessionSummary`. */
export interface EndSessionSummaryInput {
  endTokenIndex?: number;
  softPauseMs?: number;
  commandCount?: number;
  retakeCount?: number;
  reconnectCount?: number;
  manualCorrectionCount?: number;
  metrics?: Record<string, unknown>;
}

/**
 * Open the session record and, with it, the coordinator's session generation.
 *
 * Outside Tauri (plain-browser dev) there is no coordinator to agree with, so
 * the fallback mints a local id and generation 1. That path never talks to a
 * real stage, which is exactly why it is safe there and nowhere else.
 */
export async function startSessionRecord(
  input: StartSessionRecordInput,
): Promise<SessionRecord> {
  return invokeOrMock<SessionRecord>('start_session', { input }, () => ({
    id: newSessionId(),
    sessionGeneration: 1,
    scriptId: input.scriptId,
    scriptSourceHash: input.scriptSourceHash,
    startedAt: new Date().toISOString(),
    mode: input.mode,
    startTokenIndex: input.startTokenIndex ?? 0,
    softPauseMs: 0,
    commandCount: 0,
    retakeCount: 0,
    reconnectCount: 0,
    manualCorrectionCount: 0,
    transcriptRetained: false,
  }));
}

export async function endSessionRecord(
  sessionId: string,
  summary?: EndSessionSummaryInput,
): Promise<SessionRecord | null> {
  return invokeOrMock<SessionRecord | null>(
    'end_session',
    { sessionId, summary: summary ?? null },
    () => null,
  );
}

export async function listSessionRecords(
  scriptId?: string,
  limit?: number,
): Promise<SessionRecord[]> {
  return invokeOrMock<SessionRecord[]>(
    'list_sessions',
    { scriptId: scriptId ?? null, limit: limit ?? null },
    () => [],
  );
}
