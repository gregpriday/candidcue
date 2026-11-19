import { test, expect, type Page } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';
import { watchPageErrors } from './fixtures/page-errors';

/**
 * The CandidCue library notice reaches the window (#454), SHIM-BACKED.
 *
 * Rust copies the CandidCue data folder into place at launch, and when it
 * cannot, the window opens on an empty library while the old scripts are still
 * on disk. Creating a script here, the Welcome sample included, is what the
 * next launch reads as "keep this library", so the notice has to be on Welcome
 * BEFORE those buttons, and on the first paint rather than after a delay. These
 * prove the shell side: that the boot asks, where the card lands on each kind
 * of screen, and that a reload says it again. The Rust side (which outcome is
 * reported) is `legacy_data.rs`'s own tests.
 */

const OLD = '/Users/someone/Library/Application Support/com.candidcue.app';

const FAILED = {
  kind: 'failed',
  oldFolder: OLD,
  reason:
    'CandidCue has not finished a recovery (restore-pending.json is still there); open the build ' +
    'that wrote it once to let it finish',
};

function notice(page: Page) {
  return page.getByTestId('legacy-library-notice');
}

test('Welcome says it above the buttons that would end the retry, and a reload says it again', async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await installTauriShim(page, { legacyLibraryNotice: FAILED });
  await page.goto('/control.html');

  const card = notice(page);
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-kind', 'failed');
  await expect(card.getByTestId('legacy-library-path')).toHaveText(OLD);
  await expect(card.getByTestId('legacy-library-next-launch')).toContainText('sample script included');
  // One card, and it is Welcome's own: the floating one stands down here.
  await expect(notice(page)).toHaveCount(1);

  // Above every way of creating a script, not merely somewhere on the page.
  const sample = page.getByRole('button', { name: 'Open the sample script' });
  await expect(sample).toBeVisible();
  const precedes = await card.evaluate((element) => {
    const buttons = [...document.querySelectorAll('button')].filter((b) =>
      ['Create your first script', 'Open the sample script', 'Import Markdown'].includes(
        b.textContent?.trim() ?? '',
      ),
    );
    return (
      buttons.length === 3 &&
      buttons.every((b) => element.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    );
  });
  expect(precedes).toBe(true);

  // Showing the folder sends no path: Rust reveals the one it reported.
  await card.getByRole('button', { name: /Reveal in Finder|Show in/ }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__E2E__.calls
          .filter((c) => c.command === 'reveal_legacy_library')
          .map((c) => c.args ?? {}),
      ),
    )
    .toEqual([{}]);

  await card.getByRole('button', { name: 'Dismiss' }).click();
  await expect(notice(page)).toHaveCount(0);

  await page.reload();
  await expect(notice(page)).toBeVisible();

  errors.expectClean();
});

test('past Welcome, an abandoned copy floats over the library', async ({ page }) => {
  const errors = watchPageErrors(page);
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [{ id: 'kept', title: 'Written here', source: '# Written here\n' }],
    legacyLibraryNotice: { kind: 'abandoned', oldFolder: OLD },
  });
  await page.goto('/control.html');

  const card = notice(page);
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-kind', 'abandoned');
  await expect(card).toContainText('will not copy the old one again');
  await expect(card.getByTestId('legacy-library-recover')).toContainText('File › Import Markdown…');

  errors.expectClean();
});

test('the recovery screen says it too, and puts the import off until the library opens', async ({
  page,
}) => {
  await installTauriShim(page, {
    bootStatus: {
      databaseReady: false,
      code: 'DATABASE_CORRUPT',
      message: 'The database is damaged.',
      dataDirectory: '/tmp/speaking-glass-e2e',
    },
    legacyLibraryNotice: { kind: 'abandoned', oldFolder: OLD },
  });
  await page.goto('/control.html');

  const card = notice(page);
  await expect(card).toBeVisible();
  await expect(card.getByTestId('legacy-library-recover')).toContainText(
    'Once Speaking Glass can open its library',
  );
});

test('a clean install or a successful copy shows nothing', async ({ page }) => {
  await installTauriShim(page, {});
  await page.goto('/control.html');
  await expect(page.getByRole('button', { name: 'Open the sample script' })).toBeVisible();
  await expect(notice(page)).toHaveCount(0);
});
