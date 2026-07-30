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

/** A script with nothing in it yet — the state issue #143 is about. */
const BLANK_SCRIPT = {
  id: '22222222-2222-4222-8222-222222222222',
  title: 'Blank canvas',
  source: '',
};

test.beforeEach(async ({ page }) => {
  await installTauriShim(page, { welcomed: true, seedScripts: [SCRIPT, BLANK_SCRIPT] });
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

/**
 * The reserved count line (issue #143).
 *
 * The header renders its metadata line only when it has text, and the editor
 * handed it an empty string until the script had a word in it — so a blank
 * script showed no line at all and the first keystroke inserted one, pushing
 * the editor body down as the author started typing.
 *
 * The unit tests in tests/unit/control/format.test.ts pin what the line SAYS.
 * This pins what the old code actually got wrong: that it is on the glass at
 * zero, and that the header is exactly as tall before the first word as after.
 */
test('the count line is already there on a blank script, and typing does not move it', async ({
  page,
}) => {
  await page.goto('/control.html');

  const list = page.getByRole('list', { name: 'Scripts' });
  await list.getByRole('button', { name: /Blank canvas/ }).click();
  const editorSurface = page.getByRole('textbox', { name: 'Script Markdown' });
  await expect(editorSurface).toBeVisible();

  // Present, and reporting zero rather than staying silent.
  const meta = page.locator('.header .meta');
  await expect(meta).toHaveText('0 words · — · 0 cues');

  // Measured, not merely absent: two null boxes would compare equal below and
  // the height assertion would prove nothing at all.
  const before = await page.locator('.header').boundingBox();
  expect(before?.height).toBeGreaterThan(0);

  await editorSurface.click();
  await page.keyboard.type('Hello');
  await expect(meta).toHaveText('1 word · — · 0 cues');

  // The row was already reserved, so counting up cost the header no height.
  const after = await page.locator('.header').boundingBox();
  expect(after?.height).toBe(before?.height);
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
 * Edit and Preview rendered a MarkdownEditor from different `{#if}` branches,
 * so Svelte destroyed the CodeMirror instance — and the history it owns — on
 * every switch. Undo then could not reach anything typed before the switch.
 */
test('the undo history survives an Edit/Preview round trip', async ({ page }) => {
  await page.goto('/control.html');
  const list = page.getByRole('list', { name: 'Scripts' });
  await list.getByRole('button', { name: /Launch keynote/ }).click();
  const editorSurface = page.getByRole('textbox', { name: 'Script Markdown' });
  await expect(editorSurface).toBeVisible();

  // Two modes, and only two: Split was removed (issue #141).
  const modes = page.getByRole('radiogroup', { name: 'Editor mode' });
  await expect(modes.getByRole('radio')).toHaveText(['Edit', 'Preview']);

  // The document before the edit, so "undo" can be proved to have restored it
  // rather than merely to have removed something.
  const baseline = (await editorSurface.textContent()) ?? '';
  expect(baseline).not.toBe('');

  const typed = 'A line typed before the mode changed.';
  await editorSurface.click();
  await page.keyboard.press('End');
  await page.keyboard.type(typed);
  const edited = (await editorSurface.textContent()) ?? '';
  expect(edited).toContain(typed);
  expect(edited).not.toBe(baseline);

  /*
   * The round trip, ending back where the typing happened.
   *
   * The visibility assertions are the point. Clicking the radios proves
   * nothing on its own: a switch that had quietly stopped changing the mode
   * would still leave the editor on screen the whole time, and the undo below
   * would pass against a CodeMirror that was never hidden — which is the one
   * thing this test exists to rule out.
   */
  await modes.getByRole('radio', { name: 'Preview' }).click();
  await expect(editorSurface).toBeHidden();
  await modes.getByRole('radio', { name: 'Edit' }).click();
  await expect(editorSurface).toBeVisible();

  // The switches themselves changed nothing.
  await expect.poll(() => editorSurface.textContent()).toBe(edited);

  /*
   * ONE undo, and it has to land exactly on the baseline. Undoing in a loop
   * until the text disappears would also pass if the mode switch had reset the
   * document, or if a single undo had emptied it — which is precisely the
   * regression this exists to catch.
   */
  await editorSurface.click();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => editorSurface.textContent()).toBe(baseline);
});

/**
 * The editor arrives in one piece (issue #140).
 *
 * The loading state used to be one line inside the work area, so the header and
 * the insert toolbar assembled around it on their own schedule — and the
 * header's metadata line, which comes from the COMPILE rather than from the
 * document, landed last of all and shoved the toolbar down as it appeared.
 *
 * `get_script` is held open so the covered state is a state a spec can actually
 * look at, rather than something that flickers past between two assertions.
 */
test('covers the whole editor while a script opens, then reveals it complete', async ({ page }) => {
  await page.goto('/control.html');
  await page.evaluate(() => window.__E2E__.setDelay('get_script', 600));

  const list = page.getByRole('list', { name: 'Scripts' });
  await list.getByRole('button', { name: /Launch keynote/ }).click();

  // Covered: the panel is up and NOTHING else of the editor is on screen —
  // not the title, not the insert toolbar, not the text, not the outline.
  const panel = page.getByRole('status').filter({ hasText: 'Opening script…' });
  await expect(panel).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Script title' })).toHaveCount(0);
  await expect(page.getByRole('toolbar', { name: 'Insert' })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Outline' })).toHaveCount(0);

  // Revealed: all of it at once, and the compile-derived metadata is ALREADY
  // there. That last clause is the point — it is what used to arrive late.
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Script title' })).toBeVisible();
  await expect(page.getByRole('toolbar', { name: 'Insert' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeVisible();
  await expect(page.locator('.meta')).toContainText('words');
});

/**
 * Typing must not put the panel back.
 *
 * Every keystroke re-runs the compile, which returns the compile store to
 * `compiling`. If the panel read that status live instead of latching it once
 * per open, it would raise over a working editor and take the CodeMirror
 * instance — and the undo history with it — down with it.
 */
test('a compile during editing neither re-covers the editor nor moves the toolbar', async ({ page }) => {
  await page.goto('/control.html');
  const list = page.getByRole('list', { name: 'Scripts' });
  await list.getByRole('button', { name: /Launch keynote/ }).click();

  const editorSurface = page.getByRole('textbox', { name: 'Script Markdown' });
  await expect(editorSurface).toBeVisible();
  await expect(page.locator('.meta')).toContainText('words');

  // Mark the live CodeMirror node so a remount is detectable as such: a
  // rebuilt editor is a fresh node and does not carry the mark.
  await page.evaluate(() => {
    document.querySelector('.cm-editor')?.setAttribute('data-e2e-original', 'yes');
  });

  const toolbar = page.getByRole('toolbar', { name: 'Insert' });
  const before = await toolbar.boundingBox();
  const metaBefore = await page.locator('.meta').textContent();

  await editorSurface.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Several more spoken words for the counter to find.');

  // The word count moved, so a compile really did run and land.
  await expect.poll(() => page.locator('.meta').textContent()).not.toBe(metaBefore);

  // The panel never came back, and the editor is the SAME instance.
  await expect(page.getByRole('status').filter({ hasText: 'Opening script…' })).toHaveCount(0);
  expect(await page.locator('.cm-editor').getAttribute('data-e2e-original')).toBe('yes');

  // And the toolbar has not moved a pixel: the metadata row holds its height
  // whether or not there is metadata to put in it.
  expect((await toolbar.boundingBox())?.y).toBe(before?.y);
});

/**
 * Emptying the script takes the metadata away again — and that must not move
 * the toolbar either. This is the direction the reserved row exists for that
 * waiting on the first compile cannot cover on its own.
 */
test('emptying the script drops the metadata without moving the toolbar', async ({ page }) => {
  await page.goto('/control.html');
  const list = page.getByRole('list', { name: 'Scripts' });
  await list.getByRole('button', { name: /Launch keynote/ }).click();

  const editorSurface = page.getByRole('textbox', { name: 'Script Markdown' });
  await expect(editorSurface).toBeVisible();
  await expect(page.locator('.meta')).toContainText('words');

  const toolbar = page.getByRole('toolbar', { name: 'Insert' });
  const before = await toolbar.boundingBox();

  await editorSurface.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');

  // No spoken words left, so the metadata has nothing to report.
  await expect.poll(() => page.locator('.meta').textContent()).toBe('');
  expect((await toolbar.boundingBox())?.y).toBe(before?.y);
});
