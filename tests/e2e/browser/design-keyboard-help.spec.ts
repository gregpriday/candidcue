/**
 * Design captures of Help › Keyboard Shortcuts — opt-in, never part of the suite.
 *
 *     DESIGN_CAPTURE_DIR=/abs/out SPEAKING_GLASS_E2E_PORT=5318 \
 *       ./node_modules/.bin/playwright test --config=playwright.config.ts \
 *       tests/e2e/browser/design-keyboard-help.spec.ts
 *
 * Without `DESIGN_CAPTURE_DIR` every test skips, so `pnpm test:e2e` never writes
 * an image. With it, each state is written as a PNG into that directory, and a
 * state is only written once the dialog it shows has been checked to be the
 * one this harness meant to show: a capture of the wrong thing is worse than
 * none.
 *
 * The dialog is opened the way design-system-focus.spec.ts opens it — the
 * platform's own chord, dispatched onto the window — because a browser has no
 * menu bar to choose Help › Keyboard Shortcuts from. During a take the menu
 * command is used instead, which is the path the packaged app takes there.
 *
 * The platform is set explicitly for every capture, by telling the page what
 * it is running on before it boots — `detectPlatform` reads `navigator` and
 * nothing else. Left alone, Playwright's "Desktop Chrome" profile reports
 * Windows, so a "macOS" capture would quietly show the Windows spellings.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { installTauriShim } from './fixtures/tauri-shim';
import { collection } from './fixtures/library';

const OUT = process.env['DESIGN_CAPTURE_DIR'];

test.skip(!OUT, 'design capture harness: set DESIGN_CAPTURE_DIR to run it');
test.describe.configure({ timeout: 90_000 });

const SCRIPT = {
  id: '51851851-8518-4518-8518-518518518518',
  title: 'Quarterly update',
  source:
    '# Opening\n\nThank you for joining me today.\n\nHere is what changed this quarter.\n\n' +
    '# Results\n\nRevenue grew in every region, and the new plan carried most of it.\n',
};

const DIALOG_NAME = 'Keyboard shortcuts';

function dialog(page: Page): Locator {
  return page.getByRole('dialog', { name: DIALOG_NAME });
}

/** Make the page report a platform before any app code reads `navigator`. */
async function pretendPlatform(page: Page, platform: 'mac' | 'windows'): Promise<void> {
  await page.addInitScript((mac) => {
    Object.defineProperty(Navigator.prototype, 'platform', {
      get: () => (mac ? 'MacIntel' : 'Win32'),
    });
    Object.defineProperty(Navigator.prototype, 'userAgentData', {
      get: () => ({ platform: mac ? 'macOS' : 'Windows', brands: [], mobile: false }),
    });
  }, platform === 'mac');
}

/** The help chord for whatever platform the page believes it is on. */
async function pressHelpChord(page: Page): Promise<void> {
  await page.evaluate(() => {
    // Case-blind: `userAgentData.platform` says "macOS", `navigator.platform` "MacIntel".
    const isMac = /mac|iphone|ipad/i.test(
      (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform ??
        navigator.platform,
    );
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: '/', metaKey: isMac, ctrlKey: !isMac, bubbles: true }),
    );
  });
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

async function openShortcuts(page: Page): Promise<Locator> {
  await pressHelpChord(page);
  const d = dialog(page);
  await expect(d).toBeVisible();
  // The rows are rendered and the take section exists: not an empty shell.
  await expect(d.getByText('During a take', { exact: true }).first()).toBeAttached();
  await expect(d.locator('tbody tr').first()).toBeVisible();
  await settle(page);
  return d;
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

/** Bring the "During a take" group to the top of whatever scrolls. */
async function showTakeSection(d: Locator): Promise<void> {
  const heading = d.getByText('During a take', { exact: true }).last();
  await heading.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await expect(heading).toBeInViewport();
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
 * row and every chord without stitching scroll positions together. The panel
 * is otherwise exactly what renders.
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

async function bootLibrary(
  page: Page,
  size: { width: number; height: number },
  platform: 'mac' | 'windows' = 'mac',
): Promise<void> {
  await pretendPlatform(page, platform);
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

test('macOS spellings, light workspace', async ({ page }) => {
  await bootLibrary(page, { width: 1240, height: 800 });
  const d = await openShortcuts(page);
  await expect(d).toContainText('⌘');

  await shoot(page, '01-initial--mac-light');

  await showTakeSection(d);
  await shoot(page, '02-take-section--mac-light');

  await scrollTo(d, 'middle');
  await shoot(page, '03-scrolled-middle--mac-light');

  await scrollTo(d, 'end');
  await shoot(page, '04-end--mac-light');

  // Keyboard focus, reached the way a keyboard user reaches it.
  await scrollTo(d, 'top');
  await page.keyboard.press('Tab');
  await expect(d.getByRole('button', { name: 'Done' })).toBeFocused();
  await shoot(page, '05-focus-done--mac-light');

  await shootUnclipped(page, '00-full-content--mac-light');
});

test('Windows spellings, light workspace', async ({ page }) => {
  await bootLibrary(page, { width: 1240, height: 800 }, 'windows');
  const d = await openShortcuts(page);
  await expect(d).toContainText('Ctrl');
  await expect(d).not.toContainText('⌘');

  await shoot(page, '06-initial--win-light');

  await showTakeSection(d);
  await shoot(page, '07-take-section--win-light');

  await shootUnclipped(page, '08-full-content--win-light');
});

test('the smallest window the app allows', async ({ page }) => {
  // tauri.conf.json: minWidth 980, minHeight 680.
  await bootLibrary(page, { width: 980, height: 680 });
  const d = await openShortcuts(page);
  await expect(d).toContainText('⌘');

  await shoot(page, '09-narrow-initial--mac-light');

  await showTakeSection(d);
  await shoot(page, '10-narrow-take-section--mac-light');
});

test('opened during a take, dark studio', async ({ page }) => {
  await bootLibrary(page, { width: 1240, height: 800 });
  await collection(page).getByRole('button', { name: 'Present', exact: true }).first().click();
  await expect(page.getByRole('region', { name: 'Teleprompter' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator('.stage-root')).toHaveAttribute('data-phase', 'ready');

  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__E2E__.emit('menu://command', { id: 'help.keyboard-shortcuts' }),
      ),
    )
    .toBeGreaterThan(0);
  const d = dialog(page);
  await expect(d).toBeVisible();
  await expect(d.locator('tbody tr').first()).toBeVisible();
  await expect(d).toContainText('⌘');
  // The studio palette, not the workspace one: the take is what themes it.
  await expect
    .poll(() => d.evaluate((el) => getComputedStyle(el).backgroundColor))
    .not.toBe('rgb(255, 255, 255)');
  await settle(page);

  await shoot(page, '11-during-take--mac-studio');

  await showTakeSection(d);
  await shoot(page, '12-during-take-take-section--mac-studio');
});
