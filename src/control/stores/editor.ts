/**
 * EditorStore (spec §45.2) — current source, save state, autosave.
 * Autosave debounces ~500 ms after typing stops (spec §13.5); Cmd/Ctrl+S
 * saves immediately and shows a brief Saved state.
 */
import { get, writable } from 'svelte/store';
import type { ScriptDocument } from '../../shared/contracts';
import { describeError, errorCode } from '../services/errors';
import * as scriptsService from '../services/scripts';
import { requestCompile, resetCompiled } from './compiled';

export type SaveState = 'idle' | 'saving' | 'saved' | 'error' | 'conflict';

export interface EditorState {
  scriptId: string | null;
  title: string;
  source: string;
  scriptRevision: number;
  /** Monotonic local revision; compile requests are tagged with it. */
  editorRevision: number;
  saveState: SaveState;
  dirty: boolean;
  loading: boolean;
  /**
   * The editor's layout is NOT here.
   *
   * It used to be a `mode: 'edit' | 'preview'` field on this store, which made
   * it a property of the open DOCUMENT: closing a script reset it, so the
   * arrangement somebody chose was forgotten on every open. §11.3 asks for the
   * opposite — the last mode persists — and it also asks for a third, split
   * arrangement this two-value union could not express.
   *
   * It lives in `stores/workspace.ts` now, with the pane widths, where it is
   * persisted per machine and survives a relaunch. See `editorLayout` there.
   */
  lastError: string | null;
}

const initial: EditorState = {
  scriptId: null,
  title: '',
  source: '',
  scriptRevision: 0,
  editorRevision: 0,
  saveState: 'idle',
  dirty: false,
  loading: false,
  lastError: null,
};

const state = writable<EditorState>({ ...initial });
export const editor = { subscribe: state.subscribe };

export const AUTOSAVE_DEBOUNCE_MS = 500;

/**
 * How long "Saved" stays on the status bar after a save that worked.
 *
 * Long enough to be read by somebody who pressed ⌘S and looked down; short
 * enough that it is plainly a report of an event rather than a standing claim
 * about the document.
 */
export const SAVED_BADGE_MS = 2400;

/**
 * Caller-side compile debounce (spec §45.3). The worker coalescer already
 * supersedes stale requests, but firing one per keystroke still ships the
 * whole document across the worker boundary on every character. 90 ms is
 * below the ~100 ms threshold where a preview stops feeling live, so the
 * preview keeps up with typing while a burst of keystrokes costs one compile.
 */
export const COMPILE_DEBOUNCE_MS = 90;

let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * The save on the wire, so a second `saveNow` waits for it rather than racing
 * it.
 *
 * Two saves in flight carry the same `scriptRevision`, and the second is
 * refused as `SCRIPT_CONFLICT` — "This document changed elsewhere" — for a
 * change this window made itself. Keep typing through a slow save and the
 * debounce fires again before the first answer lands; the conflict sheet then
 * asks the user to choose between two copies of their own text.
 */
let saveInFlight: Promise<void> | null = null;
let savedBadgeTimer: ReturnType<typeof setTimeout> | null = null;
let compileTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Which open the editor is on, so a slow one cannot land on top of a later one.
 *
 * The conflict arms already refuse to adopt a document the editor has moved on
 * from (`isStillCurrent`); `openScript` was the one path that adopted whatever
 * came back. A slow read of script A followed by opening script B ended with
 * A's document in the store while the route was showing B — cancelling B's
 * pending autosave and dropping what had been typed into it.
 *
 * A counter rather than a script id, because opening A, leaving, and opening A
 * again is two opens of the same id and the first one's result is just as stale.
 */
let openGeneration = 0;

export async function openScript(scriptId: string): Promise<ScriptDocument> {
  cancelTimers();
  const generation = ++openGeneration;
  state.set({ ...initial, scriptId, loading: true });
  resetCompiled();
  const doc = await scriptsService.getScript(scriptId);
  // Superseded: the document is returned to the caller that asked for it, but
  // it is no longer what the editor is showing and must not replace it.
  if (generation !== openGeneration) return doc;
  adoptDocument(doc);
  return doc;
}

/**
 * Make an already-fetched document the editor's contents.
 *
 * Split out of `openScript` for the conflict arms, which must have the disk
 * document IN HAND before they are allowed to touch editor state at all —
 * `openScript` clears the buffer and only THEN awaits the fetch, which is
 * exactly the window that lost the user's text (see `useDiskVersion`).
 */
function adoptDocument(doc: ScriptDocument): void {
  cancelTimers();
  resetCompiled();
  state.set({
    ...initial,
    scriptId: doc.id,
    title: doc.title,
    source: doc.source,
    scriptRevision: doc.scriptRevision,
    loading: false,
    /*
     * `idle`, not `saved`.
     *
     * A freshly opened document has not been saved — it has been READ, and
     * nothing has happened to it since. It used to open as `saved`, which was
     * harmless while the label lived in a header nobody read closely and became
     * wrong the moment the status bar adopted §11.7's rule: "Saved" is
     * TRANSIENT, and a permanent one from the instant of opening is a claim the
     * user learns to ignore — so the real one, after a real save, says nothing
     * either.
     */
    saveState: 'idle',
  });
  void requestCompile(doc.id, doc.source, 0);
}

export function closeScript(): void {
  cancelTimers();
  // Closing supersedes an open in flight too, or its document would arrive
  // into a closed editor and reopen it.
  openGeneration += 1;
  state.set({ ...initial });
  resetCompiled();
}

/** Called on every editor change; schedules the debounced autosave. */
export function setSource(source: string): void {
  const s = get(state);
  if (s.scriptId === null || source === s.source) return;
  const editorRevision = s.editorRevision + 1;
  state.update((prev) => ({ ...prev, source, editorRevision, dirty: true }));
  const scriptId = s.scriptId;
  if (compileTimer) clearTimeout(compileTimer);
  compileTimer = setTimeout(() => {
    compileTimer = null;
    void requestCompile(scriptId, source, editorRevision);
  }, COMPILE_DEBOUNCE_MS);
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    void saveNow();
  }, AUTOSAVE_DEBOUNCE_MS);
}

export async function setTitle(title: string): Promise<void> {
  const s = get(state);
  const next = title.trim();
  if (s.scriptId === null || next === '' || next === s.title) return;
  // Title and body share one revision and one save queue. A separate rename
  // raced autosave, was invisible to the leave guard, and could stamp its
  // revision onto a different script after navigation.
  state.update((prev) => ({ ...prev, title: next, dirty: true }));
  await saveNow();
}

/** Immediate save (autosave flush and Cmd/Ctrl+S). */
export async function saveNow(): Promise<void> {
  // Flush the pending compile first, even when there is nothing to save:
  // Preflight awaits saveNow() and then issues its own compile at revision 0,
  // and a debounced keystroke landing after that would supersede it.
  flushPendingCompile();
  /*
   * Behind the save already on the wire, and re-read afterwards: it will have
   * adopted the new revision and recomputed `dirty`, so what follows either
   * has nothing left to do or sends the right revision. A loop, not a single
   * await, because two waiters woken by the same save would otherwise both
   * proceed — and that is the race this exists to end.
   */
  while (saveInFlight) await saveInFlight;
  const s = get(state);
  if (s.scriptId === null || !s.dirty) return;
  /*
   * Not into a conflict. The sheet is up and only its arms carry a revision
   * that can land; a save from here would be the same stale one again, and
   * each refusal makes Rust snapshot the "external" version afresh. Typing
   * while the first save was on the wire is enough to have scheduled this.
   */
  if (s.saveState === 'conflict') return;
  if (autosaveTimer) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
  const inFlight = performSave(s.scriptId, s);
  saveInFlight = inFlight;
  try {
    await inFlight;
  } finally {
    if (saveInFlight === inFlight) saveInFlight = null;
  }
}

async function performSave(scriptId: string, s: EditorState): Promise<void> {
  state.update((prev) => ({ ...prev, saveState: 'saving' }));
  const savedSource = s.source;
  const savedTitle = s.title;
  /*
   * The document this answer belongs to. Close the editor, or open another
   * script, while the write is on the wire and the answer would otherwise
   * stamp its revision and status onto whatever is open NOW — a different
   * script, or nothing. The write itself still lands; only the bookkeeping is
   * abandoned.
   */
  const generation = openGeneration;
  try {
    const result = await scriptsService.saveScript(scriptId, s.scriptRevision, savedSource, {
      title: s.title,
    });
    if (generation !== openGeneration) return;
    // Only the mock backend answers with a `status`. Rust's SaveResult has no
    // such field — see the catch below, which is the real conflict path.
    if (result.status === 'conflict') {
      state.update((prev) => ({ ...prev, saveState: 'conflict' }));
      return;
    }
    state.update((prev) => ({
      ...prev,
      scriptRevision: result.scriptRevision,
      // Still dirty if the user kept typing while the save was in flight.
      dirty: prev.source !== savedSource || prev.title !== savedTitle,
      saveState: 'saved',
      lastError: null,
    }));
    /*
     * "Saved" is TRANSIENT (§11.7), and this is what makes it so.
     *
     * `savedBadgeTimer` existed and was only ever CLEARED — nothing armed it —
     * so the label, once shown, stayed for the life of the document. A status
     * that is permanently on is a status nobody reads, which is exactly what
     * makes the next one that matters invisible.
     *
     * Back to `idle` rather than to a second state: `idle` already means "there
     * is nothing to report", which is the truth a couple of seconds after a save
     * that worked. `error` and `conflict` are untouched by this — they persist
     * until acted on, because they need acting on.
     */
    if (savedBadgeTimer) clearTimeout(savedBadgeTimer);
    savedBadgeTimer = setTimeout(() => {
      savedBadgeTimer = null;
      // Only if nothing has happened since. A save that started, or a failure,
      // owns the state now and must not be overwritten with "nothing to say".
      state.update((prev) => (prev.saveState === 'saved' ? { ...prev, saveState: 'idle' } : prev));
    }, SAVED_BADGE_MS);
  } catch (err) {
    if (generation !== openGeneration) return;
    /*
     * F.8 external-change conflict.
     *
     * Rust signals a file that changed outside CandidCue as an ERROR
     * (`SCRIPT_CONFLICT`), not as a `SaveResult.status` — its SaveResult has no
     * status field at all. The `status === 'conflict'` branch above is
     * satisfied only by the mock backend, so against the real backend the
     * conflict state was unreachable and every external change surfaced as the
     * generic "Save failed" sheet: no "keep mine / load disk / save both"
     * choice, on the one failure where the user's text and the disk's text are
     * both real. The mock being STRONGER than production is exactly what hid
     * this.
     */
    if (errorCode(err) === 'SCRIPT_CONFLICT') {
      state.update((prev) => ({
        ...prev,
        saveState: 'conflict',
        lastError: describeError(err),
      }));
      return;
    }
    state.update((prev) => ({ ...prev, saveState: 'error', lastError: describeError(err) }));
  }
}

/** Flush the open document before an action that reads or replaces its file. */
export async function flushEditorEdits(scriptId: string): Promise<void> {
  if (get(state).scriptId !== scriptId) return;
  const generation = openGeneration;
  await saveNow();
  if (generation !== openGeneration) {
    throw new Error('The open script changed. Try again from the script you want to use.');
  }
  const current = get(state);
  if (editorStateHasUnsavedWork(current)) {
    throw new Error(
      current.saveState === 'conflict'
        ? 'Resolve the external change in the editor first. Your edits have not been saved.'
        : current.lastError ?? 'Your latest edits have not finished saving. Try again once they are saved.',
    );
  }
}

/* --- F.8 external-conflict resolution --------------------------------- */

/**
 * The name the editor's text is filed under when the disk version wins.
 *
 * Exported so the dialog can promise the user the same name the store will
 * actually use — the copy and the behaviour drifting apart is the bug this
 * whole section exists to fix.
 */
export function conflictCopyTitle(title: string): string {
  return `${title} (conflict copy)`;
}

/** What an arm actually did, so the toast can say it rather than assume it. */
export interface ConflictOutcome {
  /** Whether the editor's text was filed as a separate script. */
  copied: boolean;
}

/**
 * Is the editor still on the document this operation started against?
 *
 * Both arms await IPC, and the sheet can be dismissed and another script
 * opened while they are in flight. Adopting unconditionally then replaced a
 * DIFFERENT script's editor state — cancelling its pending autosave and
 * dropping whatever had been typed into it, which is the same data loss this
 * change exists to end, arriving from the other direction. The durable write
 * still stands; only the state replacement is abandoned.
 */
function isStillCurrent(started: EditorState): boolean {
  const now = get(state);
  return now.scriptId === started.scriptId && now.source === started.source;
}

/**
 * Take the disk version, keeping the editor's text as a separate script.
 *
 * The order here is the entire point. By the time a conflict sheet is open,
 * every autosave since the external change has been refused, so `source` is
 * the ONLY copy of everything typed since then — and `openScript` clears the
 * editor before it awaits the fetch, so the old implementation (`openScript`
 * plus a toast) dropped that text before it even knew the disk read would
 * succeed. Nothing is discarded until the text is durably somewhere else:
 *
 *   1. fetch the disk document — a failure here changes nothing,
 *   2. write the editor's text to a new script — a failure here changes
 *      nothing either,
 *   3. and only now adopt the document fetched in step 1.
 *
 * A throw therefore always leaves `source`, `dirty` and `saveState:
 * 'conflict'` exactly as they were, so the sheet can stay open and the user
 * can try again with their text still in front of them.
 *
 * There is no IPC primitive for "keep this text as a revision without making
 * it live": `save_script` snapshots the canonical preimage and then makes the
 * supplied source current, which is the opposite of what this arm wants.
 * `create_script` is the only durable write that does not replace the disk
 * version, which is why the text lands in the Library rather than in this
 * script's history.
 */
export async function useDiskVersion(): Promise<ConflictOutcome> {
  const s = get(state);
  if (s.scriptId === null) throw new Error('No script is open.');
  const disk = await scriptsService.getScript(s.scriptId);

  /*
   * Title as well as body: `setTitle` writes the new name into the store
   * before its rename settles, so a rename that lost the race to the external
   * change is unsaved work too, and comparing only the source would drop it.
   */
  const copied = s.source !== disk.source || s.title !== disk.title;
  if (copied) {
    await scriptsService.createScript({
      title: conflictCopyTitle(s.title),
      source: s.source,
    });
  }
  if (!isStillCurrent(s)) return { copied };
  adoptDocument(disk);
  return { copied };
}

/**
 * Keep the editor's text, writing it over the disk version.
 *
 * The disk side needs no rescue here: Rust snapshots the externally changed
 * file as a revision (`external_change_preserved`) before it refuses the save
 * that opened this sheet, so it is already in this script's history. The save
 * goes out against the revision the disk currently holds, which is what makes
 * it succeed where the autosave was refused.
 *
 * It does NOT reload afterwards, and that is deliberate. Reopening would send
 * the editor back through `openScript`, which blanks the buffer before it
 * awaits its fetch — so a transient failure on that second read left an EMPTY
 * editor holding no copy of the text, no longer marked as a conflict, behind a
 * sheet still offering "keep my edits". Pressing it again saved that blank
 * over the text the first press had just rescued. The editor already holds
 * exactly what was written, so the revision the save returns is all it needs.
 */
export async function keepEditorVersion(): Promise<ConflictOutcome> {
  const s = get(state);
  if (s.scriptId === null) throw new Error('No script is open.');
  const disk = await scriptsService.getScript(s.scriptId);
  const result = await scriptsService.saveScript(s.scriptId, disk.scriptRevision, s.source, {
    title: s.title,
  });
  // Only the mock backend answers a conflict by value; see `saveNow`.
  if (result.status === 'conflict') {
    throw new Error('This script changed on disk again. Review the versions once more.');
  }
  if (!isStillCurrent(s)) return { copied: false };
  state.update((prev) => ({
    ...prev,
    scriptRevision: result.scriptRevision,
    dirty: false,
    saveState: 'saved',
    lastError: null,
  }));
  return { copied: false };
}

/**
 * Is there work in this state that leaving would abandon?
 *
 * `conflict` counts, and it is the state where the answer matters most: the
 * operator's text and the disk's text are both real and neither has been
 * chosen yet, so navigating away discards one of them silently. It was left out
 * originally because `saveNow()` resolves normally on a conflict — but resolving
 * is not the same as saving, which is the whole reason this predicate exists
 * rather than callers awaiting `saveNow()` and assuming the best.
 *
 * Takes the state rather than reading the store so the save-state axis can be
 * tested on its own. Driving the real store cannot produce a clean-but-failed
 * editor — every failure path leaves `dirty` true as well — so a store-only
 * test passes on `dirty` alone and would go on passing if the save states were
 * dropped from this predicate entirely.
 */
export function editorStateHasUnsavedWork(
  s: Pick<EditorState, 'dirty' | 'saveState'>,
): boolean {
  return (
    s.dirty || s.saveState === 'saving' || s.saveState === 'error' || s.saveState === 'conflict'
  );
}

/** `editorStateHasUnsavedWork` against the live editor. */
export function editorHasUnsavedWork(): boolean {
  return editorStateHasUnsavedWork(get(state));
}

/** Run a debounced compile now (or do nothing when none is pending). */
function flushPendingCompile(): void {
  if (compileTimer === null) return;
  clearTimeout(compileTimer);
  compileTimer = null;
  const s = get(state);
  if (s.scriptId === null) return;
  void requestCompile(s.scriptId, s.source, s.editorRevision);
}

function cancelTimers(): void {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  if (savedBadgeTimer) clearTimeout(savedBadgeTimer);
  if (compileTimer) clearTimeout(compileTimer);
  autosaveTimer = null;
  savedBadgeTimer = null;
  compileTimer = null;
}
