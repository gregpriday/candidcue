/**
 * Windowed rendering for extremely long scripts (spec §51.3). Ordinary
 * scripts render every block for stable measured layout; above a block-count
 * threshold the stage renders only the window around the viewport plus
 * overscan, backed by a measured-or-estimated block-height map.
 * Pure logic — the component supplies measurements.
 */
import type { CompiledBlock } from '../../shared/contracts';

export const VIRTUALIZATION_BLOCK_THRESHOLD = 300;
export const DEFAULT_OVERSCAN_PX = 1600;

export function shouldVirtualize(blockCount: number): boolean {
  return blockCount > VIRTUALIZATION_BLOCK_THRESHOLD;
}

/**
 * Rough height estimate for a block that has not been measured yet. Only
 * used until the real measurement lands; accuracy matters less than
 * monotonic, stable offsets.
 */
export function estimateBlockHeightPx(
  block: CompiledBlock,
  fontSizePx: number,
  lineHeight: number,
  columnWidthPx: number,
): number {
  const linePx = fontSizePx * lineHeight;
  if (block.kind === 'divider') return Math.max(16, fontSizePx * 0.5);
  if (block.kind === 'image' || block.kind === 'diagram' || block.kind === 'table') {
    return linePx * 6;
  }
  let chars = 0;
  for (const node of block.renderNodes) {
    if (node.type === 'text') chars += node.text.length;
    else if (node.type === 'cue') chars += node.label.length + 4;
    else if (node.type === 'line_break') chars += 1;
  }
  // Average glyph advance ~0.52em for a legible sans at prompting sizes.
  const charsPerLine = Math.max(4, Math.floor(columnWidthPx / (fontSizePx * 0.52)));
  const lines = Math.max(1, Math.ceil(chars / charsPerLine));
  return lines * linePx;
}

/**
 * Cumulative start offsets in document space. Returns n + 1 entries; the
 * last entry is the total content height (excluding bottom padding).
 */
export function computeOffsets(
  heights: readonly number[],
  gapPx: number,
  leadingPadPx: number,
): number[] {
  const offsets: number[] = new Array(heights.length + 1);
  let y = leadingPadPx;
  for (let i = 0; i < heights.length; i++) {
    offsets[i] = y;
    y += (heights[i] ?? 0) + (i < heights.length - 1 ? gapPx : 0);
  }
  offsets[heights.length] = y;
  return offsets;
}

export interface RenderWindow {
  /** First rendered block index (inclusive). */
  startIndex: number;
  /** Last rendered block index (exclusive). */
  endIndex: number;
  /** Spacer height standing in for blocks above the window. */
  leadingSpacePx: number;
  /** Spacer height standing in for blocks below the window. */
  trailingSpacePx: number;
}

/**
 * Compute the rendered window for the current scroll position. `offsets`
 * comes from computeOffsets (n + 1 entries). The window covers
 * [scrollY - overscan, scrollY + viewport + overscan] in document space.
 */
export function computeWindow(
  offsets: readonly number[],
  scrollY: number,
  viewportHeightPx: number,
  overscanPx: number = DEFAULT_OVERSCAN_PX,
): RenderWindow {
  const count = offsets.length - 1;
  if (count <= 0) {
    return { startIndex: 0, endIndex: 0, leadingSpacePx: 0, trailingSpacePx: 0 };
  }
  const topEdge = scrollY - overscanPx;
  const bottomEdge = scrollY + viewportHeightPx + overscanPx;
  const contentStart = offsets[0] ?? 0;
  const total = offsets[count] ?? 0;

  // Binary search for the first block whose bottom is past topEdge.
  let lo = 0;
  let hi = count - 1;
  let start = count;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const blockBottom = offsets[mid + 1] ?? total;
    if (blockBottom > topEdge) {
      start = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (start >= count) {
    // Everything is above the window; render the last block to keep anchors.
    start = count - 1;
  }
  let end = start;
  while (end < count && (offsets[end] ?? total) < bottomEdge) {
    end++;
  }
  const leadingSpacePx = Math.max(0, (offsets[start] ?? contentStart) - contentStart);
  const trailingSpacePx = Math.max(0, total - (offsets[end] ?? total));
  return { startIndex: start, endIndex: end, leadingSpacePx, trailingSpacePx };
}

/**
 * Where to put the scroll plane so a given token is inside the rendered window
 * (CCUX-014).
 *
 * ---------------------------------------------------------------------------
 * WHY A SEED IS NEEDED AT ALL
 * ---------------------------------------------------------------------------
 * The window is computed from `scrollY`, and `scrollY` starts at zero. Above
 * the block threshold only that window is rendered, and the stage can only
 * MEASURE what it rendered — so a take asked to open part-way down a long
 * script found no measured token at its opening index, correctly refused to
 * place against a top-of-document map, and revealed at the top instead. The
 * guards were right; nothing had rendered the region being asked about.
 *
 * Estimated block offsets are enough to fix that: they only have to land the
 * window in the right region, after which the real measurement arrives and the
 * opening placement refines to the exact row.
 *
 * Returns null when there is nothing sensible to seed — a token at or before
 * the start, or a document whose blocks do not reach it — so the caller leaves
 * the scroll alone rather than jumping somewhere arbitrary.
 */
export function seedScrollForToken(
  blocks: readonly { startTokenIndex?: number; endTokenIndex?: number }[],
  offsets: readonly number[],
  tokenIndex: number,
  viewportHeightPx: number,
  maxScrollPx: number,
): number | null {
  if (!Number.isFinite(tokenIndex) || tokenIndex <= 0) return null;
  if (offsets.length === 0) return null;

  const index = blocks.findIndex((b) => {
    const end = b.endTokenIndex ?? b.startTokenIndex;
    return end !== undefined && end >= tokenIndex;
  });
  if (index < 0) return null;

  const at = offsets[index];
  if (at === undefined || !Number.isFinite(at)) return null;

  /*
   * Biased ABOVE the block by a third of a viewport, so the target row lands
   * inside the window rather than on its very edge — the overscan then covers
   * the rest. Landing it exactly at the top edge would put the row one
   * estimation error away from being outside the render again, and the estimate
   * is by construction approximate.
   */
  return Math.max(0, Math.min(at - viewportHeightPx / 3, Math.max(0, maxScrollPx)));
}
