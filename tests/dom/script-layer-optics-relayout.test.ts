/**
 * A calibrated layout change must be seen AS a layout change.
 *
 * ---------------------------------------------------------------------------
 * THE BUG THIS PINS
 * ---------------------------------------------------------------------------
 * `layoutInputs()` decides when to rebuild the line map; `buildLayoutFingerprint`
 * decides whether the rebuilt map describes a NEW layout or the same one seen
 * more completely. The two have to agree, and the codebase already carries a
 * long warning about what happens when they do not: the map is silently
 * replaced under the old generation, `onlayoutgeneration` never fires, and the
 * §33 semantic re-anchor is skipped — so the text jumps under the presenter
 * instead of holding its place in the script.
 *
 * The optical layer reintroduced exactly that, from a direction the existing
 * guard could not see. Both functions read the FLAT `StageSettings` fields, and
 * on a calibrated rig the geometry lives in `settings.optics` instead. Moving
 * the calibrated column re-wraps every line while `columnWidthPercent` sits
 * unchanged, so both sides reported "identical layout" about two layouts that
 * were not.
 *
 * These tests drive the component the way the bug arrives — a second value of a
 * prop — because that is the only place the wiring exists. The projection
 * itself is ordinary object arithmetic and would pass a unit test while the
 * component still read the wrong fields.
 */
import { render } from '@testing-library/svelte';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import ScriptLayer from '../../src/stage/renderer/ScriptLayer.svelte';
import type {
  ResolvedOptics,
  StageRenderDocument,
  StageSettings,
} from '../../src/shared/contracts';

beforeAll(() => {
  // jsdom has no ResizeObserver, and the layer binds clientWidth/clientHeight
  // through one. Same shim the sibling ScriptLayer suites install.
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

const doc: StageRenderDocument = {
  schemaVersion: 1,
  title: 'Relayout',
  blocks: [
    {
      id: 'b1',
      kind: 'paragraph',
      spoken: true,
      startTokenIndex: 0,
      endTokenIndex: 5,
      renderNodes: [
        {
          type: 'text',
          text: 'one two three four five six',
          tokenIndexes: [0, 1, 2, 3, 4, 5],
        },
      ],
      layoutHints: {},
      source: { utf16Start: 0, utf16End: 27 },
    },
  ],
  tokenToNode: [0, 1, 2, 3, 4, 5].map((tokenIndex) => ({
    tokenIndex,
    blockId: 'b1',
    nodeKey: '',
  })),
  assets: {},
  sentences: [],
};

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

function settingsWith(o: ResolvedOptics | undefined): StageSettings {
  return {
    schemaVersion: 1,
    themeId: 'stage-dark',
    background: '#000000',
    foreground: '#f5f3ef',
    fontFamilyId: 'system-sans',
    // Deliberately CONSTANT across every case below. On a calibrated rig these
    // are not what is rendered, and the bug was that they are what was read.
    fontSizePx: 64,
    lineHeight: 1.32,
    letterSpacingEm: 0,
    columnWidthPercent: 68,
    readingBandCenterPercent: 38,
    readingBandHalfHeightPercent: 4,
    pastOpacity: 0.42,
    futureOpacity: 0.92,
    currentUnderlayOpacity: 0,
    mirrorX: false,
    mirrorY: false,
    showCues: true,
    stageAcknowledgements: true,
    reducedMotion: false,
    paragraphSpacingEm: 0.7,
    ...(o ? { optics: o } : {}),
  };
}

function mount(o: ResolvedOptics | undefined) {
  const onlayoutgeneration = vi.fn();
  const result = render(ScriptLayer, {
    props: {
      doc,
      settings: settingsWith(o),
      onlayoutgeneration,
      sessionId: 's',
      sessionGeneration: 1,
      stageGeneration: 1,
      scriptCompileHash: 'hash',
    },
  });
  return { ...result, onlayoutgeneration };
}

/** Let the scheduled rebuild (rAF + a timer fallback) actually run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

describe('a calibrated geometry change', () => {
  it('is classified as a new layout when only the column moves', async () => {
    /*
     * The exact shape of the bug. Nothing in the flat settings changes — only
     * `optics.columnCh` — but every line re-wraps, so this MUST bump the layout
     * generation. Before the fix it bumped nothing at all.
     */
    const { onlayoutgeneration, rerender } = mount(optics({ columnCh: 34 }));
    await settle();
    const before = onlayoutgeneration.mock.calls.length;

    await rerender({
      doc,
      settings: settingsWith(optics({ columnCh: 22 })),
      onlayoutgeneration,
      sessionId: 's',
      sessionGeneration: 1,
      stageGeneration: 1,
      scriptCompileHash: 'hash',
    });
    await settle();

    expect(onlayoutgeneration.mock.calls.length).toBeGreaterThan(before);
  });

  /*
   * Weaker than the case above, and deliberately kept anyway.
   *
   * A body-size change also moves the derived padding, and padding IS in the
   * fingerprint, so this passes even with the projection removed — it does not
   * pin the fix. It pins the OUTCOME, which is what a reader of this file
   * actually cares about, and it would catch a future change that stopped
   * feeding padding into the fingerprint. The column case above is the one that
   * is mutation-sensitive to the projection itself.
   */
  it('is classified as a new layout when only the body size moves', async () => {
    const { onlayoutgeneration, rerender } = mount(optics({ bodyFontSizePx: 62 }));
    await settle();
    const before = onlayoutgeneration.mock.calls.length;

    await rerender({
      doc,
      settings: settingsWith(optics({ bodyFontSizePx: 96 })),
      onlayoutgeneration,
      sessionId: 's',
      sessionGeneration: 1,
      stageGeneration: 1,
      scriptCompileHash: 'hash',
    });
    await settle();

    expect(onlayoutgeneration.mock.calls.length).toBeGreaterThan(before);
  });

  it('does not invent a relayout when nothing moved', async () => {
    // The other half of the contract. A rebuild that describes the same layout
    // must NOT bump the generation — a spurious bump costs a re-sync window
    // during which frames only coast.
    const { onlayoutgeneration, rerender } = mount(optics());
    await settle();
    const before = onlayoutgeneration.mock.calls.length;

    await rerender({
      doc,
      settings: settingsWith(optics()),
      onlayoutgeneration,
      sessionId: 's',
      sessionGeneration: 1,
      stageGeneration: 1,
      scriptCompileHash: 'hash',
    });
    await settle();

    expect(onlayoutgeneration.mock.calls.length).toBe(before);
  });
});

describe('the uncalibrated rig', () => {
  it('still reacts to the flat settings it has always used', async () => {
    // With no `optics`, the flat fields ARE the layout, and the historical
    // behaviour has to be untouched.
    const { onlayoutgeneration, rerender } = mount(undefined);
    await settle();
    const before = onlayoutgeneration.mock.calls.length;

    const bigger = { ...settingsWith(undefined), fontSizePx: 96 };
    await rerender({
      doc,
      settings: bigger,
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

describe('switching the performance projection', () => {
  /*
   * Block ids survive the projection — a table and the one-line chip replacing
   * it share a key — so the measured-height cache has to be emptied when the
   * projection changes. Off-window blocks are the damaging case: they are never
   * re-measured, so a stale six-line height stays in `maxScroll` and the
   * reverse transition can under-estimate the document enough that its closing
   * lines cannot be scrolled to.
   */
  it('is treated as a new layout, so heights are re-measured', async () => {
    const clean = settingsWith(optics());
    const { onlayoutgeneration, rerender } = mount(optics());
    await settle();
    const before = onlayoutgeneration.mock.calls.length;

    await rerender({
      doc,
      settings: { ...clean, stageMode: 'diagnostic' as const },
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
