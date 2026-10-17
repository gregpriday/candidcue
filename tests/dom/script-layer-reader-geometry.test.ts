/**
 * A reading window's geometry, driven through the mounted script layer.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PINS
 * ---------------------------------------------------------------------------
 * Three things the stage does with the column a reading window resolves for
 * itself, each one gated on reader mode, and each one paired with the prompter
 * case it must leave alone:
 *
 *  1. the column renders at the width the resolver computed — `ch` times the
 *     SAME zero advance the resolver divided by, not a hard-coded 0.55;
 *  2. the sentence microgap is sized off the default pitch, so a line-spacing
 *     choice cannot widen it;
 *  3. the reading ticks sit one cap height off the column rather than in the
 *     middle of a margin that grows with the window.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FONT MEASURER IS REPLACED
 * ---------------------------------------------------------------------------
 * jsdom has no canvas, so the real measurer returns the DIN fallbacks — whose
 * zero advance IS 0.55, which would make the first assertion here pass against
 * the very code it exists to catch. The stand-in reports the shipped face's
 * proportions (a "0" of about 0.653 em against 0.472 em of average prose) so
 * the two conversions disagree by the 18.7% the defect was worth.
 *
 * jsdom performs no layout, so everything here is arithmetic on inline styles.
 */
import { render } from '@testing-library/svelte';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import ScriptLayer from '../../src/stage/renderer/ScriptLayer.svelte';
import { defaultOpticalProfile, type OpticalProfile } from '../../src/shared/contracts/optical';
import type { ResolvedOptics, StageRenderDocument, StageSettings } from '../../src/shared/contracts';
import { DEFAULT_LINE_HEIGHT, resolveStageGeometry } from '../../src/shared/optical-resolve';
import { MAX_COLUMN_FRACTION, type FontMetrics } from '../../src/shared/optics';

const ATKINSON: FontMetrics = {
  capHeightRatio: 0.68,
  xHeightRatio: 0.5,
  avgCharWidthRatio: 0.472,
  zeroAdvanceRatio: 0.653,
  measured: true,
};

vi.mock('../../src/stage/renderer/fontMetrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/stage/renderer/fontMetrics')>();
  return { ...actual, measureFontMetrics: () => ({ ...ATKINSON }) };
});

let viewport = { width: 1240, height: 800 };

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

/* One paragraph of four sentences: long enough to earn the microgap. */
const doc: StageRenderDocument = {
  schemaVersion: 1,
  title: 'Reader geometry',
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
  ],
  tokenToNode: Array.from({ length: 8 }, (_, tokenIndex) => ({
    tokenIndex,
    blockId: 'b1',
    nodeKey: '',
  })),
  assets: {},
  sentences: [
    { id: 's1', blockId: 'b1', startTokenIndex: 0, endTokenIndex: 1 },
    { id: 's2', blockId: 'b1', startTokenIndex: 2, endTokenIndex: 3 },
    { id: 's3', blockId: 'b1', startTokenIndex: 4, endTokenIndex: 5 },
    { id: 's4', blockId: 'b1', startTokenIndex: 6, endTokenIndex: 7 },
  ],
} as unknown as StageRenderDocument;

/** The reading rig an ordinary display gets: no scale, so uncalibrated. */
function readerProfile(overrides: OpticalProfile['overrides'] = {}): OpticalProfile {
  return { ...defaultOpticalProfile(), lensPlacement: 'none', overrides };
}

/** A prompter's envelope optics, as control resolves them — DIN, not measured. */
function prompterOptics(overrides: Partial<ResolvedOptics> = {}): ResolvedOptics {
  return {
    schemaVersion: 1,
    safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
    opticalCenterX: 0.5,
    readingBandY: 0.38,
    lensPlacement: 'in-panel',
    deadZoneLines: 0.84,
    topFadeLines: 1.25,
    bottomFadeLines: 0.75,
    futureReserveLines: 3,
    sentenceMicrogapLines: 0.2,
    columnCh: 20,
    secondaryMinPx: 30,
    bodyFontSizePx: 62,
    lineHeight: 1.38,
    fontWeight: 500,
    letterSpacingEm: 0,
    paragraphSpacingEm: 0.7,
    pastOpacity: 0.48,
    futureOpacity: 0.92,
    calibrated: true,
    metricsMeasured: false,
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

function baseSettings(overrides: Partial<StageSettings> = {}): StageSettings {
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
    ...overrides,
  };
}

/**
 * A reading window as `stageSettingsFromSettings` builds one: the envelope's
 * optics were resolved against the whole PANEL, and the stage re-resolves
 * against its own window from the profile.
 */
function readerSettings(overrides: OpticalProfile['overrides'] = {}): StageSettings {
  const profile = readerProfile(overrides);
  const envelope = resolveStageGeometry({
    profile,
    viewport: { widthPx: 1728, heightPx: 1117 },
    readingContext: 'reader',
  }).optics;
  return baseSettings({ readingContext: 'reader', opticalProfile: profile, optics: envelope });
}

/** What the stage should have resolved for itself, at the current viewport. */
function stageResolve(overrides: OpticalProfile['overrides'] = {}): ResolvedOptics {
  return resolveStageGeometry({
    profile: readerProfile(overrides),
    metrics: ATKINSON,
    viewport: { widthPx: viewport.width, heightPx: viewport.height },
    readingContext: 'reader',
  }).optics;
}

function mount(settings: StageSettings) {
  return render(ScriptLayer, {
    props: {
      doc,
      settings,
      sessionId: 's',
      sessionGeneration: 1,
      stageGeneration: 1,
      scriptCompileHash: 'hash',
    },
  });
}

const px = (el: Element | null, prop: string): number =>
  el ? Number.parseFloat((el as HTMLElement).style.getPropertyValue(prop) || 'NaN') : Number.NaN;

/** Let the measurement pass (rAF, then a 350 ms timer fallback) actually run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 420));
}

const gapOf = (container: HTMLElement, token: number): string =>
  container.querySelector<HTMLElement>(`[data-t="${token}"]`)?.style.marginInlineEnd ?? '';

describe('the reading-window column', () => {
  it('renders at the width the resolver computed, with the measured zero advance', () => {
    for (const width of [760, 1240, 1440, 2560]) {
      viewport = { width, height: 800 };
      const resolved = stageResolve();
      const { container, unmount } = mount(readerSettings());
      const column = container.querySelector('.column');
      expect(px(column, 'width'), `${width}px window`).toBeCloseTo(
        resolved.columnCh * ATKINSON.zeroAdvanceRatio * resolved.bodyFontSizePx,
        3,
      );
      // And that width holds the measure the resolver reported — the readout
      // and the glass describe the same line.
      expect(
        px(column, 'width') / (ATKINSON.avgCharWidthRatio * resolved.bodyFontSizePx),
      ).toBeCloseTo(resolved.charactersPerLine!, 3);
      unmount();
    }
  });

  it('caps a wide window at the reading measure and fills a narrow one', () => {
    viewport = { width: 2560, height: 1440 };
    const wide = mount(readerSettings());
    const widePx = px(wide.container.querySelector('.column'), 'width');
    wide.unmount();
    // ~67 characters of 0.472 em at 30 px: under a thousand pixels, however
    // wide the window.
    expect(widePx).toBeLessThan(1000);
    expect(widePx / 2560).toBeLessThan(0.4);

    viewport = { width: 760, height: 800 };
    const narrow = mount(readerSettings());
    expect(px(narrow.container.querySelector('.column'), 'width')).toBeCloseTo(
      760 * MAX_COLUMN_FRACTION,
      3,
    );
  });

  it('keeps a prompter column at columnCh x 0.55 x font, whatever the face measured', () => {
    /*
     * The guard. Control resolves prompter geometry against the DIN fallbacks,
     * so 0.55 is the conversion that matches it — and the stand-in measurer here
     * reports 0.653, which an ungated change would apply, widening every
     * automatic and calibrated prompter column by about a fifth.
     */
    viewport = { width: 1024, height: 600 };
    const { container } = mount(baseSettings({ optics: prompterOptics() }));
    expect(px(container.querySelector('.column'), 'width')).toBeCloseTo(20 * 0.55 * 62, 3);
  });

  it('keeps a reading window with no profile on the envelope column, at 0.55', () => {
    // No profile means no stage-side resolve, so the column is the envelope's,
    // which control resolved at the fallback zero advance.
    viewport = { width: 1024, height: 600 };
    const { container } = mount(
      baseSettings({ readingContext: 'reader', optics: prompterOptics() }),
    );
    expect(px(container.querySelector('.column'), 'width')).toBeCloseTo(20 * 0.55 * 62, 3);
  });
});

describe('the reading-window microgap', () => {
  it('is today’s value at the default line height', async () => {
    viewport = { width: 1240, height: 800 };
    const resolved = stageResolve();
    const { container } = mount(readerSettings());
    await settle();
    const expected = `${(0.2 * resolved.bodyFontSizePx * DEFAULT_LINE_HEIGHT).toFixed(2)}px`;
    expect(gapOf(container, 1)).toBe(expected);
  });

  it('does not move when the reader changes the line spacing', async () => {
    viewport = { width: 1240, height: 800 };
    const resolved = stageResolve({ lineHeight: 1.8 });
    expect(resolved.lineHeight).toBe(1.8);
    const { container } = mount(readerSettings({ lineHeight: 1.8 }));
    await settle();
    // Sized off the default pitch, not 1.8: spacing is a vertical choice.
    const expected = `${(0.2 * resolved.bodyFontSizePx * DEFAULT_LINE_HEIGHT).toFixed(2)}px`;
    expect(gapOf(container, 1)).toBe(expected);
    expect((container.querySelector('.column') as HTMLElement).style.lineHeight).toBe('1.8');
  });

  it('still follows the line pitch on a prompter', async () => {
    viewport = { width: 1024, height: 600 };
    const { container } = mount(baseSettings({ optics: prompterOptics({ lineHeight: 1.6 }) }));
    await settle();
    expect(gapOf(container, 1)).toBe(`${(0.2 * 62 * 1.6).toFixed(2)}px`);
  });
});

describe('the reading-window ticks', () => {
  const ticks = (container: HTMLElement): HTMLElement[] =>
    Array.from(container.querySelectorAll<HTMLElement>('.cue.ticks .tick'));
  /*
   * jsdom evaluates the left tick's `max(0px, Npx)` down to `calc(Npx)`, so it
   * is read as the last pixel length in whatever form survived. The right tick's
   * clamp is against `100%`, which jsdom cannot evaluate at all — so a hugging
   * one is read from the custom property its clamp is applied to.
   */
  const leftPxOf = (el: HTMLElement | undefined): number => {
    const lengths = el?.style.getPropertyValue('left').match(/-?[\d.]+(?:e-?\d+)?px/g) ?? [];
    return Number.parseFloat(lengths.at(-1) ?? 'NaN');
  };
  const hugPxOf = (el: HTMLElement | undefined): number =>
    Number.parseFloat(el?.style.getPropertyValue('--hug-left') || 'NaN');

  it('sit one cap height off the column, on both sides, however wide the window', () => {
    for (const width of [1240, 2560]) {
      viewport = { width, height: 800 };
      const resolved = stageResolve();
      const { container, unmount } = mount(readerSettings());
      const columnWidth = resolved.columnCh * ATKINSON.zeroAdvanceRatio * resolved.bodyFontSizePx;
      const columnLeft = (width - columnWidth) / 2;
      const unit = resolved.bodyFontSizePx * ATKINSON.capHeightRatio;
      const tickWidth = (unit * 16) / 18;
      const [left, right] = ticks(container);

      // Inner edges one unit of air from the text, at both window widths — the
      // distance does not grow with the margin.
      expect(leftPxOf(left) + tickWidth, `${width}px left`).toBeCloseTo(columnLeft - unit, 3);
      expect(hugPxOf(right), `${width}px right`).toBeCloseTo(columnLeft + columnWidth + unit, 3);
      // And it is that property the clamp to the glass is applied to.
      expect(right?.style.getPropertyValue('left')).toBe(
        `min(var(--hug-left), calc(100% - ${tickWidth}px))`,
      );
      unmount();
    }
  });

  it('stays on the glass when the margin is narrower than the mark', () => {
    /*
     * 96 px type in a 760 px window: the column takes 76% and leaves 91 px a
     * side, against a mark that needs a 65 px cap of air plus its own 58 px.
     * The left clamp is visible here; the right one is the `min()` against
     * `100%` asserted above, which only a real layout engine can evaluate.
     */
    viewport = { width: 760, height: 800 };
    const { container } = mount(readerSettings({ fontSizePx: 96 }));
    const unit = 96 * ATKINSON.capHeightRatio;
    const tickWidth = (unit * 16) / 18;
    const [left, right] = ticks(container);
    expect(leftPxOf(left)).toBeCloseTo(0, 3);
    // Wanted past the edge, which is exactly why the clamp is there.
    expect(hugPxOf(right) + tickWidth).toBeGreaterThan(760);
  });

  it('keeps the prompter tick centred in its margin', () => {
    viewport = { width: 1024, height: 600 };
    const { container } = mount(baseSettings({ optics: prompterOptics() }));
    const [left, right] = ticks(container);
    const columnWidth = 20 * 0.55 * 62;
    const columnLeft = (1024 - columnWidth) / 2;
    // The cue is sized off this file's stand-in face, measured or not.
    const unit = 62 * ATKINSON.capHeightRatio;
    const tickWidth = (unit * 16) / 18;

    expect(leftPxOf(left)).toBeCloseTo(
      Math.min((columnLeft - tickWidth) / 2, columnLeft - unit * 0.5 - tickWidth),
      3,
    );
    // Centred, so well clear of where a hugging tick would sit.
    expect(leftPxOf(left)).toBeLessThan(columnLeft - unit - tickWidth - 10);
    // And the right one never takes the hugging placement.
    expect(right?.style.getPropertyValue('--hug-left')).toBe('');
  });
});
