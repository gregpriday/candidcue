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
  const matches = (): Promise<boolean> =>
    page.evaluate((sel) => document.activeElement?.matches(sel) ?? false, selector);

  // Checked after the LAST press too: exiting the loop on a press whose result
  // was never read would report "never reached" while focus was in fact on the
  // right element.
  let reached = await matches();
  for (let i = 0; i < 40 && !reached; i++) {
    await page.keyboard.press('Tab');
    reached = await matches();
  }

  /*
   * Assert we ARRIVED. Without this the loop simply runs out and every
   * assertion below is made against whatever element focus happened to land
   * on — and since the page is full of both controls and rows, a run that
   * never reached its target could still find the ring it was looking for and
   * pass. A guard that can report success without having tested anything is
   * worse than no guard.
   */
  const landed = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return el ? `${el.tagName.toLowerCase()}.${el.className}` : 'nothing';
  });
  expect(reached, `Tab never reached "${selector}" — focus stopped on ${landed}`).toBe(true);

  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const style = getComputedStyle(el);
    /*
     * Resolved through a probe rather than parsed. A custom property's computed
     * value is whatever was authored — `#fff`, `rgb(...)`, another `var()` —
     * and hand-parsing six-digit hex turns any of those into a wrong colour
     * (or NaN, which normalises to black and could mask a real mismatch).
     * Letting the engine resolve `color` gives the same `rgb()` form the
     * outline is reported in, whatever the token is written as.
     */
    const asRgb = (name: string): string => {
      const probe = document.createElement('span');
      probe.style.color = `var(${name})`;
      probe.style.display = 'none';
      // Appended INSIDE the focused element so it inherits the same theme.
      el.appendChild(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      return resolved;
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
  await page.getByRole('button', { name: 'New script' }).first().waitFor();

  /*
   * The control is now the TOOLBAR's New script, not the sidebar's.
   *
   * Desktop refinement §7.1 turned the sidebar's raised call-to-action into an
   * ordinary source-list row — so it is deliberately an unmarked row now and
   * wears the quiet edge, which is the very thing the second half of this test
   * asserts. `Button.svelte` is the shared control that opts in, and the
   * Library toolbar renders one.
   */
  const control = await tabTo(page, '.button');
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
  /*
   * Opened with the CHORD, dispatched onto the window.
   *
   * Desktop refinement §7.1 moved Keyboard Shortcuts out of the sidebar and into
   * Help › Keyboard Shortcuts — and a browser-run spec has neither the sidebar
   * row nor a native menu bar to click, so the chord is the only route left.
   *
   * Dispatched rather than pressed with `page.keyboard`, and the difference is
   * about what this test is FOR: its subject is the dialog's pointer handling
   * (a selection drag that overshoots the panel used to dismiss it), not the
   * key that opened it. `keyboard.press` depends on the headless browser window
   * holding OS focus, which is not a property this suite should be asserting on
   * the way to testing something else. `resolveShortcut`'s handling of this
   * chord is covered directly in `tests/unit/control/shortcuts.test.ts`.
   */
  await page.evaluate(() => {
    const isMac = /Mac|iPhone|iPad/.test(
      (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform ??
        navigator.platform,
    );
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: '/',
        metaKey: isMac,
        ctrlKey: !isMac,
        bubbles: true,
      }),
    );
  });

  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog).toBeVisible();

  const panel = await dialog.boundingBox();
  expect(panel).not.toBeNull();
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();

  /*
   * Aim at the middle of the scrim BELOW the panel rather than a fixed overshoot
   * past its edge.
   *
   * The panel caps at `min(80vh, 640px)` and scrolls its own content, so a
   * dialog whose content grows past the cap stops growing on the glass and
   * instead sits taller and closer to the viewport floor. A hardcoded `+ 80`
   * then falls off the bottom of the viewport, where the pointer lands on
   * nothing at all — and a gesture that touches nothing dismisses nothing, so
   * the "must not dismiss" assertion below goes on passing while testing
   * neither the drag nor the guard it exists to protect. Only the click half
   * fails, which reports a Dialog regression that never happened.
   *
   * The midpoint self-scales, and the cap is what guarantees it exists: at most
   * 80vh of panel always leaves scrim underneath, whatever the dialog holds.
   */
  const scrimX = panel!.x + panel!.width / 2;
  const scrimY = (panel!.y + panel!.height + viewport!.height) / 2;

  // ...and prove it landed there, so neither half can be asserted against empty
  // space again.
  const hit = await page.evaluate(
    (point) => document.elementFromPoint(point.x, point.y)?.className ?? null,
    { x: scrimX, y: scrimY },
  );
  expect(hit, 'the release point must be on the scrim').toContain('scrim');

  // Press inside the panel, drag well clear of it, release over the scrim —
  // the gesture of selecting the last line of text and overshooting.
  await page.mouse.move(panel!.x + panel!.width / 2, panel!.y + panel!.height / 2);
  await page.mouse.down();
  await page.mouse.move(scrimX, scrimY, { steps: 10 });
  await page.mouse.up();

  await expect(dialog, 'releasing a panel drag over the scrim must not dismiss').toBeVisible();

  // A genuine click on the scrim still closes it — the fix must not cost the
  // dismissal it is guarding.
  await page.mouse.click(scrimX, scrimY);
  await expect(dialog).toBeHidden();
});
