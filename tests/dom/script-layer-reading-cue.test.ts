/**
 * The reading cue, the sentence microgap, and what the stage reports about the
 * face it drew — driven through the mounted script layer.
 *
 * ---------------------------------------------------------------------------
 * WHY THE COMPONENT AND NOT THE LEAVES
 * ---------------------------------------------------------------------------
 * `ReadingCue` had a full unit suite and was referenced by nothing. So did the
 * hold ladder, the calibration cards and the font measurer. A leaf component
 * cannot tell you whether anything mounts it, whether it is handed the geometry
 * it needs, or whether the thing it replaces was actually switched off — and
 * every one of those was the defect. These tests mount `ScriptLayer`.
 *
 * ---------------------------------------------------------------------------
 * BOUNDARY
 * ---------------------------------------------------------------------------
 * jsdom performs no layout: `Range.getClientRects()` is shimmed to return an
 * empty list (tests/dom/setup.ts) and every box measures zero. So nothing here
 * asserts on measured geometry — these are assertions about what is mounted,
 * what it is handed, and which elements carry which inline styles. The
 * per-line underlay's actual rectangles belong to the browser E2E layer, which
 * has a real engine.
 */
import { render } from '@testing-library/svelte';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import ScriptLayer from '../../src/stage/renderer/ScriptLayer.svelte';
import type {
  ReadingCueStyle,
  ResolvedOptics,
  StageRenderDocument,
  StageSettings,
} from '../../src/shared/contracts';

beforeAll(() => {
  (globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
    constructor(private cb: (entries: unknown[], self: unknown) => void) {}
    observe(target: Element): void {
      this.cb([{ target }], this);
    }
    unobserve(): void {}
    disconnect(): void {}
  };
  for (const [prop, value] of [
    ['clientWidth', 1024],
    ['clientHeight', 600],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => value });
  }
});

/*
 * Three paragraphs, chosen for their sentence structure:
 *
 *   b1  four sentences — long enough to earn internal sentence spacing;
 *   b2  two sentences  — a paragraph a reader holds in one glance;
 *   b3  three sentences, the first ending on a word with no punctuation, which
 *       is a segmentation artefact rather than a boundary anybody can see.
 */
const doc: StageRenderDocument = {
  schemaVersion: 1,
  title: 'Microgap',
  blocks: [
    {
      id: 'b1',
      kind: 'paragraph',
      spoken: true,
      startTokenIndex: 0,
      endTokenIndex: 7,
      renderNodes: [
        {
          type: 'text',
          text: 'Alpha one. Beta two. Gamma three. Delta four.',
          tokenIndexes: [0, 1, 2, 3, 4, 5, 6, 7],
        },
      ],
      layoutHints: {},
      source: { utf16Start: 0, utf16End: 45 },
    },
    {
      id: 'b2',
      kind: 'paragraph',
      spoken: true,
      startTokenIndex: 8,
      endTokenIndex: 11,
      renderNodes: [
        { type: 'text', text: 'Solo one. Solo two.', tokenIndexes: [8, 9, 10, 11] },
      ],
      layoutHints: {},
      source: { utf16Start: 0, utf16End: 19 },
    },
    {
      id: 'b3',
      kind: 'paragraph',
      spoken: true,
      startTokenIndex: 12,
      endTokenIndex: 17,
      renderNodes: [
        {
          type: 'text',
          text: 'alpha beta gamma delta. eps zeta.',
          tokenIndexes: [12, 13, 14, 15, 16, 17],
        },
      ],
      layoutHints: {},
      source: { utf16Start: 0, utf16End: 33 },
    },
  ],
  tokenToNode: Array.from({ length: 18 }, (_, tokenIndex) => ({
    tokenIndex,
    blockId: tokenIndex < 8 ? 'b1' : tokenIndex < 12 ? 'b2' : 'b3',
    nodeKey: '',
  })),
  assets: {},
  sentences: [
    { id: 's1', blockId: 'b1', startTokenIndex: 0, endTokenIndex: 1 },
    { id: 's2', blockId: 'b1', startTokenIndex: 2, endTokenIndex: 3 },
    { id: 's3', blockId: 'b1', startTokenIndex: 4, endTokenIndex: 5 },
    { id: 's4', blockId: 'b1', startTokenIndex: 6, endTokenIndex: 7 },
    { id: 's5', blockId: 'b2', startTokenIndex: 8, endTokenIndex: 9 },
    { id: 's6', blockId: 'b2', startTokenIndex: 10, endTokenIndex: 11 },
    { id: 's7', blockId: 'b3', startTokenIndex: 12, endTokenIndex: 13 },
    { id: 's8', blockId: 'b3', startTokenIndex: 14, endTokenIndex: 15 },
    { id: 's9', blockId: 'b3', startTokenIndex: 16, endTokenIndex: 17 },
  ],
} as unknown as StageRenderDocument;

function optics(overrides: Partial<ResolvedOptics> = {}): ResolvedOptics {
  return {
    schemaVersion: 1,
    safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
    opticalCenterX: 0.5,
    readingBandY: 0.38,
    deadZoneLines: 0.84,
    topFadeLines: 1.25,
    bottomFadeLines: 0.75,
    futureReserveLines: 3,
    sentenceMicrogapLines: 0.2,
    columnCh: 34,
    secondaryMinPx: 30,
    bodyFontSizePx: 62,
    lineHeight: 1.38,
    fontWeight: 500,
    letterSpacingEm: 0,
    paragraphSpacingEm: 0.7,
    pastOpacity: 0.48,
    futureOpacity: 0.92,
    calibrated: true,
    metricsMeasured: true,
    mmPerCssPx: 0.1926,
    viewingDistanceMm: 1200,
    bodyArcminutes: 24,
    charactersPerLine: 30,
    fitVerdict: 'width_limited',
    fitAdvice: '',
    overriddenFields: [],
    ...overrides,
  };
}

function settingsWith(overrides: Partial<StageSettings> = {}): StageSettings {
  return {
    schemaVersion: 1,
    themeId: 'stage-dark',
    background: '#000000',
    foreground: '#f5f3ef',
    fontFamilyId: 'system-sans',
    fontSizePx: 64,
    lineHeight: 1.32,
    letterSpacingEm: 0,
    columnWidthPercent: 68,
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
    optics: optics(),
    ...overrides,
  };
}

function mount(settings: StageSettings, extra: Record<string, unknown> = {}) {
  const onlayoutready = vi.fn();
  const result = render(ScriptLayer, {
    props: {
      doc,
      settings,
      onlayoutready,
      sessionId: 's',
      sessionGeneration: 1,
      stageGeneration: 1,
      scriptCompileHash: 'hash',
      ...extra,
    },
  });
  return { ...result, onlayoutready };
}

/** Let the measurement pass (rAF, then a 350 ms timer fallback) actually run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 420));
}

const gapOf = (container: HTMLElement, token: number): string =>
  (container.querySelector<HTMLElement>(`[data-t="${token}"]`)?.style.marginInlineEnd ?? '');

describe('the reading cue', () => {
  it('is drawn by default, on the band, outside the layer that scrolls', () => {
    const { container } = mount(settingsWith());
    const cue = container.querySelector('.cue');
    expect(cue, 'nothing marks the reading position').not.toBeNull();
    expect(cue?.classList.contains('ticks')).toBe(true);
    // The one mark on the glass that must NOT move: a child of the scroll plane
    // would travel with the script and stop marking the band the moment the
    // document moved.
    expect(cue?.closest('.scroll-plane'), 'the cue scrolls with the script').toBeNull();
  });

  it('follows the operator’s choice, including drawing nothing at all', () => {
    for (const [style, expected] of [
      ['ticks', 'ticks'],
      ['wash', 'wash'],
    ] as Array<[ReadingCueStyle, string]>) {
      const { container, unmount } = mount(settingsWith({ readingCue: style }));
      expect(container.querySelector('.cue')?.classList.contains(expected)).toBe(true);
      unmount();
    }

    const { container } = mount(settingsWith({ readingCue: 'none' }));
    expect(container.querySelector('.cue')).toBeNull();
  });

  it('goes hollow on the first rung of the hold ladder', async () => {
    // Solid → outline is the whole of the change: no pulse, no motion, no
    // colour. The presenter is mid-sentence and the cue's job at this moment is
    // to report without being looked at.
    const { container, rerender } = mount(settingsWith());
    expect(container.querySelector('.cue')?.getAttribute('data-hollow')).toBe('false');

    await rerender({
      doc,
      settings: settingsWith(),
      sessionId: 's',
      sessionGeneration: 1,
      stageGeneration: 1,
      scriptCompileHash: 'hash',
      cueHollow: true,
    });
    expect(container.querySelector('.cue')?.getAttribute('data-hollow')).toBe('true');
  });

  it('marks the band the rig resolved, measured inside the safe rectangle', () => {
    /*
     * The cue is the only element on the glass that says "your line is here",
     * so it has to name the same line the padding solver and the motion path
     * use. Drawing it from the flat `readingBandCenterPercent` while the engine
     * drives to the calibrated lens teaches the presenter the wrong line and
     * gives them no way to tell.
     *
     * These are arithmetic, not measurements: jsdom performs no layout, and the
     * stub above reports a 600px-tall layer.
     */
    const topOf = (c: HTMLElement): number =>
      parseFloat(c.querySelector<HTMLElement>('.tick')?.style.top ?? 'NaN');

    const { container: onLens } = mount(settingsWith({ optics: optics({ readingBandY: 0.62 }) }));
    expect(topOf(onLens)).toBeCloseTo(600 * 0.62, 3);

    // A hood crops the panel, and the band is a fraction of what is VISIBLE:
    // 120px of crop, then 38% of the 420px that is left.
    const { container: hooded } = mount(
      settingsWith({ optics: optics({ safeArea: { top: 0.2, right: 0, bottom: 0.1, left: 0 } }) }),
    );
    expect(topOf(hooded)).toBeCloseTo(120 + 420 * 0.38, 3);
  });

  it('is sized in cap heights of the rendered face, not in pixels', () => {
    // A fixed tick is a letter on a 15.6-inch panel at arm's length and a speck
    // on a 9-inch one calibrated for two metres.
    const { container } = mount(settingsWith());
    const tick = container.querySelector<HTMLElement>('.tick');
    const small = tick?.style.height;

    const { container: bigger } = mount(
      settingsWith({ optics: optics({ bodyFontSizePx: 124 }) }),
    );
    const large = bigger.querySelector<HTMLElement>('.tick')?.style.height;

    expect(small).toBeTruthy();
    expect(large).toBeTruthy();
    expect(parseFloat(large ?? '0')).toBeCloseTo(parseFloat(small ?? '0') * 2, 1);
  });
});

describe('the phrase underlay it replaces', () => {
  it('is not drawn on a rig using the default cue, whatever its opacity says', () => {
    /*
     * `currentUnderlayOpacity` ships at 0.1 from control, so leaving the old
     * path gated on that alone would have drawn BOTH marks on every default
     * rig. The underlay survives only for the presenter who chose the loud cue
     * and left phrase highlighting on.
     */
    const { container } = mount(settingsWith({ readingCue: 'ticks', currentUnderlayOpacity: 0.4 }));
    expect(container.querySelectorAll('.phrase-underlay')).toHaveLength(0);
  });

  it('is off when phrase highlighting is off, even with the loud cue', () => {
    const { container } = mount(settingsWith({ readingCue: 'wash', currentUnderlayOpacity: 0 }));
    expect(container.querySelectorAll('.phrase-underlay')).toHaveLength(0);
  });
});

describe('the sentence microgap', () => {
  it('spaces sentence boundaries inside a long paragraph', async () => {
    const { container } = mount(settingsWith());
    await settle();

    // 0.2 line pitches at 62px × 1.38.
    const expected = `${(0.2 * 62 * 1.38).toFixed(2)}px`;
    for (const token of [1, 3, 5]) {
      expect(gapOf(container, token), `token ${token} has no microgap`).toBe(expected);
    }
    // Not after the closing sentence: that gap would only pad the block's own
    // bottom margin, where the paragraph gap already is.
    expect(gapOf(container, 7)).toBe('');
  });

  it('leaves a short paragraph alone', async () => {
    // Two sentences are read as one thought, and the block boundary is close
    // enough to orient by. Spacing them would make an ordinary paragraph look
    // broken.
    const { container } = mount(settingsWith());
    await settle();
    for (const token of [8, 9, 10, 11]) {
      expect(gapOf(container, token), `token ${token} was spaced`).toBe('');
    }
  });

  it('only follows punctuation a reader can see', async () => {
    // A span that ends on a word rather than a full stop is a segmentation
    // artefact; spacing after it puts a hole in the middle of a clause.
    const { container } = mount(settingsWith());
    await settle();
    expect(gapOf(container, 13), 'spaced after a word with no punctuation').toBe('');
    expect(gapOf(container, 15)).not.toBe('');
  });

  it('is absent on a rig that has never been calibrated', async () => {
    const { container } = mount(settingsWith({ optics: undefined }));
    await settle();
    for (const token of [1, 3, 5]) expect(gapOf(container, token)).toBe('');
  });

  it('is removed again when it is turned off', async () => {
    /*
     * It moves glyphs, so turning it off is a relayout — and the inline styles
     * it wrote have to come back off the spans, or the setting would only ever
     * apply in one direction.
     */
    const { container, rerender } = mount(settingsWith());
    await settle();
    expect(gapOf(container, 1)).not.toBe('');

    await rerender({
      doc,
      settings: settingsWith({ optics: optics({ sentenceMicrogapLines: 0 }) }),
      sessionId: 's',
      sessionGeneration: 1,
      stageGeneration: 1,
      scriptCompileHash: 'hash',
    });
    await settle();
    expect(gapOf(container, 1)).toBe('');
  });

  it('is classified as a relayout, not as the same layout measured again', async () => {
    /*
     * The failure this guards is the one the layout fingerprint exists to
     * prevent: an input that moves glyphs but is not recognised as a layout
     * change gets the map replaced under the OLD generation, so the §33 semantic
     * re-anchor never runs and the text jumps under the presenter instead of
     * holding its place in the script.
     */
    const onlayoutgeneration = vi.fn();
    const { rerender } = mount(settingsWith(), { onlayoutgeneration });
    await settle();
    const before = onlayoutgeneration.mock.calls.length;

    await rerender({
      doc,
      settings: settingsWith({ optics: optics({ sentenceMicrogapLines: 0.6 }) }),
      onlayoutgeneration,
      sessionId: 's',
      sessionGeneration: 1,
      stageGeneration: 1,
      scriptCompileHash: 'hash',
    });
    await settle();

    expect(onlayoutgeneration.mock.calls.length).toBeGreaterThan(before);
  });
});

describe('what the stage reports about the face it drew', () => {
  it('hands the measurement out with the layout-ready handshake', async () => {
    /*
     * Control resolves geometry against DIN fallbacks because control does not
     * render the font; only the window that paints it can measure it. The
     * measurement travels with the handshake so the calibration screen can say
     * whether it is describing this rig or a plausible average of every rig.
     */
    const { onlayoutready } = mount(settingsWith());
    await settle();

    expect(onlayoutready).toHaveBeenCalled();
    const measurement = onlayoutready.mock.calls[0]?.[0];
    expect(measurement).toBeDefined();
    expect(typeof measurement.fontMetrics.capHeightRatio).toBe('number');
    // jsdom has no canvas, so the honest answer here is the DIN estimate — and
    // saying so is the point of the flag.
    expect(measurement.fontMetrics.measured).toBe(false);
    expect(typeof measurement.linePitchMeasured).toBe('boolean');
  });
});
