/**
 * Session records (spec §36.1) and optional transcript retention (§36.2).
 *
 * These four commands are registered in src-tauri/src/app.rs and implemented in
 * src-tauri/src/commands/sessions_cmds.rs. Until this service existed nothing in
 * the frontend invoked them, and three guarantees silently did not happen:
 *
 *  - §21.4: `start_session` takes the pre-session revision snapshot in Rust
 *    precisely "so it cannot be skipped by a frontend that forgets to ask" —
 *    and the frontend never asked;
 *  - §36.2: no session row existed, so no transcript could ever be retained;
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
  estimatedCostUsd?: number;
  /** False when `general.saveTranscript` is 'off' — fixed at session start. */
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
  estimatedCostUsd?: number;
  metrics?: Record<string, unknown>;
}

/** Mirror of `sessions::TranscriptItemInput`. */
export interface TranscriptItemInput {
  commitSequence: number;
  providerItemId?: string;
  audioStartMs?: number;
  audioEndMs?: number;
  transcript: string;
  disposition: 'script' | 'command' | 'discarded';
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

/**
 * Persist finalized transcript items. Rust REFUSES this when the session was
 * started with retention disabled, so a session started under
 * `saveTranscript: 'off'` cannot be talked into keeping text later — call it
 * only when `transcriptRetained` came back true.
 */
export async function appendSessionTranscript(
  sessionId: string,
  items: TranscriptItemInput[],
): Promise<number> {
  if (items.length === 0) return 0;
  return invokeOrMock<number>('append_session_transcript', { sessionId, items }, () => 0);
}

/* ---------------------------------------------------------------------------
 * §36.3 take history
 * ------------------------------------------------------------------------- */

/** A position the take passed through. Mirrors `sessions::TakeCheckpoint`. */
export interface TakeCheckpointInput {
  /** Milliseconds since the take started — never wall clock. */
  atMs: number;
  tokenIndex: number;
  blockId?: string;
  sentenceId?: string;
  kind: 'take' | 'paragraph_start' | 'command' | 'manual';
}

/** Mirror of `sessions::SessionTakeInput`. */
export interface SessionTakeInput {
  /**
   * `${sessionId}:${passOrdinal}` — the SAME identity the post-take review lane
   * keys `TakePassRecord` by, so the two are one history rather than two.
   */
  takePassId: string;
  /** 1-based and ascending. A retake opens the next one. */
  passOrdinal: number;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  startTokenIndex?: number;
  endTokenIndex?: number;
  /** Authored block ids in the order they were first reached. */
  sections?: string[];
  checkpoints?: TakeCheckpointInput[];
  /** §36.3: retakes the ALIGNER detected inside this pass. */
  automaticRetakes?: number;
  /** §36.3 confidence summary. Omitted when the pass had no snapshots. */
  confidenceMean?: number;
}

/** Mirror of `sessions::SessionTakeRecord`. */
export interface SessionTakeRecord {
  id: string;
  sessionId: string;
  takePassId: string;
  passOrdinal: number;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  startTokenIndex: number;
  endTokenIndex?: number;
  sections: string[];
  checkpoints: TakeCheckpointInput[];
  automaticRetakes: number;
  confidenceMean?: number;
}

/**
 * §36.3. Record (or complete) one take.
 *
 * Upserts on `(sessionId, passOrdinal)` in Rust, so the store may write a take
 * while it is still running and complete it later without duplicating — and a
 * second take can never overwrite the first, because a different ordinal is a
 * different row by table constraint rather than by caller discipline.
 */
export async function recordSessionTake(
  sessionId: string,
  take: SessionTakeInput,
): Promise<SessionTakeRecord | null> {
  return invokeOrMock<SessionTakeRecord | null>(
    'record_session_take',
    { sessionId, take },
    () => null,
  );
}

export async function listSessionTakes(sessionId: string): Promise<SessionTakeRecord[]> {
  return invokeOrMock<SessionTakeRecord[]>('list_session_takes', { sessionId }, () => []);
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
