/**
 * Screenshots of the pane dividers, for a design review of the splitter
 * itself: the sidebar's edge, the editor/preview split and the outline rail,
 * at rest, under the pointer, mid-drag, held against a limit, with keyboard
 * focus, and at both ends of their range. Opt-in: it skips unless
 * DESIGN_CAPTURE_DIR names a directory to write into, so the normal suite never
 * runs it.
 *
 *     DESIGN_CAPTURE_DIR=/tmp/shots CANDIDCUE_E2E_PORT=5300 \
 *       ./node_modules/.bin/playwright test --config=playwright.config.ts \
 *       tests/e2e/browser/design-pane-divider.spec.ts
 *
 * Most of what a splitter does never reaches a screenshot — the cursor is not
 * drawn into one — so beside the pictures it writes `divider-facts.json`: each
 * divider's hit box, its cursor at rest and at either limit, the cursor and
 * selection state of the page mid-drag, its ARIA values, and the contrast of
 * its line against the panes either side. Every shot checks that the state it
 * names is on screen before it writes, and throws rather than write a picture
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
/* The declared minimum window, where the limits of three panes meet. */
const SMALL_WINDOW = { width: 980, height: 680 };

const SCRIPT = `# Getting started

## Read this part out loud

Hi. If you're reading this sentence off the screen right now, that's exactly the idea. Keep going at whatever pace feels natural to you, and watch what the text does as you speak.

You should see the line you're on stay roughly in the middle of the screen. The words behind you fade back, and the words ahead of you sit and wait.

[Cue: relax your shoulders and look at the lens]

## A heading long enough to be cut off when the outline is at its narrowest

Now try slowing right down for a sentence or two, and put a real pause in the middle of this one — like that. The text should ease off and wait for you rather than running ahead.

# What to try next

## Go off script

Say something that isn't written here at all. Talk about your day, or what you had for breakfast, for five or ten seconds, and then come back to this line and carry on reading.

## Start a sentence over

Read this next sentence, stop halfway through, and then start it again from the beginning. Presenters do this constantly.

# Wrapping up

That's the tour. Delete all of this and write your own words whenever you're ready.
`;

const SEEDS: ShimScriptSeed[] = [
  {
    id: 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1',
    title: 'Sample: read this aloud',
    source: SCRIPT,
    updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
  },
];

const SIDEBAR = 'Sidebar width';
const SPLIT = 'Editor and preview split';
const OUTLINE = 'Outline width';

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
  workspace?: Record<string, unknown>;
}

/** Boot into the editor with the sample script open. */
async function bootEditor(page: Page, opts: Boot = {}): Promise<void> {
  await pretendMac(page);
  if (opts.workspace) {
    const seeded = JSON.stringify(opts.workspace);
    await page.addInitScript((value) => {
      localStorage.setItem('candidcue.workspace.v1', value);
    }, seeded);
  }
  await page.setViewportSize(opts.viewport ?? WINDOW);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: SEEDS,
    engineStatus: { available: true, loaded: true, model: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05' },
    promptMode: 'voice',
  });
  await page.goto('/control.html');
  await expect(collection(page).getByRole('option')).toHaveCount(SEEDS.length);
  await row(page, 'Sample: read this aloud').dblclick();
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Outline' })).toBeVisible();
}

async function useBoth(page: Page): Promise<void> {
  const both = page.getByRole('radiogroup', { name: 'Editor mode' }).getByRole('radio', { name: 'Both' });
  await both.click();
  await expect(both).toBeChecked();
  await expect(divider(page, SPLIT)).toBeVisible();
  // The split is placed from the measured work area, which lands a frame later.
  await expect.poll(() => valueOf(divider(page, SPLIT))).toBeGreaterThan(0);
  await settle(page);
}

function divider(page: Page, name: string): Locator {
  return page.getByRole('separator', { name });
}

async function centre(target: Locator): Promise<{ x: number; y: number }> {
  const box = await target.boundingBox();
  if (!box) throw new Error('divider has no box');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function parkPointer(page: Page): Promise<void> {
  const size = page.viewportSize();
  await page.mouse.move((size?.width ?? 1240) - 4, (size?.height ?? 820) - 4);
}

/**
 * Keyboard focus that `:focus-visible` will actually draw.
 *
 * The script was opened with a double click, and Chromium declines to match
 * `:focus-visible` for programmatic focus that follows a pointer gesture. A key
 * press first puts the page back in keyboard modality; the match is asserted,
 * so a capture can never be of a divider that merely holds focus invisibly.
 */
async function keyboardFocus(page: Page, target: Locator): Promise<void> {
  await page.keyboard.press('Shift');
  await target.focus();
  await expect.poll(() => target.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
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

async function shoot(
  page: Page,
  name: string,
  clip?: { x: number; y: number; width: number; height: number },
): Promise<void> {
  if (!OUT) throw new Error('DESIGN_CAPTURE_DIR must be set');
  fs.mkdirSync(OUT, { recursive: true });
  await settle(page);
  const file = path.join(OUT, `divider--${name}.png`);
  await page.screenshot({ path: file, clip });
  const size = fs.statSync(file).size;
  if (size < 4_000) throw new Error(`${name}.png is ${size} bytes — not a real capture`);
}

/** A close-up: the divider's top 300px, with 90px of pane either side. */
async function closeUp(target: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const { x } = await centre(target);
  return { x: Math.round(x - 90), y: 0, width: 180, height: 300 };
}

/** The value the divider reports, which is what moved. */
async function valueOf(target: Locator): Promise<number> {
  return Number(await target.getAttribute('aria-valuenow'));
}

/* ------------------------------------------------------------------ facts -- */

interface DividerFacts {
  label: string;
  box: { width: number; height: number };
  aria: Record<string, string | null>;
  cursor: { rest: string; atMin: string; atMax: string };
  line: { rest: string; hover: string; focus: string; restWidth: string; focusWidth: string };
  contrast: { restAgainstLeading: number; restAgainstTrailing: number; focusAgainstLeading: number };
  /** aria-valuenow before and after each key, pressed in this order. */
  keyboard: Record<string, number>;
  /** aria-valuenow after dragging past each end, and after a double-click there. */
  pointer: Record<string, number>;
}

/** Everything about one divider that a screenshot cannot show. */
async function readStatic(
  target: Locator,
): Promise<Omit<DividerFacts, 'cursor' | 'line' | 'contrast' | 'keyboard' | 'pointer'>> {
  return target.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const aria: Record<string, string | null> = {};
    for (const name of [
      'role',
      'aria-label',
      'aria-orientation',
      'aria-valuenow',
      'aria-valuemin',
      'aria-valuemax',
      'aria-valuetext',
      'aria-controls',
      'aria-keyshortcuts',
      'aria-description',
      'title',
      'tabindex',
    ]) {
      aria[name] = el.getAttribute(name);
    }
    return {
      label: el.getAttribute('aria-label') ?? '',
      box: { width: Math.round(box.width * 10) / 10, height: Math.round(box.height) },
      aria,
    };
  });
}

async function lineStyle(target: Locator): Promise<{ color: string; width: string }> {
  return target.evaluate((el) => {
    const before = getComputedStyle(el, '::before');
    return { color: before.backgroundColor, width: before.width };
  });
}

async function cursorOf(target: Locator): Promise<string> {
  return target.evaluate((el) => getComputedStyle(el).cursor);
}

/**
 * The WCAG contrast of a colour against the first opaque background found
 * under a point beside the divider.
 */
async function contrastBeside(page: Page, target: Locator, color: string, dx: number): Promise<number> {
  const { x, y } = await centre(target);
  return page.evaluate(
    ({ color, px, py }) => {
      const parse = (c: string): [number, number, number, number] => {
        const m = c.match(/rgba?\(([^)]+)\)/);
        if (!m) return [0, 0, 0, 0];
        const parts = m[1]!.split(',').map((p) => parseFloat(p));
        return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
      };
      let el: Element | null = document.elementFromPoint(px, py);
      let bg: [number, number, number, number] = [255, 255, 255, 1];
      while (el) {
        const c = parse(getComputedStyle(el).backgroundColor);
        if (c[3] > 0.99) {
          bg = c;
          break;
        }
        el = el.parentElement;
      }
      const lum = ([r, g, b]: number[]) => {
        const f = (v: number) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
      };
      const fg = parse(color);
      const a = lum(fg);
      const b = lum(bg);
      return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
    },
    { color, px: x + dx, py: y },
  );
}

/* ------------------------------------------------------------------ shots -- */

test('01 editor at rest, sidebar and outline dividers', async ({ page }) => {
  await bootEditor(page);
  await expect(divider(page, SIDEBAR)).toBeVisible();
  await expect(divider(page, OUTLINE)).toBeVisible();
  await parkPointer(page);
  await shoot(page, '01-editor-rest');
});

test('02 both, three dividers at rest', async ({ page }) => {
  await bootEditor(page);
  await useBoth(page);
  await parkPointer(page);
  await shoot(page, '02-both-rest');
  await shoot(page, '02b-both-rest-split-closeup', await closeUp(divider(page, SPLIT)));
});

test('03 the pointer over the outline divider', async ({ page }) => {
  await bootEditor(page);
  const target = divider(page, OUTLINE);
  const { x, y } = await centre(target);
  await page.mouse.move(x, y);
  await expect.poll(() => target.evaluate((el) => el.matches(':hover'))).toBe(true);
  await page.waitForTimeout(600);
  await shoot(page, '03-outline-hover-closeup', await closeUp(target));
});

test('04 mid-drag on the split, and held past its limit', async ({ page }) => {
  await bootEditor(page);
  await useBoth(page);
  const target = divider(page, SPLIT);
  const before = await valueOf(target);
  const start = await centre(target);
  const clip = await closeUp(target);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 40, start.y, { steps: 6 });
  await expect.poll(() => valueOf(target)).toBeGreaterThan(before);
  await expect(target).toHaveClass(/dragging/);
  await shoot(page, '04-split-dragging-closeup', { ...clip, x: clip.x + 40 });
  // Far past the maximum: the divider stops, the pointer carries on over the
  // preview's text.
  await page.mouse.move(start.x + 900, start.y + 120, { steps: 12 });
  const max = Number(await target.getAttribute('aria-valuemax'));
  await expect.poll(() => valueOf(target)).toBe(max);
  await shoot(page, '05-split-held-past-max');
  await page.mouse.up();
});

test('06 keyboard focus on the outline and sidebar dividers', async ({ page }) => {
  await bootEditor(page);
  await parkPointer(page);
  const outline = divider(page, OUTLINE);
  await keyboardFocus(page, outline);
  await shoot(page, '06-outline-focus-closeup', await closeUp(outline));
  const sidebar = divider(page, SIDEBAR);
  await keyboardFocus(page, sidebar);
  await shoot(page, '07-sidebar-focus-closeup', await closeUp(sidebar));
});

test('08 the outline at either end of its range', async ({ page }) => {
  // Seeded rather than driven, so the picture of a limit does not depend on
  // the gesture that reaches it — the facts below test the gestures.
  await bootEditor(page, { workspace: { outlineWidth: 200 } });
  await expect(divider(page, OUTLINE)).toHaveAttribute('aria-valuenow', '200');
  await parkPointer(page);
  await shoot(page, '08-outline-at-min');
});

test('09 the outline at its maximum', async ({ page }) => {
  await bootEditor(page, { workspace: { outlineWidth: 420 } });
  await expect(divider(page, OUTLINE)).toHaveAttribute('aria-valuenow', '420');
  await parkPointer(page);
  await shoot(page, '09-outline-at-max');
});

test('10 the smallest window, every pane dragged wide', async ({ page }) => {
  await bootEditor(page, {
    viewport: SMALL_WINDOW,
    workspace: { editorLayout: 'split', sidebarWidth: 360, outlineWidth: 420, editorSplitRatio: 0.75 },
  });
  await expect(divider(page, SPLIT)).toBeVisible();
  await parkPointer(page);
  await shoot(page, '10-small-window-all-wide');
});

test('11 the outline divider\'s menu', async ({ page }) => {
  await bootEditor(page);
  const target = divider(page, OUTLINE);
  const { x } = await centre(target);
  await page.mouse.click(x, 260, { button: 'right' });
  const menu = page.getByRole('menu', { name: OUTLINE });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveCount(3);
  await page.mouse.move(x - 160, 640);
  await shoot(page, '11-outline-menu');
});

test('12 with the system asking for more contrast', async ({ page }) => {
  await bootEditor(page);
  await useBoth(page);
  await page.emulateMedia({ reducedMotion: 'reduce', contrast: 'more' });
  await expect.poll(() => page.evaluate(() => matchMedia('(prefers-contrast: more)').matches)).toBe(true);
  await parkPointer(page);
  await shoot(page, '12-increased-contrast');
});

test('13 in forced colours', async ({ page }) => {
  await bootEditor(page);
  await useBoth(page);
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  await expect.poll(() => page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
  await parkPointer(page);
  await shoot(page, '13-forced-colors-split-closeup', await closeUp(divider(page, SPLIT)));
});

/* ------------------------------------------------------------------ facts -- */

test('facts the pictures cannot show', async ({ page }) => {
  if (!OUT) throw new Error('DESIGN_CAPTURE_DIR must be set');
  await bootEditor(page);
  await useBoth(page);
  await parkPointer(page);

  const facts: { dividers: DividerFacts[]; drag: Record<string, unknown> } = { dividers: [], drag: {} };

  for (const name of [SIDEBAR, SPLIT, OUTLINE]) {
    const target = divider(page, name);
    await parkPointer(page);
    await page.locator('body').evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await settle(page);
    const rest = await lineStyle(target);
    const restCursor = await cursorOf(target);
    const restLeading = await contrastBeside(page, target, rest.color, -8);
    const restTrailing = await contrastBeside(page, target, rest.color, 8);

    const { x, y } = await centre(target);
    await page.mouse.move(x, y);
    await page.waitForTimeout(600);
    await settle(page);
    const hover = await lineStyle(target);
    await parkPointer(page);

    await keyboardFocus(page, target);
    await settle(page);
    const focus = await lineStyle(target);
    const focusLeading = await contrastBeside(page, target, focus.color, -8);

    const keyboard: Record<string, number> = { before: await valueOf(target) };
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter']) {
      await target.press(key);
      keyboard[`after ${key}`] = await valueOf(target);
    }
    await page.locator('body').evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    // Past each end with the pointer, then a double-click where it stopped.
    const width = page.viewportSize()?.width ?? 1240;
    const pointer: Record<string, number> = {};
    const dragTo = async (toX: number): Promise<void> => {
      const from = await centre(target);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(toX, from.y, { steps: 10 });
      await page.mouse.up();
      await parkPointer(page);
      await settle(page);
    };
    await dragTo(2);
    const leftmost = await valueOf(target);
    const cursorLeft = await cursorOf(target);
    await dragTo(width - 2);
    const rightmost = await valueOf(target);
    const cursorRight = await cursorOf(target);
    const leading = (await target.getAttribute('aria-valuemin')) === String(leftmost);
    pointer['dragged to the left edge'] = leftmost;
    pointer['dragged to the right edge'] = rightmost;
    const here = await centre(target);
    await page.mouse.dblclick(here.x, here.y);
    await parkPointer(page);
    await settle(page);
    pointer['after double-click'] = await valueOf(target);

    facts.dividers.push({
      ...(await readStatic(target)),
      cursor: {
        rest: restCursor,
        atMin: leading ? cursorLeft : cursorRight,
        atMax: leading ? cursorRight : cursorLeft,
      },
      line: { rest: rest.color, hover: hover.color, focus: focus.color, restWidth: rest.width, focusWidth: focus.width },
      contrast: {
        restAgainstLeading: restLeading,
        restAgainstTrailing: restTrailing,
        focusAgainstLeading: focusLeading,
      },
      keyboard,
      pointer,
    });
    // Put it back for the next divider, whatever the gestures above did.
    await target.press('Enter');
  }

  // Mid-drag, with the pointer off the divider over the preview's text: what
  // cursor the page shows there, and whether a selection was started.
  await page.locator('body').evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const split = divider(page, SPLIT);
  const start = await centre(split);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  const point = { x: (page.viewportSize()?.width ?? 1240) - 340, y: start.y + 60 };
  await page.mouse.move(point.x, point.y, { steps: 12 });
  facts.drag = await page.evaluate(({ x, y }) => {
    const under = document.elementFromPoint(x, y) as HTMLElement | null;
    return {
      elementUnderPointer: under ? `${under.tagName.toLowerCase()}.${[...under.classList].join('.')}` : null,
      cursorUnderPointer: under ? getComputedStyle(under).cursor : null,
      rootCursor: getComputedStyle(document.documentElement).cursor,
      bodyUserSelect: getComputedStyle(document.body).userSelect,
      selection: String(window.getSelection() ?? ''),
    };
  }, point);
  await page.mouse.up();

  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'divider-facts.json');
  fs.writeFileSync(file, `${JSON.stringify(facts, null, 2)}\n`);
  expect(facts.dividers).toHaveLength(3);
});
