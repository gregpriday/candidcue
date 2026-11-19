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
 * ABOVE those buttons, and there before they can be pressed. These prove the
 * shell side: that the boot asks and waits, where the card lands on each
 * screen, that recovery never waits for it, and that a reload says it again.
 * Which outcome Rust reports is `legacy_data.rs`'s own tests.
 */

const OLD = '/Users/someone/Library/Application Support/com.candidcue.app';

const FAILED = {
  kind: 'failed',
  oldFolder: OLD,
  reason:
    'CandidCue has not finished a recovery (restore-pending.json is still there); open the build ' +
    'that wrote it once to let it finish',
};

const ABANDONED = { kind: 'abandoned', oldFolder: OLD };

const CREATE_BUTTONS = ['Create your first script', 'Open the sample script', 'Import Markdown'];

function notice(page: Page) {
  return page.getByTestId('legacy-library-notice');
}

function calls(page: Page, command: string) {
  return page.evaluate(
    (name) => window.__E2E__.calls.filter((c) => c.command === name).map((c) => c.args ?? {}),
    command,
  );
}

test('Welcome waits for the notice, then shows it above the buttons that would end the retry', async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await installTauriShim(page, {
    legacyLibraryNotice: FAILED,
    heldAtBoot: ['get_legacy_library_notice'],
  });
  await page.goto('/control.html');

  // Asked, and still unanswered: nothing that creates a script is on screen.
  await expect.poll(() => calls(page, 'get_legacy_library_notice')).toHaveLength(1);
  for (const name of CREATE_BUTTONS) {
    await expect(page.getByRole('button', { name })).toHaveCount(0);
  }
  await page.evaluate(() => window.__E2E__.setHeld('get_legacy_library_notice', false));

  const card = notice(page);
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-kind', 'failed');
  await expect(card.getByTestId('legacy-library-path')).toHaveText(OLD);
  await expect(card.getByTestId('legacy-library-reason')).toHaveText(FAILED.reason);
  await expect(card.getByTestId('legacy-library-next-launch')).toContainText('sample script included');
  await expect(notice(page)).toHaveCount(1);

  // Above every way of creating a script: first in the document AND on screen.
  const cardBox = await card.boundingBox();
  for (const name of CREATE_BUTTONS) {
    const button = page.getByRole('button', { name });
    await expect(button).toBeVisible();
    const follows = await card.evaluate(
      (element, label) => {
        const target = [...document.querySelectorAll('button')].find(
          (b) => b.textContent?.trim() === label,
        );
        return target !== undefined && (element.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      },
      name,
    );
    expect(follows, name).toBe(true);
    const box = await button.boundingBox();
    expect(box!.y, name).toBeGreaterThanOrEqual(cardBox!.y + cardBox!.height);
  }

  // Showing the folder sends no path: Rust reveals the one it reported.
  await card.getByRole('button', { name: /Reveal in Finder|Show in/ }).click();
  await expect.poll(() => calls(page, 'reveal_legacy_library')).toEqual([{}]);

  await card.getByRole('button', { name: 'Dismiss' }).click();
  await expect(notice(page)).toHaveCount(0);

  // The shim holds the reply again on a reload, as on the first boot.
  await page.reload();
  await expect.poll(() => calls(page, 'get_legacy_library_notice')).toHaveLength(1);
  await page.evaluate(() => window.__E2E__.setHeld('get_legacy_library_notice', false));
  await expect(notice(page)).toBeVisible();

  errors.expectClean();
});

test('past Welcome, the Library says it at the head of its list', async ({ page }) => {
  const errors = watchPageErrors(page);
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [{ id: 'kept', title: 'Written here', source: '# Written here\n' }],
    legacyLibraryNotice: ABANDONED,
  });
  await page.goto('/control.html');

  const card = notice(page);
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-kind', 'abandoned');
  await expect(card.getByTestId('legacy-library-kept')).toContainText('will not copy the old one over it');
  await expect(card.getByTestId('legacy-library-recover')).toContainText('File › Import Markdown…');
  // In the page, not over it: the list's own rows stay clear of it.
  expect(await card.evaluate((element) => getComputedStyle(element).position)).toBe('static');
  const row = page.getByText('Written here').first();
  await expect(row).toBeVisible();
  const [cardBox, rowBox] = [await card.boundingBox(), await row.boundingBox()];
  expect(rowBox!.y).toBeGreaterThanOrEqual(cardBox!.y + cardBox!.height);

  errors.expectClean();
});

test('the recovery screen does not wait for it, and says it once it comes', async ({ page }) => {
  await installTauriShim(page, {
    bootStatus: {
      databaseReady: false,
      code: 'DATABASE_CORRUPT',
      message: 'The database is damaged.',
      dataDirectory: '/tmp/speaking-glass-e2e',
    },
    legacyLibraryNotice: ABANDONED,
    heldAtBoot: ['get_legacy_library_notice'],
  });
  await page.goto('/control.html');

  // The repairs are up while the notice is still unanswered.
  await expect(page.locator('main.recovery')).toBeVisible();
  await expect(notice(page)).toHaveCount(0);
  await page.evaluate(() => window.__E2E__.setHeld('get_legacy_library_notice', false));

  const card = notice(page);
  await expect(card).toBeVisible();
  expect(await card.evaluate((element) => element.closest('main.recovery') !== null)).toBe(true);
  // Both ways of bringing scripts in need a library that opens.
  await expect(card.getByTestId('legacy-library-recover')).toContainText(
    'Once Speaking Glass can open its library',
  );
});

test('a launch that opens a script is pointed at the Library', async ({ page }) => {
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [{ id: 'kept', title: 'Written here', source: '# Written here\n', lastOpenedAt: new Date().toISOString() }],
    legacyLibraryNotice: ABANDONED,
    openTo: 'last_script',
  });
  await page.goto('/control.html');
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeVisible();
  await expect(page.getByText('Your scripts from CandidCue are not in this library.')).toBeVisible();
  await page.getByRole('button', { name: 'Open Library' }).click();
  await expect(notice(page)).toBeVisible();
});

test('nothing to say shows nothing', async ({ page }) => {
  await installTauriShim(page, {});
  await page.goto('/control.html');
  await expect(page.getByRole('button', { name: 'Open the sample script' })).toBeVisible();
  await expect.poll(() => calls(page, 'get_legacy_library_notice')).toHaveLength(1);
  await expect(notice(page)).toHaveCount(0);
});
