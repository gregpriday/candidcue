/**
 * Layout measurement pass (companion §7.1, §7.2).
 *
 * "Do not infer line wrapping from character counts. The stage must measure the
 * rendered text." This module is the only place in the motion stack that
 * touches the DOM, and it runs only when layout changes — never inside the
 * frame loop (§63: no layout reads in the ordinary frame loop after map
 * creation).
 *
 * Token spans are measured with `Range.getClientRects()` over the rendered
 * `[data-t]` anchors that `InlineNodes` already emits, so measurement sees
 * exactly the typography, column width, and wrapping the presenter sees.
 */
import type { CompiledBlock, LayoutFingerprint, StageSettings } from '../../shared/contracts';
import type { MeasuredBlockBox, MeasuredTokenRect } from './lineMap';

export interface StageMeasurement {
  tokens: MeasuredTokenRect[];
  blocks: MeasuredBlockBox[];
  /** Median measured line pitch, px; falls back to the typographic line box. */
  lineHeightPx: number;
  /** Total measured content height, px. */
  contentHeightPx: number;
}

/**
 * Section identity per block: a heading opens a new section, everything after
 * it belongs to that section. Used for the `section` boundary kind and for the
 * conservative-location contract's section awareness.
 */
export function sectionIdsForBlocks(blocks: readonly CompiledBlock[]): Map<string, string> {
  const sections = new Map<string, string>();
  let current = 'section:0';
  for (const block of blocks) {
    if (block.kind === 'heading') current = `section:${block.id}`;
    sections.set(block.id, current);
  }
  return sections;
}

export interface MeasureStageOptions {
  /** The translated scroll plane; document coordinates are relative to it. */
  plane: HTMLElement;
  blocks: readonly CompiledBlock[];
  fallbackLineHeightPx: number;
}

/** Measure every rendered spoken token and block box in document coordinates. */
export function measureStageLayout(options: MeasureStageOptions): StageMeasurement {
  const { plane, blocks, fallbackLineHeightPx } = options;
  const planeTop = plane.getBoundingClientRect().top;
  const sections = sectionIdsForBlocks(blocks);
  const blockMeta = new Map(blocks.map((b) => [b.id, b]));

  const measuredBlocks: MeasuredBlockBox[] = [];
  let contentHeightPx = 0;
  for (const el of Array.from(plane.querySelectorAll<HTMLElement>('[data-block-id]'))) {
    const id = el.dataset.blockId;
    if (!id) continue;
    const meta = blockMeta.get(id);
    const rect = el.getBoundingClientRect();
    const topY = rect.top - planeTop;
    const bottomY = rect.bottom - planeTop;
    measuredBlocks.push({
      blockId: id,
      sectionId: sections.get(id) ?? 'section:0',
      kind: meta?.kind ?? 'paragraph',
      spoken: meta?.spoken ?? false,
      topY,
      bottomY,
    });
    contentHeightPx = Math.max(contentHeightPx, bottomY);
  }

  const tokens: MeasuredTokenRect[] = [];
  const range = plane.ownerDocument.createRange();
  for (const el of Array.from(plane.querySelectorAll<HTMLElement>('[data-t]'))) {
    const raw = el.dataset.t;
    if (raw === undefined) continue;
    const tokenIndex = Number.parseInt(raw, 10);
    if (!Number.isFinite(tokenIndex)) continue;
    const blockEl = el.closest<HTMLElement>('[data-block-id]');
    const blockId = blockEl?.dataset.blockId;
    if (!blockId) continue;

    range.selectNodeContents(el);
    const rects = range.getClientRects();
    // The first rect is where the token *starts*, which is the line it belongs
    // to even in the rare case of a word that wraps inside itself.
    const rect = rects.length > 0 ? rects[0] : el.getBoundingClientRect();
    // A zero-width rect means the token is not laid out (hidden block, empty
    // text run); it must not create a phantom line.
    if (!rect || rect.width <= 0) continue;
    tokens.push({
      tokenIndex,
      blockId,
      xStart: rect.left,
      xEnd: rect.right,
      topY: rect.top - planeTop,
      bottomY: rect.bottom - planeTop,
    });
  }
  range.detach?.();

  return {
    tokens,
    blocks: measuredBlocks,
    lineHeightPx: medianLinePitch(tokens, fallbackLineHeightPx),
    contentHeightPx,
  };
}

function medianLinePitch(tokens: readonly MeasuredTokenRect[], fallbackPx: number): number {
  const tops: number[] = [];
  let previousTop: number | null = null;
  for (const token of tokens) {
    if (previousTop === null || token.topY - previousTop > 1) {
      if (previousTop !== null) tops.push(token.topY - previousTop);
      previousTop = token.topY;
    }
  }
  const positive = tops.filter((d) => d > 1);
  if (positive.length === 0) return fallbackPx;
  positive.sort((a, b) => a - b);
  return positive[Math.floor(positive.length / 2)] ?? fallbackPx;
}

export interface FingerprintInput {
  scriptCompileHash: string;
  stageGeneration: number;
  layoutGeneration: number;
  settings: StageSettings;
  viewportWidthPx: number;
  viewportHeightPx: number;
  displayScaleFactor: number;
  listenerGeometryHash?: string;
  fontHash?: string;
}

/** Companion §7.2 — everything a map's validity depends on. */
export function buildLayoutFingerprint(input: FingerprintInput): LayoutFingerprint {
  const s = input.settings;
  return {
    scriptCompileHash: input.scriptCompileHash,
    stageGeneration: input.stageGeneration,
    layoutGeneration: input.layoutGeneration,
    displayScaleFactor: input.displayScaleFactor,
    viewportWidthPx: input.viewportWidthPx,
    viewportHeightPx: input.viewportHeightPx,
    fontFamily: s.fontFamilyId,
    fontHash: input.fontHash,
    fontSizePx: s.fontSizePx,
    lineHeight: s.lineHeight,
    marginTopPx: 0,
    marginBottomPx: 0,
    marginHorizontalPx: s.columnWidthPercent,
    mirrored: s.mirrorX || s.mirrorY,
    cueLayout: s.showCues ? 'cues' : 'none',
    listenerGeometryHash: input.listenerGeometryHash ?? 'none',
  };
}

/** True when two fingerprints describe the same layout (§33 invalidation). */
export function sameLayout(a: LayoutFingerprint | null, b: LayoutFingerprint | null): boolean {
  if (!a || !b) return false;
  return (
    a.scriptCompileHash === b.scriptCompileHash &&
    a.stageGeneration === b.stageGeneration &&
    a.displayScaleFactor === b.displayScaleFactor &&
    a.viewportWidthPx === b.viewportWidthPx &&
    a.viewportHeightPx === b.viewportHeightPx &&
    a.fontFamily === b.fontFamily &&
    a.fontHash === b.fontHash &&
    a.fontSizePx === b.fontSizePx &&
    a.lineHeight === b.lineHeight &&
    a.marginHorizontalPx === b.marginHorizontalPx &&
    a.mirrored === b.mirrored &&
    a.cueLayout === b.cueLayout &&
    a.listenerGeometryHash === b.listenerGeometryHash
  );
}

/**
 * Resolve once fonts and layout-affecting assets are final (§7.1). Images that
 * are still loading change line positions, so the map must wait for them.
 */
export async function awaitLayoutStable(root: ParentNode & { ownerDocument?: Document }): Promise<void> {
  const doc = (root as { ownerDocument?: Document }).ownerDocument ?? globalThis.document;
  const waits: Promise<unknown>[] = [];
  if (doc?.fonts?.ready) waits.push(doc.fonts.ready);
  for (const img of Array.from(root.querySelectorAll('img'))) {
    if (img.complete) continue;
    waits.push(
      new Promise<void>((resolve) => {
        img.addEventListener('load', () => resolve(), { once: true });
        img.addEventListener('error', () => resolve(), { once: true });
      }),
    );
  }
  await Promise.all(waits);
}
