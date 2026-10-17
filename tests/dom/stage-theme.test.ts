/**
 * The stage names its field on `.stage-root`, and only a reading window can
 * name paper.
 *
 * jsdom resolves no stylesheets, so this cannot see a colour — the Playwright
 * spec (`reader-paper-theme.spec.ts`) does that. What it CAN see is the one
 * attribute every paper token is keyed on, set from the envelope the stage
 * actually hydrated from: paper for a reading window composed on paper, the
 * dark field for a prompter, and the dark field for an envelope that claims
 * paper without being a reading window — the stage's own second lock, so a
 * light field cannot reach glass even if control were ever to say otherwise.
 */
import { render } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import StageApp from '../../src/stage/StageApp.svelte';
import { dispatchLocalStageEvent } from '../../src/stage/events';
import { STAGE_EVENT } from '../../src/shared/contracts';
import type {
  StageRenderDocument,
  StageSessionEnvelope,
  StageSettings,
} from '../../src/shared/contracts';
import {
  READER_PAPER_THEME_ID,
  STAGE_DARK_THEME_ID,
  buildStageSettings,
} from '../../src/control/services/stage-envelope';

beforeAll(() => {
  (globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        onchange: null,
        dispatchEvent: () => false,
      }),
    });
  }
  if (!('fonts' in document)) {
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready: Promise.resolve(), load: async () => [] },
    });
  }
});

afterEach(() => {
  document.body.innerHTML = '';
});

function renderDocument(): StageRenderDocument {
  return {
    schemaVersion: 1,
    title: 'Take one',
    blocks: [
      {
        id: 'b1',
        kind: 'paragraph',
        renderNodes: [{ type: 'text', text: 'Hello there friend', tokenIndexes: [0, 1, 2] }],
        startTokenIndex: 0,
        endTokenIndex: 2,
        source: { utf16Start: 0, utf16End: 18 },
        spoken: true,
      },
    ],
    tokenToNode: [0, 1, 2].map((tokenIndex) => ({ tokenIndex, blockId: 'b1', nodeKey: '' })),
    assets: {},
    sentences: [{ id: 's1', blockId: 'b1', startTokenIndex: 0, endTokenIndex: 2 }],
  } as unknown as StageRenderDocument;
}

function envelope(stageSettings: StageSettings, stageGeneration = 3): StageSessionEnvelope {
  return {
    schemaVersion: 1,
    sessionId: '00000000-0000-0000-0000-0000000000bb',
    sessionGeneration: 1,
    stageGeneration,
    scriptId: '00000000-0000-0000-0000-000000000002',
    sourceHash: 'hash-theme',
    compileRevision: 1,
    stageSettings,
    renderDocument: renderDocument(),
    initialTokenIndex: 0,
  } as StageSessionEnvelope;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function mountWith(stageSettings: StageSettings): Promise<HTMLElement> {
  const { container } = render(StageApp);
  await settle();
  dispatchLocalStageEvent(STAGE_EVENT.loadSession, envelope(stageSettings));
  await settle();
  const root = container.querySelector<HTMLElement>('.stage-root');
  expect(root).not.toBeNull();
  return root!;
}

const readerOnPaper = () => buildStageSettings({ readingContext: 'reader', readerTheme: 'paper' });

describe('the field the stage names', () => {
  it('is paper for a reading window composed on paper', async () => {
    const root = await mountWith(readerOnPaper());
    expect(root.getAttribute('data-theme')).toBe(READER_PAPER_THEME_ID);
  });

  it('is the dark field for a prompter, and for a dark reading window', async () => {
    const prompter = await mountWith(buildStageSettings());
    expect(prompter.getAttribute('data-theme')).toBe(STAGE_DARK_THEME_ID);
    document.body.innerHTML = '';

    const reader = await mountWith(buildStageSettings({ readingContext: 'reader' }));
    expect(reader.getAttribute('data-theme')).toBe(STAGE_DARK_THEME_ID);
  });

  it('refuses paper for anything that is not a reading window', async () => {
    // Forged past `buildStageSettings`, which would never write this.
    const forged = { ...buildStageSettings(), themeId: READER_PAPER_THEME_ID };
    const root = await mountWith(forged);
    expect(root.getAttribute('data-theme')).toBe(STAGE_DARK_THEME_ID);
  });

  it('treats an id it does not know as the dark field', async () => {
    const root = await mountWith({
      ...buildStageSettings({ readingContext: 'reader' }),
      themeId: 'reader-sepia',
    });
    expect(root.getAttribute('data-theme')).toBe(STAGE_DARK_THEME_ID);
  });

  it('follows a refresh in place, the way a mid-read switch arrives', async () => {
    const root = await mountWith(buildStageSettings({ readingContext: 'reader' }));
    expect(root.getAttribute('data-theme')).toBe(STAGE_DARK_THEME_ID);

    // Same generation: `stageReducer` treats it as a refresh, not a new take.
    dispatchLocalStageEvent(STAGE_EVENT.loadSession, envelope(readerOnPaper()));
    await settle();
    expect(root.getAttribute('data-theme')).toBe(READER_PAPER_THEME_ID);

    // And to the prompter: black again.
    dispatchLocalStageEvent(STAGE_EVENT.loadSession, envelope(buildStageSettings()));
    await settle();
    expect(root.getAttribute('data-theme')).toBe(STAGE_DARK_THEME_ID);
  });

  it('keeps the intensity attribute alongside it, for the paper inks', async () => {
    const root = await mountWith({ ...readerOnPaper(), textIntensity: 'soft' });
    expect(root.getAttribute('data-theme')).toBe(READER_PAPER_THEME_ID);
    expect(root.getAttribute('data-text-intensity')).toBe('soft');
  });
});
