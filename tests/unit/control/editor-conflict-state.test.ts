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
const saveCalls: Array<{ expectedRevision: number; source: string }> = [];

vi.mock('../../../src/control/services/scripts', () => ({
  getScript: async () => structuredClone(diskDocument),
  saveScript: async (_id: string, expectedRevision: number, source: string) => {
    saveCalls.push({ expectedRevision, source });
    return saveBehaviour();
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
    expect(state.saveState).toBe('saved');
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
});
