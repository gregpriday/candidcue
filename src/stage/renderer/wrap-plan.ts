/**
 * The bridge: compiled blocks in, chosen line breaks out.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE OF THE DECISION
 * ---------------------------------------------------------------------------
 * The breaker is pure and knows nothing about the DOM. The renderer knows
 * nothing about English. This module is the only place the two meet: it walks a
 * block's render nodes in the order they will be drawn, measures each word in
 * the face it will be drawn in, asks the solver where the lines should end, and
 * answers with a set of SPOKEN TOKEN INDEXES after which the renderer should
 * end a line.
 *
 * Token indexes rather than word positions, deliberately. The renderer would
 * otherwise have to count words in the same order this module did, and two
 * counters that must agree are two counters that will eventually disagree — by
 * one word, silently, on some block shape nobody tested. A token index is a
 * name both sides already have.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS CANNOT MAKE THINGS WORSE
 * ---------------------------------------------------------------------------
 * The renderer honours the plan by drawing a hard break after a chosen word,
 * and it leaves every other space breakable. So the browser is still free to
 * wrap a line this module got wrong, and no word can go missing or move — a
 * break is only ever drawn where breakable whitespace already was.
 *
 * The honest limit of that claim, because it is worth stating precisely: a
 * browser wrap that lands BEFORE a planned break leaves a short fragment
 * between the two, which is worse than either wrap alone. That is why the
 * module refuses to plan at all whenever it cannot reproduce the rendered
 * geometry exactly — unmeasurable inline content, a block kind whose size it
 * cannot know, a platform that will not measure — rather than planning on an
 * estimate. Overflow itself is not introduced here: the solver can leave one
 * indivisible run wider than the column, exactly as the browser already did
 * with a word longer than the line.
 *
 * The two ways to get nothing at all, both safe:
 *   - the platform will not measure text (`measureAdvance` returns null), or
 *   - the plan fails its own invariant.
 * Both return null, and null means "wrap it the way you always did".
 */

import type { CompiledBlock, SafeRenderNode } from '../../shared/contracts';
import { hashString } from '../../shared/markdown/hash';
import {
  breakLines,
  LINE_BREAK_DEFAULTS,
  verifyLineBreakPlan,
  type LineBreakPlan,
  type LineBreakToken,
} from '../../shared/line-break';
import {
  flattenWords,
  hasUnmeasurableInline,
  measureAdvance,
  type AdvanceMeasurer,
  type AdvanceStyle,
} from './advance';
import { FONT_METRICS_PROSE_SAMPLE } from './fontMetrics';

/**
 * How much narrower than the real column the planner aims.
 *
 * Sub-pixel rounding, the kerning this module does not see across a word
 * boundary, and a sliver of layout padding all push the same way: a plan that
 * lands a line exactly on the column edge is a plan the browser may disagree
 * with by a fraction of a pixel. It costs a hair of measure and removes a whole
 * class of "why did that line wrap" — and unlike most safety margins, being
 * wrong the other way is free, because a slightly short line is what the cost
 * model is already trading for good seams.
 */
const COLUMN_SAFETY_MARGIN_PX = 2;

/**
 * The shortest block worth planning.
 *
 * A block that cannot reach two lines has no break to choose, and planning it
 * is measurement nobody reads.
 */
const MIN_WORDS_TO_PLAN = 3;

/**
 * The width of one "character", measured in the face being planned.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PLAN IS NOT SOLVED IN RAW PIXELS
 * ---------------------------------------------------------------------------
 * Two of the solver's constants are costs PER UNIT OF WIDTH — the toll for a
 * line under the minimum measure, and the toll for overflowing the column — and
 * both were calibrated in character cells. Handing them pixels multiplies them
 * by the width of a character, around fifteen, and the balance the whole cost
 * model rests on is gone: a line twenty pixels short would outweigh splitting a
 * proper noun by a factor of ten.
 *
 * So the widths are divided by one measured constant before the solve. That is
 * not a loss of the precision this module exists for — dividing every width AND
 * the column by the same number leaves "does this line fit" exactly as true as
 * it was, and each word keeps its own real advance relative to every other. It
 * simply puts the numbers back on the scale the constants were tuned for, where
 * `targetChars` again means roughly what its name says.
 *
 * Measured from the same prose sample `fontMetrics.ts` averages, through the
 * same measurer, so letter spacing and the actual loaded face are inside the
 * number rather than assumed.
 */
function cellWidth(style: AdvanceStyle, measure: AdvanceMeasurer | undefined): number | null {
  const width =
    measureAdvance(FONT_METRICS_PROSE_SAMPLE, style, measure);
  if (width === null || width <= 0) return null;
  return width / [...FONT_METRICS_PROSE_SAMPLE].length;
}

export interface WrapPlanOptions {
  /** The rendered column, in CSS pixels. */
  columnWidthPx: number;
  /** The face the block's ordinary text is drawn in. */
  baseStyle: AdvanceStyle;
  /** Test seam; defaults to the canvas measurer. */
  measure?: AdvanceMeasurer;
  /**
   * The calibrated sentence microgap, in CSS pixels, and the tokens it is drawn
   * after.
   *
   * The stage sets this as `margin-inline-end` on sentence-final tokens AFTER
   * this plan is made, and it is around 17px at ordinary stage sizes — nearly
   * ten times the safety margin. A planner blind to it plans a line that does
   * not fit; the browser then wraps that line and the planned break strands the
   * word it moved. That is the one failure mode this feature is not allowed to
   * have, so the gap is measured as part of the separator that follows.
   */
  microgapPx?: number;
  microgapTokens?: ReadonlySet<number>;
}

export interface WrapPlan {
  /** End a line after the space that follows each of these spoken tokens. */
  breakAfterTokens: ReadonlySet<number>;
  /** The solver's digest, for the layout fingerprint. */
  signature: string;
  /** How each planned line ended — diagnostics and benchmarks only. */
  reasons: Readonly<Record<string, number>>;
  lineCount: number;
}

/** An empty plan: legal, and indistinguishable from "wrap it yourself". */
const NO_BREAKS: WrapPlan = {
  breakAfterTokens: new Set(),
  signature: 'none',
  reasons: {},
  lineCount: 0,
};

/**
 * Plan one block's lines, or null if it cannot be planned.
 *
 * Null is not a failure to report to the presenter. It is the ordinary answer
 * on a platform without canvas text metrics, and the stage's response to it is
 * to render exactly what it rendered before this feature existed.
 */
export function planBlockBreaks(
  nodes: readonly SafeRenderNode[],
  options: WrapPlanOptions,
): WrapPlan | null {
  const column = options.columnWidthPx - COLUMN_SAFETY_MARGIN_PX;
  if (!Number.isFinite(column) || column <= 0) return null;

  /*
   * A block carrying inline content this pass cannot measure is handed back to
   * the browser whole. Planning it would mean planning against a width that is
   * not the width being drawn.
   */
  if (hasUnmeasurableInline(nodes)) return null;

  const words = flattenWords(nodes, options.baseStyle);
  if (words.length < MIN_WORDS_TO_PLAN) return NO_BREAKS;

  /*
   * How many rendered spans each token index names.
   *
   * Usually one. It is TWO for a token the compiler merged across formatting —
   * "**Candid**Cue" is one spoken token mapped onto both render nodes, which
   * the compiler has a test asserting. The renderer draws a break after every
   * span carrying a planned index, so a break planned on a duplicated index
   * would draw two of them and split a word that has no space in it at all.
   */
  const occurrences = new Map<number, number>();
  for (const word of words) {
    if (word.tokenIndex === null) continue;
    occurrences.set(word.tokenIndex, (occurrences.get(word.tokenIndex) ?? 0) + 1);
  }

  const measure = options.measure;
  const cell = cellWidth(options.baseStyle, measure);
  if (cell === null) return null;
  const microgapPx = options.microgapPx ?? 0;
  const microgapTokens = options.microgapTokens;
  const tokens: LineBreakToken[] = [];
  for (const word of words) {
    const width = measureAdvance(word.text, word.style, measure);
    if (width === null) return null;
    let separatorWidth = 0;
    if (word.spaceAfter) {
      // The separator as RENDERED: ordinary whitespace has collapsed to one
      // space, a non-breaking run has not collapsed at all.
      const space = measureAdvance(word.separatorText, word.style, measure);
      if (space === null) return null;
      separatorWidth = space;
    }
    // The gap the stage will draw after this token, which nothing else here
    // would otherwise account for.
    if (microgapPx > 0 && word.tokenIndex !== null && microgapTokens?.has(word.tokenIndex)) {
      separatorWidth += microgapPx;
    }
    tokens.push({
      text: word.text,
      tokenIndex: word.tokenIndex,
      spaceAfter: word.spaceAfter,
      /*
       * A break is legal only where the renderer can draw exactly one, at a
       * seam CSS agrees is a seam:
       *   - there must be whitespace to replace, and it must be BREAKABLE
       *     whitespace (an author's non-breaking space is an instruction);
       *   - the word must have a token index, which is how the break is keyed;
       *   - that index must name exactly one span, or the break is drawn twice.
       * Failing any of these merges the word into the following atom, and the
       * browser keeps its own wrapping for that stretch.
       */
      noBreakAfter: !(
        word.spaceAfter &&
        word.breakableAfter &&
        word.tokenIndex !== null &&
        occurrences.get(word.tokenIndex) === 1
      ),
      breakAfter: word.breakAfter,
      width: width / cell,
      separatorWidth: separatorWidth / cell,
    });
  }

  /*
   * The target IS the column, rather than sitting below it by the module's
   * default slack.
   *
   * That default exists for a caller who states a reading measure and wants
   * room past it; here the column is a hard ceiling the renderer cannot exceed,
   * so slack below it would only be a second, quieter ceiling. Measured over
   * the benchmark scripts the choice barely registers — aiming 11% low cost
   * about one extra line in a hundred and bought no better seams — and aiming
   * at the column is the version that can be explained in one sentence.
   *
   * Floored, because `breakLines` ROUNDS the measure it is given and the token
   * widths it compares against are not rounded. A column of 38.7 cells rounded
   * to 39 is a ceiling half a character above the real one — about seven pixels
   * of licence to plan a line the browser then has to wrap. Flooring gives that
   * half-character back instead of spending it, and the most it can cost is one
   * character of measure.
   */
  const cells = Math.floor(column / cell);
  // A column narrower than one character cannot be planned, and must not fall
  // through to the module's default measure, which would be a column nobody has.
  if (cells < 1) return null;
  const plan = breakLines(tokens, {
    targetChars: cells,
    maxChars: cells,
    minChars: cells * LINE_BREAK_DEFAULTS.minOverTargetRatio,
  });

  /*
   * The invariant is checked on every real block rather than only in tests,
   * because the shapes the solver has never seen come from real documents. A
   * plan that fails it is discarded whole — a partly-honoured plan would move
   * the presenter's position in the script, and no line quality is worth that.
   */
  if (verifyLineBreakPlan(tokens, plan).length > 0) return null;

  return toWrapPlan(plan, tokens);
}

function toWrapPlan(plan: LineBreakPlan, tokens: readonly LineBreakToken[]): WrapPlan {
  const breakAfterTokens = new Set<number>();
  const reasons: Record<string, number> = {};
  for (const [i, line] of plan.lines.entries()) {
    reasons[line.reason] = (reasons[line.reason] ?? 0) + 1;
    // The last line ends because the block does; there is no break to draw.
    if (i === plan.lines.length - 1) continue;
    const last = tokens[line.endIndex];
    /*
     * A forced break is one the renderer already draws for the `line_break`
     * node that caused it. Emitting a second break for the same seam would put
     * a blank line on the glass.
     */
    if (!last || last.breakAfter === true) continue;
    if (typeof last.tokenIndex !== 'number') continue;
    breakAfterTokens.add(last.tokenIndex);
  }
  return {
    breakAfterTokens,
    signature: plan.signature,
    reasons,
    lineCount: plan.lines.length,
  };
}

/* ---------------------------------------------------------------------------
 * Whole-script planning
 * ------------------------------------------------------------------------- */

export interface ScriptWrapPlan {
  /** Every spoken token in the script after which a line ends. */
  breakAfterTokens: ReadonlySet<number>;
  /**
   * One digest over every block's plan, in block order.
   *
   * This is what the layout fingerprint carries. A plan that changed while the
   * fingerprint did not is the bug the fingerprint exists to prevent: the line
   * map is rebuilt under the old generation and the re-anchor never runs.
   */
  signature: string;
  /** Blocks whose lines are the browser's rather than the planner's. */
  unplannedBlocks: number;
  reasons: Readonly<Record<string, number>>;
}

/**
 * How much narrower than the column a block of this kind is, and in what face.
 *
 * ---------------------------------------------------------------------------
 * WHY A WRONG PLAN IS WORSE THAN NO PLAN
 * ---------------------------------------------------------------------------
 * Everywhere else in this module, being wrong costs one browser-wrapped line.
 * Here it costs more than that: a planner that thinks the column is wider than
 * it is packs too many words onto a line, the browser wraps it anyway, and the
 * presenter gets the planner's break AND the browser's — a stray short line
 * that neither would have produced alone. So a block kind is planned only where
 * its geometry is known exactly, and the ones below are mirrored from the rules
 * in `BlockView.svelte` that produce them.
 *
 * Headings are deliberately absent. They render at 1.05em to 1.3em by level,
 * and a compact heading takes `max(var(--stage-secondary-min), 0.9em)` — a
 * custom property resolved against the rig's optics at runtime, which this pass
 * does not have. Planning them would mean guessing a size, and a heading is
 * usually one line anyway, so there is little to win and a visible line to
 * lose.
 *
 * Everything not listed is not prose the presenter reads down a column: a table
 * is a reference card laid out in cells, a code block is preformatted, a cue is
 * a chip.
 */
interface BlockLayout {
  /** Pixels of the column this kind does not get to use. */
  insetPx: number;
  italic: boolean;
}

/** `.list-item { gap: 0.55em }` plus `.bullet { width: 0.28em }`. */
const LIST_INSET_EM = 0.83;
/** `.quote { padding-left: 0.85em; font-style: italic }`. */
const QUOTE_INSET_EM = 0.85;

function layoutForKind(kind: string, fontSizePx: number): BlockLayout | null {
  switch (kind) {
    case 'paragraph':
      return { insetPx: 0, italic: false };
    case 'list_item':
      return { insetPx: LIST_INSET_EM * fontSizePx, italic: false };
    case 'blockquote':
      return { insetPx: QUOTE_INSET_EM * fontSizePx, italic: true };
    default:
      return null;
  }
}

/**
 * The plan for a stage that is not planning: no breaks, and a signature that
 * says so.
 *
 * A distinct signature rather than an empty string, so turning the feature off
 * is itself a layout change — every line re-wraps at that moment, and a
 * fingerprint that could not see it would replace the map under the old
 * generation.
 */
export const EMPTY_WRAP_PLAN: ScriptWrapPlan = {
  breakAfterTokens: new Set(),
  signature: 'off',
  unplannedBlocks: 0,
  reasons: {},
};

export function planScriptBreaks(
  blocks: readonly CompiledBlock[],
  options: WrapPlanOptions,
): ScriptWrapPlan {
  const breakAfterTokens = new Set<number>();
  const reasons: Record<string, number> = {};
  const parts: string[] = [];
  let unplannedBlocks = 0;

  for (const block of blocks) {
    const layout = layoutForKind(block.kind, options.baseStyle.fontSizePx);
    if (!layout) continue;
    const plan = planBlockBreaks(block.renderNodes, {
      ...options,
      columnWidthPx: options.columnWidthPx - layout.insetPx,
      baseStyle: { ...options.baseStyle, italic: layout.italic },
    });
    if (!plan) {
      unplannedBlocks++;
      continue;
    }
    for (const token of plan.breakAfterTokens) breakAfterTokens.add(token);
    for (const [reason, count] of Object.entries(plan.reasons)) {
      reasons[reason] = (reasons[reason] ?? 0) + count;
    }
    parts.push(`${block.id}:${plan.signature}`);
  }

  return {
    breakAfterTokens,
    /*
     * Hashed rather than concatenated: this is carried in a fingerprint that is
     * compared on every layout check, and a script of five hundred blocks would
     * otherwise make that comparison a kilobyte of string per frame.
     */
    signature: hashString(parts.join('|')),
    unplannedBlocks,
    reasons,
  };
}
