/**
 * The editor's title field — how it ends when the name is longer than its room.
 *
 * The title in the editor toolbar is an `<input>`, and an input is sized by its
 * `size` attribute, not by its text: twenty average characters, ~184px, at any
 * window width. So a long name was cut off at about twenty characters even with
 * hundreds of pixels of empty toolbar beside it, where the read-only title on
 * every other route uses the room it has and only ellipsizes when that runs out
 * (issue #411).
 *
 * Layout is the whole subject, and jsdom resolves no stylesheets, so these run
 * against the real CSS in a browser.
 */
import { test, expect, type Page } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';
import { openScript } from './fixtures/library';

const LONG = 'Quarterly product update for the board of directors and investors';
const MEDIUM = 'Quarterly product update for the board';

async function openTitled(page: Page, title: string, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 800 });
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [
      { id: '41141141-4114-4114-8114-411411411411', title, source: '# Opening\n\nHello there.' },
    ],
  });
  await page.goto('/control.html');
  await openScript(page, title.slice(0, 12));
  await expect(page.getByRole('textbox', { name: 'Script title' })).toHaveValue(title);
  // Park the pointer away from the field: hover is a state of its own.
  await page.mouse.move(width - 4, 796);
}

interface FieldMetrics {
  clientWidth: number;
  scrollWidth: number;
  textOverflow: string;
  spacerWidth: number;
}

function fieldMetrics(page: Page): Promise<FieldMetrics> {
  return page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('.title-input')!;
    const spacer = document.querySelector<HTMLElement>('.toolbar .spacer')!;
    return {
      clientWidth: input.clientWidth,
      scrollWidth: input.scrollWidth,
      textOverflow: getComputedStyle(input).textOverflow,
      spacerWidth: spacer.getBoundingClientRect().width,
    };
  });
}

test('a title that fits the toolbar is shown whole, not cut at the field’s default width', async ({
  page,
}) => {
  await openTitled(page, MEDIUM, 1600);
  const m = await fieldMetrics(page);
  // Before the fix: clientWidth 184, scrollWidth ~290 — clipped with a wide
  // toolbar to spare.
  expect(m.scrollWidth, 'the whole title fits inside the field').toBeLessThanOrEqual(m.clientWidth);
  expect(m.spacerWidth, 'and the toolbar still has room left over').toBeGreaterThan(0);
});

test('a title longer than its room uses the room, then ends in an ellipsis at rest', async ({
  page,
}) => {
  await openTitled(page, LONG, 980);
  const m = await fieldMetrics(page);
  expect(m.scrollWidth, 'the title really is longer than its room').toBeGreaterThan(m.clientWidth);
  expect(m.textOverflow).toBe('ellipsis');
  // The field took the room the toolbar had rather than stopping at its
  // default width: what is left over is the spacer's floor, not slack.
  expect(m.spacerWidth).toBeLessThan(24);
});

test('while editing, the full title stays reachable, and blur puts the ellipsis back', async ({
  page,
}) => {
  await openTitled(page, LONG, 980);
  const field = page.getByRole('textbox', { name: 'Script title' });
  await field.click();
  // The caret to the end the way an engine scrolls for it: End does not move
  // the caret in a WebKit field on a Mac, and this spec should hold there too.
  await field.evaluate((input: HTMLInputElement) =>
    input.setSelectionRange(input.value.length, input.value.length),
  );
  await page.keyboard.type('!');
  const editing = await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('.title-input')!;
    return {
      textOverflow: getComputedStyle(input).textOverflow,
      scrollLeft: input.scrollLeft,
      caret: input.selectionStart,
      length: input.value.length,
    };
  });
  expect(editing.textOverflow, 'no ellipsis over text being edited').toBe('clip');
  expect(editing.caret).toBe(editing.length);
  expect(editing.scrollLeft, 'the caret scrolled the end of the title into view').toBeGreaterThan(0);

  await page.keyboard.press('Escape');
  await expect(field).toHaveValue(LONG);
  await field.blur();
  await page.mouse.move(976, 796);
  const rest = await fieldMetrics(page);
  expect(rest.textOverflow).toBe('ellipsis');
  expect(rest.scrollWidth).toBeGreaterThan(rest.clientWidth);
  // The title gives up its room before the actions do (§21.3).
  await expect(page.getByRole('button', { name: 'Present', exact: true })).toBeInViewport({
    ratio: 1,
  });
});

test('the field widens as a short title is typed longer', async ({ page }) => {
  await openTitled(page, 'Pitch', 1600);
  const before = await fieldMetrics(page);
  const field = page.getByRole('textbox', { name: 'Script title' });
  await field.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' to the board');
  const after = await fieldMetrics(page);
  expect(after.clientWidth, 'the field widens as the title grows').toBeGreaterThan(before.clientWidth);
  expect(after.scrollWidth, 'and keeps the whole draft in view').toBeLessThanOrEqual(after.clientWidth);
});
