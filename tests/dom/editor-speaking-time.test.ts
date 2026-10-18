/**
 * The editor's speaking-time labels (#246).
 *
 * The status bar and the outline estimated at 150 wpm while the compiler, the
 * Library and the spec said 130, so a 1,000-word script read "≈ 7 min" in the
 * editor and "≈ 8 min" on its own Library row. The outline also dropped a word
 * from every section by subtracting an inclusive end.
 *
 * These mount the route over a REAL compile result, because what was wrong was
 * the route's own arithmetic on one. The compile store is stubbed only so the
 * Web Worker behind it does not have to run in jsdom.
 *
 * No jest-dom here (see `vitest.dom.config.ts`) — assertions are plain DOM
 * reads.
 */
import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import type { Writable } from 'svelte/store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setInvokeForTesting, type InvokeFn } from '../../src/control/services/ipc';
import type { CompileOutput } from '../../src/control/services/compiler';
import { compiled, type CompiledState } from '../../src/control/stores/compiled';
import Editor from '../../src/control/routes/Editor.svelte';
import { compile } from '../../src/shared/markdown';

vi.mock('../../src/control/stores/toasts', () => ({
  showToast: vi.fn(),
  dismissToast: vi.fn(),
  dismissToastByKey: vi.fn(),
  clearConditionToasts: vi.fn(),
  toasts: { subscribe: () => () => {} },
}));

vi.mock('../../src/control/stores/router', () => ({
  navigate: vi.fn(async () => true),
  route: { subscribe: () => () => {} },
  currentRoute: () => ({ name: 'editor', scriptId: 'a' }),
  registerNavigationGuard: () => () => {},
  setInitialRoute: vi.fn(),
}));

vi.mock('../../src/control/lib/shortcuts', () => ({ onShortcut: () => () => {} }));
vi.mock('../../src/control/lib/start-take', () => ({
  startTake: vi.fn(async () => {}),
  takeStarting: { subscribe: (run: (v: boolean) => void) => (run(false), () => {}) },
}));

/*
 * A writable in place of the real store, so each test can hand the route the
 * compile it wants. Opening the script calls `resetCompiled` and
 * `requestCompile`; both are inert here, so the compile set below stays put.
 */
vi.mock('../../src/control/stores/compiled', async () => {
  const { writable } = await import('svelte/store');
  return {
    compiled: writable({
      status: 'idle',
      editorRevision: -1,
      result: null,
      error: null,
      scriptId: null,
    }),
    requestCompile: vi.fn(async () => {}),
    resetCompiled: vi.fn(),
  };
});

const compiledState = compiled as unknown as Writable<CompiledState>;

const SCRIPT_ID = 'a';

function words(count: number): string {
  return `${Array.from({ length: count }, () => 'word').join(' ')}.`;
}

/*
 * 1,000 spoken words in four sections. The numbers are chosen so each fix
 * shows on its own label:
 *
 *   - the script at 130 wpm is 462 s, "≈ 8 min" (150 made it 400 s, "≈ 7 min");
 *   - `Detail` has 28 words, 13 s at 130, "0:15" in the outline's five-second
 *     steps — and 27 words, the count the inclusive-end subtraction gave it, is
 *     12 s, "0:10";
 *   - `Close` has 372 words, "2:50" at 130 and "2:30" at 150;
 *   - `Intro` holds its subsections too, 628 words: "4:50" at 130, "4:10" at 150.
 *
 * The status bar keeps the rounded "≈ N min"; the outline's time column is
 * minutes and seconds (`formatSectionTime`), with "0:00" for a section that has
 * nothing spoken in it.
 */
const SOURCE = [
  '# Intro',
  '',
  words(600),
  '',
  '## Detail',
  '',
  words(28),
  '',
  '## Empty',
  '',
  '# Close',
  '',
  words(372),
  '',
].join('\n');

function installBackend(wordsPerMinuteEstimate: number): void {
  const fake: InvokeFn = async <T,>(command: string): Promise<T> => {
    if (command === 'get_script') {
      return {
        id: SCRIPT_ID,
        title: 'Keynote',
        status: 'draft',
        language: 'en',
        spokenWordCount: 1000,
        estimatedDurationSeconds: Math.round((1000 / wordsPerMinuteEstimate) * 60),
        updatedAt: '2026-10-16T10:00:00.000Z',
        previewText: 'word word word',
        hasWarnings: false,
        scriptRevision: 3,
        source: SOURCE,
        sourceHash: 'hash',
        settings: {
          schemaVersion: 1,
          readHeadings: false,
          readImageAltText: false,
          readInlineCode: false,
          cueVisibility: 'subtle',
          silentBlockVisibility: 'dim',
          wordsPerMinuteEstimate,
        },
      } as T;
    }
    throw new Error(`unexpected command ${command}`);
  };
  setInvokeForTesting(fake);
}

/** The compile the editor would get back, made the way the worker makes it. */
function compiledAt(wordsPerMinute: number): CompileOutput {
  const script = compile(SOURCE, { scriptId: SCRIPT_ID, wordsPerMinute });
  return {
    stale: false,
    requestId: 1,
    scriptId: SCRIPT_ID,
    sourceHash: script.sourceHash,
    script,
    blocks: script.blocks,
    outline: script.outline,
    sentences: script.sentences,
    navigationTargets: script.navigationTargets,
    parts: script.parts ?? [],
    diagnostics: script.diagnostics,
    spokenWordCount: script.statistics.spokenWordCount,
    estimatedDurationSeconds: script.statistics.estimatedDurationSeconds,
  };
}

async function mountEditor(wordsPerMinute: number): Promise<void> {
  installBackend(wordsPerMinute);
  compiledState.set({
    status: 'ready',
    editorRevision: 0,
    result: compiledAt(wordsPerMinute),
    error: null,
    scriptId: SCRIPT_ID,
  });
  render(Editor, { props: { scriptId: SCRIPT_ID } });
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
}

function statusBarLabels(): string[] {
  const bar = document.querySelector('footer[aria-label="Status"]');
  expect(bar, 'the editor must have a status bar').toBeTruthy();
  return [...bar!.querySelectorAll('.item')].map((item) => item.textContent?.trim() ?? '');
}

function outlineLabels(): Array<[string, string]> {
  const items = [...document.querySelectorAll('aside[aria-label="Outline"] .outline-item')];
  expect(items.length, 'the outline must list the sections').toBeGreaterThan(0);
  return items.map((item) => [
    item.querySelector('.outline-title')?.textContent?.trim() ?? '',
    item.querySelector('.outline-time')?.textContent?.trim() ?? '',
  ]);
}

afterEach(() => {
  setInvokeForTesting(null);
  vi.clearAllMocks();
});

describe('editor speaking time', () => {
  it('reads 1,000 words as the Library does, at 130 wpm', async () => {
    await mountEditor(130);
    const labels = statusBarLabels();
    // The route groups digits with `toLocaleString`, so the expectation does too.
    expect(labels).toContain(`${(1000).toLocaleString()} words`);
    expect(labels).toContain('≈ 8 min');
    expect(labels).not.toContain('≈ 7 min');
  });

  it('times each outline section at the same rate, counting every word in it', async () => {
    await mountEditor(130);
    expect(outlineLabels()).toEqual([
      ['Intro', '4:50'],
      ['Detail', '0:15'],
      ['Empty', '0:00'],
      ['Close', '2:50'],
    ]);
  });

  it('follows a script whose own rate says otherwise', async () => {
    // The compile is made at the script's rate (the editor store passes it),
    // and both labels take the rate from that compile rather than a default.
    // 180, not 150: at 150 these labels are the ones the old code drew anyway.
    await mountEditor(180);
    const labels = statusBarLabels();
    expect(labels).toContain('≈ 6 min');
    expect(labels).not.toContain('≈ 7 min');
    expect(outlineLabels()).toEqual([
      ['Intro', '3:30'],
      ['Detail', '0:10'],
      ['Empty', '0:00'],
      ['Close', '2:05'],
    ]);
  });
});
