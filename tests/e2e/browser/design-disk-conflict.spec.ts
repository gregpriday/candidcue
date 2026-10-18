/**
 * Design capture harness for the external-change conflict sheet ("This script
 * changed on disk"). Opt-in: it writes screenshots for a design review and
 * asserts nothing about behaviour, so it never runs in the normal suite.
 *
 *   DESIGN_CAPTURE=1 DESIGN_CAPTURE_DIR=/abs/out CANDIDCUE_E2E_PORT=5319 \
 *     ./node_modules/.bin/playwright test tests/e2e/browser/design-disk-conflict.spec.ts
 *
 * The conflict is driven the way production reaches it: the editor opens the
 * script, `save_script` starts rejecting with SCRIPT_CONFLICT, and the author
 * types. The file's NEW contents are answered through a seam over `get_script`
 * that is armed only once the editor is open, so the open itself reads the
 * original and every later read sees what the other app wrote. Held and failed
 * arms go through the common shim's `setHeld` / `setFail`.
 */
import { test, expect, type Page } from '@playwright/test';
import { join } from 'node:path';
import { installTauriShim, SCRIPT_CONFLICT_ERROR } from './fixtures/tauri-shim';
import { collection, openScript } from './fixtures/library';

const CAPTURE = process.env['DESIGN_CAPTURE'] === '1';
const OUT = process.env['DESIGN_CAPTURE_DIR'];

test.skip(!CAPTURE, 'design capture harness — set DESIGN_CAPTURE=1');
test.use({ deviceScaleFactor: 2 });

/** Thursday afternoon, local time. */
const NOW = new Date(2026, 9, 15, 16, 20, 0);

const SIZES = [
  { name: 'default', width: 1240, height: 820 },
  { name: 'min', width: 980, height: 680 },
] as const;

/* ------------------------------------------------------------------------ */
/* Fixture                                                                   */
/* ------------------------------------------------------------------------ */

const BASE = [
  '# Launch keynote',
  '## Opening',
  'Good morning, everyone, and thank you for being here.',
  'Most teleprompters make you choose between reading and performing. This one listens instead, so the words follow you.',
  '## Why it listens',
  'The hard problem was never transcription.',
  'It was deciding, from a few half-heard words, where in the script you actually are, without ever jumping somewhere you did not go.',
  '## Setting up',
  'Setting up takes about a minute. Pick the display your glass sits on, choose a reading distance, and press Present.',
  'Thanks for watching.',
].join('\n\n') + '\n';

/** What the other app wrote: a different sentence changed, and a line added. */
const DISK = BASE.replace(
  'Setting up takes about a minute.',
  'Setting up takes about two minutes, most of it choosing a display.',
).replace('Thanks for watching.', 'Questions are welcome at the end.\n\nThanks for watching.');

/** A heavier rewrite: five places, one paragraph gone, a long one reworded. */
const MANY = DISK.replace('Good morning, everyone, and thank you for being here.', 'Good afternoon, and thank you all for coming.')
  .replace('This one listens instead, so the words follow you.', 'This one listens instead, and the words simply follow along as you speak.')
  .replace(
    'It was deciding, from a few half-heard words, where in the script you actually are, without ever jumping somewhere you did not go.',
    'It was deciding, from a few half-heard words and a lot of silence, where in the script you actually are — and never jumping somewhere you did not go, however tempting the match.',
  )
  .replace('## Why it listens', '## Why it listens first');

/** Typed into the editor after the file changed, so it exists nowhere else. */
const TYPED = ' It was finding your place again after a pause.';
const TYPED_AFTER = 'The hard problem was never transcription.';

const SCRIPT = {
  id: '5c0ff1c7-5c0f-4f1c-8c0f-5c0ff1c75c0f',
  title: 'Launch keynote',
  source: BASE,
  scriptRevision: 12,
};

const LONG_SCRIPT = {
  id: '6c0ff1c7-6c0f-4f1c-8c0f-6c0ff1c76c0f',
  title: 'Quarterly all-hands: product roadmap, hiring plan and the Q4 launch keynote',
  source: BASE.replace('# Launch keynote', '# Quarterly all-hands'),
  scriptRevision: 4,
};

/* ------------------------------------------------------------------------ */
/* The disk seam                                                            */
/* ------------------------------------------------------------------------ */

type Mode = 'answer' | 'hold' | 'fail';

interface DiskSeam {
  /** Null until armed: the open reads the original file. */
  source: string | null;
  title: string | null;
  mode: Mode;
  error: unknown;
}

async function installDiskSeam(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seam: DiskSeam = { source: null, title: null, mode: 'answer', error: null };
    (window as unknown as { __DISK__: DiskSeam }).__DISK__ = seam;
    const internals = (window as unknown as {
      __TAURI_INTERNALS__: { invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown> };
    }).__TAURI_INTERNALS__;
    const forward = internals.invoke.bind(internals);
    internals.invoke = async (command, args) => {
      if (command !== 'get_script' || seam.source === null) return forward(command, args);
      if (seam.mode === 'hold') return new Promise<never>(() => {});
      if (seam.mode === 'fail') throw seam.error;
      const doc = (await forward(command, args)) as Record<string, unknown>;
      const source = seam.source;
      const words = source
        .replace(/^#+\s.*$/gm, '')
        .split(/\s+/)
        .filter(Boolean).length;
      return {
        ...doc,
        source,
        title: seam.title ?? doc['title'],
        spokenWordCount: words,
        scriptRevision: (doc['scriptRevision'] as number) + 1,
      };
    };
  });
}

async function configureDisk(page: Page, patch: Partial<DiskSeam>): Promise<void> {
  await page.evaluate((p) => {
    Object.assign((window as unknown as { __DISK__: DiskSeam }).__DISK__, p);
  }, patch);
}

const sheet = (page: Page) => page.getByRole('dialog', { name: 'This script changed on disk' });

interface Conflict {
  script?: typeof SCRIPT;
  /** What the file now holds. `null` = the same text the editor ends up with. */
  disk?: string | null;
}

/**
 * Boot, open the script, and put the editor into conflict: the file changes,
 * the author types, the autosave is refused.
 */
async function boot(page: Page, size: (typeof SIZES)[number], conflict: Conflict = {}): Promise<void> {
  const script = conflict.script ?? SCRIPT;
  await page.setViewportSize({ width: size.width, height: size.height });
  await page.clock.setFixedTime(NOW);
  await installTauriShim(page, {
    welcomed: true,
    // One script per boot: the long title contains the short one, so a row
    // located by title would match both.
    seedScripts: [script],
    engineStatus: {
      available: true,
      loaded: true,
      model: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05',
    },
    promptMode: 'voice',
  });
  await installDiskSeam(page);
  await page.goto('/control.html');
  await expect(collection(page)).toBeVisible();
  await openScript(page, script.title);
  const surface = page.getByRole('textbox', { name: 'Script Markdown' });
  await expect(surface).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText(TYPED_AFTER);

  const typedSource = script.source.replace(TYPED_AFTER, TYPED_AFTER + TYPED);
  const disk = conflict.disk === undefined ? DISK : conflict.disk ?? typedSource;
  await configureDisk(page, { source: disk.replace('# Launch keynote', script.source.split('\n')[0]!) });
  await page.evaluate((err) => window.__E2E__.setFail('save_script', err), SCRIPT_CONFLICT_ERROR);

  await page.locator('.cm-line', { hasText: TYPED_AFTER }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(TYPED);
  await expect(page.getByRole('button', { name: /Changed outside CandidCue/ })).toBeVisible();
}

async function openSheet(page: Page, via: 'pointer' | 'keyboard' = 'pointer'): Promise<void> {
  const trigger = page.getByRole('button', { name: /Changed outside CandidCue/ });
  if (via === 'keyboard') {
    await trigger.focus();
    await page.keyboard.press('Enter');
  } else {
    await trigger.click();
  }
  await expect(sheet(page)).toBeVisible();
}

async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(350);
}

async function shootFrame(page: Page, name: string): Promise<void> {
  await settle(page);
  await page.screenshot({ path: join(OUT!, `conflict--${name}.png`) });
}

async function shootSheet(page: Page, name: string): Promise<void> {
  await settle(page);
  const panel = sheet(page);
  await expect(panel).toBeVisible();
  // A margin of scrim around the panel, so its edge and shadow are in frame.
  const box = await panel.boundingBox();
  if (!box) throw new Error(`no panel box for ${name}`);
  const viewport = page.viewportSize()!;
  const pad = 24;
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  await page.screenshot({
    path: join(OUT!, `conflict--${name}.png`),
    clip: {
      x,
      y,
      width: Math.min(viewport.width - x, box.width + pad * 2),
      height: Math.min(viewport.height - y, box.height + pad * 2),
    },
  });
}

/* ------------------------------------------------------------------------ */
/* States                                                                    */
/* ------------------------------------------------------------------------ */

test.describe.configure({ mode: 'serial' });

for (const size of SIZES) {
  test(`frame: open — ${size.name}`, async ({ page }) => {
    await boot(page, size);
    await openSheet(page);
    await page.mouse.move(2, 2);
    await shootFrame(page, `open-frame--${size.name}`);
  });
}

test('trigger in the toolbar', async ({ page }) => {
  await boot(page, SIZES[0]);
  await page.mouse.move(2, 2);
  await settle(page);
  await page.screenshot({
    path: join(OUT!, 'conflict--trigger.png'),
    clip: { x: 0, y: 0, width: SIZES[0].width, height: 160 },
  });
});

test('sheet: open', async ({ page }) => {
  await boot(page, SIZES[0]);
  await openSheet(page);
  await page.mouse.move(2, 2);
  await shootSheet(page, 'open');
});

test('sheet: opened from the keyboard (initial focus)', async ({ page }) => {
  await boot(page, SIZES[0]);
  await openSheet(page, 'keyboard');
  await shootSheet(page, 'keyboard-open');
});

test('sheet: keyboard, one Tab in', async ({ page }) => {
  await boot(page, SIZES[0]);
  await openSheet(page, 'keyboard');
  await page.keyboard.press('Tab');
  await shootSheet(page, 'keyboard-tab');
});

test('sheet: the disk already matches the edits', async ({ page }) => {
  await boot(page, SIZES[0], { disk: null });
  await openSheet(page);
  await page.mouse.move(2, 2);
  await shootSheet(page, 'identical');
});

test('sheet: long title', async ({ page }) => {
  await boot(page, SIZES[0], { script: LONG_SCRIPT });
  await openSheet(page);
  await page.mouse.move(2, 2);
  await shootSheet(page, 'long-title');
});

test('sheet: disk version still loading', async ({ page }) => {
  await boot(page, SIZES[0]);
  await configureDisk(page, { mode: 'hold' });
  await openSheet(page);
  await page.mouse.move(2, 2);
  await shootSheet(page, 'disk-loading');
});

test('sheet: disk version unreadable', async ({ page }) => {
  await boot(page, SIZES[0]);
  await configureDisk(page, {
    mode: 'fail',
    error: { code: 'SCRIPT_FILE_MISSING', userMessage: 'The script file could not be read.' },
  });
  await openSheet(page);
  await page.mouse.move(2, 2);
  await shootSheet(page, 'disk-unreadable');
});

test('sheet: using the disk version, in flight', async ({ page }) => {
  await boot(page, SIZES[0]);
  await openSheet(page);
  await page.evaluate(() => window.__E2E__.setHeld('create_script', true));
  await sheet(page).getByRole('button', { name: /Use disk version|Use the disk version/ }).click();
  await page.mouse.move(2, 2);
  await shootSheet(page, 'resolving-disk');
});

test('sheet: keeping the edits, in flight', async ({ page }) => {
  await boot(page, SIZES[0]);
  await openSheet(page);
  await page.evaluate(() => {
    window.__E2E__.setFail('save_script', null);
    window.__E2E__.setHeld('save_script', true);
  });
  await sheet(page).getByRole('button', { name: 'Keep my edits' }).click();
  await page.mouse.move(2, 2);
  await shootSheet(page, 'resolving-keep');
});

test('sheet: many places differ', async ({ page }) => {
  await boot(page, SIZES[0], { disk: MANY });
  await openSheet(page);
  await page.mouse.move(2, 2);
  await shootSheet(page, 'many-changes');
});

test('sheet: a line break and spacing are all that differ', async ({ page }) => {
  // The editor's own text, with one paragraph broken across two lines and a
  // doubled space in another: the same words either way.
  const typed = BASE.replace(TYPED_AFTER, TYPED_AFTER + TYPED);
  await boot(page, SIZES[0], {
    disk: typed
      .replace('Pick the display your glass sits on,', 'Pick the display\nyour glass sits on,')
      .replace('thank you for being here', 'thank you  for being here'),
  });
  await openSheet(page);
  await page.mouse.move(2, 2);
  await shootSheet(page, 'spacing');
});

test('after: the receipt opens revision history', async ({ page }) => {
  await boot(page, SIZES[0]);
  await openSheet(page);
  await page.evaluate(() => window.__E2E__.setFail('save_script', null));
  await sheet(page).getByRole('button', { name: 'Keep my edits' }).click();
  await expect(sheet(page)).toBeHidden();
  await page.getByRole('button', { name: 'Open revision history' }).click();
  await expect(page.getByRole('dialog', { name: 'Revision history' })).toBeVisible();
  await page.mouse.move(2, 2);
  await shootFrame(page, 'history-from-receipt');
});

test('sheet: many places, shown in full', async ({ page }) => {
  await boot(page, SIZES[0], { disk: MANY });
  await openSheet(page);
  await sheet(page).getByRole('button', { name: 'Show all in full' }).click();
  await page.mouse.move(2, 2);
  await shootSheet(page, 'many-expanded');
});

test('sheet: unreadable, text copied out', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await boot(page, SIZES[0]);
  await configureDisk(page, {
    mode: 'fail',
    error: { code: 'SCRIPT_FILE_MISSING', userMessage: 'The script file could not be read.' },
  });
  await openSheet(page);
  await sheet(page).getByRole('button', { name: 'Copy all text' }).click();
  await page.mouse.move(2, 2);
  await shootSheet(page, 'unreadable-copied');
});

test('sheet: the file changed again before the choice', async ({ page }) => {
  await boot(page, SIZES[0]);
  await openSheet(page);
  const keep = sheet(page).getByRole('button', { name: 'Keep my edits' });
  await expect(keep).toBeEnabled();
  await configureDisk(page, { source: DISK.replace('Thanks for watching.', 'Thanks, and see you next week.') });
  await page.evaluate(() => window.__E2E__.setFail('save_script', null));
  await keep.click();
  await page.mouse.move(2, 2);
  await shootSheet(page, 'changed-again');
});

test('sheet: the arm failed', async ({ page }) => {
  await boot(page, SIZES[0]);
  await openSheet(page);
  await page.evaluate(() =>
    window.__E2E__.setFail('create_script', {
      code: 'INTERNAL_UNEXPECTED',
      userMessage: 'The Library could not be written to.',
    }),
  );
  await sheet(page).getByRole('button', { name: /Use disk version|Use the disk version/ }).click();
  await page.mouse.move(2, 2);
  await settle(page);
  await shootFrame(page, 'failed-frame');
  await shootSheet(page, 'failed');
});

test('after: used the disk version', async ({ page }) => {
  await boot(page, SIZES[0]);
  await openSheet(page);
  await sheet(page).getByRole('button', { name: /Use disk version|Use the disk version/ }).click();
  await expect(sheet(page)).toBeHidden();
  await page.mouse.move(2, 2);
  await shootFrame(page, 'done-disk');
});

test('after: kept the edits', async ({ page }) => {
  await boot(page, SIZES[0]);
  await openSheet(page);
  await page.evaluate(() => window.__E2E__.setFail('save_script', null));
  await sheet(page).getByRole('button', { name: 'Keep my edits' }).click();
  await expect(sheet(page)).toBeHidden();
  await page.mouse.move(2, 2);
  await shootFrame(page, 'done-keep');
});

test('sheet: min window', async ({ page }) => {
  await boot(page, SIZES[1]);
  await openSheet(page);
  await page.mouse.move(2, 2);
  await shootSheet(page, 'open--min');
});
