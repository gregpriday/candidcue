/**
 * How wide a word actually is, in the face the stage will draw it in.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The line breaker can plan in any unit, and given nothing better it counts
 * character cells. Cells are a fair estimate of a COLUMN — the optical resolver
 * sizes one from an average advance and is right about the average — and a poor
 * estimate of any INDIVIDUAL line: "Wow, William" and "illicit institution" are
 * the same number of cells and nowhere near the same number of pixels. A plan
 * wrong by that much hands the browser a line it has to wrap a second time, and
 * the second wrap is the greedy one the planner exists to replace.
 *
 * So the stage measures. This module is the only thing in the renderer that
 * turns text into a width, and it answers in the same unit the column is
 * expressed in, which is what lets the solver compare them.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT IS HONEST ABOUT
 * ---------------------------------------------------------------------------
 * `null` means "this platform would not measure that", never a zero. A zero
 * would read as a word of no width and would let a line hold any number of
 * them. Every caller has to decide what to do without a measurement, and the
 * decision the stage makes is to fall back to character cells for the whole
 * block rather than mix units inside one plan.
 *
 * It shares the sentinel-font discipline in `fontMetrics.ts` and deliberately
 * does not share its code: that module measures ONE string per face to derive
 * proportions, this one measures thousands of words in four style variants, and
 * the request shapes have diverged far enough that one function serving both
 * would take an options bag nobody could read.
 */

import type { SafeRenderNode } from '../../shared/contracts';
import { resolveWordTokens } from './word-tokens';

/** The marks the compiler can put on a text run. */
export type Mark = 'strong' | 'em' | 'strike' | 'code';

/**
 * The face a run is drawn in, as far as its ADVANCE is concerned.
 *
 * `strike` is absent on purpose: `text-decoration` draws a line through a word
 * without moving a glyph, so it is not part of this shape at all.
 */
export interface AdvanceStyle {
  fontStack: string;
  fontSizePx: number;
  fontWeight: number;
  italic: boolean;
  /** Inline code: a different family at a different size. See `CODE_*` below. */
  mono: boolean;
  /**
   * `letter-spacing`, resolved to pixels.
   *
   * `measureText` knows nothing about it, and the stage sets it on every rig —
   * so leaving it out biases every width in the same direction, which is the
   * one error a safety margin cannot absorb because it grows with the length of
   * the line. Added arithmetically rather than through `ctx.letterSpacing`:
   * that property is recent enough that relying on it would make the plan
   * depend on which engine is asking.
   *
   * CSS puts the spacing after EVERY character, the last one included, which is
   * why the count below is not `length - 1`.
   */
  letterSpacingPx: number;
}

/**
 * The family and relative size `.m-code` renders at, mirrored from
 * `InlineNodes.svelte`.
 *
 * The real rule is `max(var(--stage-secondary-min), 0.92em)`, and the floor is
 * a resolved pixel value this module does not have. It is not always the 0.92em
 * arm that wins: `--stage-secondary-min` carries the optical resolver's hard
 * 16-arcmin angular floor, and on a rig where that floor resolves above 0.92 of
 * the body size, inline code is drawn WIDER than anything measured here.
 *
 * Which is why measuring the 0.92em arm alone is not an acceptable
 * approximation. Under-measuring a PLANNED line does not degrade to the
 * wrapping the browser did before this feature existed: the planned break is
 * already in that line, so the browser's wrap lands IN ADDITION to it and
 * strands a short fragment between the two — worse than either wrap on its own.
 * `hasUnmeasurableInline` therefore refuses a block carrying a code mark
 * outright, and no line is ever planned from these constants.
 */
const CODE_FAMILY = 'ui-monospace, SFMono-Regular, Consolas, monospace';
const CODE_SIZE_RATIO = 0.92;
/** `.m-strong { font-weight: 700 }`. */
const STRONG_WEIGHT = 700;

/**
 * A font the sentinel check can recognise after the browser normalises it. Its
 * size is small enough that nothing this module asks for serialises to the same
 * string and gets misread as a rejection.
 */
const SENTINEL_FONT = '10px monospace';

/** `undefined` means "not tried yet"; `null` means "this platform has none". */
let context: CanvasRenderingContext2D | null | undefined;

function measuringContext(): CanvasRenderingContext2D | null {
  if (context !== undefined) return context;
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    context = null;
    return null;
  }
  try {
    context = document.createElement('canvas').getContext('2d');
  } catch {
    // jsdom and headless runners report an unimplemented canvas by throwing.
    context = null;
  }
  return context;
}

/** The one primitive this module needs from the platform. Injectable for tests. */
export type AdvanceMeasurer = (text: string, style: AdvanceStyle) => number | null;

/** The CSS `font` shorthand for a style, in the order the spec requires. */
export function fontShorthand(style: AdvanceStyle): string {
  const family = style.mono ? CODE_FAMILY : style.fontStack;
  const size = style.mono ? style.fontSizePx * CODE_SIZE_RATIO : style.fontSizePx;
  const slant = style.italic ? 'italic ' : '';
  return `${slant}${style.fontWeight} ${size}px ${family}`;
}

const canvasAdvance: AdvanceMeasurer = (text, style) => {
  const ctx = measuringContext();
  if (!ctx) return null;
  /*
   * Assigning an unparseable font shorthand to a 2D context is a silent no-op:
   * the previous face stays in force and `measureText` answers about THAT font.
   * A stack from a settings document is not necessarily quotable, so the
   * assignment is checked rather than trusted — reporting one font's advances
   * as another's would put the plan quietly out of step with the glass.
   */
  ctx.font = SENTINEL_FONT;
  const rejected = ctx.font;
  ctx.font = fontShorthand(style);
  if (ctx.font === rejected) return null;
  let width: number;
  try {
    width = ctx.measureText(text).width;
  } catch {
    /*
     * Creating the context is already guarded; measuring through it was not.
     * A platform that throws here would throw inside a `$derived`, taking the
     * stage down over a line break — when the honest answer is the one every
     * other unmeasurable case gives: no measurement, so no plan.
     */
    return null;
  }
  if (!Number.isFinite(width)) return null;
  const spacing = Number.isFinite(style.letterSpacingPx) ? style.letterSpacingPx : 0;
  // By code point, not by `length`: an astral glyph is one character that CSS
  // spaces once, and UTF-16 counts it twice.
  return spacing === 0 ? width : width + [...text].length * spacing;
};

/* ---------------------------------------------------------------------------
 * The cache
 *
 * A script is re-planned when the font, the column or the text changes, and
 * never per frame — but one re-plan is thousands of `measureText` calls, and
 * ordinary English repeats its words heavily enough that a cache turns most of
 * them into a map lookup.
 * ------------------------------------------------------------------------- */

/** Enough for a long script in several styles; cleared wholesale past it. */
const MAX_CACHE_ENTRIES = 20_000;
const cache = new Map<string, number>();

export function styleKey(style: AdvanceStyle): string {
  // Letter spacing is part of the advance but not part of the font shorthand,
  // so a key built from the shorthand alone would serve one rig's widths to
  // another's.
  return `${fontShorthand(style)}|ls:${style.letterSpacingPx}`;
}

export function clearAdvanceCache(): void {
  cache.clear();
}

/**
 * The advance of `text` in `style`, or null if the platform will not measure.
 *
 * Cached on the exact string, so punctuation counts: "Monday" and "Monday," are
 * different keys because they are different widths, which is the whole reason
 * the breaker is given the rendered surface rather than a stripped word.
 */
export function measureAdvance(
  text: string,
  style: AdvanceStyle,
  measure?: AdvanceMeasurer,
): number | null {
  if (text.length === 0) return 0;
  /*
   * Only the real measurer is cached. The cache is keyed by face and text, not
   * by who did the measuring, so serving an injected measurer out of it would
   * hand one caller the answers another caller wrote.
   */
  if (measure !== undefined) return measure(text, style);
  const key = `${styleKey(style)}\u0000${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const width = canvasAdvance(text, style);
  if (width === null) return null;
  if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
  cache.set(key, width);
  return width;
}

/* ---------------------------------------------------------------------------
 * Marks → style
 * ------------------------------------------------------------------------- */

/** The style a run with `marks` is drawn in, given the block's base style. */
export function styleForMarks(
  base: AdvanceStyle,
  marks: readonly Mark[] | undefined,
): AdvanceStyle {
  if (!marks || marks.length === 0) return base;
  return {
    ...base,
    fontWeight: marks.includes('strong') ? STRONG_WEIGHT : base.fontWeight,
    italic: base.italic || marks.includes('em'),
    mono: base.mono || marks.includes('code'),
  };
}

/* ---------------------------------------------------------------------------
 * Flattening render nodes into words
 * ------------------------------------------------------------------------- */

/**
 * Whitespace CSS will neither break at nor collapse.
 *
 * JavaScript's `\s` matches all of these, which is why they have to be named:
 * splitting on `\s+` and calling every piece "a space" is what would let a plan
 * break a phrase its author deliberately welded together.
 */
const NON_BREAKING_SPACE = /[\u00A0\u202F\u2007\u2060\uFEFF]/;

/**
 * Inline content whose width this pass cannot account for.
 *
 * A cue chip has its own size, capitals, letter-spacing and padding; an image
 * has whatever the asset is; a nested table has columns. None of them is
 * measured here, so a block containing one is a block whose lines would be
 * planned against a width that is not the width being drawn. Those blocks are
 * handed back to the browser whole rather than planned wrongly.
 *
 * An inline `code` run is here for the same reason and a subtler cause: it is
 * text, and it does measure, but only against the 0.92em arm of the rule above.
 * The other arm is a runtime pixel value, so on the rigs where it wins the run
 * is wider than its measurement and the line it sits on is planned short.
 */
export function hasUnmeasurableInline(nodes: readonly SafeRenderNode[]): boolean {
  for (const node of nodes) {
    if (node.type === 'image' || node.type === 'cue' || node.type === 'table') return true;
    if (node.type === 'text' && node.marks?.includes('code')) return true;
    if (node.type === 'link' && hasUnmeasurableInline(node.label)) return true;
  }
  return false;
}

/**
 * One word of a block, with everything the planner and the renderer both need.
 *
 * `tokenIndex` is the JOIN between the two. The plan comes back as a set of
 * token indexes after which a line ends, and the renderer recognises them
 * without having to count words in the same order twice — counting twice is
 * exactly how a plan and a render drift apart, and drifting apart here means
 * the break lands one word from where it was planned.
 */
export interface FlatWord {
  text: string;
  tokenIndex: number | null;
  /**
   * Whitespace separates this word from the next one in the block.
   *
   * Load-bearing beyond width: the renderer can only put a break where there is
   * already a space to replace, so a word with no space after it is a word no
   * plan may break after. "**Candid**Cue" is two runs and one word.
   */
  spaceAfter: boolean;
  /**
   * That whitespace is somewhere CSS would actually break a line.
   *
   * Not the same question as `spaceAfter`, and the difference is an author's
   * instruction. JavaScript's `\s` matches U+00A0, CSS does not break at one,
   * and it does not collapse one either — so a plan that broke at a
   * non-breaking space would defy the author AND leave the surviving character
   * indenting the next line. Someone who typed "South Africa" with a
   * non-breaking space is asking for exactly what this feature is for.
   */
  breakableAfter: boolean;
  /**
   * The separator as it will be RENDERED, for measuring.
   *
   * Ordinary whitespace collapses to a single space however much of it there
   * is; a non-breaking run does not collapse at all and is drawn as written.
   */
  separatorText: string;
  /** An authored hard break (`line_break`) follows this word. */
  breakAfter: boolean;
  style: AdvanceStyle;
}

/**
 * Walk a block's render nodes and yield its words in rendered order.
 *
 * Mirrors what `InlineNodes.svelte` draws, and only what it draws: a link's
 * label is inline text and is walked into; an image, a cue chip and a table are
 * not part of the paragraph's line flow this planner is planning, so they end
 * the run rather than contributing a word to it.
 */
export function flattenWords(
  nodes: readonly SafeRenderNode[],
  base: AdvanceStyle,
): FlatWord[] {
  const words: FlatWord[] = [];

  const walk = (list: readonly SafeRenderNode[], style: AdvanceStyle): void => {
    for (const node of list) {
      if (node.type === 'text') {
        const parts = node.text.split(/(\s+)/);
        const runStyle = styleForMarks(style, node.marks);
        let wordIdx = 0;
        const wordCount = parts.filter((p, i) => i % 2 === 0 && p.length > 0).length;
        const byWord = resolveWordTokens(wordCount, node.tokenIndexes, node.wordTokens);
        for (const [i, part] of parts.entries()) {
          if (part.length === 0) continue;
          if (i % 2 === 1) {
            // Whitespace: it separates the word before it from the word after.
            const previous = words[words.length - 1];
            if (previous) {
              const breakable = !NON_BREAKING_SPACE.test(part);
              previous.spaceAfter = true;
              previous.breakableAfter = breakable;
              // Ordinary whitespace collapses to one space however much of it
              // there is; a non-breaking run is drawn exactly as written.
              previous.separatorText = breakable ? ' ' : part;
            }
            continue;
          }
          /*
           * Token identity comes from the same rule `segmentText` uses, out of
           * the same module — not a copy of it. The two must agree because the
           * plan is keyed on token index and the renderer draws the break by
           * looking that index up on a span.
           */
          words.push({
            text: part,
            tokenIndex: byWord[wordIdx] ?? null,
            spaceAfter: false,
            breakableAfter: false,
            separatorText: '',
            breakAfter: false,
            style: runStyle,
          });
          wordIdx++;
        }
      } else if (node.type === 'link') {
        walk(node.label, style);
      } else if (node.type === 'line_break') {
        /*
         * The renderer already draws a <br> here, so the line ends whatever the
         * plan says. Telling the planner is not optional bookkeeping: a solver
         * that thinks the words after this one continue the same line measures
         * a line that does not exist and plans the rest of the block against
         * it. `breakAfter` is the contract for exactly this.
         */
        const previous = words[words.length - 1];
        if (previous) previous.breakAfter = true;
      }
      /*
       * Everything else — an image, a cue chip, a table — is not a word and not
       * part of the line flow being planned.
       */
    }
  };

  walk(nodes, base);
  return words;
}
