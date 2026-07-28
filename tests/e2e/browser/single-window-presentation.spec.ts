import { test, expect, type Page } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';
import { watchPageErrors } from './fixtures/page-errors';

const SCRIPT = {
  id: '44444444-4444-4444-8444-444444444444',
  title: 'Single-window walkthrough',
  source:
    '# Opening\n\nThank you for joining me today. Here is what changed this quarter.\n\n' +
    '## The numbers\n\nRevenue grew steadily. Churn came down.\n\n' +
    '## What is next\n\nWe ship the new onboarding in March.\n',
};

async function present(page: Page): Promise<void> {
  await page.goto('/control.html');
  await page
    .getByRole('list', { name: 'Scripts' })
    .getByRole('button', { name: 'Present', exact: true })
    .first()
    .click();
  await expect(page.getByRole('region', { name: 'Teleprompter' })).toBeVisible({
    timeout: 20_000,
  });
}

test.beforeEach(async ({ page }) => {
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [SCRIPT],
    keyStatus: { present: true, hint: 'sk-…live', source: 'keychain' },
    promptMode: 'voice',
  });
});

test('Present mounts the production stage in this webview and never opens another', async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await present(page);

  await expect(page.locator('aside.sidebar')).toHaveCount(0);
  await expect(page.locator('footer.transport')).toHaveCount(0);
  await expect(page.locator('.stage-root')).toHaveAttribute('data-phase', 'ready');
  await expect(page.locator('.script-layer')).toBeVisible();
  await expect(page.getByText('Thank you for joining me today.')).toBeVisible();
  await expect(page.locator('.diagnostics')).toBeVisible();
  await expect(page.locator('.transcript-tap')).toContainText('listening — no words yet');
  await expect(page.locator('.voice-pill')).toBeAttached({ timeout: 10_000 });

  const calls = await page.evaluate(() => window.__E2E__.calls.map((call) => call.command));
  expect(calls).toContain('start_session');
  expect(calls).toContain('start_alignment');
  expect(calls).toContain('plugin:window|set_fullscreen');
  expect(calls).not.toContain('open_stage');
  expect(calls).not.toContain('publish_stage_document');
  expect(calls).not.toContain('set_stage_fullscreen');

  errors.expectClean();
});

test('the one-screen script follows the control alignment position', async ({ page }) => {
  const errors = watchPageErrors(page);
  await present(page);

  await expect(page.locator('[data-t=\"0\"]')).not.toHaveClass(/past/);
  const delivered = await page.evaluate(() => {
    const generation = window.__E2E__.lastSession?.sessionGeneration ?? 0;
    return window.__E2E__.emit('align://snapshot', {
      sessionGeneration: generation,
      seq: 1,
      state: 'following',
      decision: 'localConfirmed',
      confirmedToken: 6,
      observedToken: 6,
      rateTokensPerSecond: 2,
      evidenceAudioMs: 1000,
      atAudioMs: 1000,
      maxPredictionMs: 800,
      pauseOnsetMs: 400,
      leadFloorMs: 0,
      maxLeadTokens: 2,
      displayLimitToken: 12,
      confidence: 0.95,
      suggestionToken: null,
      scriptLenTokens: 30,
      observedAtom: 6,
      confirmedAtom: 6,
    });
  });
  expect(delivered).toBeGreaterThan(0);
  await expect(page.locator('.stage-root')).toHaveAttribute('data-phase', 'live');
  await expect(page.locator('[data-t=\"0\"]')).toHaveClass(/past/);
  await expect(page.locator('.diagnostics')).toContainText('token: 6.0');

  errors.expectClean();
});

test('one Escape ends the take, leaves full screen, and returns to the editor', async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await present(page);

  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: 'Teleprompter' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Present', exact: true })).toBeVisible();

  const result = await page.evaluate(() => ({
    commands: window.__E2E__.calls.map((call) => call.command),
    session: window.__E2E__.lastSession,
  }));
  expect(result.commands.filter((command) => command === 'plugin:window|set_fullscreen')).toHaveLength(
    2,
  );
  expect(result.commands).toContain('end_session');

  errors.expectClean();
});
