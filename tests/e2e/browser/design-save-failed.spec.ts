/**
 * Design capture harness for the editor's "save failed" sheet (F.8). Opt-in:
 * it writes screenshots for a design review and asserts nothing about
 * behaviour, so it never runs in the normal suite.
 *
 *   DESIGN_CAPTURE=1 DESIGN_CAPTURE_DIR=/abs/out SPEAKING_GLASS_E2E_PORT=5320 \
 *     ./node_modules/.bin/playwright test tests/e2e/browser/design-save-failed.spec.ts
 *
 * The common shim can only make `save_script` reject outright, so this spec
 * wraps the shim's `invoke` for `save_script` and `reveal_script_folder` and
 * forwards every other command unchanged. A save can answer, fail, or be held
 * open (the retry in flight); the reveal can answer or fail. Each state is
 * driven through that seam and the real autosave, never by reaching into the
 * component.
 *
 * Every state is written twice: the whole window, and a 2x crop of the sheet
 * with a margin of the editor around it.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { installTauriShim } from './fixtures/tauri-shim';
import { collection, openScript } from './fixtures/library';

const CAPTURE = process.env['DESIGN_CAPTURE'] === '1';
const OUT = process.env['DESIGN_CAPTURE_DIR'];

test.skip(!CAPTURE, 'design capture harness — set DESIGN_CAPTURE=1');

const SIZES = {
  default: { name: 'default', width: 1240, height: 820 },
  min: { name: 'min', width: 980, height: 680 },
} as const;
type Size = (typeof SIZES)[keyof typeof SIZES];
type Platform = 'macos' | 'windows';

const PARAGRAPHS = [
  'Most teleprompters make you choose between reading and performing. You either lock your eyes on the glass and sound like you are reading, or you look away and lose your place. This one listens instead, so the words follow you rather than the other way round.',
  'Here is the part that surprised me. The hard problem was never transcription. It was deciding, from a few half-heard words, where in the script you actually are, and doing it without ever jumping somewhere you did not go.',
  '[Beat] So the engine is deliberately boring. It is deterministic, it never invents a position, and when it is unsure it simply waits for the next phrase.',
  'If you ad-lib, it holds. If you skip a paragraph, it notices the jump and catches up once two or three words agree.',
  'The model runs on your own machine. Nothing you say leaves it, and there is no account to sign into before you can record.',
];

const SCRIPT = {
  id: '5a7ef00d-5a7e-4a7e-8a7e-5a7ef00d5a7e',
  title: 'Spring launch keynote',
  source: [
    '# Spring launch keynote',
    '## Opening',
    PARAGRAPHS[0],
    PARAGRAPHS[1],
    '## How the engine decides',
    PARAGRAPHS[2],
    PARAGRAPHS[3],
    '## Privacy',
    PARAGRAPHS[4],
  ].join('\n\n') + '\n',
};

/* ------------------------------------------------------------------------ */
/* The save seam                                                            */
/* ------------------------------------------------------------------------ */

type Mode = 'answer' | 'fail' | 'hold';

interface SaveSeam {
  save: Mode;
  saveError: unknown;
  reveal: 'answer' | 'fail';
  revealError: unknown;
  saveCalls: number;
  revealCalls: number;
}

async function installSaveSeam(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seam: SaveSeam = {
      save: 'answer',
      saveError: null,
      reveal: 'answer',
      revealError: null,
      saveCalls: 0,
      revealCalls: 0,
    };
    (window as unknown as { __SAVE__: SaveSeam }).__SAVE__ = seam;

    const internals = (window as unknown as {
      __TAURI_INTERNALS__: { invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown> };
    }).__TAURI_INTERNALS__;
    const forward = internals.invoke.bind(internals);

    internals.invoke = (command, args) => {
      if (command === 'save_script') {
        seam.saveCalls += 1;
        if (seam.save === 'hold') return new Promise<never>(() => {});
        if (seam.save === 'fail') return Promise.reject(seam.saveError);
      }
      if (command === 'reveal_script_folder') {
        seam.revealCalls += 1;
        if (seam.reveal === 'fail') return Promise.reject(seam.revealError);
        return Promise.resolve(undefined);
      }
      return forward(command, args);
    };
  });
}

async function configure(page: Page, patch: Partial<SaveSeam>): Promise<void> {
  await page.evaluate((p) => {
    Object.assign((window as unknown as { __SAVE__: SaveSeam }).__SAVE__, p);
  }, patch);
}

const seamCount = (page: Page, key: 'saveCalls' | 'revealCalls') =>
  page.evaluate((k) => (window as unknown as { __SAVE__: SaveSeam }).__SAVE__[k], key);

/* ------------------------------------------------------------------------ */
/* Errors, as Rust raises them                                              */
/* ------------------------------------------------------------------------ */

const DISK_ERROR = {
  code: 'SCRIPT_SAVE_FAILED',
  userMessage: 'Speaking Glass could not write the script file.',
};
const FILE_MISSING = {
  code: 'SCRIPT_FILE_MISSING',
  userMessage: 'The script file is missing.',
};
const UNEXPECTED = {
  code: 'INTERNAL_UNEXPECTED',
  userMessage: 'Something unexpected went wrong.',
};

/* ------------------------------------------------------------------------ */
/* Driving                                                                  */
/* ------------------------------------------------------------------------ */

const sheet = (page: Page): Locator => page.getByRole('dialog').filter({ hasText: /save|Save/ }).first();
const trigger = (page: Page): Locator => page.getByRole('button', { name: /Save failed|Not saved|couldn.t save/i });

/**
 * Present the webview as macOS (or Windows) the way the app reads it.
 *
 * Playwright's desktop Chrome profile reports Windows, and the sheet names the
 * file manager by platform, so without this every capture showed the Windows
 * wording on a macOS-first app.
 */
async function emulatePlatform(page: Page, platform: Platform): Promise<void> {
  await page.addInitScript((p) => {
    const mac = p === 'macos';
    Object.defineProperty(navigator, 'platform', { get: () => (mac ? 'MacIntel' : 'Win32') });
    Object.defineProperty(navigator, 'userAgentData', {
      get: () => ({ platform: mac ? 'macOS' : 'Windows', brands: [], mobile: false }),
    });
  }, platform);
}

async function boot(page: Page, size: Size, platform: Platform): Promise<void> {
  await page.setViewportSize({ width: size.width, height: size.height });
  await emulatePlatform(page, platform);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await installTauriShim(page, { welcomed: true, seedScripts: [SCRIPT] });
  await installSaveSeam(page);
  await page.goto('/control.html');
  await expect(collection(page)).toBeVisible();
  await openScript(page, SCRIPT.title);
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('Most teleprompters');
}

/** Type, and let the real autosave fail against `error`. */
async function failAutosave(page: Page, error: unknown): Promise<void> {
  await configure(page, { save: 'fail', saveError: error });
  const editorSurface = page.getByRole('textbox', { name: 'Script Markdown' });
  await editorSurface.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' A closing line typed since the last save.');
  await expect.poll(() => seamCount(page, 'saveCalls')).toBeGreaterThan(0);
  await expect(trigger(page)).toBeVisible();
}

async function openByPointer(page: Page): Promise<void> {
  await trigger(page).click();
  await expect(sheet(page)).toBeVisible();
}

async function openByKeyboard(page: Page): Promise<void> {
  await trigger(page).focus();
  await page.keyboard.press('Enter');
  await expect(sheet(page)).toBeVisible();
}

async function shoot(page: Page, state: string, size: Size, crop: 'sheet' | 'toolbar' | 'auto'): Promise<void> {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT!, `save-failed--${state}--${size.name}.png`) });
  let box: { x: number; y: number; width: number; height: number } | null = null;
  // `auto`: the sheet if it is still up, otherwise the whole window says it all.
  if (crop === 'auto' && (await sheet(page).isVisible())) crop = 'sheet';
  if (crop === 'sheet') {
    box = await sheet(page).boundingBox();
    if (!box || box.width < 50) throw new Error(`${state}: the sheet is not on screen`);
  } else if (crop === 'toolbar') {
    box = await page.locator('header.toolbar').first().boundingBox();
    if (!box) throw new Error(`${state}: no toolbar`);
    box = { x: box.x, y: box.y, width: Math.min(box.width, 760), height: box.height };
  }
  if (box) {
    const margin = 28;
    const x = Math.max(0, box.x - margin);
    const y = Math.max(0, box.y - margin);
    const clip = {
      x,
      y,
      width: Math.min(size.width - x, box.width + margin * 2),
      height: Math.min(size.height - y, box.height + margin * 2),
    };
    await page.screenshot({ path: join(OUT!, `save-failed--${state}--${size.name}--crop.png`), clip });
  }
}

/* ------------------------------------------------------------------------ */
/* States                                                                    */
/* ------------------------------------------------------------------------ */

const STATES: Array<{
  name: string;
  size: Size;
  crop?: 'sheet' | 'toolbar' | 'auto';
  platform?: Platform;
  drive: (page: Page) => Promise<void>;
}> = [
  {
    name: 'trigger',
    size: SIZES.default,
    crop: 'toolbar',
    drive: async (page) => {
      await failAutosave(page, DISK_ERROR);
      await page.mouse.move(2, 400);
    },
  },
  {
    name: 'disk-error',
    size: SIZES.default,
    drive: async (page) => {
      await failAutosave(page, DISK_ERROR);
      await openByPointer(page);
      await page.mouse.move(2, 400);
    },
  },
  {
    name: 'disk-error-keyboard',
    size: SIZES.default,
    drive: async (page) => {
      await failAutosave(page, DISK_ERROR);
      await openByKeyboard(page);
    },
  },
  {
    name: 'file-missing',
    size: SIZES.default,
    drive: async (page) => {
      await failAutosave(page, FILE_MISSING);
      await openByPointer(page);
      await page.mouse.move(2, 400);
    },
  },
  {
    name: 'unexpected',
    size: SIZES.default,
    drive: async (page) => {
      await failAutosave(page, UNEXPECTED);
      await openByPointer(page);
      await page.mouse.move(2, 400);
    },
  },
  {
    name: 'retrying',
    size: SIZES.default,
    crop: 'auto',
    drive: async (page) => {
      await failAutosave(page, DISK_ERROR);
      await openByPointer(page);
      const before = await seamCount(page, 'saveCalls');
      await configure(page, { save: 'hold' });
      await sheet(page).getByRole('button', { name: /Retry|Try again|Saving/ }).click();
      await expect.poll(() => seamCount(page, 'saveCalls')).toBeGreaterThan(before);
      await page.mouse.move(2, 400);
    },
  },
  {
    name: 'retry-failed',
    size: SIZES.default,
    crop: 'auto',
    drive: async (page) => {
      await failAutosave(page, DISK_ERROR);
      await openByPointer(page);
      const before = await seamCount(page, 'saveCalls');
      await sheet(page).getByRole('button', { name: /Retry|Try again/ }).click();
      await expect.poll(() => seamCount(page, 'saveCalls')).toBeGreaterThan(before);
      await page.mouse.move(2, 400);
    },
  },
  {
    name: 'retry-saved',
    size: SIZES.default,
    crop: 'auto',
    drive: async (page) => {
      await failAutosave(page, DISK_ERROR);
      await openByPointer(page);
      const before = await seamCount(page, 'saveCalls');
      await configure(page, { save: 'answer' });
      await sheet(page).getByRole('button', { name: /Retry|Try again/ }).click();
      await expect.poll(() => seamCount(page, 'saveCalls')).toBeGreaterThan(before);
      await expect(trigger(page)).toHaveCount(0);
      await page.mouse.move(2, 400);
    },
  },
  {
    name: 'copied',
    size: SIZES.default,
    crop: 'auto',
    drive: async (page) => {
      await failAutosave(page, DISK_ERROR);
      await openByPointer(page);
      await sheet(page).getByRole('button', { name: /Copy/ }).first().click();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toContain('Spring launch keynote');
      await page.mouse.move(2, 400);
    },
  },
  {
    name: 'copied-then-retry-failed',
    size: SIZES.default,
    crop: 'auto',
    drive: async (page) => {
      await failAutosave(page, DISK_ERROR);
      await openByPointer(page);
      await sheet(page).getByRole('button', { name: /Copy/ }).first().click();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toContain('Spring launch keynote');
      const before = await seamCount(page, 'saveCalls');
      await sheet(page).getByRole('button', { name: /Retry|Try again/ }).click();
      await expect.poll(() => seamCount(page, 'saveCalls')).toBeGreaterThan(before);
      await page.mouse.move(2, 400);
    },
  },
  {
    name: 'reveal-failed',
    size: SIZES.default,
    crop: 'auto',
    drive: async (page) => {
      await failAutosave(page, FILE_MISSING);
      await openByPointer(page);
      await configure(page, { reveal: 'fail', revealError: FILE_MISSING });
      await sheet(page).getByRole('button', { name: /Reveal|Show in/ }).click();
      await expect.poll(() => seamCount(page, 'revealCalls')).toBeGreaterThan(0);
      await page.mouse.move(2, 400);
    },
  },
  {
    name: 'disk-error-windows',
    size: SIZES.default,
    platform: 'windows',
    drive: async (page) => {
      await failAutosave(page, DISK_ERROR);
      await openByPointer(page);
      await page.mouse.move(2, 400);
    },
  },
  {
    name: 'disk-error',
    size: SIZES.min,
    drive: async (page) => {
      await failAutosave(page, DISK_ERROR);
      await openByPointer(page);
      await page.mouse.move(2, 400);
    },
  },
];

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  if (!OUT) throw new Error('DESIGN_CAPTURE_DIR is not set');
  mkdirSync(OUT, { recursive: true });
});

test.use({ deviceScaleFactor: 2 });

for (const state of STATES) {
  test(`save-failed sheet — ${state.name} @ ${state.size.name}`, async ({ page }) => {
    await boot(page, state.size, state.platform ?? 'macos');
    await state.drive(page);
    await shoot(page, state.name, state.size, state.crop ?? 'sheet');
  });
}
