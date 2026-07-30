/**
 * Library selection: what the store remembers vs what the screen is allowed to
 * claim.
 *
 * `loadLibrary` falls back to the first script when nothing is selected, and that
 * fallback is worth keeping — it is what gives the Present shortcut a target the
 * moment the library finishes loading, with no clicking required.
 *
 * What it must not do is LOOK like a choice. Before `selectionIsExplicit` the top
 * card came up wearing the selected treatment on every boot, so the one script in
 * a new library was permanently drawn as picked; and because the old selected rule
 * replaced the card's white surface with a 5%-alpha wash, "picked" is exactly what
 * made it look broken.
 *
 * So these pin both halves: `selectedId` still resolves for the shortcut, and the
 * flag the cards read stays false until somebody actually chooses something.
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

  it('does not call that fallback an explicit choice', async () => {
    await loadLibrary();
    // The cards read this flag, not `selectedId` — nothing may be drawn as
    // chosen when the operator has not touched the list.
    expect(get(library).selectionIsExplicit).toBe(false);
  });

  it('marks a real selection as explicit', async () => {
    await loadLibrary();
    selectScript('b');
    expect(get(library).selectedId).toBe('b');
    expect(get(library).selectionIsExplicit).toBe(true);
  });

  it('keeps an explicit selection across a reload while the script survives', async () => {
    await loadLibrary();
    selectScript('b');
    await loadLibrary();
    expect(get(library).selectedId).toBe('b');
    expect(get(library).selectionIsExplicit).toBe(true);
  });

  it('drops back to implicit when the chosen script leaves the list', async () => {
    await loadLibrary();
    selectScript('b');
    // Bravo is trashed, renamed out of the filter, whatever — it is simply gone.
    items = [summary('a', 'Alpha')];
    await loadLibrary();
    expect(get(library).selectedId).toBe('a');
    // Inheriting the flag here would draw Alpha as chosen purely because a
    // DIFFERENT script had been chosen before it.
    expect(get(library).selectionIsExplicit).toBe(false);
  });

  it('clearing the selection clears the claim with it', async () => {
    await loadLibrary();
    selectScript('b');
    selectScript(null);
    expect(get(library).selectedId).toBeNull();
    expect(get(library).selectionIsExplicit).toBe(false);
  });
});
