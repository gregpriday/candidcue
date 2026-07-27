import { test, expect } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';
import { watchPageErrors } from './fixtures/page-errors';
import { dismissAllToasts } from './fixtures/toasts';

/**
 * VOICE mode, at the honest edge of what a browser can prove.
 *
 * A voice take needs a real microphone and a live Inworld session. This spec
 * supplies neither and fakes neither. What it does drive is the one voice-mode
 * state that is fully reachable without hardware, and that a user hits for
 * real whenever their key is rejected or Inworld is down: `start_transcription`
 * refuses, so there is no session and no transcription.
 *
 * That state matters precisely because it is the one where a teleprompter must
 * not lie. If the pill still reads "Connected" while nothing is listening, the
 * presenter keeps talking at a script that will never move.
 */

const SCRIPT = {
  id: '55555555-5555-4555-8555-555555555555',
  title: 'Product announcement',
  source: '# Product announcement\n\nToday we are shipping something new.\n',
};

/** Exactly what Rust returns when the session cannot be opened. */
const MINT_REFUSED = {
  code: 'REALTIME_CONNECT_FAILED',
  userMessage: 'The transcription session could not be opened.',
  recoverable: false,
};

test('a voice take whose realtime transport cannot be established says so instead of pretending', async ({
  page,
}, testInfo) => {
  const errors = watchPageErrors(page);
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [SCRIPT],
    keyStatus: { present: true, hint: 'sk-…live', source: 'keychain' },
    promptMode: 'voice',
  });
  await page.goto('/control.html');
  await page.evaluate((err) => {
    window.__E2E__.setFail('start_transcription', err);
  }, MINT_REFUSED);

  await page
    .getByRole('list', { name: 'Scripts' })
    .getByRole('button', { name: 'Present', exact: true })
    .first()
    .click();

  // Nothing before the take can know the transport will fail, and nothing
  // tries to: the stage opens, and the failure is reported from the take.
  const statusBar = page.locator('header.statusbar');
  await expect(statusBar).toBeVisible({ timeout: 20_000 });
  await expect(statusBar.getByText('Voice', { exact: true })).toBeVisible();

  // The three things the operator must be told, in the three places §15.1 puts
  // them: the connection pill, the microphone pill, and the status line.
  await expect(statusBar.getByText('Disconnected', { exact: true })).toBeVisible();
  await expect(statusBar.getByText('Mic lost', { exact: true })).toBeVisible();
  await expect(statusBar.getByText('Disconnected — voice following has stopped')).toBeVisible();

  await page.screenshot({ path: testInfo.outputPath('live-voice-no-transport.png'), fullPage: true });

  /*
   * The session really was attempted, and it carried THIS take's
   * configuration — the model and the language from Settings. Without this the
   * spec would pass just as happily against a build that never tried to open a
   * session at all, which is the opposite of what it is here to prove.
   */
  const attempt = await page.evaluate(() => window.__E2E__.lastCall('start_transcription'));
  expect(attempt).not.toBeNull();
  const options = (attempt!.args as { options: Record<string, unknown> }).options;
  expect(options['modelId']).toBe('inworld/inworld-stt-1');
  expect(options['language']).toBe('en-US');

  /*
   * The failure is announced in English (§44.12 / E.7). The toast used to be
   * built by interpolating whatever `describeError` returned, and for the
   * codes that arrive as bare strings that WAS the code — "Voice following
   * stopped: QUOTA_EXHAUSTED". Nothing shaped like a code may appear in it.
   */
  const failureToast = page.getByText('Voice tracking is unavailable', { exact: false });
  await expect(failureToast).toBeVisible();
  const failureText = (await failureToast.innerText()).trim();
  expect(failureText).not.toMatch(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/);
  // …and it says what to do next, not just that something broke.
  expect(failureText).toMatch(/Try again/i);

  // The transport is still offered as the way out.
  await expect(
    page.locator('footer.transport').getByRole('button', { name: 'Start', exact: true }),
  ).toBeEnabled();

  errors.expectClean();
});

/*
 * THE MANUAL FALLBACK, ON A DEAD TRANSPORT. Two defects met here, and both are
 * guarded by this one spec because they only appear together in a real browser.
 *
 * 1. Pressing Start on the Live transport after the realtime session died threw
 *    an uncaught `InvalidTransitionError: fatal_error --start_listening-->` out
 *    of the click handler:
 *
 *      Live.svelte  → startPrompting()            (stores/session.ts)
 *                   → pipeline.startListening()   (voice-session.ts)
 *                   → controller.startListening() (realtime/sessionController.ts)
 *                   → machine.transition('start_listening')
 *
 *    `fatal_error` has no `start_listening` edge, and that call site used the
 *    throwing `transition`. `softPause`/`resume` threw the same way.
 *
 * 2. The two danger toasts this failure raises are sticky by design and used to
 *    sit on top of the centre transport controls, eating their clicks.
 *
 * Manual driving is the ONLY thing left when the transport is gone, and the
 * transport bar is where the operator reaches for it — so BOTH broke in exactly
 * the situation they exist for. Nothing below dismisses a toast before clicking.
 */
test('a dead realtime transport still leaves the operator a working manual transport', async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [SCRIPT],
    keyStatus: { present: true, hint: 'sk-…live', source: 'keychain' },
    promptMode: 'voice',
  });
  await page.goto('/control.html');
  await page.evaluate((err) => {
    window.__E2E__.setFail('start_transcription', err);
  }, MINT_REFUSED);
  await page
    .getByRole('list', { name: 'Scripts' })
    .getByRole('button', { name: 'Present', exact: true })
    .first()
    .click();
  await expect(
    page.locator('header.statusbar').getByText('Disconnected', { exact: true }),
  ).toBeVisible({ timeout: 20_000 });

  // The danger toasts really are up — and stay up — while the transport is used.
  const danger = page.locator('.toast.danger');
  await expect(danger.first()).toBeVisible();
  const transportBox = await page.locator('footer.transport').boundingBox();
  const count = await danger.count();
  for (let i = 0; i < count; i += 1) {
    const box = await danger.nth(i).boundingBox();
    expect(box!.y + box!.height, `danger toast ${i} must clear the transport`).toBeLessThanOrEqual(
      transportBox!.y,
    );
  }

  await page.locator('footer.transport').getByRole('button', { name: 'Start', exact: true }).click();
  await page.getByRole('button', { name: 'Forward one sentence' }).click();
  await expect(page.locator('.preview-sentence.current')).toHaveText(
    'today we are shipping something new',
  );
  await expect(danger).toHaveCount(count); // sticky: nothing auto-dismissed

  // Pause and resume go through the same dead session and must not throw either.
  await page.locator('footer.transport').getByRole('button', { name: 'Pause', exact: true }).click();
  await page.locator('footer.transport').getByRole('button', { name: 'Resume' }).click();

  // Still dismissable by hand.
  await dismissAllToasts(page);
  await expect(danger).toHaveCount(0);

  // This is the assertion that used to fail.
  errors.expectClean();
});

/*
 * The other half of the manual-mode honesty pair (live-session.spec.ts). A fix
 * that simply deletes the connection/microphone indicators passes there and
 * fails here.
 */
test('a voice take still reports its realtime connection and its microphone', async ({ page }) => {
  const errors = watchPageErrors(page);
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [SCRIPT],
    keyStatus: { present: true, hint: 'sk-…live', source: 'keychain' },
    promptMode: 'voice',
  });
  await page.goto('/control.html');
  await page.evaluate((err) => {
    window.__E2E__.setFail('start_transcription', err);
  }, MINT_REFUSED);
  await page
    .getByRole('list', { name: 'Scripts' })
    .getByRole('button', { name: 'Present', exact: true })
    .first()
    .click();
  const statusBar = page.locator('header.statusbar');
  await expect(statusBar).toBeVisible({ timeout: 20_000 });
  // The realtime pills are PRESENT in a voice take — reporting the truth, which
  // here is a failure. "No microphone" is the manual-mode wording and must not
  // leak into a take that really does have one.
  await expect(statusBar.getByText('Disconnected', { exact: true })).toBeVisible();
  await expect(statusBar.getByText('Mic lost', { exact: true })).toBeVisible();
  await expect(statusBar.getByText('No microphone', { exact: true })).toHaveCount(0);

  /*
   * §28.2. "Mic lost" here means the TRANSPORT died, not the input device, and
   * swapping microphones cannot fix a credential that was refused. The
   * mid-session input picker is therefore not offered — an affordance that
   * cannot help is the same unfollowable-instruction defect as the copy that
   * used to send the user looking for a control that did not exist.
   */
  await expect(statusBar.getByRole('combobox', { name: 'Input device' })).toHaveCount(0);
  await expect(statusBar.getByRole('button', { name: 'Use this input' })).toHaveCount(0);

  errors.expectClean();
});
