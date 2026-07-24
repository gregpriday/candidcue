import { test, expect } from '@playwright/test';

/**
 * The stage window, driven directly via /stage.html?preview=1.
 *
 * BOUNDARY (read the report): this exercises the stage RENDERER through the
 * stage's own event protocol on a local bus (src/stage/preview.ts). It does NOT
 * exercise the control->stage channel — cross-window Tauri events do not fire
 * between two browser pages, and the Rust IPC relay that carries them is not
 * reachable here. The coaching-rail CONTENT is likewise not driven by the
 * preview (no coach_rail snapshot is emitted); what is asserted below is the
 * structural band the renderer reserves, plus the reading-band motion the
 * semantic frames drive.
 *
 * Real behaviour asserted:
 *   - the compiled script renders on the glass (heading + narration);
 *   - a reserved band is folded into the scroll plane's bottom padding (§7.1);
 *   - the reading band is live: the script drifts upward as semantic motion
 *     frames advance (not a static frame);
 *   - blanking hides the script instantly without unmounting (§16.6).
 */

function translateY(transform: string): number {
  // matrix(a,b,c,d,tx,ty) or translate3d(...) -> read the vertical component.
  const m = transform.match(/matrix\([^)]*,\s*([-\d.]+)\)/);
  if (m) return parseFloat(m[1]!);
  return 0;
}

test('the preview renders the script, reserves the rail band, and drives the reading band', async ({ page }, testInfo) => {
  await page.goto('/stage.html?preview=1');

  const root = page.locator('.stage-root');
  await expect(root).toHaveAttribute('data-phase', 'live');

  // The compiled document is on the glass.
  await expect(root.getByText('A calm start')).toBeVisible();
  await expect(root.getByText('Welcome back to the channel.')).toBeVisible();

  // §7.1: the rail's reserved band is folded into the scroll plane's bottom
  // padding, so the script never scrolls under the rail.
  const scrollPlane = page.locator('.scroll-plane');
  const paddingBottom = await scrollPlane.evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom));
  expect(paddingBottom).toBeGreaterThan(0);

  await page.screenshot({ path: testInfo.outputPath('stage-preview.png'), fullPage: false });

  // The reading band is LIVE: semantic frames advance, so the script drifts up
  // (translateY grows more negative) rather than sitting on a static frame.
  const first = translateY(await scrollPlane.evaluate((el) => getComputedStyle(el).transform));
  await expect
    .poll(async () => translateY(await scrollPlane.evaluate((el) => getComputedStyle(el).transform)), {
      timeout: 5000,
    })
    .toBeLessThan(first - 5);

  // Blank (§16.6): the script hides instantly, without unmounting.
  await root.press('b');
  await expect(page.locator('.script-holder.blanked')).toHaveCount(1);
  await root.press('b');
  await expect(page.locator('.script-holder.blanked')).toHaveCount(0);
});
