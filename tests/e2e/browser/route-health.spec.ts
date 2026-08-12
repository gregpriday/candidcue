import { test, expect, type Page } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';
import { openScript } from './fixtures/library';
import { openPreferences } from './fixtures/preferences';
import { watchPageErrors } from './fixtures/page-errors';

/**
 * Route health sweep, SHIM-BACKED (production IPC path).
 *
 * Why this exists: the compiler worker threw `ReferenceError: document is not
 * defined` for the life of the project. Every unit test passed. It was only
 * visible when something opened the real app in a real browser — and then only
 * if somebody was watching the console. Nobody was.
 *
 * So this walks every route the control window can reach, plus the other two
 * Vite entries, and asserts two things per route: it rendered something a user
 * would recognise (a blank frame is a failed launch, not a pass), and it raised
 * no uncaught error or console error getting there.
 *
 * Deliberately shallow. It is a tripwire for "this route is broken today",
 * not a substitute for the journey specs.
 */

const SCRIPT = {
  id: '66666666-6666-4666-8666-666666666666',
  title: 'Sweep script',
  source: '# Sweep script\n\nA sentence for the compiler to chew on.\n',
};

const SETTINGS_SECTIONS = [
  'General',
  'Speech',
  'Audio',
  'Stage display',
  'Teleprompter',
  'Following',
  'Data, privacy & updates',
] as const;

/** Assert a route rendered content, not an empty shell. */
async function expectNotBlank(page: Page): Promise<void> {
  const text = await page.locator('main, .stage-root, .identify').first().innerText();
  expect(text.trim().length, 'the route rendered no text at all').toBeGreaterThan(20);
}

test('every control-window route renders and raises nothing', async ({ page }, testInfo) => {
  const errors = watchPageErrors(page);
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [SCRIPT],
    engineStatus: { available: true, loaded: true, model: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05' },
  });

  // Library.
  await page.goto('/control.html');
  await expect(page.getByRole('heading', { name: 'All scripts' })).toBeVisible();
  await expectNotBlank(page);

  // Editor — the route the compiler-worker crash used to make unreachable.
  // Double click: a single click SELECTS in the collection model (§10.2).
  await openScript(page, /Sweep script/);
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('A sentence for the compiler');

  /*
   * Settings, every section — in its own WINDOW now (§14.1), which is its own
   * page. The sweep loads it directly for the reason `fixtures/preferences.ts`
   * sets out: a browser cannot open a native window, and the surface under test
   * is the same either way.
   *
   * A section that throws on mount is exactly the failure mode this sweep is
   * for, and moving Settings to another entry point makes it MORE worth
   * sweeping, not less: it now boots on its own, with its own settings load and
   * its own voice-facade binding.
   */
  await openPreferences(page);
  const nav = page.getByRole('navigation', { name: 'Settings sections' });
  for (const section of SETTINGS_SECTIONS) {
    await nav.getByRole('button', { name: section, exact: true }).click();
    await expect(nav.getByRole('button', { name: section, exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expectNotBlank(page);
  }

  // Back to the control window for the rest of the sweep.
  await page.goto('/control.html');
  await expect(page.getByRole('heading', { name: 'All scripts' })).toBeVisible();

  // Live, reached the only way it can be reached: one press of Present.
  await page.getByRole('button', { name: 'All scripts', exact: true }).click();
  await page
    .getByRole('listbox')
    .getByRole('button', { name: 'Present', exact: true })
    .first()
    .click();
  await expect(page.getByRole('region', { name: 'Teleprompter' })).toBeVisible({
    timeout: 20_000,
  });
  await expectNotBlank(page);

  await page.screenshot({ path: testInfo.outputPath('route-sweep-live.png'), fullPage: true });

  errors.expectClean();
});

test('the welcome route renders on a first launch and hands off to the library', async ({ page }) => {
  const errors = watchPageErrors(page);
  // No `welcomed` flag: this is a genuine first launch on the production path.
  await installTauriShim(page, { engineStatus: { available: true, loaded: false, model: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05' } });
  await page.goto('/control.html');

  await expect(
    page.getByRole('heading', { name: 'Speak naturally. Keep your place.' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Go to the library' }).click();
  await expect(page.getByRole('heading', { name: 'All scripts' })).toBeVisible();

  errors.expectClean();
});

test('the stage and identify entries render and raise nothing', async ({ page }) => {
  const errors = watchPageErrors(page);

  await page.goto('/stage.html');
  await expect(page.locator('.stage-root')).toHaveAttribute('data-phase', 'handshake');

  await page.goto('/identify.html?n=2&primary=1');
  await expect(page.locator('.identify .number')).toHaveText('2');

  errors.expectClean();
});
