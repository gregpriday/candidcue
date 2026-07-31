import { test, expect, type Page } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';
import { watchPageErrors } from './fixtures/page-errors';

/**
 * Picking a language and fetching its model (#153), SHIM-BACKED.
 *
 * What this layer proves that the jsdom tests cannot: the picker is reachable
 * through the real routes, on the real settings store, and the payloads it puts
 * on the wire are the ones Rust deserializes. The component tests pin what the
 * panel says; these pin that it is wired to anything at all.
 *
 * Three regressions are specifically in view:
 *
 *   - THE INSTALL COMMANDS MUST CARRY A MODEL ID. Every one of them takes an
 *     optional `modelId` and falls back to the catalogue default, so a picker
 *     that forgot to send one would drive the DEFAULT model however many
 *     languages were listed — and would look completely correct doing it.
 *   - CHOOSING IS DELIBERATE. Moving the dropdown must not download and must
 *     not save; §153 wants the sizes seen first, and a change afterwards to
 *     read as a deliberate act rather than a toggle.
 *   - THE CHOICE IS ONE WRITE. `select_speech_language` carries the language,
 *     and Rust pairs it with the recogniser. A screen that fell back to two
 *     `update_settings` patches would let the pair be observed half-applied.
 */

const RECOGNIZER_ID = 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05';

/** A status the shim can seed, in the shape Rust actually serializes. */
function status(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    modelId: 'x-asr-480ms',
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
    ...overrides,
  };
}

function option(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    languageTag: 'en-US',
    primarySubtag: 'en',
    modelId: 'x-asr-480ms',
    recognizerId: RECOGNIZER_ID,
    active: true,
    status: status(),
    origins: [{ kind: 'upstream', host: 'github.com' }],
    attribution: {
      title: 'X-ASR streaming Zipformer transducer',
      author: 'Jun Guo, with the X-LANCE Lab',
      sourceUrl: 'https://github.com/Gilgamesh-J/X-ASR',
      distributedVia: 'https://github.com/k2-fsa/sherpa-onnx',
      license: {
        id: 'Apache-2.0',
        name: 'Apache License 2.0',
        url: 'https://www.apache.org/licenses/LICENSE-2.0',
      },
      licenseNote: null,
      modified: false,
    },
    ...overrides,
  };
}

function languageOptions(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    active: {
      languageTag: 'en-US',
      primarySubtag: 'en',
      modelId: 'x-asr-480ms',
      recognizerId: RECOGNIZER_ID,
    },
    changeBlocked: false,
    languages: [option()],
    removable: [],
    ...overrides,
  };
}

async function openSpeechSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'Speech', exact: true }).click();
}

test('the first-run screen asks for a language and states what it costs', async ({ page }) => {
  watchPageErrors(page);
  await installTauriShim(page, {
    languageOptions: languageOptions({
      languages: [option({ status: status({ installed: false, phase: 'notInstalled' }) })],
    }),
  });
  await page.goto('/control.html');

  await expect(page.getByRole('heading', { name: 'Speak naturally. Keep your place.' })).toBeVisible();

  const row = page.locator('.readiness-item').filter({ hasText: 'Speech language' });
  await expect(row).toBeVisible();

  // §153: the choice belongs at first run, not behind a link to Settings.
  await expect(row.locator('select')).toBeVisible();

  // All three facts, before the button that spends bandwidth. "once installed"
  // rather than "on disk", because the model is not on this machine yet.
  await expect(row).toContainText('128 MB to download');
  await expect(row).toContainText('162 MB once installed');
  await expect(row).toContainText('github.com');

  // Attribution shown; nothing gating on it.
  await expect(row).toContainText('Apache License 2.0');
  await expect(row.locator('input[type="checkbox"]')).toHaveCount(0);

  await expect(row.getByRole('button', { name: /Download/ })).toBeVisible();
});

test('downloading from the picker addresses the model by id', async ({ page }) => {
  watchPageErrors(page);
  // A NON-DEFAULT model deliberately. Every install command takes an OPTIONAL
  // `modelId` and falls back to the catalogue default, so a picker that forgot
  // to send one — or hardcoded the default — would drive the wrong model and
  // still pass a test aimed at `x-asr-480ms`.
  const german = option({
    languageTag: 'de-DE',
    primarySubtag: 'de',
    modelId: 'kroko-de',
    recognizerId: 'streaming-zipformer-de-kroko-2025-08-06',
    active: false,
    status: status({
      modelId: 'kroko-de',
      languages: ['de'],
      installed: false,
      phase: 'notInstalled',
      downloadBytes: 57_565_698,
    }),
  });
  await installTauriShim(page, {
    welcomed: true,
    languageOptions: languageOptions({ languages: [option(), german] }),
  });
  await page.goto('/control.html');
  await openSpeechSettings(page);

  await page.locator('.picker select').selectOption('de-DE');
  await page.getByRole('button', { name: /Download/ }).click();

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__E2E__.calls.filter((c) => c.command === 'start_speech_model_download').length,
      ),
    )
    .toBe(1);

  const call = await page.evaluate(() => window.__E2E__.lastCall('start_speech_model_download'));
  // The SHORT catalogue id, not the long recogniser id: the install commands
  // resolve a catalogue entry, and the long one names nothing there.
  expect((call!.args as { modelId?: string }).modelId).toBe('kroko-de');
});

test('stopping a download addresses the same model', async ({ page }) => {
  watchPageErrors(page);
  const german = option({
    languageTag: 'de-DE',
    primarySubtag: 'de',
    modelId: 'kroko-de',
    active: false,
    status: status({
      modelId: 'kroko-de',
      languages: ['de'],
      installed: false,
      phase: 'downloading',
      progressBytes: 10_000_000,
      progressTotal: 57_565_698,
    }),
  });
  await installTauriShim(page, {
    welcomed: true,
    languageOptions: languageOptions({ languages: [option(), german] }),
  });
  await page.goto('/control.html');
  await openSpeechSettings(page);

  await page.locator('.picker select').selectOption('de-DE');
  await page.getByRole('button', { name: 'Stop' }).click();

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__E2E__.calls.filter((c) => c.command === 'cancel_speech_model_download').length,
      ),
    )
    .toBe(1);

  const call = await page.evaluate(() => window.__E2E__.lastCall('cancel_speech_model_download'));
  expect((call!.args as { modelId?: string }).modelId).toBe('kroko-de');
});

test('moving the dropdown downloads nothing and saves nothing', async ({ page }) => {
  watchPageErrors(page);
  const german = option({
    languageTag: 'de-DE',
    primarySubtag: 'de',
    modelId: 'kroko-de',
    active: false,
    status: status({ modelId: 'kroko-de', languages: ['de'], installed: false, phase: 'notInstalled' }),
  });
  await installTauriShim(page, {
    welcomed: true,
    languageOptions: languageOptions({ languages: [option(), german] }),
  });
  await page.goto('/control.html');
  await openSpeechSettings(page);

  const select = page.locator('.picker select');
  await expect(select).toBeVisible();
  await select.selectOption('de-DE');

  // The panel followed the choice...
  await expect(page.locator('.picker')).toContainText(/Download/);

  // ...and nothing was spent or written. §153: see the sizes first, then decide.
  const spent = await page.evaluate(() =>
    window.__E2E__.calls.filter(
      (c) =>
        c.command === 'start_speech_model_download' ||
        c.command === 'select_speech_language' ||
        c.command === 'update_settings',
    ).length,
  );
  expect(spent).toBe(0);
});

test('activating a language is one write carrying the tag', async ({ page }) => {
  watchPageErrors(page);
  const german = option({
    languageTag: 'de-DE',
    primarySubtag: 'de',
    modelId: 'kroko-de',
    active: false,
    // Installed, so activation is actually offered.
    status: status({ modelId: 'kroko-de', languages: ['de'], installed: true }),
  });
  await installTauriShim(page, {
    welcomed: true,
    languageOptions: languageOptions({ languages: [option({ active: false }), german] }),
  });
  await page.goto('/control.html');
  await openSpeechSettings(page);

  await page.locator('.picker select').selectOption('de-DE');
  await page.getByRole('button', { name: /^Use / }).click();

  // EXACTLY one — not "at least one". The language and the recogniser are
  // paired in Rust precisely so the screen never issues two writes and risks
  // them being observed half-applied.
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__E2E__.calls.filter((c) => c.command === 'select_speech_language').length,
      ),
    )
    .toBe(1);

  const call = await page.evaluate(() => window.__E2E__.lastCall('select_speech_language'));
  const args = call!.args as { input: { expectedRevision: number; languageTag: string } };
  // Nested under `input`: Rust takes a struct, and a flat payload deserializes
  // to nothing.
  expect(args.input.languageTag).toBe('de-DE');
  expect(typeof args.input.expectedRevision).toBe('number');

  const generic = await page.evaluate(
    () => window.__E2E__.calls.filter((c) => c.command === 'update_settings').length,
  );
  expect(generic).toBe(0);

  // The choice actually took: the shim applies it, and the picker re-reads.
  await expect(page.locator('.picker')).toContainText('Currently using German');
});

/**
 * The regression this pins: the picker is handed a settings revision, and Rust
 * supersedes it on every successful selection. If the screen does not reload
 * the settings document before releasing the button, the NEXT write goes out
 * against a revision that no longer exists and fails its conflict check — which
 * the shim now models faithfully.
 */
test('a second language change in a row does not fail on a stale revision', async ({ page }) => {
  watchPageErrors(page);
  const german = option({
    languageTag: 'de-DE',
    primarySubtag: 'de',
    modelId: 'kroko-de',
    active: false,
    status: status({ modelId: 'kroko-de', languages: ['de'], installed: true }),
  });
  await installTauriShim(page, {
    welcomed: true,
    languageOptions: languageOptions({ languages: [option({ active: false }), german] }),
  });
  await page.goto('/control.html');
  await openSpeechSettings(page);

  await page.locator('.picker select').selectOption('de-DE');
  await page.getByRole('button', { name: /^Use / }).click();
  await expect(page.locator('.picker')).toContainText('Currently using German');

  // Straight back to English, with no reload in between.
  await page.locator('.picker select').selectOption('en-US');
  await page.getByRole('button', { name: /^Use / }).click();
  await expect(page.locator('.picker')).toContainText('Currently using');

  // Polled, not read once: the second write is in flight when the assertion
  // above resolves, and a bare `evaluate` would sample before it lands.
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__E2E__.calls.filter((c) => c.command === 'select_speech_language').length,
      ),
    )
    .toBe(2);
  // No conflict was surfaced — the second write used the revision Rust wrote.
  // The shim rejects a stale `expectedRevision`, so this would fail loudly if
  // the screen had not reloaded the settings document between the two clicks.
  await expect(page.locator('.picker')).not.toContainText('changed somewhere else');
});

test('a take blocks the change, and the screen says so before the click', async ({ page }) => {
  watchPageErrors(page);
  const german = option({
    languageTag: 'de-DE',
    primarySubtag: 'de',
    modelId: 'kroko-de',
    active: false,
    status: status({ modelId: 'kroko-de', languages: ['de'], installed: true }),
  });
  await installTauriShim(page, {
    welcomed: true,
    languageOptions: languageOptions({
      changeBlocked: true,
      languages: [option({ active: false }), german],
    }),
  });
  await page.goto('/control.html');
  await openSpeechSettings(page);

  await page.locator('.picker select').selectOption('de-DE');

  const use = page.getByRole('button', { name: /^Use / });
  await expect(use).toBeDisabled();
  await expect(page.locator('.picker')).toContainText('End the take to change the speech language.');
});

test('a selected language with no data on the machine is fixable here', async ({ page }) => {
  watchPageErrors(page);
  await installTauriShim(page, {
    welcomed: true,
    languageOptions: languageOptions({
      languages: [option({ active: true, status: status({ installed: false, phase: 'notInstalled' }) })],
    }),
  });
  await page.goto('/control.html');
  await openSpeechSettings(page);

  // §153: STT_MODEL_MISSING has to be visible and fixable on THIS screen, not
  // discovered at the top of a take.
  const picker = page.locator('.picker');
  await expect(picker).toContainText('speech data is not on this machine');
  await expect(picker.getByRole('button', { name: /Download/ })).toBeEnabled();
});

test('a model backing no offered language can be removed, behind a confirm', async ({ page }) => {
  watchPageErrors(page);
  await installTauriShim(page, {
    welcomed: true,
    languageOptions: languageOptions({
      removable: [
        status({ modelId: 'kroko-es', languages: ['es'], installed: true, installedBytes: 155_832_407 }),
      ],
    }),
  });
  await page.goto('/control.html');
  await openSpeechSettings(page);

  const picker = page.locator('.picker');
  await expect(picker).toContainText('Other language data on this Mac');

  await picker.getByRole('button', { name: 'Remove', exact: true }).click();
  // Several hundred megabytes is never a single click.
  await expect(picker.getByRole('button', { name: 'Remove it' })).toBeVisible();
  await expect(picker.getByRole('button', { name: 'Keep it' })).toBeVisible();

  await picker.getByRole('button', { name: 'Remove it' }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__E2E__.calls.filter((c) => c.command === 'delete_speech_model').length,
      ),
    )
    .toBeGreaterThan(0);

  const call = await page.evaluate(() => window.__E2E__.lastCall('delete_speech_model'));
  expect((call!.args as { modelId?: string }).modelId).toBe('kroko-es');
});
