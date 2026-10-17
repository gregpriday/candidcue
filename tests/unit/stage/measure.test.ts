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
  buildRenderedLineMap,
  maxPathDisagreementPx,
  measureStageLayout,
  medianLinePitch,
  rowStepsWithin,
  sameLayout,
  sectionIdsForBlocks,
  toDocumentRect,
  tokenFragmentRects,
  type FingerprintInput,
  type MeasuredTokenRect,
} from '../../../src/stage/motion';
import { fixtureFingerprint, syntheticLayout } from '../../fixtures/layout';

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
  inputOverrides: Partial<FingerprintInput> = {},
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

  /**
   * §practice. A rehearsal is reached from a per-take flag, not from a setting.
   *
   * `ScriptLayer` renders the whole document for a practice — the reference
   * table is the thing being rehearsed against — while `stageMode` and every
   * other declared input sit exactly where an ordinary take left them. Deriving
   * this field from the settings alone would call a full-height table and the
   * words REFER TO TABLE the same layout, replace the map under the old
   * generation and skip the §33 semantic re-anchor. So the renderer says which
   * projection it drew, and the derivation only stands in when nobody does.
   */
  it('takes the rendered projection from the caller when it is given one', () => {
    const take = fingerprint({}, 1, { performanceView: 'take' });
    const rehearsal = fingerprint({}, 1, { performanceView: 'rehearsal' });
    expect(take.performanceView).toBe('take');
    expect(rehearsal.performanceView).toBe('rehearsal');
    expect(sameLayout(take, rehearsal)).toBe(false);
  });

  it('falls back to the diagnostic stage mode when the caller says nothing', () => {
    expect(fingerprint().performanceView).toBe('take');
    expect(fingerprint({ stageMode: 'diagnostic' }).performanceView).toBe('rehearsal');
  });

  it('invalidates on a new script or stage generation', () => {
    const base = fingerprint();
    expect(sameLayout(base, { ...base, scriptCompileHash: 'hash-b' })).toBe(false);
    expect(sameLayout(base, { ...base, stageGeneration: 2 })).toBe(false);
    expect(sameLayout(base, null)).toBe(false);
  });
});

/**
 * `sameLayout()` answers "should the geometry have changed?" from the declared
 * inputs. `maxPathDisagreementPx()` answers "did it?" from the measurements.
 * The gap between those two questions is where a font file swapped under an
 * unchanged family id lives, and where a virtualized height estimate corrected
 * by a real measurement lives — both move every glyph after them with an
 * identical fingerprint, so the rebuild is classified coverage-only and the §33
 * re-anchor that would have hidden the shift never runs.
 */
describe('measured geometry drift (§7.2, §33)', () => {
  function mapFor(options: { wordWidthPx?: number; startY?: number; tokens?: number } = {}) {
    const layout = syntheticLayout({
      blocks: [
        { kind: 'paragraph', tokens: options.tokens ?? 90 },
        { kind: 'paragraph', tokens: options.tokens ?? 90 },
      ],
      columnWidthPx: 800,
      wordWidthPx: options.wordWidthPx ?? 90,
      startY: options.startY ?? 800,
    });
    return buildRenderedLineMap({
      fingerprint: fixtureFingerprint({ layoutGeneration: 1 }),
      tokens: layout.tokens,
      blocks: layout.blocks,
      readingLineStartY: 400,
      lineHeightPx: layout.lineHeightPx,
      viewportHeightPx: 1080,
      maxScrollPx: layout.contentHeightPx,
    });
  }

  it('reports zero for a map rebuilt from identical measurements', () => {
    expect(maxPathDisagreementPx(mapFor(), mapFor())).toBeLessThan(1e-6);
  });

  it('sees a whole-document shift a corrected height estimate would produce', () => {
    // Every block after the corrected one moves by the correction.
    const shifted = mapFor({ startY: 860 });
    expect(maxPathDisagreementPx(mapFor(), shifted)).toBeGreaterThan(50);
  });

  it('sees a re-wrap a font file swap would produce under the same family', () => {
    // Wider glyphs at the same family id and size: different line breaks, so
    // the unit → scroll path moves even though nothing in the fingerprint did.
    const wider = mapFor({ wordWidthPx: 130 });
    expect(maxPathDisagreementPx(mapFor(), wider)).toBeGreaterThan(1);
  });

  it('does not call a coverage-only rebuild a disagreement', () => {
    // The overlap is what is compared: a map that simply measured MORE of the
    // document — virtualization scrolled and another block came into the
    // window — agrees with the old one everywhere the old one knew about.
    const layout = syntheticLayout({
      blocks: [
        { kind: 'paragraph', tokens: 90 },
        { kind: 'paragraph', tokens: 90 },
      ],
      columnWidthPx: 800,
      startY: 800,
    });
    const build = (tokenCount: number) =>
      buildRenderedLineMap({
        fingerprint: fixtureFingerprint({ layoutGeneration: 1 }),
        tokens: layout.tokens.slice(0, tokenCount),
        blocks: layout.blocks,
        readingLineStartY: 400,
        lineHeightPx: layout.lineHeightPx,
        viewportHeightPx: 1080,
        // Identical bounds: only the measured COVERAGE differs.
        maxScrollPx: layout.contentHeightPx,
      });
    expect(maxPathDisagreementPx(build(70), build(layout.tokens.length))).toBeLessThan(1);
  });

  it('refuses to compare when either side has no path', () => {
    expect(maxPathDisagreementPx(null, mapFor())).toBe(Number.POSITIVE_INFINITY);
    expect(maxPathDisagreementPx(mapFor(), null)).toBe(Number.POSITIVE_INFINITY);
    expect(
      maxPathDisagreementPx({ motionKnots: [], sampleMotionPath: () => null }, mapFor()),
    ).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('a word broken across rows (#281)', () => {
  /*
   * The column breaks a word wider than itself inside its one span, so a
   * token can now be drawn on several rows. The map anchors it on the row it
   * starts on; these pin what that does to the measured pitch, and where a
   * caller asking for the token's position looks.
   */
  const P = 84;
  function token(tokenIndex: number, row: number): MeasuredTokenRect {
    return { tokenIndex, blockId: 'b1', xStart: 0, xEnd: 100, topY: row * P, bottomY: row * P + 60 };
  }
  function drawnOn(...rows: number[]): number[] {
    return rows.map((row) => row * P);
  }

  it('counts each row inside a broken word as one step', () => {
    expect(rowStepsWithin(drawnOn(0, 1, 2))).toEqual([P, P]);
    // Fragment order is not a promise the caller has to keep.
    expect(rowStepsWithin(drawnOn(2, 0, 1))).toEqual([P, P]);
  });

  it('adds nothing for a word on one row, or two fragments sharing a row', () => {
    expect(rowStepsWithin([0])).toEqual([]);
    expect(rowStepsWithin([P, P + 0.5])).toEqual([]);
  });

  it('keeps a script of broken words from measuring its pitch as several rows', () => {
    // A three-row word on rows 0-2, then ordinary words on rows 3 and 4. Start
    // to start that is 3P then P, and the upper median of two is the outlier: a
    // pitch of 3P makes the grouping tolerance (0.35 of it) wider than a real
    // row, and rows 3 and 4 would be built as one line.
    const word = token(0, 0);
    const tokens = [word, token(1, 3), token(2, 4)];
    expect(medianLinePitch(tokens, 70)).toBe(3 * P);
    expect(medianLinePitch(tokens, 70, new Map([[word, drawnOn(0, 1, 2)]]))).toBe(P);
  });

  it('measures the step after a broken word from its last row, not its first', () => {
    // Two rows, then one more word: the step OVER the word is not a sample.
    // Counting it beside the word's own step would leave [2P, P], whose upper
    // median is still the outlier.
    const word = token(0, 0);
    const tokens = [word, token(1, 2)];
    expect(medianLinePitch(tokens, 70, new Map([[word, drawnOn(0, 1)]]))).toBe(P);
    // A word that ends mid-row with the next one beside it adds no step at all.
    const ending = token(0, 0);
    const beside = [ending, token(1, 1), token(2, 2)];
    expect(medianLinePitch(beside, 70, new Map([[ending, drawnOn(0, 1)]]))).toBe(P);
  });

  it('measures a script with no broken word exactly as before', () => {
    const tokens = [token(0, 0), token(1, 1), token(2, 3), token(3, 4)];
    expect(medianLinePitch(tokens, 70, new Map())).toBe(medianLinePitch(tokens, 70));
    // ...and falls back to the typographic line with no row step to measure.
    expect(medianLinePitch([token(0, 0)], 70)).toBe(70);
  });

  /**
   * A plane whose words are drawn on the given rows, measured through the real
   * `measureStageLayout` — a Range reports a word's rows only once it has been
   * pointed at that word, as a real one does.
   */
  function planeOf(words: number[][], options: { emptyRowAt?: number } = {}): HTMLElement {
    const rect = (row: number, width = 100) => ({
      top: row * P,
      bottom: row * P + 60,
      left: 0,
      right: width,
      width,
      height: 60,
    });
    const blockEl = {
      dataset: { blockId: 'b1' },
      getBoundingClientRect: () => ({ top: 0, bottom: 10 * P, left: 0, right: 800 }),
    };
    const wordEls = words.map((rows, i) => ({
      dataset: { t: String(i) },
      rows,
      closest: () => blockEl,
      getBoundingClientRect: () => rect(rows[0]!),
    }));
    return {
      getBoundingClientRect: () => ({ top: 0, bottom: 10 * P, left: 0, right: 800 }),
      querySelectorAll: (selector: string) => (selector === '[data-block-id]' ? [blockEl] : wordEls),
      ownerDocument: {
        createRange: () => {
          let selected: (typeof wordEls)[number] | null = null;
          return {
            selectNodeContents: (el: (typeof wordEls)[number]) => {
              selected = el;
            },
            getClientRects: () => {
              if (!selected) return [];
              const drawn = selected.rows.map((row) => rect(row));
              // A collapsed fragment on another row: nothing is drawn there.
              if (options.emptyRowAt !== undefined && selected.rows.length > 1) {
                drawn.push(rect(options.emptyRowAt, 0));
              }
              return drawn;
            },
            detach() {},
          };
        },
      },
    } as unknown as HTMLElement;
  }

  it('measures a broken word as the rows it is drawn on, anchored on the first', () => {
    const measured = measureStageLayout({
      plane: planeOf([[0, 1, 2], [3], [4]]),
      blocks: [block('b1', 'paragraph')],
      fallbackLineHeightPx: 70,
    });
    expect(measured.lineHeightPx).toBe(P);
    // One anchor per token, on the row it starts on: the break is not a token.
    expect(measured.tokens.map((t) => t.topY)).toEqual([0, 3 * P, 4 * P]);
  });

  it('ignores an empty fragment on a row the word is not drawn on', () => {
    const measured = measureStageLayout({
      plane: planeOf([[0, 1], [2], [3]], { emptyRowAt: 7 }),
      blocks: [block('b1', 'paragraph')],
      fallbackLineHeightPx: 70,
    });
    expect(measured.lineHeightPx).toBe(P);
  });

  it('places a token on the rows its text is drawn on, never on an empty fragment', () => {
    const rect = (top: number, width: number, height: number) => ({ top, width, height }) as DOMRect;
    const el = {} as Element;
    let selected: unknown = null;
    Object.assign(el, {
      ownerDocument: {
        createRange: () => ({
          selectNodeContents: (node: unknown) => {
            selected = node;
          },
          getClientRects: () =>
            selected === el
              ? [rect(0, 0, 20), rect(10, 50, 20), rect(40, 30, 0), rect(94, 30, 20)]
              : [],
          detach() {},
        }),
      },
    });
    expect(tokenFragmentRects(el).map((r) => r.top)).toEqual([10, 94]);
  });
});
