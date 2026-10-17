/**
 * The script syntax reference (#305), from the two places it opens.
 *
 * Help › Script Syntax Reference is a native menu item, so it is driven by
 * `menu://command` rather than a click — the browser has no menu bar, and a
 * keystroke would exercise a path the packaged app never takes. The editor's
 * own button is a real click.
 *
 * What this proves: both paths open the same bundled page, it closes and gives
 * focus back, its last entry is reachable, and a take refuses it. What it
 * cannot: the native Help menu's own placement, or WKWebView.
 */
import { test, expect, type Page } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';
import { watchPageErrors } from './fixtures/page-errors';
import { collection, openScript } from './fixtures/library';
import { syntaxEntries } from '../../../src/shared/markdown/syntax-reference';

const SCRIPT = {
  id: '30530530-5305-4305-8305-305305305305',
  title: 'Syntax walkthrough',
  source: '# Opening\n\nThank you for joining me today.\n\nHere is what changed this quarter.\n',
};

/** Choose an item from the native menu, once the window is listening for it. */
async function chooseMenuCommand(page: Page, id: string): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        (commandId) => window.__E2E__.emit('menu://command', { id: commandId }),
        id,
      ),
    )
    .toBeGreaterThan(0);
}

const reference = (page: Page) => page.getByRole('dialog', { name: 'Script syntax reference' });

/** Whether the last menu push enabled Help › Script Syntax Reference. */
function referenceMenuEnabled(page: Page): Promise<boolean | null> {
  return page.evaluate(() => {
    const call = window.__E2E__.lastCall('set_menu_state');
    const items = (call?.args as { items?: Array<{ id: string; enabled: boolean }> } | null)?.items;
    return items?.find((item) => item.id === 'help.syntax-reference')?.enabled ?? null;
  });
}

test.beforeEach(async ({ page }) => {
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [SCRIPT],
    engineStatus: {
      available: true,
      loaded: true,
      model: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05',
    },
    promptMode: 'voice',
  });
  await page.goto('/control.html');
  await expect(collection(page)).toBeVisible();
});

test('the editor button opens the reference and Escape returns focus to it', async ({ page }) => {
  const errors = watchPageErrors(page);
  await openScript(page, SCRIPT.title);
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeVisible();

  const button = page.getByRole('button', { name: 'Syntax reference' });
  await button.click();

  const dialog = reference(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Part break' })).toBeVisible();
  // Opens on its first line, not scrolled to the footer.
  await expect(dialog.locator('[data-autofocus]')).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(button).toBeFocused();
  errors.expectClean();
});

test('Help opens the same reference, whose last entry and Done are reachable', async ({ page }) => {
  const errors = watchPageErrors(page);
  await page.setViewportSize({ width: 900, height: 560 });
  await expect.poll(() => referenceMenuEnabled(page)).toBe(true);
  await chooseMenuCommand(page, 'help.syntax-reference');

  const dialog = reference(page);
  await expect(dialog).toBeVisible();

  // The page is taller than the panel, so the reference's own region scrolls
  // under the wheel — not the document, and not the footer with Done in it.
  const region = dialog.locator('.scroll');
  const done = dialog.getByRole('button', { name: 'Done' });
  const doneBefore = await done.boundingBox();
  await region.hover();
  await page.mouse.wheel(0, 20_000);
  await expect.poll(() => region.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0)).toBe(0);

  const last = syntaxEntries().at(-1)!;
  const lastEntry = dialog.locator(`[data-entry="${last.id}"]`);
  await expect(lastEntry).toBeInViewport();
  await expect(lastEntry.locator('pre code')).toHaveText(last.example);

  await expect(done).toBeInViewport({ ratio: 1 });
  expect(await done.boundingBox()).toEqual(doneBefore);
  await done.click();
  await expect(dialog).toHaveCount(0);
  errors.expectClean();
});

test('Keyboard Shortcuts replaces the reference rather than opening under it', async ({ page }) => {
  await chooseMenuCommand(page, 'help.syntax-reference');
  await expect(reference(page)).toBeVisible();

  await chooseMenuCommand(page, 'help.keyboard-shortcuts');
  const shortcuts = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(shortcuts).toBeVisible();
  await expect(reference(page)).toHaveCount(0);

  await chooseMenuCommand(page, 'help.syntax-reference');
  await expect(reference(page)).toBeVisible();
  await expect(shortcuts).toHaveCount(0);
});

test('a take refuses the reference rather than covering the prompter', async ({ page }) => {
  await collection(page).getByRole('button', { name: 'Present', exact: true }).first().click();
  await expect(page.getByRole('region', { name: 'Teleprompter' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator('.stage-root')).toHaveAttribute('data-phase', 'ready');

  // The menu greys the item out, and the command refuses even if delivered.
  await expect.poll(() => referenceMenuEnabled(page)).toBe(false);
  await chooseMenuCommand(page, 'help.syntax-reference');
  await expect(reference(page)).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Teleprompter' })).toBeVisible();
});
