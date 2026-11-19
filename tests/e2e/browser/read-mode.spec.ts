/**
 * A Read take, end to end, on a machine with nothing to listen with (#243).
 *
 * The issue's "done": with no speech model installed and the microphone
 * refused, a script can be presented and moved by hand and by Auto-scroll,
 * with no permission prompt and no readiness warning about voice. So this
 * seeds exactly that machine — the model not installed, the OS saying the
 * microphone is denied — and presses the Library's Present, which goes through
 * the same readiness check as every other launcher. A sheet would stop the
 * take before the teleprompter region appears, so reaching it is the first
 * half of the claim.
 *
 * The second half is what was NOT done. The microphone wrappers count every
 * probe from before the app loads, and the shim records every command: a Read
 * take that quietly asked for the microphone, enumerated inputs, or loaded or
 * started the recogniser would pass a test that only looked at the glass.
 */
import { test, expect, type Page } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';
import { watchPageErrors } from './fixtures/page-errors';

const PARAGRAPH =
  'Revenue grew steadily through the quarter and churn came down in every segment we measure. ' +
  'The onboarding rewrite landed in February and the numbers moved the week after it shipped. ' +
  'Support volume fell, activation rose, and the team has been able to work ahead of the queue.';

const SCRIPT = {
  id: '66666666-6666-4666-8666-666666666666',
  title: 'Read walkthrough',
  source:
    '# Opening\n\nThank you for joining me today.\n\n' +
    Array.from({ length: 8 }, (_, i) => `## Section ${i + 1}\n\n${PARAGRAPH}\n`).join('\n'),
};

/** Same reading as `auto-scroll.spec.ts`: forward is a growing positive number. */
async function scrollPx(page: Page): Promise<number> {
  return page.locator('.scroll-plane').evaluate((el) => {
    const match = /translate3d\(0(?:px)?,\s*(-?[\d.]+)px/.exec((el as HTMLElement).style.transform);
    return match?.[1] === undefined ? 0 : -Number(match[1]);
  });
}

const VOICE_COMMANDS = [
  'get_microphone_permission',
  'preload_speech_engine',
  'start_transcription',
  'push_transcription_audio',
];

test('a Read take presents and rolls with no model and the microphone refused', async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [SCRIPT],
    promptMode: 'manual',
    engineStatus: { available: false, loaded: false, model: 'unknown' },
    modelStatus: {
      modelId: 'x-asr-480ms',
      languages: ['en'],
      supported: true,
      installed: false,
      phase: 'notInstalled',
      source: null,
      downloadBytes: 133_895_136,
      installedBytes: 0,
      progressBytes: 0,
      progressTotal: 0,
      operationId: null,
      error: null,
    },
  });
  await page.addInitScript(() => {
    const counters = { query: 0, getUserMedia: 0, enumerateDevices: 0 };
    const query = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (descriptor: PermissionDescriptor) => {
      if (descriptor.name === ('microphone' as PermissionName)) counters.query += 1;
      return query(descriptor);
    };
    navigator.mediaDevices.getUserMedia = () => {
      counters.getUserMedia += 1;
      // What a refused microphone answers.
      return Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
    };
    const enumerateDevices = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
    navigator.mediaDevices.enumerateDevices = () => {
      counters.enumerateDevices += 1;
      return enumerateDevices();
    };
    window.__MIC_PROBES__ = counters;
  });

  await page.goto('/control.html');
  await page
    .getByRole('listbox')
    .getByRole('button', { name: 'Present', exact: true })
    .first()
    .click();
  // No readiness sheet stood in the way: the take opened.
  await expect(page.getByRole('region', { name: 'Teleprompter' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator('.script-layer')).toBeVisible();
  await expect(page.getByText(/cannot follow your voice/)).toHaveCount(0);
  // Let the opening placement land before sampling a position.
  await page.waitForTimeout(1500);

  const atRest = await scrollPx(page);
  await page.keyboard.press('a');
  await expect
    .poll(() => scrollPx(page), { timeout: 15_000, intervals: [250] })
    .toBeGreaterThan(atRest + 20);
  await page.keyboard.press('a');

  expect(await page.evaluate(() => window.__MIC_PROBES__)).toEqual({
    query: 0,
    getUserMedia: 0,
    enumerateDevices: 0,
  });
  const voiceCalls = await page.evaluate(
    (names) => window.__E2E__.calls.filter((c) => names.includes(c.command)).map((c) => c.command),
    VOICE_COMMANDS,
  );
  expect(voiceCalls).toEqual([]);
  // The take was recorded as what it is.
  const started = await page.evaluate(() =>
    window.__E2E__.calls.find((c) => c.command === 'start_session'),
  );
  expect((started?.args as { input?: { mode?: string } } | undefined)?.input?.mode).toBe('manual');

  errors.expectClean();
});
