/**
 * Screenshots of the Reading notes panel in the editor's outline rail, for a
 * design review of that one surface: collapsed and open, a row under the
 * pointer and under the keyboard, the editor after a note is followed to its
 * text, the rail at its narrowest and widest, a short window, a script with a
 * single note and one with a wall of them. Opt-in: it skips unless
 * DESIGN_CAPTURE_DIR names a directory to write into, so the normal suite never
 * runs it.
 *
 *     DESIGN_CAPTURE_DIR=/tmp/shots CANDIDCUE_E2E_PORT=5300 \
 *       ./node_modules/.bin/playwright test --config=playwright.config.ts \
 *       tests/e2e/browser/design-capture-reading-notes.spec.ts
 *
 * The scripts go in through the Tauri shim and the notes come out of the real
 * lint on the real compile cadence, so nothing here is staged at the UI. Each
 * shot checks that the state it names is on screen before it writes, and
 * throws rather than write a picture of something else.
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
/* The smallest window the app allows (tauri.conf.json). */
const SMALL_WINDOW = { width: 980, height: 680 };

const id = (n: number) =>
  `b22b${String(n).padStart(4, '0')}-b22b-4b2b-8b2b-b22bb22b${String(n).padStart(4, '0')}`;

/*
 * A launch video written the way people actually write one: mostly fine, with
 * a dozen places that will read badly out loud. Every rule fires at least
 * twice, the long-paragraph rule fires at both severities, and two rules land
 * on the same paragraph more than once.
 */
const LAUNCH = `# Launch video

## Cold open

Every tool now promises to save you time, and most of them quietly hand that time back to you as another inbox. We spent the last year building the opposite of that.

So this is the video where we show you what changed, why it changed, and what it means for the way your team works every single day starting this Monday morning when the update lands on every desk and every laptop in the company without anyone needing to install anything at all

[Cue: cut to the product]

## What it does

Here is the short version. You write the script the way you would say it, you press Present, and the text follows your voice. It does not race ahead of you when you pause, and it does not lose you when you go off script for a moment to tell a story or answer a question from the room. When you come back to the words, it finds you again, usually within a sentence, and it does that without a cloud service, without an account, and without sending a single second of your audio anywhere. All of it runs on the machine in front of you, which is also why it keeps working on a plane.

THIS PART MATTERS MORE THAN ANYTHING ELSE we say today.

## How it feels

The first time you use it you will probably read too fast

That is normal. Slow down, breathe, and let the words come to you rather than chasing them down the screen.

## Under the hood

The recogniser is a small streaming model that listens in half-second steps. Each step it hands over the words it thinks it heard, and a separate engine, which never guesses, decides where in your script those words belong. It looks nearby first, because that is where you almost always are. If nothing nearby fits, it widens the search, but only across the part of the script that is already on the screen, so it can never jump somewhere you cannot see. When you skip a paragraph, it waits for two or three words in a row that only make sense in the new place before it moves, and when you stumble and start a sentence again it follows you back without fuss and without losing the line you were on, which is the part that took us the longest by a very wide margin and the part we are proudest of. None of that needs a network. None of it needs an account. It is the same engine we test every night against hours of real recorded takes.

## Pricing

It is free. It is open source, it is MIT licensed, and there is no paid tier hiding behind the free one

## For teams

- One library per person
- Shared rigs and displays
- Scripts that open the same on every machine

## Wrapping up

So that is the tour, and if you take one thing away from it let it be that the hardest part of reading to a camera was never the reading itself but the constant low-level worry that the words will run away from you at exactly the moment you look up to make a point to the people on the other side of the lens.

PLEASE DO NOT SKIP THE SETUP STEP before your first real recording

Thanks for watching
`;

/* A shot list typed as prose: every line its own paragraph, none with a stop. */
const SHOT_LIST = [
  '# Shot list',
  '',
  '## Morning',
  '',
  ...[
    'Wide shot of the office at dawn',
    'Coffee machine close up',
    'Door opens and the first person walks in',
    'Laptop lid lifts',
    'Over the shoulder on the editor',
    'Hands typing the opening line',
    'Cut to the camera rig',
    'Talent sits down and adjusts the chair',
    'Close on the prompter glass',
    'Talent reads the first sentence',
  ].flatMap((line) => [line, '']),
  '## Afternoon',
  '',
  ...[
    'Wide of the meeting room',
    'Whiteboard with the plan on it',
    'Two people arguing about a slide',
    'Someone laughs off camera',
    'Rack focus to the window',
    'Rain on the glass',
    'Back to the rig for the second take',
    'Talent fluffs a line and starts again',
    'The text follows them back',
    'Thumbs up from behind the camera',
  ].flatMap((line) => [line, '']),
  '## Evening',
  '',
  ...[
    'Lights go down in the office',
    'Last laptop closes',
    'Empty chairs',
    'Street outside in the blue hour',
    'Logo on black',
  ].flatMap((line) => [line, '']),
  'And then the usual end card, which needs the address, the date, the time, the speakers, the sponsors, the hashtag, the thank-yous to the crew and the venue, and the line about where to find the recording afterwards for anybody who could not make it on the night itself.',
  '',
].join('\n');

const SINGLE = `# Quarterly update

## Opening

Thank you for joining me today. Here is what changed this quarter, and why it matters for the next one.

## Numbers

Revenue grew in every region this quarter, and for the first time the growth came from customers we already had rather than from new ones, which is the shape we have been working towards for two years. Retention is up, support tickets per customer are down, and the time it takes a new team to get their first script on the glass has fallen from a week to an afternoon. That last number is the one I am proudest of, and we will go through each of them in turn.

## Closing

Thanks, everyone. Questions in the channel as usual.
`;

const LIBRARY: ShimScriptSeed[] = [
  { id: id(1), title: 'Launch video', source: LAUNCH },
  { id: id(2), title: 'Shot list', source: SHOT_LIST },
  { id: id(3), title: 'Quarterly update', source: SINGLE },
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
    Object.defineProperty(Navigator.prototype, 'userAgentData', {
      get: () => ({ platform: 'macOS', brands: [], mobile: false }),
    });
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
    seedScripts: LIBRARY,
    engineStatus: ENGINE_READY,
    promptMode: 'voice',
  });
  await page.goto('/control.html');
  await expect(collection(page).getByRole('option')).toHaveCount(LIBRARY.length);
}

async function openScript(page: Page, title: string): Promise<void> {
  await row(page, title).dblclick();
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeVisible();
}

function notes(page: Page): Locator {
  return page.getByRole('region', { name: 'Reading notes' });
}

/** The rows a note can be followed from — whatever shape the panel takes. */
function noteRows(page: Page): Locator {
  return notes(page).locator('[data-note], .finding');
}

/** Wait for the lint to settle on the open script, then open the panel. */
async function openNotes(page: Page, atLeast: number): Promise<void> {
  await expect(notes(page)).toBeVisible();
  const toggle = notes(page).locator('summary, [aria-expanded]').first();
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    const details = notes(page).locator('details').first();
    const open = (await details.count()) > 0 ? await details.evaluate((d) => (d as HTMLDetailsElement).open) : false;
    if (!open) await toggle.click();
  }
  await expect.poll(() => noteRows(page).count()).toBeGreaterThanOrEqual(atLeast);
  await expect(notes(page).locator('details').first()).toHaveJSProperty('open', true);
}

/**
 * Make a row visible: if it sits inside a closed group, open that group the
 * way a person would, by its heading.
 */
async function reveal(row: Locator): Promise<Locator> {
  if (!(await row.isVisible())) {
    await row.locator('xpath=ancestor::details[1]/summary').click();
  }
  await expect(row).toBeVisible();
  return row;
}

/** Open every closed group in the panel. */
async function openEveryGroup(page: Page): Promise<void> {
  const inner = notes(page).locator('details details');
  for (let i = 0; i < (await inner.count()); i++) {
    const group = inner.nth(i);
    if (!(await group.evaluate((d) => (d as HTMLDetailsElement).open))) {
      await group.locator('summary').first().click();
    }
  }
}

function sentenceAt(page: Page, line: number): Locator {
  return noteRows(page)
    .filter({ hasText: new RegExp(`line ${line}\\b`) })
    .filter({ hasText: /long sentence/i })
    .first();
}

function rail(page: Page): Locator {
  return page.getByRole('complementary', { name: 'Outline' });
}

/** Park the pointer where it hovers nothing. */
async function parkPointer(page: Page): Promise<void> {
  const size = page.viewportSize();
  await page.mouse.move((size?.width ?? 1240) - 4, (size?.height ?? 820) - 4);
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
      new Promise((r) => setTimeout(r, 2_000)),
    ]);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}

async function shoot(page: Page, name: string, target?: Locator): Promise<void> {
  if (!OUT) throw new Error('DESIGN_CAPTURE_DIR must be set');
  fs.mkdirSync(OUT, { recursive: true });
  await settle(page);
  const file = path.join(OUT, `notes--${name}.png`);
  if (target) {
    const box = await target.boundingBox();
    if (!box || box.width < 50 || box.height < 50) throw new Error(`${name}: target is not on screen`);
    await page.screenshot({ path: file, clip: box });
  } else {
    await page.screenshot({ path: file });
  }
  const size = fs.statSync(file).size;
  if (size < 4_000) throw new Error(`${name}.png is ${size} bytes — not a real capture`);
}

test('01 collapsed, in the editor', async ({ page }) => {
  await boot(page);
  await openScript(page, 'Launch video');
  await expect(notes(page)).toBeVisible();
  await parkPointer(page);
  await shoot(page, '01-collapsed');
});

test('02 open, in the editor', async ({ page }) => {
  await boot(page);
  await openScript(page, 'Launch video');
  await openNotes(page, 10);
  await parkPointer(page);
  await shoot(page, '02-open');
});

test('03 open, the rail close up', async ({ page }) => {
  await boot(page);
  await openScript(page, 'Launch video');
  await openNotes(page, 10);
  await reveal(sentenceAt(page, 25));
  await parkPointer(page);
  await shoot(page, '03-open-rail', rail(page));
});

test('04 open, scrolled to the last note', async ({ page }) => {
  await boot(page);
  await openScript(page, 'Launch video');
  await openNotes(page, 10);
  await openEveryGroup(page);
  await noteRows(page).last().scrollIntoViewIfNeeded();
  await expect(noteRows(page).last()).toBeVisible();
  await parkPointer(page);
  await shoot(page, '04-open-scrolled', rail(page));
});

test('05 a row under the pointer', async ({ page }) => {
  await boot(page);
  await openScript(page, 'Launch video');
  await openNotes(page, 10);
  await (await reveal(sentenceAt(page, 25))).hover();
  await shoot(page, '05-hover', rail(page));
});

test('06 a row under the keyboard', async ({ page }) => {
  await boot(page);
  await openScript(page, 'Launch video');
  await openNotes(page, 10);
  const row = await reveal(sentenceAt(page, 25));
  await row.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(row).toBeFocused();
  await parkPointer(page);
  await shoot(page, '06-focus', rail(page));
});

/*
 * Followed to the text. The long sentence in "Under the hood" starts in the
 * middle of a paragraph, which is the case where the caret alone says least
 * about what the note means.
 */
test('07 a long sentence followed to its text', async ({ page }) => {
  await boot(page);
  await openScript(page, 'Launch video');
  await openNotes(page, 10);
  await (await reveal(sentenceAt(page, 25))).click();
  await expect(page.locator('.cm-content')).toBeFocused();
  const line = await page.evaluate(() => {
    const node = window.getSelection()?.focusNode ?? null;
    const el = node instanceof Element ? node : node?.parentElement;
    return el?.closest('.cm-line')?.textContent ?? '';
  });
  if (!line.includes('When you skip a paragraph')) {
    throw new Error('07: the caret did not land in the flagged paragraph');
  }
  await parkPointer(page);
  await shoot(page, '07-followed-sentence');
});

test('08 a long paragraph followed to its text', async ({ page }) => {
  await boot(page);
  await openScript(page, 'Launch video');
  await openNotes(page, 10);
  const target = noteRows(page).filter({ hasText: /line 13\b/ }).filter({ hasText: /paragraph/i }).first();
  await (await reveal(target)).click();
  await expect(page.locator('.cm-content')).toBeFocused();
  await parkPointer(page);
  await shoot(page, '08-followed-paragraph');
});

test('09 the rail at its narrowest', async ({ page }) => {
  await boot(page, { workspace: { outlineWidth: 200 } });
  await openScript(page, 'Launch video');
  await openNotes(page, 10);
  await reveal(sentenceAt(page, 25));
  await expect.poll(async () => (await rail(page).boundingBox())?.width ?? 0).toBeLessThan(210);
  await parkPointer(page);
  await shoot(page, '09-narrow-rail', rail(page));
});

test('10 the rail at its widest', async ({ page }) => {
  await boot(page, { workspace: { outlineWidth: 420 } });
  await openScript(page, 'Launch video');
  await openNotes(page, 10);
  await reveal(sentenceAt(page, 25));
  await expect.poll(async () => (await rail(page).boundingBox())?.width ?? 0).toBeGreaterThan(410);
  await parkPointer(page);
  await shoot(page, '10-wide-rail', rail(page));
});

test('11 the smallest window the app allows', async ({ page }) => {
  await boot(page, { viewport: SMALL_WINDOW });
  await openScript(page, 'Launch video');
  await openNotes(page, 10);
  await reveal(sentenceAt(page, 25));
  await parkPointer(page);
  await shoot(page, '11-small-window');
});

test('12 a single note', async ({ page }) => {
  await boot(page);
  await openScript(page, 'Quarterly update');
  await openNotes(page, 1);
  await expect(noteRows(page)).toHaveCount(1);
  await expect(noteRows(page).first()).toBeVisible();
  await parkPointer(page);
  await shoot(page, '12-single', rail(page));
});

test('13 a wall of notes, collapsed', async ({ page }) => {
  await boot(page);
  await openScript(page, 'Shot list');
  await expect(notes(page)).toBeVisible();
  await parkPointer(page);
  await shoot(page, '13-wall-collapsed', rail(page));
});

test('14 a wall of notes, open', async ({ page }) => {
  await boot(page);
  await openScript(page, 'Shot list');
  await openNotes(page, 20);
  await parkPointer(page);
  await shoot(page, '14-wall-open');
});

test('15 open beside the preview', async ({ page }) => {
  await boot(page, { workspace: { editorLayout: 'split' } });
  await openScript(page, 'Launch video');
  await expect(page.getByRole('radiogroup', { name: 'Editor mode' }).getByRole('radio', { name: 'Both' })).toBeChecked();
  await openNotes(page, 10);
  await reveal(sentenceAt(page, 25));
  await parkPointer(page);
  await shoot(page, '15-beside-preview');
});

/* Back from the text with Escape: the note followed is where focus lands. */
test('16 back to the note with Escape', async ({ page }) => {
  await boot(page);
  await openScript(page, 'Launch video');
  await openNotes(page, 10);
  const row = await reveal(sentenceAt(page, 25));
  await row.click();
  await expect(page.locator('.cm-content')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(row).toBeFocused();
  await parkPointer(page);
  await shoot(page, '16-back-with-escape', rail(page));
});

test('17 a wall of notes, the big group open', async ({ page }) => {
  await boot(page);
  await openScript(page, 'Shot list');
  await openNotes(page, 20);
  await reveal(noteRows(page).filter({ hasText: /line 5\b/ }).first());
  await expect(noteRows(page).filter({ hasText: /line 7\b/ }).first()).toBeVisible();
  await parkPointer(page);
  await shoot(page, '17-wall-group-open', rail(page));
});

/* A missing full stop is about the END of a paragraph: the landing has to say so. */
test('18 a missing full stop followed to its text', async ({ page }) => {
  await boot(page);
  await openScript(page, 'Launch video');
  await openNotes(page, 10);
  const target = noteRows(page).filter({ hasText: /line 19\b/ }).first();
  await (await reveal(target)).click();
  await expect(page.locator('.cm-content')).toBeFocused();
  await expect(page.locator('.cm-lint-run')).toHaveText('fast');
  await parkPointer(page);
  await shoot(page, '18-followed-full-stop');
});

/* The reason, opened: what "Why this helps" reveals, at the default width. */
test('19 a rule with its reason open', async ({ page }) => {
  await boot(page);
  await openScript(page, 'Launch video');
  await openNotes(page, 10);
  const row = await reveal(sentenceAt(page, 25));
  await row.locator('xpath=ancestor::details[1]').getByText('Why this helps').click();
  await expect(notes(page).getByText('Sentence endings give').first()).toBeVisible();
  await parkPointer(page);
  await shoot(page, '19-reason-open', rail(page));
});

/*
 * Fixed, then back: the followed note is gone once its full stop is typed, so
 * Escape has to land on the next note of the same kind rather than on nothing.
 */
test('20 back with Escape after fixing the note', async ({ page }) => {
  await boot(page);
  await openScript(page, 'Launch video');
  await openNotes(page, 10);
  await (await reveal(noteRows(page).filter({ hasText: /line 19\b/ }).first())).click();
  await expect(page.locator('.cm-content')).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.type('.');
  await expect(noteRows(page).filter({ hasText: /line 19\b/ })).toHaveCount(0, { timeout: 10_000 });
  await page.keyboard.press('Escape');
  const next = noteRows(page).filter({ hasText: /line 29\b/ }).first();
  await expect(next).toBeFocused();
  await parkPointer(page);
  await shoot(page, '20-back-after-fix', rail(page));
});
