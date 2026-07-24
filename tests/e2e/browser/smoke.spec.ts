import { test, expect } from '@playwright/test';

/**
 * [MOCK-BACKED] Navigation / render smoke across all three Vite entries.
 *
 * These specs install NO Tauri shim, so `isTauriRuntime()` is false and the app
 * runs against `src/control/services/mock-backend.ts`. That proves the FRONTEND
 * routes resolve and render — it says NOTHING about the Rust backend, and the
 * mock is in places deliberately stronger than Rust. Treat these as launch/
 * render checks only; the production-path assertions live in the shim-backed
 * specs (library-editor, preflight, settings, accessibility).
 */

test('[mock-backed] control window boots to Welcome and navigates to the Library', async ({ page }) => {
  await page.goto('/control.html');

  // First launch (no `welcomed` flag) lands on the Welcome screen.
  await expect(page.getByRole('heading', { name: 'Speak naturally. Keep your place.' })).toBeVisible();

  // The Welcome -> Library path works and the Library renders its empty state.
  await page.getByRole('button', { name: 'Go to the library' }).click();
  await expect(page.getByRole('heading', { name: 'Scripts' })).toBeVisible();
  await expect(page.getByText('Write the words. CandidCue keeps your place.')).toBeVisible();
});

test('[mock-backed] identify overlay renders the display number it was handed', async ({ page }) => {
  await page.goto('/identify.html?n=2&primary=1');
  await expect(page.locator('.identify .number')).toHaveText('2');
  await expect(page.locator('.identify .label')).toHaveText('Display · Primary');
});

test('[mock-backed] stage window renders its waiting state before any session', async ({ page }) => {
  await page.goto('/stage.html');
  const root = page.locator('.stage-root');
  await expect(root).toHaveAttribute('data-phase', 'handshake');
  await expect(root.locator('.waiting')).toHaveText('CandidCue');
});
