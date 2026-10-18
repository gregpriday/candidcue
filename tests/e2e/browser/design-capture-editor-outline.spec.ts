/**
 * Screenshots of the editor's outline rail, for a design review of the
 * navigator on its own: heading hierarchy at four levels, titles too long for
 * the rail, section lengths, where the caret is, and what the rail does when a
 * row is used to move. Opt-in: it skips unless DESIGN_CAPTURE_DIR names a
 * directory to write into, so the normal suite never runs it.
 *
 *     DESIGN_CAPTURE_DIR=/tmp/shots CANDIDCUE_E2E_PORT=5300 \
 *       ./node_modules/.bin/playwright test --config=playwright.config.ts \
 *       tests/e2e/browser/design-capture-editor-outline.spec.ts
 *
 * Everything goes in through the Tauri shim, so the rail is drawn from a real
 * compile of a real script. Each shot checks that the state it names is on
 * screen before it writes, and throws rather than write a picture of something
 * else.
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

const id = (n: number) =>
  `0e1e${String(n).padStart(4, '0')}-0e1e-4e1e-8e1e-0e1e0e1e${String(n).padStart(4, '0')}`;

/*
 * Prose for a section of roughly `words` spoken words. Real sentences rather
 * than lorem, so the editor beside the rail reads as a script and the section
 * lengths the rail reports are the ones a presenter would see.
 */
const SENTENCES = [
  'We spent most of last year listening to the people who book rooms for a living, and the same complaint came up in almost every conversation.',
  'The calendar was never the problem; the problem was everything that happened after somebody pressed the button.',
  'A booking would go through, the confirmation would arrive, and twenty minutes later the room would belong to someone else.',
  'Nobody on the team wanted to say it out loud, but the engine underneath was older than most of the people maintaining it.',
  'So we stopped patching it, and we started again from a blank page.',
  'That decision cost us four months, and I would make it again tomorrow.',
  'Here is what it looks like when it works, and then I will show you what it looks like when it does not.',
  'Watch the board on the left while I pull the network cable out of this laptop.',
  'Nothing moves, nothing is lost, and when the connection comes back the board catches up on its own.',
  'That is the whole demo, and it is the part I was most nervous about.',
  'If you take one thing away from this morning, let it be that the boring parts are finally boring.',
  'We measured it against the old engine on the same hardware, with the same load, for a full week.',
];

function prose(words: number): string {
  const out: string[] = [];
  let count = 0;
  let i = 0;
  while (count < words) {
    const sentence = SENTENCES[i % SENTENCES.length]!;
    out.push(sentence);
    count += sentence.split(/\s+/).length;
    i += 1;
  }
  // Paragraphs of three sentences, the way a script is actually broken up.
  const paragraphs: string[] = [];
  for (let p = 0; p < out.length; p += 3) paragraphs.push(out.slice(p, p + 3).join(' '));
  return paragraphs.join('\n\n');
}

/*
 * Four heading levels, two titles far too long for any rail width, a section
 * with nothing spoken under it, sections from five seconds to several minutes,
 * and enough rows to overflow the rail at the default window height.
 */
const KEYNOTE_HEADINGS: Array<[level: number, title: string, words: number]> = [
  [1, 'Cold open', 40],
  [1, 'Part one: why we rebuilt the scheduling engine from scratch instead of patching it', 30],
  [2, 'The problem nobody on the platform team wanted to say out loud', 190],
  [2, 'Three numbers', 20],
  [3, 'Latency', 60],
  [3, 'Cost per booking', 70],
  [3, 'Support tickets', 12],
  [2, 'What we tried first', 140],
  [1, 'Part two: the demo', 15],
  [2, 'Setting up the board', 90],
  [2, 'The moment it breaks', 120],
  [3, 'Recovering a dropped connection mid-demo, without restarting the stage', 80],
  [4, 'Fallback if the venue network is down', 45],
  [2, 'Questions we expect from the room', 260],
  [1, 'Customer quote (to be confirmed)', 0],
  [1, 'Wrapping up', 20],
  [2, 'Thank-yous', 45],
  [2, 'Call to action', 70],
];

const KEYNOTE = KEYNOTE_HEADINGS.map(
  ([level, title, words]) => `${'#'.repeat(level)} ${title}\n\n${words > 0 ? `${prose(words)}\n\n` : ''}`,
).join('');

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

const NO_HEADINGS =
  'Good morning, and welcome to this short teleprompter test. The goal is to check whether the text scrolls smoothly and remains easy to follow at a natural speaking pace.\n\nNothing in this script is divided into sections, so there is nothing for an outline to list.\n';

const SCRIPTS: ShimScriptSeed[] = [
  { id: id(1), title: 'Northwind launch keynote', source: KEYNOTE },
  { id: id(2), title: 'Sample: read this aloud', source: SAMPLE },
  { id: id(3), title: 'Teleprompter test', source: NO_HEADINGS },
  { id: id(4), title: 'Untitled script', source: '' },
];

const ENGINE_READY = {
  available: true,
  loaded: true,
  model: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05',
};

interface Boot {
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
  await page.setViewportSize(WINDOW);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: SCRIPTS,
    engineStatus: ENGINE_READY,
    promptMode: 'voice',
  });
  await page.goto('/control.html');
  await expect(collection(page).getByRole('option')).toHaveCount(SCRIPTS.length);
}

const rail = (page: Page): Locator => page.getByRole('complementary', { name: 'Outline' });

/** The rail's row for a heading, by the title its accessible name starts with. */
function entry(page: Page, title: string): Locator {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return rail(page).getByRole('button', { name: new RegExp(`^${escaped}`) });
}

async function open(page: Page, title: string): Promise<void> {
  await row(page, title).dblclick();
  // Attached rather than visible: in Preview the source pane is hidden.
  await expect(page.locator('.cm-content')).toBeAttached();
  await expect(rail(page)).toBeVisible();
}

/** The text of the editor line the caret is on. */
function caretLine(page: Page): Promise<string> {
  return page.evaluate(() => {
    const node = window.getSelection()?.anchorNode ?? null;
    const el = node instanceof Element ? node : (node?.parentElement ?? null);
    return el?.closest('.cm-line')?.textContent ?? '';
  });
}

/** Open the keynote and wait for the compile to have drawn every row. */
async function openKeynote(page: Page): Promise<void> {
  await open(page, 'Northwind launch keynote');
  await expect(entry(page, KEYNOTE_HEADINGS[0]![1])).toBeAttached();
  await expect(entry(page, KEYNOTE_HEADINGS.at(-1)![1])).toBeAttached();
}

/**
 * Put the caret in the editor at the start of `text`, the way a click in the
 * text would: through the editor's own selection, so the rail hears about it
 * exactly as it hears about any other caret move. Lines off screen are not in
 * the DOM at all, so this cannot be done by clicking one.
 */
async function caretAt(page: Page, text: string): Promise<void> {
  const found = await page.evaluate((needle) => {
    // What `EditorView.findFromDOM` reads: the content element's tile, whose
    // root holds the view.
    type View = { state: { doc: { toString(): string } }; dispatch(spec: unknown): void; focus(): void };
    const content = document.querySelector('.cm-content') as
      | (HTMLElement & { cmTile?: { root?: { view?: View } } })
      | null;
    const view = content?.cmTile?.root?.view;
    if (!view) return false;
    const at = view.state.doc.toString().indexOf(needle);
    if (at < 0) return false;
    view.dispatch({ selection: { anchor: at }, scrollIntoView: true });
    view.focus();
    return true;
  }, text);
  if (!found) throw new Error(`caretAt: could not place the caret at "${text}"`);
  await expect.poll(() => caretLine(page)).toContain(text.slice(0, 24));
}

/**
 * The heading a row jumped to has come to rest near the top of `pane` — the
 * arrival a jump promises, checked after the settle rather than assumed.
 */
async function expectLandedAtTop(page: Page, pane: 'editor' | 'preview', title: string): Promise<void> {
  await settle(page);
  const offset = await page.evaluate(
    ({ pane, title }) => {
      const scroller = document.querySelector(pane === 'editor' ? '.cm-scroller' : '.preview');
      if (!scroller) return null;
      const candidates = [
        ...scroller.querySelectorAll(pane === 'editor' ? '.cm-line' : 'h1, h2, h3, h4, h5, h6'),
      ];
      const heading = candidates.find((el) => el.textContent?.replace(/^#+\s*/, '').startsWith(title));
      if (!heading) return null;
      return heading.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    },
    { pane, title },
  );
  if (offset === null || offset < 0 || offset > 64) {
    throw new Error(`"${title}" did not land at the top of the ${pane} (offset ${offset})`);
  }
}

async function parkPointer(page: Page): Promise<void> {
  await page.mouse.move(WINDOW.width / 2, WINDOW.height - 4);
}

async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(250);
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

/** The whole window. */
async function shoot(page: Page, name: string): Promise<void> {
  await write(page, name);
}

/** The rail, with a strip of the editor beside it so the seam is in frame. */
async function shootRail(page: Page, name: string): Promise<void> {
  const box = await rail(page).boundingBox();
  if (!box) throw new Error(`${name}: the outline rail is not on screen`);
  const x = Math.max(0, box.x - 48);
  await write(page, name, { x, y: box.y - 8, width: box.x + box.width - x, height: box.height + 8 });
}

async function write(
  page: Page,
  name: string,
  clip?: { x: number; y: number; width: number; height: number },
): Promise<void> {
  if (!OUT) throw new Error('DESIGN_CAPTURE_DIR must be set');
  fs.mkdirSync(OUT, { recursive: true });
  await settle(page);
  await expect(rail(page)).toBeVisible();
  const file = path.join(OUT, `outline--${name}.png`);
  await page.screenshot({ path: file, clip });
  const size = fs.statSync(file).size;
  if (size < 4_000) throw new Error(`${name}.png is ${size} bytes — not a real capture`);
}

test('01 a short script, at rest', async ({ page }) => {
  await boot(page);
  await open(page, 'Sample: read this aloud');
  await expect(entry(page, 'Start a sentence over')).toBeVisible();
  await parkPointer(page);
  await shoot(page, '01-sample-window');
});

test('02 a long script, caret at the top', async ({ page }) => {
  await boot(page);
  await openKeynote(page);
  await parkPointer(page);
  await shoot(page, '02-keynote-window');
  await shootRail(page, '03-keynote-rail');
});

test('04 after choosing a row', async ({ page }) => {
  await boot(page);
  await openKeynote(page);
  await entry(page, 'The moment it breaks').click();
  await expect.poll(() => caretLine(page)).toContain('The moment it breaks');
  await expectLandedAtTop(page, 'editor', 'The moment it breaks');
  await parkPointer(page);
  await shoot(page, '04-navigated-window');
  await shootRail(page, '05-navigated-rail');
});

test('06 caret moved in the editor, not the rail', async ({ page }) => {
  await boot(page);
  await openKeynote(page);
  // Into the Cost per booking section's prose, from the editor alone.
  await caretAt(page, KEYNOTE_HEADINGS[5]![1]);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await parkPointer(page);
  await shootRail(page, '06-caret-in-editor-rail');
});

test('07 caret in the last section', async ({ page }) => {
  await boot(page);
  await openKeynote(page);
  await caretAt(page, 'Cold open');
  await page.keyboard.press('Meta+End');
  await expect.poll(() => caretLine(page)).not.toContain('Cold open');
  await parkPointer(page);
  await shoot(page, '07-caret-at-end-window');
});

test('08 hover on a row', async ({ page }) => {
  await boot(page);
  await openKeynote(page);
  await caretAt(page, '## Setting up the board');
  await entry(page, 'Three numbers').hover();
  await shootRail(page, '08-hover-rail');
});

test('09 keyboard focus on a row', async ({ page }) => {
  await boot(page);
  await openKeynote(page);
  await entry(page, 'Cold open').focus();
  // Arrows, not Tab: the rail is one tab stop and the arrows walk its rows.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(entry(page, 'The problem nobody')).toBeFocused();
  await parkPointer(page);
  await shootRail(page, '09-focus-rail');
});

test('10 the rail at its narrowest', async ({ page }) => {
  await boot(page, { workspace: { outlineWidth: 200 } });
  await openKeynote(page);
  await caretAt(page, '#### Fallback if the venue');
  await parkPointer(page);
  await shootRail(page, '10-narrow-rail');
});

test('11 the rail at its widest', async ({ page }) => {
  await boot(page, { workspace: { outlineWidth: 420 } });
  await openKeynote(page);
  await caretAt(page, '#### Fallback if the venue');
  await parkPointer(page);
  await shootRail(page, '11-wide-rail');
});

test('12 source and preview side by side, after choosing a row', async ({ page }) => {
  await boot(page, { workspace: { editorLayout: 'split' } });
  await openKeynote(page);
  await entry(page, 'Questions we expect').click();
  await expect.poll(() => caretLine(page)).toContain('Questions we expect');
  await expectLandedAtTop(page, 'editor', 'Questions we expect');
  await expectLandedAtTop(page, 'preview', 'Questions we expect');
  await parkPointer(page);
  await shoot(page, '12-split-navigated-window');
});

test('13 preview, after choosing a row', async ({ page }) => {
  await boot(page, { workspace: { editorLayout: 'preview' } });
  await openKeynote(page);
  await entry(page, 'Setting up the board').click();
  await expectLandedAtTop(page, 'preview', 'Setting up the board');
  await parkPointer(page);
  await shoot(page, '13-preview-navigated-window');
});

test('14 a script with no headings', async ({ page }) => {
  await boot(page);
  await open(page, 'Teleprompter test');
  await expect(rail(page)).toContainText(/ready/i);
  await parkPointer(page);
  await shootRail(page, '14-no-headings-rail');
});

test('15 a blank script', async ({ page }) => {
  await boot(page);
  await open(page, 'Untitled script');
  await expect(rail(page)).toContainText('No spoken text yet.');
  await parkPointer(page);
  await shootRail(page, '15-blank-rail');
});

test('16 keyboard focus on a clipped row the rail had to scroll to', async ({ page }) => {
  await boot(page, { workspace: { outlineWidth: 200 } });
  await openKeynote(page);
  await entry(page, 'Cold open').focus();
  await page.keyboard.press('End');
  for (let i = 0; i < 4; i += 1) await page.keyboard.press('ArrowUp');
  await expect(entry(page, 'Questions we expect')).toBeFocused();
  // The opened-out title must survive the scroll that brought its row into view.
  await expect(page.locator('.outline-peek')).toBeVisible();
  await parkPointer(page);
  await expect(entry(page, 'Questions we expect')).toBeFocused();
  await shootRail(page, '16-focus-scrolled-narrow-rail');
});
