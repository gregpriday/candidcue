/**
 * Layout fingerprinting and section identity (companion §7.2, §33).
 *
 * The DOM measurement pass itself needs a real layout engine (jsdom reports
 * zero-sized rects), so it is exercised through the stage preview; everything
 * pure about it is covered here.
 */
import { describe, it, expect } from 'vitest';
import type { CompiledBlock, StageSettings } from '../../../src/shared/contracts';
import {
  buildLayoutFingerprint,
  sameLayout,
  sectionIdsForBlocks,
  toDocumentRect,
} from '../../../src/stage/motion';

const settings: StageSettings = {
  schemaVersion: 1,
  themeId: 'stage-dark',
  background: '#000',
  foreground: '#fff',
  fontFamilyId: 'system-sans',
  fontSizePx: 64,
  lineHeight: 1.28,
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
};

function block(id: string, kind: CompiledBlock['kind']): CompiledBlock {
  return {
    id,
    kind,
    renderNodes: [],
    source: { utf16Start: 0, utf16End: 0 },
    spoken: kind === 'paragraph' || kind === 'heading',
  };
}

const BASE_INPUT = {
  scriptCompileHash: 'hash-a',
  stageGeneration: 1,
  layoutGeneration: 1,
  viewportWidthPx: 1920,
  viewportHeightPx: 1080,
  displayScaleFactor: 2,
  paddingTopPx: 300,
  paddingBottomPx: 400,
};

function fingerprint(
  overrides: Partial<StageSettings> = {},
  layoutGeneration = 1,
  inputOverrides: Partial<typeof BASE_INPUT> = {},
) {
  return buildLayoutFingerprint({
    ...BASE_INPUT,
    ...inputOverrides,
    layoutGeneration,
    settings: { ...settings, ...overrides },
  });
}

/**
 * H5. `getBoundingClientRect()` reports VIEWPORT-space rects, which include
 * every ancestor transform. The script sits inside the mirror plane (§16.7), so
 * under `scaleY(-1)` later lines have DECREASING tops: the builder sees an
 * inverted document, and mirror mode is a core teleprompter feature, not an edge
 * case. The measurement pass has to undo the flip.
 */
describe('mirror-plane coordinate compensation (§7.1, §16.7)', () => {
  // A 1000 px-tall plane at viewport y = 100..1100.
  const plane = { top: 100, bottom: 1100, left: 50, right: 850 };

  function flipped(rect: { top: number; bottom: number; left: number; right: number }) {
    // What the browser reports for this element under scale(-1, -1) about the
    // plane's centre: y -> C - y with C = plane.top + plane.bottom.
    const cy = plane.top + plane.bottom;
    const cx = plane.left + plane.right;
    return { top: cy - rect.bottom, bottom: cy - rect.top, left: cx - rect.right, right: cx - rect.left };
  }

  it('is the identity when nothing is mirrored', () => {
    const rect = { top: 300, bottom: 340, left: 90, right: 210 };
    expect(toDocumentRect(rect, plane, false, false)).toEqual({
      topY: 200,
      bottomY: 240,
      xStart: 40,
      xEnd: 160,
    });
  });

  it('recovers the untransformed offsets under a vertical mirror', () => {
    const rect = { top: 300, bottom: 340, left: 90, right: 210 };
    const measured = toDocumentRect(flipped(rect), plane, false, true);
    expect(measured.topY).toBeCloseTo(200, 9);
    expect(measured.bottomY).toBeCloseTo(240, 9);
  });

  it('recovers them under a horizontal mirror', () => {
    const rect = { top: 300, bottom: 340, left: 90, right: 210 };
    const measured = toDocumentRect(flipped(rect), plane, true, false);
    expect(measured.xStart).toBeCloseTo(40, 9);
    expect(measured.xEnd).toBeCloseTo(160, 9);
  });

  it('recovers both axes under scale(-1, -1)', () => {
    const rect = { top: 300, bottom: 340, left: 90, right: 210 };
    // The plane rect is itself flipped, but a full-bleed box maps onto itself.
    expect(toDocumentRect(flipped(rect), plane, true, true)).toEqual(
      toDocumentRect(rect, plane, false, false),
    );
  });

  it('keeps successive lines INCREASING under a vertical mirror', () => {
    // The property the line map actually depends on (§8.3). Without the
    // compensation this sequence decreases and the builder rejects the whole
    // measurement as inverted.
    const lines = [
      { top: 200, bottom: 240, left: 90, right: 400 },
      { top: 264, bottom: 304, left: 90, right: 380 },
      { top: 328, bottom: 368, left: 90, right: 420 },
    ];
    const measured = lines.map((l) => toDocumentRect(flipped(l), plane, false, true));
    for (let i = 1; i < measured.length; i++) {
      expect(measured[i]?.topY ?? 0).toBeGreaterThan(measured[i - 1]?.topY ?? 0);
      expect(measured[i]?.bottomY ?? 0).toBeGreaterThan(measured[i]?.topY ?? 0);
    }
    // And the pitch survives the flip exactly.
    expect((measured[1]?.topY ?? 0) - (measured[0]?.topY ?? 0)).toBeCloseTo(64, 9);
  });

  it('would produce a decreasing sequence if the flip were NOT compensated', () => {
    // The defect itself, stated as a test so the compensation cannot be dropped
    // without something failing.
    const lines = [
      { top: 200, bottom: 240, left: 90, right: 400 },
      { top: 264, bottom: 304, left: 90, right: 380 },
    ];
    const naive = lines.map((l) => flipped(l).top - plane.top);
    expect(naive[1] ?? 0).toBeLessThan(naive[0] ?? 0);
  });
});

describe('section identity (§7)', () => {
  it('opens a new section at every heading', () => {
    const blocks = [
      block('b0', 'paragraph'),
      block('b1', 'heading'),
      block('b2', 'paragraph'),
      block('b3', 'paragraph'),
      block('b4', 'heading'),
      block('b5', 'paragraph'),
    ];
    const sections = sectionIdsForBlocks(blocks);
    expect(sections.get('b0')).toBe('section:0');
    expect(sections.get('b1')).toBe('section:b1');
    expect(sections.get('b3')).toBe('section:b1');
    expect(sections.get('b5')).toBe('section:b4');
  });
});

describe('layout fingerprint (§7.2, §33)', () => {
  it('is stable for the same layout and ignores the generation counter', () => {
    expect(sameLayout(fingerprint(), fingerprint({}, 9))).toBe(true);
  });

  /**
   * H2. Every one of these MOVES A RENDERED GLYPH, so every one of them has to
   * invalidate the map. Letter spacing, paragraph spacing, the reading band and
   * the two mirror axes were all missing from the fingerprint: the rebuild was
   * scheduled, `sameLayout()` called the result identical, the generation was
   * never bumped and the §33 semantic recovery never ran — so the map changed
   * underneath a generation control still believed in.
   */
  it.each([
    ['font size', { fontSizePx: 72 }],
    ['line height', { lineHeight: 1.4 }],
    ['column width', { columnWidthPercent: 80 }],
    ['font family', { fontFamilyId: 'serif' }],
    ['mirror state', { mirrorX: true }],
    ['cue layout', { showCues: false }],
    ['letter spacing', { letterSpacingEm: 0.02 }],
    ['paragraph spacing', { paragraphSpacingEm: 1.1 }],
    ['reading-band centre', { readingBandCenterPercent: 55 }],
    ['reading-band half height', { readingBandHalfHeightPercent: 9 }],
    ['vertical mirror alone', { mirrorY: true }],
  ] as const)('invalidates on a %s change', (_name, overrides) => {
    expect(sameLayout(fingerprint(), fingerprint(overrides))).toBe(false);
  });

  it('distinguishes the two mirror axes, not just "mirrored"', () => {
    // Both are `mirrored: true`, but only the vertical one inverts measured
    // viewport-space tops — they are not the same layout (H5).
    const x = fingerprint({ mirrorX: true });
    const y = fingerprint({ mirrorY: true });
    expect(x.mirrored).toBe(true);
    expect(y.mirrored).toBe(true);
    expect(sameLayout(x, y)).toBe(false);
  });

  it('invalidates when the rendered padding changes (compact viewport)', () => {
    const roomy = fingerprint({}, 1, { paddingTopPx: 300, paddingBottomPx: 400 });
    const compact = fingerprint({}, 1, { paddingTopPx: 120, paddingBottomPx: 160 });
    expect(sameLayout(roomy, compact)).toBe(false);
    // The recorded margins are the real ones, not a hard-coded zero.
    expect(roomy.marginTopPx).toBe(300);
    expect(roomy.marginBottomPx).toBe(400);
  });

  it('invalidates on a viewport or scale-factor change', () => {
    const base = fingerprint();
    const resized = fingerprint({}, 1, { viewportWidthPx: 1280, viewportHeightPx: 720 });
    const rescaled = fingerprint({}, 1, { displayScaleFactor: 1.5 });
    expect(sameLayout(base, resized)).toBe(false);
    expect(sameLayout(base, rescaled)).toBe(false);
  });

  it('compares every field of the fingerprint except the generation counter', () => {
    // The guard against the omission this whole group exists for: walk the
    // fingerprint itself rather than a hand-maintained list, so a field added
    // to the contract but forgotten in `sameLayout` fails here as well as in
    // the compiler.
    const base = fingerprint();
    for (const key of Object.keys(base) as Array<keyof typeof base>) {
      const mutated = { ...base } as Record<string, unknown>;
      const value = base[key];
      mutated[key] =
        typeof value === 'number'
          ? value + 1
          : typeof value === 'boolean'
            ? !value
            : `${String(value)}-changed`;
      const same = sameLayout(base, mutated as unknown as typeof base);
      if (key === 'layoutGeneration') expect(same).toBe(true);
      else expect(same, `${key} must invalidate the map`).toBe(false);
    }
  });

  it('invalidates on a new script or stage generation', () => {
    const base = fingerprint();
    expect(sameLayout(base, { ...base, scriptCompileHash: 'hash-b' })).toBe(false);
    expect(sameLayout(base, { ...base, stageGeneration: 2 })).toBe(false);
    expect(sameLayout(base, null)).toBe(false);
  });
});
