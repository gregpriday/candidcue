import { test, expect } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';

/**
 * The focus policy, in an engine that actually resolves stylesheets.
 *
 * Issue #126's core defect was that `tokens.css` gave every raw `<button>` an
 * accent ring, so each row and tile pattern had to remember to cancel it and
 * the ones that forgot wore a terracotta ring around a whole surface. The fix
 * inverts the default — unmarked buttons take a quiet inset edge, and a genuine
 * control opts in with `data-focus="control"`.
 *
 * That is not assertable anywhere below this layer. jsdom resolves no
 * stylesheets, so `tests/dom/**` can see the `data-focus` attribute but never
 * the outline it produces; only a real engine computes `:focus-visible`.
 *
 * Focus is driven with real Tab presses. `:focus-visible` is engine-heuristic:
 * Chromium declines to match it for focus moved programmatically after a
 * pointer click, so an assertion on a mouse-driven path would report
 * `outline-style: none` whether or not the policy exists — coverage that cannot
 * fail. Sidebar is the specimen because it holds both cases side by side: the
 * "New script" button is a control, the navigation entries are rows.
 *
 * Says nothing about WKWebView, which is what ships — see CLAUDE.md.
 */

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1240, height: 800 });
  await installTauriShim(page, { welcomed: true, seedScripts: [] });
});

/** Tab until the focused element matches, returning its computed focus ring. */
async function tabTo(
  page: import('@playwright/test').Page,
  selector: string,
): Promise<{ color: string; style: string; offset: string; quiet: string; ring: string }> {
  for (let i = 0; i < 40; i++) {
    const found = await page.evaluate((sel) => document.activeElement?.matches(sel) ?? false, selector);
    if (found) break;
    await page.keyboard.press('Tab');
  }

  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const style = getComputedStyle(el);
    // Resolved from the element itself so it picks up the theme actually in
    // force on this route rather than the un-themed :root default.
    const asRgb = (name: string): string => {
      const n = parseInt(style.getPropertyValue(name).trim().replace('#', ''), 16);
      return `rgb(${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff})`;
    };
    return {
      color: style.outlineColor,
      style: style.outlineStyle,
      offset: style.outlineOffset,
      quiet: asRgb('--focus-quiet'),
      ring: asRgb('--focus-ring'),
    };
  });
}

test('a shared control wears the accent ring; a raw row does not', async ({ page }) => {
  await page.goto('/control.html');
  // The sidebar's own button — the empty library renders a second "New script"
  // in the page body, so the role query alone is ambiguous.
  await page.locator('.new-button').waitFor();

  // The control: an explicit data-focus="control" opt-in.
  const control = await tabTo(page, '.new-button');
  expect(control.style, 'a control must still show a focus ring').not.toBe('none');
  expect(control.color).toBe(control.ring);
  // Drawn OUTSIDE the control, the way a ring around a small target should be.
  expect(parseFloat(control.offset)).toBeGreaterThan(0);

  /*
   * The row: an unmarked <button>, which is exactly the shape every route-level
   * row and tile takes. Before the policy inverted, this wore the same
   * terracotta ring as the button above.
   */
  const row = await tabTo(page, '.nav-item');
  expect(row.style, 'a row must still show SOMETHING — quiet is not invisible').not.toBe('none');
  expect(row.color, 'a row must not wear the accent ring').not.toBe(row.ring);
  expect(row.color).toBe(row.quiet);
  // Inset, so it reads as the surface's own edge firming rather than a ring
  // drawn around a whole tile.
  expect(parseFloat(row.offset)).toBeLessThan(0);
});

/**
 * The Dialog defect: `click` reports where the pointer went UP, so a text
 * selection that started in the dialog and overshot the panel dismissed it —
 * take summaries included. Only a real pointer sequence can show this; a
 * synthesised click has no drag to get wrong.
 */
test('a selection drag out of a dialog does not dismiss it', async ({ page }) => {
  await page.goto('/control.html');
  await page.getByRole('button', { name: 'Keyboard shortcuts' }).click();

  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog).toBeVisible();

  const panel = await dialog.boundingBox();
  expect(panel).not.toBeNull();

  // Press inside the panel, drag well clear of it, release over the scrim —
  // the gesture of selecting the last line of text and overshooting.
  await page.mouse.move(panel!.x + panel!.width / 2, panel!.y + panel!.height / 2);
  await page.mouse.down();
  await page.mouse.move(panel!.x + panel!.width / 2, panel!.y + panel!.height + 80, { steps: 10 });
  await page.mouse.up();

  await expect(dialog, 'releasing a panel drag over the scrim must not dismiss').toBeVisible();

  // A genuine click on the scrim still closes it — the fix must not cost the
  // dismissal it is guarding.
  await page.mouse.click(panel!.x + panel!.width / 2, panel!.y + panel!.height + 80);
  await expect(dialog).toBeHidden();
});
