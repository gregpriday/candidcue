/**
 * Screenshots of the Library (All scripts, Recent, Trash) in every state that
 * carries design weight, for design review. Opt-in: it skips unless
 * DESIGN_CAPTURE_DIR names a directory to write into, so the normal suite never
 * runs it.
 *
 *     DESIGN_CAPTURE_DIR=/tmp/shots CANDIDCUE_E2E_PORT=5300 \
 *       ./node_modules/.bin/playwright test --config=playwright.config.ts \
 *       tests/e2e/browser/design-capture-library.spec.ts
 *
 * The scripts go in through the Tauri shim, which answers `list_scripts` the
 * way Rust does, so every row is drawn by the real store and the real route.
 * Each shot checks that the state it names is actually on screen before it
 * writes, and throws rather than write a picture of something else.
 */
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { installTauriShim, type ShimScriptSeed } from './fixtures/tauri-shim';
import { collection, row, viewOptions } from './fixtures/library';

const OUT = process.env['DESIGN_CAPTURE_DIR'];

test.skip(!OUT, 'design capture harness — set DESIGN_CAPTURE_DIR');
/*
 * A Mac, at Retina density, because that is the rig the Library is used on.
 * The Desktop Chrome device the config defaults to reports Windows, and the
 * app reads the platform from the user agent: menus said Ctrl+Enter and
 * Show in File Explorer.
 */
test.use({
  deviceScaleFactor: 2,
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const SENTENCES = [
  'Every tool wants you to run more agents, and running more of them was never the hard part.',
  'The hard part is keeping track of which one needs you, which one is stuck, and which one finished an hour ago.',
  'So this week I rebuilt the overview around exactly those three questions.',
  'If you are reading this off the glass right now, keep going at whatever pace feels natural.',
  'Notice that the line you are on stays put, and the next one is already waiting.',
];

/** About `words` words of plausible narration, so durations come out real. */
function prose(words: number, lead = ''): string {
  const out: string[] = lead ? lead.split(/\s+/) : [];
  let i = 0;
  while (out.length < words) {
    out.push(...(SENTENCES[i % SENTENCES.length] ?? '').split(/\s+/));
    i += 1;
  }
  return out.slice(0, words).join(' ');
}

const id = (n: number) => `5c0e${String(n).padStart(4, '0')}-5c0e-4c0e-8c0e-5c0e5c0e${String(n).padStart(4, '0')}`;

/** A library somebody has actually been using: mixed ages, lengths and states. */
const LIBRARY: ShimScriptSeed[] = [
  {
    id: id(1),
    title: 'Sample: read this aloud',
    source: `# Sample\n\n${prose(260, "Hi. If you're reading this sentence off the screen right now, that's exactly the idea.")}\n`,
    updatedAt: ago(9 * HOUR),
    lastOpenedAt: ago(9 * HOUR),
  },
  {
    id: id(2),
    title: 'Daintree intro',
    source: `# Intro\n\n${prose(270)}\n`,
    updatedAt: ago(26 * HOUR),
    lastOpenedAt: ago(26 * HOUR),
  },
  {
    id: id(3),
    title: 'Q4 investor update: what changed this quarter, what we learned from the beta, and the hiring plan',
    source: `# Q4\n\n${prose(1150, 'Thank you for joining me today. Here is what changed this quarter, and why it matters for the next one.')}\n`,
    updatedAt: ago(4 * DAY),
    hasWarnings: true,
  },
  { id: id(4), title: 'Untitled script', source: '', updatedAt: ago(6 * DAY) },
  {
    id: id(5),
    title: 'YouTube: how I run twenty agents without losing my place',
    source: `# Cold open\n\n${prose(640, 'Twenty agents, one screen, and not one of them waiting on me without my knowing.')}\n`,
    updatedAt: ago(12 * DAY),
    lastOpenedAt: ago(3 * DAY),
  },
  {
    id: id(6),
    title: 'Podcast cold open',
    source: `${prose(24, 'Welcome back. Today is a short one, and I promise it is worth it.')}\n`,
    updatedAt: ago(19 * DAY),
  },
  {
    id: id(7),
    title: 'Webinar, part 2 of 3: onboarding',
    source: `# Part two\n\n${prose(2100, 'Last time we set up the workspace. Today we bring the team in.')}\n`,
    updatedAt: ago(45 * DAY),
  },
  { id: id(8), title: 'Recovered script 2cd9dbee', source: '', updatedAt: ago(65 * DAY) },
  {
    id: id(9),
    title: 'Customer story: Northwind',
    source: `${prose(380, 'Northwind had forty people recording product videos and no shared script library.')}\n`,
    updatedAt: ago(120 * DAY),
    hasWarnings: true,
  },
  {
    id: id(10),
    title: 'Teleprompter test',
    source: `${prose(150, 'Good morning, and welcome to this short teleprompter test.')}\n`,
    updatedAt: ago(400 * DAY),
  },
];

const TRASH: ShimScriptSeed[] = [
  {
    id: id(90),
    title: 'Old pricing announcement',
    source: `${prose(200, 'We are changing how pricing works, and here is why.')}\n`,
    status: 'trash',
    updatedAt: ago(3 * DAY),
  },
  { id: id(91), title: 'Untitled script', source: '', status: 'trash', updatedAt: ago(8 * DAY) },
];

const DENSE: ShimScriptSeed[] = Array.from({ length: 48 }, (_, i) => ({
  id: id(200 + i),
  title: `Episode ${48 - i}: ${['Shipping the editor', 'What the beta taught us', 'Hiring our first designer', 'A week of on-device speech', 'Why we went open source', 'The release checklist'][i % 6]}`,
  source: i % 7 === 3 ? '' : `${prose(120 + ((i * 97) % 900))}\n`,
  updatedAt: ago(i * 2.5 * DAY + 3 * HOUR),
  hasWarnings: i % 11 === 4,
}));

interface Boot {
  seeds?: ShimScriptSeed[];
  viewport?: { width: number; height: number };
  workspace?: Record<string, unknown>;
}

async function boot(page: Page, opts: Boot = {}): Promise<void> {
  await page.setViewportSize(opts.viewport ?? { width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  if (opts.workspace) {
    await page.addInitScript((value) => {
      localStorage.setItem('candidcue.workspace.v1', JSON.stringify(value));
    }, opts.workspace);
  }
  await installTauriShim(page, { welcomed: true, seedScripts: opts.seeds ?? [...LIBRARY, ...TRASH] });
  await page.goto('/control.html');
}

async function waitForRows(page: Page, count: number): Promise<void> {
  await expect(collection(page).getByRole('option')).toHaveCount(count);
}

/** Park the pointer where it hovers nothing in the list. */
async function parkPointer(page: Page): Promise<void> {
  const size = page.viewportSize();
  await page.mouse.move((size?.width ?? 1440) - 4, (size?.height ?? 900) - 4);
}

async function shoot(page: Page, name: string): Promise<void> {
  if (!OUT) throw new Error('DESIGN_CAPTURE_DIR must be set');
  fs.mkdirSync(OUT, { recursive: true });
  /*
   * Let the last state change settle before the shot. Under emulated reduced
   * motion tokens.css gives EVERY element a 0.01ms transition, and an element
   * that declares none transitions `all` — so `visibility` too, and a single
   * frame caught a row's overflow button still showing after its row had lost
   * the selection. A short wait is cheaper than chasing that frame.
   */
  await page.waitForTimeout(150);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
  await page.screenshot({ path: path.join(OUT, `library--${name}.png`) });
}

const LIVE_COUNT = LIBRARY.length;

test('01 populated, first row selected, list not focused', async ({ page }) => {
  await boot(page);
  await waitForRows(page, LIVE_COUNT);
  await parkPointer(page);
  await expect(collection(page).locator('[aria-selected="true"]')).toHaveCount(1);
  await shoot(page, '01-populated');
});

test('02 keyboard focus in the list', async ({ page }) => {
  await boot(page);
  await waitForRows(page, LIVE_COUNT);
  await parkPointer(page);
  await row(page, 'Sample: read this aloud').focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(row(page, /^Q4 investor update/)).toHaveAttribute('aria-selected', 'true');
  await expect(row(page, /^Q4 investor update/)).toBeFocused();
  await shoot(page, '02-keyboard-focus');
});

test('03 pointer hovering an unselected row', async ({ page }) => {
  await boot(page);
  await waitForRows(page, LIVE_COUNT);
  await row(page, 'YouTube: how I run twenty agents').hover();
  await expect(row(page, 'YouTube: how I run twenty agents').getByRole('button', { name: 'Present' })).toBeVisible();
  await shoot(page, '03-hover');
});

test('04 row overflow menu open', async ({ page }) => {
  await boot(page);
  await waitForRows(page, LIVE_COUNT);
  await page.getByRole('button', { name: 'Actions for Sample: read this aloud' }).click();
  await expect(page.locator('[role="menu"]')).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Reveal in Finder/ })).toBeVisible();
  await shoot(page, '04-row-menu');
});

test('05 view options menu open', async ({ page }) => {
  await boot(page);
  await waitForRows(page, LIVE_COUNT);
  await viewOptions(page).click();
  await expect(page.locator('[role="menu"]')).toBeVisible();
  await shoot(page, '05-view-options');
});

test('06 search with results', async ({ page }) => {
  await boot(page);
  await waitForRows(page, LIVE_COUNT);
  await page.getByRole('searchbox', { name: 'Search scripts' }).fill('agents');
  await expect.poll(async () => collection(page).getByRole('option').count()).toBeLessThan(LIVE_COUNT);
  await expect(page.getByText('Filtered by “agents”')).toBeVisible();
  await shoot(page, '06-search');
});

test('07 search with no results', async ({ page }) => {
  await boot(page);
  await waitForRows(page, LIVE_COUNT);
  await page.getByRole('searchbox', { name: 'Search scripts' }).fill('zebra crossing');
  await expect(page.getByText('No matching scripts')).toBeVisible();
  await shoot(page, '07-search-empty');
});

test('08 compact density', async ({ page }) => {
  await boot(page, { workspace: { libraryDensity: 'compact' } });
  await waitForRows(page, LIVE_COUNT);
  await parkPointer(page);
  await shoot(page, '08-compact');
});

test('09 sidebar hidden, wide window', async ({ page }) => {
  await boot(page, { viewport: { width: 1340, height: 820 }, workspace: { sidebarVisible: false } });
  await waitForRows(page, LIVE_COUNT);
  await expect(page.getByRole('navigation', { name: 'Library' })).toHaveCount(0);
  await parkPointer(page);
  await shoot(page, '09-sidebar-hidden');
});

test('10 narrow window', async ({ page }) => {
  await boot(page, { viewport: { width: 900, height: 760 } });
  await waitForRows(page, LIVE_COUNT);
  await parkPointer(page);
  await shoot(page, '10-narrow');
});

test('11 a long library', async ({ page }) => {
  await boot(page, { seeds: DENSE });
  await waitForRows(page, DENSE.length);
  await parkPointer(page);
  await shoot(page, '11-dense');
});

test('12 trash', async ({ page }) => {
  await boot(page);
  await waitForRows(page, LIVE_COUNT);
  await page.getByRole('navigation', { name: 'Library' }).getByText('Trash', { exact: true }).click();
  await waitForRows(page, TRASH.length);
  await expect(page.getByRole('heading', { name: 'Trash' })).toBeVisible();
  await parkPointer(page);
  await shoot(page, '12-trash');
});

test('13 recent', async ({ page }) => {
  await boot(page);
  await waitForRows(page, LIVE_COUNT);
  await page.getByRole('navigation', { name: 'Library' }).getByText('Recent', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Recent' })).toBeVisible();
  await waitForRows(page, LIBRARY.filter((s) => s.lastOpenedAt).length);
  await parkPointer(page);
  await shoot(page, '13-recent');
});

test('14 empty library', async ({ page }) => {
  await boot(page, { seeds: [] });
  await expect(page.getByRole('button', { name: 'Create a script' })).toBeVisible();
  await parkPointer(page);
  await shoot(page, '14-empty');
});

test('15 refresh failed with rows on screen', async ({ page }) => {
  await boot(page);
  await waitForRows(page, LIVE_COUNT);
  await page.evaluate(() => {
    (window as unknown as { __E2E__: { setFail(c: string, e: unknown): void } }).__E2E__.setFail('list_scripts', {
      code: 'DATABASE_ERROR',
      userMessage: 'The script library could not be read.',
    });
  });
  await page.getByRole('searchbox', { name: 'Search scripts' }).fill('a');
  await expect(page.getByRole('alert').filter({ hasText: 'Scripts could not be refreshed' })).toBeVisible();
  await parkPointer(page);
  await shoot(page, '15-stale-error');
});

test('16 loading', async ({ page }) => {
  await boot(page);
  await waitForRows(page, LIVE_COUNT);
  await page.evaluate(() => {
    (window as unknown as { __E2E__: { setHeld(c: string, h: boolean): void } }).__E2E__.setHeld('list_scripts', true);
  });
  await page.getByRole('navigation', { name: 'Library' }).getByText('Recent', { exact: true }).click();
  await expect(page.locator('.skeleton').first()).toBeVisible();
  await parkPointer(page);
  await shoot(page, '16-loading');
  await page.evaluate(() => {
    (window as unknown as { __E2E__: { setHeld(c: string, h: boolean): void } }).__E2E__.setHeld('list_scripts', false);
  });
});

test('17 row menu on a short list', async ({ page }) => {
  await boot(page);
  await waitForRows(page, LIVE_COUNT);
  await page.getByRole('navigation', { name: 'Library' }).getByText('Recent', { exact: true }).click();
  await waitForRows(page, LIBRARY.filter((s) => s.lastOpenedAt).length);
  await page.getByRole('button', { name: 'Actions for Sample: read this aloud' }).click();
  const last = page.getByRole('menuitem', { name: 'Move to Trash' });
  await expect(last).toBeVisible();
  // Visible to the hit test, not merely laid out: a clipped menu fails here.
  const box = await last.boundingBox();
  if (!box) throw new Error('the last menu item has no box');
  const hit = await page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.closest('[role="menu"]') !== null,
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  );
  if (!hit) throw new Error('the row menu is clipped by the collection — refusing to write');
  await shoot(page, '17-short-list-menu');
});

test('18 row menu opened from the keyboard', async ({ page }) => {
  await boot(page);
  await waitForRows(page, LIVE_COUNT);
  await parkPointer(page);
  await page.getByRole('button', { name: 'Actions for Sample: read this aloud' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[role="menu"]')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[role="menu"] .item.active')).toHaveCount(1);
  await shoot(page, '18-keyboard-menu');
});

test('19 narrow window with a long title selected', async ({ page }) => {
  await boot(page, { viewport: { width: 900, height: 760 } });
  await waitForRows(page, LIVE_COUNT);
  await row(page, /^Q4 investor update/).click();
  await expect(row(page, /^Q4 investor update/)).toHaveAttribute('aria-selected', 'true');
  await parkPointer(page);
  await expect(page.locator('.statusbar .label').first()).toHaveText('10 scripts');
  await shoot(page, '19-narrow-long-selection');
});

test('20 editor menu opened from the keyboard', async ({ page }) => {
  await boot(page);
  await waitForRows(page, LIVE_COUNT);
  await row(page, 'Daintree intro').dblclick();
  await page.getByRole('textbox', { name: 'Script Markdown' }).waitFor();
  await parkPointer(page);
  await page.getByRole('button', { name: 'Script actions' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[role="menu"]')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[role="menu"] .item.active')).toHaveCount(1);
  await shoot(page, '20-editor-menu');
});

test('21 row menu near the bottom of a scrolled list', async ({ page }) => {
  await boot(page, { seeds: DENSE });
  await waitForRows(page, DENSE.length);
  /*
   * Put a row's menu trigger where the window has room for the six-item menu
   * below it but the scrolling list, which ends at the status bar, does not:
   * the band a window-only measurement got wrong.
   */
  const target = row(page, /^Episode 30:/);
  const trigger = target.getByRole('button', { name: /^Actions for / });
  await target.scrollIntoViewIfNeeded();
  const viewport = page.viewportSize()!;
  await page.evaluate(
    ({ goal }) => {
      const area = document.querySelector<HTMLElement>('.list-area')!;
      const button = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
        .find((r) => r.textContent?.includes('Episode 30:'))!
        .querySelector<HTMLElement>('button[aria-haspopup="menu"]')!;
      area.scrollTop += button.getBoundingClientRect().bottom - goal;
    },
    { goal: viewport.height - 245 },
  );
  await target.hover();
  await trigger.click();
  const last = page.getByRole('menuitem', { name: 'Move to Trash' });
  await expect(last).toBeVisible();
  const box = await last.boundingBox();
  if (!box) throw new Error('the last menu item has no box');
  const hit = await page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.closest('[role="menu"]') !== null,
    { x: box.x + box.width / 2, y: box.y + box.height - 3 },
  );
  if (!hit) throw new Error('the row menu is clipped by the scrolling list — refusing to write');
  await shoot(page, '21-scrolled-row-menu');
});

test('22 paging up a scrolled list keeps the row clear of the headings', async ({ page }) => {
  await boot(page, { seeds: DENSE });
  await waitForRows(page, DENSE.length);
  const start = row(page, /^Episode 20:/);
  await start.scrollIntoViewIfNeeded();
  await start.click();
  await parkPointer(page);
  await start.focus();
  await page.keyboard.press('PageUp');
  const selected = collection(page).locator('[aria-selected="true"]');
  await expect(selected).toBeFocused();
  const rowBox = await selected.boundingBox();
  const headingBox = await page.locator('.columns').boundingBox();
  if (!rowBox || !headingBox) throw new Error('expected the row and the headings to be laid out');
  if (rowBox.y < headingBox.y + headingBox.height - 1) {
    throw new Error(
      `the selected row (top ${rowBox.y}) is under the pinned headings (bottom ${headingBox.y + headingBox.height}) — refusing to write`,
    );
  }
  await shoot(page, '22-page-up-under-headings');
});
