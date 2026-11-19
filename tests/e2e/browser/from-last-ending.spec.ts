/**
 * Present › From last ending after the script is edited (#448).
 *
 * A take's ending is stored as a token offset into the source it was read
 * from. Inserting an introduction above the passage used to make the same row
 * quote, and launch, whatever sentence then sat at that offset. The row is now
 * offered only while the editor's compile is the source the take recorded.
 *
 * The history arrives through the seam the Editor really reads — Rust's
 * `list_sessions` — carrying the compiler's own hash of the seeded source.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';
import { openScript } from './fixtures/library';
import { sourceHash } from '../../../src/shared/markdown/hash';

const SCRIPT = {
  id: '44844844-0448-4448-8448-448448448448',
  title: 'Tricky passage',
  source: 'Opening words go here.\n\nRepeat this tricky passage.\n\nClosing words go here.\n',
};

/** Three words into "Repeat this tricky passage." (tokens 4–7). */
const END_TOKEN = 6;

/** One finished take, recorded against the seeded source. */
const HISTORY = [
  {
    id: 'session-448-0001',
    sessionGeneration: 3,
    scriptId: SCRIPT.id,
    // The compiler's own hash of the seeded source.
    scriptSourceHash: sourceHash(SCRIPT.source),
    startedAt: '2026-11-18T09:00:00.000Z',
    endedAt: '2026-11-18T09:01:10.000Z',
    mode: 'voice',
    startTokenIndex: 0,
    endTokenIndex: END_TOKEN,
    durationMs: 70_000,
    softPauseMs: 0,
    commandCount: 0,
    retakeCount: 0,
    reconnectCount: 0,
    manualCorrectionCount: 0,
  },
];

function menu(page: Page): Locator {
  return page.getByRole('menu', { name: 'How to present' });
}

function row(page: Page, name: string): Locator {
  return menu(page).getByRole('menuitem').filter({ hasText: name });
}

async function openMenu(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'How to present' }).click();
  await expect(menu(page)).toBeVisible();
  // The menu is populated, so an absent row below is absent, not unrendered.
  await expect(row(page, 'From beginning')).toBeVisible();
}

async function closeMenu(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [SCRIPT],
    engineStatus: { available: true, loaded: true, model: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05' },
    promptMode: 'voice',
    sessionHistory: HISTORY,
  });
  await page.goto('/control.html');
  await openScript(page, SCRIPT.title);
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeVisible();
  await expect(page.locator('.panel-foot')).not.toContainText('Reading the script', { timeout: 15_000 });
});

test('an unchanged script offers and launches the passage the take stopped in', async ({ page }) => {
  await openMenu(page);
  const lastEnding = row(page, 'From last ending');
  await expect(lastEnding).toContainText('Repeat this tricky passage.');
  await lastEnding.click();

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window.__E2E__.calls.find((call) => call.command === 'start_session')?.args as
              | { input?: { startTokenIndex?: number } }
              | undefined
          )?.input?.startTokenIndex ?? null,
      ),
    )
    .toBe(4);
});

test('inserting text before the ending withdraws the row instead of naming another sentence', async ({
  page,
}) => {
  await openMenu(page);
  await expect(row(page, 'From last ending')).toContainText('Repeat this tricky passage.');
  await closeMenu(page);

  await page.locator('.cm-line', { hasText: 'Opening words go here.' }).click();
  await page.keyboard.press('Home');
  await page.keyboard.type('A new introduction first. ');
  await expect(page.locator('.cm-line').first()).toHaveText('A new introduction first. Opening words go here.');

  await openMenu(page);
  await expect(row(page, 'From last ending')).toHaveCount(0);
});

test('deleting the sentence the take ended in withdraws the row', async ({ page }) => {
  // Established first, so the absence below is the edit's doing and not a
  // history that never loaded.
  await openMenu(page);
  await expect(row(page, 'From last ending')).toContainText('Repeat this tricky passage.');
  await closeMenu(page);

  await page.locator('.cm-line', { hasText: 'Repeat this tricky passage.' }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Shift+Home');
  await page.keyboard.press('Backspace');
  await expect(page.locator('.cm-content')).not.toContainText('Repeat this tricky passage.');

  await openMenu(page);
  await expect(row(page, 'From last ending')).toHaveCount(0);
});

test('a launch is refused when the saved script changed after the row was offered', async ({ page }) => {
  await openMenu(page);
  const lastEnding = row(page, 'From last ending');
  await expect(lastEnding).toContainText('Repeat this tricky passage.');

  // Another app edits the file. The editor still holds — and offers — the
  // text it loaded; the take is compiled from what is saved.
  await page.evaluate(
    ({ id, source }) => window.__E2E__.setScriptSource(id, source),
    { id: SCRIPT.id, source: `A new introduction first. ${SCRIPT.source}` },
  );
  await lastEnding.click();

  await expect(page.getByText('The script has changed since that take ended')).toBeVisible();
  const commands = await page.evaluate(() => window.__E2E__.calls.map((call) => call.command));
  expect(commands).toContain('get_script');
  expect(commands).not.toContain('start_session');
  await expect(page.getByRole('region', { name: 'Teleprompter' })).toHaveCount(0);
});
