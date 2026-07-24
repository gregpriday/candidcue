/**
 * ScriptLibraryStore (spec §45.2) — summaries, search, sort, selection.
 */
import { derived, get, writable } from 'svelte/store';
import type { ScriptSummary } from '../../shared/contracts';
import * as scriptsService from '../services/scripts';
import type { LibraryView, ScriptSort } from '../services/scripts-types';
import { showToast } from './toasts';

export interface LibraryState {
  loading: boolean;
  scripts: ScriptSummary[];
  view: LibraryView;
  query: string;
  sort: ScriptSort;
  selectedId: string | null;
  error: string | null;
}

const state = writable<LibraryState>({
  loading: false,
  scripts: [],
  view: 'all',
  query: '',
  sort: 'recently_edited',
  selectedId: null,
  error: null,
});

export const library = { subscribe: state.subscribe };

export const librarySelection = derived(state, ($s) =>
  $s.scripts.find((script) => script.id === $s.selectedId) ?? null,
);

export async function loadLibrary(): Promise<void> {
  const current = get(state);
  state.update((s) => ({ ...s, loading: true, error: null }));
  try {
    const page = await scriptsService.listScripts(
      { view: current.view, query: current.query },
      current.sort,
    );
    state.update((s) => ({
      ...s,
      loading: false,
      scripts: page.items,
      selectedId: page.items.some((i) => i.id === s.selectedId)
        ? s.selectedId
        : page.items[0]?.id ?? null,
    }));
  } catch (err) {
    state.update((s) => ({ ...s, loading: false, error: String(err) }));
  }
}

export function setLibraryView(view: LibraryView): void {
  state.update((s) => ({ ...s, view }));
  void loadLibrary();
}

export function setLibraryQuery(query: string): void {
  state.update((s) => ({ ...s, query }));
  void loadLibrary();
}

export function setLibrarySort(sort: ScriptSort): void {
  state.update((s) => ({ ...s, sort }));
  void loadLibrary();
}

export function selectScript(id: string | null): void {
  state.update((s) => ({ ...s, selectedId: id }));
}

export async function duplicateScript(id: string): Promise<void> {
  await scriptsService.duplicateScript(id);
  showToast('Script duplicated', 'success');
  await loadLibrary();
}

/** Look up the revision the library currently believes a script is at. */
function revisionOf(id: string): number {
  const found = get(state).scripts.find((script) => script.id === id);
  if (found === undefined) throw new Error('That script is no longer in the library.');
  return found.scriptRevision;
}

export async function moveScriptToTrash(id: string): Promise<void> {
  await scriptsService.trashScript(id, revisionOf(id));
  await loadLibrary();
}

export async function restoreScriptFromTrash(id: string): Promise<void> {
  await scriptsService.restoreScript(id, revisionOf(id));
  showToast('Script restored', 'success');
  await loadLibrary();
}

export async function deleteScriptPermanently(id: string): Promise<void> {
  await scriptsService.permanentlyDeleteScript(id);
  await loadLibrary();
}

export async function emptyTrash(): Promise<void> {
  const trashed = get(state).scripts;
  for (const script of trashed) {
    await scriptsService.permanentlyDeleteScript(script.id);
  }
  await loadLibrary();
}
