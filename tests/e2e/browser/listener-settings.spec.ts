import { test, expect, type Page } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';

/**
 * The Listener's two unreachable halves, driven through the real UI.
 *
 * 1. Placement (§37.4). Four of the five modes were implemented in CSS and
 *    unreachable: the producer hard-coded `placement: 'background'`, so nothing
 *    in any screen or service could select `lens_left`, `lens_right`,
 *    `top_strip` or `pip`. A test that only checked the picker renders would
 *    have proved nothing, so this one also checks the geometry the picker
 *    produces — the preview is drawn from the same `listenerPlacementBox` the
 *    stage layer positions itself with (the producer → stage half is pinned in
 *    tests/unit/stage/listener-placement.test.ts).
 *
 * 2. Settings that were written and never read. `listeners.dimPercent` was
 *    written by the Settings screen while Preflight hard-coded 40 — the same
 *    number, which is exactly why nobody noticed — and `autoplay` /
 *    `defaultPackId` had no reader anywhere. Every value seeded below is
 *    deliberately NOT the default, so a control still reading its old literal
 *    fails.
 *
 * These controls used to live on Preflight, one screen before every take, with
 * a partial copy here in Settings. There is one copy now: what is set here is
 * what the stage runs, because Present has nothing in between.
 */

const SCRIPT = {
  id: '33333333-3333-4333-8333-333333333333',
  title: 'Product walkthrough',
  source: '# Product walkthrough\n\nLet me show you what changed this quarter.\n',
};

const MIRA_INSTALLED = {
  packId: 'mira',
  version: '1.0.0',
  displayName: 'Mira',
  description: 'A calm, neutral listener.',
  source: 'bundled',
  sizeBytes: 42_000_000,
  clipCount: 2,
  state: 'installed',
  installedAt: '2026-01-01T00:00:00.000Z',
};

/** Non-default on every axis (defaults: null / true / 40 / 0 / 0.85). */
const LISTENER_SETTINGS = {
  defaultPackId: 'mira',
  autoplay: true,
  dimPercent: 62,
  blurPx: 8,
  saturation: 0.4,
};

async function openListenerSettings(page: Page): Promise<void> {
  await page.goto('/control.html');
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Listeners', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Listeners' })).toBeVisible();
}

/** Reveal the framing controls, which sit behind a disclosure. */
async function openFraming(page: Page): Promise<void> {
  const summary = page.getByText('Framing and placement', { exact: true });
  await expect(summary).toBeVisible();
  await summary.click();
}

/** The inline `left` of the "look here" marker, as a percentage. */
async function markerLeftPercent(page: Page): Promise<number> {
  const raw = await page.locator('.mini-target').evaluate((el) => (el as HTMLElement).style.left);
  return Number.parseFloat(raw);
}

test('the stored Listener settings are what the controls show', async ({ page }) => {
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [SCRIPT],
    listenerSettings: LISTENER_SETTINGS,
    installedListeners: [MIRA_INSTALLED],
  });
  await openListenerSettings(page);

  // `autoplay` + `defaultPackId` had no reader at all. The remembered pack is
  // the selected one, and it is what a take opens with.
  await expect(page.getByRole('combobox', { name: 'Listener' })).toHaveValue('mira');

  // Each of these is a setting that was written and never read. 62 / 8 / 40 are
  // the persisted values; 40 / 0 / 85 were the literals in the component.
  await expect(page.getByRole('slider', { name: 'Default dim' })).toHaveValue('62');
  await expect(page.getByRole('slider', { name: 'Default blur' })).toHaveValue('8');
  await expect(page.getByRole('slider', { name: 'Default colour' })).toHaveValue('40');
});

test('no remembered pack means no framing controls to set', async ({ page }) => {
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [SCRIPT],
    listenerSettings: { ...LISTENER_SETTINGS, defaultPackId: null, autoplay: false },
    installedListeners: [MIRA_INSTALLED],
  });
  await openListenerSettings(page);

  await expect(page.getByRole('combobox', { name: 'Listener' })).toHaveValue('');
  // Framing a person who is not on the stage is not a thing to offer.
  await expect(page.getByText('Framing and placement', { exact: true })).toHaveCount(0);
});

test('every placement mode is selectable and moves where the presenter looks', async ({
  page,
}, testInfo) => {
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [SCRIPT],
    listenerSettings: LISTENER_SETTINGS,
    installedListeners: [MIRA_INSTALLED],
  });
  await openListenerSettings(page);
  await openFraming(page);

  const group = page.getByRole('radiogroup', { name: 'Listener placement' });
  await expect(group).toBeVisible();
  // All five renderable modes, and never "off" — that is the pack picker's job.
  await expect(group.getByRole('radio')).toHaveCount(5);

  // Background is where every session used to be stuck.
  await expect(group.getByRole('radio', { name: /Behind the script/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  const behindTheScript = await markerLeftPercent(page);
  expect(behindTheScript).toBeCloseTo(50, 1);

  await group.getByRole('radio', { name: /lens — left/ }).click();
  const lensLeft = await markerLeftPercent(page);

  await group.getByRole('radio', { name: /lens — right/ }).click();
  const lensRight = await markerLeftPercent(page);

  // The lens modes are the ones that matter on a teleprompter rig: they put a
  // face beside the lens rather than behind the text, on opposite sides.
  expect(lensLeft).toBeLessThan(behindTheScript);
  expect(lensRight).toBeGreaterThan(behindTheScript);
  expect(lensLeft + lensRight).toBeCloseTo(100, 1);

  // A "Size on stage" control appears only once she has a box of her own.
  await expect(page.getByRole('slider', { name: 'Size on stage' })).toBeVisible();
  await group.getByRole('radio', { name: /Behind the script/ }).click();
  await expect(page.getByRole('slider', { name: 'Size on stage' })).toHaveCount(0);

  await page.screenshot({
    path: testInfo.outputPath('listener-placement.png'),
    fullPage: true,
  });
});

test('choosing a Listener remembers it, and choosing None forgets it', async ({ page }) => {
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [SCRIPT],
    listenerSettings: { ...LISTENER_SETTINGS, defaultPackId: null, autoplay: true },
    installedListeners: [MIRA_INSTALLED],
  });
  await openListenerSettings(page);

  await page.getByRole('combobox', { name: 'Listener' }).selectOption('mira');
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          window.__E2E__.calls.filter(
            (c) =>
              c.command === 'update_settings' &&
              (c.args as { patch?: { listener?: { defaultPackId?: unknown } } } | null)?.patch
                ?.listener?.defaultPackId === 'mira',
          ).length,
      ),
    )
    .toBeGreaterThan(0);

  // …and null is SENT to clear it, not omitted: Rust's merge removes a null key
  // and the container default refills it with None. Omitting it would leave the
  // old pack behind and reopen a Listener the user had just turned off.
  await page.getByRole('combobox', { name: 'Listener' }).selectOption('');
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          window.__E2E__.calls.filter(
            (c) =>
              c.command === 'update_settings' &&
              (c.args as { patch?: { listener?: Record<string, unknown> } } | null)?.patch?.listener
                ?.defaultPackId === null,
          ).length,
      ),
    )
    .toBeGreaterThan(0);
});
