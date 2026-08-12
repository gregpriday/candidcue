import { test, expect } from '@playwright/test';
import { installTauriShim, SCRIPT_CONFLICT_ERROR } from './fixtures/tauri-shim';
import { openScript, row } from './fixtures/library';

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
  await expect(row(page, 'Launch keynote')).toBeVisible();

  // Open it — the editor shows the title and the body text.
  await openScript(page, /Launch keynote/);
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

  await openScript(page, /Blank canvas/);
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
  await openScript(page, /Launch keynote/);
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
  await openScript(page, /Launch keynote/);
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
  await openScript(page, /Launch keynote/);
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

  await openScript(page, /Launch keynote/);

  // Covered: the panel is up and NOTHING else of the editor is on screen —
  // not the title, not the insert toolbar, not the text, not the outline.
  const panel = page.getByRole('status').filter({ hasText: 'Opening script…' });
  await expect(panel).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Script title' })).toHaveCount(0);
  await expect(page.getByRole('toolbar', { name: 'Insert' })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Outline' })).toHaveCount(0);

  /*
   * Revealed — and the assertion has to be about the FIRST frame that shows
   * the editor, not about the settled end state. Asserting each piece with
   * Playwright's auto-waiting would pass just as happily against the old
   * behaviour, which also got there eventually; the bug was never that the
   * pieces failed to arrive, only that they arrived one at a time.
   *
   * So: watch for the moment the title first exists and record, in that same
   * callback, what else was on screen with it.
   */
  const firstFrame = await page.evaluate(
    () =>
      new Promise<{ toolbar: boolean; editor: boolean; outline: boolean; meta: string }>(
        (resolve) => {
          const look = () => {
            if (!document.querySelector('.title-input')) return false;
            resolve({
              toolbar: !!document.querySelector('[role="toolbar"][aria-label="Insert"]'),
              editor: !!document.querySelector('.cm-content'),
              outline: !!document.querySelector('aside[aria-label="Outline"]'),
              meta: document.querySelector('.meta')?.textContent ?? '',
            });
            return true;
          };
          if (look()) return;
          const observer = new MutationObserver(() => {
            if (look()) observer.disconnect();
          });
          observer.observe(document.body, { childList: true, subtree: true });
        },
      ),
  );

  expect(firstFrame.toolbar).toBe(true);
  expect(firstFrame.editor).toBe(true);
  expect(firstFrame.outline).toBe(true);
  // The clause that matters most: the metadata is compile-derived, and it is
  // already populated in the very frame the header first appears in.
  expect(firstFrame.meta).toContain('words');

  await expect(panel).toHaveCount(0);
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
  await openScript(page, /Launch keynote/);

  const editorSurface = page.getByRole('textbox', { name: 'Script Markdown' });
  await expect(editorSurface).toBeVisible();
  await expect(page.locator('.meta')).toContainText('words');

  // Mark the live CodeMirror node so a remount is detectable as such: a
  // rebuilt editor is a fresh node and does not carry the mark.
  await page.evaluate(() => {
    document.querySelector('.cm-editor')?.setAttribute('data-e2e-original', 'yes');
  });

  const toolbar = page.getByRole('toolbar', { name: 'Insert' });
  await expect(toolbar).toBeVisible();
  const before = await toolbar.boundingBox();
  expect(before).not.toBeNull();
  const metaBefore = await page.locator('.meta').textContent();

  await editorSurface.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Several more spoken words for the counter to find.');

  // The word count moved, so a compile really did run and land.
  await expect.poll(() => page.locator('.meta').textContent()).not.toBe(metaBefore);

  // The panel never came back, and the editor is the SAME instance.
  await expect(page.getByRole('status').filter({ hasText: 'Opening script…' })).toHaveCount(0);
  expect(await page.locator('.cm-editor').getAttribute('data-e2e-original')).toBe('yes');

  // The toolbar has not moved: one metadata string replaced another of the
  // same height. Emptying the script back to zero counts is the harder
  // direction, and the next test covers that one.
  const after = await toolbar.boundingBox();
  expect(after).not.toBeNull();
  expect(after?.y).toBe(before?.y);
});

/**
 * Emptying the script takes it back to zero counts — and that must not move the
 * toolbar either. This is the direction waiting on the first compile cannot
 * cover on its own: it happens long after the panel has gone, on a script the
 * author is still typing in.
 *
 * Two things hold the row here, and either alone would do it: the count line
 * reports zero rather than vanishing, and the row's space is reserved. The
 * height is what is under test, not which of them supplied it.
 */
test('emptying the script reports zero without moving the toolbar', async ({ page }) => {
  await page.goto('/control.html');
  await openScript(page, /Launch keynote/);

  const editorSurface = page.getByRole('textbox', { name: 'Script Markdown' });
  await expect(editorSurface).toBeVisible();
  await expect(page.locator('.meta')).toContainText('words');

  const toolbar = page.getByRole('toolbar', { name: 'Insert' });
  await expect(toolbar).toBeVisible();
  const before = await toolbar.boundingBox();
  expect(before).not.toBeNull();

  await editorSurface.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');

  // No spoken words left, so the metadata reports zero — in the same row, at
  // the same height, exactly where it was.
  await expect.poll(() => page.locator('.meta').textContent()).toBe('0 words · — · 0 cues');
  const after = await toolbar.boundingBox();
  expect(after).not.toBeNull();
  expect(after?.y).toBe(before?.y);
});

/**
 * The safety net, exercised.
 *
 * `compileScript` settles only when the compile worker answers — it has no
 * timeout and no `error` listener — so a worker that fails to construct leaves
 * the compile pending forever. That already cost the preview; once the loading
 * panel started waiting for the first compile it would have cost the whole
 * editor, which is a far worse failure than the one this change set out to fix.
 *
 * Here the worker is replaced with one that never replies, which is what a
 * worker that failed to construct looks like from the editor's side.
 */
test('reveals the editor anyway when the compile worker never answers', async ({ page }) => {
  await page.addInitScript(() => {
    class SilentWorker {
      addEventListener(): void {}
      removeEventListener(): void {}
      postMessage(): void {}
      terminate(): void {}
      onmessage: unknown = null;
      onerror: unknown = null;
    }
    (window as unknown as { Worker: unknown }).Worker = SilentWorker;
  });

  await page.goto('/control.html');
  await openScript(page, /Launch keynote/);

  // The editor arrives regardless — the text is reachable and editable, which
  // is the thing that must never be locked away behind a compile.
  const editorSurface = page.getByRole('textbox', { name: 'Script Markdown' });
  await expect(editorSurface).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.cm-content')).toContainText('Welcome everyone to the show');
  await expect(page.getByRole('status').filter({ hasText: 'Opening script…' })).toHaveCount(0);

  // Nothing compile-derived can be there, so the row says so with the em dash
  // it keeps for "no compile to report" rather than stating a count nobody has
  // worked out — and it is on the glass, holding its height, either way.
  await expect(page.locator('.meta')).toHaveText('—');
  await expect(page.locator('.meta')).toHaveCount(1);
});
