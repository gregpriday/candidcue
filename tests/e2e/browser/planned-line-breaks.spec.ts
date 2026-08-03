import { test, expect } from '@playwright/test';

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
 * The claim under test is the safety claim, not the taste claim. The stage
 * plans a line and then leaves every other space breakable, so a plan that
 * misjudged a width does not overflow — the browser quietly wraps it, and the
 * line the presenter reads is the greedy one the planner exists to replace.
 * That failure is invisible by design, which is exactly why it needs a test:
 * "every rendered line boundary is one the planner chose" is the assertion that
 * distinguishes a working planner from a planner whose output is being silently
 * corrected.
 */

/** One rendered line: the tokens sharing a baseline, in order. */
interface RenderedLine {
  top: number;
  words: string[];
}

/**
 * Group a block's token spans into the lines the ENGINE actually produced,
 * by their measured vertical position rather than by any markup we emitted.
 */
async function renderedLines(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const blocks: {
      id: string;
      lines: { top: number; words: string[] }[];
      plannedBreaks: number;
      columnWidth: number;
      widest: number;
    }[] = [];

    /*
     * Exactly the kinds `wrap-plan.ts` plans, identified by the `k-{kind}`
     * class `BlockView` puts on the wrapper. Selecting on the inner container
     * instead would sweep up headings and `:::silent` blocks, which render
     * through `.para` and `.heading` but are deliberately NOT planned — their
     * rendered size is not something the planning pass can reproduce — so the
     * line-count identity below does not hold for them.
     */
    const planned = '.k-paragraph, .k-list_item, .k-blockquote';
    for (const block of Array.from(document.querySelectorAll(planned))) {
      const prose = block.querySelector('.para, .quote, .list-body');
      if (!prose) continue;
      const spans = Array.from(prose.querySelectorAll<HTMLElement>('[data-t]'));
      if (spans.length === 0) continue;

      const byTop = new Map<number, { top: number; words: string[] }>();
      let widest = 0;
      for (const span of spans) {
        const rect = span.getBoundingClientRect();
        // Round to the nearest pixel: sub-pixel baselines differ within a line
        // for a span that carries a different face (bold, italic).
        const key = Math.round(rect.top);
        const existing = byTop.get(key);
        if (existing) existing.words.push(span.textContent ?? '');
        else byTop.set(key, { top: key, words: [span.textContent ?? ''] });
      }

      const lines = Array.from(byTop.values()).sort((a, b) => a.top - b.top);
      // The rendered width of each line, taken from its own spans.
      for (const line of lines) {
        const onLine = spans.filter((s) => Math.round(s.getBoundingClientRect().top) === line.top);
        const left = Math.min(...onLine.map((s) => s.getBoundingClientRect().left));
        const right = Math.max(...onLine.map((s) => s.getBoundingClientRect().right));
        widest = Math.max(widest, right - left);
      }

      blocks.push({
        id: block.getAttribute('data-block-id') ?? '',
        lines,
        plannedBreaks: prose.querySelectorAll('br[data-planned-break]').length,
        columnWidth: prose.getBoundingClientRect().width,
        widest,
      });
    }
    return blocks;
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

test('the stage renders the lines it planned, and no others', async ({ page }, testInfo) => {
  await page.goto('/stage.html?preview=1');
  const root = page.locator('.stage-root');
  await expect(root).toHaveAttribute('data-phase', 'live');
  await expect(root.getByText('Welcome back to the channel.')).toBeVisible();

  // Fonts settle before anything is measured: a plan made against the fallback
  // face is a plan for a font nobody is looking at, and the stage re-plans when
  // `document.fonts.ready` resolves.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);

  const blocks = await renderedLines(page);
  expect(blocks.length).toBeGreaterThan(0);

  const planned = blocks.filter((b) => b.plannedBreaks > 0);
  // The preview script has multi-line prose, so SOMETHING must have planned.
  // Zero here means the measurement path returned null and the whole feature is
  // silently inert — the exact failure this spec exists to catch.
  expect(planned.length).toBeGreaterThan(0);

  for (const block of blocks) {
    /*
     * THE SAFETY CLAIM. A block with N planned breaks must render N+1 lines. A
     * greater number means the browser re-wrapped a line the planner thought
     * fitted — the plan was measured wrong, and the presenter is reading a
     * greedy break that no cost model chose.
     */
    expect(
      block.lines.length,
      `block ${block.id} planned ${block.plannedBreaks} breaks but rendered ${block.lines.length} lines`,
    ).toBe(block.plannedBreaks + 1);

    // And nothing ran past the column it was planned against.
    expect(block.widest).toBeLessThanOrEqual(block.columnWidth + 1);
  }

  await page.screenshot({
    path: testInfo.outputPath('planned-line-breaks.png'),
    fullPage: false,
  });
});

test('no rendered line ends on a word that leaves the phrase hanging', async ({ page }) => {
  await page.goto('/stage.html?preview=1');
  await expect(page.locator('.stage-root')).toHaveAttribute('data-phase', 'live');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);

  const blocks = await renderedLines(page);
  const offenders: string[] = [];
  for (const block of blocks) {
    for (const line of block.lines.slice(0, -1)) {
      const last = line.words[line.words.length - 1] ?? '';
      if (HANGING.has(core(last))) offenders.push(`${block.id}: "…${last}"`);
    }
  }
  expect(offenders, `lines ended on a function word: ${offenders.join(', ')}`).toEqual([]);
});
