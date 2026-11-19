/**
 * A title still being typed is part of an explicit Save and of a quit (#449).
 *
 * The toolbar's title is a DRAFT until Enter or leaving the field commits it.
 * Save and quit both left the caret where it was, so neither ever committed it:
 * a presenter who typed a new name, pressed ⌘S and quit reopened the script
 * under its old one, with no save or rename written at all.
 *
 * Every case here keeps focus in the title field throughout — moving it would
 * commit the draft through the blur path and prove nothing. Save is driven by
 * `menu://command` and quit by `app://shutdown-requested`, the two events Rust
 * delivers, and the title is read back from the shim's store after the
 * frontend acknowledges the shutdown.
 */
import { test, expect, type Page } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';
import { watchPageErrors } from './fixtures/page-errors';
import { collection, openScript } from './fixtures/library';

const SCRIPT = {
  id: '44944944-9449-4449-8449-449449449449',
  title: 'Audit rehearsal',
  source: '# Opening\n\nThank you for joining me today.\n',
};

function titleField(page: Page) {
  return page.getByRole('textbox', { name: 'Script title' });
}

/** Deliver a Rust → control event once the window is listening for it. */
async function deliver(page: Page, event: string, payload: unknown): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(([name, body]) => window.__E2E__.emit(name as string, body), [event, payload]),
    )
    .toBeGreaterThan(0);
}

/** How many title-carrying writes the frontend sent, of either kind. */
function titleWrites(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      window.__E2E__.calls.filter(
        (call) => call.command === 'save_script' || call.command === 'rename_script',
      ).length,
  );
}

/**
 * Quit the way Rust asks, wait for the frontend's acknowledgement, and return
 * the steps it reports as completed.
 */
async function quit(page: Page): Promise<string[]> {
  await deliver(page, 'app://shutdown-requested', null);
  const ack = () =>
    page.evaluate(() => {
      const call = window.__E2E__.calls.find((c) => {
        const args = c.args as { event?: unknown } | null;
        return c.command === 'plugin:event|emit' && args?.event === 'app://shutdown-complete';
      });
      if (!call) return null;
      const args = call.args as { payload?: { completed?: string[] } };
      return args.payload?.completed ?? [];
    });
  await expect.poll(ack).not.toBeNull();
  return (await ack()) ?? [];
}

/** The title as persisted, read back through the backend. */
function persistedTitle(page: Page): Promise<string> {
  return page.evaluate(async (scriptId) => {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__;
    const doc = (await internals.invoke('get_script', { scriptId })) as { title: string };
    return doc.title;
  }, SCRIPT.id);
}

/** Open the script and type into its title without leaving the field. */
async function typeTitle(page: Page, text: string): Promise<void> {
  await openScript(page, SCRIPT.title);
  const field = titleField(page);
  await expect(field).toHaveValue(SCRIPT.title);
  await field.click();
  await field.fill(text);
  await expect(field).toBeFocused();
}

test.beforeEach(async ({ page }) => {
  await installTauriShim(page, { welcomed: true, seedScripts: [SCRIPT] });
  await page.goto('/control.html');
  await expect(collection(page)).toBeVisible();
});

test('File › Save writes the title being typed, and leaves the caret in it', async ({ page }) => {
  const errors = watchPageErrors(page);
  await typeTitle(page, 'Renamed rehearsal');

  await deliver(page, 'menu://command', { id: 'file.save' });

  await expect.poll(() => persistedTitle(page)).toBe('Renamed rehearsal');
  await expect(titleField(page)).toBeFocused();
  await expect(titleField(page)).toHaveValue('Renamed rehearsal');
  errors.expectClean();
});

test('the save shortcut typed in the title field writes the title being typed', async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await typeTitle(page, 'Renamed rehearsal');

  await titleField(page).press('ControlOrMeta+s');

  await expect.poll(() => persistedTitle(page)).toBe('Renamed rehearsal');
  await expect(titleField(page)).toBeFocused();
  errors.expectClean();
});

test('quitting with the caret in the title persists the new title', async ({ page }) => {
  const errors = watchPageErrors(page);
  await typeTitle(page, 'Renamed rehearsal');

  const completed = await quit(page);

  expect(completed).toContain('flush-editor');
  expect(await persistedTitle(page)).toBe('Renamed rehearsal');
  await expect(titleField(page)).toBeFocused();
  errors.expectClean();
});

test('a title typed and then abandoned with Escape is not written by a quit', async ({ page }) => {
  await typeTitle(page, 'Renamed rehearsal');
  // Escape abandons AND leaves the field; the caret is put back so the quit
  // below finds it there, which is the case that has to read nothing.
  await titleField(page).press('Escape');
  await expect(titleField(page)).toHaveValue(SCRIPT.title);
  await titleField(page).focus();

  expect(await quit(page)).toContain('flush-editor');

  expect(await persistedTitle(page)).toBe(SCRIPT.title);
  expect(await titleWrites(page)).toBe(0);
});

test('an emptied title is not written by Save or a quit', async ({ page }) => {
  await typeTitle(page, '   ');

  await deliver(page, 'menu://command', { id: 'file.save' });
  await expect.poll(() => titleWrites(page)).toBe(0);
  // Still the user's half-finished edit: nothing restored it under the caret.
  await expect(titleField(page)).toHaveValue('   ');
  await expect(titleField(page)).toBeFocused();

  expect(await quit(page)).toContain('flush-editor');

  expect(await persistedTitle(page)).toBe(SCRIPT.title);
  expect(await titleWrites(page)).toBe(0);
});
