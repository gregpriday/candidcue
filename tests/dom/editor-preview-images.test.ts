/**
 * Pictures in the editor preview (#250).
 *
 * The preview drew every image as `[Image: alt]`, so the only way to check
 * which picture went in was to start a take, and an image whose file was
 * missing looked exactly like one that worked.
 *
 * These mount the route over a REAL compile, because what is under test is the
 * route's own lookup: asked once per set of images rather than per keystroke,
 * answered under the id it sent, and an answer for a superseded set dropped.
 * The compile store is stubbed only so the Web Worker behind it does not have
 * to run in jsdom, and so each test can hand the route the compile it wants.
 *
 * No jest-dom here (see `vitest.dom.config.ts`) — assertions are plain DOM
 * reads. jsdom loads no images, so an `<img>` failing to load is a dispatched
 * `error` event; what WKWebView makes of a real `asset://` url is not proven
 * by anything in this file.
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

const SOURCE = [
  '# Launch',
  '',
  'Here is the chart.',
  '',
  '![Revenue by month](assets/revenue.png)',
  '',
  '![Old screenshot](assets/gone.png)',
  '',
].join('\n');

const REVENUE_URL = 'asset://localhost/revenue.png';

type ResolveRequest = { id: string; href: string };
type ResolveAnswer = Record<string, { url: string; mime: string }>;

/**
 * Rust's answer, as `resolve_asset_urls` gives it: found ids only, under the
 * id the caller sent. `answer` may hold a call open or reject it.
 */
function installBackend(
  answer: (requests: ResolveRequest[]) => Promise<ResolveAnswer> = async (requests) =>
    found(requests, { 'assets/revenue.png': REVENUE_URL }),
): Array<ResolveRequest[]> {
  const resolveCalls: Array<ResolveRequest[]> = [];
  const fake: InvokeFn = async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
    if (command === 'get_script') {
      return {
        id: SCRIPT_ID,
        title: 'Keynote',
        status: 'draft',
        language: 'en',
        spokenWordCount: 4,
        estimatedDurationSeconds: 2,
        updatedAt: '2026-10-16T10:00:00.000Z',
        previewText: 'Here is the chart.',
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
          wordsPerMinuteEstimate: 130,
        },
      } as T;
    }
    if (command === 'resolve_asset_urls') {
      expect(args?.['scriptId']).toBe(SCRIPT_ID);
      const requests = args?.['assetsToResolve'] as ResolveRequest[];
      resolveCalls.push(requests);
      return (await answer(requests)) as T;
    }
    throw new Error(`unexpected command ${command}`);
  };
  setInvokeForTesting(fake);
  return resolveCalls;
}

function found(requests: ResolveRequest[], urls: Record<string, string>): ResolveAnswer {
  const answer: ResolveAnswer = {};
  for (const request of requests) {
    const url = urls[request.href];
    if (url) answer[request.id] = { url, mime: 'image/png' };
  }
  return answer;
}

/** The compile the editor would get back, made the way the worker makes it. */
function compiledFrom(source: string, editorRevision: number): CompiledState {
  const script = compile(source, { scriptId: SCRIPT_ID });
  const result: CompileOutput = {
    stale: false,
    requestId: editorRevision + 1,
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
  return { status: 'ready', editorRevision, result, error: null, scriptId: SCRIPT_ID };
}

async function settle(): Promise<void> {
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
}

async function mountEditor(source = SOURCE): Promise<void> {
  compiledState.set(compiledFrom(source, 0));
  render(Editor, { props: { scriptId: SCRIPT_ID } });
  await settle();
}

function preview(): HTMLElement {
  const pane = document.querySelector<HTMLElement>('.preview');
  expect(pane, 'the editor must have a preview pane').toBeTruthy();
  return pane!;
}

function previewImage(alt: string): HTMLImageElement | null {
  return preview().querySelector<HTMLImageElement>(`img[alt="${alt}"]`);
}

function note(state: string): HTMLElement | null {
  return preview().querySelector<HTMLElement>(`[data-image-state="${state}"]`);
}

afterEach(() => {
  setInvokeForTesting(null);
  vi.clearAllMocks();
});

describe('editor preview images', () => {
  it('draws the picture Rust found and marks the one it could not find', async () => {
    const calls = installBackend();
    await mountEditor();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.map((r) => r.href).sort()).toEqual(['assets/gone.png', 'assets/revenue.png']);

    const img = previewImage('Revenue by month');
    expect(img, 'a resolved image must be drawn, not described').toBeTruthy();
    expect(img!.getAttribute('src')).toBe(REVENUE_URL);

    expect(previewImage('Old screenshot')).toBeNull();
    const missing = note('missing');
    expect(missing).toBeTruthy();
    expect(missing!.textContent).toContain('Image not found');
    expect(missing!.textContent).toContain('Old screenshot');
    expect(preview().textContent).not.toContain('[Image:');
  });

  it('asks once per set of images, not once per keystroke', async () => {
    const calls = installBackend();
    await mountEditor();
    expect(calls).toHaveLength(1);

    // Typing prose around the pictures: a new compile, the same images.
    compiledState.set(compiledFrom(SOURCE.replace('the chart.', 'the chart for May.'), 1));
    await settle();
    expect(calls).toHaveLength(1);
    expect(previewImage('Revenue by month')?.getAttribute('src')).toBe(REVENUE_URL);

    // Adding a picture is a new set, and only then is Rust asked again.
    compiledState.set(compiledFrom(`${SOURCE}\n![Team photo](assets/team.png)\n`, 2));
    await settle();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.map((r) => r.href)).toContain('assets/team.png');
  });

  it('keeps showing a picture while a new set of images is being looked up', async () => {
    const held: Array<() => void> = [];
    let callCount = 0;
    installBackend(async (requests) => {
      callCount += 1;
      if (callCount === 2) await new Promise<void>((resolve) => held.push(resolve));
      return found(requests, {
        'assets/revenue.png': REVENUE_URL,
        'assets/team.png': 'asset://localhost/team.png',
      });
    });
    await mountEditor();

    compiledState.set(compiledFrom(`${SOURCE}\n![Team photo](assets/team.png)\n`, 1));
    await settle();
    // The old answer stays on screen; only the new picture waits.
    expect(previewImage('Revenue by month')?.getAttribute('src')).toBe(REVENUE_URL);
    expect(note('missing')?.textContent).toContain('Old screenshot');
    expect(note('pending')?.textContent).toContain('Team photo');

    expect(held).toHaveLength(1);
    held[0]!();
    await settle();
    expect(previewImage('Team photo')?.getAttribute('src')).toBe('asset://localhost/team.png');
    expect(note('pending')).toBeNull();
  });

  it('drops an answer for a set of images the script no longer has', async () => {
    const held: Array<() => void> = [];
    installBackend(async (requests) => {
      await new Promise<void>((resolve) => held.push(resolve));
      // The stale answer would "find" the old screenshot, which the newer
      // answer reports missing; whichever lands last is what shows.
      return found(requests, {
        'assets/revenue.png': REVENUE_URL,
        ...(requests.some((r) => r.href === 'assets/team.png')
          ? {}
          : { 'assets/gone.png': 'asset://localhost/stale.png' }),
      });
    });
    await mountEditor();
    expect(held).toHaveLength(1);

    compiledState.set(compiledFrom(`${SOURCE}\n![Team photo](assets/team.png)\n`, 1));
    await settle();
    expect(held).toHaveLength(2);

    // The newer answer first, then the superseded one arrives late.
    held[1]!();
    await settle();
    held[0]!();
    await settle();

    expect(previewImage('Old screenshot')).toBeNull();
    expect(note('missing')?.textContent).toContain('Old screenshot');
    expect(preview().querySelector('img[src="asset://localhost/stale.png"]')).toBeNull();
  });

  it('does not call an image missing when the lookup itself failed', async () => {
    installBackend(async () => {
      throw { code: 'INTERNAL', userMessage: 'database is locked' };
    });
    await mountEditor();

    expect(preview().querySelector('img')).toBeNull();
    expect(note('missing')).toBeNull();
    const errors = preview().querySelectorAll('[data-image-state="error"]');
    expect(errors).toHaveLength(2);
    expect(errors[0]!.textContent).toContain('Image could not be loaded');
  });

  it('marks a picture the webview could not load instead of leaving a broken image', async () => {
    installBackend();
    await mountEditor();
    const img = previewImage('Revenue by month');
    expect(img).toBeTruthy();

    img!.dispatchEvent(new Event('error'));
    await settle();

    expect(previewImage('Revenue by month')).toBeNull();
    const failed = note('error');
    expect(failed?.textContent).toContain('Image could not be loaded');
    expect(failed?.textContent).toContain('Revenue by month');
  });
});
