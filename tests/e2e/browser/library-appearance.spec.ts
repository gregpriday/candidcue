import { test, expect } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';
import { collection, openScript, row, rowMenu } from './fixtures/library';

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
  const list = collection(page);
  await list.getByRole('option').first().waitFor();

  await list.getByRole('button', { name: /^Actions for / }).first().click();
  const menu = page.locator('[role="menu"]');
  await menu.waitFor();

  // Focus IS inside the menu — that half of the ARIA pattern must hold.
  // `.item-label` rather than the whole row: a menu row now carries an optional
  // right-aligned shortcut beside its label (§18.3), so `textContent` on the row
  // reads "Duplicate⌘D".
  const focusedLabel = await page.evaluate(() =>
    document.activeElement?.querySelector('.item-label')?.textContent?.trim(),
  );
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
          .map((el) => el.querySelector('.item-label')?.textContent?.trim()),
      backgrounds[0]),
    )
    .toEqual(['Duplicate']);
});

test('Enter on the trigger opens the menu with a visible highlight', async ({ page }) => {
  // A real key press, not a synthesised click: Enter and Space reach a button as
  // a click, so treating every click as pointer-originated left a keyboard user
  // with focus in the menu and nothing drawn to say where.
  await page.goto('/control.html');
  const list = collection(page);
  await list.getByRole('option').first().waitFor();

  const trigger = list.getByRole('button', { name: /^Actions for / }).first();
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

/*
 * ---------------------------------------------------------------------------
 * THIS TEST USED TO ASSERT THE OPPOSITE, AND IT WAS RIGHT TO
 * ---------------------------------------------------------------------------
 * It was called "a card is never painted as the chosen one". Its reasoning was
 * sound for the code it guarded: `selectedId` existed as the Present shortcut's
 * invisible target, so painting a row as chosen would have claimed a selection
 * the user had not made and could not act on.
 *
 * Desktop refinement §10.2 removed the premise. Selection is real now — it is
 * what the context menu, the File commands and the Delete key act on — so it has
 * to be VISIBLE, and the new failure to guard against is the reverse: a
 * selection that is drawn identically whether or not the list has focus, which
 * §23.3 calls out because it leaves a keyboard user unable to tell where the
 * next keystroke will land.
 */
test('the selected row is visibly selected, and focus is distinguishable from it', async ({
  page,
}) => {
  await page.goto('/control.html');
  const list = collection(page);
  await list.getByRole('option').first().waitFor();

  const background = (title: string) =>
    row(page, title).evaluate((el) => getComputedStyle(el).backgroundColor);

  // Click one to select it — a single click selects and does NOT open.
  await row(page, 'Weekly product update').click();
  await expect(row(page, 'Weekly product update')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toHaveCount(0);

  /*
   * POLLED, not read once.
   *
   * The row transitions its background, and `getComputedStyle` during a
   * transition returns the INTERPOLATED value — so a single immediate read
   * catches an alpha partway between transparent and the selected tint, and two
   * such reads can land on the same intermediate value and compare equal. That
   * is what made the first version of this test fail against a correct
   * implementation. The neighbouring menu test polls for the same reason.
   */
  const settledBackground = async (title: string): Promise<string> => {
    let last = '';
    await expect
      .poll(async () => {
        const next = await background(title);
        const stable = next === last;
        last = next;
        return stable;
      })
      .toBe(true);
    return last;
  };

  const selected = await settledBackground('Weekly product update');
  const unselected = await settledBackground('Launch keynote');
  expect(selected).not.toBe(unselected);

  // The selected-and-focused tone must differ from the selected-but-not-focused
  // one: §23.3's requirement, and the easy thing to collapse into one colour.
  await row(page, 'Weekly product update').focus();
  const focusedTone = await settledBackground('Weekly product update');

  await page.getByRole('searchbox', { name: 'Search scripts' }).focus();
  const blurredTone = await settledBackground('Weekly product update');

  expect(focusedTone).not.toBe(blurredTone);
  // …and both still read as "selected" rather than reverting to the plain row.
  expect(blurredTone).not.toBe(unselected);
});

test('selection survives opening a script and coming back', async ({ page }) => {
  // §10.2: selection is a property of the collection, not of the visit. A user
  // who opens a script, edits, and returns should find their place kept.
  await page.goto('/control.html');
  await collection(page).getByRole('option').first().waitFor();

  await openScript(page, /Weekly product update/);
  await page.getByRole('textbox', { name: 'Script Markdown' }).waitFor();
  await page.getByRole('button', { name: 'All scripts' }).click();
  await collection(page).getByRole('option').first().waitFor();

  await expect(row(page, 'Weekly product update')).toHaveAttribute('aria-selected', 'true');
});

test('the overflow menu opens upward rather than off the bottom of the list', async ({ page }) => {
  // `.list-area` scrolls, and the menu is absolutely positioned inside it, so the
  // menu on the last row used to be clipped by the bottom of the list. Twenty-four
  // rows rather than eight: the desktop pass made rows 52px instead of ~100px, so
  // eight of them no longer fill the viewport and there is nothing to flip from.
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: Array.from({ length: 24 }, (_, i) => ({
      // Padded: at two digits the old template produced a nine-character first
      // group, which is not a UUID and which the shim's id handling would treat
      // inconsistently.
      id: `4444${String(i).padStart(4, '0')}-4444-4444-8444-4444444444${String(i).padStart(2, '0')}`,
      title: `Script number ${i + 1}`,
      source: `# Script ${i + 1}\n\nNarration for take ${i + 1}.\n`,
    })),
  });
  await page.goto('/control.html');
  const list = collection(page);
  await list.getByRole('option').first().waitFor();

  /*
   * Hovered first, and that is not a workaround.
   *
   * §10.1: a row's actions are hidden until hover, focus or selection, so the
   * list does not become a wall of buttons. `visibility: hidden` is not
   * clickable, so reaching the last row's overflow means doing what a user does
   * — putting the pointer on the row. Hovering also scrolls it into view, which
   * is what puts the trigger near the bottom edge where the flip matters.
   */
  const lastRow = list.getByRole('option').last();
  await lastRow.scrollIntoViewIfNeeded();
  await lastRow.hover();
  const trigger = lastRow.getByRole('button', { name: /^Actions for / });
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
