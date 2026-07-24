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
  /**
   * Whether the plane is inside an active mirror transform (§16.7). MUST be
   * passed: `getBoundingClientRect()` reports VIEWPORT-space rects, which
   * include every ancestor transform, so under `scaleY(-1)` later lines have
   * DECREASING tops and the whole document measures upside down. Mirror mode is
   * a core teleprompter feature (glass rigs), not an edge case.
   */
  mirrorX?: boolean;
  mirrorY?: boolean;
}

/**
 * Convert a viewport-space rect into document coordinates relative to the
 * plane, undoing the mirror plane's flip.
 *
 * A flip about the mirror plane's centre maps viewport `y` to `C − y`, so under
 * a vertical mirror an element's measured `top` is the distance from the
 * plane's BOTTOM to the element's bottom. Reflecting both the element rect and
 * the plane rect through the same flip recovers the layout-space offset
 * exactly — `planeRect.bottom − rect.bottom` — with no dependency on where the
 * mirror's centre actually is. The same argument applies per-axis, so a
 * `scale(-1, -1)` plane is handled by composing the two independent cases.
 */
export function toDocumentRect(
  rect: { top: number; bottom: number; left: number; right: number },
  plane: { top: number; bottom: number; left: number; right: number },
  mirrorX: boolean,
  mirrorY: boolean,
): { topY: number; bottomY: number; xStart: number; xEnd: number } {
  const topY = mirrorY ? plane.bottom - rect.bottom : rect.top - plane.top;
  const bottomY = mirrorY ? plane.bottom - rect.top : rect.bottom - plane.top;
  const xStart = mirrorX ? plane.right - rect.right : rect.left - plane.left;
  const xEnd = mirrorX ? plane.right - rect.left : rect.right - plane.left;
  return { topY, bottomY, xStart, xEnd };
}

/** Measure every rendered spoken token and block box in document coordinates. */
export function measureStageLayout(options: MeasureStageOptions): StageMeasurement {
  const { plane, blocks, fallbackLineHeightPx } = options;
  const mirrorX = options.mirrorX === true;
  const mirrorY = options.mirrorY === true;
  const planeRect = plane.getBoundingClientRect();
  const sections = sectionIdsForBlocks(blocks);
  const blockMeta = new Map(blocks.map((b) => [b.id, b]));

  const measuredBlocks: MeasuredBlockBox[] = [];
  let contentHeightPx = 0;
  for (const el of Array.from(plane.querySelectorAll<HTMLElement>('[data-block-id]'))) {
    const id = el.dataset.blockId;
    if (!id) continue;
    const meta = blockMeta.get(id);
    const { topY, bottomY } = toDocumentRect(
      el.getBoundingClientRect(),
      planeRect,
      mirrorX,
      mirrorY,
    );
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
      ...toDocumentRect(rect, planeRect, mirrorX, mirrorY),
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
  /** Actual rendered top padding, px — NOT a constant (§16 compact viewports). */
  paddingTopPx: number;
  /** Actual rendered bottom padding, px. */
  paddingBottomPx: number;
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
    letterSpacingEm: s.letterSpacingEm,
    paragraphSpacingEm: s.paragraphSpacingEm ?? DEFAULT_PARAGRAPH_SPACING_EM,
    marginTopPx: input.paddingTopPx,
    marginBottomPx: input.paddingBottomPx,
    marginHorizontalPx: s.columnWidthPercent,
    mirrored: s.mirrorX || s.mirrorY,
    mirrorX: s.mirrorX,
    mirrorY: s.mirrorY,
    readingBandCenterPercent: s.readingBandCenterPercent,
    readingBandHalfHeightPercent: s.readingBandHalfHeightPercent,
    cueLayout: s.showCues ? 'cues' : 'none',
    listenerGeometryHash: input.listenerGeometryHash ?? 'none',
  };
}

/** Renderer default when the setting is absent (A.3). Keep in sync with ScriptLayer. */
export const DEFAULT_PARAGRAPH_SPACING_EM = 0.7;

/**
 * Which fingerprint fields identify the LAYOUT, as opposed to identifying the
 * map instance built from it.
 *
 * Typed `Record<keyof LayoutFingerprint, boolean>`: a field added to the
 * contract fails compilation here until it is classified, which is the only
 * reliable way to stop the omissions this table exists to prevent. Only
 * `layoutGeneration` is excluded — it is the *name* the stage gives a layout,
 * not an input to it, so two fingerprints that differ only in generation
 * describe the same geometry.
 */
const IDENTIFIES_LAYOUT: Record<keyof LayoutFingerprint, boolean> = {
  layoutGeneration: false,

  scriptCompileHash: true,
  stageGeneration: true,
  displayScaleFactor: true,
  viewportWidthPx: true,
  viewportHeightPx: true,
  fontFamily: true,
  fontHash: true,
  fontSizePx: true,
  lineHeight: true,
  letterSpacingEm: true,
  paragraphSpacingEm: true,
  marginTopPx: true,
  marginBottomPx: true,
  marginHorizontalPx: true,
  mirrored: true,
  mirrorX: true,
  mirrorY: true,
  readingBandCenterPercent: true,
  readingBandHalfHeightPercent: true,
  cueLayout: true,
  listenerGeometryHash: true,
};

const LAYOUT_KEYS = (
  Object.keys(IDENTIFIES_LAYOUT) as Array<keyof LayoutFingerprint>
).filter((key) => IDENTIFIES_LAYOUT[key]);

/** True when two fingerprints describe the same layout (§33 invalidation). */
export function sameLayout(a: LayoutFingerprint | null, b: LayoutFingerprint | null): boolean {
  if (!a || !b) return false;
  for (const key of LAYOUT_KEYS) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/**
 * Largest scroll disagreement, in px, between two maps over the spoken-unit
 * range they BOTH cover — or `Infinity` when they cannot be compared.
 *
 * `sameLayout()` answers "should the geometry have changed?" from the declared
 * inputs. This answers "did it?" from the measurements, and the two are not the
 * same question. Three known ways they diverge, all of which move glyphs with an
 * identical fingerprint:
 *
 *  - a FONT FILE swapped under the same family id. `fontFamily` is a settings
 *    string, so every advance width and every line break can change without one
 *    fingerprint field moving. (`fontHash` exists in the §7.2 contract for this
 *    and no renderer has ever populated it.)
 *  - a VIRTUALIZED height ESTIMATE corrected by a real measurement. Every block
 *    after it shifts, under a scroll transform that did not move.
 *  - anything nobody has thought of yet, which is the point: a predicted check
 *    can only cover the causes someone enumerated, and this one covers the
 *    effect.
 *
 * Comparing over the common range matters: a coverage-only rebuild legitimately
 * gains knots at the ends, and a newly measured region is not a disagreement.
 */
export function maxPathDisagreementPx(
  a: { motionKnots: readonly { spokenUnit: number }[]; sampleMotionPath(u: number): { scrollPx: number } | null } | null,
  b: { motionKnots: readonly { spokenUnit: number }[]; sampleMotionPath(u: number): { scrollPx: number } | null } | null,
  samples = 24,
): number {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const aFirst = a.motionKnots[0]?.spokenUnit;
  const aLast = a.motionKnots[a.motionKnots.length - 1]?.spokenUnit;
  const bFirst = b.motionKnots[0]?.spokenUnit;
  const bLast = b.motionKnots[b.motionKnots.length - 1]?.spokenUnit;
  if (
    aFirst === undefined ||
    aLast === undefined ||
    bFirst === undefined ||
    bLast === undefined
  ) {
    return Number.POSITIVE_INFINITY;
  }
  const from = Math.max(aFirst, bFirst);
  const to = Math.min(aLast, bLast);
  if (!(to > from)) return 0;
  let worst = 0;
  for (let i = 0; i <= samples; i++) {
    const unit = from + ((to - from) * i) / samples;
    const sa = a.sampleMotionPath(unit);
    const sb = b.sampleMotionPath(unit);
    if (!sa || !sb) continue;
    worst = Math.max(worst, Math.abs(sa.scrollPx - sb.scrollPx));
  }
  return worst;
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
