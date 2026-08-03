/**
 * Is the planned wrap actually better than the browser's?
 *
 * ---------------------------------------------------------------------------
 * WHY THE JUDGE IS WRITTEN OUT AGAIN HERE
 * ---------------------------------------------------------------------------
 * Scoring the plan with the solver's own cost model would prove only that the
 * solver minimises the solver. The lists below are therefore a SECOND, blunter
 * statement of what a bad line ending is, written from the research rather than
 * from the implementation: a line that ends on a function word leaves the eye
 * to sweep back carrying an incomplete phrase, and a line that splits a name or
 * a number from its unit is the failure a presenter hears themselves make.
 *
 * They overlap with `line-break/lexicon.ts` because both describe the same
 * closed classes of English — there is only one set of English articles. What
 * is independent is the SCORING: this file never reads a penalty, a cost or a
 * reason, only the words a line happens to end on.
 *
 * Measured in character cells, because node has no canvas. That is fine for a
 * comparison: both wraps are measured the same way, so the difference between
 * them is about where the breaks went and not about how wide anything is.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { breakLines, visualWidth, type LineBreakToken } from '../../../src/shared/line-break';

const SCRIPTS_DIR = join(process.cwd(), 'bench', 'scripts');

/** A line that ends on one of these leaves a phrase hanging over the sweep. */
const HANGING = new Set([
  // articles and determiners
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'my', 'your', 'our',
  'their', 'his', 'her', 'its', 'each', 'every', 'some', 'any',
  // prepositions
  'of', 'in', 'on', 'at', 'to', 'for', 'with', 'from', 'by', 'into', 'onto',
  'over', 'under', 'between', 'through', 'during', 'about', 'across', 'within',
  'without', 'toward', 'towards', 'via', 'per', 'near', 'around',
  // auxiliaries and modals
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'has', 'have',
  'had', 'do', 'does', 'did', 'will', 'would', 'shall', 'should', 'can',
  'could', 'may', 'might', 'must',
  // coordinators and subordinators
  'and', 'or', 'but', 'nor', 'so', 'yet', 'because', 'although', 'though',
  'while', 'if', 'unless', 'since', 'when', 'where', 'than', 'as',
  // subject pronouns
  'i', 'you', 'he', 'she', 'it', 'we', 'they',
]);

const UNITS = new Set([
  'percent', 'million', 'billion', 'thousand', 'hundred', 'dollars', 'pounds',
  'euros', 'seconds', 'minutes', 'hours', 'days', 'weeks', 'months', 'years',
  'times', 'people', 'kilometres', 'miles', 'hours', 'x',
]);

const NUMBER = /^[$£€]?\d/;
const CAPITAL = /^[A-Z]/;
const SENTENCE_END = /[.!?]["'”’)\]]*$/;

function core(word: string): string {
  return word.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '').toLowerCase();
}

interface Score {
  lines: number;
  /** Lines ending on a function word. */
  hanging: number;
  /** Lines that put a number and its unit on different lines. */
  splitUnits: number;
  /** Lines that split what is probably one proper name. */
  splitNames: number;
  /** Mean absolute deviation from the target measure, interior lines only. */
  ragged: number;
  /** Interior lines under half the measure. */
  holes: number;
  /** Paragraphs whose last line is one short word. */
  orphans: number;
  /**
   * Paragraphs whose last line is badly under-filled, at ANY word count.
   *
   * The orphan rule only reaches one or two words, so raising the raggedness
   * weight can push a paragraph into a closing line of three or four words at a
   * fifth of the column while every counter above stays flat — a retune that
   * measured as an improvement did exactly that, turning "which makes the
   * public parts more honest, not less." into "honest, not less.". This is the
   * counter that would have caught it.
   */
  closingHoles: number;
  overflow: number;
}

/** Score a wrap given as arrays of words per line. */
function score(paragraphs: string[][][], target: number, max: number): Score {
  const s: Score = {
    lines: 0, hanging: 0, splitUnits: 0, splitNames: 0,
    ragged: 0, holes: 0, orphans: 0, closingHoles: 0, overflow: 0,
  };
  let deviation = 0;
  let interior = 0;

  for (const lines of paragraphs) {
    for (const [i, words] of lines.entries()) {
      s.lines++;
      const width = visualWidth(words.join(' '));
      if (width > max) s.overflow++;
      const last = words[words.length - 1] ?? '';
      const isLast = i === lines.length - 1;

      if (!isLast) {
        const next = lines[i + 1]?.[0] ?? '';
        if (HANGING.has(core(last))) s.hanging++;
        if (NUMBER.test(last) && UNITS.has(core(next))) s.splitUnits++;
        /*
         * A name split: both sides capitalised, and the left-hand word is not
         * the one that opens a sentence (where a capital means nothing) and
         * does not itself end one.
         */
        const previous = words[words.length - 2];
        const midSentence = i > 0 || (previous !== undefined && !SENTENCE_END.test(previous));
        if (midSentence && CAPITAL.test(last) && CAPITAL.test(next) && !SENTENCE_END.test(last)) {
          s.splitNames++;
        }
        deviation += Math.abs(width - target);
        interior++;
        if (width < target * 0.5) s.holes++;
      } else if (lines.length > 1) {
        if (words.length === 1 && width < target * 0.5) s.orphans++;
        // Word count deliberately not considered — that is the gap this counts.
        if (width < target * 0.4) s.closingHoles++;
      }
    }
  }
  s.ragged = interior > 0 ? deviation / interior : 0;
  return s;
}

/** What the browser does: take the last word that fits. */
function greedyWrap(words: string[], max: number): string[][] {
  const lines: string[][] = [];
  let current: string[] = [];
  let width = 0;
  for (const word of words) {
    const w = visualWidth(word);
    const added = current.length === 0 ? w : w + 1;
    if (current.length > 0 && width + added > max) {
      lines.push(current);
      current = [word];
      width = w;
    } else {
      current.push(word);
      width += added;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

/**
 * The wrap the stage actually ships, in cells.
 *
 * Target and ceiling are both the column, which is what `wrap-plan.ts` passes:
 * the column is a hard limit the renderer cannot exceed, so aiming below it
 * would only be a second, quieter ceiling.
 */
function plannedWrap(words: string[], column: number): string[][] {
  const tokens: LineBreakToken[] = words.map((text) => ({ text }));
  const plan = breakLines(tokens, {
    targetChars: column,
    maxChars: column,
    minChars: Math.round(column * 0.5),
  });
  return plan.lines.map((line) => words.slice(line.startIndex, line.endIndex + 1));
}

/** Paragraphs of a fixture script, as word arrays. Markdown syntax stripped. */
function paragraphsOf(markdown: string): string[][] {
  return markdown
    .split(/\n\s*\n/)
    .map((block) =>
      block
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/^[-*+]\s+/gm, '')
        .replace(/^>\s?/gm, '')
        .replace(/[*_`]/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .trim(),
    )
    .filter((block) => block.length > 0 && !block.startsWith(':::') && !block.startsWith('|'))
    .map((block) => block.split(/\s+/).filter(Boolean))
    .filter((words) => words.length >= 8);
}

const FIXTURES = readdirSync(SCRIPTS_DIR)
  .filter((f) => f.endsWith('.md'))
  .map((f) => ({ name: f.replace(/\.md$/, ''), text: readFileSync(join(SCRIPTS_DIR, f), 'utf8') }))
  .map((f) => ({ ...f, paragraphs: paragraphsOf(f.text) }))
  .filter((f) => f.paragraphs.length > 0);

/** Columns a real rig lands on, narrow to wide, in characters. */
const MEASURES = [32, 42, 54];

describe('planned wrapping against the browser, on the benchmark scripts', () => {
  it('has fixtures to measure', () => {
    expect(FIXTURES.length).toBeGreaterThan(5);
  });

  const totals = { planned: 0, greedy: 0 };

  it.each(MEASURES)('is a better read at a %i-character column', (target) => {
    const max = target;
    const rows: string[] = [];
    let plannedBad = 0;
    let greedyBad = 0;
    let plannedLines = 0;
    let greedyLines = 0;

    for (const fixture of FIXTURES) {
      const planned = score(
        fixture.paragraphs.map((w) => plannedWrap(w, target)),
        target,
        max,
      );
      const greedy = score(
        fixture.paragraphs.map((w) => greedyWrap(w, max)),
        target,
        max,
      );
      const pBad = planned.hanging + planned.splitUnits + planned.splitNames;
      const gBad = greedy.hanging + greedy.splitUnits + greedy.splitNames;
      plannedBad += pBad;
      greedyBad += gBad;
      plannedLines += planned.lines;
      greedyLines += greedy.lines;

      rows.push(
        `  ${fixture.name.padEnd(15)} ` +
          `bad ${String(gBad).padStart(3)}→${String(pBad).padStart(3)}  ` +
          `hang ${String(greedy.hanging).padStart(3)}→${String(planned.hanging).padStart(3)}  ` +
          `names ${String(greedy.splitNames).padStart(2)}→${String(planned.splitNames).padStart(2)}  ` +
          `units ${String(greedy.splitUnits).padStart(2)}→${String(planned.splitUnits).padStart(2)}  ` +
          `ragged ${greedy.ragged.toFixed(1)}→${planned.ragged.toFixed(1)}  ` +
          `lines ${greedy.lines}→${planned.lines}  ` +
          `orphans ${greedy.orphans}→${planned.orphans}`,
      );
    }

    const drop = (100 * (greedyBad - plannedBad)) / Math.max(1, greedyBad);
    console.log(
      `\n=== measure ${target} (max ${max}) — greedy → planned ===\n` +
        rows.join('\n') +
        `\n  TOTAL bad seams ${greedyBad} → ${plannedBad}  (${drop.toFixed(1)}% fewer)` +
        `\n  TOTAL lines     ${greedyLines} → ${plannedLines}` +
        ` (${((100 * (plannedLines - greedyLines)) / greedyLines).toFixed(1)}% more)`,
    );

    totals.planned += plannedBad;
    totals.greedy += greedyBad;

    /*
     * The point of the feature, and it is not a marginal win: the seams the
     * research names are the ones greedy wrapping hits most often, and the plan
     * removes about 94% of them across every fixture and every column. The
     * guard sits at 20% remaining — far enough below the measured 5-6% to be a
     * regression alarm rather than a restatement of today's number.
     */
    expect(plannedBad).toBeLessThan(greedyBad * 0.2);

    /*
     * What it costs, stated rather than hidden: better seams are bought with
     * shorter lines, and every extra line is another return sweep. Measured at
     * 11-15% more lines depending on the column.
     *
     * That number is the whole reason `MEASURE_WEIGHT` and
     * `SHORT_LINE_WEAKNESS_FLOOR` are where they are — it started at 14-21%,
     * which reads on a real stage as the prompter fidgeting with the script
     * rather than as better phrasing. It does not go much lower without the
     * model splitting number-units and pronoun-verb pairs at narrow columns,
     * which is a worse failure than a short line; see the ceiling documented on
     * `MEASURE_WEIGHT` and the note where a per-line toll was tried and
     * rejected, both in `line-break/cost.ts`.
     */
    expect(plannedLines).toBeLessThanOrEqual(Math.ceil(greedyLines * 1.18));
  });

  it('never plans a line past the column', () => {
    for (const target of MEASURES) {
      // The column IS the ceiling, exactly as `plannedWrap` and the stage pass
      // it. Checking against a 12%-wider max would have been checking a limit
      // the plan was never solved against, and would pass a line that overflows.
      const max = target;
      for (const fixture of FIXTURES) {
        for (const words of fixture.paragraphs) {
          for (const line of plannedWrap(words, target)) {
            // The only permitted exception is a single word wider than the
            // whole column, which no plan can help.
            if (visualWidth(line.join(' ')) > max) expect(line).toHaveLength(1);
          }
        }
      }
    }
  });

  it('strands fewer closing lines than the browser', () => {
    let planned = 0;
    let greedy = 0;
    let plannedHoles = 0;
    let greedyHoles = 0;
    for (const target of MEASURES) {
      const max = target;
      for (const fixture of FIXTURES) {
        const p = score(fixture.paragraphs.map((w) => plannedWrap(w, target)), target, max);
        const g = score(fixture.paragraphs.map((w) => greedyWrap(w, max)), target, max);
        planned += p.orphans;
        greedy += g.orphans;
        plannedHoles += p.closingHoles;
        greedyHoles += g.closingHoles;
      }
    }
    console.log(
      `\n  stranded closing lines: greedy ${greedy} → planned ${planned}` +
        `\n  under-filled closing lines (any word count): greedy ${greedyHoles} → planned ${plannedHoles}`,
    );
    expect(planned).toBeLessThanOrEqual(greedy);
    /*
     * The counter the orphan rule cannot see: it reaches one or two words, and
     * raising the raggedness weight fills the second-to-last line and dumps
     * three or four into the remainder.
     *
     * Reported honestly as a LOOSE guard. It is worth having and it is not a
     * tight gate: the retune that produced "honest, not less." where "which
     * makes the public parts more honest, not less." would have fitted moved
     * this corpus total by one, well inside the browser's own margin. Read the
     * printed number when retuning; do not assume a green test means the
     * closing lines are unchanged.
     */
    expect(plannedHoles).toBeLessThanOrEqual(greedyHoles);
  });
});
