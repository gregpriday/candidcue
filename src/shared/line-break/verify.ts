/**
 * The invariant, as an executable check.
 *
 * The one unacceptable failure of this module is silent: a plan that drops,
 * duplicates or reorders a token changes what the presenter reads while every
 * test about break QUALITY still passes. This is exported rather than kept
 * private so the code that wires the breaker into the stage can assert it
 * against real compiled documents, which is where the shapes the solver has
 * never seen actually come from.
 */

import type { LineBreakLine, LineBreakPlan, LineBreakToken } from './types';
import { tokenSeparator, tokenWidth } from './width';

/**
 * How far two widths may differ and still be called equal.
 *
 * In character cells every width is an integer and any real disagreement is at
 * least 1, so this changes nothing. In pixels it is the difference between a
 * checker and a false alarm generator: the solver sums widths as prefix sums
 * and subtracts, this recomputes them by addition, and IEEE 754 does not
 * promise those two orders agree in the last bits. A checker that fires on the
 * fifteenth decimal place would be turned off within a day.
 */
function widthTolerance(width: number): number {
  return 1e-6 * Math.max(1, Math.abs(width));
}

/**
 * Everything wrong with a plan, as human-readable problems. Empty means valid.
 *
 * It returns problems instead of throwing, because a checker that can take the
 * stage down is worse than the bug it looks for.
 */
export function verifyLineBreakPlan(
  tokens: readonly LineBreakToken[],
  plan: LineBreakPlan,
): string[] {
  const problems: string[] = [];
  if (plan.tokenCount !== tokens.length) {
    problems.push(`tokenCount ${plan.tokenCount} does not match ${tokens.length} tokens`);
  }
  if (tokens.length === 0) {
    if (plan.lines.length > 0) problems.push('empty input produced lines');
    return problems;
  }

  let expected = 0;
  for (const [i, line] of plan.lines.entries()) {
    if (line.startIndex !== expected) {
      problems.push(`line ${i} starts at ${line.startIndex}, expected ${expected}`);
    }
    if (line.endIndex < line.startIndex) {
      problems.push(`line ${i} is empty (${line.startIndex}..${line.endIndex})`);
    }
    expected = line.endIndex + 1;

    /*
     * Recomputed straight from the tokens rather than read back from the
     * solver's prefix sums, so this catches the two of them disagreeing. The
     * width is what a caller sizes a line box against; a plan whose reported
     * width is wrong wraps that box a second time inside itself, which puts a
     * line on the glass nobody planned.
     */
    let width = 0;
    for (let t = line.startIndex; t <= line.endIndex && t < tokens.length; t++) {
      const token = tokens[t];
      if (!token) continue;
      width += tokenWidth(token);
      if (t < line.endIndex) width += tokenSeparator(token);
    }
    const tolerance = widthTolerance(width);
    if (Math.abs(width - line.widthChars) > tolerance) {
      problems.push(`line ${i} reports width ${line.widthChars}, tokens measure ${width}`);
    }
    const overflows = width > plan.measure.maxChars;
    // Only a disagreement the tolerance cannot explain is a disagreement: a
    // line sitting exactly on the ceiling is decided by the last bit otherwise.
    if (
      line.overflow !== overflows &&
      Math.abs(width - plan.measure.maxChars) > tolerance
    ) {
      problems.push(`line ${i} reports overflow ${line.overflow} at width ${width}`);
    }
  }
  if (expected !== tokens.length) {
    problems.push(`plan covers ${expected} of ${tokens.length} tokens`);
  }

  for (let i = 0; i < plan.lines.length - 1; i++) {
    const line = plan.lines[i];
    if (!line || line.endIndex >= tokens.length - 1) continue;
    // Unreachable by construction — a forbidden break is inside an atom, and
    // the solver only ever breaks between them. Checked anyway, because "the
    // atoms tile the token stream" is the assumption the whole invariant rests
    // on, and an assumption nothing tests is a comment.
    if (tokens[line.endIndex]?.noBreakAfter && !tokens[line.endIndex]?.breakAfter) {
      problems.push(`line ${i} breaks after token ${line.endIndex}, which forbids a break`);
    }
  }
  /*
   * Line ends collected once rather than rescanned per token.
   *
   * The inner `.some()` made this quadratic in the one input that maximises
   * both terms — a script where most tokens carry `breakAfter` — so a
   * 5,000-token document with a forced break on every token did about twelve
   * million comparisons. Nothing in the timed tests reaches that shape, which
   * is precisely why it survived.
   */
  const lineEnds = new Set(plan.lines.map((line) => line.endIndex));
  for (const [i, token] of tokens.entries()) {
    if (!token.breakAfter || i === tokens.length - 1) continue;
    if (!lineEnds.has(i)) {
      problems.push(`forced break after token ${i} was not honoured`);
    }
  }
  return problems;
}

/**
 * The tokens of one line, in order — the mapping every caller needs and none
 * should write twice.
 */
export function tokensForLine<T>(items: readonly T[], line: LineBreakLine): T[] {
  return items.slice(line.startIndex, line.endIndex + 1);
}
