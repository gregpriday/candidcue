/**
 * Screenshots of the editor's writing surface — the CodeMirror source pane —
 * for a design review of its type, syntax colouring, caret and selection.
 * Opt-in: it skips unless DESIGN_CAPTURE_DIR names a directory to write into,
 * so the normal suite never runs it.
 *
 *     DESIGN_CAPTURE_DIR=/tmp/shots CANDIDCUE_E2E_PORT=5300 \
 *       ./node_modules/.bin/playwright test --config=playwright.config.ts \
 *       tests/e2e/browser/design-writing-surface.spec.ts
 *
 * It runs in WebKit, because the app ships in WKWebView and the things this
 * surface is judged on — native selection, the caret, glyph rendering — are
 * exactly where the engines differ. Every shot goes in through the Tauri shim,
 * so the editor is the real route with the real stores, and each one checks
 * that the state it names is on screen before it writes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { installTauriShim, type ShimScriptSeed } from './fixtures/tauri-shim';
import { collection, row } from './fixtures/library';

const OUT = process.env['DESIGN_CAPTURE_DIR'];

test.skip(!OUT, 'design capture harness: set DESIGN_CAPTURE_DIR to run it');
test.describe.configure({ timeout: 90_000 });
/* WebKit at Retina density. The chromium project's fake-media flags and its
   microphone grant are Chromium-only, and WebKit refuses both. */
test.use({
  browserName: 'webkit',
  deviceScaleFactor: 2,
  launchOptions: { args: [] },
  permissions: [],
});
test.beforeEach(({ browserName }) => {
  expect(browserName, 'this harness exists to show WebKit').toBe('webkit');
});

const WINDOW = { width: 1240, height: 820 };

const id = (n: number) =>
  `5c1a${String(n).padStart(4, '0')}-5c1a-4a1a-8a1a-5c1aa11a${String(n).padStart(4, '0')}`;

/* Every construct a script uses, in the order a real one would use them. */
const SCRIPT = `# Cold open

[Cue: look at the lens]

Every tool wants you to run more AI agents. That's fine, but running more agents was never the hard part. The hard part is managing your **attention**, because that's the thing that actually runs out.

So this week I rebuilt the overview around *three questions*. [Beat] Is anything asking me for something? Is anything stuck? Is anything finished and waiting?

## What changed

- The list is sorted by **who needs you**, not by age
- Stuck agents float to the top [Pause]
- Read [the release notes](https://example.com/notes) for the details

The API{say="A P I"} is the same as before, so nothing you've built breaks.

:::silent
Cut to the screen recording here. Hold on the overview for three seconds.
:::

> Nothing in this list is decoration.

[Take: The overview]

# The overview

Here's what it looks like with twenty agents running. Type \`daintree status\` in any terminal and you get the same view. [Breathe]

![The overview with twenty agents](images/overview.png)

That's the tour. ~~Thanks for watching.~~ See you next week.
`;

/* Long enough that its end is well below the fold. */
const LONG = `${SCRIPT}
${Array.from(
  { length: 6 },
  (_, n) => `## Part ${n + 2}

This is the part of the script where the argument has to carry itself. Say it plainly, keep the sentences short enough to say on one breath, and let the pauses do some of the work for you.

Then come back to the overview and show what changed, one row at a time, so the viewer sees the same thing you do.
`,
).join('\n')}
That's everything for this week.`;

/* The constructs the compiler treats as literal or unspoken, side by side. */
const EDGES = `## Shown, not said

:::stage
Key result: **42% faster**
:::

:::spoken
visual: Q3 revenue: $4.2M
say: third quarter revenue was four point two million [Pause]
:::

Type \\[Pause] to add a pause, and \`[Beat]\` stays code. The CLI{say="C L I"} ships today.

| Plan | Price |
| --- | --- |
| Pro | **12** |

\`\`\`js
console.log("[Beat]");
\`\`\`

\`\`\`mermaid
graph LR
  Idea --> Script
\`\`\`

Back to the script for the last line. [Breathe]
`;

const SEEDS: ShimScriptSeed[] = [
  { id: id(1), title: 'Weekly update', source: SCRIPT },
  { id: id(4), title: 'Edge cases', source: EDGES },
  { id: id(2), title: 'Long script', source: LONG },
  { id: id(3), title: 'Untitled script', source: '' },
];

const ENGINE_READY = {
  available: true,
  loaded: true,
  model: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05',
};

interface Boot {
  viewport?: { width: number; height: number };
  workspace?: Record<string, unknown>;
}

async function boot(page: Page, opts: Boot = {}): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' });
  });
  if (opts.workspace) {
    await page.addInitScript((ws) => {
      localStorage.setItem('candidcue.workspace.v1', JSON.stringify(ws));
    }, opts.workspace);
  }
  await page.setViewportSize(opts.viewport ?? WINDOW);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: SEEDS,
    engineStatus: ENGINE_READY,
    promptMode: 'voice',
  });
  await page.goto('/control.html');
  await expect(collection(page).getByRole('option')).toHaveCount(SEEDS.length);
}

async function open(page: Page, title: string): Promise<void> {
  await row(page, title).dblclick();
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeVisible();
}

/** Put the caret in a line, at a fraction of the way along its text. */
async function caretIn(page: Page, text: string, at = 0.5): Promise<void> {
  const line = page.locator('.cm-line').filter({ hasText: text }).first();
  const box = await line.boundingBox();
  if (!box) throw new Error(`no line containing "${text}"`);
  await line.click({ position: { x: Math.max(24, box.width * at), y: box.height / 2 } });
  await expect(page.locator('.cm-editor')).toHaveClass(/cm-focused/);
}

/** Park the pointer where it hovers nothing. */
async function parkPointer(page: Page): Promise<void> {
  const size = page.viewportSize();
  await page.mouse.move((size?.width ?? 1240) - 4, (size?.height ?? 820) - 4);
}

/** Wait out every finite animation and two frames, so a capture is at rest. */
async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(120);
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
 * Nudge the caret so its blink restarts in the visible phase. The caret is
 * the subject of half these shots, and a blink caught off is a lie.
 */
async function wakeCaret(page: Page): Promise<void> {
  // Out and back, ending where it started — even at the end of the document,
  // where a plain right-then-left would step the caret back a character.
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('ArrowRight');
  // The drawn selection repaints on the next frame; without waiting for it the
  // one-character selection in between ends up in the picture.
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
}

async function shoot(
  page: Page,
  name: string,
  opts: { clip?: { x: number; y: number; width: number; height: number }; caret?: boolean } = {},
): Promise<void> {
  if (!OUT) throw new Error('DESIGN_CAPTURE_DIR must be set');
  fs.mkdirSync(OUT, { recursive: true });
  await settle(page);
  if (opts.caret) await wakeCaret(page);
  const file = path.join(OUT, `ws--${name}.png`);
  await page.screenshot({ path: file, clip: opts.clip, caret: opts.caret ? 'initial' : 'hide' });
  const size = fs.statSync(file).size;
  if (size < 4_000) throw new Error(`${name}.png is ${size} bytes — not a real capture`);
}

/** The editor pane's box, for close-up clips. */
async function paneBox(page: Page) {
  const box = await page.locator('.editor-pane').boundingBox();
  if (!box) throw new Error('editor pane has no box');
  return box;
}

test('01 a populated script, caret in a paragraph', async ({ page }) => {
  await boot(page);
  await open(page, 'Weekly update');
  await caretIn(page, 'Every tool wants you', 0.4);
  await parkPointer(page);
  await shoot(page, '01-edit-caret', { caret: true });
});

test('02 a selection across a heading, a cue and a list', async ({ page }) => {
  await boot(page);
  await open(page, 'Weekly update');
  await caretIn(page, 'So this week I rebuilt', 0.3);
  for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+End');
  expect(await page.evaluate(() => document.getSelection()?.toString().length ?? 0)).toBeGreaterThan(80);
  await parkPointer(page);
  await shoot(page, '02-selection');
});

test('03 the same selection after focus leaves the editor', async ({ page }) => {
  await boot(page);
  await open(page, 'Weekly update');
  await caretIn(page, 'So this week I rebuilt', 0.3);
  for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+End');
  await page.getByRole('button', { name: 'Script actions' }).focus();
  await expect(page.locator('.cm-editor')).not.toHaveClass(/cm-focused/);
  await parkPointer(page);
  await shoot(page, '03-selection-blurred');
});

test('04 syntax close-up', async ({ page }) => {
  await boot(page);
  await open(page, 'Weekly update');
  await parkPointer(page);
  const pane = await paneBox(page);
  await shoot(page, '04-syntax-closeup', {
    clip: { x: pane.x, y: pane.y, width: Math.min(pane.width, 760), height: Math.min(pane.height, 560) },
  });
});

test('05 syntax close-up, lower half of the script', async ({ page }) => {
  await boot(page);
  await open(page, 'Weekly update');
  await caretIn(page, 'Nothing in this list', 0.2);
  await page.locator('.cm-scroller').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await parkPointer(page);
  const pane = await paneBox(page);
  await shoot(page, '05-syntax-closeup-lower', {
    clip: {
      x: pane.x,
      y: pane.y + pane.height - Math.min(pane.height, 560),
      width: Math.min(pane.width, 760),
      height: Math.min(pane.height, 560),
    },
  });
});

test('06 caret close-up', async ({ page }) => {
  await boot(page);
  await open(page, 'Weekly update');
  await caretIn(page, 'The hard part is', 0.5);
  await parkPointer(page);
  const caret = await page.evaluate(() => {
    const sel = document.getSelection();
    const rect = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).getBoundingClientRect() : null;
    return rect ? { x: rect.x, y: rect.y } : null;
  });
  if (!caret) throw new Error('no caret to frame');
  await shoot(page, '06-caret-closeup', {
    caret: true,
    clip: { x: Math.max(0, caret.x - 160), y: Math.max(0, caret.y - 60), width: 320, height: 140 },
  });
});

test('07 source and preview side by side', async ({ page }) => {
  await boot(page, { workspace: { editorLayout: 'split' } });
  await open(page, 'Weekly update');
  await caretIn(page, 'So this week I rebuilt', 0.5);
  await parkPointer(page);
  await shoot(page, '07-both', { caret: true });
});

test('08 the largest editor text size', async ({ page }) => {
  await boot(page, { workspace: { documentScale: 1.6 } });
  await open(page, 'Weekly update');
  await caretIn(page, 'Every tool wants you', 0.3);
  await parkPointer(page);
  await shoot(page, '08-larger-text', { caret: true });
});

test('09 the smallest window the app allows', async ({ page }) => {
  await boot(page, { viewport: { width: 980, height: 680 } });
  await open(page, 'Weekly update');
  await caretIn(page, 'Every tool wants you', 0.3);
  await parkPointer(page);
  await shoot(page, '09-small-window', { caret: true });
});

test('10 a wide window with the outline hidden', async ({ page }) => {
  await boot(page, { viewport: { width: 1680, height: 1000 }, workspace: { outlineVisible: false } });
  await open(page, 'Weekly update');
  await caretIn(page, 'Every tool wants you', 0.3);
  await parkPointer(page);
  await shoot(page, '10-wide-no-outline', { caret: true });
});

test('11 writing at the end of a long script', async ({ page }) => {
  await boot(page);
  await open(page, 'Long script');
  await caretIn(page, 'Every tool wants you', 0.1);
  await page.keyboard.press('Meta+ArrowDown');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('And one more line, typed at the very end.');
  await expect(page.locator('.cm-content')).toContainText('typed at the very end');
  await parkPointer(page);
  await shoot(page, '11-end-of-long-script', { caret: true });
});

test('12 a blank script, focused', async ({ page }) => {
  await boot(page);
  await open(page, 'Untitled script');
  await page.locator('.cm-content').click();
  await expect(page.locator('.cm-editor')).toHaveClass(/cm-focused/);
  await expect(page.locator('.cm-placeholder')).toBeVisible();
  await parkPointer(page);
  await shoot(page, '12-blank-focused', { caret: true });
});

test('13 what the compiler shows but never says', async ({ page }) => {
  await boot(page);
  await open(page, 'Edge cases');
  await expect(page.locator('.cm-content')).toContainText('graph LR');
  await parkPointer(page);
  const pane = await paneBox(page);
  await shoot(page, '13-unspoken-closeup', {
    clip: { x: pane.x, y: pane.y, width: Math.min(pane.width, 760), height: Math.min(pane.height, 640) },
  });
});
