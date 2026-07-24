/**
 * RenderedLineMapBuilder (companion §7, §7.1, §7.2, §7.3, §8).
 *
 * The map is built from *measured* rects — never from character counts — and is
 * immutable for one layout generation. It answers exactly one question for the
 * frame loop: given a spoken-unit position, where should the document be, and
 * how fast is that place moving? (`sampleMotionPath`, §8.)
 *
 * This module is pure: the DOM measurement pass lives in `measure.ts` and hands
 * plain rects in, so the whole geometry stack is unit-testable in node against
 * synthetic fixtures.
 *
 * Coordinate model matches the existing stage renderer: "document Y" is
 * measured from the top of the scroll plane content, and the plane is
 * translated by `-scrollPx`, so a document Y appears on screen at
 * `documentY - scrollPx`.
 */
import type {
  LayoutFingerprint,
  LineMotionKnot,
  LineMotionSample,
  RenderedLine,
  RenderedLineMap,
  RenderedTokenStop,
} from '../../shared/contracts';
import { createMonotoneSpline, type MonotoneSpline } from './monotone';
import { identityUnitScale, type SpokenUnitScale } from './units';

/** One measured spoken token rect, in document coordinates. */
export interface MeasuredTokenRect {
  tokenIndex: number;
  blockId: string;
  xStart: number;
  xEnd: number;
  topY: number;
  bottomY: number;
}

/** One measured block box, in document coordinates. */
export interface MeasuredBlockBox {
  blockId: string;
  sectionId: string;
  /** Compiled block kind; visual kinds create vertical distance without speech. */
  kind: string;
  spoken: boolean;
  topY: number;
  bottomY: number;
}

export type LineMapIssueCode =
  | 'no_tokens'
  | 'nonmonotonic_tokens'
  | 'nonmonotonic_baselines'
  | 'degenerate_units'
  | 'insufficient_knots'
  | 'unknown_block';

export interface LineMapIssue {
  code: LineMapIssueCode;
  detail: string;
  /** Fatal issues make the map invalid; the stage must hold rather than guess (§62). */
  fatal: boolean;
}

export interface LineMapCoverage {
  firstTokenIndex: number;
  lastTokenIndex: number;
  unitStart: number;
  unitEnd: number;
}

export interface LineMapBuildOptions {
  fingerprint: LayoutFingerprint;
  tokens: readonly MeasuredTokenRect[];
  blocks: readonly MeasuredBlockBox[];
  unitScale?: SpokenUnitScale;
  /** `R` in companion §8: the preferred line-entry baseline, viewport pixels. */
  readingLineStartY: number;
  lineHeightPx: number;
  viewportHeightPx: number;
  /** Scroll range the map may target; knots are clamped into it. */
  maxScrollPx: number;
  /** Baseline as a fraction of the measured line box height. */
  baselineFraction?: number;
  /** Tokens within this vertical distance share a rendered line. */
  baselineTolerancePx?: number;
  /** Absolute clamp for any knot slope (§8.6: no unbounded media slope). */
  maxSlopePxPerUnit?: number;
  /** Tighter clamp at paragraph/section/visual-block knots (§8.5). */
  boundarySlopeClampPxPerUnit?: number;
  /** A vertical gap this large between spoken lines is a visual-block boundary. */
  visualBlockGapPx?: number;
}

/**
 * The contract's `RenderedLineMap` plus the extras the stage needs: validity,
 * coverage (windowed rendering measures only part of a long script), and the
 * explicitly-tested degraded fallbacks of Appendix B.4.
 */
export interface StageRenderedLineMap extends RenderedLineMap {
  readonly fingerprint: LayoutFingerprint;
  readonly valid: boolean;
  readonly issues: readonly LineMapIssue[];
  readonly coverage: LineMapCoverage | null;
  readonly readingLineStartY: number;
  readonly linePitchPx: number;
  lineForUnit(spokenUnit: number): RenderedLine | null;
  lineForToken(tokenIndex: number): RenderedLine | null;
  /** Degraded per-line interpolation (Appendix B.4), used when no path exists. */
  fallbackTarget(spokenUnit: number): LineMotionSample | null;
  /** True when `spokenUnit` sits inside the measured coverage. */
  covers(spokenUnit: number): boolean;
}

const DEFAULT_BASELINE_FRACTION = 0.8;
const DEFAULT_VISUAL_GAP_FACTOR = 2.2;
const HANDOFF_SOFTNESS = 0.35;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Empty, invalid map — the stage holds motion and reports it (§62). */
export function emptyRenderedLineMap(
  fingerprint: LayoutFingerprint,
  issues: readonly LineMapIssue[] = [{ code: 'no_tokens', detail: 'no measured tokens', fatal: true }],
): StageRenderedLineMap {
  return {
    generation: fingerprint.layoutGeneration,
    lines: [],
    motionKnots: [],
    fingerprint,
    valid: false,
    issues,
    coverage: null,
    readingLineStartY: 0,
    linePitchPx: 0,
    sampleMotionPath: () => null,
    lineForUnit: () => null,
    lineForToken: () => null,
    fallbackTarget: () => null,
    covers: () => false,
  };
}

interface LineDraft {
  blockId: string;
  sectionId: string;
  tokens: MeasuredTokenRect[];
  topY: number;
  bottomY: number;
}

/**
 * Group measured token rects into rendered lines and build the monotone
 * unit → scroll path through their line-start knots.
 */
export function buildRenderedLineMap(options: LineMapBuildOptions): StageRenderedLineMap {
  const issues: LineMapIssue[] = [];
  const unitScale = options.unitScale ?? identityUnitScale();
  const baselineFraction = options.baselineFraction ?? DEFAULT_BASELINE_FRACTION;
  const lineHeightPx = Math.max(1, options.lineHeightPx);
  const tolerance = options.baselineTolerancePx ?? Math.max(2, lineHeightPx * 0.35);
  const visualGapPx = options.visualBlockGapPx ?? lineHeightPx * DEFAULT_VISUAL_GAP_FACTOR;
  const maxScroll = Math.max(0, options.maxScrollPx);
  const R = options.readingLineStartY;

  const blockById = new Map(options.blocks.map((b) => [b.blockId, b]));

  const sorted = [...options.tokens].sort((a, b) => a.tokenIndex - b.tokenIndex);
  if (sorted.length === 0) {
    return emptyRenderedLineMap(options.fingerprint);
  }

  /* ---- 1. group rects into rendered lines by measured top (§7.1) ---- */
  const drafts: LineDraft[] = [];
  let draft: LineDraft | null = null;
  let previousToken = -1;
  for (const token of sorted) {
    if (token.tokenIndex === previousToken) continue; // duplicate anchor: keep the first
    previousToken = token.tokenIndex;
    const block = blockById.get(token.blockId);
    if (!block && !issues.some((i) => i.code === 'unknown_block')) {
      issues.push({
        code: 'unknown_block',
        detail: `token ${token.tokenIndex} references unmeasured block ${token.blockId}`,
        fatal: false,
      });
    }
    const sectionId = block?.sectionId ?? token.blockId;
    const sameLine =
      draft !== null &&
      draft.blockId === token.blockId &&
      Math.abs(token.topY - draft.topY) <= tolerance;
    if (draft && sameLine) {
      draft.tokens.push(token);
      draft.topY = Math.min(draft.topY, token.topY);
      draft.bottomY = Math.max(draft.bottomY, token.bottomY);
    } else {
      draft = {
        blockId: token.blockId,
        sectionId,
        tokens: [token],
        topY: token.topY,
        bottomY: token.bottomY,
      };
      drafts.push(draft);
    }
  }

  /* ---- 2. materialize RenderedLines ---- */
  const lines: RenderedLine[] = [];
  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i];
    if (!d) continue;
    const first = d.tokens[0];
    const last = d.tokens[d.tokens.length - 1];
    if (!first || !last) continue;

    const lineXStart = Math.min(...d.tokens.map((t) => t.xStart));
    const lineXEnd = Math.max(...d.tokens.map((t) => t.xEnd));
    const width = Math.max(1, lineXEnd - lineXStart);
    const height = Math.max(1, d.bottomY - d.topY);

    const tokenStops: RenderedTokenStop[] = d.tokens.map((t) => ({
      tokenIndex: t.tokenIndex,
      spokenUnit: unitScale.unitForToken(t.tokenIndex),
      xStart: t.xStart,
      xEnd: t.xEnd,
      visualFractionStart: clamp((t.xStart - lineXStart) / width, 0, 1),
      visualFractionEnd: clamp((t.xEnd - lineXStart) / width, 0, 1),
    }));

    const prev = drafts[i - 1];
    const next = drafts[i + 1];
    lines.push({
      lineId: `L${i}:${first.tokenIndex}`,
      blockId: d.blockId,
      sectionId: d.sectionId,
      firstTokenIndex: first.tokenIndex,
      lastTokenIndex: last.tokenIndex,
      spokenUnitStart: unitScale.unitForToken(first.tokenIndex),
      spokenUnitEnd:
        unitScale.unitForToken(last.tokenIndex) + unitScale.unitSpanForToken(last.tokenIndex),
      topY: d.topY,
      baselineY: d.topY + height * baselineFraction,
      bottomY: d.bottomY,
      nextBaselineY: null, // filled below
      visibleTextWidthPx: width,
      tokenStops,
      startsParagraph: !prev || prev.blockId !== d.blockId,
      endsParagraph: !next || next.blockId !== d.blockId,
      startsSection: !prev || prev.sectionId !== d.sectionId,
      endsSection: !next || next.sectionId !== d.sectionId,
    });
  }
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    const next = lines[i + 1];
    if (line && next) line.nextBaselineY = next.baselineY;
  }

  /* ---- 3. boundary classification (§7.3, §8.5, §8.6) ---- */
  const boundaryKinds: LineMotionKnot['boundaryKind'][] = lines.map((line, i) => {
    const prev = lines[i - 1];
    if (!prev) return 'ordinary';
    if (prev.sectionId !== line.sectionId) return 'section';
    if (prev.blockId === line.blockId) return 'ordinary';
    const gap = line.topY - prev.bottomY;
    if (gap >= visualGapPx || hasVisualBlockBetween(options.blocks, prev.blockId, line.blockId)) {
      return 'visual_block';
    }
    return 'paragraph';
  });

  /* ---- 4. knots: every line start sits at the reading position (§8) ---- */
  const knotXs: number[] = [];
  const knotYs: number[] = [];
  const knotLineIndex: number[] = [];
  const knotBoundary: LineMotionKnot['boundaryKind'][] = [];
  const slopeClamp: (number | undefined)[] = [];
  const boundaryClamp = options.boundarySlopeClampPxPerUnit;

  let lastY = -Infinity;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const u = line.spokenUnitStart;
    if (knotXs.length > 0 && u <= (knotXs[knotXs.length - 1] ?? 0)) {
      // Spoken lines must have strictly increasing start coordinates (§8.3).
      if (!issues.some((issue) => issue.code === 'degenerate_units')) {
        issues.push({
          code: 'degenerate_units',
          detail: `line ${line.lineId} does not advance the spoken-unit axis`,
          fatal: false,
        });
      }
      continue;
    }
    let y = clamp(line.baselineY - R, 0, maxScroll);
    if (y < lastY) {
      // A measured inversion would make the path move backward. Flatten it and
      // report; never let guessed geometry drive motion (§62).
      if (!issues.some((issue) => issue.code === 'nonmonotonic_baselines')) {
        issues.push({
          code: 'nonmonotonic_baselines',
          detail: `line ${line.lineId} measured above its predecessor`,
          fatal: false,
        });
      }
      y = lastY;
    }
    lastY = y;
    knotXs.push(u);
    knotYs.push(y);
    knotLineIndex.push(i);
    const kind = boundaryKinds[i] ?? 'ordinary';
    knotBoundary.push(kind);
    slopeClamp.push(kind === 'ordinary' ? undefined : boundaryClamp);
  }

  /* ---- 5. virtual final knot (§8.7) ---- */
  const linePitchPx = medianPitch(lines, lineHeightPx);
  const lastLine = lines[lines.length - 1];
  if (lastLine && knotXs.length > 0) {
    const tailUnits = Math.max(
      lastLine.spokenUnitEnd - lastLine.spokenUnitStart,
      1e-3,
    );
    const virtualX = (knotXs[knotXs.length - 1] ?? 0) + tailUnits;
    const virtualY = clamp((knotYs[knotYs.length - 1] ?? 0) + linePitchPx, 0, maxScroll);
    knotXs.push(virtualX);
    knotYs.push(virtualY);
    knotLineIndex.push(lines.length - 1);
    knotBoundary.push('ordinary');
    slopeClamp.push(undefined);
  }

  const spline: MonotoneSpline | null =
    knotXs.length >= 2
      ? createMonotoneSpline(knotXs, knotYs, {
          maxSlope: options.maxSlopePxPerUnit,
          knotSlopeClamp: slopeClamp,
        })
      : null;

  if (!spline) {
    issues.push({
      code: 'insufficient_knots',
      detail: `${knotXs.length} usable line knots`,
      fatal: true,
    });
  }

  const motionKnots: LineMotionKnot[] = knotXs.map((x, i) => ({
    lineId: lines[knotLineIndex[i] ?? 0]?.lineId ?? '',
    spokenUnit: x,
    scrollPx: knotYs[i] ?? 0,
    slopePxPerUnit: spline?.slopes[i] ?? 0,
    boundaryKind: knotBoundary[i] ?? 'ordinary',
  }));

  const firstLine = lines[0];
  const coverage: LineMapCoverage | null =
    firstLine && lastLine
      ? {
          firstTokenIndex: firstLine.firstTokenIndex,
          lastTokenIndex: lastLine.lastTokenIndex,
          unitStart: firstLine.spokenUnitStart,
          unitEnd: lastLine.spokenUnitEnd,
        }
      : null;

  const valid = spline !== null && !issues.some((issue) => issue.fatal);

  function lineIndexForUnit(unit: number): number {
    if (lines.length === 0) return -1;
    let lo = 0;
    let hi = lines.length - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((lines[mid]?.spokenUnitStart ?? 0) <= unit) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  }

  const map: StageRenderedLineMap = {
    generation: options.fingerprint.layoutGeneration,
    lines,
    motionKnots,
    fingerprint: options.fingerprint,
    valid,
    issues,
    coverage,
    readingLineStartY: R,
    linePitchPx,

    sampleMotionPath(spokenUnit: number): LineMotionSample | null {
      if (!spline || !valid) return null;
      const sample = spline.sample(spokenUnit);
      const lineIdx = knotLineIndex[sample.index] ?? 0;
      return {
        scrollPx: sample.y,
        derivativePxPerUnit: sample.dy,
        lineId: lines[lineIdx]?.lineId ?? null,
        lineProgress: sample.t,
      };
    },

    lineForUnit(spokenUnit: number): RenderedLine | null {
      const index = lineIndexForUnit(spokenUnit);
      return index < 0 ? null : (lines[index] ?? null);
    },

    lineForToken(tokenIndex: number): RenderedLine | null {
      if (lines.length === 0) return null;
      let lo = 0;
      let hi = lines.length - 1;
      let best = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if ((lines[mid]?.firstTokenIndex ?? 0) <= tokenIndex) {
          best = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return lines[best] ?? null;
    },

    /**
     * Appendix B.4's explicitly-tested degraded fallback: single-line
     * interpolation with a low-strength smoothstep. Production following uses
     * the shared-slope path above; this only runs when no path exists.
     */
    fallbackTarget(spokenUnit: number): LineMotionSample | null {
      const index = lineIndexForUnit(spokenUnit);
      const line = index < 0 ? null : lines[index];
      if (!line) return null;
      const denominator = Math.max(line.spokenUnitEnd - line.spokenUnitStart, 0.001);
      const rawProgress = clamp((spokenUnit - line.spokenUnitStart) / denominator, 0, 1);
      const nextBaseline = line.nextBaselineY ?? line.baselineY + linePitchPx;
      const baselineDelta = nextBaseline - line.baselineY;
      const p = handoffCurve(rawProgress, HANDOFF_SOFTNESS);
      const dp = handoffCurveDerivative(rawProgress, HANDOFF_SOFTNESS);
      return {
        scrollPx: clamp(line.baselineY - R + p * baselineDelta, 0, maxScroll),
        derivativePxPerUnit: Math.max(0, (dp * baselineDelta) / denominator),
        lineId: line.lineId,
        lineProgress: rawProgress,
      };
    },

    covers(spokenUnit: number): boolean {
      if (!coverage) return false;
      return spokenUnit >= coverage.unitStart && spokenUnit <= coverage.unitEnd;
    },
  };

  return map;
}

function hasVisualBlockBetween(
  blocks: readonly MeasuredBlockBox[],
  fromBlockId: string,
  toBlockId: string,
): boolean {
  const from = blocks.findIndex((b) => b.blockId === fromBlockId);
  const to = blocks.findIndex((b) => b.blockId === toBlockId);
  if (from < 0 || to < 0 || to <= from + 1) return false;
  for (let i = from + 1; i < to; i++) {
    const block = blocks[i];
    if (!block) continue;
    if (isVisualKind(block.kind)) return true;
  }
  return false;
}

function isVisualKind(kind: string): boolean {
  return kind === 'image' || kind === 'table' || kind === 'diagram' || kind === 'code';
}

function medianPitch(lines: readonly RenderedLine[], fallbackPx: number): number {
  const deltas: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    const line = lines[i];
    if (!prev || !line) continue;
    if (prev.blockId !== line.blockId) continue;
    const delta = line.baselineY - prev.baselineY;
    if (delta > 0) deltas.push(delta);
  }
  if (deltas.length === 0) return fallbackPx;
  deltas.sort((a, b) => a - b);
  return deltas[Math.floor(deltas.length / 2)] ?? fallbackPx;
}

/** `H(p) = mix(p, p²(3 - 2p), softness)` — companion §8.4. */
export function handoffCurve(p: number, softness: number): number {
  const x = clamp(p, 0, 1);
  const smooth = x * x * (3 - 2 * x);
  return x + (smooth - x) * clamp(softness, 0, 1);
}

export function handoffCurveDerivative(p: number, softness: number): number {
  const x = clamp(p, 0, 1);
  const dSmooth = 6 * x * (1 - x);
  return 1 + (dSmooth - 1) * clamp(softness, 0, 1);
}
