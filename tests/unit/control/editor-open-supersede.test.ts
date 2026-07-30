/**
 * A slow open must not land on top of a later one.
 *
 * `openScript` clears the buffer and only THEN awaits its fetch, so a read that
 * takes its time is a window in which the user can be somewhere else entirely.
 * Adopting whatever came back replaced a DIFFERENT script's editor state —
 * cancelling its pending autosave and dropping what had been typed into it. The
 * conflict arms already refuse to do this (`isStillCurrent`); this was the one
 * path that did not.
 *
 * It matters more now that the loading panel covers the whole route: a store
 * left holding the wrong script no longer merely shows the wrong text, it
 * leaves the panel up over an editor that never arrives.
 *
 * A counter rather than a script id, because opening A, leaving, and opening A
 * again is two opens of the same id and the first one's answer is just as stale.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import type { ScriptDocument } from '../../../src/shared/contracts';

/**
 * Fetches that are in flight, in the order they were started.
 *
 * A list rather than a map by id, because two opens of the SAME script can be
 * in flight at once — which is exactly the case a map would collapse and the
 * case the guard has to get right.
 */
let pending: Array<{ id: string; resolve: (doc: ScriptDocument) => void }>;

vi.mock('../../../src/control/services/scripts', () => ({
  getScript: (id: string) =>
    new Promise<ScriptDocument>((resolve) => {
      pending.push({ id, resolve });
    }),
  saveScript: async () => ({ status: 'saved', scriptRevision: 1 }),
  renameScript: async () => ({ scriptRevision: 1 }),
  createScript: async () => ({ id: 'copy' }),
}));

vi.mock('../../../src/control/stores/compiled', () => ({
  requestCompile: async () => undefined,
  resetCompiled: () => undefined,
}));

const { editor, openScript, closeScript, setSource } = await import(
  '../../../src/control/stores/editor'
);

function doc(id: string, source: string): ScriptDocument {
  return {
    id,
    title: `Script ${id}`,
    source,
    sourceHash: `hash-${id}`,
    scriptRevision: 1,
  } as unknown as ScriptDocument;
}

/** Answer the nth read that was started (0 = the first one). */
async function land(nth: number, source: string): Promise<void> {
  const entry = pending[nth];
  if (!entry) throw new Error(`no read number ${nth} is in flight`);
  entry.resolve(doc(entry.id, source));
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  pending = [];
  closeScript();
});

describe('an open that has been superseded', () => {
  it('does not replace the editor when an earlier open answers last', async () => {
    const first = openScript('a');
    const second = openScript('b');

    // B wins the race, then A's slow read finally answers.
    await land(1, '# B\n');
    await land(0, '# A\n');
    await Promise.all([first, second]);

    const state = get(editor);
    expect(state.scriptId).toBe('b');
    expect(state.source).toBe('# B\n');
    expect(state.loading).toBe(false);
  });

  it('does not discard text typed into the newer script', async () => {
    // The damage the guard exists to prevent: `adoptDocument` resets the whole
    // state, so a late arrival took the unsaved buffer with it.
    const first = openScript('a');
    const second = openScript('b');
    await land(1, '# B\n');
    setSource('# B\n\nTen minutes of work.\n');

    await land(0, '# A\n');
    await Promise.all([first, second]);

    expect(get(editor).source).toBe('# B\n\nTen minutes of work.\n');
    expect(get(editor).dirty).toBe(true);
  });

  it('still hands the fetched document back to the caller that asked for it', async () => {
    // Superseded means "do not adopt this", not "pretend the read failed" —
    // the caller awaited a document and gets the one it asked for.
    const first = openScript('a');
    const second = openScript('b');
    await land(1, '# B\n');
    await land(0, '# A\n');

    await expect(first).resolves.toMatchObject({ id: 'a' });
    await expect(second).resolves.toMatchObject({ id: 'b' });
  });

  it('reopening the SAME script supersedes the previous open of it', async () => {
    // Two opens of one id: comparing script ids would call the stale answer
    // current, which is why the guard counts opens instead.
    const first = openScript('a');
    const second = openScript('a');

    // The second read answers, then the first one — stale despite naming the
    // very same script, which is what an id comparison would fail to notice.
    await land(1, '# Second read\n');
    await land(0, '# First read\n');
    await Promise.all([first, second]);

    expect(get(editor).source).toBe('# Second read\n');
    expect(get(editor).scriptId).toBe('a');
  });

  it('does not reopen a closed editor when a read answers after the close', async () => {
    const open = openScript('a');
    closeScript();
    await land(0, '# A\n');
    await open;

    const state = get(editor);
    expect(state.scriptId).toBeNull();
    expect(state.source).toBe('');
  });
});
