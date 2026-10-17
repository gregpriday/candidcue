import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { installTauriShim } from './fixtures/tauri-shim';
import { gotoSection, openPreferences } from './fixtures/preferences';

/**
 * Design capture harness for Settings › Audio — choosing an input, checking
 * its level and test-transcribing it.
 *
 * OPT-IN. It writes screenshots and asserts only that each state it names is
 * the state on screen, so it is a tool for looking at the section rather than
 * a test of it, and it never runs in the normal suite:
 *
 *     DESIGN_CAPTURE=1 DESIGN_CAPTURE_DIR=/tmp/mic CANDIDCUE_E2E_PORT=5312 \
 *       ./node_modules/.bin/playwright test --config=playwright.config.ts \
 *       tests/e2e/browser/design-microphone-setup.spec.ts
 *
 * Everything goes through the production seams: the real voice facade over a
 * stubbed `navigator.mediaDevices`, the native permission read answered at the
 * IPC boundary, and recogniser frames delivered on `stt://event` as Rust sends
 * them. The level is made deterministic one layer down, in the analyser the
 * meter reads, so the real VAD and the real advice decide what is shown.
 */

const CAPTURE = process.env['DESIGN_CAPTURE'] === '1';
const OUT = process.env['DESIGN_CAPTURE_DIR'];

test.skip(!CAPTURE, 'design capture harness — set DESIGN_CAPTURE=1');
test.describe.configure({ mode: 'serial' });

type NativeAccess = 'granted' | 'denied' | 'restricted' | 'prompt' | 'unsupported';

interface MicFixture {
  /** What `get_microphone_permission` answers — the OS's own view (#303). */
  access: NativeAccess;
  /** `getUserMedia` refuses, as it does after a macOS denial. */
  refuse: boolean;
  /** Analyser amplitude, 0–1. */
  amplitude: number;
  waveform: 'sine' | 'square';
  devices: Array<{ deviceId: string; label: string; groupId: string }>;
  /** Seeded into the settings overlay's `audio` section before boot. */
  audio?: Record<string, unknown>;
}

const DEVICES: MicFixture['devices'] = [
  { deviceId: 'default', label: 'Default - MacBook Pro Microphone', groupId: 'g-mbp' },
  { deviceId: 'mbp-mic', label: 'MacBook Pro Microphone', groupId: 'g-mbp' },
  { deviceId: 'shure-mv7', label: 'Shure MV7', groupId: 'g-shure' },
  { deviceId: 'airpods-pro', label: 'AirPods Pro', groupId: 'g-airpods' },
];

const SPEAKING = 0.3;
const LOW = 0.006;

function fixture(overrides: Partial<MicFixture> = {}): MicFixture {
  return {
    access: 'granted',
    refuse: false,
    amplitude: SPEAKING,
    waveform: 'sine',
    devices: DEVICES,
    ...overrides,
  };
}

/**
 * The page-side stubs. Serialised and run after the Tauri shim, so it can
 * wrap the shim's `invoke` rather than replace it.
 */
function micStubs(config: MicFixture): void {
  const state = { ...config, generation: null as number | null };
  (window as unknown as { __MIC__: typeof state }).__MIC__ = state;

  if (config.audio) {
    localStorage.setItem('candidcue.settings-overlay.v1', JSON.stringify({ audio: config.audio }));
  }

  // WKWebView has no Permissions API for the microphone, so the screen must
  // decide from the native read. Recreate that hole.
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
    if (command === 'get_microphone_permission') return Promise.resolve(state.access);
    if (command === 'open_microphone_settings') return Promise.resolve(null);
    const answer = invoke(command, args);
    if (command === 'start_transcription') {
      return answer.then((generation) => {
        state.generation = generation as number;
        return generation;
      });
    }
    return answer;
  };

  const media = navigator.mediaDevices;
  media.enumerateDevices = () =>
    Promise.resolve(
      state.devices.map(
        (d) =>
          ({ ...d, kind: 'audioinput', toJSON: () => d }) as unknown as MediaDeviceInfo,
      ),
    );
  const getUserMedia = media.getUserMedia.bind(media);
  media.getUserMedia = (constraints?: MediaStreamConstraints) => {
    if (state.refuse) {
      return Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
    }
    // The fake capture device has none of the fixture's ids; drop the pin and
    // let the analyser stub decide what is heard.
    const audio = constraints?.audio;
    const loose =
      typeof audio === 'object' && audio !== null
        ? { ...constraints, audio: { ...audio, deviceId: undefined } }
        : constraints;
    return getUserMedia(loose);
  };

  AnalyserNode.prototype.getFloatTimeDomainData = function fill(buffer: Float32Array) {
    const a = state.amplitude;
    for (let i = 0; i < buffer.length; i += 1) {
      const s = Math.sin((2 * Math.PI * i) / 48);
      buffer[i] = state.waveform === 'square' ? (s >= 0 ? a : -a) : a * s;
    }
  };
}

async function boot(page: Page, config: MicFixture, size: { width: number; height: number }) {
  await page.setViewportSize(size);
  await installTauriShim(page, { welcomed: true });
  await page.addInitScript(micStubs, config);
  await openPreferences(page);
  await gotoSection(page, 'Audio');
}

const shots: string[] = [];

async function shoot(page: Page, name: string): Promise<void> {
  if (!OUT) throw new Error('DESIGN_CAPTURE_DIR must be set to a directory outside the repo');
  mkdirSync(OUT, { recursive: true });
  // Let the meter's transition and any reflow settle on the asserted state.
  await page.waitForTimeout(400);
  const path = join(OUT, `${name}.png`);
  await page.screenshot({ path, animations: 'disabled', caret: 'hide' });
  if (!existsSync(path) || statSync(path).size < 2000) throw new Error(`capture ${name} is missing`);
  shots.push(name);
}

const LARGE = { width: 880, height: 660 };
const SMALL = { width: 720, height: 480 };
const TALL = { width: 880, height: 1180 };

const meterStatus = (page: Page) => page.locator('[role="meter"]').locator('xpath=..').locator('.status');

async function emitFrame(page: Page, frame: Record<string, unknown>): Promise<void> {
  const delivered = await page.evaluate((f) => {
    const generation = (window as unknown as { __MIC__: { generation: number | null } }).__MIC__
      .generation;
    return window.__E2E__.emit('stt://event', { ...f, generation });
  }, frame);
  expect(delivered, 'the test must be listening for recogniser frames').toBeGreaterThan(0);
}

async function startTestAndListen(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Test transcription' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __MIC__: { generation: number | null } }).__MIC__.generation))
    .not.toBeNull();
  await expect(page.getByRole('button', { name: 'Stop test' })).toBeVisible();
}

/* ------------------------------------------------------------- permission */

test('permission: not yet asked', async ({ page }) => {
  await boot(page, fixture({ access: 'prompt' }), LARGE);
  await expect(page.getByRole('button', { name: 'Allow and choose microphone' })).toBeVisible();
  await shoot(page, 'perm-unknown--880');
});

test('permission: denied', async ({ page }) => {
  await boot(page, fixture({ access: 'denied', refuse: true }), LARGE);
  await expect(page.getByRole('button', { name: 'Open System Settings' })).toBeVisible();
  await shoot(page, 'perm-denied--880');
  await page.setViewportSize(SMALL);
  await shoot(page, 'perm-denied--720');
});

test('permission: restricted by policy', async ({ page }) => {
  await boot(page, fixture({ access: 'restricted', refuse: true }), LARGE);
  await expect(page.getByText(/managed on this Mac/i).first()).toBeVisible();
  await shoot(page, 'perm-restricted--880');
});

test('permission: allowed in System Settings since the refusal', async ({ page }) => {
  await boot(page, fixture({ access: 'denied', refuse: true }), LARGE);
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __MIC__: { access: string } }).__MIC__.access = 'granted';
    window.dispatchEvent(new Event('focus'));
  });
  await expect(page.getByText(/Microphone access is on/i).first()).toBeVisible();
  await shoot(page, 'perm-allowed-since--880');
});

test('permission: try again refused again', async ({ page }) => {
  await boot(page, fixture({ access: 'denied', refuse: true }), LARGE);
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText(/quit and reopen/i).first()).toBeVisible();
  await shoot(page, 'perm-retry-refused--880');
});

/* ------------------------------------------------------------------ input */

test('granted: system default, speaking', async ({ page }) => {
  await boot(page, fixture(), LARGE);
  await expect(page.getByLabel('Input device')).toHaveValue('__system_default__');
  await expect(meterStatus(page)).toHaveText('Hearing you');
  await shoot(page, 'default-speaking--880');
  await page.setViewportSize(SMALL);
  await expect(meterStatus(page)).toHaveText('Hearing you');
  await shoot(page, 'default-speaking--720');
  await page.setViewportSize(TALL);
  await expect(meterStatus(page)).toHaveText('Hearing you');
  await shoot(page, 'section-whole--880x1180');
  await page.getByText(/^Capture tuning/).click();
  await expect(page.getByRole('switch', { name: 'Noise suppression' })).toBeVisible();
  await shoot(page, 'capture-tuning-open--880x1180');
});

test('granted: a pinned input', async ({ page }) => {
  await boot(
    page,
    fixture({
      audio: {
        microphoneGranted: true,
        followSystemDefault: false,
        preferredDeviceId: 'shure-mv7',
        preferredDeviceLabel: 'Shure MV7',
      },
    }),
    LARGE,
  );
  await expect(page.getByLabel('Input device')).toHaveValue('shure-mv7');
  await expect(meterStatus(page)).toHaveText('Hearing you');
  await shoot(page, 'pinned-speaking--880');
});

test('granted: the pinned input is unplugged', async ({ page }) => {
  await boot(
    page,
    fixture({
      audio: {
        microphoneGranted: true,
        followSystemDefault: false,
        preferredDeviceId: 'rode-nt-usb-mini',
        preferredDeviceLabel: 'RØDE NT-USB Mini',
      },
    }),
    LARGE,
  );
  await expect(page.getByLabel('Input device')).toHaveValue('rode-nt-usb-mini');
  await expect(page.getByText(/not connected/i).filter({ visible: true }).first()).toBeVisible();
  await expect(meterStatus(page)).toHaveText('Hearing you');
  await shoot(page, 'pin-disconnected--880');
  await page.setViewportSize(SMALL);
  await shoot(page, 'pin-disconnected--720');
});

/* ------------------------------------------------------------------ level */

test('level: silence', async ({ page }) => {
  await boot(page, fixture({ amplitude: 0 }), LARGE);
  await expect(meterStatus(page)).toHaveText('No signal');
  await shoot(page, 'level-silence--880');
});

test('level: too quiet', async ({ page }) => {
  await boot(page, fixture({ amplitude: LOW }), LARGE);
  await expect(meterStatus(page)).toHaveText('Too quiet');
  await shoot(page, 'level-low--880');
});

test('level: clipping', async ({ page }) => {
  await boot(page, fixture({ amplitude: 1, waveform: 'square' }), LARGE);
  await expect(meterStatus(page)).toHaveText('Clipping');
  await shoot(page, 'level-clipping--880');
});

/* ------------------------------------------------------------------- test */

test('test: opening, listening, hearing, answered', async ({ page }) => {
  await boot(page, fixture(), LARGE);
  await expect(meterStatus(page)).toHaveText('Hearing you');
  await expect(page.getByRole('button', { name: 'Test transcription' })).toBeVisible();
  await shoot(page, 'test-idle--880');

  await page.evaluate(() => window.__E2E__.setHeld('start_transcription', true));
  await page.getByRole('button', { name: 'Test transcription' }).click();
  await expect(page.getByRole('button', { name: 'Stop test' })).toBeVisible();
  await expect(page.getByText(/Starting speech recognition/i).first()).toBeVisible();
  await shoot(page, 'test-opening--880');

  await page.evaluate(() => window.__E2E__.setHeld('start_transcription', false));
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __MIC__: { generation: number | null } }).__MIC__.generation))
    .not.toBeNull();
  await expect(page.getByText(/Listening/).first()).toBeVisible();
  await shoot(page, 'test-listening--880');

  await emitFrame(page, { kind: 'partial', itemId: 'i1', text: 'CandidCue is following' });
  await expect(page.getByText('CandidCue is following', { exact: false }).first()).toBeVisible();
  await shoot(page, 'test-waiting--880');

  await emitFrame(page, {
    kind: 'final',
    itemId: 'i1',
    text: 'CandidCue is following my voice.',
    audioEndMs: 2400,
  });
  await expect(page.getByRole('button', { name: 'Stop test' })).toHaveCount(0);
  await expect(page.getByText('CandidCue is following my voice.').first()).toBeVisible();
  // The meter reopens once the test lets go; capture it settled, not mid-calibration.
  await expect(meterStatus(page)).toHaveText('Hearing you');
  await shoot(page, 'test-success--880');
  await page.setViewportSize(SMALL);
  await shoot(page, 'test-success--720');
});

test('test: nothing transcribed for 30 seconds', async ({ page }) => {
  await page.clock.install();
  await boot(page, fixture(), LARGE);
  await startTestAndListen(page);
  await page.clock.fastForward(31_000);
  await expect(page.getByRole('button', { name: 'Stop test' })).toHaveCount(0);
  await expect(page.getByText(/Nothing was transcribed/i).first()).toBeVisible();
  await expect(meterStatus(page)).toHaveText('Hearing you');
  await shoot(page, 'test-timeout--880');
});

test('test: the recogniser fails', async ({ page }) => {
  await boot(page, fixture(), LARGE);
  await startTestAndListen(page);
  await emitFrame(page, {
    kind: 'failed',
    code: 'STT_MODEL_NOT_INSTALLED',
    message: 'model not installed',
    recoverable: false,
  });
  await expect(page.getByRole('button', { name: 'Stop test' })).toHaveCount(0);
  await expect(page.getByText(/not installed/i).first()).toBeVisible();
  await expect(meterStatus(page)).toHaveText('Hearing you');
  await shoot(page, 'test-error--880');
});

test.afterAll(() => {
  // A visible tally, so a run that captured less than it should is obvious.
  console.log(`DESIGN_CAPTURE wrote ${shots.length}: ${shots.join(', ')}`);
});
