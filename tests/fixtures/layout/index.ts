/**
 * Synthetic rendered-layout fixtures (companion §68 layout corpus).
 *
 * The line-map builder is deliberately pure: it consumes measured rects, not a
 * DOM. These fixtures produce the rects a real layout would have produced —
 * wrapped paragraphs at a given column width, headings that open sections,
 * images that create vertical distance without spoken tokens — so the geometry
 * stack can be exercised in node across narrow/wide columns, large/small fonts,
 * and media-heavy documents.
 */
import type { LayoutFingerprint } from '../../../src/shared/contracts';
import type { MeasuredBlockBox, MeasuredTokenRect } from '../../../src/stage/motion';

export interface SyntheticBlockSpec {
  kind: 'paragraph' | 'heading' | 'image' | 'table';
  /** Spoken token count; visual blocks use 0. */
  tokens?: number;
  /** Override block height for visual blocks. */
  heightPx?: number;
}

export interface SyntheticLayoutOptions {
  blocks: SyntheticBlockSpec[];
  columnWidthPx?: number;
  wordWidthPx?: number;
  spaceWidthPx?: number;
  lineHeightPx?: number;
  glyphHeightPx?: number;
  paragraphGapPx?: number;
  startY?: number;
  /** Deterministic per-token width jitter, so lines do not all break evenly. */
  jitter?: number[];
}

export interface SyntheticLayout {
  tokens: MeasuredTokenRect[];
  blocks: MeasuredBlockBox[];
  lineHeightPx: number;
  contentHeightPx: number;
  tokenCount: number;
  /** Number of rendered lines the fixture laid out. */
  lineCount: number;
}

export function syntheticLayout(options: SyntheticLayoutOptions): SyntheticLayout {
  const columnWidthPx = options.columnWidthPx ?? 800;
  const wordWidthPx = options.wordWidthPx ?? 90;
  const spaceWidthPx = options.spaceWidthPx ?? 14;
  const lineHeightPx = options.lineHeightPx ?? 64;
  const glyphHeightPx = options.glyphHeightPx ?? Math.round(lineHeightPx * 0.75);
  const paragraphGapPx = options.paragraphGapPx ?? 44;
  const jitter = options.jitter ?? [0, 12, -8, 20, -14, 6];

  const tokens: MeasuredTokenRect[] = [];
  const blocks: MeasuredBlockBox[] = [];
  let y = options.startY ?? 0;
  let tokenIndex = 0;
  let sectionId = 'section:0';
  let lineCount = 0;

  options.blocks.forEach((spec, blockIndex) => {
    const blockId = `b${blockIndex}`;
    if (spec.kind === 'heading') sectionId = `section:${blockId}`;
    const blockTop = y;

    if (spec.kind === 'image' || spec.kind === 'table') {
      y += spec.heightPx ?? lineHeightPx * 6;
    } else {
      const count = spec.tokens ?? 0;
      let x = 0;
      let lineStarted = false;
      for (let i = 0; i < count; i++) {
        const width = Math.max(20, wordWidthPx + (jitter[tokenIndex % jitter.length] ?? 0));
        if (lineStarted && x + width > columnWidthPx) {
          x = 0;
          y += lineHeightPx;
          lineStarted = false;
        }
        if (!lineStarted) {
          lineCount++;
          lineStarted = true;
        }
        tokens.push({
          tokenIndex,
          blockId,
          xStart: x,
          xEnd: x + width,
          topY: y,
          bottomY: y + glyphHeightPx,
        });
        x += width + spaceWidthPx;
        tokenIndex++;
      }
      if (lineStarted) y += lineHeightPx;
    }

    blocks.push({
      blockId,
      sectionId,
      kind: spec.kind,
      spoken: spec.kind === 'paragraph' || spec.kind === 'heading',
      topY: blockTop,
      bottomY: y,
    });
    y += paragraphGapPx;
  });

  return {
    tokens,
    blocks,
    lineHeightPx,
    contentHeightPx: y,
    tokenCount: tokenIndex,
    lineCount,
  };
}

export function fixtureFingerprint(
  overrides: Partial<LayoutFingerprint> = {},
): LayoutFingerprint {
  return {
    scriptCompileHash: 'hash-a',
    stageGeneration: 1,
    layoutGeneration: 1,
    displayScaleFactor: 2,
    viewportWidthPx: 1920,
    viewportHeightPx: 1080,
    fontFamily: 'system-sans',
    fontSizePx: 64,
    lineHeight: 1.28,
    letterSpacingEm: 0,
    paragraphSpacingEm: 0.7,
    marginTopPx: 0,
    marginBottomPx: 0,
    marginHorizontalPx: 68,
    mirrored: false,
    mirrorX: false,
    mirrorY: false,
    readingBandCenterPercent: 38,
    readingBandHalfHeightPercent: 4,
    cueLayout: 'cues',
    performanceView: 'take',
    ...overrides,
  };
}

/** A small deterministic PRNG so fuzz tests are reproducible. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}
