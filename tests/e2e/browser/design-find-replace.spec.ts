/**
 * Screenshots of the editor's find and replace panel, for a design review of
 * that one surface: empty, with matches, with none, each search option, a bad
 * regular expression, the replace row before and after Replace All, keyboard
 * focus inside the panel, and the narrowest pane it has to fit, the split
 * editor at the smallest window the app allows. Opt-in: it skips unless
 * DESIGN_CAPTURE_DIR names a directory to write into, so the normal suite never
 * runs it.
 *
 *     DESIGN_CAPTURE_DIR=/tmp/shots SPEAKING_GLASS_E2E_PORT=5300 \
 *       ./node_modules/.bin/playwright test --config=playwright.config.ts \
 *       tests/e2e/browser/design-find-replace.spec.ts
 *
 * The panel is opened the way the Edit menu opens it, through the route
 * command bus, and every field is reached by its `name`, so the same spec
 * drives the panel whatever it is built from. Each shot checks that the state
 * it names is actually on screen before it writes, and throws rather than
 * write a picture of something else.
 */
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { installTauriShim, type ShimScriptSeed } from './fixtures/tauri-shim';
import { collection, row } from './fixtures/library';

const OUT = process.env['DESIGN_CAPTURE_DIR'];

test.skip(!OUT, 'design capture harness: set DESIGN_CAPTURE_DIR to run it');
test.describe.configure({ timeout: 90_000 });
test.use({ deviceScaleFactor: 2 });

const WINDOW = { width: 1240, height: 820 };
/* `minWidth`/`minHeight` in tauri.conf.json: the smallest window there is. */
const SMALLEST_WINDOW = { width: 980, height: 680 };

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
`;

const SEEDS: ShimScriptSeed[] = [
  {
    id: 'f1d0f1d0-f1d0-4f1d-8f1d-f1d0f1d00001',
    title: 'Sample: read this aloud',
    source: SAMPLE,
    updatedAt: new Date(Date.now() - 16 * 3_600_000).toISOString(),
  },
];

const ENGINE_READY = {
  available: true,
  loaded: true,
  model: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05',
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

interface Boot {
  viewport?: { width: number; height: number };
  split?: boolean;
}

/** Boot the app, open the sample script, and wait for the editor. */
async function openEditor(page: Page, opts: Boot = {}): Promise<void> {
  await pretendMac(page);
  await page.setViewportSize(opts.viewport ?? WINDOW);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  if (opts.split) {
    await page.addInitScript(() => {
      localStorage.setItem('speaking-glass.workspace.v1', JSON.stringify({ editorLayout: 'split' }));
    });
  }
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: SEEDS,
    engineStatus: ENGINE_READY,
    promptMode: 'voice',
  });
  await page.goto('/control.html');
  await expect(collection(page).getByRole('option')).toHaveCount(SEEDS.length);
  await row(page, 'Sample: read this aloud').dblclick();
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeVisible();
}

/** Run an Edit menu command the way the native menu delivers it. */
async function menu(page: Page, id: string): Promise<void> {
  await expect
    .poll(() => page.evaluate((cmd) => window.__E2E__.emit('menu://command', { id: cmd }), id))
    .toBeGreaterThan(0);
}

function panel(page: Page): Locator {
  return page.locator('.cm-search');
}

function field(page: Page, name: 'search' | 'replace'): Locator {
  return panel(page).locator(`input[name="${name}"]`);
}

/** Type into a panel field key by key, as a person does. */
async function typeInto(page: Page, name: 'search' | 'replace', text: string): Promise<void> {
  const input = field(page, name);
  await input.focus();
  await input.press('ControlOrMeta+a');
  await input.press('Backspace');
  await input.pressSequentially(text, { delay: 5 });
  await expect(input).toHaveValue(text);
}

/** Turn a search option on, whatever control the panel draws it with. */
async function enableOption(page: Page, name: 'case' | 'word' | 're'): Promise<void> {
  const control = panel(page).locator(`[name="${name}"]`);
  await control.click();
  const on = await control.evaluate(
    (el) =>
      (el as HTMLInputElement).checked === true || el.getAttribute('aria-pressed') === 'true',
  );
  if (!on) throw new Error(`the "${name}" option did not turn on`);
}

function matches(page: Page): Locator {
  return page.locator('.cm-content .cm-searchMatch');
}

async function editorText(page: Page): Promise<string> {
  return page.locator('.cm-content').innerText();
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
    await Promise.race([
      Promise.all(finite.map((a) => a.finished.catch(() => undefined))),
      new Promise((r) => setTimeout(r, 2_000)),
    ]);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}

/**
 * The top of the editor pane: the formatting row above it for context, the
 * panel, and enough of the document beneath to see the highlighted matches.
 */
async function paneClip(page: Page, below = 440) {
  const pane = await page.locator('.editor-pane').boundingBox();
  if (!pane) throw new Error('editor pane is not on screen');
  const top = Math.max(0, pane.y - 36);
  return { x: pane.x, y: top, width: pane.width, height: Math.min(pane.y - top + below, pane.height + pane.y - top) };
}

async function shoot(
  page: Page,
  name: string,
  clip?: { x: number; y: number; width: number; height: number },
): Promise<void> {
  if (!OUT) throw new Error('DESIGN_CAPTURE_DIR must be set');
  fs.mkdirSync(OUT, { recursive: true });
  await settle(page);
  // Re-check after the settle: the panel must still be open when the picture
  // is taken, or this is a picture of the editor and nothing else.
  await expect(panel(page)).toBeVisible();
  const file = path.join(OUT, `find--${name}.png`);
  await page.screenshot({ path: file, clip });
  const size = fs.statSync(file).size;
  if (size < 4_000) throw new Error(`${name}.png is ${size} bytes — not a real capture`);
}

test('01 find, in the whole window, stepped to a match', async ({ page }) => {
  await openEditor(page);
  await menu(page, 'edit.find');
  await expect(field(page, 'search')).toBeFocused();
  await typeInto(page, 'search', 'text');
  await field(page, 'search').press('Enter');
  await field(page, 'search').press('Enter');
  await expect(matches(page)).not.toHaveCount(0);
  await parkPointer(page);
  await shoot(page, '01-window-matches');
});

test('02 find, just opened', async ({ page }) => {
  await openEditor(page);
  await menu(page, 'edit.find');
  await expect(field(page, 'search')).toBeFocused();
  await expect(field(page, 'search')).toHaveValue('');
  await parkPointer(page);
  await shoot(page, '02-empty', await paneClip(page));
});

test('03 find, many matches, stepped to the third', async ({ page }) => {
  await openEditor(page);
  await menu(page, 'edit.find');
  await typeInto(page, 'search', 'the');
  for (let i = 0; i < 3; i++) await field(page, 'search').press('Enter');
  await expect(matches(page)).not.toHaveCount(0);
  await parkPointer(page);
  await shoot(page, '03-matches', await paneClip(page));
});

test('04 find, no results', async ({ page }) => {
  await openEditor(page);
  await menu(page, 'edit.find');
  await typeInto(page, 'search', 'teleprompters');
  await field(page, 'search').press('Enter');
  await expect(matches(page)).toHaveCount(0);
  await parkPointer(page);
  await shoot(page, '04-no-results', await paneClip(page));
});

test('05 find, match case and whole word on', async ({ page }) => {
  await openEditor(page);
  await menu(page, 'edit.find');
  await typeInto(page, 'search', 'The');
  await enableOption(page, 'case');
  await enableOption(page, 'word');
  await field(page, 'search').press('Enter');
  await expect(matches(page)).not.toHaveCount(0);
  await parkPointer(page);
  await shoot(page, '05-options-on', await paneClip(page));
});

test('06 find, a regular expression that does not parse', async ({ page }) => {
  await openEditor(page);
  await menu(page, 'edit.find');
  await enableOption(page, 're');
  await typeInto(page, 'search', '(read|say');
  await expect(matches(page)).toHaveCount(0);
  await parkPointer(page);
  await shoot(page, '06-regex-invalid', await paneClip(page));
});

test('07 find, a regular expression with matches', async ({ page }) => {
  await openEditor(page);
  await menu(page, 'edit.find');
  await enableOption(page, 're');
  await typeInto(page, 'search', 's(low|mooth)\\w*');
  await field(page, 'search').press('Enter');
  await expect(matches(page)).not.toHaveCount(0);
  await parkPointer(page);
  await shoot(page, '07-regex-matches', await paneClip(page));
});

test('08 find and replace, ready to replace', async ({ page }) => {
  await openEditor(page);
  await menu(page, 'edit.replace');
  await expect(field(page, 'replace')).toBeFocused();
  await typeInto(page, 'search', 'text');
  await typeInto(page, 'replace', 'script');
  await field(page, 'search').press('Enter');
  await field(page, 'replace').focus();
  await expect(matches(page)).not.toHaveCount(0);
  await parkPointer(page);
  await shoot(page, '08-replace-ready', await paneClip(page));
});

test('09 find and replace, after Replace All', async ({ page }) => {
  await openEditor(page);
  await menu(page, 'edit.replace');
  await typeInto(page, 'search', 'text');
  await typeInto(page, 'replace', 'script');
  await panel(page).getByRole('button', { name: /^replace all/i }).click();
  await expect.poll(() => editorText(page)).not.toMatch(/\btext\b/);
  await parkPointer(page);
  await shoot(page, '09-after-replace-all', await paneClip(page));
});

test('10 find and replace, in the whole window', async ({ page }) => {
  await openEditor(page);
  await menu(page, 'edit.replace');
  await typeInto(page, 'search', 'text');
  await typeInto(page, 'replace', 'script');
  await field(page, 'search').press('Enter');
  await field(page, 'replace').focus();
  await parkPointer(page);
  await shoot(page, '10-window-replace');
});

test('11 keyboard focus on a search option', async ({ page }) => {
  await openEditor(page);
  await menu(page, 'edit.find');
  await typeInto(page, 'search', 'the');
  // Walk forward from the field until a search option has focus.
  let reached = false;
  for (let i = 0; i < 8 && !reached; i++) {
    await page.keyboard.press('Tab');
    reached = await page.evaluate(() => {
      const el = document.activeElement;
      return !!el?.closest('.cm-search') && ['case', 'word', 're'].includes(el.getAttribute('name') ?? '');
    });
  }
  if (!reached) throw new Error('Tab never reached a search option');
  await parkPointer(page);
  await shoot(page, '11-focus-option', await paneClip(page, 200));
});

test('12 a very long query', async ({ page }) => {
  await openEditor(page);
  await menu(page, 'edit.replace');
  await typeInto(page, 'search', 'Read this next sentence, stop halfway through, and then start it again from the beginning');
  await typeInto(page, 'replace', 'Read this next sentence, stop halfway, and start it over from the top');
  await field(page, 'search').press('Enter');
  await expect(matches(page)).toHaveCount(1);
  await parkPointer(page);
  await shoot(page, '12-long-query', await paneClip(page));
});

test('13 the smallest window, source and preview side by side', async ({ page }) => {
  await openEditor(page, { viewport: SMALLEST_WINDOW, split: true });
  await menu(page, 'edit.replace');
  await typeInto(page, 'search', 'the');
  await typeInto(page, 'replace', 'a');
  await field(page, 'search').press('Enter');
  await expect(matches(page)).not.toHaveCount(0);
  await parkPointer(page);
  await shoot(page, '13-compact-split-window');
});

test('14 the smallest split pane, close up', async ({ page }) => {
  await openEditor(page, { viewport: SMALLEST_WINDOW, split: true });
  await menu(page, 'edit.replace');
  await typeInto(page, 'search', 'the');
  await typeInto(page, 'replace', 'a');
  await enableOption(page, 'case');
  await field(page, 'search').press('Enter');
  await expect(matches(page)).not.toHaveCount(0);
  await parkPointer(page);
  await shoot(page, '14-compact-split-pane', await paneClip(page, 260));
});

test('15 the smallest split pane, a regular expression that does not parse', async ({ page }) => {
  await openEditor(page, { viewport: SMALLEST_WINDOW, split: true });
  await menu(page, 'edit.find');
  await enableOption(page, 're');
  await typeInto(page, 'search', '(read|say');
  await expect(matches(page)).toHaveCount(0);
  await parkPointer(page);
  await shoot(page, '15-compact-regex-invalid', await paneClip(page, 200));
});
