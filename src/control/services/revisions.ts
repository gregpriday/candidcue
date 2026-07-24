/**
 * Revision browser service (spec §21.4, §46.2) — `list_revisions`,
 * `get_revision`, `restore_revision`.
 *
 * These three commands have been implemented and tested in Rust since the
 * scripts repo landed and had NO TypeScript caller: every snapshot the app
 * took was write-only. This module is the doorway.
 *
 * Deliberately NOT routed through `invokeOrMock`. The mock backend has no
 * revision store, so a fallback could only invent history — and a fabricated
 * "restore point" is worse than a screen that says the feature needs the
 * desktop app. `BackendUnavailableError` therefore reaches the caller, and
 * the panel reports it. It also means no test of this module can be satisfied
 * by the mock.
 */
import { ipcInvoke } from './ipc';

/**
 * Twin of Rust `RevisionSummary` (src-tauri/src/scripts/mod.rs). Field names
 * are the camelCase serde forms; `wordCount` is skipped when null, hence
 * optional here.
 */
export interface RevisionSummary {
  id: string;
  revisionNumber: number;
  sourceHash: string;
  reason: string;
  wordCount?: number;
  createdAt: string;
}

/**
 * Twin of Rust `RevisionDocument`, which `#[serde(flatten)]`s the summary —
 * so the payload is a summary with a `source`, NOT `{ summary, source }`.
 */
export interface RevisionDocument extends RevisionSummary {
  source: string;
}

/**
 * Twin of Rust `SaveResult`, returned by `restore_revision`.
 *
 * NOTE the absence of `status`: `scripts-types.ts` declares a
 * `status: 'saved' | 'conflict'` field that Rust has never sent — a stale
 * revision or an external change is an Err (`STALE_REVISION` /
 * `SCRIPT_CONFLICT`), not a value. This type describes what actually arrives.
 */
export interface RestoreResult {
  scriptRevision: number;
  sourceHash: string;
  savedAt: string;
  revisionCreated: boolean;
  revisionId?: string;
}

/** Newest first — Rust orders by `revision_number DESC`. */
export async function listRevisions(scriptId: string): Promise<RevisionSummary[]> {
  return ipcInvoke<RevisionSummary[]>('list_revisions', { scriptId });
}

export async function getRevision(
  scriptId: string,
  revisionId: string,
): Promise<RevisionDocument> {
  return ipcInvoke<RevisionDocument>('get_revision', { scriptId, revisionId });
}

/**
 * Restore a revision as the current text.
 *
 * `expectedRevision` is the script revision the caller believes it is acting
 * on: this is a compare-and-swap like any other save, so a stale editor
 * cannot clobber a concurrent change.
 *
 * The undo guarantee is Rust's, not ours: `restore_revision` calls
 * `save_script` with `revisionReason: "before_restore"`, which snapshots the
 * PREIMAGE under the per-script lock before the replacement is written. Doing
 * it a second time here would both duplicate the snapshot and reopen the
 * window between snapshot and write that the Rust comment (H2) closed.
 */
export async function restoreRevision(
  scriptId: string,
  revisionId: string,
  expectedRevision: number,
): Promise<RestoreResult> {
  return ipcInvoke<RestoreResult>('restore_revision', {
    scriptId,
    revisionId,
    expectedRevision,
  });
}
