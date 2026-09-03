import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import {
  setCompilerWorkerFactoryForTesting,
  type WorkerLike,
} from '../../../src/control/services/compiler';
import * as scripts from '../../../src/control/services/scripts';
import {
  AUTOSAVE_DEBOUNCE_MS,
  COMPILE_DEBOUNCE_MS,
  closeScript,
  editor,
  editorHasUnsavedWork,
  editorStateHasUnsavedWork,
  openScript,
  saveNow,
  setSource,
} from '../../../src/control/stores/editor';

/** Auto-answering fake worker so compile requests resolve immediately. */
class AutoWorker implements WorkerLike {
  /** Every compile request that crossed the worker boundary. */
  static requests: Array<{ source: string }> = [];
  private listener: ((event: MessageEvent) => void) | null = null;
  postMessage(message: unknown): void {
    const request = message as {
      requestId: number;
      editorRevision: number;
      scriptId: string;
      source: string;
    };
    AutoWorker.requests.push({ source: request.source });
    queueMicrotask(() => {
      this.listener?.({
        data: {
          type: 'compile_result',
          requestId: request.requestId,
          editorRevision: request.editorRevision,
          durationMs: 0,
          script: {
            schemaVersion: 1,
            compilerVersion: 'test',
            scriptId: request.scriptId,
            sourceHash: 'hash',
            settingsHash: 'settings',
            title: 'Test',
            outline: [],
            blocks: [],
            spokenTokens: [],
            sentences: [],
            navigationTargets: [],
            cues: [],
            assets: [],
            diagnostics: [],
            statistics: {
              spokenWordCount: 0,
              wordsPerMinute: 150,
              estimatedDurationSeconds: 0,
              nonSpokenBlockCount: 0,
              imageCount: 0,
              diagramCount: 0,
              tableCount: 0,
              cueCount: 0,
              takeCount: 0,
              sentenceCount: 0,
              blockCount: 0,
            },
            indexes: {},
          },
        },
      } as MessageEvent);
    });
  }
  addEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
    this.listener = listener;
  }
  terminate(): void {
    this.listener = null;
  }
}

let scriptId: string;

beforeEach(async () => {
  setCompilerWorkerFactoryForTesting(() => new AutoWorker());
  const doc = await scripts.createScript({ title: 'Autosave test', source: '# Start\n' });
  scriptId = doc.id;
  await openScript(scriptId);
});

afterEach(async () => {
  closeScript();
  setCompilerWorkerFactoryForTesting(null);
  await scripts.permanentlyDeleteScript(scriptId);
  vi.useRealTimers();
});

describe('editor autosave', () => {
  /*
   * `idle`, not `saved`.
   *
   * A freshly opened document has not been saved — it has been READ. Opening as
   * `saved` was harmless while the label lived in a header nobody read closely,
   * and became wrong when the status bar adopted §11.7's rule that "Saved" is
   * transient: a permanent one from the instant of opening is a claim the user
   * learns to ignore, which is what makes the real one invisible.
   */
  it('opens a script into a clean state with nothing to report', () => {
    const state = get(editor);
    expect(state.scriptId).toBe(scriptId);
    expect(state.saveState).toBe('idle');
    expect(state.dirty).toBe(false);
    // And nothing is outstanding — "idle" here means saved-and-quiet, never
    // "there is unflushed work".
    expect(editorHasUnsavedWork()).toBe(false);
  });

  /*
   * The predicate the leave guard asks before it lets anybody out of the
   * editor. It had no callers at all until that guard started using it, so
   * nothing had ever pinned down what it considers safe to abandon.
   */
  it('reports nothing outstanding on a freshly opened script', () => {
    expect(editorHasUnsavedWork()).toBe(false);
  });

  it('reports work outstanding while a save is still in flight', async () => {
    vi.useFakeTimers();
    setSource('# Start\n\nIn flight.\n');
    const pending = saveNow();
    // Mid-save: the bytes are not on disk yet, so leaving now would still lose
    // them if the write fails.
    expect(get(editor).saveState).toBe('saving');
    expect(editorHasUnsavedWork()).toBe(true);
    await pending;
    // Immediately after the write: "Saved", which is the report of an event.
    expect(get(editor).saveState).toBe('saved');
    expect(editorHasUnsavedWork()).toBe(false);
    // …and then it goes quiet. `runAllTimersAsync` runs the badge timer too.
    await vi.runAllTimersAsync();
    expect(get(editor).saveState).toBe('idle');
    expect(editorHasUnsavedWork()).toBe(false);
    vi.useRealTimers();
  });

  /*
   * Two saves on the wire carry the same `scriptRevision`, and the second is
   * refused as `SCRIPT_CONFLICT` — the "changed elsewhere" sheet, for a change
   * this window made itself. Typing through a slow save is all it took.
   */
  it('waits for the save in flight rather than racing it with a stale revision', async () => {
    setSource('# Start\n\nFirst.\n');
    const first = saveNow();
    expect(get(editor).saveState).toBe('saving');
    // More typing while the first save is on the wire, then a second flush.
    setSource('# Start\n\nFirst. Second.\n');
    const second = saveNow();
    await Promise.all([first, second]);

    expect(get(editor).saveState).not.toBe('conflict');
    expect(get(editor).dirty).toBe(false);
    const persisted = await scripts.getScript(scriptId);
    expect(persisted.source).toContain('Second.');
    expect(persisted.scriptRevision).toBe(get(editor).scriptRevision);
  });

  it('debounces autosave ~500 ms after typing stops', async () => {
    vi.useFakeTimers();
    setSource('# Start\n\nMore words.\n');
    expect(get(editor).dirty).toBe(true);
    expect(editorHasUnsavedWork()).toBe(true);

    // Before the debounce elapses nothing has been saved.
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS - 100);
    expect(get(editor).dirty).toBe(true);

    await vi.advanceTimersByTimeAsync(200);
    await vi.runAllTimersAsync();
    // Past the badge interval as well, so the state has settled back to quiet.
    expect(get(editor).saveState).toBe('idle');
    expect(get(editor).dirty).toBe(false);
    vi.useRealTimers();

    const persisted = await scripts.getScript(scriptId);
    expect(persisted.source).toContain('More words.');
  });

  it('restarts the debounce on further typing', async () => {
    vi.useFakeTimers();
    setSource('# Start\n\nOne.\n');
    await vi.advanceTimersByTimeAsync(300);
    setSource('# Start\n\nOne. Two.\n');
    await vi.advanceTimersByTimeAsync(300);
    // 600ms total but only 300ms since the last keystroke — still unsaved.
    expect(get(editor).dirty).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    await vi.runAllTimersAsync();
    expect(get(editor).dirty).toBe(false);
  });

  it('saveNow persists immediately (Cmd/Ctrl+S path)', async () => {
    setSource('# Start\n\nImmediate.\n');
    await saveNow();
    const state = get(editor);
    expect(state.saveState).toBe('saved');
    expect(state.dirty).toBe(false);
    const persisted = await scripts.getScript(scriptId);
    expect(persisted.source).toContain('Immediate.');
  });

  it('bumps the editor revision on every change', () => {
    const before = get(editor).editorRevision;
    setSource('# Start\n\nA.\n');
    setSource('# Start\n\nA. B.\n');
    expect(get(editor).editorRevision).toBe(before + 2);
  });
});

/*
 * The save-state axis on its own.
 *
 * These cases cannot be reached through the store: every failure path leaves
 * `dirty` true as well, so a store-driven test is satisfied by `dirty` alone
 * and would keep passing if the save states were deleted from the predicate
 * outright. Holding `dirty` false is the only way to assert that each save
 * state carries the decision by itself.
 */
describe('editorStateHasUnsavedWork', () => {
  it('lets a clean, settled editor go', () => {
    expect(editorStateHasUnsavedWork({ dirty: false, saveState: 'idle' })).toBe(false);
    expect(editorStateHasUnsavedWork({ dirty: false, saveState: 'saved' })).toBe(false);
  });

  it('holds on to a save that has not landed, with nothing else outstanding', () => {
    expect(editorStateHasUnsavedWork({ dirty: false, saveState: 'saving' })).toBe(true);
    expect(editorStateHasUnsavedWork({ dirty: false, saveState: 'error' })).toBe(true);
    // The state the predicate used to miss entirely.
    expect(editorStateHasUnsavedWork({ dirty: false, saveState: 'conflict' })).toBe(true);
  });

  it('treats unsaved typing as outstanding whatever the last save did', () => {
    expect(editorStateHasUnsavedWork({ dirty: true, saveState: 'idle' })).toBe(true);
    expect(editorStateHasUnsavedWork({ dirty: true, saveState: 'saved' })).toBe(true);
  });
});

describe('compile debounce (spec §45.3)', () => {
  beforeEach(() => {
    AutoWorker.requests = [];
  });

  it('coalesces a burst of keystrokes into a single compile request', async () => {
    vi.useFakeTimers();
    // Four keystrokes inside one debounce window.
    setSource('# Start\n\nT');
    await vi.advanceTimersByTimeAsync(20);
    setSource('# Start\n\nTy');
    await vi.advanceTimersByTimeAsync(20);
    setSource('# Start\n\nTyp');
    await vi.advanceTimersByTimeAsync(20);
    setSource('# Start\n\nType');
    expect(AutoWorker.requests).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(COMPILE_DEBOUNCE_MS + 10);
    expect(AutoWorker.requests).toHaveLength(1);
    // The one request that ran carries the newest text, not a stale prefix.
    expect(AutoWorker.requests[0]?.source).toBe('# Start\n\nType');
    await vi.runAllTimersAsync();
    vi.useRealTimers();
  });

  it('still compiles once typing stops', async () => {
    vi.useFakeTimers();
    setSource('# Start\n\nSettled.\n');
    await vi.advanceTimersByTimeAsync(COMPILE_DEBOUNCE_MS + 10);
    expect(AutoWorker.requests).toHaveLength(1);
    await vi.runAllTimersAsync();
    vi.useRealTimers();
  });

  it('stays well under the latency at which a preview feels laggy', () => {
    expect(COMPILE_DEBOUNCE_MS).toBeGreaterThan(0);
    expect(COMPILE_DEBOUNCE_MS).toBeLessThanOrEqual(120);
  });

  it('flushes a pending compile when saveNow runs (Preflight handoff)', async () => {
    vi.useFakeTimers();
    setSource('# Start\n\nFlush me.\n');
    expect(AutoWorker.requests).toHaveLength(0);
    const saving = saveNow();
    // The compile went out immediately, without waiting for the debounce.
    expect(AutoWorker.requests).toHaveLength(1);
    await vi.runAllTimersAsync();
    await saving;
    vi.useRealTimers();
  });
});
