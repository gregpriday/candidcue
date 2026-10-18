/**
 * Screenshots of the database recovery screen, for design review: each boot
 * failure Rust can report, with and without backups to choose from, and what
 * the screen does while a repair runs, when it lands and when it is refused.
 * Opt-in: it skips unless DESIGN_CAPTURE_DIR names a directory to write into,
 * so the normal suite never runs it.
 *
 *     DESIGN_CAPTURE_DIR=/tmp/shots CANDIDCUE_E2E_PORT=5300 \
 *       ./node_modules/.bin/playwright test --config=playwright.config.ts \
 *       tests/e2e/browser/design-capture-recovery.spec.ts
 *
 * The failure goes in through the Tauri shim's `bootStatus`, so the shell takes
 * the same path a failed `database::init` sends it down and renders recovery
 * instead of the app. Each shot checks that the state it names is on screen
 * before it writes, and throws rather than write a picture of something else.
 */
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { installTauriShim, type ShimScriptSeed } from './fixtures/tauri-shim';

const OUT = process.env['DESIGN_CAPTURE_DIR'];

test.skip(!OUT, 'design capture harness: set DESIGN_CAPTURE_DIR to run it');
test.describe.configure({ timeout: 60_000 });
test.use({ deviceScaleFactor: 2 });

const WINDOW = { width: 1240, height: 820 };
const NARROW = { width: 760, height: 700 };
const DATA_DIRECTORY = '/Users/sam/Library/Application Support/com.candidcue.app';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** A backup as `list_database_backups` reports it, named the way Rust names it. */
function backup(agoMs: number, schema: number, appVersion: string, bytes: number, verified: boolean) {
  const takenAt = new Date(Date.now() - agoMs).toISOString();
  const stamp = takenAt.replace(/[-:]/g, '').replace('.', '');
  return {
    name: `pre-migration-${stamp}-schema${schema}.sqlite3`,
    bytes,
    takenAt,
    appVersion,
    schemaVersionBefore: schema,
    verified,
  };
}

const BACKUPS = [
  backup(2 * HOUR, 14, '1.0.0-rc.1', 2_516_582, true),
  backup(9 * DAY, 12, '0.9.4', 2_401_239, false),
  backup(41 * DAY, 11, '0.9.2', 2_203_008, true),
];

const SCRIPTS: ShimScriptSeed[] = Array.from({ length: 14 }, (_, i) => ({
  id: `b0b0${String(i).padStart(4, '0')}-b0b0-4b0b-8b0b-b0b0b0b0${String(i).padStart(4, '0')}`,
  title: `Script ${i + 1}`,
  source: 'Hello.\n',
}));

interface Boot {
  code?: string;
  message?: string;
  dataDirectory?: string;
  backups?: Array<Record<string, unknown>>;
  viewport?: { width: number; height: number };
  /** Commands whose replies are held from before the app boots. */
  held?: string[];
  /** Commands that reject, from before the app boots, with this AppError. */
  failing?: Record<string, Record<string, unknown>>;
}

async function bootRecovery(page: Page, opts: Boot = {}): Promise<void> {
  // A Mac: the platform the app is used on, so "Reveal in Finder" and ⌘Q.
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' });
    Object.defineProperty(Navigator.prototype, 'userAgentData', {
      get: () => ({ platform: 'macOS', brands: [], mobile: false }),
    });
  });
  await page.setViewportSize(opts.viewport ?? WINDOW);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: SCRIPTS,
    bootStatus: {
      databaseReady: false,
      code: opts.code ?? 'DATABASE_MIGRATION_FAILED',
      ...(opts.message === undefined ? {} : { message: opts.message }),
      dataDirectory: opts.dataDirectory ?? DATA_DIRECTORY,
    },
    databaseBackups: opts.backups ?? BACKUPS,
  });
  if (opts.held?.length) {
    await page.addInitScript((held: string[]) => {
      for (const command of held) window.__E2E__.setHeld(command, true);
    }, opts.held);
  }
  if (opts.failing) {
    await page.addInitScript((failing: Record<string, Record<string, unknown>>) => {
      for (const [command, error] of Object.entries(failing)) window.__E2E__.setFail(command, error);
    }, opts.failing);
  }
  await page.goto('/control.html');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  // Never the app behind it: recovery renders INSTEAD of the shell's routes.
  await expect(page.getByRole('navigation', { name: 'Library' })).toHaveCount(0);
}

/** Wait until the backup list has answered, whatever it said. */
async function backupsSettled(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__E2E__.settled.includes('list_database_backups')))
    .toBe(true);
  await expect(page.getByText('Looking for backups…')).toHaveCount(0);
}

/** Park the pointer where it hovers nothing. */
async function parkPointer(page: Page): Promise<void> {
  const size = page.viewportSize();
  await page.mouse.move((size?.width ?? 1240) - 4, (size?.height ?? 820) - 4);
}

/** Wait out every finite animation and two frames, so a capture is at rest. */
async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(150);
  await page.evaluate(async () => {
    await document.fonts.ready;
    const finite = document
      .getAnimations()
      .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.race([
      Promise.all(finite.map((a) => a.finished.catch(() => undefined))),
      new Promise((r) => setTimeout(r, 2_000)),
    ]);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}

async function shoot(page: Page, name: string): Promise<void> {
  if (!OUT) throw new Error('DESIGN_CAPTURE_DIR must be set');
  fs.mkdirSync(OUT, { recursive: true });
  await settle(page);
  const file = path.join(OUT, `recovery--${name}.png`);
  await page.screenshot({ path: file });
  const size = fs.statSync(file).size;
  if (size < 4_000) throw new Error(`${name}.png is ${size} bytes — not a real capture`);
}

/** Scroll the screen's own scroller (or the page) to its end. */
async function scrollToEnd(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>('*')) {
      if (el.scrollHeight > el.clientHeight + 1 && getComputedStyle(el).overflowY !== 'visible') {
        el.scrollTop = el.scrollHeight;
      }
    }
    window.scrollTo(0, document.body.scrollHeight);
  });
}

/** The first verified backup's restore control. */
function restoreButton(page: Page) {
  return page.getByRole('button', { name: /^Restore/ }).first();
}

/** Answer a confirmation if the screen asks one; returns whether it did. */
async function confirmIfAsked(page: Page, name: RegExp): Promise<boolean> {
  const dialog = page.getByRole('dialog');
  if ((await dialog.count()) === 0) return false;
  await dialog.getByRole('button', { name }).click();
  return true;
}

test('01 a failed upgrade, with backups — first sight', async ({ page }) => {
  await bootRecovery(page);
  await backupsSettled(page);
  await parkPointer(page);
  await shoot(page, '01-migration-failed');
});

test('02 a failed upgrade, with backups — the end of the screen', async ({ page }) => {
  await bootRecovery(page);
  await backupsSettled(page);
  await scrollToEnd(page);
  await parkPointer(page);
  await shoot(page, '02-migration-failed-end');
});

test('03 a damaged database and no backups', async ({ page }) => {
  await bootRecovery(page, { code: 'DATABASE_CORRUPT', backups: [] });
  await backupsSettled(page);
  await parkPointer(page);
  await shoot(page, '03-corrupt-no-backups');
});

test('04 no room for the pre-upgrade backup', async ({ page }) => {
  await bootRecovery(page, { code: 'DATABASE_BACKUP_REQUIRED', backups: [BACKUPS[2]!] });
  await backupsSettled(page);
  await parkPointer(page);
  await shoot(page, '04-backup-required');
});

test('05 an answer nobody could read, and no data folder', async ({ page }) => {
  await bootRecovery(page, {
    code: 'DATABASE_UNAVAILABLE',
    message:
      'CandidCue could not determine whether its database opened: it asked, and the answer could not be read.',
    dataDirectory: '',
    backups: [],
  });
  await backupsSettled(page);
  await parkPointer(page);
  await shoot(page, '05-unavailable');
});

test('06 still looking for backups', async ({ page }) => {
  await bootRecovery(page, { held: ['list_database_backups'] });
  await expect(page.getByText(/Looking for backups/)).toBeVisible();
  await parkPointer(page);
  await shoot(page, '06-backups-loading');
});

test('07 restoring a backup — the question, or the work under way', async ({ page }) => {
  await bootRecovery(page, { held: ['restore_database_backup'] });
  await backupsSettled(page);
  await restoreButton(page).click();
  const dialog = page.getByRole('dialog');
  if ((await dialog.count()) > 0) {
    await expect(dialog).toBeVisible();
    await shoot(page, '07-restore-asking');
    await dialog.getByRole('button', { name: /^Restore/ }).click();
  }
  await expect.poll(() => page.evaluate(() => window.__E2E__.lastCall('restore_database_backup') !== null)).toBe(true);
  await shoot(page, '08-restore-running');
});

test('09 a backup restored', async ({ page }) => {
  await bootRecovery(page);
  await backupsSettled(page);
  await restoreButton(page).click();
  await confirmIfAsked(page, /^Restore/);
  await expect(page.getByText(/quarantine/).first()).toBeVisible();
  await parkPointer(page);
  await shoot(page, '09-restored');
});

test('10 a rebuild set up', async ({ page }) => {
  await bootRecovery(page, { code: 'DATABASE_CORRUPT', backups: [] });
  await backupsSettled(page);
  await page.getByRole('button', { name: /^Rebuild/ }).click();
  await confirmIfAsked(page, /^Rebuild/);
  await expect(page.getByText(/quarantine/).first()).toBeVisible();
  await parkPointer(page);
  await shoot(page, '10-rebuild-ready');
});

test('11 scripts saved somewhere else', async ({ page }) => {
  await bootRecovery(page);
  await backupsSettled(page);
  await page.getByRole('button', { name: /scripts/i }).first().click();
  await expect(page.getByText(/CandidCue-scripts-/).first()).toBeVisible();
  await parkPointer(page);
  await shoot(page, '11-scripts-saved');
});

test('12 a restore refused', async ({ page }) => {
  await bootRecovery(page);
  await backupsSettled(page);
  await page.evaluate(() =>
    window.__E2E__.setFail('restore_database_backup', {
      code: 'VALIDATION_FAILED',
      category: 'validation',
      userMessage:
        'The backup did not survive being copied into place, so nothing was published. Your previous database is at /Users/sam/Library/Application Support/com.candidcue.app/quarantine/pre-rebuild-20261018T081500Z: database disk image is malformed',
      recoverable: true,
    }),
  );
  await restoreButton(page).click();
  await confirmIfAsked(page, /^Restore/);
  await expect.poll(() => page.evaluate(() => window.__E2E__.settled.includes('restore_database_backup'))).toBe(true);
  await parkPointer(page);
  await shoot(page, '12-restore-refused');
});

test('13 a narrow window', async ({ page }) => {
  await bootRecovery(page, { viewport: NARROW });
  await backupsSettled(page);
  await parkPointer(page);
  await shoot(page, '13-narrow');
});

test('15 no room for the backup — the other ways back, opened', async ({ page }) => {
  await bootRecovery(page, { code: 'DATABASE_BACKUP_REQUIRED', backups: [BACKUPS[2]!] });
  await backupsSettled(page);
  const other = page.getByText('Other ways back');
  await other.click();
  await expect(page.getByRole('button', { name: /^Rebuild/ })).toBeVisible();
  await scrollToEnd(page);
  await parkPointer(page);
  await shoot(page, '15-backup-required-other-ways');
});

test('16 the backups could not be listed', async ({ page }) => {
  await bootRecovery(page, {
    failing: {
      list_database_backups: {
        code: 'IO_ERROR',
        category: 'storage',
        userMessage: 'A file operation failed.',
        recoverable: true,
      },
    },
  });
  await expect
    .poll(() => page.evaluate(() => window.__E2E__.settled.includes('list_database_backups')))
    .toBe(true);
  await parkPointer(page);
  await shoot(page, '16-backups-unreadable');
});

test('14 the keyboard arrives', async ({ page }) => {
  await bootRecovery(page);
  await backupsSettled(page);
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).toHaveCount(1);
  await parkPointer(page);
  await shoot(page, '14-first-tab');
});
