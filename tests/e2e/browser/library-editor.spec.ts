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

  // Opening it reveals the resolution sheet — the whole point of F.8.
  await conflictButton.click();
  const sheet = page.getByRole('dialog', { name: 'This script changed on disk' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Keep my edits' })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Use disk version' })).toBeVisible();
});

/**
 * The data-loss path (issue #118).
 *
 * By the time this sheet is open every autosave has been refused, so the text
 * typed since the file changed exists only in the editor. "Use disk version"
 * replaces it — and used to do so without writing it anywhere, while the
 * dialog told the user the other version would be kept. This asserts the text
 * reaches the backend BEFORE it leaves the screen.
 */
test('choosing the disk version writes the unsaved text to a new script first', async ({ page }) => {
  await page.goto('/control.html');
  const list = page.getByRole('list', { name: 'Scripts' });
  await list.getByRole('button', { name: /Launch keynote/ }).click();
  const editorSurface = page.getByRole('textbox', { name: 'Script Markdown' });
  await expect(editorSurface).toBeVisible();

  await page.evaluate((err) => window.__E2E__.setFail('save_script', err), SCRIPT_CONFLICT_ERROR);

  const onlyCopy = ' Ten minutes of work that is only in memory.';
  await editorSurface.click();
  await page.keyboard.press('End');
  await page.keyboard.type(onlyCopy);

  await expect
    .poll(() => page.evaluate(() => window.__E2E__.calls.filter((c) => c.command === 'save_script').length))
    .toBeGreaterThan(0);

  await page.getByRole('button', { name: /Changed outside CandidCue/ }).click();
  const sheet = page.getByRole('dialog', { name: 'This script changed on disk' });
  await sheet.getByRole('button', { name: 'Use disk version' }).click();

  // The text was handed to create_script, verbatim, before anything replaced it.
  await expect
    .poll(() => page.evaluate(() => window.__E2E__.calls.filter((c) => c.command === 'create_script').length))
    .toBe(1);
  const created = await page.evaluate(
    () => window.__E2E__.calls.find((c) => c.command === 'create_script')?.args,
  );
  const input = (created as Record<string, unknown>)['input'] as Record<string, unknown>;
  expect(String(input['source'])).toContain(onlyCopy.trim());
  expect(String(input['title'])).toContain('conflict copy');

  await expect(sheet).toBeHidden();
});

/**
 * Switching modes must not throw away the undo history (issue #118).
 *
 * Edit and Split rendered a MarkdownEditor from two different `{#if}` branches
 * and Preview rendered none, so Svelte destroyed the CodeMirror instance — and
 * the history it owns — on every switch. Undo then could not reach anything
 * typed before the switch.
 */
test('the undo history survives an Edit/Split/Preview round trip', async ({ page }) => {
  await page.goto('/control.html');
  const list = page.getByRole('list', { name: 'Scripts' });
  await list.getByRole('button', { name: /Launch keynote/ }).click();
  const editorSurface = page.getByRole('textbox', { name: 'Script Markdown' });
  await expect(editorSurface).toBeVisible();

  const typed = 'A line typed before the mode changed.';
  await editorSurface.click();
  await page.keyboard.press('End');
  await page.keyboard.type(typed);
  await expect(editorSurface).toContainText(typed);

  // Round trip through every mode.
  for (const mode of ['Split', 'Preview', 'Edit']) {
    await page.getByRole('radio', { name: mode }).click();
  }

  // Undo must still reach the edit made before the first switch.
  await editorSurface.click();
  const undo = process.platform === 'darwin' ? 'Meta+z' : 'Control+z';
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press(undo);
    if (!(await editorSurface.textContent())?.includes(typed)) break;
  }
  await expect(editorSurface).not.toContainText(typed);
});
