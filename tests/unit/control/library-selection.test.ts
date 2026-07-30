/**
 * Library selection: what the store remembers, and who it is for.
 *
 * `loadLibrary` falls back to the first script when nothing is selected, and that
 * fallback is the whole point of the field — it is what gives the Present
 * shortcut a target the moment the library finishes loading, with no clicking
 * required.
 *
 * Nothing DRAWS it. The cards used to wear a leading accent bar for the chosen
 * script, which needed a `selectionIsExplicit` companion so the boot-time
 * fallback would not come up looking picked; both are gone, because no action on
 * that screen reads a selection (see the note in `ScriptCard`). So these pin the
 * one behaviour left: that `selectedId` always resolves to something sensible for
 * the shortcut.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setInvokeForTesting } from '../../../src/control/services/ipc';
import { library, loadLibrary, selectScript } from '../../../src/control/stores/library';
import type { ScriptSummary } from '../../../src/shared/contracts';
import { get } from 'svelte/store';

function summary(id: string, title: string): ScriptSummary {
  return {
    id,
    title,
    status: 'draft',
    language: 'en',
    spokenWordCount: 10,
    estimatedDurationSeconds: 4,
    updatedAt: '2026-07-30T10:00:00.000Z',
    previewText: 'Some narration.',
    hasWarnings: false,
    scriptRevision: 1,
  };
}

let items: ScriptSummary[] = [];

beforeEach(() => {
  items = [summary('a', 'Alpha'), summary('b', 'Bravo')];
  setInvokeForTesting(async <T>() => ({ items, total: items.length }) as T);
});

afterEach(() => {
  setInvokeForTesting(null);
  selectScript(null);
  vi.restoreAllMocks();
});

describe('library selection', () => {
  it('falls back to the first script so the Present shortcut has a target', async () => {
    await loadLibrary();
    expect(get(library).selectedId).toBe('a');
  });

  it('records a real selection', async () => {
    await loadLibrary();
    selectScript('b');
    expect(get(library).selectedId).toBe('b');
  });

  it('keeps a selection across a reload while the script survives', async () => {
    await loadLibrary();
    selectScript('b');
    await loadLibrary();
    expect(get(library).selectedId).toBe('b');
  });

  it('drops back to the fallback when the chosen script leaves the list', async () => {
    await loadLibrary();
    selectScript('b');
    // Bravo is trashed, renamed out of the filter, whatever — it is simply gone.
    items = [summary('a', 'Alpha')];
    await loadLibrary();
    // A dangling id would leave the shortcut aiming at nothing, which is the one
    // way this field can actually fail somebody.
    expect(get(library).selectedId).toBe('a');
  });

  it('can be cleared', async () => {
    await loadLibrary();
    selectScript('b');
    selectScript(null);
    expect(get(library).selectedId).toBeNull();
  });
});
