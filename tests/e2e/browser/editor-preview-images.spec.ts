import { test, expect } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';
import { openScript } from './fixtures/library';

/**
 * Pictures in the editor preview (#250), SHIM-BACKED (production IPC path).
 *
 * Every image used to render as `[Image: alt]` with no `<img>` at all, so the
 * only way to see which picture went in was to start a take, and one whose
 * file was missing looked exactly like one that worked.
 *
 * Real behaviour asserted: the real compile worker finds the images, the route
 * asks `resolve_asset_urls` for them, and the url it is given is decoded and
 * drawn in Preview and in Both; the image Rust cannot find is marked missing;
 * the remote one is labelled and never requested.
 *
 * NOT proven here: the url is a `data:` PNG, so Rust's lookup, the dynamic
 * asset-protocol scope and WKWebView's `asset://` loading are all untested.
 */

/**
 * A 2400x40 PNG: wider than any preview pane, so the picture has to be scaled
 * down to fit, and a decoded image is distinguishable from a broken one.
 */
const WIDE_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAACWAAAAAoCAIAAAD1vFbrAAABcklEQVR42u3ZQQ0AAAjEsBOGEhQjCxskNKmCfZfpAgAAAAAAAJ6IBAAAAAAAAGAQAgAAAAAAAAYhAAAAAAAAYBACAAAAAAAABiEAAAAAAABgEAIAAAAAAAAGIQAAAAAAAGAQAgAAAAAAAAYhAAAAAAAAYBACAAAAAAAABiEAAAAAAABgEAIAAAAAAIBBCAAAAAAAABiEAAAAAAAAgEEIAAAAAAAAGIQAAAAAAACAQQgAAAAAAAAYhAAAAAAAAIBBCAAAAAAAABiEAAAAAAAAgEEIAAAAAAAAGIQAAAAAAACAQQgAAAAAAAAGIQAAAAAAAGAQAgAAAAAAAAYhAAAAAAAAYBACAAAAAAAABiEAAAAAAABgEAIAAAAAAAAGIQAAAAAAAGAQAgAAAAAAAAYhAAAAAAAAYBACAAAAAAAABiEAAAAAAAAYhAAAAAAAAIBBCAAAAAAAABiEAAAAAAAAgEEIAAAAAAAAGIQAAAAAAADADQuPZNAB9WEucQAAAABJRU5ErkJggg==';

const SCRIPT = {
  id: '33333333-3333-4333-8333-333333333333',
  title: 'Revenue review',
  source: [
    '# Revenue review',
    '',
    'Here is how the year went.',
    '',
    '![Revenue by month](assets/revenue.png)',
    '',
    '![Old screenshot](assets/gone.png)',
    '',
    '![Remote chart](https://example.com/chart.png)',
    '',
  ].join('\n'),
};

test.beforeEach(async ({ page }) => {
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [SCRIPT],
    assetUrls: { 'assets/revenue.png': WIDE_PNG },
  });
});

test('Preview and Both draw the picture and mark the one that is missing', async ({ page }) => {
  const remoteRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('example.com')) remoteRequests.push(request.url());
  });

  await page.goto('/control.html');
  await openScript(page, /Revenue review/);

  const modes = page.getByRole('radiogroup', { name: 'Editor mode' });
  await modes.getByRole('radio', { name: 'Preview' }).click();

  const preview = page.locator('.preview');
  const picture = preview.getByRole('img', { name: 'Revenue by month' });
  await expect(picture).toBeVisible();
  // Decoded, not merely present: a broken image is an `<img>` too.
  await expect
    .poll(() => picture.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
    .toBe(2400);

  const missing = preview.locator('[data-image-state="missing"]');
  await expect(missing).toContainText('Image not found');
  await expect(missing).toContainText('Old screenshot');
  await expect(preview.getByRole('img', { name: 'Old screenshot' })).toHaveCount(0);

  await expect(preview.locator('[data-image-state="remote"]')).toContainText(
    'Remote image not shown',
  );
  await expect(preview).not.toContainText('[Image:');

  // One lookup, for the two local images, under the script's own id.
  const lookups = await page.evaluate(() =>
    (
      window as unknown as { __E2E__: { calls: Array<{ command: string; args: unknown }> } }
    ).__E2E__.calls.filter((call) => call.command === 'resolve_asset_urls'),
  );
  expect(lookups).toHaveLength(1);
  const args = lookups[0]!.args as {
    scriptId: string;
    assetsToResolve: Array<{ id: string; href: string }>;
  };
  expect(args.scriptId).toBe(SCRIPT.id);
  expect(args.assetsToResolve.map((a) => a.href).sort()).toEqual([
    'assets/gone.png',
    'assets/revenue.png',
  ]);

  // Both: the same picture beside the source, scaled down to its pane rather
  // than overflowing it, and not squashed on the way.
  await modes.getByRole('radio', { name: 'Both' }).click();
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeVisible();
  await expect(picture).toBeVisible();
  const box = await picture.evaluate((img: HTMLImageElement) => {
    const pane = img.closest('.preview')!.getBoundingClientRect();
    const rect = img.getBoundingClientRect();
    return {
      width: rect.width,
      height: rect.height,
      paneWidth: pane.width,
      inside: rect.left >= pane.left - 0.5 && rect.right <= pane.right + 0.5,
    };
  });
  expect(box.paneWidth).toBeLessThan(2400);
  expect(box.width).toBeGreaterThan(0);
  expect(box.width).toBeLessThan(2400);
  expect(box.inside).toBe(true);
  expect(box.height / box.width).toBeCloseTo(40 / 2400, 2);

  expect(remoteRequests).toEqual([]);
});
