/**
 * Screenshots of the script actions menus, for design review: the editor's
 * "Script actions" menu and the Library's per-row "Actions for …" menu, opened
 * by pointer and by keyboard, with the destructive item highlighted, the
 * confirmation it leads to, the same row's right-click menu beside it, and the
 * Windows spellings. Opt-in: it skips unless DESIGN_CAPTURE_DIR names a
 * directory to write into, so the normal suite never runs it.
 *
 *     DESIGN_CAPTURE_DIR=/tmp/shots CANDIDCUE_E2E_PORT=5300 \
 *       ./node_modules/.bin/playwright test --config=playwright.config.ts \
 *       tests/e2e/browser/design-capture-script-actions.spec.ts
 *
 * Everything goes in through the Tauri shim, so every menu is drawn by the real
 * stores and the real routes. Each shot checks that the state it names is
 * actually on screen before it writes, and throws rather than write a picture
 * of something else.
 */
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { installTauriShim, type ShimScriptSeed } from './fixtures/tauri-shim';
import { collection, row } from './fixtures/library';

const OUT = process.env['DESIGN_CAPTURE_DIR'];

test.skip(!OUT, 'design capture harness: set DESIGN_CAPTURE_DIR to run it');
test.describe.configure({ timeout: 60_000 });
test.use({ deviceScaleFactor: 2 });

const WINDOW = { width: 1240, height: 820 };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const id = (n: number) =>
  `5ac70000-5ac7-4a1a-8a1a-5ac7000000${String(n).padStart(2, '0')}`;

const INTRO = `# Cold open

Every tool wants you to run more AI agents. That's fine, but running more agents was never the hard part. The hard part is managing your attention, because that's the thing that actually runs out.

So this week I rebuilt the overview around exactly three questions: is anything asking me for something, is anything stuck, and is anything finished and waiting.

[Cue: cut to the screen recording]

# The overview

Here's what it looks like with twenty agents running. **Nothing** in this list is decoration.
`;

const LIBRARY: ShimScriptSeed[] = [
  { id: id(1), title: 'Daintree intro', source: INTRO, updatedAt: ago(2 * HOUR), lastOpenedAt: ago(2 * HOUR) },
  {
    id: id(2),
    title: 'Q4 investor update',
    source: '# Opening\n\nThank you for joining me today. Here is what changed this quarter.\n',
    updatedAt: ago(3 * DAY),
  },
  {
    id: id(3),
    title: 'Teleprompter test',
    source: 'Good morning, and welcome to this short teleprompter test.\n',
    updatedAt: ago(9 * DAY),
  },
  {
    id: id(4),
    title: 'Old webinar opener',
    source: 'Welcome, everyone. We will get started in about a minute.\n',
    status: 'trash',
    updatedAt: ago(4 * DAY),
  },
];
const LIVE = LIBRARY.filter((s) => s.status !== 'trash');

/** Make the page report macOS before any app code reads `navigator`. */
async function pretendMac(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' });
    Object.defineProperty(Navigator.prototype, 'userAgentData', {
      get: () => ({ platform: 'macOS', brands: [], mobile: false }),
    });
  });
}

async function boot(page: Page, opts: { windows?: boolean } = {}): Promise<void> {
  // The Desktop Chrome device reports Windows, which is the other platform's
  // spelling; everything else is drawn as the Mac it is used on.
  if (!opts.windows) await pretendMac(page);
  await page.setViewportSize(WINDOW);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installTauriShim(page, { welcomed: true, seedScripts: LIBRARY });
  await page.goto('/control.html');
  await expect(collection(page).getByRole('option')).toHaveCount(LIVE.length);
}

async function openEditor(page: Page, opts: { windows?: boolean } = {}): Promise<void> {
  await boot(page, opts);
  await row(page, 'Daintree intro').dblclick();
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeVisible();
}

/** Park the pointer where it hovers nothing. */
async function parkPointer(page: Page): Promise<void> {
  await page.mouse.move(WINDOW.width - 4, WINDOW.height - 4);
}

function openMenu(page: Page): Locator {
  return page.locator('[role="menu"]');
}

/** The item drawn as chosen, or none. */
function highlighted(page: Page): Locator {
  return openMenu(page).locator('.item.active');
}

/** Wait out every finite animation and two frames, so a capture is at rest. */
async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(150);
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

/**
 * Write one capture: the whole window, or a clip around the given elements
 * with room to see what they sit beside.
 */
async function shoot(page: Page, name: string, around: Locator[] = []): Promise<void> {
  if (!OUT) throw new Error('DESIGN_CAPTURE_DIR must be set');
  fs.mkdirSync(OUT, { recursive: true });
  await settle(page);
  let clip: { x: number; y: number; width: number; height: number } | undefined;
  if (around.length > 0) {
    const boxes = await Promise.all(around.map((l) => l.boundingBox()));
    if (boxes.some((b) => b === null)) throw new Error(`${name}: a framed element has no box`);
    const left = Math.min(...boxes.map((b) => b!.x)) - 140;
    const top = Math.min(...boxes.map((b) => b!.y)) - 40;
    const right = Math.max(...boxes.map((b) => b!.x + b!.width)) + 40;
    const bottom = Math.max(...boxes.map((b) => b!.y + b!.height)) + 40;
    const x = Math.max(0, left);
    const y = Math.max(0, top);
    clip = {
      x,
      y,
      width: Math.min(WINDOW.width, right) - x,
      height: Math.min(WINDOW.height, bottom) - y,
    };
  }
  const file = path.join(OUT, `actions--${name}.png`);
  await page.screenshot({ path: file, clip });
  const size = fs.statSync(file).size;
  if (size < 4_000) throw new Error(`${name}.png is ${size} bytes — not a real capture`);
}

const scriptActions = (page: Page) => page.getByRole('button', { name: 'Script actions' });
const editorToolbar = (page: Page) => page.locator('.toolbar').first();

test('01 editor, menu in context', async ({ page }) => {
  await openEditor(page);
  await scriptActions(page).click();
  await expect(openMenu(page)).toBeVisible();
  await parkPointer(page);
  await expect(highlighted(page)).toHaveCount(0);
  await shoot(page, '01-editor-context');
});

test('02 editor, opened with the pointer', async ({ page }) => {
  await openEditor(page);
  await scriptActions(page).click();
  await expect(openMenu(page)).toBeVisible();
  await parkPointer(page);
  await expect(highlighted(page)).toHaveCount(0);
  await shoot(page, '02-editor-pointer', [scriptActions(page), openMenu(page)]);
});

test('03 editor, pointer over an item', async ({ page }) => {
  await openEditor(page);
  await scriptActions(page).click();
  const items = openMenu(page).locator('.item');
  await expect(items.first()).toBeVisible();
  await items.nth(2).hover();
  await expect(highlighted(page)).toHaveCount(1);
  await shoot(page, '03-editor-hover', [scriptActions(page), openMenu(page)]);
});

test('04 editor, opened from the keyboard', async ({ page }) => {
  await openEditor(page);
  await parkPointer(page);
  await scriptActions(page).focus();
  await page.keyboard.press('Enter');
  await expect(openMenu(page)).toBeVisible();
  await expect(highlighted(page)).toHaveCount(1);
  await shoot(page, '04-editor-keyboard', [scriptActions(page), openMenu(page)]);
});

test('05 editor, the destructive item highlighted', async ({ page }) => {
  await openEditor(page);
  await parkPointer(page);
  await scriptActions(page).focus();
  await page.keyboard.press('Enter');
  await expect(openMenu(page)).toBeVisible();
  await page.keyboard.press('End');
  await expect(highlighted(page)).toHaveText(/Trash/);
  await shoot(page, '05-editor-danger', [scriptActions(page), openMenu(page)]);
});

test('06 editor, a letter typed into the open menu', async ({ page }) => {
  await openEditor(page);
  await parkPointer(page);
  await scriptActions(page).focus();
  await page.keyboard.press('Enter');
  await expect(openMenu(page)).toBeVisible();
  // First-letter navigation: "E" is Export, which is not the first item.
  await page.keyboard.press('e');
  await expect(highlighted(page)).toHaveText(/Export/);
  await shoot(page, '06-editor-typeahead', [scriptActions(page), openMenu(page)]);
});

test('07 editor, the Move to Trash confirmation', async ({ page }) => {
  await openEditor(page);
  await scriptActions(page).click();
  await openMenu(page).getByRole('menuitem', { name: /Trash/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await parkPointer(page);
  await shoot(page, '07-editor-trash-confirm');
});

test('08 editor, the Windows spellings', async ({ page }) => {
  await openEditor(page, { windows: true });
  await parkPointer(page);
  await scriptActions(page).focus();
  await page.keyboard.press('Enter');
  await expect(openMenu(page)).toBeVisible();
  await expect(editorToolbar(page)).toBeVisible();
  await shoot(page, '08-editor-windows', [scriptActions(page), openMenu(page)]);
});

test('09 library, a row menu opened with the pointer', async ({ page }) => {
  await boot(page);
  const trigger = page.getByRole('button', { name: 'Actions for Q4 investor update' });
  await row(page, 'Q4 investor update').hover();
  await trigger.click();
  await expect(openMenu(page)).toBeVisible();
  await parkPointer(page);
  await shoot(page, '09-library-row-menu', [row(page, 'Q4 investor update'), openMenu(page)]);
});

test('10 library, a row menu from the keyboard, on the destructive item', async ({ page }) => {
  await boot(page);
  await parkPointer(page);
  await row(page, 'Q4 investor update').click();
  await parkPointer(page);
  const trigger = page.getByRole('button', { name: 'Actions for Q4 investor update' });
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(openMenu(page)).toBeVisible();
  await page.keyboard.press('End');
  await expect(highlighted(page)).toHaveText(/Trash/);
  await shoot(page, '10-library-row-danger', [row(page, 'Q4 investor update'), openMenu(page)]);
});

test('11 library, the same row right-clicked', async ({ page }) => {
  await boot(page);
  const target = row(page, 'Q4 investor update');
  const box = await target.boundingBox();
  if (!box) throw new Error('the row has no box');
  await page.mouse.click(box.x + 260, box.y + box.height / 2, { button: 'right' });
  await expect(openMenu(page)).toBeVisible();
  // The same items as the row's ⋯ menu, drawn by the right-click component.
  await openMenu(page).getByRole('menuitem').nth(1).hover();
  await expect(highlighted(page)).toHaveCount(1);
  await shoot(page, '11-library-context-menu', [target, openMenu(page)]);
});

test('12 library, a row menu in Trash', async ({ page }) => {
  await boot(page);
  await page.getByRole('navigation', { name: 'Library' }).getByText('Trash', { exact: true }).click();
  await expect(collection(page).getByRole('option')).toHaveCount(1);
  const target = row(page, 'Old webinar opener');
  await target.hover();
  await page.getByRole('button', { name: 'Actions for Old webinar opener' }).click();
  await expect(openMenu(page)).toBeVisible();
  await parkPointer(page);
  await shoot(page, '12-library-trash-menu', [target, openMenu(page)]);
});

test('13 library, view options', async ({ page }) => {
  await boot(page);
  const trigger = page.getByRole('button', { name: 'View options' });
  await trigger.click();
  await expect(openMenu(page)).toBeVisible();
  await parkPointer(page);
  await shoot(page, '13-library-view-options', [trigger, openMenu(page)]);
});

test('14 library, the keyboard straight after a right-click', async ({ page }) => {
  await boot(page);
  const target = row(page, 'Q4 investor update');
  const box = await target.boundingBox();
  if (!box) throw new Error('the row has no box');
  await page.mouse.click(box.x + 260, box.y + box.height / 2, { button: 'right' });
  await expect(openMenu(page)).toBeVisible();
  // The menu owns the keyboard the moment it is open: the arrows walk it,
  // not the list of scripts behind it.
  await expect(openMenu(page)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(highlighted(page)).toHaveText(/Present/);
  await expect(row(page, 'Q4 investor update')).toHaveAttribute('aria-selected', 'true');
  await shoot(page, '14-library-context-keyboard', [target, openMenu(page)]);
});

test('15 editor, an arrow pressed after a pointer open', async ({ page }) => {
  await openEditor(page);
  await scriptActions(page).click();
  await expect(openMenu(page)).toBeVisible();
  await parkPointer(page);
  await expect(highlighted(page)).toHaveCount(0);
  // Nothing was drawn as chosen, so the first Down chooses the top item.
  await page.keyboard.press('ArrowDown');
  await expect(highlighted(page)).toHaveText(/Duplicate/);
  await shoot(page, '15-editor-pointer-then-arrow', [scriptActions(page), openMenu(page)]);
});
