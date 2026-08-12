/**
 * F.8 external-change conflict: the state the mock backend hid.
 *
 * The editor store branched on `SaveResult.status === 'conflict'`. Rust's
 * `SaveResult` has no `status` field — a file that changed outside CandidCue
 * comes back as an ERROR with code `SCRIPT_CONFLICT` — so against the real
 * backend the conflict state was unreachable and Editor.svelte's "keep mine /
 * load disk / save both" sheet could never open. Only `mock-backend.ts`
 * returns a `status`, which is why every existing test passed.
 *
 * These tests drive the store with the payload Rust actually sends.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

const scriptDocument = {
  id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  title: 'Keynote',
  status: 'draft',
  language: 'en',
  spokenWordCount: 2,
  estimatedDurationSeconds: 1,
  updatedAt: '2026-07-24T09:00:00Z',
  previewText: '',
  hasWarnings: false,
  source: '# Keynote\n',
  sourceHash: 'hash',
  scriptRevision: 7,
  settings: {
    schemaVersion: 1,
    readHeadings: false,
    readImageAltText: false,
    readInlineCode: false,
    cueVisibility: 'subtle',
    silentBlockVisibility: 'dim',
    wordsPerMinuteEstimate: 150,
  },
};

let saveBehaviour: () => Promise<unknown> = async () => ({ scriptRevision: 8 });
/** What `get_script` answers with — the DISK side of a conflict. */
let diskDocument = structuredClone(scriptDocument);
let createBehaviour: (input: { title: string; source: string }) => Promise<unknown> = async (
  input,
) => ({ ...structuredClone(scriptDocument), id: 'created', ...input });

const createCalls: Array<{ title: string; source: string }> = [];
const saveCalls: Array<{ expectedRevision: number; source: string; title?: string }> = [];

/** Overrides `getScript` for the call that follows a save, when set. */
let getBehaviour: (() => Promise<unknown>) | null = null;

vi.mock('../../../src/control/services/scripts', () => ({
  getScript: async () => (getBehaviour ? getBehaviour() : structuredClone(diskDocument)),
  saveScript: async (
    _id: string,
    expectedRevision: number,
    source: string,
    metadataPatch?: { title?: string },
  ) => {
    saveCalls.push({ expectedRevision, source, title: metadataPatch?.title });
    const result = await saveBehaviour();
    // A successful save makes that text canonical, so the fake disk has to
    // move with it — otherwise a reload silently "restores" the old text and
    // a test asserting only call arguments never notices.
    diskDocument = {
      ...diskDocument,
      source,
      title: metadataPatch?.title ?? diskDocument.title,
      scriptRevision: (result as { scriptRevision: number }).scriptRevision,
    };
    return result;
  },
  renameScript: async () => ({ scriptRevision: 8 }),
  createScript: async (input: { title: string; source: string }) => {
    createCalls.push({ ...input });
    return createBehaviour(input);
  },
}));

vi.mock('../../../src/control/stores/compiled', () => ({
  requestCompile: async () => undefined,
  resetCompiled: () => undefined,
}));

const {
  editor,
  editorHasUnsavedWork,
  openScript,
  saveNow,
  setSource,
  closeScript,
  useDiskVersion,
  keepEditorVersion,
  conflictCopyTitle,
} = await import('../../../src/control/stores/editor');

/** The AppError payload shape Rust rejections cross the boundary as. */
function appError(code: string, userMessage: string): unknown {
  return { code, category: 'validation', userMessage, recoverable: true };
}

describe('the editor reflects a real SCRIPT_CONFLICT', () => {
  beforeEach(async () => {
    saveBehaviour = async () => ({ scriptRevision: 8 });
    diskDocument = structuredClone(scriptDocument);
    createCalls.length = 0;
    saveCalls.length = 0;
    closeScript();
    await openScript(scriptDocument.id);
  });

  it('enters the conflict state when Rust reports an external change', async () => {
    saveBehaviour = async () => {
      throw appError(
        'SCRIPT_CONFLICT',
        "This script's file changed outside CandidCue. Resolve the conflict before saving.",
      );
    };
    setSource('# Keynote\n\nEdited.\n');
    await saveNow();

    const state = get(editor);
    // Before the fix this was 'error', which opens the generic "Save failed"
    // sheet instead of the choice between the two real versions.
    expect(state.saveState).toBe('conflict');
    expect(state.lastError).toContain('changed outside CandidCue');
    /*
     * And it counts as unsaved work, which is what lets the leave guard stop.
     *
     * A conflict is the state where walking away costs the most — the
     * operator's text and the disk's text are both real and neither has been
     * chosen — and it was the one state the predicate left out, so the guard
     * waved it through and the resolution sheet could be bypassed entirely.
     */
    expect(editorHasUnsavedWork()).toBe(true);
  });

  it('still reports other failures as errors', async () => {
    saveBehaviour = async () => {
      throw appError('SAVE_FAILED', 'CandidCue could not write the script file.');
    };
    setSource('# Keynote\n\nEdited again.\n');
    await saveNow();

    const state = get(editor);
    expect(state.saveState).toBe('error');
    expect(state.lastError).toBe('CandidCue could not write the script file.');
    expect(editorHasUnsavedWork()).toBe(true);
  });

  /** A stale revision is a different failure and must not read as a conflict. */
  it('does not treat a stale revision as an external change', async () => {
    saveBehaviour = async () => {
      throw appError('STALE_REVISION', 'This script changed since you opened it.');
    };
    setSource('# Keynote\n\nThird edit.\n');
    await saveNow();
    expect(get(editor).saveState).toBe('error');
  });
});

/**
 * Resolving the conflict, which is where the text was actually lost.
 *
 * Once `saveState` is 'conflict' every autosave has been refused, so the
 * store's `source` is the only copy of everything typed since the file changed
 * underneath it. The disk arm reloaded the script and showed a toast, and the
 * dialog told the user the other version would be kept as a revision. Nothing
 * wrote it anywhere.
 */
describe('resolving an external conflict never drops the editor text', () => {
  /** Everything typed after the external change; it exists nowhere else. */
  const unsaved = '# Keynote\n\nTen minutes of work that is only in memory.\n';

  beforeEach(async () => {
    // Before anything reads a script: a leftover override from the previous
    // test would otherwise reject this block's own `openScript`.
    getBehaviour = null;
    saveBehaviour = async () => ({ scriptRevision: 8 });
    createBehaviour = async (input) => ({
      ...structuredClone(scriptDocument),
      id: 'created',
      ...input,
    });
    diskDocument = structuredClone(scriptDocument);
    createCalls.length = 0;
    saveCalls.length = 0;
    closeScript();
    await openScript(scriptDocument.id);

    // Drive the store into the real conflict state, then let the disk move on.
    saveBehaviour = async () => {
      throw appError('SCRIPT_CONFLICT', "This script's file changed outside CandidCue.");
    };
    setSource(unsaved);
    await saveNow();
    diskDocument = {
      ...structuredClone(scriptDocument),
      source: '# Keynote\n\nSomething a sync wrote.\n',
      scriptRevision: 9,
    };
    saveBehaviour = async () => ({ scriptRevision: 10 });
    expect(get(editor).saveState).toBe('conflict');

    // The refused autosave above is setup, not part of what each test asserts.
    createCalls.length = 0;
    saveCalls.length = 0;
  });

  /*
   * The ordering guarantee, observed WHILE the durable write is in flight.
   *
   * Every other test here inspects state after the arm has settled, and an
   * implementation that adopted the disk document first and rolled back on
   * rejection would satisfy all of them. This one holds `createScript` open
   * and looks at the editor in that window, where such an implementation has
   * already replaced the text.
   */
  it('still holds the unsaved text while the copy is being written', async () => {
    let releaseCreate = (): void => {};
    const created = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    createBehaviour = async (input) => {
      await created;
      return { ...structuredClone(scriptDocument), id: 'created', ...input };
    };

    const arm = useDiskVersion();
    // Let the fetch and the createScript call happen, but not resolve.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(createCalls).toHaveLength(1);
    const midFlight = get(editor);
    expect(midFlight.source).toBe(unsaved);
    expect(midFlight.saveState).toBe('conflict');
    expect(midFlight.dirty).toBe(true);

    releaseCreate();
    await arm;
    expect(get(editor).source).toBe(diskDocument.source);
  });

  it('writes the in-memory text to a new script before loading the disk version', async () => {
    await useDiskVersion();

    expect(createCalls).toHaveLength(1);
    // The exact bytes the user typed, not a truncated or re-read copy.
    expect(createCalls[0]?.source).toBe(unsaved);
    expect(createCalls[0]?.title).toBe(conflictCopyTitle(scriptDocument.title));

    // ...and only then does the disk version take over the editor.
    const state = get(editor);
    expect(state.source).toBe(diskDocument.source);
    expect(state.scriptRevision).toBe(9);
    // The disk version arrives through `openScript`, so the editor is quiet
    // rather than reporting a save it did not perform — see the note on
    // `saveState: 'idle'` there.
    expect(state.saveState).toBe('idle');
    expect(state.dirty).toBe(false);
  });

  /*
   * The ordering guarantee, stated as the failure it prevents. `openScript`
   * clears the buffer BEFORE it awaits the fetch, so an implementation that
   * reloads first and preserves second destroys the text and then discovers it
   * cannot write it down.
   */
  it('keeps the text and the conflict state when the copy cannot be written', async () => {
    createBehaviour = async () => {
      throw appError('SAVE_FAILED', 'CandidCue could not write the script file.');
    };

    await expect(useDiskVersion()).rejects.toBeTruthy();

    const state = get(editor);
    expect(state.source).toBe(unsaved);
    expect(state.saveState).toBe('conflict');
    expect(state.dirty).toBe(true);
  });

  it('does not reach the disk version when the copy fails', async () => {
    createBehaviour = async () => {
      throw appError('SAVE_FAILED', 'CandidCue could not write the script file.');
    };
    await expect(useDiskVersion()).rejects.toBeTruthy();
    expect(get(editor).source).not.toBe(diskDocument.source);
  });

  /** No junk copy when there is nothing to preserve. */
  it('skips the copy when the editor already holds the disk text', async () => {
    diskDocument = { ...diskDocument, source: unsaved };
    await useDiskVersion();
    expect(createCalls).toHaveLength(0);
    expect(get(editor).source).toBe(unsaved);
  });

  /*
   * The other arm. Rust preserves the externally changed file as a revision
   * before it refuses the save, so this one only has to win the compare-and-
   * swap — against the revision the DISK now holds, not the stale one the
   * editor was opened with.
   */
  it('keeps the editor text by saving against the revision the disk now holds', async () => {
    await keepEditorVersion();

    expect(saveCalls).toHaveLength(1);
    expect(saveCalls[0]?.source).toBe(unsaved);
    expect(saveCalls[0]?.expectedRevision).toBe(9);
    expect(createCalls).toHaveLength(0);
  });

  it('leaves the conflict unresolved when keeping the editor text fails', async () => {
    saveBehaviour = async () => {
      throw appError('SAVE_FAILED', 'CandidCue could not write the script file.');
    };

    await expect(keepEditorVersion()).rejects.toBeTruthy();

    const state = get(editor);
    expect(state.source).toBe(unsaved);
    expect(state.saveState).toBe('conflict');
  });

  /*
   * Keeping the edits must not leave a BLANK editor behind.
   *
   * The arm used to reopen the script after saving, and `openScript` clears
   * the buffer before it awaits its fetch. A transient failure on that second
   * read therefore emptied the editor of the text the save had just rescued,
   * cleared the conflict, and left the sheet offering "keep my edits" over an
   * empty buffer — so pressing it again wrote the blank over the rescue.
   */
  it('does not blank the editor when a post-save reload would fail', async () => {
    let gets = 0;
    getBehaviour = async () => {
      gets += 1;
      // The first read is the arm's own; anything after it is a reload.
      if (gets > 1) throw appError('SCRIPT_NOT_FOUND', 'The script could not be read.');
      return structuredClone(diskDocument);
    };

    await keepEditorVersion();

    const state = get(editor);
    expect(state.source).toBe(unsaved);
    expect(state.title).toBe(scriptDocument.title);
    expect(state.saveState).toBe('saved');
    expect(state.dirty).toBe(false);
  });

  it('adopts the revision the save returned rather than re-reading it', async () => {
    saveBehaviour = async () => ({ scriptRevision: 11 });
    await keepEditorVersion();
    expect(get(editor).scriptRevision).toBe(11);
  });

  /* The mock backend answers a conflict by value rather than by rejection. */
  it('treats a by-value conflict from the save as a failure', async () => {
    saveBehaviour = async () => ({ status: 'conflict', scriptRevision: 9 });
    await expect(keepEditorVersion()).rejects.toBeTruthy();
    expect(get(editor).source).toBe(unsaved);
  });

  /*
   * A slow arm must not reach across a navigation.
   *
   * The sheet can be dismissed and another script opened while an arm is in
   * flight; adopting unconditionally then replaced THAT script's editor state
   * and cancelled its pending autosave — the same data loss, arriving from the
   * other direction.
   */
  it('does not replace the editor when another script was opened meanwhile', async () => {
    let releaseCreate = (): void => {};
    const created = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    createBehaviour = async (input) => {
      await created;
      return { ...structuredClone(scriptDocument), id: 'created', ...input };
    };

    const arm = useDiskVersion();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The user leaves for another script while the copy is still being written.
    const other = {
      ...structuredClone(scriptDocument),
      id: '9f8e7d6c-5b4a-4392-8281-706f5e4d3c2b',
      title: 'Another script',
      source: '# Another script\n\nTyped here instead.\n',
    };
    diskDocument = other;
    await openScript(other.id);

    releaseCreate();
    await arm;

    // The durable copy still happened; the other script's editor is untouched.
    expect(createCalls).toHaveLength(1);
    const state = get(editor);
    expect(state.scriptId).toBe(other.id);
    expect(state.source).toBe(other.source);
  });
});
