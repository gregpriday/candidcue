import { test, expect, type Locator, type Page } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';
import { watchPageErrors } from './fixtures/page-errors';
import { openScript } from './fixtures/library';

/*
 * PAPER IS A READING WINDOW'S, AND NEVER THE GLASS'S.
 *
 * The unit suites compose the settings and hold the contrast arithmetic; the
 * DOM suite sees the attribute the paper tokens are keyed on. Neither can see a
 * colour — jsdom resolves no stylesheets — so this is where the field itself is
 * read: the computed background of `.stage-root`, the ink of the column, and
 * the page canvas behind them, on a paper reading window, after a switch to
 * the teleprompter mid-take, and on a prompter take with Paper saved.
 */

const SCRIPT = {
  id: '77777777-7777-4777-8777-777777777777',
  title: 'Paper reading walkthrough',
  source:
    '# Opening\n\nThe harbour was quiet the morning the survey boat came in, low in the water ' +
    'and an hour later than anybody had said.\n\n' +
    'Nobody on the quay knew what it had found, and the crew were not saying.\n',
};

const PAPER_FIELD = 'rgb(246, 242, 234)';
const PAPER_INK = 'rgb(36, 36, 36)';
const BLACK = 'rgb(0, 0, 0)';

/** Paper saved in Settings, before the app reads its overlay. */
async function seedPaper(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const key = 'speaking-glass.settings-overlay.v1';
    const overlay = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>;
    const teleprompter = (overlay['teleprompter'] ?? {}) as Record<string, unknown>;
    overlay['teleprompter'] = { ...teleprompter, readerTheme: 'paper' };
    localStorage.setItem(key, JSON.stringify(overlay));
  });
}

async function presentInWindow(page: Page): Promise<void> {
  await page.goto('/control.html');
  await openScript(page, /Paper reading walkthrough/);
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeVisible();
  await page.getByRole('button', { name: 'How to present' }).click();
  await page
    .getByRole('menu', { name: 'How to present' })
    .getByRole('menuitemradio', { name: /Reading window/ })
    .click();
  await expect(page.locator('.stage-root')).toHaveAttribute('data-phase', 'ready', {
    timeout: 20_000,
  });
}

async function presentOnDisplay(page: Page): Promise<void> {
  await page.goto('/control.html');
  await openScript(page, /Paper reading walkthrough/);
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeVisible();
  await page.getByRole('button', { name: 'How to present' }).click();
  await page
    .getByRole('menu', { name: 'How to present' })
    .getByRole('menuitemradio', { name: /Teleprompter/ })
    .click();
  await expect(page.locator('.stage-root')).toHaveAttribute('data-phase', 'ready', {
    timeout: 20_000,
  });
}

const stageField = (page: Page) =>
  page.locator('.stage-root').evaluate((el) => getComputedStyle(el).backgroundColor);
const columnInk = (page: Page) =>
  page.locator('.script-layer .column').first().evaluate((el) => getComputedStyle(el).color);
const canvas = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);

/** The ink a surface's palette gives its text — the frozen paper value on paper. */
const textPrimary = (surface: Locator) =>
  surface.evaluate((el) => getComputedStyle(el).getPropertyValue('--text-primary').trim());

async function openDockMenu(page: Page): Promise<void> {
  await page.locator('.stage-root').hover();
  await page.locator('.stage-dock .dock-button.menu-trigger').click();
}

async function openReadingAppearance(page: Page): Promise<void> {
  await openDockMenu(page);
  await page.locator('.stage-dock [data-menu-row="appearance"]').click();
  await expect(page.locator('.stage-dock .appearance-popover')).toBeVisible();
}

const appearanceOption = (page: Page, name: 'Dark' | 'Paper') =>
  page
    .locator('.stage-dock .appearance-popover')
    .getByRole('radiogroup', { name: 'Appearance' })
    .getByRole('radio', { name });

test.beforeEach(async ({ page }) => {
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [SCRIPT],
    presentationMode: 'reader',
    engineStatus: {
      available: true,
      loaded: true,
      model: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05',
    },
    promptMode: 'voice',
  });
});

test('a paper reading window draws paper — field, ink and canvas — and a switch to the teleprompter is black', async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await seedPaper(page);
  await page.setViewportSize({ width: 1240, height: 820 });
  await presentInWindow(page);

  await expect(page.locator('.stage-root')).toHaveAttribute('data-theme', 'reader-paper');
  expect(await stageField(page)).toBe(PAPER_FIELD);
  expect(await columnInk(page)).toBe(PAPER_INK);
  // The canvas under the stage: what a growing window shows before layout.
  expect(await canvas(page)).toBe(PAPER_FIELD);
  // The take controls over the read are on the frozen paper palette, not the
  // desk's, so a retune of the desk never reaches them (`tokens.css`).
  const drawer = page.locator('.take-controls');
  await expect(drawer).toHaveAttribute('data-theme', 'paper');
  expect(await textPrimary(drawer)).toBe('#18191d');

  // Mid-take, to the teleprompter: the glass is black, whatever was saved.
  // The window moves BEFORE the geometry recomposes, and it moves onto the
  // glass, so the field has to be dark already while the move is in flight —
  // held open here so that interval is observable at all. Held, not delayed:
  // a timed delay can run out on a slow runner before the assertions reach it.
  await page.evaluate(() => window.__E2E__.setHeld('set_control_presenting', true));
  await openDockMenu(page);
  await page.locator('.stage-dock [data-menu-row="present"]').click();
  await expect(page.locator('.stage-root')).toHaveAttribute('data-theme', 'stage-dark', {
    timeout: 700,
  });
  expect(await stageField(page)).toBe(BLACK);
  expect(await canvas(page)).toBe(BLACK);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__E2E__.calls
          .filter((call) => call.command === 'set_control_presenting')
          .map((call) => (call.args as { mode?: string } | null)?.mode ?? null),
      ),
    )
    .toContain('prompter');
  // Asked and not answered: still the reading window, already dark.
  await expect(page.locator('.stage-root')).toHaveAttribute('aria-label', /^Reading: /);
  await page.evaluate(() => window.__E2E__.setHeld('set_control_presenting', false));
  /*
   * Landed: still black, now as the prompter.
   *
   * Waited for by the label, which only changes when the switch is adopted. A
   * switch in flight drops the next toggle (`switchingPresentation` in
   * Live.svelte), so asking for the way back before this one has landed is a
   * click that does nothing — and the take then lands as the prompter.
   */
  await expect(page.locator('.stage-root')).toHaveAttribute('aria-label', 'Teleprompter', {
    timeout: 10_000,
  });
  await expect(page.locator('.stage-root')).toHaveAttribute('data-theme', 'stage-dark');
  await expect.poll(() => stageField(page)).toBe(BLACK);
  await expect.poll(() => canvas(page)).toBe(BLACK);
  await expect(drawer).not.toHaveAttribute('data-theme');

  // And back: the reading window is paper again.
  await openDockMenu(page);
  await page.locator('.stage-dock [data-menu-row="present"]').click();
  await expect(page.locator('.stage-root')).toHaveAttribute('data-theme', 'reader-paper');
  await expect.poll(() => stageField(page)).toBe(PAPER_FIELD);
  await expect.poll(() => canvas(page)).toBe(PAPER_FIELD);

  errors.expectClean();
});

test('a prompter take stays black with Paper saved', async ({ page }) => {
  const errors = watchPageErrors(page);
  await seedPaper(page);
  await presentOnDisplay(page);

  await expect(page.locator('.stage-root')).toHaveAttribute('data-theme', 'stage-dark');
  expect(await stageField(page)).toBe(BLACK);
  expect(await canvas(page)).toBe(BLACK);
  expect(await columnInk(page)).not.toBe(PAPER_INK);
  await expect(page.locator('.take-controls')).not.toHaveAttribute('data-theme');

  errors.expectClean();
});

test('Reading appearance switches the field live, Escape puts it back, and Done remembers it', async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.setViewportSize({ width: 1240, height: 820 });
  await presentInWindow(page);
  await expect(page.locator('.stage-root')).toHaveAttribute('data-theme', 'stage-dark');
  expect(await stageField(page)).toBe(BLACK);

  // Live, on the way past — and the panel goes light with the page.
  await openReadingAppearance(page);
  await expect(appearanceOption(page, 'Dark')).toHaveAttribute('aria-checked', 'true');
  await appearanceOption(page, 'Paper').click();
  await expect.poll(() => stageField(page)).toBe(PAPER_FIELD);
  await expect.poll(() => columnInk(page)).toBe(PAPER_INK);
  await expect(page.locator('.stage-dock .appearance-popover [role="dialog"]')).toHaveAttribute(
    'data-theme',
    'paper',
  );
  expect(await textPrimary(page.locator('.stage-dock .appearance-popover [role="dialog"]'))).toBe(
    '#18191d',
  );

  // Escape is Cancel: back to exactly what it was, and nothing saved.
  await page.keyboard.press('Escape');
  await expect(page.locator('.stage-dock .appearance-popover')).toHaveCount(0);
  await expect.poll(() => stageField(page)).toBe(BLACK);
  const savedTheme = () =>
    page.evaluate(() => {
      const overlay = JSON.parse(
        localStorage.getItem('speaking-glass.settings-overlay.v1') ?? '{}',
      ) as { teleprompter?: { readerTheme?: unknown } };
      return overlay.teleprompter?.readerTheme ?? null;
    });
  expect(await savedTheme()).toBeNull();

  // Done keeps it on the screen and saves it for the next read.
  await openReadingAppearance(page);
  await appearanceOption(page, 'Paper').click();
  await page.locator('.stage-dock .appearance-popover').getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('.stage-dock .appearance-popover')).toHaveCount(0);
  await expect.poll(() => stageField(page)).toBe(PAPER_FIELD);
  await expect.poll(savedTheme).toBe('paper');

  // Remembered between reads: a fresh launch opens the reading window on paper.
  await presentInWindow(page);
  await expect(page.locator('.stage-root')).toHaveAttribute('data-theme', 'reader-paper');
  expect(await stageField(page)).toBe(PAPER_FIELD);

  errors.expectClean();
});
