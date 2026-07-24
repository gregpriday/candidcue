import { expect, type Page } from '@playwright/test';

/**
 * Clear every open toast.
 *
 * KNOWN DEFECT — this helper exists because of one, and specs should not lose
 * that context by quietly calling it.
 *
 * `danger` toasts stick until dismissed (toasts.ts: `DEFAULT_TOAST_DURATION_MS`
 * is 0 for danger, deliberately, so a failure cannot scroll away). The toast
 * region is `position: fixed; bottom: var(--space-6)` (24px), bottom-centre,
 * with `pointer-events: auto` on each toast — and the Live screen's transport
 * bar is ~60px tall and always visible at the bottom. So every danger toast on
 * the Live screen lands ON TOP of the centre transport controls (back/forward a
 * sentence, restart paragraph, take marker, blank stage) and swallows their
 * clicks. Two independent live failures land there — §62 stage-closed, and a
 * realtime transport that will not connect — and both leave the operator's
 * manual fallback unclickable at exactly the moment they need it.
 *
 * Playwright surfaces this as "…<div class='toast danger'> intercepts pointer
 * events"; a person just clicks and nothing happens.
 */
export async function dismissAllToasts(page: Page): Promise<void> {
  const dismiss = page.getByRole('button', { name: 'Dismiss notification' });
  for (let guard = 0; guard < 8; guard += 1) {
    if ((await dismiss.count()) === 0) return;
    await dismiss.first().click();
  }
  await expect(dismiss).toHaveCount(0);
}
