/**
 * The renderer hands the auto-scroll scale the block boxes it measured.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AS A COMPONENT TEST
 * ---------------------------------------------------------------------------
 * #278: an image's height was charged to the words either side of it, and the
 * text rolled faster than the dial. The correction lives in
 * `measureAutoScrollScale`, and its unit tests prove the arithmetic — but they
 * supply the block boxes themselves. In production the boxes come from
 * `measureStageLayout`, and only `ScriptLayer` passes them on; drop that one
 * argument at the rebuild and every unit test goes on passing over a renderer
 * that has the bug back. This mounts the real component over a measured layout
 * with an image in it and checks the scale it actually derived.
 */
import { render } from '@testing-library/svelte';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StageRenderDocument, StageSettings } from '../../src/shared/contracts';
import type { AutoScrollBlockBox, AutoScrollScale } from '../../src/stage/renderer/autoscroll';
import type { MeasuredBlockBox, MeasuredTokenRect } from '../../src/stage/motion';

/** Every scale the component measured, newest last. */
const measured: { boxes: AutoScrollBlockBox[]; scale: AutoScrollScale | null }[] = [];

/*
 * Two paragraphs of two eight-word lines each, 64 px of pitch, with a 600 px
 * image between them. The text alone spends 264 px of travel on 24 words —
 * 11 px a word. Charged with the image as well it is 36.
 */
function lineOf(blockId: string, firstToken: number, topY: number): MeasuredTokenRect[] {
  return Array.from({ length: 8 }, (_, i) => ({
    tokenIndex: firstToken + i,
    blockId,
    xStart: i * 100,
    xEnd: i * 100 + 90,
    topY,
    bottomY: topY + 48,
  }));
}

function blockBox(blockId: string, kind: string, topY: number, bottomY: number): MeasuredBlockBox {
  return { blockId, sectionId: 'section:0', kind, spoken: kind !== 'image', topY, bottomY };
}

vi.mock('../../src/stage/motion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/stage/motion')>();
  return {
    ...actual,
    // jsdom lays nothing out, so the measurement is supplied: the one input
    // this test is about is what the component does with it.
    measureStageLayout: (): ReturnType<typeof actual.measureStageLayout> => ({
      tokens: [
        ...lineOf('p1', 0, 0),
        ...lineOf('p1', 8, 64),
        ...lineOf('p2', 16, 800),
        ...lineOf('p2', 24, 864),
      ],
      blocks: [
        blockBox('p1', 'paragraph', 0, 112),
        blockBox('img', 'image', 156, 756),
        blockBox('p2', 'paragraph', 800, 912),
      ],
      lineHeightPx: 64,
      contentHeightPx: 912,
    }),
  };
});

vi.mock('../../src/stage/renderer/autoscroll', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/stage/renderer/autoscroll')>();
  return {
    ...actual,
    measureAutoScrollScale: (...args: Parameters<typeof actual.measureAutoScrollScale>) => {
      const scale = actual.measureAutoScrollScale(...args);
      measured.push({ boxes: [...(args[1] ?? [])], scale });
      return scale;
    },
  };
});

const ScriptLayer = (await import('../../src/stage/renderer/ScriptLayer.svelte')).default;

const VIEWPORT = { width: 1920, height: 1080 };

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
  measured.length = 0;
});

function paragraph(id: string, start: number): StageRenderDocument['blocks'][number] {
  const tokenIndexes = Array.from({ length: 16 }, (_, i) => start + i);
  return {
    id,
    kind: 'paragraph',
    spoken: true,
    startTokenIndex: start,
    endTokenIndex: start + 15,
    renderNodes: [{ type: 'text', text: tokenIndexes.map(() => 'word').join(' '), tokenIndexes }],
    layoutHints: {},
    source: { utf16Start: 0, utf16End: 0 },
  };
}

const doc: StageRenderDocument = {
  schemaVersion: 1,
  title: 'Screenshot',
  blocks: [
    paragraph('p1', 0),
    {
      id: 'img',
      kind: 'image',
      spoken: false,
      renderNodes: [],
      layoutHints: {},
      source: { utf16Start: 0, utf16End: 0 },
    },
    paragraph('p2', 16),
  ],
  tokenToNode: Array.from({ length: 32 }, (_, tokenIndex) => ({
    tokenIndex,
    blockId: tokenIndex < 16 ? 'p1' : 'p2',
    nodeKey: '',
  })),
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

describe('ScriptLayer measures the auto-scroll pace off the words alone', () => {
  it('derives the scale with the measured block boxes, image and all', async () => {
    render(ScriptLayer, {
      props: {
        doc,
        settings,
        sessionId: 's',
        sessionGeneration: 1,
        stageGeneration: 1,
        scriptCompileHash: 'hash',
      },
    });
    // The map is built on a later frame than the first paint (§7.1).
    await vi.waitFor(() => expect(measured.some((entry) => entry.scale !== null)).toBe(true));

    const latest = measured.filter((entry) => entry.scale !== null).at(-1)!;
    // Every measured box, carrying the spoken tokens its compiled block owns —
    // the image none, each paragraph its sixteen.
    expect(latest.boxes.map((box) => [box.blockId, box.spokenTokens])).toEqual([
      ['p1', 16],
      ['img', 0],
      ['p2', 16],
    ]);
    // 264 px of text over 24 words, not 864 px of paper.
    expect(latest.scale?.pxPerWord).toBeCloseTo(11, 6);
    expect(latest.scale?.sampledWords).toBe(24);
  });
});
