/**
 * Screenshots of the whole control window and the Settings window, for a
 * design review of the app as one product rather than one surface at a time:
 * the sidebar and its mark, the Library, the Editor in each arrangement, every
 * Settings section, the Welcome screen, a take on the glass, and the dialogs a
 * writer meets along the way. Opt-in: it skips unless DESIGN_CAPTURE_DIR names
 * a directory to write into, so the normal suite never runs it.
 *
 *     DESIGN_CAPTURE_DIR=/tmp/shots CANDIDCUE_E2E_PORT=5300 \
 *       ./node_modules/.bin/playwright test --config=playwright.config.ts \
 *       tests/e2e/browser/design-capture-app.spec.ts
 *
 * Everything goes in through the Tauri shim, so every screen is drawn by the
 * real stores and the real routes. Each shot checks that the state it names is
 * actually on screen before it writes, and throws rather than write a picture
 * of something else.
 */
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { installTauriShim, type ShimScriptSeed } from './fixtures/tauri-shim';
import { collection, row } from './fixtures/library';
import { gotoSection, openPreferences } from './fixtures/preferences';

const OUT = process.env['DESIGN_CAPTURE_DIR'];

test.skip(!OUT, 'design capture harness: set DESIGN_CAPTURE_DIR to run it');
test.describe.configure({ timeout: 90_000 });
/* A Mac at Retina density: the rig the app is used on, and the platform the
   sidebar's mark and the menu spellings are drawn for. */
test.use({ deviceScaleFactor: 2 });

const WINDOW = { width: 1240, height: 820 };
const SETTINGS_WINDOW = { width: 900, height: 680 };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const id = (n: number) =>
  `a11a${String(n).padStart(4, '0')}-a11a-4a1a-8a1a-a11aa11a${String(n).padStart(4, '0')}`;

const SAMPLE = `# Getting started

## Read this part out loud

Hi. If you're reading this sentence off the screen right now, that's exactly the idea. Keep going at whatever pace feels natural to you, and watch what the text does as you speak.

You should see the line you're on stay roughly in the middle of the screen. The words behind you fade back, and the words ahead of you sit and wait. You shouldn't have to think about scrolling at all.

[Cue: relax your shoulders and look at the lens]

## Try slowing down

Now try slowing right down for a sentence or two, and put a real pause in the middle of this one — like that. The text should ease off and wait for you rather than running ahead.

Then pick the pace back up again. It should catch up smoothly, without jumping.

# What to try next

## Go off script

Say something that isn't written here at all. Talk about your day, or what you had for breakfast, for five or ten seconds, and then come back to this line and carry on reading.

That's the hard part of following a voice, and it's worth seeing how it handles it before you rely on it for anything real.

[Beat]

## Start a sentence over

Read this next sentence, stop halfway through, and then start it again from the beginning. Presenters do this constantly, and the script should follow you backwards without losing its place.

[Take: Wrapping up]

# Wrapping up

That's the tour. Delete all of this and write your own words whenever you're ready — the words you plan to say, written the way you'd actually say them.

[Cue: hold still for two seconds before you stop the take]
`;

const INTRO = `# Cold open

Every tool wants you to run more AI agents. That's fine, but running more agents was never the hard part. The hard part is managing your attention, because that's the thing that actually runs out.

So this week I rebuilt the overview around exactly three questions: is anything asking me for something, is anything stuck, and is anything finished and waiting.

[Cue: cut to the screen recording]

# The overview

Here's what it looks like with twenty agents running. **Nothing** in this list is decoration.
`;

const LIBRARY: ShimScriptSeed[] = [
  { id: id(1), title: 'Sample: read this aloud', source: SAMPLE, updatedAt: ago(16 * HOUR), lastOpenedAt: ago(16 * HOUR) },
  { id: id(2), title: 'Daintree intro', source: INTRO, updatedAt: ago(43 * DAY), lastOpenedAt: ago(43 * DAY) },
  { id: id(3), title: 'Untitled script', source: '', updatedAt: ago(65 * DAY) },
  {
    id: id(4),
    title: 'Teleprompter test',
    source:
      'Good morning, and welcome to this short teleprompter test. The goal is to check whether the text scrolls smoothly and remains easy to follow at a natural speaking pace.\n',
    updatedAt: ago(65 * DAY),
  },
  {
    id: id(5),
    title: 'Q4 investor update',
    source: `# Opening\n\nThank you for joining me today. Here is what changed this quarter, and why it matters for the next one.\n`,
    updatedAt: ago(70 * DAY),
    hasWarnings: true,
  },
];

const ENGINE_READY = {
  available: true,
  loaded: true,
  model: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05',
};

interface Boot {
  seeds?: ShimScriptSeed[];
  viewport?: { width: number; height: number };
  welcomed?: boolean;
}

/** Make the page report macOS before any app code reads `navigator`. */
async function pretendMac(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' });
    Object.defineProperty(Navigator.prototype, 'userAgentData', {
      get: () => ({ platform: 'macOS', brands: [], mobile: false }),
    });
  });
}

async function boot(page: Page, opts: Boot = {}): Promise<void> {
  await pretendMac(page);
  await page.setViewportSize(opts.viewport ?? WINDOW);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installTauriShim(page, {
    welcomed: opts.welcomed ?? true,
    seedScripts: opts.seeds ?? LIBRARY,
    engineStatus: ENGINE_READY,
    promptMode: 'voice',
  });
}

async function bootLibrary(page: Page, opts: Boot = {}): Promise<void> {
  await boot(page, opts);
  await page.goto('/control.html');
  if ((opts.seeds ?? LIBRARY).length > 0) {
    await expect(collection(page).getByRole('option')).toHaveCount((opts.seeds ?? LIBRARY).length);
  }
}

async function openScript(page: Page, title: string): Promise<void> {
  await row(page, title).dblclick();
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeVisible();
}

/** Park the pointer where it hovers nothing. */
async function parkPointer(page: Page): Promise<void> {
  const size = page.viewportSize();
  await page.mouse.move((size?.width ?? 1240) - 4, (size?.height ?? 820) - 4);
}

/** Wait out every finite animation and two frames, so a capture is at rest. */
async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(150);
  await page.evaluate(async () => {
    await document.fonts.ready;
    const finite = document
      .getAnimations()
      .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
    // Capped: a take keeps long finite fades running, and a picture of the
    // frame they are in is still the picture somebody sees.
    await Promise.race([
      Promise.all(finite.map((a) => a.finished.catch(() => undefined))),
      new Promise((r) => setTimeout(r, 2_000)),
    ]);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}

async function shoot(
  page: Page,
  name: string,
  clip?: { x: number; y: number; width: number; height: number },
): Promise<void> {
  if (!OUT) throw new Error('DESIGN_CAPTURE_DIR must be set');
  fs.mkdirSync(OUT, { recursive: true });
  await settle(page);
  const file = path.join(OUT, `app--${name}.png`);
  await page.screenshot({ path: file, clip });
  const size = fs.statSync(file).size;
  if (size < 4_000) throw new Error(`${name}.png is ${size} bytes — not a real capture`);
}

test('01 library with the sidebar', async ({ page }) => {
  await bootLibrary(page);
  await parkPointer(page);
  await expect(page.getByRole('navigation', { name: 'Library' })).toBeVisible();
  await shoot(page, '01-library');
});

test('02 the sidebar, close up', async ({ page }) => {
  await bootLibrary(page);
  await parkPointer(page);
  const nav = page.getByRole('navigation', { name: 'Library' });
  await expect(nav).toBeVisible();
  await shoot(page, '02-sidebar-closeup', { x: 0, y: 0, width: 520, height: 300 });
});

test('03 sidebar keyboard focus on a row that is not the current one', async ({ page }) => {
  await bootLibrary(page);
  await parkPointer(page);
  const nav = page.getByRole('navigation', { name: 'Library' });
  await nav.getByRole('button', { name: 'All scripts' }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(nav.getByRole('button', { name: 'Recent' })).toBeFocused();
  await shoot(page, '03-sidebar-focus', { x: 0, y: 0, width: 520, height: 300 });
});

test('04 empty library', async ({ page }) => {
  await bootLibrary(page, { seeds: [] });
  await expect(page.getByRole('button', { name: 'Create a script' })).toBeVisible();
  await parkPointer(page);
  await shoot(page, '04-library-empty');
});

test('05 editor, the default arrangement', async ({ page }) => {
  await bootLibrary(page);
  await openScript(page, 'Sample: read this aloud');
  await parkPointer(page);
  await shoot(page, '05-editor');
});

test('06 editor, source and preview side by side', async ({ page }) => {
  await bootLibrary(page);
  await openScript(page, 'Sample: read this aloud');
  await page.getByRole('radiogroup', { name: 'Editor mode' }).getByRole('radio', { name: 'Both' }).click();
  await expect(page.getByRole('radiogroup', { name: 'Editor mode' }).getByRole('radio', { name: 'Both' })).toBeChecked();
  await parkPointer(page);
  await shoot(page, '06-editor-both');
});

test('07 editor, preview', async ({ page }) => {
  await bootLibrary(page);
  await openScript(page, 'Sample: read this aloud');
  await page.getByRole('radiogroup', { name: 'Editor mode' }).getByRole('radio', { name: 'Preview' }).click();
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeHidden();
  await parkPointer(page);
  await shoot(page, '07-editor-preview');
});

test('08 editor, a blank new script', async ({ page }) => {
  await bootLibrary(page);
  await openScript(page, 'Untitled script');
  await parkPointer(page);
  await shoot(page, '08-editor-blank');
});

test('09 editor, script actions menu', async ({ page }) => {
  await bootLibrary(page);
  await openScript(page, 'Daintree intro');
  await page.getByRole('button', { name: 'Script actions' }).click();
  await expect(page.locator('[role="menu"]')).toBeVisible();
  await shoot(page, '09-editor-actions-menu');
});

test('10 editor, the Present menu', async ({ page }) => {
  await bootLibrary(page);
  await openScript(page, 'Sample: read this aloud');
  await page.getByRole('button', { name: 'How to present' }).click();
  await expect(page.locator('[role="menu"]')).toBeVisible();
  await shoot(page, '10-editor-present-menu');
});

const SECTIONS = [
  'General',
  'Speech',
  'Audio',
  'Prompter display and rigs',
  'Teleprompter',
  'Following',
  'Data, privacy & updates',
];

for (const [index, name] of SECTIONS.entries()) {
  const n = String(11 + index).padStart(2, '0');
  const slug = name.toLowerCase().replace(/[^a-z]+/g, '-').replace(/-+$/, '');
  test(`${n} settings — ${name}`, async ({ page }) => {
    await boot(page, { viewport: SETTINGS_WINDOW });
    await openPreferences(page);
    if (index > 0) await gotoSection(page, name);
    await parkPointer(page);
    await shoot(page, `${n}-settings-${slug}`);
  });
}

test('18 welcome', async ({ page }) => {
  await boot(page, { welcomed: false });
  await page.goto('/control.html');
  await expect(page.getByRole('heading').first()).toBeVisible();
  await expect(collection(page)).toHaveCount(0);
  await parkPointer(page);
  await shoot(page, '18-welcome');
});

test('19 a take on the glass', async ({ page }) => {
  await bootLibrary(page);
  await collection(page).getByRole('button', { name: 'Present', exact: true }).first().click();
  await expect(page.getByRole('region', { name: 'Teleprompter' })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.stage-root')).toHaveAttribute('data-phase', 'ready');
  await parkPointer(page);
  await shoot(page, '19-take');
});

test('20 keyboard shortcuts', async ({ page }) => {
  await bootLibrary(page);
  await expect
    .poll(() => page.evaluate(() => window.__E2E__.emit('menu://command', { id: 'help.keyboard-shortcuts' })))
    .toBeGreaterThan(0);
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  await parkPointer(page);
  await shoot(page, '20-shortcuts');
});

test('21 script syntax reference', async ({ page }) => {
  await bootLibrary(page);
  await openScript(page, 'Sample: read this aloud');
  await expect
    .poll(() => page.evaluate(() => window.__E2E__.emit('menu://command', { id: 'help.syntax-reference' })))
    .toBeGreaterThan(0);
  await expect(page.getByRole('dialog')).toBeVisible();
  await parkPointer(page);
  await shoot(page, '21-syntax-reference');
});

/*
 * The app icon where people actually meet it: the Dock and Finder at the sizes
 * macOS draws, on a light and a dark desktop, beside the mark the sidebar
 * carries. Reads the committed icon files, so a regenerated set is what shows.
 */
test('22 app icon at the sizes macOS draws it', async ({ page }) => {
  const icons = path.resolve('src-tauri/icons');
  const data = (file: string) =>
    `data:image/png;base64,${fs.readFileSync(path.join(icons, file)).toString('base64')}`;
  const big = data('icon.png');
  // What a Retina screen actually draws at each point size: 32pt takes the
  // 64px asset (the master), 16pt the 32px small drawing.
  const small = { 128: data('128x128.png'), 64: data('128x128.png'), 32: data('64x64.png'), 16: data('32x32.png') };
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.setContent(`<!doctype html><html><body style="margin:0;font:13px -apple-system,system-ui,sans-serif">
    ${['#e9e7e4', '#1f1f22']
      .map(
        (bg) => `<div style="display:flex;align-items:flex-end;gap:36px;padding:28px 36px;background:${bg};color:${bg === '#1f1f22' ? '#ddd' : '#333'}">
          <figure style="margin:0;text-align:center"><img src="${big}" width="256" height="256"><figcaption>256</figcaption></figure>
          <figure style="margin:0;text-align:center"><img src="${small[128]}" width="128" height="128"><figcaption>128</figcaption></figure>
          <figure style="margin:0;text-align:center"><img src="${small[64]}" width="64" height="64"><figcaption>64 (Dock)</figcaption></figure>
          <figure style="margin:0;text-align:center"><img src="${small[32]}" width="32" height="32"><figcaption>32</figcaption></figure>
          <figure style="margin:0;text-align:center"><img src="${small[16]}" width="16" height="16"><figcaption>16</figcaption></figure>
        </div>`,
      )
      .join('')}
  </body></html>`);
  await expect(page.locator('img')).toHaveCount(10);
  await page.evaluate(() => Promise.all([...document.images].map((img) => img.decode())));
  await shoot(page, '22-app-icon');
});

test('23 editor, both, at a larger text size', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'candidcue.workspace.v1',
      JSON.stringify({ editorLayout: 'split', documentScale: 1.25 }),
    );
  });
  await bootLibrary(page);
  await openScript(page, 'Sample: read this aloud');
  await expect(page.getByRole('radiogroup', { name: 'Editor mode' }).getByRole('radio', { name: 'Both' })).toBeChecked();
  // Both halves at the larger size, not just the source: the preview's body
  // text must have grown past its 100% size (17px) too.
  await expect
    .poll(() =>
      page.locator('.preview p').first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
    )
    .toBeGreaterThan(18);
  await parkPointer(page);
  await shoot(page, '23-editor-both-larger');
});
