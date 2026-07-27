/**
 * The uncalibrated stage still renders the pre-optical geometry, exactly.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS PINNED TO LITERALS
 * ---------------------------------------------------------------------------
 * The optical layer is supposed to be additive: somebody who has never opened
 * the calibration screen must get the stage they had before it existed. That
 * claim was made once already and was false — an early commit routed the
 * uncalibrated path through the new padding solver and line-relative fades, and
 * on a 1024x600 panel it moved bottom padding from 360px to 583px and the top
 * fade from 60px to 106px. Nothing failed, because every test that could have
 * noticed computed its expectation from the same code it was checking.
 *
 * So the numbers here are LITERAL, and deliberately so. They are transcribed
 * from the geometry this file shipped with — the §16.8 `vh` tables and the
 * <=700px compact breakpoint — and if a future change moves them, the right
 * response is almost always to fix the change rather than the test. The known
 * defect in the old table (the closing line stops just short of the reading
 * band) is preserved here ON PURPOSE: the correction ships to rigs that opted
 * into the optical model, not to everyone else's stage on upgrade.
 */
import { render } from '@testing-library/svelte';
import { beforeAll, describe, expect, it } from 'vitest';
import ScriptLayer from '../../src/stage/renderer/ScriptLayer.svelte';
import type { StageRenderDocument, StageSettings } from '../../src/shared/contracts';

/** The 9-inch Prompter, which is the panel the compact table existed for. */
const COMPACT = { width: 1024, height: 600 };
/** Anything taller took the non-compact table. */
const ROOMY = { width: 1920, height: 1080 };

let viewport = COMPACT;

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
    get: () => viewport.width,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => viewport.height,
  });
});

const doc: StageRenderDocument = {
  schemaVersion: 1,
  title: 'Parity',
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
  sentences: [],
};

/** Settings with NO `optics` — the shape every pre-optical document has. */
function uncalibrated(): StageSettings {
  return {
    schemaVersion: 1,
    themeId: 'stage-dark',
    background: '#000000',
    foreground: '#f5f3ef',
    fontFamilyId: 'system-sans',
    fontSizePx: 64,
    lineHeight: 1.32,
    letterSpacingEm: 0,
    columnWidthPercent: 78,
    readingBandCenterPercent: 38,
    readingBandHalfHeightPercent: 4,
    pastOpacity: 0.42,
    futureOpacity: 0.92,
    currentUnderlayOpacity: 0.1,
    mirrorX: false,
    mirrorY: false,
    showCues: true,
    stageAcknowledgements: true,
    reducedMotion: false,
    paragraphSpacingEm: 0.7,
  };
}

function mount(settings: StageSettings) {
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
  const px = (el: Element | null, prop: string): number =>
    el ? Number.parseFloat((el as HTMLElement).style.getPropertyValue(prop) || '0') : Number.NaN;
  return { ...result, px };
}

describe('the compact panel, 1024x600', () => {
  beforeAll(() => {
    viewport = COMPACT;
  });

  it('keeps the 34/60 vh padding table', () => {
    // 34% and 60% of 600px. The pair does not sum to 100 and that is the known
    // defect; preserving it is the point of this test.
    const { container, px } = mount(uncalibrated());
    const plane = container.querySelector('.scroll-plane');
    expect(px(plane, 'padding-top')).toBeCloseTo(204, 1);
    expect(px(plane, 'padding-bottom')).toBeCloseTo(360, 1);
  });

  it('keeps the reduced 10vh focus fades, equal at both edges', () => {
    // The asymmetry that favours upcoming context belongs to the optical model.
    // The old stage faded both edges the same, and so does this one.
    const { container, px } = mount(uncalibrated());
    const top = container.querySelector('.fade-top');
    const bottom = container.querySelector('.fade-bottom');
    expect(px(top, 'height')).toBeCloseTo(60, 1);
    expect(px(bottom, 'height')).toBeCloseTo(60, 1);
  });

  it('keeps the column at its percentage of the window', () => {
    // 78% of 1024px, centred — not a `ch` measure and not lens-relative.
    const { container, px } = mount(uncalibrated());
    const column = container.querySelector('.column');
    expect(px(column, 'width')).toBeCloseTo(798.72, 1);
  });

  it('renders the authored size and line height, not a resolved one', () => {
    const { container } = mount(uncalibrated());
    const column = container.querySelector('.column') as HTMLElement | null;
    expect(column?.style.fontSize).toBe('64px');
    expect(column?.style.lineHeight).toBe('1.32');
  });
});

describe('the roomy panel, 1920x1080', () => {
  beforeAll(() => {
    viewport = ROOMY;
  });

  it('keeps the 38/55 vh padding table', () => {
    const { container, px } = mount(uncalibrated());
    const plane = container.querySelector('.scroll-plane');
    expect(px(plane, 'padding-top')).toBeCloseTo(410.4, 1);
    expect(px(plane, 'padding-bottom')).toBeCloseTo(594, 1);
  });

  it('keeps the full 16vh focus fades', () => {
    const { container, px } = mount(uncalibrated());
    expect(px(container.querySelector('.fade-top'), 'height')).toBeCloseTo(172.8, 1);
    expect(px(container.querySelector('.fade-bottom'), 'height')).toBeCloseTo(172.8, 1);
  });

  it('still selects the table by the old breakpoint, not by line pitch', () => {
    /*
     * The compact breakpoint is <=700px tall AND <=1280px wide. It is gone from
     * the calibrated path — where the real question is how many line pitches fit
     * — but the uncalibrated path must keep choosing exactly as it did, or two
     * panels that used to get different tables would start getting the same one.
     */
    viewport = COMPACT;
    const compactPlane = mount(uncalibrated()).container.querySelector('.scroll-plane');
    viewport = ROOMY;
    const roomyPlane = mount(uncalibrated()).container.querySelector('.scroll-plane');

    const topFraction = (el: Element | null, height: number): number =>
      Number.parseFloat((el as HTMLElement).style.paddingTop) / height;
    expect(topFraction(compactPlane, COMPACT.height)).toBeCloseTo(0.34, 4);
    expect(topFraction(roomyPlane, ROOMY.height)).toBeCloseTo(0.38, 4);
  });
});
