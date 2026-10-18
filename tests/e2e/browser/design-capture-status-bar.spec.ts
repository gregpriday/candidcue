/**
 * Screenshots of the document status bar, for a design review of that band on
 * its own: every state the editor and the Library put into it, at the default
 * window and at the narrowest one the app allows. Opt-in: it skips unless
 * DESIGN_CAPTURE_DIR names a directory to write into, so the normal suite never
 * runs it.
 *
 *     DESIGN_CAPTURE_DIR=/tmp/shots CANDIDCUE_E2E_PORT=5300 \
 *       ./node_modules/.bin/playwright test --config=playwright.config.ts \
 *       tests/e2e/browser/design-capture-status-bar.spec.ts
 *
 * Each state writes two files: the whole window, and a strip of the band with
 * the bottom of the pane above it, which is what the band actually looks like
 * at the size it is read. Everything goes in through the Tauri shim and the
 * real compiler worker, so the band is drawn by the real stores; the compile
 * states that are hard to reach by typing (a compile still in flight, a worker
 * that died) come from holding or failing that worker's messages, not from a
 * fake result. Each shot checks the state it names is on screen first and
 * throws rather than write a picture of something else.
 */
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { installTauriShim, type ShimScriptSeed } from './fixtures/tauri-shim';
import { collection, row, selectScript } from './fixtures/library';

const OUT = process.env['DESIGN_CAPTURE_DIR'];

test.skip(!OUT, 'design capture harness: set DESIGN_CAPTURE_DIR to run it');
test.describe.configure({ timeout: 90_000 });
test.use({ deviceScaleFactor: 2 });

const WINDOW = { width: 1240, height: 820 };
/* `minWidth` in tauri.conf.json: the narrowest the control window can be. */
const NARROW = { width: 980, height: 680 };

const id = (n: number) =>
  `5ba50000-5ba5-4a5a-8a5a-5ba55ba5${String(n).padStart(4, '0')}`;

const SAMPLE = `# Cold open

Every tool wants you to run more AI agents. That's fine, but running more agents was never the hard part. The hard part is managing your attention, because that's the thing that actually runs out.

So this week I rebuilt the overview around exactly three questions: is anything asking me for something, is anything stuck, and is anything finished and waiting.

[Cue: cut to the screen recording]

# The overview

Here's what it looks like with twenty agents running. Nothing in this list is decoration, and every row earns its place by answering one of those three questions.

[Cue: zoom on the first row]

## Asking

The top band is anything waiting on me. A question, a permission, a review. If it's empty, I can ignore the whole screen.

[Beat]

## Stuck

The middle band is anything that hasn't moved in a while. Not failed, just quiet. That's usually the one that costs me an afternoon.

[Cue: hold on the stuck row for a second]
`;

/* Two non-blocking notes: an unknown directive and raw HTML. */
const WITH_NOTES = `# Launch keynote

:::aside
Remember to slow down here.
:::

This is how I am working now. There are five coding agents running on my machine, across a few different projects, and at any moment I know exactly which one of them needs me.

<div>Pause for the slide.</div>

That is the whole pitch, and the rest of this talk is how it works.
`;

/* One blocking error (a malformed spoken block) plus two notes. */
const WITH_ISSUES = `# Investor update

Thank you for joining me today. Here is what changed this quarter, and why it matters for the next one.

:::spoken
visual: Q3 ARR
:::

:::aside
Numbers slide goes here.
:::

![Revenue chart](https://example.com/revenue.png)

Revenue grew faster than headcount for the third quarter running, and that is the number I want you to remember.
`;

/* A script at the far end of realistic: five figures of words, dozens of cues. */
const LONG = (() => {
  const paragraph =
    'The part of this that nobody tells you is how much of the work is waiting, and how little of it is typing. You spend the day reading what something else wrote, deciding whether it is right, and sending it back with a sentence of direction. ';
  const sections: string[] = ['# The long version'];
  for (let s = 1; s <= 28; s++) {
    sections.push(`## Part ${s}`);
    for (let p = 0; p < 10; p++) sections.push(paragraph.repeat(2).trim());
    sections.push(`[Cue: change camera for part ${s}]`);
  }
  return `${sections.join('\n\n')}\n`;
})();

const LONG_TITLE =
  'Quarterly all-hands: what we shipped, what we learned, and what we are betting the next two quarters on';

const LIBRARY: ShimScriptSeed[] = [
  { id: id(1), title: 'Agent overview', source: SAMPLE },
  { id: id(2), title: 'Launch keynote', source: WITH_NOTES },
  { id: id(3), title: 'Investor update', source: WITH_ISSUES },
  { id: id(4), title: 'Untitled script', source: '' },
  { id: id(5), title: 'The long version', source: LONG },
  { id: id(6), title: LONG_TITLE, source: SAMPLE },
];

interface Boot {
  viewport?: { width: number; height: number };
  workspace?: Record<string, unknown>;
  /** Hold the compiler worker's replies from the start. */
  holdCompile?: boolean;
  /** Fail every compile, as a worker that died would. */
  failCompile?: boolean;
}

/**
 * Hooks on the compiler worker, installed before any app code runs.
 *
 * `hold` queues the worker's replies until `release()`, which is a compile in
 * flight for as long as the capture needs it. `fail` answers every request with
 * the worker's error event, which is what a worker that crashed sends — the
 * service turns it into a rejected compile exactly as it would in the app.
 */
async function installCompilerHooks(page: Page, opts: Boot): Promise<void> {
  await page.addInitScript(
    ({ hold, fail }) => {
      const hooks = {
        hold,
        fail,
        queue: [] as Array<() => void>,
        release() {
          hooks.hold = false;
          for (const deliver of hooks.queue.splice(0)) deliver();
        },
      };
      (window as unknown as { __compilerHooks: typeof hooks }).__compilerHooks = hooks;
      const Real = window.Worker;
      class HookedWorker extends Real {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          if (!String(url).includes('compiler.worker')) return;
          const addListener = this.addEventListener.bind(this);
          this.addEventListener = ((type: string, listener: EventListener, o?: unknown) => {
            if (type !== 'message') return addListener(type, listener, o as AddEventListenerOptions);
            return addListener(
              'message',
              (event: Event) => {
                if (hooks.hold) hooks.queue.push(() => listener(event));
                else listener(event);
              },
              o as AddEventListenerOptions,
            );
          }) as Worker['addEventListener'];
          const post = this.postMessage.bind(this);
          this.postMessage = ((message: unknown, transfer?: Transferable[]) => {
            if (hooks.fail) {
              setTimeout(() => this.onerror?.(new ErrorEvent('error', { message: 'worker crashed' })));
              return;
            }
            post(message, transfer ?? []);
          }) as Worker['postMessage'];
        }
      }
      window.Worker = HookedWorker as typeof Worker;
    },
    { hold: opts.holdCompile ?? false, fail: opts.failCompile ?? false },
  );
}

async function boot(page: Page, opts: Boot = {}): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' });
  });
  if (opts.workspace) {
    await page.addInitScript((workspace) => {
      localStorage.setItem('candidcue.workspace.v1', JSON.stringify(workspace));
    }, opts.workspace);
  }
  await installCompilerHooks(page, opts);
  await page.setViewportSize(opts.viewport ?? WINDOW);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: LIBRARY,
    engineStatus: {
      available: true,
      loaded: true,
      model: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05',
    },
    promptMode: 'voice',
  });
  await page.goto('/control.html');
  await expect(collection(page).getByRole('option')).toHaveCount(LIBRARY.length);
}

function bar(page: Page) {
  return page.locator('footer.statusbar');
}

async function openScript(page: Page, title: string): Promise<void> {
  await row(page, title).dblclick();
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeVisible({ timeout: 10_000 });
}

/** Type at the end of the document, which is what starts a save and a compile. */
async function typeAtEnd(page: Page, text: string): Promise<void> {
  await page.locator('.cm-content').click();
  await page.keyboard.press('Meta+ArrowDown');
  await page.keyboard.type(text);
}

async function parkPointer(page: Page): Promise<void> {
  const size = page.viewportSize();
  await page.mouse.move((size?.width ?? 1240) / 2, 60);
}

async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(150);
  await page.evaluate(async () => {
    await document.fonts.ready;
    const finite = document
      .getAnimations()
      .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.race([
      Promise.all(finite.map((a) => a.finished.catch(() => undefined))),
      new Promise((r) => setTimeout(r, 1_000)),
    ]);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}

/**
 * Write the window and the band, after checking the band says `expected`.
 *
 * The check runs AFTER the settle, so a state that changed while the page came
 * to rest (a "Saved" that timed out, a compile that landed) fails loudly rather
 * than being captured as the state it no longer is.
 */
async function shoot(page: Page, name: string, expected: Array<string | RegExp>): Promise<void> {
  if (!OUT) throw new Error('DESIGN_CAPTURE_DIR must be set');
  fs.mkdirSync(OUT, { recursive: true });
  await settle(page);
  for (const text of expected) await expect(bar(page)).toContainText(text, { timeout: 1_000 });
  const box = await bar(page).boundingBox();
  if (!box) throw new Error(`${name}: the status bar is not on screen`);
  const size = page.viewportSize()!;
  const window = path.join(OUT, `status-bar--${name}.png`);
  const strip = path.join(OUT, `status-bar--${name}--band.png`);
  const lead = 44;
  await page.screenshot({ path: window });
  await page.screenshot({
    path: strip,
    clip: { x: 0, y: box.y - lead, width: size.width, height: box.height + lead },
  });
  for (const file of [window, strip]) {
    const bytes = fs.statSync(file).size;
    if (bytes < 2_000) throw new Error(`${path.basename(file)} is ${bytes} bytes — not a real capture`);
  }
}

test('01 editor, at rest', async ({ page }) => {
  await boot(page);
  await openScript(page, 'Agent overview');
  await parkPointer(page);
  await shoot(page, '01-editor-rest', [/\d+ words/, /cues/]);
});

test('02 editor, saving', async ({ page }) => {
  await boot(page);
  await openScript(page, 'Agent overview');
  await page.evaluate(() => window.__E2E__.setHeld('save_script', true));
  await typeAtEnd(page, '\nOne more line for the end.');
  await expect(bar(page)).toContainText('Saving…', { timeout: 5_000 });
  await parkPointer(page);
  await shoot(page, '02-editor-saving', ['Saving…']);
});

test('03 editor, saved', async ({ page }) => {
  await boot(page);
  await openScript(page, 'Agent overview');
  await page.evaluate(() => window.__E2E__.setHeld('save_script', true));
  await typeAtEnd(page, '\nOne more line for the end.');
  await expect(bar(page)).toContainText('Saving…', { timeout: 5_000 });
  await parkPointer(page);
  await page.evaluate(() => window.__E2E__.setHeld('save_script', false));
  await expect(bar(page)).toContainText('Saved', { timeout: 2_000 });
  await shoot(page, '03-editor-saved', ['Saved']);
});

test('04 editor, compiler notes', async ({ page }) => {
  await boot(page);
  await openScript(page, 'Launch keynote');
  await parkPointer(page);
  await shoot(page, '04-editor-notes', [/notes?/]);
});

test('05 editor, a blocking issue, outline closed', async ({ page }) => {
  await boot(page, { workspace: { outlineVisible: false } });
  await openScript(page, 'Investor update');
  await parkPointer(page);
  await shoot(page, '05-editor-issues-outline-closed', [/errors?/, /notes?/]);
});

test('06 editor, pointer over the issue count', async ({ page }) => {
  await boot(page, { workspace: { outlineVisible: false } });
  await openScript(page, 'Investor update');
  await bar(page).getByRole('button').first().hover();
  await shoot(page, '06-editor-issues-hover', [/errors?/, /notes?/]);
});

test('07 editor, keyboard focus on the issue count', async ({ page }) => {
  await boot(page);
  await openScript(page, 'Investor update');
  const button = bar(page).getByRole('button').first();
  await page.keyboard.press('Shift');
  await button.focus();
  await expect(button).toBeFocused();
  await parkPointer(page);
  await shoot(page, '07-editor-issues-focus', [/errors?/, /notes?/]);
});

test('08 editor, compile failed', async ({ page }) => {
  await boot(page, { failCompile: true });
  await openScript(page, 'Agent overview');
  await parkPointer(page);
  await shoot(page, '08-editor-compile-failed', ['Could not render']);
});

test('09 editor, first compile still in flight', async ({ page }) => {
  await boot(page, { holdCompile: true });
  await row(page, 'Agent overview').dblclick();
  // The opening cover gives up waiting after two seconds and shows the editor.
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeVisible({ timeout: 10_000 });
  await parkPointer(page);
  await shoot(page, '09-editor-first-compile', ['Reading the script…']);
});

test('10 editor, recompiling after an edit', async ({ page }) => {
  await boot(page);
  await openScript(page, 'Agent overview');
  await expect(bar(page)).toContainText(/\d+ words/);
  await page.evaluate(() => {
    (window as unknown as { __compilerHooks: { hold: boolean } }).__compilerHooks.hold = true;
  });
  await typeAtEnd(page, ' And one more.');
  await page.waitForTimeout(400);
  await parkPointer(page);
  await shoot(page, '10-editor-recompiling', [/\d+ words/]);
});

test('11 editor, a blank script', async ({ page }) => {
  await boot(page);
  await openScript(page, 'Untitled script');
  await parkPointer(page);
  await shoot(page, '11-editor-blank', ['0 words']);
});

test('12 editor, larger text, saving', async ({ page }) => {
  await boot(page, { workspace: { documentScale: 1.25 } });
  await openScript(page, 'Agent overview');
  await page.evaluate(() => window.__E2E__.setHeld('save_script', true));
  await typeAtEnd(page, '\nOne more line for the end.');
  await expect(bar(page)).toContainText('Saving…', { timeout: 5_000 });
  await parkPointer(page);
  await shoot(page, '12-editor-scale-saving', ['125%', 'Saving…']);
});

test('13 editor, a very long script', async ({ page }) => {
  await boot(page);
  await openScript(page, 'The long version');
  await parkPointer(page);
  await shoot(page, '13-editor-long', [/\d{2},\d{3} words/]);
});

test('14 editor, narrowest window, issues, larger text, saving', async ({ page }) => {
  await boot(page, { viewport: NARROW, workspace: { documentScale: 1.25 } });
  await openScript(page, 'Investor update');
  await page.evaluate(() => window.__E2E__.setHeld('save_script', true));
  await typeAtEnd(page, '\nOne more line.');
  await expect(bar(page)).toContainText('Saving…', { timeout: 5_000 });
  await parkPointer(page);
  await shoot(page, '14-narrow-issues-scale-saving', [/errors?/, /notes?/]);
});

test('15 editor, narrowest window, compile failed, larger text', async ({ page }) => {
  await boot(page, { viewport: NARROW, failCompile: true, workspace: { documentScale: 1.25 } });
  await openScript(page, 'Agent overview');
  await parkPointer(page);
  await shoot(page, '15-narrow-compile-failed', ['Could not render']);
});

test('16 editor, narrowest window, long script, notes', async ({ page }) => {
  await boot(page, { viewport: NARROW });
  await openScript(page, 'The long version');
  await parkPointer(page);
  await shoot(page, '16-narrow-long', [/words/]);
});

test('17 library, at rest', async ({ page }) => {
  await boot(page);
  await parkPointer(page);
  await shoot(page, '17-library-rest', ['scripts']);
});

test('18 library, filtered, a long title selected', async ({ page }) => {
  await boot(page);
  await page.getByPlaceholder('Search scripts').fill('the');
  await expect(bar(page)).toContainText('Filtered by');
  await selectScript(page, /Quarterly all-hands/);
  await parkPointer(page);
  await shoot(page, '18-library-filtered-selected', ['Filtered by', 'Quarterly']);
});

test('19 library, narrowest window, filtered, a long title selected', async ({ page }) => {
  await boot(page, { viewport: NARROW });
  await page.getByPlaceholder('Search scripts').fill('what we shipped, what we learned');
  await expect(bar(page)).toContainText('Filtered by');
  await selectScript(page, /Quarterly all-hands/);
  await parkPointer(page);
  await shoot(page, '19-narrow-library-filtered-selected', ['Filtered by']);
});

test('20 editor, after clicking the diagnostic summary', async ({ page }) => {
  await boot(page);
  await openScript(page, 'Investor update');
  await page.keyboard.press('Shift');
  const button = bar(page).getByRole('button').first();
  await button.focus();
  await page.keyboard.press('Enter');
  // The keyboard lands on the first error in the outline, not back in the bar.
  await expect(page.locator('aside[aria-label="Outline"] .diagnostics .error button')).toBeFocused();
  await parkPointer(page);
  await shoot(page, '20-editor-diagnostics-shown', [/errors?/]);
});

test('21 editor, the diagnostic summary pressed while a recompile is in flight', async ({ page }) => {
  await boot(page);
  await openScript(page, 'Investor update');
  await page.evaluate(() => {
    (window as unknown as { __compilerHooks: { hold: boolean } }).__compilerHooks.hold = true;
  });
  await typeAtEnd(page, ' And one more.');
  await expect(page.locator('aside[aria-label="Outline"] .panel-foot')).toContainText('Reading the script…');
  await page.keyboard.press('Shift');
  const button = bar(page).getByRole('button').first();
  await button.focus();
  await page.keyboard.press('Enter');
  await page.evaluate(() => {
    (window as unknown as { __compilerHooks: { release: () => void } }).__compilerHooks.release();
  });
  // The request waits for the list to come back rather than finding nothing.
  await expect(page.locator('aside[aria-label="Outline"] .diagnostics .error button')).toBeFocused();
  await parkPointer(page);
  await shoot(page, '21-editor-diagnostics-after-recompile', [/errors?/]);
});
