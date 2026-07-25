import { test, expect } from '@playwright/test';
import { installTauriShim, SCRIPT_CONFLICT_ERROR } from './fixtures/tauri-shim';

/**
 * Library -> Editor journey, SHIM-BACKED (production IPC path).
 *
 * Real behaviour asserted:
 *   - the seeded script appears in the Library list;
 *   - opening it reaches the editor with the script's title and body;
 *   - typing autosaves and the header reports "Saved" (a real save_script call);
 *   - a save that REJECTS with a SCRIPT_CONFLICT AppError drives the F.8
 *     external-change resolution sheet — the path that was unreachable in
 *     production because only the mock backend answered with SaveResult.status.
 */

const SCRIPT = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Launch keynote',
  source: '# Launch keynote\n\nWelcome everyone to the show.\n',
};

test.beforeEach(async ({ page }) => {
  await installTauriShim(page, { welcomed: true, seedScripts: [SCRIPT] });
});

test('opens a seeded script, edits it, and autosaves to a real save_script call', async ({ page }) => {
  await page.goto('/control.html');

  // Library renders the seeded script (proves the boot list_scripts round-trip).
  const list = page.getByRole('list', { name: 'Scripts' });
  await expect(list.locator('.title', { hasText: 'Launch keynote' })).toBeVisible();

  // Open it — the editor shows the title and the body text.
  await list.getByRole('button', { name: /Launch keynote/ }).click();
  const editorSurface = page.getByRole('textbox', { name: 'Script Markdown' });
  await expect(editorSurface).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('Welcome everyone to the show');

  // Type — autosave (500 ms debounce) fires a real save_script. Wait on the
  // actual IPC call, not the header (which already reads "Saved" from open).
  await editorSurface.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' A second line of narration.');
  await expect
    .poll(() => page.evaluate(() => window.__E2E__.calls.filter((c) => c.command === 'save_script').length))
    .toBeGreaterThan(0);

  // The header reports "Saved" from the resolved SaveResult (no mock `status`).
  await expect(page.getByText('Saved')).toBeVisible();

  // The frontend actually put a save_script on the wire with the expected shape.
  const saveCall = await page.evaluate(() => window.__E2E__.lastCall('save_script'));
  expect(saveCall).not.toBeNull();
  expect((saveCall!.args as Record<string, unknown>)['scriptId']).toBe(SCRIPT.id);
  expect((saveCall!.args as Record<string, unknown>)['source']).toContain('A second line of narration.');
});

test('a SCRIPT_CONFLICT rejection drives the F.8 external-change resolution sheet', async ({ page }) => {
  await page.goto('/control.html');
  const list = page.getByRole('list', { name: 'Scripts' });
  await list.getByRole('button', { name: /Launch keynote/ }).click();
  const editorSurface = page.getByRole('textbox', { name: 'Script Markdown' });
  await expect(editorSurface).toBeVisible();

  // Now the backend rejects the next save exactly as Rust does when the file
  // changed on disk: an AppError with code SCRIPT_CONFLICT, NOT a SaveResult.
  await page.evaluate((err) => window.__E2E__.setFail('save_script', err), SCRIPT_CONFLICT_ERROR);

  await editorSurface.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Text that will collide with the disk version.');

  // Confirm the save was actually attempted (and thus rejected) before asserting UI.
  await expect
    .poll(() => page.evaluate(() => window.__E2E__.calls.filter((c) => c.command === 'save_script').length))
    .toBeGreaterThan(0);

  // The header swaps to the conflict affordance (not the generic "Save failed").
  const conflictButton = page.getByRole('button', { name: /Changed outside CandidCue/ });
  await expect(conflictButton).toBeVisible();

  // Opening it reveals the three-way resolution sheet — the whole point of F.8.
  await conflictButton.click();
  const sheet = page.getByRole('dialog', { name: 'This script changed on disk' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Keep CandidCue version' })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Load disk version' })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Save both' })).toBeVisible();
});
