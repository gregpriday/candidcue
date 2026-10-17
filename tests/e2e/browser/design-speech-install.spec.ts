import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { installTauriShim, type ShimConfig } from './fixtures/tauri-shim';
import { openPreferences } from './fixtures/preferences';

/**
 * Design capture harness for the speech-language picker, OPT-IN.
 *
 * Not a test of anything. It walks `SpeechLanguagePicker` through every
 * install state it can show — in both of the places it is shown — and writes
 * one PNG per state, so a design review argues about pixels rather than about
 * a template. Nothing here asserts behaviour the journey specs do not already
 * pin; the `expect` before each screenshot exists only so a state that failed
 * to render throws instead of writing a plausible picture of the wrong screen.
 *
 *     DESIGN_CAPTURE=1 DESIGN_CAPTURE_DIR=/tmp/somewhere CANDIDCUE_E2E_PORT=5313 \
 *       ./node_modules/.bin/playwright test tests/e2e/browser/design-speech-install.spec.ts
 *
 * The output directory is REQUIRED and deliberately has no default: a fallback
 * inside the repo would outlive the run that needed it, and the next capture
 * would write screenshots into somebody's working tree.
 *
 * Two layouts, one light theme:
 *   - `full--*`    Settings › Speech (`preferences.html`), the whole section
 *                  the picker sits in, at the Settings window's real size;
 *   - `compact--*` the first-run Welcome checklist (`control.html`), the
 *                  speech row it is embedded in, at the control window's size.
 * Both windows run the workspace theme — Settings unconditionally, Welcome
 * because no take is running.
 */

const CAPTURE = process.env['DESIGN_CAPTURE'] === '1';
const OUT = process.env['DESIGN_CAPTURE_DIR'];

test.skip(!CAPTURE, 'design capture harness — set DESIGN_CAPTURE=1');
test.describe.configure({ mode: 'serial' });
// Retina, as the panel is actually seen: 12px metadata at 1x is too soft to
// judge weight and contrast from.
test.use({ deviceScaleFactor: 2 });

const RECOGNIZER_ID = 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05';
const DOWNLOAD_BYTES = 133_895_136;

/** A status in the shape Rust serializes. */
function status(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    modelId: 'x-asr-480ms',
    modelName: RECOGNIZER_ID,
    languages: ['en', 'zh'],
    phase: 'installed',
    source: 'downloaded',
    installed: true,
    supported: true,
    downloadBytes: DOWNLOAD_BYTES,
    installedBytes: 169_347_218,
    progressBytes: 0,
    progressTotal: 0,
    operationId: null,
    error: null,
    ...overrides,
  };
}

/** English, as the real catalogue offers it today. */
function english(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    languageTag: 'en-US',
    primarySubtag: 'en',
    modelId: 'x-asr-480ms',
    recognizerId: RECOGNIZER_ID,
    active: true,
    status: status(),
    origins: [{ kind: 'upstream', host: 'github.com' }],
    attribution: {
      title: 'X-ASR streaming Zipformer transducer (480 ms chunk, INT8, punctuated)',
      author: 'Jun Guo, with the X-LANCE Lab, Shanghai Jiao Tong University',
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

/** A second language. No real build offers one yet; a stress state only. */
function german(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return english({
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
      source: null,
      downloadBytes: 57_565_698,
      installedBytes: 71_204_311,
    }),
    attribution: {
      title: 'Kroko streaming Zipformer (German)',
      author: 'Banafo',
      sourceUrl: 'https://huggingface.co/Banafo/Kroko-ASR',
      distributedVia: 'https://github.com/k2-fsa/sherpa-onnx',
      license: {
        id: 'CC-BY-SA-4.0',
        name: 'Creative Commons Attribution-ShareAlike 4.0',
        url: 'https://creativecommons.org/licenses/by-sa/4.0/',
      },
      licenseNote: 'Changes to the model must be shared under the same licence.',
      modified: false,
    },
    ...overrides,
  });
}

function options(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    active: {
      languageTag: 'en-US',
      primarySubtag: 'en',
      modelId: 'x-asr-480ms',
      recognizerId: RECOGNIZER_ID,
    },
    changeBlocked: false,
    languages: [english()],
    removable: [],
    ...overrides,
  };
}

/** English alone, in the given install state. */
function englishIn(statusOverrides: Record<string, unknown>): Record<string, unknown> {
  return options({ languages: [english({ status: status(statusOverrides) })] });
}

const MISSING = { installed: false, phase: 'notInstalled', source: null };
const DOWNLOADING = {
  installed: false,
  phase: 'downloading',
  source: null,
  progressBytes: Math.round(DOWNLOAD_BYTES * 0.46),
  progressTotal: DOWNLOAD_BYTES,
};
const VALIDATING = {
  installed: false,
  phase: 'validating',
  source: null,
  progressBytes: 1,
  progressTotal: 1,
};
const DAMAGED = {
  installed: false,
  phase: 'failed',
  source: 'downloaded',
  error: {
    code: 'STT_MODEL_DAMAGED',
    message: 'The speech data on this computer is damaged and cannot be used. Download it again to repair it.',
  },
};
const RETRY = {
  installed: false,
  phase: 'failed',
  source: null,
  error: { code: 'STT_MODEL_DOWNLOAD_FAILED', message: 'The download was interrupted.' },
};

const OFFLINE = { code: 'NETWORK_OFFLINE', userMessage: 'CandidCue could not reach the internet.' };
const LOAD_FAILED = { code: 'IPC_ERROR', userMessage: 'CandidCue could not ask the backend about speech languages.' };

interface Shot {
  name: string;
  layout: 'full' | 'compact';
  config: ShimConfig;
  /** Runs before the app boots (init script), for states that must exist from the first call. */
  beforeBoot?: { held?: string; fail?: [string, unknown] };
  /** Drives the screen into the state, after the picker is on screen. */
  drive?: (page: Page, picker: Locator) => Promise<void>;
  /** What must be visible at the moment of capture, or the shot is refused. */
  marker: (picker: Locator, page: Page) => Locator;
}

const SHOTS: Shot[] = [
  /* ---------------------------------------------------------- full layout */
  {
    name: 'checking',
    layout: 'full',
    config: {},
    beforeBoot: { held: 'get_speech_language_options' },
    marker: (picker) => picker.getByText(/Checking/),
  },
  {
    name: 'load-failed',
    layout: 'full',
    config: {},
    beforeBoot: { fail: ['get_speech_language_options', LOAD_FAILED] },
    marker: (picker) => picker.getByRole('button', { name: /Check again/ }),
  },
  {
    name: 'installed',
    layout: 'full',
    config: { languageOptions: options() },
    marker: (picker) => picker.getByRole('button', { name: /Remove/ }),
  },
  {
    name: 'missing',
    layout: 'full',
    config: { languageOptions: englishIn(MISSING) },
    marker: (picker) => picker.getByRole('button', { name: /Download/ }),
  },
  {
    name: 'downloading',
    layout: 'full',
    config: { languageOptions: englishIn(DOWNLOADING) },
    marker: (picker) => picker.locator('progress[value]'),
  },
  {
    name: 'validating',
    layout: 'full',
    config: { languageOptions: englishIn(VALIDATING) },
    marker: (picker) => picker.locator('progress:not([value])'),
  },
  {
    name: 'damaged',
    layout: 'full',
    config: { languageOptions: englishIn(DAMAGED) },
    marker: (picker) => picker.getByRole('button', { name: /Download again/ }),
  },
  {
    name: 'retry',
    layout: 'full',
    config: { languageOptions: englishIn(RETRY) },
    marker: (picker) => picker.getByRole('button', { name: /Try again/ }),
  },
  {
    name: 'action-error',
    layout: 'full',
    config: { languageOptions: englishIn(MISSING) },
    drive: async (page, picker) => {
      await page.evaluate((error) => window.__E2E__.setFail('start_speech_model_download', error), OFFLINE);
      await picker.getByRole('button', { name: /Download/ }).click();
    },
    marker: (picker) => picker.getByText(/cannot reach the network/),
  },
  {
    name: 'remove-confirm',
    layout: 'full',
    config: { languageOptions: options() },
    drive: async (_page, picker) => {
      await picker.getByRole('button', { name: /Remove/ }).first().click();
    },
    marker: (picker) => picker.getByRole('button', { name: 'Keep it' }),
  },
  {
    name: 'orphans',
    layout: 'full',
    config: {
      languageOptions: options({
        removable: [
          status({ modelId: 'kroko-es', languages: ['es'], installedBytes: 155_832_407 }),
          status({
            modelId: 'kroko-fr',
            languages: ['fr'],
            installed: false,
            phase: 'failed',
            source: 'downloaded',
            installedBytes: 148_115_002,
            error: DAMAGED.error,
          }),
        ],
      }),
    },
    marker: (picker) => picker.getByText(/Spanish/),
  },
  {
    name: 'orphan-confirm',
    layout: 'full',
    config: {
      languageOptions: options({
        removable: [status({ modelId: 'kroko-es', languages: ['es'], installedBytes: 155_832_407 })],
      }),
    },
    drive: async (_page, picker) => {
      await picker.getByRole('button', { name: 'Remove', exact: true }).click();
    },
    marker: (picker) => picker.getByRole('button', { name: 'Keep it' }),
  },
  {
    name: 'inspect-other',
    layout: 'full',
    config: { languageOptions: options({ languages: [english(), german()] }) },
    drive: async (_page, picker) => {
      await picker.locator('select').selectOption('de-DE');
    },
    marker: (picker) => picker.getByRole('button', { name: /Download/ }),
  },
  {
    name: 'no-languages',
    layout: 'full',
    config: { languageOptions: options({ languages: [] }) },
    marker: (picker) => picker.getByText(/no speech languages/),
  },

  /* ------------------------------------------------------- compact layout */
  {
    name: 'checking',
    layout: 'compact',
    config: {},
    beforeBoot: { held: 'get_speech_language_options' },
    marker: (picker) => picker.getByText(/Checking/),
  },
  {
    name: 'load-failed',
    layout: 'compact',
    config: {},
    beforeBoot: { fail: ['get_speech_language_options', LOAD_FAILED] },
    marker: (picker) => picker.getByRole('button', { name: /Check again/ }),
  },
  {
    name: 'missing',
    layout: 'compact',
    config: { languageOptions: englishIn(MISSING) },
    marker: (picker) => picker.getByRole('button', { name: /Download/ }),
  },
  {
    name: 'downloading',
    layout: 'compact',
    config: { languageOptions: englishIn(DOWNLOADING) },
    marker: (picker) => picker.locator('progress[value]'),
  },
  {
    name: 'validating',
    layout: 'compact',
    config: { languageOptions: englishIn(VALIDATING) },
    marker: (picker) => picker.locator('progress:not([value])'),
  },
  {
    name: 'installed',
    layout: 'compact',
    config: { languageOptions: options() },
    marker: (picker) => picker.getByText(/on disk/),
  },
  {
    name: 'damaged',
    layout: 'compact',
    config: { languageOptions: englishIn(DAMAGED) },
    marker: (picker) => picker.getByRole('button', { name: /Download again/ }),
  },
  {
    name: 'retry',
    layout: 'compact',
    config: { languageOptions: englishIn(RETRY) },
    marker: (picker) => picker.getByRole('button', { name: /Try again/ }),
  },
];

/** Where the picker sits, and the region worth photographing around it. */
async function openLayout(page: Page, shot: Shot): Promise<{ picker: Locator; frame: Locator }> {
  if (shot.layout === 'full') {
    // Taller than the real window (880x660) so a long section is photographed
    // whole rather than scrolled under the sticky Settings header. The page
    // shot below goes back to the real size.
    await page.setViewportSize({ width: 880, height: 1100 });
    await openPreferences(page);
    await page.getByRole('button', { name: 'Speech', exact: true }).click();
    const picker = page.locator('.picker');
    return { picker, frame: page.locator('section.section').filter({ has: picker }) };
  }
  await page.setViewportSize({ width: 1240, height: 820 });
  await page.goto('/control.html');
  const picker = page.locator('.picker');
  return { picker, frame: page.locator('.readiness-item').filter({ has: picker }) };
}

for (const shot of SHOTS) {
  test(`capture ${shot.layout} — ${shot.name}`, async ({ page }) => {
    if (!OUT) throw new Error('DESIGN_CAPTURE_DIR must be set to a directory outside the repo');
    mkdirSync(OUT, { recursive: true });

    await installTauriShim(page, { welcomed: shot.layout === 'full', ...shot.config });
    if (shot.beforeBoot) {
      await page.addInitScript((seam) => {
        const e2e = (window as unknown as { __E2E__?: Window['__E2E__'] }).__E2E__;
        if (!e2e) throw new Error('tauri shim not installed before the capture seam');
        if (seam.held) e2e.setHeld(seam.held, true);
        if (seam.fail) e2e.setFail(seam.fail[0], seam.fail[1]);
      }, shot.beforeBoot);
    }

    // A render that threw is named in the failure rather than left to look
    // like a panel that never finished loading.
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(`${error.name}: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(message.text());
    });

    const { picker, frame } = await openLayout(page, shot);
    await expect(picker).toBeVisible();
    if (shot.drive) await shot.drive(page, picker);

    // Verified AFTER the settle: a state that did not render is refused rather
    // than photographed.
    try {
      await expect(shot.marker(picker, page)).toBeVisible();
    } catch (cause) {
      throw new Error(`${shot.layout}/${shot.name} did not render. Page errors: ${pageErrors.join(' | ') || 'none'}`, {
        cause,
      });
    }
    // Off every control, so a click that drove the state does not leave a
    // hover on the frame; then lets focus and transitions land.
    await page.mouse.move(0, 0);
    await page.waitForTimeout(250);

    await frame.screenshot({ path: join(OUT, `${shot.layout}--${shot.name}.png`), animations: 'disabled' });
    // One page-level frame per layout, for the proportion of the panel against
    // the screen around it.
    if (shot.name === (shot.layout === 'full' ? 'installed' : 'missing')) {
      if (shot.layout === 'full') await page.setViewportSize({ width: 880, height: 660 });
      await page.screenshot({ path: join(OUT, `${shot.layout}--${shot.name}--page.png`), animations: 'disabled' });
    }
  });
}
