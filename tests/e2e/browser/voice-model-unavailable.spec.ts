/**
 * A take whose speech model is refused is not a microphone fault (#286).
 *
 * The voice pipeline opens the microphone FIRST and asks Rust for a recogniser
 * second, so a take started with no usable model had a working input and no
 * recogniser at all. It came out of the same branch as a dead microphone: the
 * take-controls drawer read "Mic lost" while it ran, and the summary said
 * "Nothing was transcribed — test or change the microphone in Settings". A new
 * presenter who had skipped the download was sent to debug hardware that
 * worked.
 *
 * Both surfaces are asserted here because the store tests cannot see either:
 * they prove the take RECORDS the refusal, not that the status bar reads it or
 * that the summary dialog passes it to the outcome. And both start paths are
 * driven, because the fix has to key off the refusal itself — readiness is
 * advisory, and a Present that skips the sheet never consulted it.
 *
 * What this cannot prove: the refusal comes from the shim, not from Rust's
 * `ensure_loaded`, and the microphone is Chromium's fake device. A real take
 * with no model installed, on WKWebView, is still only verified by use.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';
import { watchPageErrors } from './fixtures/page-errors';
import { openScript } from './fixtures/library';

const SCRIPT = {
  id: '28628628-6286-4286-8286-286286286286',
  title: 'Model refusal walkthrough',
  source:
    '# Opening\n\nThank you for joining me today. Here is what changed this quarter.\n\n' +
    '## What is next\n\nWe ship the new onboarding in March.\n',
};

/** Both ids the app may ask about: the catalogue id and the recogniser id. */
const MODEL_IDS = ['x-asr-480ms', 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05'];

function notInstalled(modelId: string): Record<string, unknown> {
  return {
    modelId,
    modelName: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05',
    languages: ['en', 'zh'],
    phase: 'notInstalled',
    source: null,
    installed: false,
    supported: true,
    downloadBytes: 133_895_136,
    installedBytes: 0,
    progressBytes: 0,
    progressTotal: 0,
  };
}

/** Make Rust refuse the recogniser the way `ensure_loaded` does. */
async function refuseRecogniser(page: Page, code: string): Promise<void> {
  await page.evaluate(
    (refused) =>
      window.__E2E__.setFail('start_transcription', {
        code: refused,
        userMessage: 'The speech model could not be used.',
      }),
    code,
  );
}

async function expectTakeRunning(page: Page): Promise<void> {
  await expect(page.getByRole('region', { name: 'Teleprompter' })).toBeVisible({
    timeout: 20_000,
  });
}

/**
 * The drawer's status pills name the refusal and do not blame the input.
 *
 * Polled through `toContainText`: the refusal lands asynchronously after the
 * microphone opens, so the pill reads "Mic live" for a moment first.
 */
async function expectDrawerNamesTheRefusal(page: Page): Promise<void> {
  const tab = page.getByRole('button', { name: /Take controls/ });
  await tab.click();
  const panel = page.getByRole('region', { name: 'Take controls' });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Voice unavailable');
  await expect(panel).not.toContainText('Mic lost');
  // In a neutral light: the danger dot was half of the accusation.
  await expect(
    panel.locator('.live-status', { hasText: 'Voice unavailable' }).locator('.status-dot'),
  ).toHaveClass(/\bneutral\b/);
  await page.keyboard.press('Escape');
  await expect(tab).toHaveAttribute('aria-expanded', 'false');
}

/** End a single-window take the way a presenter does, and return the summary. */
async function endTake(page: Page): Promise<Locator> {
  await page.keyboard.press('Escape');
  await expect(page.locator('.escape-hint')).toBeVisible();
  await page.keyboard.press('Escape');
  const summary = page.getByRole('dialog', { name: 'Take complete' });
  await expect(summary).toBeVisible();
  await expect(page.locator('.present-cover')).toHaveCount(0);
  return summary;
}

/**
 * The outcome card, not the whole dialog: the measurements behind the
 * disclosure are still in the DOM, and a row label there is not advice.
 */
async function expectModelOutcome(summary: Locator): Promise<void> {
  const outcome = summary.locator('.outcome');
  await expect(outcome.locator('.outcome-headline')).toHaveText(
    'Take finished without voice following',
  );
  await expect(outcome.locator('.outcome-suggestion')).toContainText('Settings → Speech');
  await expect(outcome).not.toContainText(/microphone/i);
  await expect(outcome).not.toContainText('Nothing was transcribed');
}

async function transcriptionWasAttempted(page: Page): Promise<boolean> {
  return page.evaluate(() =>
    window.__E2E__.calls.some((call) => call.command === 'start_transcription'),
  );
}

test('a Present that skips readiness still reports a refused model, not the microphone', async ({
  page,
}) => {
  /*
   * The model looks installed, so readiness has nothing to say and Present
   * launches at once — and then the recogniser fails to load. This is the
   * path where nothing but the refusal itself can tell the take what happened.
   */
  const errors = watchPageErrors(page);
  await installTauriShim(page, { welcomed: true, seedScripts: [SCRIPT], promptMode: 'voice' });
  await page.goto('/control.html');
  await refuseRecogniser(page, 'STT_MODEL_LOAD_FAILED');

  await page
    .getByRole('listbox')
    .getByRole('button', { name: 'Present', exact: true })
    .first()
    .click();
  await expectTakeRunning(page);
  await expect.poll(() => transcriptionWasAttempted(page)).toBe(true);

  await expectDrawerNamesTheRefusal(page);
  await expectModelOutcome(await endTake(page));
  errors.expectClean();
});

test('Start anyway past a missing model ends without microphone advice', async ({ page }) => {
  /*
   * The case the issue was filed from: readiness warned that no model was
   * installed, the presenter chose to go ahead, and the summary then told
   * them to test a microphone that had opened normally.
   */
  const errors = watchPageErrors(page);
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [SCRIPT],
    promptMode: 'voice',
    modelStatuses: Object.fromEntries(MODEL_IDS.map((id) => [id, notInstalled(id)])),
  });
  await page.goto('/control.html');
  await refuseRecogniser(page, 'STT_MODEL_NOT_INSTALLED');

  await openScript(page, SCRIPT.title);
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeVisible();
  /*
   * The editor assumes a model is installed until its status call answers, so
   * a Present clicked before then would skip the sheet this test is about.
   * Wait for every model-status request to have been answered, not for a
   * fixed time.
   */
  await expect
    .poll(() =>
      page.evaluate(() => {
        const asked = window.__E2E__.calls.filter(
          (call) => call.command === 'get_speech_model_status',
        ).length;
        const answered = window.__E2E__.settled.filter(
          (command) => command === 'get_speech_model_status',
        ).length;
        return asked > 0 && answered >= asked;
      }),
    )
    .toBe(true);
  await page.locator('header.toolbar').getByRole('button', { name: 'Present', exact: true }).click();

  const sheet = page.getByRole('dialog', { name: 'Before this take' });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('No speech model is installed');
  await sheet.getByRole('button', { name: 'Start anyway' }).click();

  await expectTakeRunning(page);
  await expect.poll(() => transcriptionWasAttempted(page)).toBe(true);

  await expectDrawerNamesTheRefusal(page);
  await expectModelOutcome(await endTake(page));
  errors.expectClean();
});
