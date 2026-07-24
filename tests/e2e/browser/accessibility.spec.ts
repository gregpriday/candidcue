import { test, expect } from '@playwright/test';
import { installTauriShim, SCRIPT_CONFLICT_ERROR } from './fixtures/tauri-shim';

/**
 * Accessibility as a journey, SHIM-BACKED but the value is REAL BROWSER FOCUS —
 * document.activeElement, Tab order, and the focus-return-to-opener behaviour
 * that jsdom cannot exercise faithfully.
 *
 * Driven through the F.8 conflict sheet (a real modal Dialog with three
 * buttons). Asserted:
 *   - opening is keyboard-operable (Enter on the focused trigger);
 *   - focus moves INTO the dialog on open;
 *   - Tab is trapped: it wraps within the dialog and never lands on <body>
 *     behind the aria-modal scrim;
 *   - Escape closes the dialog AND returns focus to the trigger.
 */

const SCRIPT = {
  id: '33333333-3333-4333-8333-333333333333',
  title: 'Panel talk',
  source: '# Panel talk\n\nHello and welcome.\n',
};

async function activeInsideDialog(page: import('@playwright/test').Page): Promise<boolean> {
  return page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
    return dialog !== null && dialog.contains(document.activeElement);
  });
}

test('the conflict dialog traps focus and returns it to the opener on Escape', async ({ page }) => {
  await installTauriShim(page, { welcomed: true, seedScripts: [SCRIPT] });
  await page.goto('/control.html');

  await page.getByRole('list', { name: 'Scripts' }).getByRole('button', { name: /Panel talk/ }).dblclick();
  const editorSurface = page.getByRole('textbox', { name: 'Script Markdown' });
  await expect(editorSurface).toBeVisible();

  await page.evaluate((err) => window.__E2E__.setFail('save_script', err), SCRIPT_CONFLICT_ERROR);
  await editorSurface.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' colliding edit');

  const trigger = page.getByRole('button', { name: /Changed outside CandidCue/ });
  await expect(trigger).toBeVisible();

  // Keyboard-operate the trigger (focus + Enter), not a mouse click.
  await trigger.focus();
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('dialog', { name: 'This script changed on disk' });
  await expect(dialog).toBeVisible();
  // Focus landed inside the modal.
  expect(await activeInsideDialog(page)).toBe(true);

  // Tabbing many times never escapes the modal (the trap holds).
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    expect(await activeInsideDialog(page)).toBe(true);
  }

  // Shift+Tab from the first control wraps to the last ("Keep CandidCue version").
  await dialog.getByRole('button', { name: 'Save both' }).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Keep CandidCue version' })).toBeFocused();

  // Escape closes the dialog and returns focus to the trigger.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});
