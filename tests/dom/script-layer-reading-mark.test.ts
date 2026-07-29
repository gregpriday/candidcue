/**
 * The renderer's two halves of the line-entry offset have to agree.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AS A COMPONENT TEST
 * ---------------------------------------------------------------------------
 * `lineEntryOffsetPx` is applied in two places in `ScriptLayer.svelte`: to the
 * scroll plane's top padding, and to the `readingLineStartY` (`R`) the line map
 * is built with. Both are load-bearing and they mean opposite things if either
 * one goes missing:
 *
 *   - padding only  → the document moves down but `R` still says a line ENTERS
 *                     at the mark, so the mark points at the following line for
 *                     most of every line. The original defect, restored.
 *   - `R` only      → the knots shift under a document that did not, the first
 *                     knot clamps at scroll 0, and the opening lines crawl.
 *
 * The pure geometry test (`tests/unit/stage/reading-mark-alignment.test.ts`)
 * models both numbers itself, so it cannot see either mistake — it would go on
 * passing with the component reverted. This is the seam that catches it: mount
 * the real component, capture the options it actually hands the map builder, and
 * check the offset against the mark the cue is actually drawn on.
 */
import { render } from '@testing-library/svelte';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StageRenderDocument, StageSettings } from '../../src/shared/contracts';
import type { LineMapBuildOptions } from '../../src/stage/motion';

/** Options from the most recent real `buildRenderedLineMap` call. */
let lastBuild: LineMapBuildOptions | null = null;

vi.mock('../../src/stage/motion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/stage/motion')>();
  return {
    ...actual,
    /*
     * jsdom lays nothing out, so `Range.getClientRects()` finds no token rows
     * and the renderer takes its `emptyRenderedLineMap` branch — which never
     * calls the builder at all. One synthetic token and block is the whole
     * stub: enough to reach the branch under test, and it is only ever used to
     * get there.
     */
    measureStageLayout: (): ReturnType<typeof actual.measureStageLayout> => ({
      tokens: [{ tokenIndex: 0, blockId: 'b1', xStart: 0, xEnd: 100, topY: 0, bottomY: 60 }],
      blocks: [
        {
          blockId: 'b1',
          sectionId: 'section:0',
          kind: 'paragraph',
          spoken: true,
          topY: 0,
          bottomY: 60,
        },
      ],
      lineHeightPx: 84.48,
      contentHeightPx: 60,
    }),
    buildRenderedLineMap: (options: LineMapBuildOptions) => {
      lastBuild = options;
      return actual.buildRenderedLineMap(options);
    },
  };
});

const ScriptLayer = (await import('../../src/stage/renderer/ScriptLayer.svelte')).default;

const VIEWPORT = { width: 1920, height: 1080 };
/** The uncalibrated 38 vh top padding this panel selects, before the offset. */
const LEGACY_TOP_PX = 0.38 * VIEWPORT.height;
/** Half a pitch (64 x 1.32) plus half a cap height (64 x the 0.7 fallback). */
// A quarter of the 84.48px pitch, plus half the 44.8px cap — see
// `lineEntryOffsetPx`, which moved from half a pitch to a quarter so the mark
// reaches the next line before the reader finishes the current one.
const LINE_ENTRY_PX = 84.48 * 0.25 + 22.4;

beforeAll(() => {
  (globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
    constructor(private cb: (entries: unknown[], self: unknown) => void) {}
    observe(target: Element): void {
      this.cb([{ target }], this);
    }
    unobserve(): void {}
    disconnect(): void {}
  };
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => VIEWPORT.width,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => VIEWPORT.height,
  });
});

beforeEach(() => {
  lastBuild = null;
});

const doc: StageRenderDocument = {
  schemaVersion: 1,
  title: 'Mark',
  blocks: [
    {
      id: 'b1',
      kind: 'paragraph',
      spoken: true,
      startTokenIndex: 0,
      endTokenIndex: 2,
      renderNodes: [{ type: 'text', text: 'one two three', tokenIndexes: [0, 1, 2] }],
      layoutHints: {},
      source: { utf16Start: 0, utf16End: 13 },
    },
  ],
  tokenToNode: [0, 1, 2].map((tokenIndex) => ({ tokenIndex, blockId: 'b1', nodeKey: '' })),
  assets: {},
};

const settings = {
  fontSizePx: 64,
  lineHeight: 1.32,
  fontWeight: 500,
  fontFamilyId: 'inter',
  letterSpacingEm: 0,
  paragraphSpacingEm: 0.7,
  columnWidthPercent: 78,
  readingBandCenterPercent: 38,
  readingBandHalfHeightPercent: 4,
  readingCue: 'ticks',
  mirrorX: false,
  mirrorY: false,
  pastOpacity: 0.35,
  futureOpacity: 1,
  currentUnderlayOpacity: 0,
  theme: 'dark',
} as unknown as StageSettings;

/**
 * Mount and wait for the map build, which is deliberately asynchronous: §7.1
 * measures only once fonts and layout-affecting assets are final, and then only
 * on the next animation frame.
 */
async function mount() {
  const result = render(ScriptLayer, {
    props: {
      doc,
      settings,
      sessionId: 's',
      sessionGeneration: 1,
      stageGeneration: 1,
      scriptCompileHash: 'hash',
    },
  });
  await vi.waitFor(() => expect(lastBuild).not.toBeNull());
  return result;
}

describe('ScriptLayer wires the line-entry offset to both halves', () => {
  it('puts `R` one offset below the mark the cue is drawn on', async () => {
    const { container } = await mount();
    const tick = container.querySelector('.tick') as HTMLElement | null;
    expect(tick).not.toBeNull();
    expect(lastBuild).not.toBeNull();

    // The cue is positioned on the band centre and centred on it by transform,
    // so its `top` IS the mark.
    const markPx = Number.parseFloat(tick?.style.top ?? 'NaN');
    expect(markPx).toBeGreaterThan(0);
    expect((lastBuild as LineMapBuildOptions).readingLineStartY - markPx).toBeCloseTo(
      LINE_ENTRY_PX,
      1,
    );
  });

  it('pays the same offset in the top padding, so the knots do not move', async () => {
    const { container } = await mount();
    const plane = container.querySelector('.scroll-plane') as HTMLElement | null;
    const padTopPx = Number.parseFloat(plane?.style.paddingTop ?? 'NaN');
    expect(padTopPx - LEGACY_TOP_PX).toBeCloseTo(LINE_ENTRY_PX, 1);

    // The two halves, stated as the one thing they have to be: equal. Applying
    // either alone is a different defect, and this is what makes reverting one
    // of them fail rather than quietly change the reading position.
    const markPx = Number.parseFloat(
      (container.querySelector('.tick') as HTMLElement | null)?.style.top ?? 'NaN',
    );
    expect((lastBuild as LineMapBuildOptions).readingLineStartY - markPx).toBeCloseTo(
      padTopPx - LEGACY_TOP_PX,
      1,
    );
  });
});
