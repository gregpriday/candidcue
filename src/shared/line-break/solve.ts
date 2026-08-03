/**
 * The solver: every legal break scored, the cheapest set chosen over the whole
 * paragraph.
 *
 * Choosing per line (greedy first-fit, which is what the browser does) cannot
 * trade a slightly short line now for a much better seam later, and that trade
 * is the entire point.
 */

import { hashString } from '../markdown/hash';
import { classifyBreak } from './cost';
import {
  BREAK_BASE,
  MEASURE_WEIGHT,
  ORPHAN_LINE_PENALTY,
  ORPHAN_SINGLE_WORD_MULTIPLIER,
  OVERFLOW_PENALTY,
  OVERFLOW_PER_CHAR,
  SHORT_LINE_PER_CHAR,
} from './cost';
import { describeWord, type WordFacts } from './lexicon';
import {
  LINE_BREAK_DEFAULTS,
  type LineBreakLine,
  type LineBreakOptions,
  type LineBreakPlan,
  type LineBreakReason,
  type LineBreakToken,
} from './types';
import { tokenSeparator, tokenWidth } from './width';

/**
 * The hard ceiling on how many atoms one line may be scanned across.
 *
 * The width test in the solver is the real bound and for ordinary text it is
 * the only one needed: a candidate line that has passed the column ends the
 * scan, so the work per line is bounded by the measure. It bounds nothing when
 * an atom occupies no width at all — a run of empty tokens (adjacent inline
 * runs that render to nothing, which a caller produces by accident rather than
 * on purpose) never passes the column, so the scan walks the whole document
 * for every line and the solve goes quadratic. A count no real line could
 * reach closes that without touching any plan the width test would have
 * allowed: 1,024 atoms is not a line at any measure a person reads from.
 *
 * In pixel mode this constant is the ONLY one of the two bounds that is finite
 * in the constant itself — `maxChars + 2` is hundreds of pixels — so it does
 * the whole job there. That is fine: the width test still stops the scan after
 * a dozen atoms for any text with width, and the ceiling only bites on the
 * zero-width pathology it was written for.
 */
const MAX_ATOMS_PER_LINE = 1024;

/**
 * A run of tokens that must stay on one line, and the unit the solver places.
 *
 * Usually exactly one token. It is more only where the caller said a break is
 * impossible — inline runs written with no space between them — and collapsing
 * those before the solve is what keeps the solver total: its smallest unit is
 * always placeable, so there is no such thing as an input it cannot answer.
 */
interface Atom {
  /** Inclusive token index range. */
  startIndex: number;
  endIndex: number;
  /** Rendered width, including any separators inside the run. */
  width: number;
  /** Separator between this atom and the next. */
  separator: number;
  /** An authored line break: a line MUST end here. */
  breakAfter: boolean;
  /** Facts of the last word — the left-hand side of the break that follows. */
  tail: WordFacts;
  /** Facts of the first word — the right-hand side of the break before it. */
  head: WordFacts;
}

function buildAtoms(tokens: readonly LineBreakToken[]): Atom[] {
  const atoms: Atom[] = [];
  let sentenceInitial = true;
  let open: Atom | null = null;
  for (const [index, token] of tokens.entries()) {
    const text = typeof token.text === 'string' ? token.text : '';
    const facts = describeWord(text, sentenceInitial);
    const width = tokenWidth(token);
    const separator = tokenSeparator(token);
    const forced = token.breakAfter === true;

    if (open) {
      open.endIndex = index;
      open.width += open.separator + width;
      open.separator = separator;
      open.breakAfter = forced;
      open.tail = facts;
    } else {
      open = {
        startIndex: index,
        endIndex: index,
        width,
        separator,
        breakAfter: forced,
        tail: facts,
        head: facts,
      };
      atoms.push(open);
    }
    /*
     * A forced break closes the atom whatever `noBreakAfter` says. The two are
     * a contradiction the caller can only produce by accident, and of the two
     * the authored line break is the one with an author behind it.
     */
    if (forced || token.noBreakAfter !== true) open = null;
    sentenceInitial = facts.endsSentence || forced;
  }
  return atoms;
}

function sanitizeMeasure(opts: LineBreakOptions | undefined): {
  targetChars: number;
  maxChars: number;
  minChars: number;
} {
  const raw = opts ?? {};
  const target =
    Number.isFinite(raw.targetChars) && (raw.targetChars as number) >= 1
      ? Math.round(raw.targetChars as number)
      : LINE_BREAK_DEFAULTS.targetChars;
  const maxCandidate =
    Number.isFinite(raw.maxChars) && (raw.maxChars as number) >= 1
      ? Math.round(raw.maxChars as number)
      : Math.round(target * LINE_BREAK_DEFAULTS.maxOverTargetRatio);
  // A max under the target is a caller contradiction, and the readable measure
  // is the one that has to survive it.
  const max = Math.max(target, maxCandidate);
  const minCandidate =
    Number.isFinite(raw.minChars) && (raw.minChars as number) >= 0
      ? Math.round(raw.minChars as number)
      : Math.round(target * LINE_BREAK_DEFAULTS.minOverTargetRatio);
  const min = Math.max(0, Math.min(target, minCandidate));
  return { targetChars: target, maxChars: max, minChars: min };
}

/**
 * A digest of the break positions and the measure they were solved for.
 *
 * Break positions only — not widths, not costs, not reasons. Those are derived
 * from the same decisions, and a fingerprint that moves when a tuning constant
 * moves would invalidate every cached layout on an upgrade that changed nothing
 * the presenter can see.
 */
function planSignature(
  lines: readonly LineBreakLine[],
  measure: { targetChars: number; maxChars: number; minChars: number },
  tokenCount: number,
): string {
  const breaks = lines.slice(0, -1).map((line) => line.endIndex);
  return hashString(
    `${tokenCount}|${measure.targetChars}:${measure.maxChars}:${measure.minChars}|${breaks.join(',')}`,
  );
}

/**
 * Plan where the lines of one paragraph break.
 *
 * O(n · k) where k is the number of tokens that fit in a line — the inner scan
 * stops the moment a candidate line passes the measure, so the work per token
 * is bounded by the column and not by the length of the script.
 */
export function breakLines(
  tokens: readonly LineBreakToken[],
  opts?: LineBreakOptions,
): LineBreakPlan {
  const measure = sanitizeMeasure(opts);
  const n = tokens.length;
  if (n === 0) {
    return {
      lines: [],
      measure,
      cost: 0,
      signature: planSignature([], measure, 0),
      tokenCount: 0,
    };
  }

  const atoms = buildAtoms(tokens);
  const count = atoms.length;

  /*
   * Prefix sums, so a candidate line's width is two subtractions rather than a
   * loop. Without them the inner scan is O(k) per candidate and the whole solve
   * goes quadratic in the column width for no reason.
   */
  const cumWidth = new Float64Array(count + 1);
  const cumSeparator = new Float64Array(count + 1);
  for (let i = 0; i < count; i++) {
    cumWidth[i + 1] = (cumWidth[i] ?? 0) + (atoms[i]?.width ?? 0);
    cumSeparator[i + 1] = (cumSeparator[i] ?? 0) + (atoms[i]?.separator ?? 0);
  }
  /** Width of atoms `from`..`to` inclusive, separators between them included. */
  const widthOf = (from: number, to: number): number =>
    (cumWidth[to + 1] ?? 0) -
    (cumWidth[from] ?? 0) +
    ((cumSeparator[to] ?? 0) - (cumSeparator[from] ?? 0));

  // The seam quality of every break point, computed once — it depends on the
  // pair of words either side and not on which line they end up in.
  const breakPenalties = new Float64Array(Math.max(0, count - 1));
  const breakReasons: LineBreakReason[] = new Array(Math.max(0, count - 1));
  for (let i = 0; i < count - 1; i++) {
    const before = atoms[i];
    const after = atoms[i + 1];
    const classified =
      before && after
        ? classifyBreak(before.tail, after.head, before.breakAfter)
        : { penalty: 0, reason: 'end' as LineBreakReason };
    breakPenalties[i] = classified.penalty;
    breakReasons[i] = classified.reason;
  }

  const best = new Float64Array(count + 1).fill(Number.POSITIVE_INFINITY);
  const from = new Int32Array(count + 1).fill(-1);
  best[0] = 0;

  /*
   * How far back a line may be scanned.
   *
   * The width test is the real bound; this is the backstop for atoms too narrow
   * for it to bite on. `maxChars + 2` assumed every atom occupies at least one
   * unit of width, which is true of character cells and NOT true once a caller
   * supplies measured advances normalised to an AVERAGE character: "i" and a
   * space are both a fraction of one, so a line can legitimately hold far more
   * atoms than the measure has units. Scanning only `maxChars + 2` of them
   * would stop short of a line that genuinely fits and force a break the
   * geometry never asked for.
   *
   * So the bound is derived from the narrowest atom actually present. Lines are
   * still bounded — by the fixed ceiling for the zero-width pathology the
   * constant was written for.
   */
  let narrowest = Number.POSITIVE_INFINITY;
  for (const atom of atoms) {
    const step = atom.width + atom.separator;
    if (step > 0 && step < narrowest) narrowest = step;
  }
  const scanWindow = Number.isFinite(narrowest)
    ? Math.min(Math.ceil(measure.maxChars / narrowest) + 2, MAX_ATOMS_PER_LINE)
    : // Nothing has any width at all, so no number of atoms passes the column
      // and there is no honest bound to derive. One unit per atom is the
      // assumption that was always being made here, and it keeps the quadratic
      // blow-up on a document of empty runs down to a window nobody notices.
      Math.min(measure.maxChars + 2, MAX_ATOMS_PER_LINE);

  for (let end = 1; end <= count; end++) {
    const isLastLine = end === count;
    // The seam that CLOSES this line. The document's own end is free.
    const closing = isLastLine ? 0 : (breakPenalties[end - 1] ?? 0);
    for (let start = end - 1; start >= 0 && end - start <= scanWindow; start--) {
      const width = widthOf(start, end - 1);
      // Always cost the single-atom line (start === end - 1) even when it
      // overflows: an indivisible run wider than the column has to go
      // somewhere, and this is the branch that guarantees `best[end]` is always
      // finite — and therefore that the solve always has an answer.
      if (width > measure.maxChars && start < end - 1) break;

      let cost = (best[start] ?? Number.POSITIVE_INFINITY) + closing;
      if (!Number.isFinite(cost)) break;

      if (width > measure.maxChars) {
        cost += OVERFLOW_PENALTY + OVERFLOW_PER_CHAR * (width - measure.maxChars);
      } else if (isLastLine) {
        /*
         * A last line pays nothing for being short — it is SUPPOSED to be, and
         * charging it turns every closing line into a reason to ruin the ones
         * above it. What it does pay for is being stranded: one or two words
         * under the minimum measure, alone at the left edge, is the failure a
         * presenter sees.
         *
         * It pays nothing for being LONG either, which is only safe because
         * `maxChars` is the ceiling and a caller sets it near the target. Hand
         * this a max far above the target and the closing line will run all
         * the way to it for free: the measure the caller passes is the only
         * thing holding the last line in.
         */
        const wordCount =
          (atoms[end - 1]?.endIndex ?? 0) - (atoms[start]?.startIndex ?? 0) + 1;
        if (wordCount <= 2 && width < measure.minChars) {
          cost +=
            ORPHAN_LINE_PENALTY * (wordCount === 1 ? ORPHAN_SINGLE_WORD_MULTIPLIER : 1);
        }
      } else {
        const deviation = (width - measure.targetChars) / measure.targetChars;
        cost += MEASURE_WEIGHT * deviation * deviation;
        if (width < measure.minChars) {
          // Weighted by the seam, not by the shortfall alone — see the note on
          // the constant. `closing` is 0 at a sentence end and BREAK_BASE at an
          // ordinary break, so this is "how much of a hole is this, given how
          // little reason there was to stop here".
          const weakness = Math.min(1, closing / BREAK_BASE);
          cost += SHORT_LINE_PER_CHAR * (measure.minChars - width) * weakness;
        }
      }

      // `<` and not `<=`: `start` walks downward from the shortest candidate
      // line, so the first plan scored wins a tie and ties keep the SHORTEST
      // line. Which of the two it is matters less than that it is fixed —
      // the plan is a fingerprint input, and two equal-cost plans that
      // alternate would churn the layout for no visible reason.
      if (cost < (best[end] ?? Number.POSITIVE_INFINITY)) {
        best[end] = cost;
        from[end] = start;
      }

      // A forced break may not sit inside a line. Lines STARTING at `start` are
      // fine, so this stops after scoring it rather than before.
      if (start > 0 && atoms[start - 1]?.breakAfter) break;
    }
  }

  /* Reconstruct backwards. The ranges are contiguous by construction — each
   * line starts where the previous one ended, and atoms tile the token stream —
   * which is what makes the "every token exactly once, in order" invariant
   * structural rather than something the cost model could accidentally violate.
   * The guard is for a `from` that was never written, which cannot happen
   * (`best[end]` is always finite) and would otherwise be an infinite loop
   * rather than a bug report. */
  const lines: LineBreakLine[] = [];
  let cursor = count;
  while (cursor > 0) {
    const recorded = from[cursor];
    const start =
      recorded === undefined || recorded < 0 || recorded >= cursor ? cursor - 1 : recorded;
    const width = widthOf(start, cursor - 1);
    lines.push({
      startIndex: atoms[start]?.startIndex ?? 0,
      endIndex: atoms[cursor - 1]?.endIndex ?? n - 1,
      widthChars: width,
      overflow: width > measure.maxChars,
      reason: cursor === count ? 'end' : (breakReasons[cursor - 1] ?? 'measure'),
    });
    cursor = start;
  }
  lines.reverse();

  const cost = best[count] ?? 0;
  return {
    lines,
    measure,
    cost: Number.isFinite(cost) ? cost : 0,
    signature: planSignature(lines, measure, n),
    tokenCount: n,
  };
}
