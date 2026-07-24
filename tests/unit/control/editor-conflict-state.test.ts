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

vi.mock('../../../src/control/services/scripts', () => ({
  getScript: async () => structuredClone(scriptDocument),
  saveScript: async () => saveBehaviour(),
  renameScript: async () => ({ scriptRevision: 8 }),
}));

vi.mock('../../../src/control/stores/compiled', () => ({
  requestCompile: async () => undefined,
  resetCompiled: () => undefined,
}));

const { editor, openScript, saveNow, setSource, closeScript } = await import(
  '../../../src/control/stores/editor'
);

/** The AppError payload shape Rust rejections cross the boundary as. */
function appError(code: string, userMessage: string): unknown {
  return { code, category: 'validation', userMessage, recoverable: true };
}

describe('the editor reflects a real SCRIPT_CONFLICT', () => {
  beforeEach(async () => {
    saveBehaviour = async () => ({ scriptRevision: 8 });
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
