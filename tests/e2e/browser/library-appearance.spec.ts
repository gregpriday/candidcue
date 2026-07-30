import { test, expect } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';

/**
 * The library screen's APPEARANCE, in a real browser.
 *
 * This layer exists because the two bugs this screen was fixed for are both
 * invisible to jsdom, which resolves no stylesheets and computes no colours:
 *
 *   - the overflow menu's first item wore a 2px accent ring, inherited from a
 *     global `:focus-visible` rule in `src/styles/tokens.css`, because the
 *     menu-button pattern moves focus onto it as soon as the menu opens. The
 *     jsdom tests in `tests/dom/overflow-menu.test.ts` cover the highlight state
 *     machine, but deleting the `outline: none` rule would leave every one of them
 *     green while restoring the ring;
 *
 *   - a selected card's rule was `background: var(--accent-wash)`, and that token
 *     is a 5%-alpha tint, so it REPLACED the card's opaque white surface instead
 *     of tinting it and the page canvas showed through. A class assertion cannot
 *     tell that apart from a correctly painted card.
 *
 * So everything below reads computed style or geometry. It says nothing about
 * WKWebView, which is what actually ships — see CLAUDE.md on that gap.
 */

const SCRIPTS = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Launch keynote',
    source: '# Launch keynote\n\nWelcome everyone to the show.\n',
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    title: 'Weekly product update',
    source: '# Weekly update\n\nThree things shipped this week.\n',
  },
];

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1240, height: 800 });
  await installTauriShim(page, { welcomed: true, seedScripts: SCRIPTS });
});

test('a pointer-opened menu highlights nothing and moves focus anyway', async ({ page }) => {
  await page.goto('/control.html');
  const list = page.getByRole('list', { name: 'Scripts' });
  await list.locator('.title').first().waitFor();

  await list.getByRole('button', { name: 'Script actions' }).first().click();
  const menu = page.locator('[role="menu"]');
  await menu.waitFor();

  // Focus IS inside the menu — that half of the ARIA pattern must hold.
  const focusedLabel = await page.evaluate(() => document.activeElement?.textContent?.trim());
  expect(focusedLabel).toBe('Open');

  /*
   * There is deliberately NO outline assertion on this path.
   *
   * Chromium declines to match `:focus-visible` for focus moved programmatically
   * after a pointer click, so the focused item here reports `outline-style: none`
   * whether or not the suppression rule exists — an assertion that cannot fail is
   * worse than no assertion, because it reads as coverage. The ring is guarded on
   * the keyboard path in the next test, where removing the rule genuinely fails.
   */

  // A pointer-opened menu highlights nothing: every item shares one background.
  const backgrounds = await menu
    .getByRole('menuitem')
    .evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
  expect(new Set(backgrounds).size).toBe(1);

  // Hovering lights exactly one item, and it is the hovered one. Polled because
  // the highlight is state-driven: `pointerenter` sets it and Svelte flushes the
  // class on a microtask, so a single immediate read can land a frame early.
  await page.getByRole('menuitem', { name: 'Duplicate' }).hover();
  await expect
    .poll(async () =>
      menu.getByRole('menuitem').evaluateAll((els, resting) =>
        els
          .filter((el) => getComputedStyle(el).backgroundColor !== resting)
          .map((el) => el.textContent?.trim()),
      backgrounds[0]),
    )
    .toEqual(['Duplicate']);
});

test('Enter on the trigger opens the menu with a visible highlight', async ({ page }) => {
  // A real key press, not a synthesised click: Enter and Space reach a button as
  // a click, so treating every click as pointer-originated left a keyboard user
  // with focus in the menu and nothing drawn to say where.
  await page.goto('/control.html');
  const list = page.getByRole('list', { name: 'Scripts' });
  await list.locator('.title').first().waitFor();

  const trigger = list.getByRole('button', { name: 'Script actions' }).first();
  await trigger.focus();
  await page.keyboard.press('Enter');

  const menu = page.locator('[role="menu"]');
  await menu.waitFor();

  const items = await menu
    .getByRole('menuitem')
    .evaluateAll((els) =>
      els.map((el) => ({ label: el.textContent?.trim(), bg: getComputedStyle(el).backgroundColor })),
    );
  // The first item is distinguishable from the rest — the keyboard user can see
  // what Return would fire.
  const others = new Set(items.slice(1).map((i) => i.bg));
  expect(others.size).toBe(1);
  expect(items[0]?.bg).not.toBe([...others][0]);

  /*
   * ...and it shows that with a WASH, not with the global accent ring.
   *
   * This is the assertion that actually guards the original bug, and it has to
   * live on the KEYBOARD path. `:focus-visible` is engine-heuristic: Chromium
   * declines to match it for focus moved programmatically after a pointer click,
   * so a mouse-opened menu reports no outline whether or not the suppression rule
   * exists, and the same assertion over there proves nothing. After a real key
   * press Chromium does match, so removing `outline: none` from the item rule
   * fails here — verified by reverting it.
   *
   * WKWebView is more liberal still and rang the item on the pointer path too,
   * which is why the screenshot that started this showed a ring on a menu opened
   * by mouse. Nothing automated on macOS can drive WKWebView (CLAUDE.md), so this
   * is the strongest available proxy rather than a proof for the shipping engine.
   */
  const ring = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    return getComputedStyle(el).outlineStyle;
  });
  expect(ring).toBe('none');
});

test('a selected card keeps its opaque surface and gains a leading bar', async ({ page }) => {
  await page.goto('/control.html');
  const list = page.getByRole('list', { name: 'Scripts' });
  await list.locator('.title').first().waitFor();

  // The store falls back to the first script so the Present shortcut has a target
  // on boot. That is a default, not a choice, so nothing may be drawn as chosen.
  await expect(list.locator('[aria-current="true"]')).toHaveCount(0);

  const cardBackground = (title: string) =>
    list
      .locator('.card', { hasText: title })
      .evaluate((el) => getComputedStyle(el).backgroundColor);
  const restingBackground = await cardBackground('Launch keynote');
  // The card is a white panel, not a tint over the canvas.
  expect(restingBackground).toBe('rgb(255, 255, 255)');

  // Choose one for real, then come back to the list.
  await list.getByRole('button', { name: /Weekly product update/ }).click();
  await page.getByRole('textbox', { name: 'Script Markdown' }).waitFor();
  await page.getByRole('button', { name: 'All scripts' }).click();
  await list.locator('.title').first().waitFor();

  // Exactly the chosen card is current now.
  const current = list.locator('[aria-current="true"]');
  await expect(current).toHaveCount(1);
  await expect(current).toContainText('Weekly product update');

  // THE REGRESSION: selection must not swap the surface for a 5% wash. The
  // selected card is the same white as an unselected one.
  expect(await cardBackground('Weekly product update')).toBe(restingBackground);

  // What selection actually adds is an inset accent bar, drawn as a pseudo-element
  // so a rounded box never wears a half-painted one-sided border.
  const bar = await list
    .locator('.card', { hasText: 'Weekly product update' })
    .evaluate((el) => {
      const s = getComputedStyle(el, '::before');
      return { content: s.content, width: s.width, bg: s.backgroundColor };
    });
  expect(bar.content).not.toBe('none');
  expect(bar.width).toBe('3px');
  // Terracotta, and opaque — an alpha fill here would be the old mistake again.
  expect(bar.bg).toBe('rgb(179, 90, 56)');

  // The unselected card has no bar at all.
  const noBar = await list
    .locator('.card', { hasText: 'Launch keynote' })
    .evaluate((el) => getComputedStyle(el, '::before').content);
  expect(noBar).toBe('none');
});

test('the overflow menu opens upward rather than off the bottom of the list', async ({ page }) => {
  // `.page` scrolls, and the menu is absolutely positioned inside it, so the menu
  // on the last card used to be clipped by the bottom of the list.
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: Array.from({ length: 8 }, (_, i) => ({
      id: `4444444${i}-4444-4444-8444-44444444444${i}`,
      title: `Script number ${i + 1}`,
      source: `# Script ${i + 1}\n\nNarration for take ${i + 1}.\n`,
    })),
  });
  await page.goto('/control.html');
  const list = page.getByRole('list', { name: 'Scripts' });
  await list.locator('.title').first().waitFor();

  const trigger = list.getByRole('button', { name: 'Script actions' }).last();
  await trigger.click();
  const menu = page.locator('[role="menu"]');
  await menu.waitFor();

  const triggerBox = await trigger.boundingBox();
  const menuBox = await menu.boundingBox();
  if (!triggerBox || !menuBox) throw new Error('expected both to be laid out');

  // Actually above the trigger — not merely wearing the class that should do it.
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(triggerBox.y + 1);
  // And wholly on screen, which is the point of flipping at all.
  const viewport = page.viewportSize();
  expect(menuBox.y).toBeGreaterThanOrEqual(0);
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(viewport!.height);
});
