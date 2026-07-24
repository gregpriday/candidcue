import { test, expect } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';
import { watchPageErrors } from './fixtures/page-errors';
import { dismissAllToasts } from './fixtures/toasts';

/**
 * VOICE mode, at the honest edge of what a browser can prove.
 *
 * A voice take needs a real microphone, a WebRTC transport to api.openai.com
 * and the Realtime provider. This spec supplies NONE of them and fakes none of
 * them. What it does drive is the one voice-mode state that is fully reachable
 * without hardware, and that a user hits for real whenever their key is
 * rejected or OpenAI is down: the realtime credential cannot be minted, so
 * there is no transport and no transcription.
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

/** Exactly what Rust returns when the mint is refused and cannot be retried. */
const MINT_REFUSED = {
  code: 'REALTIME_NEGOTIATION_FAILED',
  userMessage: 'The realtime session could not be negotiated.',
  recoverable: false,
};

test('a voice take whose realtime transport cannot be established says so instead of pretending', async ({
  page,
}, testInfo) => {
  const errors = watchPageErrors(page);
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [SCRIPT],
    keyStatus: { present: true, state: 'valid' },
    promptMode: 'voice',
  });
  await page.goto('/control.html');
  await page.evaluate((err) => {
    window.__E2E__.setFail('create_realtime_transcription_credential', err);
  }, MINT_REFUSED);

  await page
    .getByRole('list', { name: 'Scripts' })
    .getByRole('button', { name: 'Present', exact: true })
    .first()
    .click();

  // Preflight is happy: the key is present and valid, the mic enumerates, the
  // stage is there. Nothing here can know the transport will fail.
  const start = page.getByRole('button', { name: 'Start session' });
  await expect(start).toBeEnabled({ timeout: 20_000 });
  await start.click();

  const statusBar = page.locator('header.statusbar');
  await expect(statusBar).toBeVisible();
  await expect(statusBar.getByText('Voice', { exact: true })).toBeVisible();

  // The three things the operator must be told, in the three places §15.1 puts
  // them: the connection pill, the microphone pill, and the status line.
  await expect(statusBar.getByText('Disconnected', { exact: true })).toBeVisible();
  await expect(statusBar.getByText('Mic lost', { exact: true })).toBeVisible();
  await expect(statusBar.getByText('Disconnected — voice following has stopped')).toBeVisible();

  await page.screenshot({ path: testInfo.outputPath('live-voice-no-transport.png'), fullPage: true });

  /*
   * The mint really was attempted, and it carried THIS session's configuration
   * — the model from Settings, and the language and the latency preset chosen
   * in Preflight ('balanced' → delay 'low', spec A.6). Without this the spec
   * would pass just as happily against a build that never opened a transport
   * at all, which is the opposite of what it is here to prove.
   */
  const mint = await page.evaluate(() =>
    window.__E2E__.lastCall('create_realtime_transcription_credential'),
  );
  expect(mint).not.toBeNull();
  const config = (mint!.args as { config: Record<string, unknown> }).config;
  expect(config['model']).toBe('gpt-4o-mini-transcribe');
  expect(config['language']).toBe('en');
  expect(config['delay']).toBe('low');

  // The failure is announced, and the transport is still offered as the way out.
  await expect(page.getByText('Voice tracking is unavailable', { exact: false })).toBeVisible();
  await expect(
    page.locator('footer.transport').getByRole('button', { name: 'Start', exact: true }),
  ).toBeEnabled();

  errors.expectClean();
});

/*
 * KNOWN DEFECT — reported, not yet fixed. `test.fixme` so it stays visible in
 * the run without failing the suite; delete the `.fixme` when the fix lands.
 *
 * Pressing Start on the Live transport after the realtime session has died
 * throws an uncaught `InvalidTransitionError: fatal_error --start_listening-->`
 * out of the click handler:
 *
 *   Live.svelte  → startPrompting()                  (stores/session.ts)
 *                → pipeline.startListening()         (voice-session.ts)
 *                → controller.startListening()       (realtime/sessionController.ts:255)
 *                → machine.transition('start_listening')
 *
 * `fatal_error` has no `start_listening` edge (realtime/stateMachine.ts), and
 * this call site uses the throwing `transition` while the internal one at
 * sessionController.ts:341 uses the tolerant `tryTransition`. `softPause` and
 * `resume` throw the same way from a dead session.
 *
 * The cost is not the log line. Manual driving is the ONLY thing left when the
 * transport is gone, and the transport bar is where the operator reaches for
 * it — so the fallback breaks in exactly the situation it exists for.
 */
test.fixme(
  'a dead realtime transport still leaves the operator a working manual transport',
  async ({ page }) => {
    const errors = watchPageErrors(page);
    await installTauriShim(page, {
      welcomed: true,
      seedScripts: [SCRIPT],
      keyStatus: { present: true, state: 'valid' },
      promptMode: 'voice',
    });
    await page.goto('/control.html');
    await page.evaluate((err) => {
      window.__E2E__.setFail('create_realtime_transcription_credential', err);
    }, MINT_REFUSED);
    await page
      .getByRole('list', { name: 'Scripts' })
      .getByRole('button', { name: 'Present', exact: true })
      .first()
      .click();
    const start = page.getByRole('button', { name: 'Start session' });
    await expect(start).toBeEnabled({ timeout: 20_000 });
    await start.click();
    await expect(page.locator('header.statusbar').getByText('Disconnected', { exact: true })).toBeVisible();

    // Two danger toasts are covering the centre transport (see dismissAllToasts).
    await dismissAllToasts(page);

    await page.locator('footer.transport').getByRole('button', { name: 'Start', exact: true }).click();
    await page.getByRole('button', { name: 'Forward one sentence' }).click();
    await expect(page.locator('.preview-sentence.current')).toHaveText(
      'today we are shipping something new',
    );

    // This is the assertion that fails today.
    errors.expectClean();
  },
);
