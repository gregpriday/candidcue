import { test, expect, type Page } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';
import { watchPageErrors } from './fixtures/page-errors';
import { openScript } from './fixtures/library';

/*
 * A READING WINDOW'S TEXT CAN BE MADE COMFORTABLE, AND THE PANEL KEEPS ITS WORD.
 *
 * The unit suites prove the pieces: the reader preference and its storage, the
 * take-local nudges, the sheet's reader branch. None of them can see the seam
 * this file exists for — the panel is control's, the button that raises it is
 * the stage's, and the transaction that Cancel restores and Done saves lives in
 * Live between them. So this drives the real surface: open the panel from the
 * dock, change the size, and watch the column on the glass answer, back out,
 * and save.
 */

const SCRIPT = {
  id: '66666666-6666-4666-8666-666666666666',
  title: 'Reading appearance walkthrough',
  source:
    '# Opening\n\nFor eleven years the light at Cape Morrow was kept by a woman named Ada Vance, ' +
    'who arrived with two suitcases, a crate of books and no particular plan to stay.\n\n' +
    'The first winter nearly finished her. Storms came in off the water three and four days at a ' +
    'stretch, and the lamp had to be wound by hand every four hours.\n',
};

async function presentInWindow(page: Page): Promise<void> {
  await page.goto('/control.html');
  await openScript(page, /Reading appearance walkthrough/);
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeVisible();
  await page.getByRole('button', { name: 'How to present' }).click();
  await page
    .getByRole('menu', { name: 'How to present' })
    .getByRole('menuitemradio', { name: /Present in a window/ })
    .click();
  await expect(page.locator('.stage-root')).toHaveAttribute('data-phase', 'ready', {
    timeout: 20_000,
  });
}

async function openReadingAppearance(page: Page): Promise<void> {
  await page.locator('.stage-root').hover();
  await page.locator('.stage-dock .dock-button.menu-trigger').click();
  const row = page.locator('.stage-dock [data-menu-row="appearance"]');
  await expect(row).toHaveText('Reading appearance…');
  await row.click();
  await expect(page.locator('.stage-dock .appearance-popover')).toBeVisible();
}

const columnFontSize = (page: Page) =>
  page
    .locator('.script-layer .column')
    .first()
    .evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));

/** Every optical write the app has asked Rust for, as JSON text. */
const opticalWrites = (page: Page) =>
  page.evaluate(() =>
    window.__E2E__.calls
      .filter((call) => call.command === 'update_settings')
      .map((call) => (call.args as { patch?: Record<string, unknown> } | null)?.patch)
      .filter((patch) => patch?.['optical'] !== undefined)
      .map((patch) => JSON.stringify(patch)),
  );

test.beforeEach(async ({ page }) => {
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [SCRIPT],
    presentationMode: 'reader',
    engineStatus: { available: true, loaded: true, model: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05' },
    promptMode: 'voice',
  });
});

test('the reading appearance panel applies live, Escape puts it back, and Done saves it for reading windows only', async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.setViewportSize({ width: 1240, height: 820 });
  await presentInWindow(page);

  const opened = await columnFontSize(page);
  await openReadingAppearance(page);
  const panel = page.locator('.stage-dock .appearance-popover');
  await expect(panel.getByRole('heading', { name: 'Reading appearance' })).toBeVisible();
  await expect(panel).not.toContainText('Calibrated');

  // Live, on the way past — not on the way out.
  await panel.getByRole('button', { name: 'Larger text' }).click();
  await expect.poll(() => columnFontSize(page)).toBeCloseTo(opened + 2, 0);

  // Escape means cancel, and cancel means exactly what it was found as.
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect.poll(() => columnFontSize(page)).toBeCloseTo(opened, 0);
  expect(await opticalWrites(page), 'a cancelled panel saves nothing').toEqual([]);

  // Done keeps it on the glass and saves it as the reader's own preference —
  // into the optical section, never the prompter's teleprompter fallbacks.
  await openReadingAppearance(page);
  await panel.getByRole('button', { name: 'Larger text' }).click();
  await panel.getByRole('button', { name: 'Larger text' }).click();
  await expect.poll(() => columnFontSize(page)).toBeCloseTo(opened + 4, 0);
  await panel.getByRole('button', { name: 'Done' }).click();
  await expect(panel).toHaveCount(0);
  await expect.poll(() => columnFontSize(page)).toBeCloseTo(opened + 4, 0);

  // Done closes the panel and THEN saves, through an asynchronous queue, so
  // the write is waited for rather than read the instant the panel is gone.
  await expect
    .poll(async () => (await opticalWrites(page)).length, {
      message: 'Done writes the reader preference',
    })
    .toBeGreaterThan(0);
  const writes = await opticalWrites(page);
  expect(writes.at(-1)).toContain('Reading');
  expect(writes.at(-1)).toContain(`"fontSizePx":${Math.round(opened + 4)}`);
  const teleprompterWrites = await page.evaluate(() =>
    window.__E2E__.calls
      .filter((call) => call.command === 'update_settings')
      .map((call) => (call.args as { patch?: Record<string, unknown> } | null)?.patch)
      .filter((patch) => patch?.['teleprompter'] !== undefined),
  );
  expect(teleprompterWrites, 'the prompter fallback is left alone').toEqual([]);

  errors.expectClean();
});

/*
 * The smallest reading window the app allows is 580×360. The panel rises from
 * the dock at the bottom, so at that height it has to scroll inside itself
 * rather than push its own Done button off the top of the window.
 */
test('the panel is still usable in the smallest reading window', async ({ page }) => {
  const errors = watchPageErrors(page);
  await page.setViewportSize({ width: 580, height: 360 });
  await presentInWindow(page);
  await openReadingAppearance(page);

  const done = page.locator('.stage-dock .appearance-popover').getByRole('button', { name: 'Done' });
  await expect(done).toBeVisible();
  const box = await done.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(360);
  await done.click();
  await expect(page.locator('.stage-dock .appearance-popover')).toHaveCount(0);

  errors.expectClean();
});
