/**
 * Reaching Settings now that it is a WINDOW (desktop refinement §14.1).
 *
 * ---------------------------------------------------------------------------
 * WHY THE SPECS STOPPED CLICKING THE SIDEBAR
 * ---------------------------------------------------------------------------
 * Settings used to be a route in the control window, so a spec got there by
 * clicking the rail and asserting on the same page. It is its own window now,
 * created by Rust (`windows/preferences.rs`) — and this suite runs in a plain
 * browser with a shimmed IPC layer, where "open a native window" is not a thing
 * that can happen. Clicking the rail here calls a command the shim answers with
 * `null` and nothing appears.
 *
 * The window IS a page, though: `preferences.html`, a real Vite entry point. So
 * a spec loads it directly, which exercises the production code path for
 * everything the specs were ever about — the sections, the form rows, the
 * settings adapter, the optimistic-concurrency writes.
 *
 * WHAT THIS DOES NOT COVER, and cannot: that ⌘, and the sidebar row open the
 * window, that it is single-instance, and that closing it leaves the control
 * window where it was. Those are `windows/preferences.rs` and only the packaged
 * app can show them.
 */
import { expect, type Page } from '@playwright/test';

/**
 * Load the Settings window and wait for it to finish reading settings.
 *
 * The window shows "Loading settings…" until `get_settings` answers, so a spec
 * that started asserting immediately would race the load — which is why this
 * waits for a section heading rather than for the page.
 */
export async function openPreferences(page: Page): Promise<void> {
  await page.goto('/preferences.html');
  await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();
}

/** Switch to a section by its visible name. */
export async function gotoSection(page: Page, name: string): Promise<void> {
  const nav = page.getByRole('navigation', { name: 'Settings sections' });
  await nav.getByRole('button', { name, exact: true }).click();
  await expect(nav.getByRole('button', { name, exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
}
