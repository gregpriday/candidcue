import { test, expect, type Page } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';
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
  'Teleprompter',
  'Following',
  'Listeners',
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
    keyStatus: { present: true, hint: 'sk-…live', source: 'keychain' },
  });

  // Library.
  await page.goto('/control.html');
  await expect(page.getByRole('heading', { name: 'Scripts' })).toBeVisible();
  await expectNotBlank(page);

  // Editor — the route the compiler-worker crash used to make unreachable.
  await page
    .getByRole('list', { name: 'Scripts' })
    .getByRole('button', { name: /Sweep script/ })
    .click();
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('A sentence for the compiler');

  // Settings, every section. A section that throws on mount is exactly the
  // failure mode this sweep is for.
  await page.getByRole('button', { name: 'Settings' }).first().click();
  const nav = page.getByRole('navigation', { name: 'Settings sections' });
  for (const section of SETTINGS_SECTIONS) {
    await nav.getByRole('button', { name: section, exact: true }).click();
    await expect(nav.getByRole('button', { name: section, exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expectNotBlank(page);
  }

  // Preflight, all the way to a passing readiness state.
  await page.getByRole('button', { name: 'All scripts', exact: true }).click();
  await page
    .getByRole('list', { name: 'Scripts' })
    .getByRole('button', { name: 'Present', exact: true })
    .first()
    .click();
  await expect(page.getByRole('button', { name: 'Start session' })).toBeEnabled({ timeout: 20_000 });
  await expectNotBlank(page);

  await page.screenshot({ path: testInfo.outputPath('route-sweep-preflight.png'), fullPage: true });

  errors.expectClean();
});

test('the welcome route renders on a first launch and hands off to the library', async ({ page }) => {
  const errors = watchPageErrors(page);
  // No `welcomed` flag: this is a genuine first launch on the production path.
  await installTauriShim(page, { keyStatus: { present: false, source: 'none' } });
  await page.goto('/control.html');

  await expect(
    page.getByRole('heading', { name: 'Speak naturally. Keep your place.' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Go to the library' }).click();
  await expect(page.getByRole('heading', { name: 'Scripts' })).toBeVisible();

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
