import { test, expect, type Page } from '@playwright/test';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { installTauriShim, type ShimConfig } from './fixtures/tauri-shim';
import { gotoSection, openPreferences } from './fixtures/preferences';

/**
 * Design capture harness for the whole Settings window, OPT-IN.
 *
 * Not a test of anything. It opens every section in the states that carry
 * design weight and writes PNGs, so a design review argues about pixels rather
 * than about a template. The `expect` before each capture exists only so a
 * state that failed to render throws instead of writing a plausible picture of
 * the wrong screen.
 *
 *     DESIGN_CAPTURE=1 DESIGN_CAPTURE_DIR=/tmp/somewhere SPEAKING_GLASS_E2E_PORT=5315 \
 *       ./node_modules/.bin/playwright test --config=playwright.config.ts \
 *       tests/e2e/browser/design-settings.spec.ts
 *
 * The output directory is REQUIRED and deliberately has no default: a fallback
 * inside the repo would outlive the run that needed it.
 *
 * Two kinds of picture:
 *   - `{name}--fold`   the window at its real size (880x660), as it opens;
 *   - `{name}--p{n}`   the whole section, photographed in bands of one window
 *                      height or so, because the section scrolls inside the
 *                      window and a single very tall image is downscaled past
 *                      legibility by anything that reads it.
 *
 * Everything goes through the production seams: the Tauri shim for IPC, the
 * settings overlay in localStorage for what it owns (calibrated rigs before
 * Rust adopts them, the pinned display), and a stubbed `navigator.mediaDevices`
 * under the real voice facade for the Audio section.
 */

const CAPTURE = process.env['DESIGN_CAPTURE'] === '1';
const OUT = process.env['DESIGN_CAPTURE_DIR'];

test.skip(!CAPTURE, 'design capture harness — set DESIGN_CAPTURE=1');
test.describe.configure({ mode: 'serial' });
// Retina, as the window is actually seen: 12px metadata at 1x is too soft to
// judge weight and contrast from.
test.use({ deviceScaleFactor: 2 });

const WINDOW = { width: 880, height: 660 };
const SMALLEST = { width: 720, height: 480 };
/** Band height for whole-section captures, in CSS pixels. */
const BAND = 1100;

const OVERLAY_KEY = 'speaking-glass.settings-overlay.v1';

const BUILTIN = {
  id: 'display-0',
  name: 'Built-in Retina Display',
  physicalPosition: { x: 0, y: 0 },
  physicalSize: { width: 3024, height: 1964 },
  scaleFactor: 2,
  logicalSize: { width: 1512, height: 982 },
  primary: true,
  fingerprint: 'dsp-e2e-builtin',
  topologyHash: 'top-e2e',
};

/** The 9-inch Elgato at its native mode, which discovery identifies by its grid. */
const ELGATO = {
  id: 'display-1',
  name: 'Elgato Prompter',
  physicalPosition: { x: 3024, y: 0 },
  physicalSize: { width: 1024, height: 600 },
  scaleFactor: 1,
  logicalSize: { width: 1024, height: 600 },
  primary: false,
  fingerprint: 'dsp-e2e-prompter',
  topologyHash: 'top-e2e',
};

/** A panel Speaking Glass cannot size: no model match and no EDID millimetres. */
const UNKNOWN_PANEL = {
  id: 'display-1',
  name: 'HDMI Capture Monitor',
  physicalPosition: { x: 3024, y: 0 },
  physicalSize: { width: 1920, height: 1080 },
  scaleFactor: 1,
  logicalSize: { width: 1920, height: 1080 },
  primary: false,
  fingerprint: 'dsp-e2e-prompter',
  topologyHash: 'top-e2e',
};

/** The 9-inch Elgato's physical scale: 228.6 mm diagonal over a 1024x600 grid. */
const ELGATO_MM_PER_PX = (228.6 * 1024) / Math.hypot(1024, 600) / 1024;

function rig(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    rigName: name,
    hardwareKind: 'elgato-prompter',
    scale: { mmPerCssPx: ELGATO_MM_PER_PX, source: 'model', diagonalMm: 228.6 },
    viewingDistanceMm: 900,
    safeArea: { top: 0.02, right: 0.03, bottom: 0.02, left: 0.03 },
    lens: { x: 0.5, y: 0.36 },
    lensPlacement: 'in-panel',
    flips: { horizontal: true, vertical: false },
    framing: 'head-and-shoulders',
    bias: 0.4,
    overrides: {},
    intensity: 'standard',
    readingCue: 'ticks',
    completedSteps: [
      'hardware',
      'safe-area',
      'orientation',
      'lens',
      'distance',
      'text-size',
      'line-width',
      'brightness',
    ],
    ...overrides,
  };
}

const rigKey = (fingerprint: string, name: string) =>
  `${encodeURIComponent(fingerprint)}::${encodeURIComponent(name)}`;

const TWO_RIGS = {
  profiles: {
    [rigKey('dsp-e2e-prompter', 'Desk hood')]: rig('Desk hood', { overrides: { fontSizePx: 58 } }),
    [rigKey('dsp-e2e-prompter', 'Boom arm, standing')]: rig('Boom arm, standing', {
      viewingDistanceMm: 1400,
      framing: 'waist-up',
    }),
  },
  activeRig: { 'dsp-e2e-prompter': 'Desk hood' },
  panelMirror: { 'dsp-e2e-prompter': { horizontal: true, vertical: false } },
};

interface Fixture {
  shim?: ShimConfig;
  /** Replaces the shim's display list. */
  displays?: unknown[];
  /** Seeded into the settings overlay before boot. */
  overlay?: Record<string, unknown>;
  /** What `get_microphone_permission` answers — the OS's own view. */
  micAccess?: 'granted' | 'denied' | 'restricted' | 'prompt';
  /** `getUserMedia` refuses, as it does after a macOS denial. */
  micRefuse?: boolean;
}

/**
 * The page-side stubs. Serialised and run after the Tauri shim, so it can wrap
 * the shim's `invoke` rather than replace it.
 */
function stubs(config: {
  displays: unknown[] | null;
  overlay: Record<string, unknown> | null;
  micAccess: string;
  micRefuse: boolean;
}): void {
  if (config.overlay) {
    localStorage.setItem('speaking-glass.settings-overlay.v1', JSON.stringify(config.overlay));
  }

  // WKWebView has no Permissions API for the microphone, so the screen decides
  // from the native read. Recreate that hole.
  const query = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = (descriptor: PermissionDescriptor) =>
    descriptor.name === ('microphone' as PermissionName)
      ? Promise.reject(new TypeError("'microphone' is not a valid permission name"))
      : query(descriptor);

  const internals = (window as unknown as {
    __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> };
  }).__TAURI_INTERNALS__;
  const invoke = internals.invoke.bind(internals);
  internals.invoke = (command: string, args?: unknown) => {
    if (command === 'get_microphone_permission') return Promise.resolve(config.micAccess);
    if (command === 'open_microphone_settings') return Promise.resolve(null);
    if (command === 'list_displays' && config.displays) {
      return invoke(command, args).then(() => config.displays);
    }
    if (command === 'get_system_diagnostics') {
      return Promise.resolve({
        appVersion: '0.1.0-e2e',
        os: 'macos',
        arch: 'aarch64',
        databaseIntegrityOk: true,
        scriptCount: 24,
        sessionCount: 311,
        dataDir: '/Users/presenter/Library/Application Support/com.speakingglass.app',
      });
    }
    return invoke(command, args);
  };

  const media = navigator.mediaDevices;
  const devices = [
    { deviceId: 'default', label: 'Default - MacBook Pro Microphone', groupId: 'g-mbp' },
    { deviceId: 'mbp-mic', label: 'MacBook Pro Microphone', groupId: 'g-mbp' },
    { deviceId: 'shure-mv7', label: 'Shure MV7', groupId: 'g-shure' },
  ];
  media.enumerateDevices = () =>
    Promise.resolve(
      devices.map((d) => ({ ...d, kind: 'audioinput', toJSON: () => d }) as unknown as MediaDeviceInfo),
    );
  const getUserMedia = media.getUserMedia.bind(media);
  media.getUserMedia = (constraints?: MediaStreamConstraints) => {
    if (config.micRefuse) {
      return Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
    }
    const audio = constraints?.audio;
    const loose =
      typeof audio === 'object' && audio !== null
        ? { ...constraints, audio: { ...audio, deviceId: undefined } }
        : constraints;
    return getUserMedia(loose);
  };
  // A steady speaking level, so the meter shows a voice rather than silence.
  AnalyserNode.prototype.getFloatTimeDomainData = function fill(buffer: Float32Array) {
    for (let i = 0; i < buffer.length; i += 1) buffer[i] = 0.3 * Math.sin((2 * Math.PI * i) / 48);
  };
}

async function boot(page: Page, fixture: Fixture, section: string | null, size = WINDOW): Promise<void> {
  await page.setViewportSize(size);
  await installTauriShim(page, { welcomed: true, ...fixture.shim });
  await page.addInitScript(stubs, {
    displays: fixture.displays ?? null,
    overlay: fixture.overlay ?? null,
    micAccess: fixture.micAccess ?? 'granted',
    micRefuse: fixture.micRefuse ?? false,
  });
  await openPreferences(page);
  if (section) await gotoSection(page, section);
}

const shots: string[] = [];

function outDir(): string {
  if (!OUT) throw new Error('DESIGN_CAPTURE_DIR must be set to a directory outside the repo');
  mkdirSync(OUT, { recursive: true });
  return OUT;
}

function written(path: string, name: string): void {
  if (!existsSync(path) || statSync(path).size < 2000) throw new Error(`capture ${name} is missing`);
  shots.push(name);
}

/** The window at the size it is, as it opens. */
async function fold(page: Page, name: string): Promise<void> {
  const dir = outDir();
  await page.waitForTimeout(350);
  const path = join(dir, `${name}--fold.png`);
  await page.screenshot({ path, animations: 'disabled', caret: 'hide' });
  written(path, `${name}--fold`);
}

/**
 * The whole section, in bands.
 *
 * The section scrolls inside `.content`, not the page, so a page screenshot is
 * only ever one window tall. The viewport is grown to the section's full height
 * (toolbar included) and the result cut into bands.
 */
async function whole(page: Page, name: string): Promise<void> {
  const dir = outDir();
  const measure = () =>
    page.evaluate(() => {
      const content = document.querySelector<HTMLElement>('.page .content');
      if (!content) throw new Error('the Settings content region is missing');
      return Math.ceil(content.getBoundingClientRect().top + content.scrollHeight);
    });
  const height = Math.max(WINDOW.height, await measure());
  await page.setViewportSize({ width: WINDOW.width, height });
  await page.waitForTimeout(350);
  const settled = Math.max(WINDOW.height, await measure());
  if (settled !== height) await page.setViewportSize({ width: WINDOW.width, height: settled });
  // Bands of BAND pixels, with a short remainder folded into the band before
  // it: a 20px sliver is not a picture of anything, and it would change the
  // file list every time a section grew or shrank by a line.
  const bands: Array<{ y: number; height: number }> = [];
  for (let y = 0; y < settled; y += BAND) {
    const height = Math.min(BAND, settled - y);
    const last = bands[bands.length - 1];
    if (last && height < BAND / 4) last.height += height;
    else bands.push({ y, height });
  }
  for (const [index, band] of bands.entries()) {
    const path = join(dir, `${name}--p${index + 1}.png`);
    await page.screenshot({
      path,
      animations: 'disabled',
      caret: 'hide',
      clip: { x: 0, y: band.y, width: WINDOW.width, height: band.height },
    });
    written(path, `${name}--p${index + 1}`);
  }
  await page.setViewportSize(WINDOW);
}

const content = (page: Page) => page.locator('.page .content');
const meterStatus = (page: Page) =>
  page.locator('[role="meter"]').locator('xpath=..').locator('.status');

/* --------------------------------------------------------------- General */

test('general', async ({ page }) => {
  await boot(page, {}, null);
  await expect(page.getByRole('switch', { name: 'Follow headings as spoken lines' })).toBeVisible();
  await fold(page, 'general');
  await page.setViewportSize(SMALLEST);
  await fold(page, 'general--smallest');
});

test('general: a mode saved by an older build', async ({ page }) => {
  await boot(page, { shim: { promptMode: 'manual' } }, null);
  await expect(page.getByRole('button', { name: /^Switch to/ })).toBeVisible();
  await fold(page, 'general-legacy-mode');
});

/* ---------------------------------------------------------------- Speech */

test('speech: installed and ready', async ({ page }) => {
  await boot(page, {}, 'Speech');
  await expect(content(page).getByRole('button', { name: /Remove/ })).toBeVisible();
  await fold(page, 'speech');
  await whole(page, 'speech');
});

test('speech: not installed', async ({ page }) => {
  const missing = {
    installed: false,
    phase: 'notInstalled',
    source: null,
  };
  await boot(
    page,
    {
      shim: {
        modelStatus: {
          modelId: 'x-asr-480ms',
          languages: ['en', 'zh'],
          supported: true,
          downloadBytes: 133_895_136,
          installedBytes: 169_347_218,
          progressBytes: 0,
          progressTotal: 0,
          operationId: null,
          error: null,
          ...missing,
        },
      },
    },
    'Speech',
  );
  await expect(content(page).getByRole('button', { name: /Download/ }).first()).toBeVisible();
  await fold(page, 'speech-missing');
});

/* ----------------------------------------------------------------- Audio */

test('audio: microphone allowed', async ({ page }) => {
  await boot(page, {}, 'Audio');
  await expect(page.getByLabel('Input device')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Test transcription' })).toBeVisible();
  // The meter calibrates before it hears anything; capture it settled.
  await expect(meterStatus(page)).toHaveText('Hearing you');
  await fold(page, 'audio');
  await page.getByText(/^Capture tuning/).click();
  await expect(page.getByRole('switch', { name: 'Noise suppression' })).toBeVisible();
  await whole(page, 'audio-tuning-open');
});

test('audio: microphone refused', async ({ page }) => {
  await boot(page, { micAccess: 'denied', micRefuse: true }, 'Audio');
  await expect(page.getByRole('button', { name: 'Open System Settings' })).toBeVisible();
  await fold(page, 'audio-denied');
});

/* ----------------------------------------------- Prompter display and rigs */

test('prompter display: Elgato sized automatically', async ({ page }) => {
  await boot(page, { displays: [BUILTIN, ELGATO] }, 'Prompter display and rigs');
  await expect(page.getByText(/^Sized automatically/)).toBeVisible();
  await expect(page.getByText('Body text')).toBeVisible();
  await fold(page, 'display-automatic');
  await whole(page, 'display-automatic');
});

test('prompter display: two calibrated rigs, advanced open', async ({ page }) => {
  await boot(
    page,
    { displays: [BUILTIN, ELGATO], overlay: { optical: TWO_RIGS } },
    'Prompter display and rigs',
  );
  await expect(page.getByRole('button', { name: /Re-calibrate Desk hood/ })).toBeVisible();
  await expect(page.getByText('Boom arm, standing')).toBeVisible();
  await page.getByText(/^Advanced/).click();
  await expect(page.getByText('Reset everything to automatic')).toBeVisible();
  await whole(page, 'display-rigs');
});

test('prompter display: a panel nothing can size', async ({ page }) => {
  await boot(page, { displays: [BUILTIN, UNKNOWN_PANEL] }, 'Prompter display and rigs');
  await expect(page.getByText(/^Using the \d+ px fallback/)).toBeVisible();
  await whole(page, 'display-unsized');
});

test('prompter display: the chosen panel is unplugged', async ({ page }) => {
  await boot(
    page,
    { displays: [BUILTIN], overlay: { stage: { displayFingerprint: 'dsp-e2e-prompter' } } },
    'Prompter display and rigs',
  );
  await expect(page.getByText(/chosen display is not connected/)).toBeVisible();
  await fold(page, 'display-pin-missing');
});

/* ---------------------------------------------------------- Teleprompter */

test('teleprompter: geometry owned by automatic sizing', async ({ page }) => {
  await boot(page, { displays: [BUILTIN, ELGATO] }, 'Teleprompter');
  await expect(page.getByText(/come from automatic sizing/).first()).toBeVisible();
  await fold(page, 'teleprompter-automatic');
  await whole(page, 'teleprompter-automatic');
});

test('teleprompter: fallback sliders live', async ({ page }) => {
  await boot(page, { displays: [BUILTIN, UNKNOWN_PANEL] }, 'Teleprompter');
  await expect(page.getByText(/These four are the/)).toBeVisible();
  await whole(page, 'teleprompter-fallback');
});

/* ------------------------------------------------------------- Following */

test('following', async ({ page }) => {
  await boot(page, {}, 'Following');
  await expect(page.getByRole('switch', { name: 'Developer diagnostics' })).toBeVisible();
  await fold(page, 'following');
});

/* ------------------------------------------------ Data, privacy & updates */

test('privacy and diagnostics', async ({ page }) => {
  await boot(page, {}, 'Data, privacy & updates');
  await expect(page.getByText('Database check')).toBeVisible();
  await fold(page, 'privacy');
  await whole(page, 'privacy');
});

/* ---------------------------------------------------------------- Search */

test('search: filtering a section', async ({ page }) => {
  await boot(page, { displays: [BUILTIN, ELGATO] }, 'Prompter display and rigs');
  await page.getByRole('searchbox', { name: 'Search settings' }).fill('mirror');
  await expect(page.getByText(/match “mirror”/)).toBeVisible();
  await fold(page, 'search-mirror');
});

test('search: a setting inside the closed Advanced fold', async ({ page }) => {
  await boot(
    page,
    { displays: [BUILTIN, ELGATO], overlay: { optical: TWO_RIGS } },
    'Prompter display and rigs',
  );
  await page.getByRole('searchbox', { name: 'Search settings' }).fill('reading corridor');
  await expect(page.getByRole('slider', { name: 'Reading corridor' })).toBeVisible();
  await fold(page, 'search-advanced');
});

test('search: nothing matches', async ({ page }) => {
  await boot(page, {}, null);
  await page.getByRole('searchbox', { name: 'Search settings' }).fill('bluetooth');
  await expect(page.getByText(/No settings match/)).toBeVisible();
  await fold(page, 'search-none');
});

test.afterAll(() => {
  // A visible tally, so a run that captured less than it should is obvious.
  console.log(`DESIGN_CAPTURE wrote ${shots.length}: ${shots.join(', ')}`);
});
