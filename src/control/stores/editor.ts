/**
 * EditorStore (spec §45.2) — current source, save state, autosave.
 * Autosave debounces ~500 ms after typing stops (spec §13.5); Cmd/Ctrl+S
 * saves immediately and shows a brief Saved state.
 */
import { get, writable } from 'svelte/store';
import type { ScriptDocument } from '../../shared/contracts';
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
  mode: 'edit' | 'split' | 'preview';
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
  mode: 'edit',
  lastError: null,
};

const state = writable<EditorState>({ ...initial });
export const editor = { subscribe: state.subscribe };

export const AUTOSAVE_DEBOUNCE_MS = 500;

/**
 * Caller-side compile debounce (spec §45.3). The worker coalescer already
 * supersedes stale requests, but firing one per keystroke still ships the
 * whole document across the worker boundary on every character. 90 ms is
 * below the ~100 ms threshold where a preview stops feeling live, so the
 * preview keeps up with typing while a burst of keystrokes costs one compile.
 */
export const COMPILE_DEBOUNCE_MS = 90;

let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
let savedBadgeTimer: ReturnType<typeof setTimeout> | null = null;
let compileTimer: ReturnType<typeof setTimeout> | null = null;

export async function openScript(scriptId: string): Promise<ScriptDocument> {
  cancelTimers();
  state.set({ ...initial, scriptId, loading: true });
  resetCompiled();
  const doc = await scriptsService.getScript(scriptId);
  state.set({
    ...initial,
    scriptId: doc.id,
    title: doc.title,
    source: doc.source,
    scriptRevision: doc.scriptRevision,
    loading: false,
    saveState: 'saved',
  });
  void requestCompile(doc.id, doc.source, 0);
  return doc;
}

export function closeScript(): void {
  cancelTimers();
  state.set({ ...initial });
  resetCompiled();
}

export function setEditorMode(mode: EditorState['mode']): void {
  state.update((s) => ({ ...s, mode }));
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
  if (s.scriptId === null || title.trim() === '' || title === s.title) return;
  state.update((prev) => ({ ...prev, title }));
  try {
    // Rename bumps the revision server-side; adopting it keeps the next body
    // save from failing with a stale expectation (M4).
    const renamed = await scriptsService.renameScript(s.scriptId, title, s.scriptRevision);
    state.update((prev) => ({ ...prev, scriptRevision: renamed.scriptRevision }));
  } catch (err) {
    state.update((prev) => ({ ...prev, saveState: 'error', lastError: String(err) }));
  }
}

/** Immediate save (autosave flush and Cmd/Ctrl+S). */
export async function saveNow(): Promise<void> {
  const s = get(state);
  // Flush the pending compile first, even when there is nothing to save:
  // Preflight awaits saveNow() and then issues its own compile at revision 0,
  // and a debounced keystroke landing after that would supersede it.
  flushPendingCompile();
  if (s.scriptId === null || !s.dirty) return;
  if (autosaveTimer) {
    clearTimeout(autosaveTimer);
    autosaveTimer = null;
  }
  state.update((prev) => ({ ...prev, saveState: 'saving' }));
  const savedSource = s.source;
  try {
    const result = await scriptsService.saveScript(s.scriptId, s.scriptRevision, savedSource, {
      title: s.title,
    });
    if (result.status === 'conflict') {
      state.update((prev) => ({ ...prev, saveState: 'conflict' }));
      return;
    }
    state.update((prev) => ({
      ...prev,
      scriptRevision: result.scriptRevision,
      // Still dirty if the user kept typing while the save was in flight.
      dirty: prev.source !== savedSource,
      saveState: 'saved',
      lastError: null,
    }));
    if (savedBadgeTimer) clearTimeout(savedBadgeTimer);
  } catch (err) {
    state.update((prev) => ({ ...prev, saveState: 'error', lastError: String(err) }));
  }
}

export function editorHasUnsavedWork(): boolean {
  const s = get(state);
  return s.dirty || s.saveState === 'saving' || s.saveState === 'error';
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
