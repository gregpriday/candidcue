import { expect, type Page } from '@playwright/test';

/**
 * Clear every open toast — by clicking each dismiss button, exactly as a person
 * would. Use it to PROVE a sticky toast is still dismissable, not to clear the
 * way for a click.
 *
 * `danger` toasts stick until dismissed (toasts.ts: `DEFAULT_TOAST_DURATION_MS`
 * is 0 for danger, deliberately, so a failure cannot scroll away). They used to
 * land on top of the Live screen's always-visible transport bar and swallow its
 * clicks — the operator's manual fallback was unusable at exactly the moment
 * two separate live failures (§62 stage-closed, and a realtime transport that
 * will not connect) produced one.
 *
 * That is fixed in the layout, not the timeout: the toast region reads
 * `--toast-safe-bottom`, which the Live route publishes as the measured height
 * of its transport bar. Specs must therefore NOT call this before driving the
 * transport — the point is that the transport works with the toast still up.
 */
export async function dismissAllToasts(page: Page): Promise<void> {
  const dismiss = page.getByRole('button', { name: 'Dismiss notification' });
  for (let guard = 0; guard < 8; guard += 1) {
    if ((await dismiss.count()) === 0) return;
    await dismiss.first().click();
  }
  await expect(dismiss).toHaveCount(0);
}
