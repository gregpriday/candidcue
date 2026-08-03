/**
 * Speech-aware line breaking.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS MODULE EXISTS
 * ---------------------------------------------------------------------------
 * A browser breaks a line at the last space that fits. That is the correct
 * answer for a paragraph somebody reads silently at their own pace, and the
 * wrong one for a prompter, where the break position is a PERFORMANCE decision:
 * the eye returns to the left edge at a phrase boundary far more comfortably
 * than in the middle of a clause, and a line that ends on "the", on "will", or
 * on a first name forces a recovery the viewer can see and hear.
 *
 * So the break is chosen rather than discovered. Every legal break point is
 * scored — how far the line lands from the reading measure, and what kind of
 * seam the break sits on — and a dynamic program picks the cheapest set of
 * breaks over the whole paragraph. Choosing per line (greedy first-fit, which
 * is what the browser does) cannot trade a slightly short line now for a much
 * better seam later, and that trade is the entire point.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE IS NOT ALLOWED TO DO
 * ---------------------------------------------------------------------------
 * It decides WHERE LINES BREAK. Nothing else. It never reorders, merges,
 * splits, inserts or drops a token, because the compiler is the single source
 * of spoken tokens and the aligner's indices are the compiler's indices — a
 * breaker that changed the token sequence would move the reader's position in
 * the script, which is the one thing the display must never do.
 * `verifyLineBreakPlan` states that invariant as an executable check.
 *
 * It is also DETERMINISTIC and PURE: no DOM, no clock, no randomness, no
 * network, no model. Same tokens and same options give the same plan on every
 * machine and in every process, which is what lets the plan be a layout
 * fingerprint input rather than a source of layout churn.
 *
 * And it is TOTAL. Empty input, a single token, one token longer than the whole
 * measure, or text with no legal break anywhere all produce a valid plan. There
 * is no input for which it throws, and no input for which it loops: a run that
 * may not break is merged into one indivisible ATOM before the solve, so the
 * smallest thing the solver has to place is always placeable — on its own line,
 * overflowing, if that is what the text is — and the dynamic program always has
 * an answer to return.
 *
 * The heuristics are English-shaped and openly so. On text they do not
 * understand — CJK, Arabic, Hebrew, anything without spaces — none of the
 * lexical rules fire, every break scores the same, and the plan degrades to
 * pure measure-based wrapping. That is the correct failure: worse than a
 * language-aware breaker, identical to what the browser would have done.
 *
 * ---------------------------------------------------------------------------
 * WHAT UNIT THE MEASURE IS IN
 * ---------------------------------------------------------------------------
 * Character cells by default, because that is all a caller with no DOM can
 * offer. A caller that can measure the rendered face puts real advances on the
 * tokens (`width`, `separatorWidth`) and expresses the measure in the same
 * unit; the solver compares the two and never asks which it is holding. The
 * stage measures pixels — see `src/stage/renderer/advance.ts` — because cells
 * are a fair estimate of a COLUMN and a poor estimate of any individual line.
 */

export { breakLines } from './solve';
export { tokensForLine, verifyLineBreakPlan } from './verify';
export { tokenSeparator, tokenWidth, visualWidth } from './width';
export {
  LINE_BREAK_DEFAULTS,
  type LineBreakLine,
  type LineBreakOptions,
  type LineBreakPlan,
  type LineBreakReason,
  type LineBreakToken,
} from './types';
