/**
 * Design captures of the script syntax reference — opt-in, never part of the suite.
 *
 *     DESIGN_CAPTURE_DIR=/abs/out CANDIDCUE_E2E_PORT=5318 \
 *       ./node_modules/.bin/playwright test --config=playwright.config.ts \
 *       tests/e2e/browser/design-syntax-reference.spec.ts
 *
 * Without `DESIGN_CAPTURE_DIR` every test skips, so `pnpm test:e2e` never writes
 * an image. With it, each state is written as a PNG into that directory, and a
 * state is only written once the dialog it shows has been checked to be the
 * one this harness meant to show: a capture of the wrong thing is worse than
 * none.
 *
 * The reference only opens outside a take, so the workspace palette is the only
 * one it is ever drawn in. It is opened from the editor's own button, which is
 * where it is met most, and from the Help menu's command for the window sizes.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { installTauriShim } from './fixtures/tauri-shim';
import { collection, openScript } from './fixtures/library';
import { syntaxEntries } from '../../../src/shared/markdown/syntax-reference';

const OUT = process.env['DESIGN_CAPTURE_DIR'];

test.skip(!OUT, 'design capture harness: set DESIGN_CAPTURE_DIR to run it');
test.describe.configure({ timeout: 90_000 });

const SCRIPT = {
  id: '30530530-5305-4305-8305-305305305318',
  title: 'Quarterly update',
  source:
    '[Take: Opening]\n\nThank you for joining me today. [Beat] Here is what changed this quarter.\n\n' +
    ':::stage\nSlide two: the revenue chart.\n:::\n\n' +
    '[Take: Results]\n\nRevenue grew in every region, and the API{say="A P I"} carried most of it.\n',
};

const DIALOG_NAME = 'Script syntax reference';

function dialog(page: Page): Locator {
  return page.getByRole('dialog', { name: DIALOG_NAME });
}

/** Wait out every finite animation and two frames, so a capture is at rest. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    const finite = document
      .getAnimations()
      .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(finite.map((a) => a.finished.catch(() => undefined)));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}

/**
 * The reference is the one this harness meant: every entry it documents is on
 * the page, and each has its glass drawn by the compiler rather than an empty
 * slot waiting for it.
 */
async function expectWholeReference(d: Locator): Promise<void> {
  await expect(d).toBeVisible();
  for (const entry of syntaxEntries()) {
    await expect(d.locator(`[data-entry="${entry.id}"]`)).toBeAttached();
  }
  await expect(d.locator('[data-specimen="ready"]')).toHaveCount(syntaxEntries().length);
}

/** Type into the reference's search field and wait for exactly `ids` to remain. */
async function search(d: Locator, text: string, ids: string[]): Promise<void> {
  await d.getByRole('searchbox', { name: 'Find syntax' }).fill(text);
  await expect(d.locator('[data-entry]')).toHaveCount(ids.length);
  for (const id of ids) await expect(d.locator(`[data-entry="${id}"]`)).toBeVisible();
}

/** The element inside the dialog that actually scrolls, whichever one that is. */
async function scrollTo(d: Locator, where: 'top' | 'middle' | 'end'): Promise<number> {
  return d.evaluate((panel, position) => {
    const candidates = [panel, ...panel.querySelectorAll<HTMLElement>('*')] as HTMLElement[];
    const scroller = candidates.find((el) => {
      const overflow = getComputedStyle(el).overflowY;
      return (overflow === 'auto' || overflow === 'scroll') && el.scrollHeight > el.clientHeight + 1;
    });
    if (!scroller) throw new Error('nothing in the dialog scrolls');
    const max = scroller.scrollHeight - scroller.clientHeight;
    scroller.scrollTop = position === 'top' ? 0 : position === 'middle' ? max / 2 : max;
    return scroller.scrollTop;
  }, where);
}

/** Bring one entry to the top of whatever scrolls. */
async function showEntry(d: Locator, id: string): Promise<void> {
  const entry = d.locator(`[data-entry="${id}"]`);
  await entry.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await expect(entry).toBeInViewport();
}

async function shoot(page: Page, name: string, target?: Locator): Promise<void> {
  mkdirSync(OUT!, { recursive: true });
  const path = join(OUT!, `${name}.png`);
  await settle(page);
  // Still the dialog this harness opened, at the moment of capture.
  await expect(dialog(page)).toBeVisible();
  if (target) await target.screenshot({ path });
  else await page.screenshot({ path });
  const size = statSync(path).size;
  if (size < 2_000) throw new Error(`${name}.png is ${size} bytes — not a real capture`);
}

/**
 * The whole reference at once, with the panel's height cap lifted.
 *
 * Diagnostic, not a state anyone sees: it exists so a reviewer can judge every
 * entry without stitching scroll positions together. The panel is otherwise
 * exactly what renders.
 */
async function shootUnclipped(page: Page, name: string): Promise<void> {
  const style = await page.addStyleTag({
    content: `[role="dialog"], [role="dialog"] * { max-height: none !important; }
              [role="dialog"], [role="dialog"] .body, [role="dialog"] .scroll { overflow: visible !important; }`,
  });
  const height = await dialog(page).evaluate((el) => el.scrollHeight);
  const viewport = page.viewportSize()!;
  await page.setViewportSize({ width: viewport.width, height: Math.ceil(height + 160) });
  await shoot(page, name, dialog(page));
  // `addStyleTag` hands back a Node handle; the tag it added is an Element.
  await style.evaluate((el) => (el as Element).remove());
  await page.setViewportSize(viewport);
}

async function boot(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.setViewportSize(size);
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [SCRIPT],
    engineStatus: {
      available: true,
      loaded: true,
      model: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05',
    },
    promptMode: 'voice',
  });
  await page.goto('/control.html');
  await expect(collection(page)).toBeVisible();
  await expect(page.locator('[data-theme="workspace"]').first()).toBeAttached();
}

/** Help › Script Syntax Reference, once the window is listening for menu commands. */
async function openFromHelp(page: Page): Promise<Locator> {
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__E2E__.emit('menu://command', { id: 'help.syntax-reference' }),
      ),
    )
    .toBeGreaterThan(0);
  const d = dialog(page);
  await expectWholeReference(d);
  await settle(page);
  return d;
}

test('opened from the editor, a typical window', async ({ page }) => {
  await boot(page, { width: 1240, height: 800 });
  await openScript(page, SCRIPT.title);
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeVisible();
  await page.getByRole('button', { name: 'Syntax reference' }).click();
  const d = dialog(page);
  await expectWholeReference(d);
  await settle(page);

  await shoot(page, '01-open-from-editor--1240');

  await showEntry(d, 'say-alias');
  await shoot(page, '02-say-and-spoken--1240');

  await showEntry(d, 'nesting');
  await shoot(page, '03-notes-for-you--1240');

  await showEntry(d, 'image');
  await shoot(page, '04-media--1240');

  await scrollTo(d, 'end');
  await shoot(page, '05-end--1240');

  await shootUnclipped(page, '00-full-content--1240');

  // Looked up by what the writer wants, by a piece of syntax, and by nothing.
  await scrollTo(d, 'top');
  await search(d, 'pause', ['shorthand-cues', 'escape']);
  await shoot(page, '09-search-pause--1240');

  await search(d, 'pronounce', ['say-alias', 'spoken-block']);
  await shoot(page, '10-search-pronounce--1240');

  // A search for a form shows that form: the glass, the words and Copy follow it.
  await search(d, 'italic', ['text']);
  const text = d.locator('[data-entry="text"]');
  await expect(text.getByRole('radio', { name: 'Italic' })).toBeChecked();
  await expect(text.locator('pre code')).toHaveText('Read it *slowly*.');
  await shoot(page, '13-search-italic--1240');

  await text.getByRole('radio', { name: 'Quote' }).click();
  await expect(text.locator('pre code')).toHaveText('> Teleprompters should listen.');
  await expect(text.locator('.heard')).toHaveText('“teleprompters should listen”');
  await shoot(page, '14-form-quote--1240');

  await search(d, 'zebra', []);
  await expect(d.locator('.empty-title')).toHaveText('No syntax matches “zebra”.');
  await shoot(page, '11-search-nothing--1240');

  // Copy, reached from the keyboard: Tab from the field to the first entry's button.
  await search(d, '[cue', ['cue']);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const copy = d.locator('[data-entry="cue"]').getByRole('button', { name: /^Copy/ });
  await expect(copy).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(d.locator('[data-entry="cue"]').getByRole('button', { name: /^Copied/ })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    syntaxEntries().find((e) => e.id === 'cue')!.example,
  );
  await shoot(page, '12-copied--1240');
});

test('the smallest window the app allows', async ({ page }) => {
  // tauri.conf.json: minWidth 980, minHeight 680.
  await boot(page, { width: 980, height: 680 });
  const d = await openFromHelp(page);

  await shoot(page, '06-open--980');

  await showEntry(d, 'take');
  await shoot(page, '07-part-break--980');
});

test('a large window', async ({ page }) => {
  await boot(page, { width: 1600, height: 1000 });
  await openFromHelp(page);
  await shoot(page, '08-open--1600');
});
