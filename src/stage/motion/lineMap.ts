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
  | 'unknown_block'
  | 'nonfinite_geometry'
  | 'visual_block_secant';

export interface LineMapIssue {
  code: LineMapIssueCode;
  detail: string;
  /** Fatal issues make the map invalid; the stage must hold rather than guess (§62). */
  fatal: boolean;
}

/**
 * Which measurement faults are fatal (§62: "hold rather than move on guessed
 * geometry"). Typed `Record<LineMapIssueCode, boolean>` so a new code has to be
 * classified rather than silently defaulting to survivable.
 *
 * Inverted baselines and a spoken-unit axis that fails to advance used to be
 * non-fatal — the builder flattened the inversion and carried on with a map it
 * still reported as `valid`. That is precisely the "moves on guessed geometry"
 * failure §62 forbids: under a vertical mirror EVERY line looks inverted, the
 * flattening collapses most knots onto the first line's scroll position, and
 * the stage follows that with complete confidence.
 */
const FATAL_ISSUE: Record<LineMapIssueCode, boolean> = {
  no_tokens: true,
  nonmonotonic_tokens: true,
  nonmonotonic_baselines: true,
  degenerate_units: true,
  insufficient_knots: true,
  nonfinite_geometry: true,
  // A block the measurement pass did not see costs the map its section identity
  // for that block, not its geometry.
  unknown_block: false,
  // Recoverable: the interval is recorded so the engine can re-anchor across it
  // instead of racing (§8.6).
  visual_block_secant: false,
};

/**
 * A spoken interval whose average slope (SECANT, not knot tangent) exceeds the
 * visual-block limit — companion §8.6.
 *
 * Clamping knot TANGENTS cannot bound the average slope: the spline still has
 * to traverse the whole vertical delta over the same semantic interval, so a
 * one-word paragraph either side of a 900 px image forces ~900 px of travel per
 * spoken unit no matter what the tangents say. The stage records the interval
 * and crosses it as an explicit, bounded re-anchor rather than racing the
 * controller at its velocity ceiling or accumulating a full-screen error.
 */
export interface VisualBlockSpan {
  unitStart: number;
  unitEnd: number;
  scrollStartPx: number;
  scrollEndPx: number;
  secantPxPerUnit: number;
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
  /**
   * Distance from `R` to the reading corridor's upper edge, viewport pixels
   * (§8.8, §16.3). The COMPUTED half-height, not the raw setting: the renderer
   * clamps the percentage and the corridor's top edge is clipped at the
   * viewport, so recomputing it from `fingerprint.readingBandHalfHeightPercent`
   * here would be a second source of truth for one number. Optional so a caller
   * that has no corridor (tests, degraded builders) gets no §30.3 ceiling
   * rather than a wrong one.
   */
  readingBandHalfHeightPx?: number;
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
  /**
   * Largest average slope (secant) a spoken interval may have before it is
   * recorded as a `VisualBlockSpan`. Defaults to `boundarySlopeClampPxPerUnit`.
   */
  maxVisualSecantPxPerUnit?: number;
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
  /**
   * §30.3's corridor scale: how far above `R` the reading corridor's upper edge
   * sits. Zero means the corridor is unknown, and the §30.3 ceiling is then not
   * applied at all rather than guessed at.
   */
  readonly readingBandHalfHeightPx: number;
  readonly linePitchPx: number;
  /** Intervals the path cannot traverse at a readable speed (§8.6). */
  readonly visualBlockSpans: readonly VisualBlockSpan[];
  /** The span containing `spokenUnit`, if any. */
  visualBlockSpanAt(spokenUnit: number): VisualBlockSpan | null;
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
    readingBandHalfHeightPx: 0,
    linePitchPx: 0,
    visualBlockSpans: [],
    visualBlockSpanAt: () => null,
    sampleMotionPath: () => null,
    lineForUnit: () => null,
    lineForToken: () => null,
    fallbackTarget: () => null,
    covers: () => false,
  };
}

function isFiniteRect(...values: number[]): boolean {
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  }
  return true;
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

  function raise(code: LineMapIssueCode, detail: string) {
    if (issues.some((issue) => issue.code === code)) return;
    issues.push({ code, detail, fatal: FATAL_ISSUE[code] });
  }

  /* ---- 0. reject geometry that cannot describe a rendered layout ----
   * A single NaN top propagates through the knot list into the spline and out
   * as `translate3d(0, NaNpx, 0)`; an inverted rect means the measurement was
   * taken through a transform the builder does not model. Neither is something
   * to smooth over — the stage holds and reports (§62).
   */
  for (const token of options.tokens) {
    if (
      !isFiniteRect(token.tokenIndex, token.xStart, token.xEnd, token.topY, token.bottomY) ||
      token.bottomY < token.topY ||
      token.xEnd < token.xStart
    ) {
      raise('nonfinite_geometry', `token ${token.tokenIndex} has unusable measured geometry`);
      break;
    }
  }
  for (const block of options.blocks) {
    if (!isFiniteRect(block.topY, block.bottomY) || block.bottomY < block.topY) {
      raise('nonfinite_geometry', `block ${block.blockId} has unusable measured geometry`);
      break;
    }
  }
  if (
    !isFiniteRect(R, lineHeightPx, maxScroll, options.viewportHeightPx) ||
    !isFiniteRect(tolerance, visualGapPx)
  ) {
    raise('nonfinite_geometry', 'layout inputs are not finite');
  }
  if (issues.some((issue) => issue.fatal)) {
    return emptyRenderedLineMap(options.fingerprint, issues);
  }

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
    if (!block) {
      raise('unknown_block', `token ${token.tokenIndex} references unmeasured block ${token.blockId}`);
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
  const slopeTarget: (number | undefined)[] = [];
  const boundaryClamp = options.boundarySlopeClampPxPerUnit;

  let lastY = -Infinity;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const u = line.spokenUnitStart;
    if (knotXs.length > 0 && u <= (knotXs[knotXs.length - 1] ?? 0)) {
      // Spoken lines must have strictly increasing start coordinates (§8.3). A
      // map that cannot order its own lines is not a map.
      raise('degenerate_units', `line ${line.lineId} does not advance the spoken-unit axis`);
      continue;
    }
    const y = clamp(line.baselineY - R, 0, maxScroll);
    if (y < lastY) {
      // A measured inversion means the measurement did not describe the
      // rendered layout — most often because it was taken through a mirror
      // transform. Flattening it produces a plausible-looking map that puts
      // most of the document at one scroll position; the stage must hold and
      // rebuild instead (§62, §7.2).
      raise('nonmonotonic_baselines', `line ${line.lineId} measured above its predecessor`);
      continue;
    }
    lastY = y;
    knotXs.push(u);
    knotYs.push(y);
    knotLineIndex.push(i);
    const kind = boundaryKinds[i] ?? 'ordinary';
    knotBoundary.push(kind);
    slopeClamp.push(kind === 'ordinary' ? undefined : boundaryClamp);
    slopeTarget.push(undefined);
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
    slopeTarget.push(undefined);

    /*
     * The virtual interval has to travel one ordinary pitch by the time the
     * final spoken line is complete. On a three-word closing line its secant
     * can be two or three times the preceding line's, and the default harmonic
     * knot slope leaves much of that acceleration inside those final words.
     * The jerk-limited plant then reaches its fastest motion as the reader
     * finishes — the most conspicuous possible place for a speed-up.
     *
     * Ask for the final interval's secant at the line-entry knot instead. The
     * monotonicity limiter may reduce it when the preceding interval cannot
     * safely carry that slope, but otherwise the closing line is traversed at
     * a steady rate and the necessary acceleration is distributed over the
     * line before it. Equal-length lines are unchanged because their secants
     * already agree.
     */
    const finalKnotIndex = knotXs.length - 2;
    const finalDx = (knotXs[finalKnotIndex + 1] ?? 0) - (knotXs[finalKnotIndex] ?? 0);
    const finalDy = (knotYs[finalKnotIndex + 1] ?? 0) - (knotYs[finalKnotIndex] ?? 0);
    if (finalDx > 0 && finalDy > 0) {
      slopeTarget[finalKnotIndex] = finalDy / finalDx;
    }
  }

  /* ---- 5b. secant check (§8.6) ----
   * A knot-tangent clamp cannot bound the AVERAGE slope of an interval: the
   * spline still has to cover `Δy` over `Δu` whatever the tangents are. Reject
   * the interval on its secant and hand it to the engine as an explicit
   * re-anchor rather than pretending the clamp did the job.
   */
  const visualBlockSpans: VisualBlockSpan[] = [];
  const secantLimit = options.maxVisualSecantPxPerUnit ?? boundaryClamp;
  if (secantLimit !== undefined && Number.isFinite(secantLimit) && secantLimit > 0) {
    for (let i = 1; i < knotXs.length; i++) {
      const du = (knotXs[i] ?? 0) - (knotXs[i - 1] ?? 0);
      const dy = (knotYs[i] ?? 0) - (knotYs[i - 1] ?? 0);
      if (du <= 0 || dy <= 0) continue;
      const secant = dy / du;
      if (secant <= secantLimit) continue;
      visualBlockSpans.push({
        unitStart: knotXs[i - 1] ?? 0,
        unitEnd: knotXs[i] ?? 0,
        scrollStartPx: knotYs[i - 1] ?? 0,
        scrollEndPx: knotYs[i] ?? 0,
        secantPxPerUnit: secant,
      });
    }
  }
  if (visualBlockSpans.length > 0) {
    raise(
      'visual_block_secant',
      `${visualBlockSpans.length} interval(s) exceed ${secantLimit?.toFixed(0)} px per spoken unit`,
    );
  }

  const spline: MonotoneSpline | null =
    knotXs.length >= 2
      ? createMonotoneSpline(knotXs, knotYs, {
          maxSlope: options.maxSlopePxPerUnit,
          knotSlopeClamp: slopeClamp,
          knotSlopeTarget: slopeTarget,
        })
      : null;

  if (!spline) {
    raise('insufficient_knots', `${knotXs.length} usable line knots`);
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
    readingBandHalfHeightPx: Math.max(0, options.readingBandHalfHeightPx ?? 0),
    linePitchPx,
    visualBlockSpans,

    visualBlockSpanAt(spokenUnit: number): VisualBlockSpan | null {
      for (const span of visualBlockSpans) {
        if (spokenUnit > span.unitStart && spokenUnit < span.unitEnd) return span;
      }
      return null;
    },

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
