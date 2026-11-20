import { expect, type Page } from '@playwright/test';

/**
 * Clear every open toast — by clicking each dismiss button, exactly as a person
 * would. Use it to PROVE a sticky toast is still dismissable, not to clear the
 * way for a click.
 *
 * `danger` toasts stick until dismissed (toasts.ts: `DEFAULT_TOAST_DURATION_MS`
 * is 0 for danger, deliberately, so a failure cannot scroll away). Specs must
 * therefore NOT call this to clear the way for a click — the point of the
 * layout is that what sits under a toast stays usable with the toast still up.
 */
export async function dismissAllToasts(page: Page): Promise<void> {
  const dismiss = page.getByRole('button', { name: 'Dismiss notification' });
  for (let guard = 0; guard < 8; guard += 1) {
    if ((await dismiss.count()) === 0) return;
    await dismiss.first().click();
  }
  await expect(dismiss).toHaveCount(0);
}
