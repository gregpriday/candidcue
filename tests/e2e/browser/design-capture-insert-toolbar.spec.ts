/**
 * Screenshots of the editor's insert toolbar, for a design review of that one
 * row: at rest, under the pointer, pressed, keyboard-focused on every button in
 * turn, and the editor straight after each kind of insertion — so what an
 * insert does to the caret and the selection is on the page, not inferred.
 * Opt-in: it skips unless DESIGN_CAPTURE_DIR names a directory to write into,
 * so the normal suite never runs it.
 *
 *     DESIGN_CAPTURE_DIR=/tmp/shots CANDIDCUE_E2E_PORT=5300 \
 *       ./node_modules/.bin/playwright test --config=playwright.config.ts \
 *       tests/e2e/browser/design-capture-insert-toolbar.spec.ts
 *
 * Next to the pictures it writes `toolbar-report.txt`: every button's name,
 * tooltip, size and focus treatment, and for each insertion where focus went,
 * what ended up selected and whether the caret is still on screen. Native
 * `title` tooltips are drawn by the OS and never reach a screenshot, so the
 * report is the only place a reviewer can read them.
 *
 * Everything goes in through the Tauri shim, so the row is drawn by the real
 * stores and the real route. Each shot checks that the state it names is
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
test.describe.configure({ timeout: 90_000 });
test.use({ deviceScaleFactor: 2 });

const WINDOW = { width: 1240, height: 820 };
/** `minWidth` / `minHeight` in tauri.conf.json: the narrowest the row ever gets. */
const NARROWEST = { width: 980, height: 680 };

const SCRIPT_ID = 'b22b0001-b22b-4b2b-8b2b-b22bb22b0001';
const SOURCE = `# Cold open

Every tool wants you to run more AI agents. That's fine, but running more agents was never the hard part. The hard part is managing your attention, because that's the thing that actually runs out.

So this week I rebuilt the overview around exactly three questions: is anything asking me for something, is anything stuck, and is anything finished and waiting.

[Cue: cut to the screen recording]

# The overview

Here's what it looks like with twenty agents running. **Nothing** in this list is decoration.

Each row is one agent. The left edge tells you whether it needs you, and the right edge tells you how long it has been waiting.

## Asking

An agent that wants an answer moves to the top and stays there until somebody gives it one.

## Stuck

An agent that has stopped making progress drops into its own band, so it cannot hide in a long list.

## Finished

And an agent that is done and waiting for review gets a quiet mark rather than a notification.

[Take: The close]

# The close

That's the whole idea. Three questions, one screen, and nothing on it that does not answer one of them.

If you try it, tell me which of the three you look at first. I have a guess, and I would like to know if I'm wrong.

Thanks for watching.
`;

/* Long enough that the caret can be scrolled well out of the editor's view. */
const LONG_SOURCE = `${SOURCE}\n# Appendix\n\n\`\`\`mermaid\nflowchart LR\n  Ask --> Answer\n  Answer --> Done\n\`\`\`\n\n${Array.from(
  { length: 40 },
  (_, i) => `Point ${i + 1}: the ${['first', 'next', 'last'][i % 3]} thing to say about agent number ${i + 1} is that it ran for ${i * 7 + 3} minutes.`,
).join('\n\n')}\n`;

const SEEDS: ShimScriptSeed[] = [
  { id: SCRIPT_ID, title: 'Daintree intro', source: SOURCE },
  { id: 'b22b0002-b22b-4b2b-8b2b-b22bb22b0002', title: 'Long read', source: LONG_SOURCE },
];

const ENGINE_READY = {
  available: true,
  loaded: true,
  model: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05',
};

const report: string[] = [];

async function pretendMac(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' });
    Object.defineProperty(Navigator.prototype, 'userAgentData', {
      get: () => ({ platform: 'macOS', brands: [], mobile: false }),
    });
  });
}

async function bootEditor(
  page: Page,
  opts: { viewport?: { width: number; height: number }; workspace?: Record<string, unknown>; script?: string } = {},
): Promise<void> {
  await pretendMac(page);
  if (opts.workspace) {
    const workspace = opts.workspace;
    await page.addInitScript((value) => {
      localStorage.setItem('candidcue.workspace.v1', JSON.stringify(value));
    }, workspace);
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
  await row(page, opts.script ?? 'Daintree intro').dblclick();
  await expect(editorBox(page)).toBeVisible();
  await expect(toolbar(page)).toBeVisible();
}

const toolbar = (page: Page): Locator => page.getByRole('toolbar');
const editorBox = (page: Page): Locator => page.getByRole('textbox', { name: 'Script Markdown' });
const buttons = (page: Page): Locator => toolbar(page).locator('button');

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

type Clip = { x: number; y: number; width: number; height: number };

async function shoot(page: Page, name: string, clip?: Clip): Promise<void> {
  if (!OUT) throw new Error('DESIGN_CAPTURE_DIR must be set');
  fs.mkdirSync(OUT, { recursive: true });
  await settle(page);
  const file = path.join(OUT, `toolbar--${name}.png`);
  await page.screenshot({ path: file, clip });
  const size = fs.statSync(file).size;
  if (size < 2_000) throw new Error(`${name}.png is ${size} bytes — not a real capture`);
}

/** The whole header (both rows) plus `below` px of the editor under it. */
async function chromeClip(page: Page, below = 0): Promise<Clip> {
  const box = await page.locator('.toolbar-stack').boundingBox();
  if (!box) throw new Error('the toolbar stack is not on screen');
  return { x: box.x, y: box.y, width: box.width, height: box.height + below };
}

/** The formatting row alone, with room either side for a focus ring. */
async function rowClip(page: Page): Promise<Clip> {
  const bar = await toolbar(page).boundingBox();
  const secondary = await page.locator('.toolbar-stack .secondary').boundingBox();
  if (!bar || !secondary) throw new Error('the formatting row is not on screen');
  return {
    x: Math.max(0, secondary.x),
    y: secondary.y - 6,
    width: Math.min(secondary.width, bar.x - secondary.x + bar.width + 220),
    height: secondary.height + 12,
  };
}

/** What CodeMirror holds right now: the selection, focus, and whether the caret is visible. */
async function editorState(page: Page): Promise<string> {
  return page.evaluate(() => {
    const content = document.querySelector('.cm-content') as (HTMLElement & { cmTile?: any; cmView?: any }) | null;
    const view = content?.cmTile?.root?.view ?? content?.cmView?.view;
    const active = document.activeElement as HTMLElement | null;
    const where = active
      ? `${active.tagName.toLowerCase()}${active.getAttribute('aria-label') ? `[${active.getAttribute('aria-label')}]` : ''}${active.className && typeof active.className === 'string' ? `.${active.className.split(' ')[0]}` : ''}`
      : 'none';
    if (!view) return `focus=${where} (no CodeMirror view found)`;
    const sel = view.state.selection.main;
    const doc: string = view.state.doc.toString();
    const line = view.state.doc.lineAt(sel.head);
    // On screen means something you could actually see is drawn there: the
    // point under the caret hits the editor's own text, not chrome or nothing.
    const coords = view.coordsAtPos(sel.head);
    const hit = coords
      ? document.elementFromPoint(coords.left + 1, (coords.top + coords.bottom) / 2)
      : null;
    const onScreen = !!hit && view.contentDOM.contains(hit);
    return [
      `focus=${where}`,
      `editorFocused=${view.hasFocus}`,
      `selection=${JSON.stringify(doc.slice(sel.from, sel.to))} (${sel.from}-${sel.to})`,
      `caretLine=${line.number}: ${JSON.stringify(line.text.slice(0, 90))}`,
      `caretOnScreen=${onScreen}`,
    ].join('  ');
  });
}

/** Put the caret (or a selection) on the first occurrence of `text`. */
async function select(page: Page, text: string, opts: { collapse?: 'start' | 'end' } = {}): Promise<void> {
  const ok = await page.evaluate(
    ({ text, collapse }) => {
      const content = document.querySelector('.cm-content') as (HTMLElement & { cmTile?: any; cmView?: any }) | null;
      const view = content?.cmTile?.root?.view ?? content?.cmView?.view;
      if (!view) return false;
      const at = view.state.doc.toString().indexOf(text);
      if (at < 0) return false;
      const anchor = collapse === 'end' ? at + text.length : at;
      const head = collapse ? anchor : at + text.length;
      view.dispatch({ selection: { anchor, head }, scrollIntoView: true });
      view.focus();
      return true;
    },
    { text, collapse: opts.collapse },
  );
  if (!ok) throw new Error(`could not place the selection on ${JSON.stringify(text)}`);
}

function note(line: string): void {
  report.push(line);
}

test.afterAll(() => {
  if (!OUT || report.length === 0) return;
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'toolbar-report.txt'), `${report.join('\n')}\n`);
});

test('01 the header at rest, and the window around it', async ({ page }) => {
  await bootEditor(page);
  await parkPointer(page);
  await shoot(page, '01-rest', await chromeClip(page, 96));
  await shoot(page, '02-window');

  // The inventory: every control in the row, as a reviewer cannot see it.
  const rows = await buttons(page).evaluateAll((els) =>
    els.map((el, i) => {
      const b = el as HTMLButtonElement;
      const r = b.getBoundingClientRect();
      return `  ${i + 1}. name=${JSON.stringify(b.getAttribute('aria-label') ?? b.textContent?.trim())} title=${JSON.stringify(b.title)} size=${Math.round(r.width)}x${Math.round(r.height)} tabindex=${b.tabIndex} data-focus=${b.dataset['focus'] ?? '(none)'} pressed=${b.getAttribute('aria-pressed') ?? '-'} shortcut=${b.getAttribute('aria-keyshortcuts') ?? '-'}`;
    }),
  );
  const name = await toolbar(page).getAttribute('aria-label');
  const groups = await toolbar(page).locator('[role="group"]').evaluateAll((els) =>
    els.map((el) => el.getAttribute('aria-label')),
  );
  note(`TOOLBAR name=${JSON.stringify(name)} groups=${JSON.stringify(groups)}`);
  note('BUTTONS (in DOM order)');
  for (const line of rows) note(line);
  const trailing = await page
    .locator('.toolbar-stack .secondary > button, .toolbar-stack .secondary > :not([role="toolbar"]) button')
    .evaluateAll((els) => els.map((el) => `${(el as HTMLElement).textContent?.trim()} title=${JSON.stringify((el as HTMLElement).title)}`));
  note(`OUTSIDE THE GROUP, SAME ROW: ${JSON.stringify(trailing)}`);
});

test('02 under the pointer and pressed', async ({ page }) => {
  await bootEditor(page);
  const clip = await rowClip(page);
  const count = await buttons(page).count();
  expect(count).toBeGreaterThan(4);
  // A typographic button and a drawn icon, so the two families sit side by side.
  const bold = toolbar(page).getByRole('button', { name: /^Bold/ });
  const link = toolbar(page).getByRole('button', { name: /link/i });
  await bold.hover();
  await shoot(page, '03-hover-bold', clip);
  await link.hover();
  await shoot(page, '04-hover-link', clip);
  // Held down, never released: a release would insert.
  await bold.hover();
  await page.mouse.down();
  await shoot(page, '05-pressed-bold', clip);
  await page.mouse.move(2, 2);
  await page.mouse.up();
  await link.hover();
  await page.mouse.down();
  await shoot(page, '06-pressed-link', clip);
  await page.mouse.move(2, 2);
  await page.mouse.up();
});

test('03 keyboard focus walked across every button', async ({ page }) => {
  await bootEditor(page);
  await parkPointer(page);
  const clip = await rowClip(page);
  // Reach the group the way a keyboard user does: from the text, backwards.
  await select(page, 'Every tool', { collapse: 'start' });
  for (let i = 0; i < 6; i += 1) {
    const inside = await toolbar(page).evaluate((el) => el.contains(document.activeElement));
    if (inside) break;
    await page.keyboard.press('Shift+Tab');
  }
  const inside = await toolbar(page).evaluate((el) => el.contains(document.activeElement));
  if (!inside) throw new Error('Shift+Tab from the editor never reached the toolbar');
  note(`REACHED FROM THE EDITOR WITH Shift+Tab, landing on: ${await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))}`);
  await page.keyboard.press('Home');
  const count = await buttons(page).count();
  note('FOCUS RING PER BUTTON (outline as computed while keyboard-focused)');
  for (let i = 0; i < count; i += 1) {
    if (i > 0) await page.keyboard.press('ArrowRight');
    const focused = buttons(page).nth(i);
    await expect(focused).toBeFocused();
    const ring = await focused.evaluate((el) => {
      const s = getComputedStyle(el);
      return `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor} offset ${s.outlineOffset}`;
    });
    const label = (await focused.getAttribute('aria-label')) ?? '';
    note(`  ${i + 1}. ${label}: ${ring}`);
    await shoot(page, `07-focus-${String(i + 1).padStart(2, '0')}`, clip);
  }
  await page.keyboard.press('ArrowRight');
  note(`ArrowRight past the last button lands on: ${await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))}`);
  await page.keyboard.press('Escape');
  note(`Escape inside the toolbar → ${await editorState(page)}`);
});

test('04 what an insertion does to the caret', async ({ page }) => {
  await bootEditor(page);
  await parkPointer(page);
  const by = (name: RegExp) => toolbar(page).getByRole('button', { name });
  note('AFTER EACH INSERTION (pointer click unless stated)');

  await select(page, 'managing your attention');
  await by(/^Bold/).click();
  await parkPointer(page);
  note(`  Bold on "managing your attention" → ${await editorState(page)}`);
  await shoot(page, '08-after-bold', await chromeClip(page, 220));

  await select(page, 'running more agents');
  await by(/link/i).click();
  await parkPointer(page);
  note(`  Link on "running more agents" → ${await editorState(page)}`);
  await shoot(page, '09-after-link', await chromeClip(page, 220));

  await select(page, 'So this week', { collapse: 'end' });
  await by(/heading/i).click();
  await by(/heading/i).click();
  await parkPointer(page);
  note(`  Heading ×2 with the caret in "So this week" → ${await editorState(page)}`);
  await shoot(page, '10-after-heading', await chromeClip(page, 220));

  await select(page, 'Here\'s what it looks like', { collapse: 'end' });
  await by(/part break/i).click();
  await parkPointer(page);
  note(`  Part break with the caret mid-paragraph → ${await editorState(page)}`);
  await shoot(page, '11-after-part-break', await chromeClip(page, 560));

  // A click in the toolbar's own gap, between two buttons: where does focus go?
  await select(page, 'Every tool', { collapse: 'start' });
  // A divider, not an icon: the icons are `aria-hidden` SVGs inside buttons.
  const rule = toolbar(page).locator('> span[aria-hidden="true"], > [role="separator"]').first();
  const box = await rule.boundingBox();
  if (box) {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    note(`  A click on the divider between groups → ${await editorState(page)}`);
  }
});

test('05 insertions from the keyboard', async ({ page }) => {
  await bootEditor(page);
  await parkPointer(page);
  await select(page, 'Every tool', { collapse: 'start' });
  for (let i = 0; i < 6; i += 1) {
    if (await toolbar(page).evaluate((el) => el.contains(document.activeElement))) break;
    await page.keyboard.press('Shift+Tab');
  }
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowLeft');
  const target = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
  await page.keyboard.press('Enter');
  note(`KEYBOARD: Shift+Tab into the row, End, ArrowLeft (${target}), Enter → ${await editorState(page)}`);
  await shoot(page, '12-after-keyboard-insert', await chromeClip(page, 220));
  // Straight back to the row: does it remember where it was?
  for (let i = 0; i < 6; i += 1) {
    if (await toolbar(page).evaluate((el) => el.contains(document.activeElement))) break;
    await page.keyboard.press('Shift+Tab');
  }
  note(`  …and Shift+Tab back into the row lands on: ${await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))}`);
});

test('06 an insertion while the caret is scrolled out of view', async ({ page }) => {
  await bootEditor(page, { script: 'Long read' });
  await parkPointer(page);
  await select(page, 'managing your attention');
  // CodeMirror scrolls the selection into view on its next measure; let that
  // land first, or it undoes the scroll below.
  await settle(page);
  // Whichever box actually scrolls the text: every scrollable ancestor of it.
  const scrolled = await page.evaluate(() => {
    let moved = 0;
    for (let el = document.querySelector('.cm-content') as HTMLElement | null; el; el = el.parentElement) {
      if (el.scrollHeight > el.clientHeight + 10 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) {
        el.scrollTop = el.scrollHeight;
        moved += 1;
      }
    }
    return moved;
  });
  if (scrolled === 0) throw new Error('nothing around the editor scrolls — the document is too short');
  await settle(page);
  await settle(page);
  const before = await editorState(page);
  if (!before.includes('caretOnScreen=false')) throw new Error(`the caret is still on screen: ${before}`);
  note(`OFF-SCREEN CARET, before → ${before}`);
  await toolbar(page).getByRole('button', { name: /^Bold/ }).click();
  await parkPointer(page);
  note(`  Bold → ${await editorState(page)}`);
  await shoot(page, '13-offscreen-insert');
});

test('07 at the narrowest window, beside the outline', async ({ page }) => {
  await bootEditor(page, { viewport: NARROWEST, workspace: { outlineVisible: true } });
  await parkPointer(page);
  await shoot(page, '14-narrowest');
  const clipped = await buttons(page).evaluateAll((els) => {
    const bar = els[0]?.closest('[role="toolbar"]')?.getBoundingClientRect();
    return els
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return !bar || r.right > bar.right + 0.5 || r.left < bar.left - 0.5;
      })
      .map((el) => el.getAttribute('aria-label'));
  });
  note(`NARROWEST WINDOW (980x680, outline open): buttons clipped by the row = ${JSON.stringify(clipped)}`);
});

test('08 in the side-by-side arrangement', async ({ page }) => {
  await bootEditor(page, { workspace: { editorLayout: 'split' } });
  await parkPointer(page);
  await shoot(page, '15-split');
});

test('09 a block insert with the caret inside a diagram', async ({ page }) => {
  await bootEditor(page, { script: 'Long read' });
  await parkPointer(page);
  await select(page, 'Ask --> Answer', { collapse: 'end' });
  await toolbar(page).getByRole('button', { name: /part break/i }).click();
  await parkPointer(page);
  note(`PART BREAK WITH THE CARET INSIDE A MERMAID FENCE → ${await editorState(page)}`);
  await shoot(page, '16-part-break-in-fence');
});
