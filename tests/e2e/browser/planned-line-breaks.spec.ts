import { test, expect, type Page } from '@playwright/test';
import { FONT_METRICS_PROSE_SAMPLE } from '../../../src/stage/renderer/fontMetrics';
import { MIN_PLANNED_COLUMN_CHARS } from '../../../src/stage/renderer/wrap-plan';

/**
 * The chosen line breaks, on glass, in a real engine.
 *
 * BOUNDARY: this is the stage renderer driven through `/stage.html?preview=1`,
 * the same local-bus preview `stage-preview.spec.ts` uses. What it adds is the
 * one thing no node or jsdom test can reach — a REAL text engine. Everything
 * upstream of here measures with an injected function or not at all, because
 * jsdom has no canvas; here the advances come from the browser measuring the
 * face it is about to draw, which is the entire premise of the feature.
 *
 * TWO REGIMES, BECAUSE THE PRODUCT HAS TWO
 * ----------------------------------------
 * The planner only runs on a column of at least `MIN_PLANNED_COLUMN_CHARS`
 * (`wrap-plan.ts` has the measurement behind that floor). Below it the stage
 * deliberately leaves wrapping to the browser — and every prompter take under
 * the automatic profile is below it, which is why the default calibrated
 * preview can no longer stand in for "a column that plans". So each regime
 * gets a fixture whose geometry is known, and each proves it is in the regime
 * it claims before anything else is asserted:
 *
 * - WIDE: the uncalibrated preview (the flat 64px fallback on a big monitor,
 *   where the feature was first judged good) at 2400x1200 — about 60
 *   characters, clear of the floor by a margin rather than a rounding error.
 *   Here the safety claim holds exactly. The stage plans a line and then leaves
 *   every other space breakable, so a plan that misjudged a width does not
 *   overflow — the browser quietly wraps it, and the line the presenter reads
 *   is the greedy one the planner exists to replace. That failure is invisible
 *   by design, which is exactly why it needs a test: "every rendered line
 *   boundary is one the planner chose" distinguishes a working planner from one
 *   whose output is being silently corrected.
 *
 * - NARROW: the same preview at 1280x720 and then 960x720, both under the
 *   floor. Nothing is planned and the browser's greedy wrap is the intended
 *   output, so a line ending on "the" is expected here and the hanging-word
 *   claim does not apply. What does apply is the fallback's own promise: no
 *   planned break survives, and every line stays inside its column — before a
 *   resize and after it.
 */

const PREVIEW_URL = '/stage.html?preview=1&calibrated=0';
const WIDE = { width: 2400, height: 1200 };
const NARROW = { width: 1280, height: 720 };
const NARROWER = { width: 960, height: 720 };

/**
 * How far above the floor the wide fixture must sit, in characters.
 *
 * 1920 wide clears it by about two characters, which a font-metrics change could
 * erase without anybody touching this file. Asserting the margin turns that
 * drift into a failure that names the fixture instead of the planner.
 */
const WIDE_CLEARANCE_CHARS = 8;

/** `COLUMN_SAFETY_MARGIN_PX` in `wrap-plan.ts`: the gate measures the column less this. */
const COLUMN_SAFETY_MARGIN_PX = 2;

/** Sub-pixel rounding between a line's fragments and the box it sits in. */
const TOLERANCE_PX = 1;

interface Bounds {
  left: number;
  right: number;
  width: number;
}

/** One rendered line: the tokens sharing it, in order, and its horizontal extent. */
interface RenderedLine {
  words: string[];
  left: number;
  right: number;
}

interface MeasuredBlock {
  id: string;
  lines: RenderedLine[];
  plannedBreaks: number;
  /** The content box of the block's prose — narrower than the column for a list or a quote. */
  content: Bounds;
}

interface StageSnapshot {
  column: Bounds;
  /** The column in the planner's own units, or NaN when the face could not be measured. */
  columnChars: number;
  /** Planned breaks anywhere in the column, not only in the blocks measured below. */
  plannedBreaks: number;
  blocks: MeasuredBlock[];
}

/**
 * Everything the assertions read, taken in ONE synchronous pass.
 *
 * The preview keeps moving the script, so two evaluations could disagree about
 * which blocks are rendered. Lines are the lines the ENGINE produced, grouped
 * from each token's own client rects by vertical overlap rather than from any
 * markup we emitted — overlap rather than a rounded `top`, because a span in a
 * different face (bold, italic) sits a sub-pixel off its neighbours' baseline.
 */
async function snapshot(page: Page): Promise<StageSnapshot> {
  return page.evaluate(
    ({ sample, marginPx }) => {
      const px = (value: string) => Number.parseFloat(value) || 0;
      const contentBounds = (el: Element) => {
        const rect = el.getBoundingClientRect();
        const css = getComputedStyle(el);
        const left = rect.left + px(css.borderLeftWidth) + px(css.paddingLeft);
        const right = rect.right - px(css.borderRightWidth) - px(css.paddingRight);
        return { left, right, width: right - left };
      };

      const columnEl = document.querySelector('.stage-root .column');
      if (!columnEl) throw new Error('the stage rendered no .column');
      const column = contentBounds(columnEl);

      /*
       * The column in characters, measured the way the gate measures it: the
       * width less the safety margin, over the average advance of the same
       * prose sample in the face the column is drawn in. An unparseable font
       * assignment is a silent no-op on a 2D context, so it is checked.
       */
      let columnChars = Number.NaN;
      const ctx = document.createElement('canvas').getContext('2d');
      if (ctx) {
        const css = getComputedStyle(columnEl);
        ctx.font = '10px monospace';
        const rejected = ctx.font;
        ctx.font = `${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
        if (ctx.font !== rejected) {
          const count = [...sample].length;
          // 'normal' parses to NaN, which is no spacing at all.
          const spacing = px(css.letterSpacing);
          const cell = (ctx.measureText(sample).width + count * spacing) / count;
          if (cell > 0) columnChars = (column.width - marginPx) / cell;
        }
      }

      /*
       * Exactly the kinds `wrap-plan.ts` plans, identified by the `k-{kind}`
       * class `BlockView` puts on the wrapper. Selecting on the inner container
       * instead would sweep up headings and `:::silent` blocks, which render
       * through `.para` and `.heading` but are deliberately NOT planned — their
       * rendered size is not something the planning pass can reproduce — so the
       * line-count identity does not hold for them.
       */
      const blocks: {
        id: string;
        lines: { words: string[]; left: number; right: number; top: number; bottom: number }[];
        plannedBreaks: number;
        content: { left: number; right: number; width: number };
      }[] = [];
      for (const block of Array.from(
        columnEl.querySelectorAll('.k-paragraph, .k-list_item, .k-blockquote'),
      )) {
        const prose = block.querySelector('.para, .quote, .list-body');
        if (!prose) continue;
        const spans = Array.from(prose.querySelectorAll<HTMLElement>('[data-t]'));
        if (spans.length === 0) continue;

        const lines: (typeof blocks)[number]['lines'] = [];
        for (const span of spans) {
          const word = span.textContent ?? '';
          for (const rect of Array.from(span.getClientRects())) {
            if (rect.width === 0 && rect.height === 0) continue;
            const line = lines[lines.length - 1];
            const overlap = line
              ? Math.min(line.bottom, rect.bottom) - Math.max(line.top, rect.top)
              : 0;
            if (line && overlap > 0.5 * Math.min(line.bottom - line.top, rect.height)) {
              line.words.push(word);
              line.left = Math.min(line.left, rect.left);
              line.right = Math.max(line.right, rect.right);
              line.top = Math.min(line.top, rect.top);
              line.bottom = Math.max(line.bottom, rect.bottom);
            } else {
              lines.push({
                words: [word],
                left: rect.left,
                right: rect.right,
                top: rect.top,
                bottom: rect.bottom,
              });
            }
          }
        }

        blocks.push({
          id: block.getAttribute('data-block-id') ?? '',
          lines,
          plannedBreaks: prose.querySelectorAll('br[data-planned-break]').length,
          content: contentBounds(prose),
        });
      }

      return {
        column,
        columnChars,
        plannedBreaks: columnEl.querySelectorAll('br[data-planned-break]').length,
        blocks: blocks.map((b) => ({
          ...b,
          lines: b.lines.map(({ words, left, right }) => ({ words, left, right })),
        })),
      };
    },
    { sample: FONT_METRICS_PROSE_SAMPLE, marginPx: COLUMN_SAFETY_MARGIN_PX },
  );
}

/**
 * Open the uncalibrated preview at a known size, with the stage face loaded.
 *
 * The viewport is set BEFORE navigation so the first layout is already the
 * fixture's. Fonts settle before anything is measured: a plan made against the
 * fallback face is a plan for a font nobody is looking at, and the stage
 * re-plans when `document.fonts.ready` resolves. `ready` alone only covers
 * loads already pending, so the face is asked for explicitly — and a load that
 * matched nothing fails here rather than leaving every number below describing
 * a fallback.
 */
async function openPreview(page: Page, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await page.goto(PREVIEW_URL);
  const root = page.locator('.stage-root');
  await expect(root).toHaveAttribute('data-phase', 'live');
  await expect(root.getByText('Welcome back to the channel.')).toBeVisible();

  const faces = await page.evaluate(async (sample) => {
    const loaded = await document.fonts.load('500 64px "Atkinson Hyperlegible Next"', sample);
    await document.fonts.ready;
    return loaded.length;
  }, FONT_METRICS_PROSE_SAMPLE);
  expect(faces, 'the stage face never loaded, so every width here would be a fallback').toBeGreaterThan(0);
}

/** Every line of a block inside both its own prose box and the column. */
function expectLinesInside(block: MeasuredBlock, column: Bounds) {
  block.lines.forEach((line, i) => {
    const where = `block ${block.id} line ${i + 1} ("${line.words.join(' ')}")`;
    for (const [name, box] of [
      ['its prose box', block.content],
      ['the column', column],
    ] as const) {
      expect(line.left, `${where} starts left of ${name}`).toBeGreaterThanOrEqual(
        box.left - TOLERANCE_PX,
      );
      expect(line.right, `${where} runs past ${name}`).toBeLessThanOrEqual(box.right + TOLERANCE_PX);
    }
  });
}

/** Function words a line must not end on. */
const HANGING = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'my', 'your', 'our', 'their',
  'of', 'in', 'on', 'at', 'to', 'for', 'with', 'from', 'by', 'into', 'over', 'under',
  'is', 'are', 'was', 'were', 'be', 'been', 'has', 'have', 'had', 'will', 'would',
  'can', 'could', 'should', 'and', 'or', 'but', 'because', 'while', 'if', 'when',
  'i', 'you', 'he', 'she', 'it', 'we', 'they',
]);

const core = (word: string) =>
  word.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '').toLowerCase();

/**
 * The wide fixture, planned.
 *
 * The column is asserted first, so a fixture that has drifted under the floor
 * reports that rather than "nothing planned"; then the planner must have
 * planned something, which is the claim the identity below rests on — over zero
 * planned blocks it would prove nothing.
 */
async function openPlannedColumn(page: Page): Promise<StageSnapshot> {
  await openPreview(page, WIDE);
  const first = await snapshot(page);
  expect(
    first.columnChars,
    `the wide fixture must clear the ${MIN_PLANNED_COLUMN_CHARS}-character floor with room to spare`,
  ).toBeGreaterThanOrEqual(MIN_PLANNED_COLUMN_CHARS + WIDE_CLEARANCE_CHARS);

  // Zero here, on a column this wide, means the measurement path returned null
  // and the whole feature is silently inert — the failure this spec exists for.
  await expect
    .poll(async () => (await snapshot(page)).plannedBreaks, {
      message: 'a column this wide must plan at least one break',
    })
    .toBeGreaterThan(0);

  const shot = await snapshot(page);
  expect(shot.blocks.length).toBeGreaterThan(0);
  expect(shot.blocks.filter((b) => b.plannedBreaks > 0).length).toBeGreaterThan(0);
  return shot;
}

test.describe('a column wide enough to plan', () => {
  test('the stage renders the lines it planned, and no others', async ({ page }, testInfo) => {
    const shot = await openPlannedColumn(page);

    for (const block of shot.blocks) {
      /*
       * THE SAFETY CLAIM, over every planned kind — not only the blocks that
       * carry a break. A block with N planned breaks must render N+1 lines, and
       * that includes N = 0: a block the planner judged to fit on one line and
       * the browser wrapped anyway is the same misjudged width as a planned line
       * that re-wrapped. A greater count means the presenter is reading a greedy
       * break that no cost model chose.
       */
      expect(
        block.lines.length,
        `block ${block.id} planned ${block.plannedBreaks} breaks but rendered ${block.lines.length} lines`,
      ).toBe(block.plannedBreaks + 1);

      // And nothing ran past the column it was planned against.
      expectLinesInside(block, shot.column);
    }

    await page.screenshot({
      path: testInfo.outputPath('planned-line-breaks.png'),
      fullPage: false,
    });
  });

  test('no rendered line ends on a word that leaves the phrase hanging', async ({ page }) => {
    const shot = await openPlannedColumn(page);

    let inspected = 0;
    const offenders: string[] = [];
    for (const block of shot.blocks) {
      for (const line of block.lines.slice(0, -1)) {
        inspected += 1;
        const last = line.words[line.words.length - 1] ?? '';
        if (HANGING.has(core(last))) offenders.push(`${block.id}: "…${last}"`);
      }
    }
    // A check over no line ends would pass on a planner that never broke a line.
    expect(inspected, 'no line end was inspected').toBeGreaterThan(0);
    expect(offenders, `lines ended on a function word: ${offenders.join(', ')}`).toEqual([]);
  });
});

test.describe('a column too narrow to plan', () => {
  /**
   * The fallback's whole contract, checked against one snapshot: under the
   * floor, with nothing planned anywhere, prose that genuinely wraps (zero
   * breaks over one-line blocks would prove nothing about wrapping), and every
   * line inside its column.
   */
  function expectBrowserWrap(shot: StageSnapshot, label: string) {
    expect(shot.columnChars, `${label}: the column must sit under the floor`).toBeLessThan(
      MIN_PLANNED_COLUMN_CHARS,
    );
    expect(shot.plannedBreaks, `${label}: a narrow column plans nothing`).toBe(0);
    expect(shot.blocks.length, `${label}: no prose was measured`).toBeGreaterThan(0);
    expect(
      shot.blocks.some((b) => b.lines.length >= 2),
      `${label}: no block wrapped, so containment was never tested`,
    ).toBe(true);
    for (const block of shot.blocks) expectLinesInside(block, shot.column);
  }

  test('leaves wrapping to the browser, inside its column, through a resize', async ({ page }) => {
    await openPreview(page, NARROW);
    await expect
      .poll(async () => (await snapshot(page)).blocks.some((b) => b.lines.length >= 2))
      .toBe(true);
    const before = await snapshot(page);
    expectBrowserWrap(before, `${NARROW.width}x${NARROW.height}`);

    /*
     * Narrower, and still under the floor: the fallback must survive a reflow,
     * not only the first layout. Without optics the column is a fixed share of
     * the viewport, so the width it must reach follows from the one it had —
     * and polling for THAT, rather than for zero breaks (which was already
     * true), is what proves the stage actually re-laid itself out before the
     * containment checks run. The stage debounces a resize before it reflows.
     */
    await page.setViewportSize(NARROWER);
    const expectedWidth = (before.column.width * NARROWER.width) / NARROW.width;
    await expect
      .poll(async () => (await snapshot(page)).column.width)
      .toBeCloseTo(expectedWidth, 0);
    const after = await snapshot(page);
    expectBrowserWrap(after, `${NARROWER.width}x${NARROWER.height}`);
    expect(after.column.width).toBeLessThan(before.column.width);

    // The same prose, re-wrapped onto more lines — the reflow was real.
    const linesBefore = new Map(
      before.blocks.map((b) => [b.id, { text: b.lines.flatMap((l) => l.words).join(' '), count: b.lines.length }]),
    );
    const rewrapped = after.blocks.filter((b) => {
      const was = linesBefore.get(b.id);
      return (
        was !== undefined &&
        was.text === b.lines.flatMap((l) => l.words).join(' ') &&
        b.lines.length > was.count
      );
    });
    expect(rewrapped.length, 'no block present at both widths gained a line').toBeGreaterThan(0);
  });
});
