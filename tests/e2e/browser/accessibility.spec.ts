import { test, expect } from '@playwright/test';
import { installTauriShim, SCRIPT_CONFLICT_ERROR } from './fixtures/tauri-shim';

/**
 * Accessibility as a journey, SHIM-BACKED but the value is REAL BROWSER FOCUS —
 * document.activeElement, Tab order, and the focus-return-to-opener behaviour
 * that jsdom cannot exercise faithfully.
 *
 * Driven through the F.8 conflict sheet (a real modal Dialog with two
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

  await page.getByRole('list', { name: 'Scripts' }).getByRole('button', { name: /Panel talk/ }).click();
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

  // Shift+Tab from the first control wraps to the last ("Keep my edits").
  await dialog.getByRole('button', { name: 'Use disk version' }).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Keep my edits' })).toBeFocused();

  // Escape closes the dialog and returns focus to the trigger.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

/**
 * The insert toolbar's keyboard pattern (issue #118).
 *
 * It declared `role="toolbar"` while every button stayed its own tab stop, so
 * it promised a pattern it did not implement and put eight stops between the
 * editor and everything after it. Real browser focus, because roving tabindex
 * is entirely about what `document.activeElement` does.
 */
test('the insert toolbar is one tab stop with arrow-key navigation', async ({ page }) => {
  await installTauriShim(page, { welcomed: true, seedScripts: [SCRIPT] });
  await page.goto('/control.html');
  await page.getByRole('list', { name: 'Scripts' }).getByRole('button', { name: /Panel talk/ }).click();
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeVisible();

  const toolbar = page.getByRole('toolbar', { name: 'Insert' });
  await expect(toolbar).toBeVisible();

  // Exactly one button in the group is reachable with Tab.
  const tabStops = await toolbar.evaluate(
    (el) => Array.from(el.querySelectorAll('button')).filter((b) => b.tabIndex === 0).length,
  );
  expect(tabStops).toBe(1);

  // Arrows move focus within the group; Home and End reach its ends.
  await toolbar.getByRole('button', { name: 'Cycle heading level' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(toolbar.getByRole('button', { name: 'Bold' })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(toolbar.getByRole('button', { name: 'Cycle heading level' })).toBeFocused();
  await page.keyboard.press('End');
  await expect(toolbar.getByRole('button', { name: 'Insert take marker' })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(toolbar.getByRole('button', { name: 'Cycle heading level' })).toBeFocused();
});

/**
 * The split divider (issue #118). It carried `role="separator"` with no way to
 * focus it, no keys and no value — a resize control that announced itself and
 * could not be used.
 */
test('the split divider is focusable and operable from the keyboard', async ({ page }) => {
  await installTauriShim(page, { welcomed: true, seedScripts: [SCRIPT] });
  await page.goto('/control.html');
  await page.getByRole('list', { name: 'Scripts' }).getByRole('button', { name: /Panel talk/ }).click();
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeVisible();

  await page.getByRole('radio', { name: 'Split' }).click();
  const divider = page.getByRole('separator', { name: 'Resize editor and preview' });
  await expect(divider).toBeVisible();

  await divider.focus();
  await expect(divider).toBeFocused();

  // It reports where it is, and the ends match the travel a drag is clamped to.
  await expect(divider).toHaveAttribute('aria-valuemin', '25');
  await expect(divider).toHaveAttribute('aria-valuemax', '75');

  await page.keyboard.press('Home');
  await expect(divider).toHaveAttribute('aria-valuenow', '25');
  await page.keyboard.press('End');
  await expect(divider).toHaveAttribute('aria-valuenow', '75');
  await page.keyboard.press('ArrowLeft');
  await expect(divider).toHaveAttribute('aria-valuenow', '70');
});
