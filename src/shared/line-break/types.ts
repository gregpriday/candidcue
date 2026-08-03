/**
 * The public shapes of the line breaker.
 *
 * Kept apart from the solver so the cost model, the lexicons and the verifier
 * can all name them without importing each other.
 */

/**
 * One visual word, as the stage will render it.
 *
 * `text` is the RENDERED surface including any punctuation attached to it
 * ("Monday,", "Australia."), because punctuation is the strongest evidence this
 * module has and stripping it upstream would throw that evidence away. It is
 * deliberately not `SpokenToken`: unspoken visual text (a cue chip's label, a
 * table cell) has to be laid out too, and carries no token index.
 */
export interface LineBreakToken {
  text: string;
  /**
   * The compiler's spoken-token index, when this word is one. Carried through
   * untouched — this module never reads it for any decision, it exists so the
   * caller can map a planned line back to the token stops it contains.
   */
  tokenIndex?: number | null;
  /**
   * Rendered with a space between this token and the next. Default true.
   *
   * Width bookkeeping only; it says nothing about whether a break is legal
   * there. Scripts that do not put spaces between words still break between
   * them, and a Latin run that genuinely may not break says so with
   * `noBreakAfter`.
   */
  spaceAfter?: boolean;
  /**
   * There is no break opportunity after this token — adjacent inline runs with
   * no space between them, or a span the caller has decided is atomic.
   */
  noBreakAfter?: boolean;
  /** An authored line break or the end of a block: a line MUST end here. */
  breakAfter?: boolean;
  /**
   * The rendered advance of this token, in the unit the measure is expressed
   * in. Defaults to `visualWidth(text)` — character cells.
   *
   * This is the seam that lets the same solver work in pixels. Character cells
   * are a decent proxy for a column sized by average advance and a poor one for
   * any INDIVIDUAL line: "Wow, William" and "illicit institution" are the same
   * number of cells and nowhere near the same number of pixels, and a planner
   * wrong by that much hands the browser a line it has to re-wrap. A caller
   * that can measure the real face passes what it measured and the plan is
   * about the text that will actually be drawn.
   */
  width?: number;
  /**
   * The rendered advance of the gap between this token and the next, same unit.
   * Defaults to 0 when `spaceAfter` is false and 1 otherwise.
   */
  separatorWidth?: number;
}

export interface LineBreakOptions {
  /**
   * The measure the plan aims for.
   *
   * In character cells unless the caller supplied `width` on its tokens, in
   * which case it is in whatever unit those widths are in — the solver never
   * inspects the unit, it only ever compares these numbers against those. The
   * name is historical and the pixel callers read it as "target measure".
   */
  targetChars?: number;
  /**
   * The measure the column can actually hold.
   *
   * A ceiling rather than a law: a line past it is penalised heavily enough
   * that it only happens when one indivisible run is wider than the column,
   * which is a fact about the text rather than a choice the solver made.
   */
  maxChars?: number;
  /**
   * The width below which a line reads as a hole rather than as a phrase.
   *
   * Never a hard floor — the whole point of a speech-aware breaker is that a
   * ten-character line ending on "…on Monday," is right. It is the threshold
   * for two judgements: how much a short mid-paragraph line costs GIVEN how
   * weak the seam that closed it was, and whether a closing line of one or two
   * words is stranded.
   */
  minChars?: number;
}

/**
 * What kind of seam the break that ends a line sits on.
 *
 * Diagnostic rather than load-bearing — nothing downstream branches on it — but
 * it is what makes a plan reviewable by a human and testable without asserting
 * on costs, which are tuning and will move.
 */
export type LineBreakReason =
  | 'sentence'
  | 'clause'
  | 'phrase'
  | 'measure'
  | 'glue'
  | 'forced'
  | 'end';

export interface LineBreakLine {
  /** Inclusive index range into the input tokens. */
  startIndex: number;
  endIndex: number;
  /** Rendered width, separators included, in the measure's unit. */
  widthChars: number;
  /** The line is wider than `maxChars` — always because nothing else fits. */
  overflow: boolean;
  reason: LineBreakReason;
}

export interface LineBreakPlan {
  lines: LineBreakLine[];
  /** The options the plan was actually solved with, after sanitization. */
  measure: { targetChars: number; maxChars: number; minChars: number };
  /** Total dynamic-program cost. Comparable only between plans of one input. */
  cost: number;
  /**
   * A stable digest of the plan.
   *
   * This is the value the stage folds into its layout fingerprint. A plan that
   * changed and a fingerprint that did not is the exact bug class the
   * fingerprint exists to prevent — the map gets replaced under the old
   * generation and the semantic re-anchor never runs.
   */
  signature: string;
  tokenCount: number;
}

/* ---------------------------------------------------------------------------
 * Measure defaults
 *
 * A prompter column is short. These are the fallbacks for a caller that has not
 * measured anything yet; a calibrated stage passes its own resolved measure and
 * these are never used.
 * ------------------------------------------------------------------------- */

export const LINE_BREAK_DEFAULTS = {
  targetChars: 38,
  /** ~12% of slack over the target, which is roughly one long word. */
  maxOverTargetRatio: 1.12,
  /** Half the target: under it, a mid-paragraph line reads as a hole. */
  minOverTargetRatio: 0.5,
} as const;
