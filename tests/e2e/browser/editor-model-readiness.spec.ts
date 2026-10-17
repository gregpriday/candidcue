/**
 * Readiness follows the speech model while a script is open (#301).
 *
 * The editor asked about the model once, when a script opened, and kept the
 * answer. So a download that finished while a script was open left Present
 * warning "No speech model is installed" over a model Settings showed as
 * Installed, and a model removed in Settings left Present launching with no
 * warning. Beside either, the footer said "Ready to present." off the compile
 * alone. And File › Present, the Library and the summary's Present again never
 * asked at all.
 *
 * Each install state is delivered here exactly as Rust delivers it — a full
 * status on `speech://model-progress` — and nothing is reopened in between.
 *
 * What this cannot prove: the event comes from the shim, not from Rust's
 * `SpeechModelManager` (the delete half of that is a cargo test), and the
 * Settings window that would really have sent it is a separate webview this
 * page is not.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';
import { watchPageErrors } from './fixtures/page-errors';
import { openScript, row } from './fixtures/library';

const SCRIPT = {
  id: '30130130-1301-4301-8301-301301301301',
  title: 'Model readiness walkthrough',
  source:
    '# Opening\n\nThank you for joining me today. Here is what changed this quarter.\n\n' +
    '## What is next\n\nWe ship the new onboarding in March.\n',
};

const CATALOGUE_ID = 'x-asr-480ms';
const RECOGNIZER_ID = 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05';

/** A status as Rust sends it: the short catalogue id, the recogniser's name. */
function modelStatus(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    modelId: CATALOGUE_ID,
    modelName: RECOGNIZER_ID,
    languages: ['en', 'zh'],
    phase: 'installed',
    source: 'downloaded',
    installed: true,
    supported: true,
    downloadBytes: 133_895_136,
    installedBytes: 169_347_218,
    progressBytes: 0,
    progressTotal: 0,
    operationId: null,
    error: null,
    ...over,
  };
}

const NOT_INSTALLED = { phase: 'notInstalled', source: null, installed: false, installedBytes: 0 };

/** Both ids the app may ask about, seeded as not installed. */
function nothingInstalled(): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    [CATALOGUE_ID, RECOGNIZER_ID].map((id) => [id, modelStatus({ ...NOT_INSTALLED, modelId: id })]),
  );
}

/** Rust → control, the way `speech://model-progress` arrives. */
async function announce(page: Page, status: Record<string, unknown>): Promise<void> {
  // Polled: the listener attaches asynchronously, and a delivery to nobody
  // would make every assertion after it vacuous.
  await expect
    .poll(() =>
      page.evaluate(
        (payload) => window.__E2E__.emit('speech://model-progress', payload),
        status,
      ),
    )
    .toBeGreaterThan(0);
}

/** Every model-status request asked so far has been answered. */
async function modelStatusSettled(page: Page): Promise<void> {
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
}

function footer(page: Page): Locator {
  return page.locator('.panel-foot');
}

function presentButton(page: Page): Locator {
  return page.locator('header.toolbar').getByRole('button', { name: 'Present', exact: true });
}

function sheet(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Before this take' });
}

async function expectTakeRunning(page: Page): Promise<void> {
  await expect(page.getByRole('region', { name: 'Teleprompter' })).toBeVisible({
    timeout: 20_000,
  });
}

test('an install that finishes while a script is open clears the warning', async ({ page }) => {
  const errors = watchPageErrors(page);
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [SCRIPT],
    promptMode: 'voice',
    modelStatuses: nothingInstalled(),
  });
  await page.goto('/control.html');
  await openScript(page, SCRIPT.title);
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeVisible();

  // The compile and the model, each said for itself.
  await expect(footer(page)).toContainText('No speech model is installed');
  await expect(footer(page)).toContainText('The script is ready.');
  await expect(footer(page)).not.toContainText('Ready to present.');

  await announce(page, modelStatus({ ...NOT_INSTALLED, phase: 'downloading', progressTotal: 10 }));
  await expect(footer(page)).toContainText('still installing');

  await announce(page, modelStatus());
  await expect(footer(page)).toContainText('Ready to present.');
  await expect(footer(page)).not.toContainText('cannot follow your voice');

  // And Present agrees: no sheet, straight into the take.
  await presentButton(page).click();
  await expectTakeRunning(page);
  await expect(sheet(page)).toHaveCount(0);
  errors.expectClean();
});

test('a model removed while a script is open is warned about at Present', async ({ page }) => {
  const errors = watchPageErrors(page);
  await installTauriShim(page, { welcomed: true, seedScripts: [SCRIPT], promptMode: 'voice' });
  await page.goto('/control.html');
  await openScript(page, SCRIPT.title);
  await modelStatusSettled(page);
  await expect(footer(page)).toContainText('Ready to present.');

  // What `delete_speech_model` now announces to the control window.
  await announce(page, modelStatus(NOT_INSTALLED));
  await expect(footer(page)).toContainText('No speech model is installed');

  await presentButton(page).click();
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page)).toContainText('No speech model is installed');
  // A warning, not a gate.
  await expect(sheet(page).getByRole('button', { name: 'Start anyway' })).toBeVisible();
  await sheet(page).getByRole('button', { name: 'Back to the script' }).click();
  await expect(sheet(page)).toBeHidden();
  errors.expectClean();
});

test('Present from the Library is checked like the editor’s', async ({ page }) => {
  const errors = watchPageErrors(page);
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [SCRIPT],
    promptMode: 'voice',
    modelStatuses: nothingInstalled(),
  });
  await page.goto('/control.html');
  await modelStatusSettled(page);

  const target = row(page, SCRIPT.title);
  await target.hover();
  await target.getByRole('button', { name: 'Present', exact: true }).click();

  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page)).toContainText('No speech model is installed');
  await sheet(page).getByRole('button', { name: 'Start anyway' }).click();
  await expectTakeRunning(page);
  errors.expectClean();
});

/** A native menu command, delivered the way Rust delivers it. */
async function menuCommand(page: Page, id: string): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate((commandId) => window.__E2E__.emit('menu://command', { id: commandId }), id),
    )
    .toBeGreaterThan(0);
}

test('File › Present is checked too, and a launch that goes ahead clears the sheet', async ({
  page,
}) => {
  /*
   * ⌘↩ is File › Present's accelerator, so in the packaged app the menu takes
   * it before the editor's own shortcut can — and the menu called `startTake`
   * directly. The most common way to present skipped the check.
   */
  const errors = watchPageErrors(page);
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [SCRIPT],
    promptMode: 'voice',
    modelStatuses: nothingInstalled(),
  });
  await page.goto('/control.html');
  await openScript(page, SCRIPT.title);
  await expect(footer(page)).toContainText('No speech model is installed');

  await menuCommand(page, 'file.present');
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page)).toContainText('No speech model is installed');

  // Installed from the sheet's own button, in another window; File › Present
  // again with the old sheet still up.
  await announce(page, modelStatus());
  await menuCommand(page, 'file.present');
  await expectTakeRunning(page);
  await expect(sheet(page)).toHaveCount(0);
  errors.expectClean();
});
