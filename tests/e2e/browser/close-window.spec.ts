/**
 * File › Close Window — ⌘W anywhere but the editor (#266).
 *
 * It did nothing at all. The action called `getCurrentWindow().close()`, the
 * control capability does not grant `core:window:allow-close`, and the `catch`
 * around it read the ACL's refusal as "browser dev". It now asks Rust, which
 * raises the same `CloseRequested` the red close button does.
 *
 * Driven by `menu://command`, not a keypress: ⌘W is a native menu accelerator,
 * so a browser keystroke would exercise a path the packaged app never takes.
 *
 * What this proves: the close is ASKED FOR, exactly once, and only after the
 * question a running take is owed. What it cannot: that the handshake then
 * finishes the take and the app exits — the shim answers `close_control_window`
 * and does nothing, because none of that exists in a browser.
 */
import { test, expect, type Page } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';
import { watchPageErrors } from './fixtures/page-errors';
import { collection, openScript } from './fixtures/library';

const SCRIPT = {
  id: '26626626-6266-4266-8266-266266266266',
  title: 'Close window walkthrough',
  source: '# Opening\n\nThank you for joining me today.\n\nHere is what changed this quarter.\n',
};

/** Choose an item from the native menu, once the window is listening for it. */
async function chooseMenuCommand(page: Page, id: string): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        (commandId) => window.__E2E__.emit('menu://command', { id: commandId }),
        id,
      ),
    )
    .toBeGreaterThan(0);
}

/** How many times the window asked Rust to close it. */
function closeRequests(page: Page): Promise<number> {
  return page.evaluate(
    () => window.__E2E__.calls.filter((call) => call.command === 'close_control_window').length,
  );
}

/** Present the script, and wait for the opening transition to finish. */
async function present(page: Page): Promise<void> {
  await collection(page).getByRole('button', { name: 'Present', exact: true }).first().click();
  await expect(page.getByRole('region', { name: 'Teleprompter' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator('.stage-root')).toHaveAttribute('data-phase', 'ready');
  await expect(page.locator('.present-cover')).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [SCRIPT],
    engineStatus: {
      available: true,
      loaded: true,
      model: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05',
    },
    promptMode: 'voice',
  });
  await page.goto('/control.html');
  await expect(collection(page)).toBeVisible();
});

test('Close Window from the Library asks Rust to close the window, once', async ({ page }) => {
  const errors = watchPageErrors(page);
  await chooseMenuCommand(page, 'file.close-script');

  await expect.poll(() => closeRequests(page)).toBe(1);
  // Nothing to ask about with no take running, so nothing was asked.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  errors.expectClean();
});

test('Close Script in the editor returns to the Library and closes nothing', async ({ page }) => {
  await openScript(page, SCRIPT.title);
  const editorSurface = page.getByRole('textbox', { name: 'Script Markdown' });
  await expect(editorSurface).toBeVisible();

  await chooseMenuCommand(page, 'file.close-script');

  await expect(editorSurface).toHaveCount(0);
  await expect(collection(page)).toBeVisible();
  expect(await closeRequests(page)).toBe(0);
});

test('Close Window during a take asks first, and Cancel leaves the take running', async ({
  page,
}) => {
  await present(page);
  await chooseMenuCommand(page, 'file.close-script');

  const dialog = page.getByRole('dialog', { name: 'End this take?' });
  await expect(dialog).toBeVisible();
  expect(await closeRequests(page)).toBe(0);

  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Teleprompter' })).toBeVisible();
  await expect(page.locator('.stage-root')).toHaveAttribute('data-phase', 'ready');
  expect(await closeRequests(page)).toBe(0);
});

test('Close Window during a take closes the window once the take is ended', async ({ page }) => {
  await present(page);
  await chooseMenuCommand(page, 'file.close-script');

  const dialog = page.getByRole('dialog', { name: 'End this take?' });
  await dialog.getByRole('button', { name: 'End take' }).click();

  await expect.poll(() => closeRequests(page)).toBe(1);
  /*
   * The take is NOT torn down here. The handshake's `end-take` step does that
   * once Rust's `CloseRequested` arrives, and awaits the writes on the way;
   * ending it here as well would race the two. So with nothing to deliver that
   * event, the prompter is still up — which is what proves the action left it
   * to the handshake.
   */
  await expect(page.getByRole('region', { name: 'Teleprompter' })).toBeVisible();
});
