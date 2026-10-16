import { test, expect, type Page } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';
import { watchPageErrors } from './fixtures/page-errors';

/**
 * Settings › Following › Developer diagnostics reaches a panel a take can open (#236).
 *
 * The setting used to promise "the full following timeline in Live", and the
 * timeline rendered only on Live's console — which a take replaces with the
 * stage. So the switch changed nothing anybody could see. The timeline is now
 * in the take-controls drawer under "Why did it move?", and the only proof that
 * the SETTING drives it is a real take with the setting read from the settings
 * document: the component tests hand `developerMode` in directly, and would
 * pass with Live's binding hard-coded to `false`.
 */

const SCRIPT = {
  id: '55555555-5555-4555-8555-555555555555',
  title: 'Follow diagnostics walkthrough',
  source: '# Opening\n\nThank you for joining me today. Here is what changed this quarter.\n',
};

async function installWith(page: Page, developerDiagnostics: boolean): Promise<void> {
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [SCRIPT],
    engineStatus: { available: true, loaded: true, model: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05' },
    promptMode: 'voice',
    following: { developerDiagnostics },
  });
}

/** Present, then open the take controls and their "Why did it move?" disclosure. */
async function openWhyDidItMove(page: Page) {
  await page.goto('/control.html');
  await page
    .getByRole('listbox')
    .getByRole('button', { name: 'Present', exact: true })
    .first()
    .click();
  await expect(page.getByRole('region', { name: 'Teleprompter' })).toBeVisible({
    timeout: 20_000,
  });

  await page.getByRole('button', { name: /Take controls/ }).click();
  const panel = page.getByRole('region', { name: 'Take controls' });
  await expect(panel).toBeVisible();
  await panel.getByText('Why did it move?').click();
  await expect(panel.getByRole('button', { name: 'Copy diagnostics' })).toBeVisible();
  return panel;
}

test.describe('with developer diagnostics on', () => {
  test.beforeEach(async ({ page }) => {
    await installWith(page, true);
  });

  test('the take controls show the following timeline', async ({ page }) => {
    const errors = watchPageErrors(page);
    const panel = await openWhyDidItMove(page);

    await expect(panel.locator('.timeline')).toBeVisible();
    await expect(panel.getByText('Turn on developer diagnostics')).toHaveCount(0);
    errors.expectClean();
  });
});

test.describe('with developer diagnostics off', () => {
  test.beforeEach(async ({ page }) => {
    await installWith(page, false);
  });

  test('the take controls keep the timeline back and say where to turn it on', async ({
    page,
  }) => {
    const errors = watchPageErrors(page);
    const panel = await openWhyDidItMove(page);

    await expect(panel.locator('.timeline')).toHaveCount(0);
    await expect(panel.getByText(/Turn on developer diagnostics in Settings → Following/)).toBeVisible();
    errors.expectClean();
  });
});
