/**
 * Design capture harness for the toast notices — design review only.
 *
 * Not a test of behaviour: `toasts.test.ts` and the specs that raise toasts on
 * their way somewhere own that. This puts toasts over every screen that has one
 * — the Editor, the Library, a take on the glass, the Settings window, and the
 * narrowest control window — in the combinations that carry design weight, and
 * writes a screenshot of each. It never runs in the normal suite:
 *
 *     DESIGN_CAPTURE_DIR=/abs/out CANDIDCUE_E2E_PORT=5328 \
 *       ./node_modules/.bin/playwright test --config=playwright.config.ts \
 *       tests/e2e/browser/design-toasts.spec.ts
 *
 * Every toast goes in through `showToast`, the one function all hundred-odd
 * call sites use, loaded from the same module URL the app imports so it is the
 * app's own store instance. The messages are real ones, copied from their call
 * sites, because a toast's design is mostly about what happens to long text.
 *
 * Each shot checks that every toast it raised is on screen AFTER the region has
 * settled, and throws rather than write a frame of the wrong state.
 */
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { installTauriShim, type ShimScriptSeed } from './fixtures/tauri-shim';
import { openPreferences } from './fixtures/preferences';
import { row } from './fixtures/library';

const OUT = process.env['DESIGN_CAPTURE_DIR'];

test.skip(!OUT, 'design capture harness: set DESIGN_CAPTURE_DIR to run it');
test.describe.configure({ timeout: 90_000 });
test.use({ deviceScaleFactor: 2 });

const WINDOW = { width: 1240, height: 820 };
const NARROW = { width: 980, height: 680 };
const PROMPTER = { width: 1024, height: 600 };
const SETTINGS_WINDOW = { width: 880, height: 660 };

const KEYNOTE = `# Launch keynote

This is how I am working now. There are five coding agents running on my machine, across a few different projects, and at any moment I know exactly which one of them needs me.

## The problem

Every tool wants you to run more agents. That's fine, but running more agents was never the hard part. The hard part is managing your attention, because that's the thing that actually runs out.

So this week I rebuilt the overview around exactly three questions: is anything asking me for something, is anything stuck, and is anything finished and waiting.

[Cue: cut to the screen recording]

## The overview

Here's what it looks like with twenty agents running. Nothing in this list is decoration. The row at the top is the one that needs me, and it stays at the top until I answer it.

The second row is stuck. It has been waiting on a test run for eleven minutes, and the overview says so in words rather than a spinner.

## What is next

We ship the new onboarding in March, and the pricing page after it. The team that built it will walk you through it next week, and I will be there to answer questions.

Thank you all for coming, and for the questions you sent in ahead of time.
`;

const SEEDS: ShimScriptSeed[] = [
  { id: 'a11a0001-a11a-4a1a-8a1a-a11aa11a0001', title: 'Launch keynote', source: KEYNOTE },
  {
    id: 'a11a0002-a11a-4a1a-8a1a-a11aa11a0002',
    title: 'Quarterly update',
    source:
      '# Opening\n\nThank you for joining me today. Here is what changed this quarter, and why it matters.\n\n' +
      '## What is next\n\nWe ship the new onboarding in March, and the pricing page after it.\n',
  },
  {
    id: 'a11a0003-a11a-4a1a-8a1a-a11aa11a0003',
    title: 'Teleprompter test',
    source:
      'Good morning, and welcome to this short teleprompter test. The goal is to check whether the text scrolls smoothly.\n',
  },
];

const ENGINE_READY = {
  available: true,
  loaded: true,
  model: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05',
};

type Tone = 'info' | 'success' | 'danger';

interface Raise {
  message: string;
  tone: Tone;
  /** An action's label; pressing it does nothing in a capture. */
  action?: string;
  key?: string;
}

/* Real messages, from their call sites. */
const COPIED: Raise = { message: 'Script text copied', tone: 'success' };
const COPY_FAILED: Raise = { message: 'Could not copy to the clipboard', tone: 'danger' };
const HISTORY_FAILED: Raise = {
  message:
    'Could not open revision history. The revision store could not be read because another ' +
    'copy of CandidCue has it open. Quit the other copy and try again.',
  tone: 'danger',
};
const DISK_RECEIPT: Raise = {
  message: 'Loaded the disk version. Your edits are in the Library as “Launch keynote (conflict copy)”.',
  tone: 'success',
  action: 'Open copy',
  key: 'script-conflict',
};
const KEPT_RECEIPT: Raise = {
  message: 'Kept your edits. The disk version is in this script’s revision history.',
  tone: 'success',
  action: 'Open revision history',
  key: 'script-conflict',
};
const EXPORTED: Raise = { message: 'Script exported', tone: 'success' };
const RESTORED: Raise = {
  message: 'Revision restored. Your previous text was saved as a revision.',
  tone: 'success',
};
const TRASHED: Raise = { message: 'Moved to Trash', tone: 'info' };
const IMPORT_SKIPPED: Raise = {
  message: 'CandidCue imports Markdown and plain text. notes.docx and 2 more were not imported.',
  tone: 'info',
};
const IMPORTED: Raise = { message: 'Script imported. It is in your library.', tone: 'success' };
const MIC_REFUSED: Raise = {
  message:
    'CandidCue is not allowed to use the microphone, so this take cannot follow your voice. ' +
    'Allow it in System Settings, then choose Try again in the take controls.',
  tone: 'danger',
  action: 'Open System Settings',
  key: 'mic-refused',
};
const AUTO_SCROLL_ON: Raise = { message: 'Auto-scroll on — 160 wpm', tone: 'info' };
const MIC_SWITCHED: Raise = {
  message: 'Microphone switched. Voice following has resumed.',
  tone: 'success',
};
const FOLLOW_INTERRUPTED: Raise = {
  message: 'Voice following interrupted. The speech recogniser stopped responding.',
  tone: 'danger',
};
const LOG_FOLDER_FAILED: Raise = {
  message: 'The log folder could not be opened. The folder does not exist, or CandidCue is not allowed to open it.',
  tone: 'danger',
};
const RESTORE_READY: Raise = {
  message:
    'Ready to restore 42 scripts from the export taken on 2026-10-01. ' +
    'Quit and reopen CandidCue to apply it — nothing has changed yet.',
  tone: 'success',
};

/** Make the page report macOS before any app code reads `navigator`. */
async function pretendMac(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' });
    Object.defineProperty(Navigator.prototype, 'userAgentData', {
      get: () => ({ platform: 'macOS', brands: [], mobile: false }),
    });
  });
}

async function boot(page: Page, viewport: { width: number; height: number }): Promise<void> {
  await pretendMac(page);
  await page.setViewportSize(viewport);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: SEEDS,
    engineStatus: ENGINE_READY,
    promptMode: 'voice',
  });
}

async function library(page: Page, viewport = WINDOW): Promise<void> {
  await boot(page, viewport);
  await page.goto('/control.html');
  await expect(row(page, 'Launch keynote')).toBeVisible();
}

/** The editor, scrolled to the script's end with the caret on its last line. */
async function editor(page: Page, viewport = WINDOW): Promise<void> {
  await library(page, viewport);
  await row(page, 'Launch keynote').dblclick();
  const source = page.getByRole('textbox', { name: 'Script Markdown' });
  await expect(source).toBeVisible();
  await source.click();
  await page.keyboard.press('Meta+ArrowDown');
}

async function present(page: Page, viewport = PROMPTER): Promise<void> {
  await boot(page, viewport);
  await page.goto('/control.html');
  // A row shows its Present button once it is the selected row.
  await row(page, 'Launch keynote').click();
  await row(page, 'Launch keynote').getByRole('button', { name: 'Present', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Teleprompter' })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.stage-root')).toHaveAttribute('data-phase', /ready|live/, { timeout: 20_000 });
}

/**
 * Raise toasts through the app's own store.
 *
 * Evaluated as a string, so the dynamic import reaches the page untouched by
 * the test-file transform, and resolved from the URL the app imports, so it is
 * the same module instance the region subscribes to.
 */
async function raise(page: Page, list: Raise[]): Promise<void> {
  await page.evaluate(`(async () => {
    window.__toastHarness ??= await import('/src/control/stores/toasts.ts');
  })()`);
  await page.evaluate((items) => {
    const store = (window as unknown as {
      __toastHarness: {
        holdToasts: (hold: boolean) => void;
        showToast: (
          message: string,
          tone: string,
          options?: { key?: string; action?: { label: string; run: () => void } },
        ) => number;
      };
    }).__toastHarness;
    // The store's own lifetimes and limits, with the countdowns held the way
    // a reader's pointer holds them, so nothing expires mid-capture.
    store.holdToasts(true);
    for (const item of items) {
      store.showToast(item.message, item.tone, {
        ...(item.key === undefined ? {} : { key: item.key }),
        ...(item.action === undefined ? {} : { action: { label: item.action, run: () => undefined } }),
      });
    }
  }, list);
}

/** Park the pointer where it hovers nothing. */
async function parkPointer(page: Page): Promise<void> {
  const size = page.viewportSize();
  await page.mouse.move((size?.width ?? 1240) - 4, 4);
}

async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(200);
  await page.evaluate(async () => {
    await document.fonts.ready;
    const finite = document
      .getAnimations()
      .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.race([
      Promise.all(finite.map((a) => a.finished.catch(() => undefined))),
      new Promise((r) => setTimeout(r, 2_000)),
    ]);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}

/** Write a frame, having checked every expected message is on screen. */
async function shoot(
  page: Page,
  name: string,
  expected: Raise[],
  clip?: { x: number; y: number; width: number; height: number },
): Promise<void> {
  if (!OUT) throw new Error('DESIGN_CAPTURE_DIR must be set');
  await settle(page);
  // Open, not merely present: a folded notice stays in its live region.
  for (const item of expected) {
    await expect(page.locator('.toast:not(.folded)').filter({ hasText: item.message }).first()).toBeVisible();
  }
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, clip, caret: 'hide' });
  const size = fs.statSync(file).size;
  if (size < 4_000) throw new Error(`${name}.png is ${size} bytes — not a real capture`);
}

/** A close-up of the toast stack and what sits under it. */
async function regionClip(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator('.region').boundingBox();
  if (!box) throw new Error('the toast region has no box');
  const size = page.viewportSize() ?? WINDOW;
  const pad = 48;
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  return {
    x,
    y,
    width: Math.min(size.width - x, box.width + pad * 2),
    height: Math.min(size.height - y, box.height + pad * 2 + 40),
  };
}

test('e01 editor, a short success', async ({ page }) => {
  await editor(page);
  await raise(page, [COPIED]);
  await parkPointer(page);
  await shoot(page, 'e01-editor-success-short', [COPIED]);
});

test('e02 editor, a long failure', async ({ page }) => {
  await editor(page);
  await raise(page, [HISTORY_FAILED]);
  await parkPointer(page);
  await shoot(page, 'e02-editor-danger-long', [HISTORY_FAILED]);
});

test('e03 editor, a receipt with an action', async ({ page }) => {
  await editor(page);
  await raise(page, [DISK_RECEIPT]);
  await parkPointer(page);
  await shoot(page, 'e03-editor-receipt-action', [DISK_RECEIPT]);
});

test('e04 editor, a receipt with a long action label', async ({ page }) => {
  await editor(page);
  await raise(page, [KEPT_RECEIPT]);
  await parkPointer(page);
  await shoot(page, 'e04-editor-receipt-long-action', [KEPT_RECEIPT]);
});

test('e05 editor, a pile of mixed notices', async ({ page }) => {
  await editor(page);
  const pile = [EXPORTED, HISTORY_FAILED, RESTORED, KEPT_RECEIPT, COPY_FAILED];
  await raise(page, pile);
  await parkPointer(page);
  // Failures first, then the newest notice; the rest folded behind a count.
  await shoot(page, 'e05-editor-pileup', [HISTORY_FAILED, KEPT_RECEIPT, COPY_FAILED]);
});

test('e05b editor, the pile opened out', async ({ page }) => {
  await editor(page);
  const pile = [EXPORTED, HISTORY_FAILED, RESTORED, KEPT_RECEIPT, COPY_FAILED];
  await raise(page, pile);
  const fold = page.getByRole('button', { name: /more notices?$/ });
  await fold.click();
  await expect(page.getByRole('button', { name: 'Show fewer' })).toBeVisible();
  await parkPointer(page);
  await shoot(page, 'e05b-editor-pileup-open', pile);
});

test('e06 editor, the same failure three times', async ({ page }) => {
  await editor(page);
  await raise(page, [COPY_FAILED, COPY_FAILED, COPY_FAILED]);
  await parkPointer(page);
  await shoot(page, 'e06-editor-duplicates', [COPY_FAILED]);
});

test('e07 editor, keyboard focus on a toast action', async ({ page }) => {
  await editor(page);
  await raise(page, [KEPT_RECEIPT]);
  await parkPointer(page);
  const action = page.getByRole('button', { name: KEPT_RECEIPT.action });
  await action.focus();
  // Through the keyboard, so the ring is the one a keyboard user sees.
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(action).toBeFocused();
  await shoot(page, 'e07-editor-action-focus', [KEPT_RECEIPT]);
});

test('e08 editor, close-up of a receipt over a failure', async ({ page }) => {
  await editor(page);
  const pair = [HISTORY_FAILED, DISK_RECEIPT];
  await raise(page, pair);
  await parkPointer(page);
  await settle(page);
  await shoot(page, 'e08-editor-closeup', pair, await regionClip(page));
});

const MORE_FAILURES: Raise[] = [
  { message: 'Could not export that script. The disk is full.', tone: 'danger' },
  { message: 'Could not add that image. The file is not a picture CandidCue can read.', tone: 'danger' },
  { message: 'That script’s folder could not be opened.', tone: 'danger' },
];

test('e09 narrowest window, six failures opened out', async ({ page }) => {
  await editor(page, NARROW);
  const pile = [HISTORY_FAILED, COPY_FAILED, LOG_FOLDER_FAILED, ...MORE_FAILURES];
  await raise(page, pile);
  await page.getByRole('button', { name: '3 more failures' }).click();
  await expect(page.getByRole('button', { name: 'Show fewer' })).toBeVisible();
  await parkPointer(page);
  await shoot(page, 'e09-narrow-failures-open', pile.slice(-2));
});

/* Enough long failures to overflow the tray's height bound at the narrowest window. */
const EXPORT_FAILURES: Raise[] = Array.from({ length: 9 }, (_, n) => ({
  message: `Could not export “Episode ${n + 1}”. The disk is full, so nothing was written. Free some space and export it again.`,
  tone: 'danger' as const,
}));

test('e10 narrowest window, an opened pile taller than the window', async ({ page }) => {
  await editor(page, NARROW);
  await raise(page, EXPORT_FAILURES);
  await page.getByRole('button', { name: '6 more failures' }).click();
  await expect(page.getByRole('button', { name: 'Show fewer' })).toBeVisible();
  await parkPointer(page);
  await settle(page);
  const overflows = await page.locator('.tray').evaluate((el) => el.scrollHeight > el.clientHeight + 1);
  if (!overflows) throw new Error('the opened pile does not overflow the tray, so this frame shows nothing');
  // The count is every open row not wholly above the control, counted here
  // from what is on screen rather than trusted.
  const counted = await page.locator('.tray').evaluate((tray) => {
    const floor = tray.querySelector('.below')!.getBoundingClientRect().top;
    return [...tray.querySelectorAll('.toast:not(.folded)')].filter(
      (row) => row.getBoundingClientRect().bottom > floor + 1,
    ).length;
  });
  await expect(page.getByRole('button', { name: `${counted} more below` })).toBeVisible();
  await shoot(page, 'e10-narrow-pile-overflow', EXPORT_FAILURES.slice(-1));
});

test('e12 a failure and a receipt arriving together while somebody is reading the pile', async ({ page }) => {
  await editor(page, NARROW);
  await raise(page, EXPORT_FAILURES);
  await page.getByRole('button', { name: '6 more failures' }).click();
  await expect(page.getByRole('button', { name: 'Show fewer' })).toBeVisible();
  // Reading the top of the pile, pointer on it.
  await page.locator('.tray .toast').first().hover();
  const late: Raise = {
    message: 'Could not export “Bonus episode”. The disk is full, so nothing was written.',
    tone: 'danger',
  };
  await raise(page, [late, IMPORTED]);
  await expect(page.getByRole('button', { name: 'Show fewer' })).toBeVisible();
  const row = page.locator('.toast:not(.folded)').filter({ hasText: late.message });
  await expect
    .poll(() =>
      row.evaluate((el) => {
        // Wholly inside the tray AND clear of the "more below" control.
        const tray = el.closest('.tray')!;
        const floor = tray.querySelector('.below')?.getBoundingClientRect().top ?? tray.getBoundingClientRect().bottom;
        const box = el.getBoundingClientRect();
        return box.top >= tray.getBoundingClientRect().top - 1 && box.bottom <= floor + 1;
      }),
    )
    .toBe(true);
  await shoot(page, 'e12-batch-arrival-while-reading', [late]);
});

test('e11 a failure arriving while the pile is opened out', async ({ page }) => {
  await editor(page);
  const pile = [EXPORTED, HISTORY_FAILED, RESTORED, KEPT_RECEIPT, COPY_FAILED];
  await raise(page, pile);
  await page.getByRole('button', { name: /more notices?/ }).click();
  await expect(page.getByRole('button', { name: 'Show fewer' })).toBeVisible();
  // Back to writing: focus and pointer both leave the stack.
  await page.getByRole('textbox', { name: 'Script Markdown' }).click();
  await parkPointer(page);
  await raise(page, [LOG_FOLDER_FAILED]);
  // Nobody is on the stack, so it folds back with the arrival open.
  await expect(page.getByRole('button', { name: 'Show fewer' })).toHaveCount(0);
  await shoot(page, 'e11-arrival-while-open', [LOG_FOLDER_FAILED]);
});

test('l01 library, a short notice', async ({ page }) => {
  await library(page);
  await row(page, 'Quarterly update').click();
  await raise(page, [TRASHED]);
  await parkPointer(page);
  await shoot(page, 'l01-library-info', [TRASHED]);
});

test('l02 library, an import that skipped files', async ({ page }) => {
  await library(page);
  const pair = [IMPORT_SKIPPED, IMPORTED];
  await raise(page, pair);
  await parkPointer(page);
  await shoot(page, 'l02-library-import', pair);
});

test('v01 take, the microphone is refused', async ({ page }) => {
  await present(page);
  await raise(page, [MIC_REFUSED]);
  await parkPointer(page);
  await shoot(page, 'v01-take-mic-refused', [MIC_REFUSED]);
});

test('v02 take, a passing notice', async ({ page }) => {
  await present(page);
  await raise(page, [AUTO_SCROLL_ON]);
  await parkPointer(page);
  await shoot(page, 'v02-take-autoscroll', [AUTO_SCROLL_ON]);
});

test('v03 take, a notice over a failure', async ({ page }) => {
  await present(page);
  const pair = [FOLLOW_INTERRUPTED, MIC_SWITCHED];
  await raise(page, pair);
  await parkPointer(page);
  // One open during a take, and a failure outranks the newer receipt.
  await shoot(page, 'v03-take-stack', [FOLLOW_INTERRUPTED]);
});

test('v04 take in a large window, the microphone is refused', async ({ page }) => {
  await present(page, { width: 1440, height: 900 });
  await raise(page, [MIC_REFUSED]);
  await parkPointer(page);
  await shoot(page, 'v04-take-large-mic-refused', [MIC_REFUSED]);
});

test('p01 settings window, a failure', async ({ page }) => {
  await pretendMac(page);
  await page.setViewportSize(SETTINGS_WINDOW);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installTauriShim(page, { welcomed: true, seedScripts: SEEDS, engineStatus: ENGINE_READY });
  await openPreferences(page);
  await raise(page, [LOG_FOLDER_FAILED]);
  await parkPointer(page);
  await shoot(page, 'p01-settings-danger', [LOG_FOLDER_FAILED]);
});

test('p02 settings window, a long success', async ({ page }) => {
  await pretendMac(page);
  await page.setViewportSize(SETTINGS_WINDOW);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installTauriShim(page, { welcomed: true, seedScripts: SEEDS, engineStatus: ENGINE_READY });
  await openPreferences(page);
  await raise(page, [RESTORE_READY]);
  await parkPointer(page);
  await shoot(page, 'p02-settings-success-long', [RESTORE_READY]);
});

test('n01 narrowest window, a receipt over a failure', async ({ page }) => {
  await editor(page, NARROW);
  const pair = [HISTORY_FAILED, KEPT_RECEIPT];
  await raise(page, pair);
  await parkPointer(page);
  await shoot(page, 'n01-narrow-editor-stack', pair);
});
