/**
 * Screenshots of the Editor's rendered preview, for a design review of that
 * one pane: a script as it reads, every kind of block the compiler can hand
 * it, the click-to-edit affordance and where a click lands, Preview beside the
 * source, and the empty and failed states. Opt-in: it skips unless
 * DESIGN_CAPTURE_DIR names a directory to write into, so the normal suite never
 * runs it.
 *
 *     DESIGN_CAPTURE_DIR=/tmp/shots CANDIDCUE_E2E_PORT=5300 \
 *       ./node_modules/.bin/playwright test --config=playwright.config.ts \
 *       tests/e2e/browser/design-capture-editor-preview.spec.ts
 *
 * Everything goes in through the Tauri shim and the real compile worker, so
 * every block is drawn by the real compiler, store and route. A failed compile
 * is the one thing the worker will not do on request, so for those shots the
 * page answers the worker's own `compile_error` message in its place. Each
 * shot checks that the state it names is on screen before it writes, and
 * throws rather than write a picture of something else.
 */
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { installTauriShim, type ShimScriptSeed } from './fixtures/tauri-shim';
import { collection, row } from './fixtures/library';

const OUT = process.env['DESIGN_CAPTURE_DIR'];

test.skip(!OUT, 'design capture harness: set DESIGN_CAPTURE_DIR to run it');
test.describe.configure({ timeout: 90_000 });
test.use({ deviceScaleFactor: 2 });

const WINDOW = { width: 1240, height: 820 };
/** The declared minimum window, where the preview is narrowest. */
const SMALLEST_WINDOW = { width: 980, height: 680 };
/** Tall enough that the whole of the rich script is on screen at once. */
const TALL_WINDOW = { width: 1240, height: 3000 };

const id = (n: number) =>
  `e11e${String(n).padStart(4, '0')}-e11e-4e1e-8e1e-e11ee11e${String(n).padStart(4, '0')}`;

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

/** Every kind of block the compiler can produce, in one script. */
const RICH = `# Spring launch briefing

[Take: Opening]

Good morning. This is the **launch briefing** for the spring release, and it should take about four minutes to read.

[Cue: look at the lens] We spent the quarter on one question: why do people stop halfway through a take? [Beat] The answer was not the one we expected.

## What changed

- Following now waits when you pause, instead of guessing.
  - Even in the middle of a sentence.
- A retake picks up from the sentence you restarted.
- The prompter remembers which panel it belongs on.

1. Open the script.
2. Press Present.
3. Read.

- [x] Record the intro
- [ ] Record the demo

> People do not read a teleprompter. They talk to it, and it has to keep up.

:::silent
Cut to the screen recording here. Hold on the dashboard for three seconds.
:::

:::stage
Key result: **42% faster** to a usable take
:::

| Plan | Price | Takes |
| --- | ---: | ---: |
| Free | $0 | Unlimited |
| Studio | $12 | Unlimited |

![Revenue by month](assets/revenue.png)

![Old screenshot](assets/gone.png)

![Remote chart](https://example.com/chart.png)

---

[Take: Demo]

### The demo

The CandidCue{say="Candid Cue"} window has \`three\` parts, and you should read [the guide](https://example.com/guide) before you start. [Pause]

\`\`\`js
console.log("hello");
\`\`\`

\`\`\`mermaid
graph LR
  Idea --> Script
\`\`\`

[Take:]

## Wrapping up

That is the whole briefing. Thanks for listening, and see you at the launch. [Breathe]
`;

/** A chart-shaped picture, so the figure reads as a real one. */
const CHART_SVG = (() => {
  const bars = [38, 52, 47, 66, 71, 88]
    .map(
      (h, i) =>
        `<rect x="${90 + i * 170}" y="${520 - h * 5}" width="110" height="${h * 5}" rx="6" fill="#b35a38" opacity="${0.55 + i * 0.08}"/>`,
    )
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600" viewBox="0 0 1200 600"><line x1="60" y1="520" x2="1140" y2="520" stroke="#c7c1b6" stroke-width="2"/>${bars}<text x="60" y="70" font-family="Helvetica, Arial, sans-serif" font-size="34" fill="#2a2b30">Revenue by month</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
})();

const LIBRARY: ShimScriptSeed[] = [
  { id: id(1), title: 'Sample: read this aloud', source: SAMPLE },
  { id: id(2), title: 'Spring launch briefing', source: RICH },
  { id: id(3), title: 'Untitled script', source: '' },
  { id: id(4), title: 'Just a title', source: '# Quarterly all-hands\n' },
];

const ENGINE_READY = {
  available: true,
  loaded: true,
  model: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05',
};

type Layout = 'edit' | 'split' | 'preview';

interface Boot {
  viewport?: { width: number; height: number };
  layout?: Layout;
  /**
   * Answer every compile with this `compile_error` message instead of a
   * result — the worker protocol's own failure, delivered where the worker
   * would deliver it.
   */
  compileError?: string;
  /** Fire the worker's `error` event instead, as a worker that died does. */
  workerCrash?: boolean;
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

async function failCompiles(page: Page, failure: { message?: string; crash?: boolean }): Promise<void> {
  await page.addInitScript((f) => {
    const RealWorker = window.Worker;
    window.Worker = class extends RealWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (!String(url).includes('compiler')) return;
        this.postMessage = (message: { type?: string; requestId?: number; editorRevision?: number }) => {
          if (message?.type !== 'compile') return;
          setTimeout(() => {
            if (f.crash) {
              this.onerror?.(new ErrorEvent('error', { message: 'worker died' }));
              return;
            }
            this.dispatchEvent(
              new MessageEvent('message', {
                data: {
                  type: 'compile_error',
                  requestId: message.requestId,
                  editorRevision: message.editorRevision,
                  message: f.message,
                },
              }),
            );
          }, 0);
        };
      }
    } as typeof Worker;
  }, failure);
}

async function boot(page: Page, opts: Boot = {}): Promise<void> {
  await pretendMac(page);
  await page.setViewportSize(opts.viewport ?? WINDOW);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  if (opts.layout) {
    await page.addInitScript((layout) => {
      localStorage.setItem('candidcue.workspace.v1', JSON.stringify({ editorLayout: layout }));
    }, opts.layout);
  }
  if (opts.compileError !== undefined || opts.workerCrash) {
    await failCompiles(page, { message: opts.compileError, crash: opts.workerCrash });
  }
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: LIBRARY,
    engineStatus: ENGINE_READY,
    promptMode: 'voice',
    assetUrls: { 'assets/revenue.png': CHART_SVG },
  });
  await page.goto('/control.html');
  await expect(collection(page).getByRole('option')).toHaveCount(LIBRARY.length);
}

async function openScript(page: Page, title: string): Promise<void> {
  await row(page, title).dblclick();
  await expect(page.getByRole('textbox', { name: 'Script Markdown', includeHidden: true })).toBeAttached();
  await expect(page.locator('.opening')).toHaveCount(0);
}

function modeRadio(page: Page, name: 'Edit' | 'Both' | 'Preview') {
  return page.getByRole('radiogroup', { name: 'Editor mode' }).getByRole('radio', { name });
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
    await Promise.all([...document.images].map((img) => img.decode().catch(() => undefined)));
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

async function shoot(
  page: Page,
  name: string,
  clip?: { x: number; y: number; width: number; height: number },
): Promise<void> {
  if (!OUT) throw new Error('DESIGN_CAPTURE_DIR must be set');
  fs.mkdirSync(OUT, { recursive: true });
  await settle(page);
  const file = path.join(OUT, `preview--${name}.png`);
  await page.screenshot({ path: file, clip });
  const size = fs.statSync(file).size;
  if (size < 4_000) throw new Error(`${name}.png is ${size} bytes — not a real capture`);
}

/** The preview pane's box, for a capture of the pane alone. */
async function previewClip(page: Page) {
  const box = await page.locator('.preview').boundingBox();
  if (!box) throw new Error('the preview pane is not on screen');
  return box;
}

test('01 preview, the sample script', async ({ page }) => {
  await boot(page, { layout: 'preview' });
  await openScript(page, 'Sample: read this aloud');
  await expect(modeRadio(page, 'Preview')).toBeChecked();
  await expect(page.locator('.preview')).toContainText('Read this part out loud');
  await parkPointer(page);
  await shoot(page, '01-sample');
});

test('02 preview, every kind of block, whole document', async ({ page }) => {
  await boot(page, { layout: 'preview', viewport: TALL_WINDOW });
  await openScript(page, 'Spring launch briefing');
  const preview = page.locator('.preview');
  await expect(preview).toContainText('Thanks for listening');
  await expect(preview.getByRole('img', { name: 'Revenue by month' })).toBeVisible();
  await expect(preview.locator('[data-image-state="missing"]')).toBeVisible();
  await parkPointer(page);
  await shoot(page, '02-rich-full');
});

test('03 preview, the rich script at the window height', async ({ page }) => {
  await boot(page, { layout: 'preview' });
  await openScript(page, 'Spring launch briefing');
  await expect(page.locator('.preview')).toContainText('launch briefing');
  await parkPointer(page);
  await shoot(page, '03-rich-top');
});

test('04 preview, pointer over a paragraph', async ({ page }) => {
  await boot(page, { layout: 'preview' });
  await openScript(page, 'Sample: read this aloud');
  const block = page.locator('.preview .block.kind-paragraph').nth(1);
  await block.hover();
  await expect
    .poll(() => block.evaluate((el) => getComputedStyle(el).backgroundColor))
    .not.toBe('rgba(0, 0, 0, 0)');
  await shoot(page, '04-hover', await previewClip(page));
});

test('05 preview, keyboard focus on a block', async ({ page }) => {
  await boot(page, { layout: 'preview' });
  await openScript(page, 'Sample: read this aloud');
  // The keyboard reaches each block through the edit button inside it.
  const edits = page.locator('.preview .block .edit');
  await edits.nth(1).focus();
  await page.keyboard.press('Tab');
  await expect(edits.nth(2)).toBeFocused();
  await parkPointer(page);
  await shoot(page, '05-focus', await previewClip(page));
});

test('06 preview, where a click on a paragraph lands', async ({ page }) => {
  await boot(page, { layout: 'preview' });
  await openScript(page, 'Sample: read this aloud');
  await page.locator('.preview .block.kind-paragraph').filter({ hasText: 'Now try slowing right down' }).click();
  await expect(modeRadio(page, 'Edit')).toBeChecked();
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeFocused();
  await parkPointer(page);
  await shoot(page, '06-click-lands');
});

test('07 both, the rich script', async ({ page }) => {
  await boot(page, { layout: 'split' });
  await openScript(page, 'Spring launch briefing');
  await expect(modeRadio(page, 'Both')).toBeChecked();
  await expect(page.locator('.preview')).toContainText('launch briefing');
  await parkPointer(page);
  await shoot(page, '07-both-rich');
});

test('08 both, where a click on a lower block lands', async ({ page }) => {
  await boot(page, { layout: 'split' });
  await openScript(page, 'Sample: read this aloud');
  const target = page.locator('.preview .block.kind-paragraph').filter({ hasText: "That's the tour" });
  await target.scrollIntoViewIfNeeded();
  await target.click();
  await expect(modeRadio(page, 'Both')).toBeChecked();
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeFocused();
  await parkPointer(page);
  await shoot(page, '08-both-click-lands');
});

test('09 preview, a blank script', async ({ page }) => {
  await boot(page, { layout: 'preview' });
  await openScript(page, 'Untitled script');
  await expect(page.locator('.preview')).toContainText('Nothing to preview yet');
  await parkPointer(page);
  await shoot(page, '09-empty');
});

test('10 preview, a title and nothing else', async ({ page }) => {
  await boot(page, { layout: 'preview' });
  await openScript(page, 'Just a title');
  await expect(page.locator('.preview')).toContainText('Quarterly all-hands');
  await parkPointer(page);
  await shoot(page, '10-title-only');
});

test('11 preview, a compile that failed', async ({ page }) => {
  await boot(page, { layout: 'preview', compileError: 'Maximum call stack size exceeded' });
  await openScript(page, 'Spring launch briefing');
  await expect(page.locator('.preview')).toContainText('This script could not be rendered');
  await parkPointer(page);
  await shoot(page, '11-failed');
});

test('12 both, a compile that failed', async ({ page }) => {
  await boot(page, { layout: 'split', compileError: 'Maximum call stack size exceeded' });
  await openScript(page, 'Spring launch briefing');
  await expect(page.locator('.preview')).toContainText('This script could not be rendered');
  await parkPointer(page);
  await shoot(page, '12-both-failed');
});

test('13 preview, the compiler stopped', async ({ page }) => {
  await boot(page, { layout: 'preview', workerCrash: true });
  await openScript(page, 'Sample: read this aloud');
  await expect(page.locator('.preview')).toContainText('This script could not be rendered');
  await parkPointer(page);
  await shoot(page, '13-worker-stopped');
});

test('14 preview, the smallest window', async ({ page }) => {
  await boot(page, { layout: 'preview', viewport: SMALLEST_WINDOW });
  await openScript(page, 'Spring launch briefing');
  await expect(page.locator('.preview')).toContainText('launch briefing');
  await parkPointer(page);
  await shoot(page, '14-smallest-window');
});
