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
import {
  library,
  loadLibrary,
  selectScript,
  setLibraryView,
} from '../../../src/control/stores/library';
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

afterEach(async () => {
  // The store is a module singleton and `view` outlives a test, so put it back
  // before the fake IPC layer goes away.
  setLibraryView('all');
  await loadLibrary();
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

/**
 * Selection in Trash.
 *
 * ---------------------------------------------------------------------------
 * THIS USED TO ASSERT THE OPPOSITE, AND THAT WAS RIGHT AT THE TIME
 * ---------------------------------------------------------------------------
 * The old rule was that the fallback must never run in Trash. Its reasoning was
 * sound for the code it was written against: `selectedId` was the Present
 * shortcut's target and NOTHING DREW IT, so a fallback in Trash meant ⌘⏎ sent an
 * invisible, arbitrary deleted script to the stage.
 *
 * Desktop refinement §10.2 removed the premise. Selection is drawn now, it is
 * what Restore and Delete Permanently act on, and Present is greyed out in
 * Trash by `lib/commands.ts` as well as refused by the route's own shortcut
 * handler. A Trash view with no selection would instead be a view where the
 * arrow keys have nothing to start from and the Delete key has nothing to
 * delete — which is the failure the new rule prevents.
 *
 * The ⌘⏎ guard is asserted where it now lives (`commands.test.ts`: "offers
 * nothing to act on for a selected row in Trash"), so nothing was traded away.
 */
describe('selection in Trash', () => {
  it('selects the first row so the keyboard has somewhere to start', async () => {
    setLibraryView('trash');
    await loadLibrary();
    expect(get(library).scripts).toHaveLength(2);
    expect(get(library).selectedId).toBe('a');
  });

  it('clears the live selection at the moment the view changes', async () => {
    await loadLibrary();
    expect(get(library).selectedId).toBe('a');
    setLibraryView('trash');
    // The rows go with the view, and so does the thing that pointed at one of
    // them — a selection surviving the switch would highlight a Trash row that
    // happens to share an index with a live script.
    expect(get(library).selectedId).toBeNull();
  });
});
