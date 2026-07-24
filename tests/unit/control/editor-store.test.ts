import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import {
  setCompilerWorkerFactoryForTesting,
  type WorkerLike,
} from '../../../src/control/services/compiler';
import * as scripts from '../../../src/control/services/scripts';
import {
  AUTOSAVE_DEBOUNCE_MS,
  closeScript,
  editor,
  editorHasUnsavedWork,
  openScript,
  saveNow,
  setSource,
} from '../../../src/control/stores/editor';

/** Auto-answering fake worker so compile requests resolve immediately. */
class AutoWorker implements WorkerLike {
  private listener: ((event: MessageEvent) => void) | null = null;
  postMessage(message: unknown): void {
    const request = message as { requestId: number; editorRevision: number; scriptId: string };
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
  it('opens a script into a clean saved state', () => {
    const state = get(editor);
    expect(state.scriptId).toBe(scriptId);
    expect(state.saveState).toBe('saved');
    expect(state.dirty).toBe(false);
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
    expect(get(editor).saveState).toBe('saved');
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
