import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installTauriShim, type ShimConfig } from './fixtures/tauri-shim';

/**
 * Design capture harness for the first-run Welcome screen. OPT-IN.
 *
 * Not a test of behaviour — `welcome.spec.ts` owns that. This boots the real
 * Welcome route through the shim in each state that carries design weight and
 * writes one PNG per state and window size, so a layout change can be judged
 * from pixels rather than from the markup.
 *
 *     DESIGN_CAPTURE_DIR=/abs/dir SPEAKING_GLASS_E2E_PORT=5317 \
 *       ./node_modules/.bin/playwright test --config=playwright.config.ts \
 *       tests/e2e/browser/design-first-run.spec.ts
 *
 * Every capture is verified after the screen settles: the state's own status
 * labels must be on screen before anything is written, so a screenshot taken
 * before the display probe or the speech status answered throws instead of
 * quietly producing a "Checking…" frame under the wrong name.
 *
 * When the welcome content overflows the window a second frame is written with
 * the scroll container at its end (`-scrolled`), and `manifest.json` lists every
 * file written so the caller can count them.
 */

const OUT = process.env['DESIGN_CAPTURE_DIR'];
test.skip(!OUT, 'design capture harness: set DESIGN_CAPTURE_DIR to run it');

const OVERLAY_KEY = 'speaking-glass.settings-overlay.v1';

const SIZES = {
  wide: { width: 1240, height: 820 },
  narrow: { width: 980, height: 680 },
} as const;
type SizeName = keyof typeof SIZES;

const MODEL_BYTES = 133_895_136;

const NOT_INSTALLED = {
  modelId: 'x-asr-480ms',
  modelName: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05',
  languages: ['en', 'zh'],
  phase: 'notInstalled',
  source: null,
  installed: false,
  supported: true,
  downloadBytes: MODEL_BYTES,
  installedBytes: 169_347_218,
  progressBytes: 0,
  progressTotal: 0,
  operationId: null,
  error: null,
};

const DOWNLOADING = {
  ...NOT_INSTALLED,
  phase: 'downloading',
  progressBytes: 58_720_256,
  progressTotal: MODEL_BYTES,
  operationId: 'op-design-capture',
};

const DAMAGED = {
  ...NOT_INSTALLED,
  phase: 'failed',
  source: 'downloaded',
  error: {
    code: 'STT_MODEL_DAMAGED',
    message: 'Two of the speech model files no longer match the download.',
  },
};

/** Long names, for the state that stresses the display row's sentence. */
const LONG_NAMES: Record<string, string> = {
  'dsp-e2e-builtin': 'Built-in Liquid Retina XDR Display (Studio Desk, Left Arm)',
  'dsp-e2e-prompter': 'Elgato Prompter 9-inch · USB-C DisplayPort Alt Mode Adapter',
};

interface CaptureState {
  name: string;
  sizes: SizeName[];
  shim: ShimConfig;
  overlay?: Record<string, unknown>;
  longDisplayNames?: boolean;
  /** Labels that must all be visible before the frame is written. */
  expectText: string[];
  /** Tab until this button holds keyboard focus before capturing. */
  focusButton?: string;
  /** Press this button before capturing (a disclosure, say). */
  clickButton?: string;
  /** Commands to reject from boot, through the shim's own `setFail` seam. */
  failCommands?: string[];
}

const STATES: CaptureState[] = [
  {
    // A genuine first launch: nothing granted, nothing pinned, no speech data.
    name: 'fresh',
    sizes: ['wide', 'narrow'],
    shim: { windowDisplay: 'dsp-e2e-builtin', modelStatus: NOT_INSTALLED },
    expectText: ['Automatic', 'Set up microphone'],
  },
  {
    name: 'ready',
    sizes: ['wide', 'narrow'],
    shim: { windowDisplay: 'dsp-e2e-builtin' },
    overlay: { audio: { microphoneGranted: true }, stage: { displayFingerprint: 'dsp-e2e-prompter' } },
    expectText: ['Previously allowed', 'Connected', 'Installed'],
  },
  {
    // The installed picker folded open from its row.
    name: 'ready-language-open',
    sizes: ['wide'],
    shim: { windowDisplay: 'dsp-e2e-builtin' },
    overlay: { audio: { microphoneGranted: true }, stage: { displayFingerprint: 'dsp-e2e-prompter' } },
    clickButton: 'Change language',
    expectText: ['Installed', 'Currently using'],
  },
  {
    // Held long past the capture, so the in-flight frame is the one written.
    name: 'display-checking',
    sizes: ['wide'],
    shim: { listDisplaysDelayMs: 120_000, modelStatus: NOT_INSTALLED },
    expectText: ['Checking…'],
  },
  {
    name: 'display-failed',
    sizes: ['wide'],
    shim: { failListDisplays: true },
    expectText: ['Couldn’t check'],
  },
  {
    name: 'display-pin-missing',
    sizes: ['wide'],
    shim: { windowDisplay: 'dsp-e2e-builtin' },
    overlay: { audio: { microphoneGranted: true }, stage: { displayFingerprint: 'dsp-gone-from-this-desk' } },
    expectText: ['Needs attention', 'Fix display'],
  },
  {
    // Welcome never probes the microphone (WKWebView cannot report a refusal),
    // so a refused grant must read exactly like one never made.
    name: 'mic-refused',
    sizes: ['wide'],
    shim: { windowDisplay: 'dsp-e2e-builtin' },
    overlay: { audio: { microphoneGranted: false } },
    expectText: ['Set up microphone', 'Installed'],
  },
  {
    name: 'model-downloading',
    sizes: ['wide', 'narrow'],
    shim: { windowDisplay: 'dsp-e2e-builtin', modelStatus: DOWNLOADING },
    expectText: ['Downloading', 'Stop'],
  },
  {
    name: 'model-damaged',
    sizes: ['wide'],
    shim: { windowDisplay: 'dsp-e2e-builtin', modelStatus: DAMAGED },
    overlay: { audio: { microphoneGranted: true } },
    expectText: ['Damaged'],
  },
  {
    // The longest sentence the display row can say, with long OS names in it.
    name: 'long-display-name',
    sizes: ['wide', 'narrow'],
    shim: { windowDisplay: 'dsp-e2e-builtin' },
    overlay: { audio: { microphoneGranted: true }, stage: { displayFingerprint: 'dsp-gone-from-this-desk' } },
    longDisplayNames: true,
    expectText: ['Needs attention', LONG_NAMES['dsp-e2e-builtin']!],
  },
  {
    // The picker's first snapshot fails: its error and Try again must show.
    name: 'speech-load-failed',
    sizes: ['wide'],
    shim: { windowDisplay: 'dsp-e2e-builtin' },
    overlay: { audio: { microphoneGranted: true } },
    failCommands: ['get_speech_language_options'],
    expectText: ['Try again'],
  },
  {
    name: 'reader-mode',
    sizes: ['wide'],
    shim: { presentationMode: 'reader', windowDisplay: 'dsp-e2e-builtin' },
    overlay: { audio: { microphoneGranted: true } },
    expectText: ['This window', 'Installed'],
  },
  {
    name: 'focus-readiness',
    sizes: ['wide'],
    shim: { windowDisplay: 'dsp-e2e-builtin', modelStatus: NOT_INSTALLED },
    expectText: ['Automatic'],
    focusButton: 'Set up microphone',
  },
];

const written: string[] = [];

async function renameDisplays(page: Page): Promise<void> {
  await page.addInitScript((names: Record<string, string>) => {
    const internals = (window as unknown as {
      __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> };
    }).__TAURI_INTERNALS__;
    const invoke = internals.invoke;
    const rename = (d: unknown) => {
      if (d === null || typeof d !== 'object') return d;
      const display = d as { fingerprint?: string; name?: string };
      const long = display.fingerprint ? names[display.fingerprint] : undefined;
      return long ? { ...display, name: long } : display;
    };
    internals.invoke = (command, args) =>
      invoke(command, args).then((answer) => {
        if (command === 'list_displays' && Array.isArray(answer)) return answer.map(rename);
        if (command === 'current_window_display') return rename(answer);
        return answer;
      });
  }, LONG_NAMES);
}

/** The element that scrolls the welcome content, or null when it all fits. */
async function overflowingScroller(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const main = document.querySelector('main');
    if (!main) return false;
    const candidates = [main, ...Array.from(main.querySelectorAll<HTMLElement>('*'))];
    const scroller = candidates.find((el) => {
      const style = getComputedStyle(el);
      return /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1;
    });
    if (!scroller) return false;
    scroller.setAttribute('data-design-scroller', '');
    return true;
  });
}

for (const state of STATES) {
  for (const size of state.sizes) {
    test(`capture ${state.name} @ ${size}`, async ({ page }) => {
      await page.setViewportSize(SIZES[size]);
      await installTauriShim(page, state.shim);
      if (state.overlay) {
        await page.addInitScript(
          ([key, value]) => localStorage.setItem(key as string, value as string),
          [OVERLAY_KEY, JSON.stringify(state.overlay)] as const,
        );
      }
      if (state.longDisplayNames) await renameDisplays(page);
      if (state.failCommands) {
        await page.addInitScript((commands: string[]) => {
          const e2e = (window as unknown as {
            __E2E__: { setFail: (command: string, error: unknown) => void };
          }).__E2E__;
          for (const command of commands) {
            e2e.setFail(command, { code: 'IO_ERROR', userMessage: 'Could not read the speech catalogue.' });
          }
        }, state.failCommands);
      }
      await page.goto('/control.html');

      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      if (state.clickButton) {
        await page.getByRole('button', { name: state.clickButton }).click();
        // Off the control again, so the frame shows its rest state, not hover.
        await page.mouse.move(0, 0);
      }
      for (const text of state.expectText) {
        await expect(page.getByText(text, { exact: false }).first()).toBeVisible();
      }
      await page.evaluate(() => document.fonts.ready);

      if (state.focusButton) {
        const target = state.focusButton;
        let found = false;
        for (let i = 0; i < 25 && !found; i++) {
          await page.keyboard.press('Tab');
          found = await page.evaluate(
            (label) => (document.activeElement?.textContent ?? '').trim() === label,
            target,
          );
        }
        if (!found) throw new Error(`could not tab to "${target}"`);
      }
      // Let any transition finish before the frame is taken.
      await page.waitForTimeout(250);

      mkdirSync(OUT!, { recursive: true });
      const base = `${state.name}--${size}`;
      const file = join(OUT!, `${base}.png`);
      await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
      written.push(file);

      if (!state.focusButton && (await overflowingScroller(page))) {
        await page.evaluate(() => {
          const el = document.querySelector<HTMLElement>('[data-design-scroller]');
          if (el) el.scrollTop = el.scrollHeight;
        });
        await page.waitForTimeout(100);
        const scrolled = join(OUT!, `${base}-scrolled.png`);
        await page.screenshot({ path: scrolled, animations: 'disabled', caret: 'hide' });
        written.push(scrolled);
      }
    });
  }
}

test.afterAll(() => {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  const onDisk = readdirSync(OUT).filter((f) => f.endsWith('.png'));
  writeFileSync(
    join(OUT, 'manifest.json'),
    JSON.stringify({ written: written.map((f) => f.split('/').pop()), onDisk: onDisk.length }, null, 2),
  );
});
