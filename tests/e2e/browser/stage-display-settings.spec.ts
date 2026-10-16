import { test, expect, type Page } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';
import { openPreferences } from './fixtures/preferences';

/**
 * The stage-display picker, SHIM-BACKED, focused on a DEGRADED path.
 *
 * Real behaviour asserted:
 *   - when display enumeration REJECTS, the section does not sit forever at
 *     "Checking…": it reports an actionable error (role="alert") and offers a
 *     retry ("Check again");
 *   - the retry actually recovers — once enumeration succeeds, the detected
 *     displays appear and the error clears. This is the "a check that starts
 *     must finish" guarantee, which is the whole reason a hardware list belongs
 *     behind a button the user pressed rather than in front of a take they are
 *     trying to start.
 *
 * This lived on Preflight, where a failed enumeration blocked Start. It cannot
 * block anything now: a take with no chosen display falls back to whatever is
 * connected and says so. What is still worth having is a screen that tells the
 * truth about the hardware when you go looking.
 */

const SCRIPT = {
  id: '22222222-2222-4222-8222-222222222222',
  title: 'Investor update',
  source: '# Investor update\n\nThanks for joining this quarter.\n',
};

test('a rejecting display enumeration leaves an actionable error and a working retry', async ({
  page,
}, testInfo) => {
  await installTauriShim(page, { welcomed: true, seedScripts: [SCRIPT], failListDisplays: true });
  await page.goto('/control.html');

  await openPreferences(page);
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Prompter display and rigs', exact: true })
    .click();

  // The section surfaces a real error and a retry — not a stuck row.
  await expect(page.getByText('could not list the connected displays')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check again' })).toBeVisible();
  // Explicitly NOT stuck in the "checking" state.
  await expect(page.getByText('Checking…')).toHaveCount(0);

  await page.screenshot({
    path: testInfo.outputPath('stage-display-degraded.png'),
    fullPage: true,
  });

  // Recover: enumeration now succeeds, the operator retries.
  await page.evaluate(() => window.__E2E__.setFail('list_displays', null));
  await page.getByRole('button', { name: 'Check again' }).click();

  // The detected displays render and the error is gone.
  await expect(page.locator('.monitor-name', { hasText: 'Teleprompter Display' })).toBeVisible();
  await expect(page.getByText('could not list the connected displays')).toHaveCount(0);
});

test('the chosen display is remembered, and Automatic names what it resolves to', async ({
  page,
}) => {
  await installTauriShim(page, { welcomed: true, seedScripts: [SCRIPT] });
  await page.goto('/control.html');

  await openPreferences(page);
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Prompter display and rigs', exact: true })
    .click();

  /*
   * Automatic is the default, and it says which panel that currently means.
   * A picker that only offers "Automatic" cannot answer the one question an
   * operator with two monitors has, which is where the prompt window will go.
   */
  const automatic = page.locator('.monitor-tile', {
    has: page.locator('.monitor-name', { hasText: 'Automatic' }),
  });
  await expect(automatic).toHaveClass(/selected/);
  await expect(automatic).toContainText('Currently');

  // Pinning a panel persists it, so the next take opens there without asking.
  // Scoped to the tile's own name: "Automatic" names the panel it resolves to,
  // so a loose text match hits both tiles.
  const pinned = page.locator('.monitor-tile', {
    has: page.locator('.monitor-name', { hasText: 'Teleprompter Display' }),
  });
  await pinned.click();
  await expect(pinned).toHaveClass(/selected/);
  await expect(automatic).not.toHaveClass(/selected/);
});

/**
 * Identify displays puts a number on every panel (#237). These pin the other
 * half: the tile in Settings carries the same number, so "2" on the glass
 * names a tile without counting tiles (Automatic comes first) or reading names
 * (two identical monitors share one).
 */
async function identifySession(page: Page): Promise<IdentifiedPanels> {
  return page.evaluate(async () => {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: { invoke: (command: string) => Promise<unknown> };
      }
    ).__TAURI_INTERNALS__;
    return (await internals.invoke('identify_displays')) as IdentifiedPanels;
  });
}

type IdentifiedPanels = { displays: Array<{ number: number; name?: string; primary: boolean }> };

function displayTile(page: Page, name: string) {
  return page.locator('.monitor-tile', {
    has: page.locator('.monitor-name', { hasText: new RegExp(`^${name}$`) }),
  });
}

test('every display tile carries the number Identify displays puts on its panel', async ({
  page,
}) => {
  await installTauriShim(page, { welcomed: true, seedScripts: [SCRIPT] });
  await page.goto('/control.html');

  await openPreferences(page);
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Prompter display and rigs', exact: true })
    .click();

  // What the overlays show, asked of the backend the same way the button asks.
  const session = await identifySession(page);
  expect(session.displays.length).toBeGreaterThan(1);
  for (const panel of session.displays) {
    const tile = displayTile(page, panel.name ?? 'Display');
    await expect(tile.locator('.monitor-number')).toHaveText(`Display ${panel.number}`);
    // Heard first, before the model name two identical monitors share.
    await expect(tile).toHaveAccessibleName(new RegExp(`^Display ${panel.number}(?!\\d)`));
  }

  // Automatic is not a panel: it takes no number of its own, and names the
  // number of the panel it resolves to (the non-primary one here).
  const automatic = page.locator('.monitor-tile', {
    has: page.locator('.monitor-name', { hasText: 'Automatic' }),
  });
  await expect(automatic.locator('.monitor-number')).toHaveCount(0);
  const external = session.displays.find((panel) => !panel.primary)!;
  await expect(automatic).toContainText(`Currently display ${external.number} · ${external.name}`);

  // The presentation-mode tiles share the tile style and are not displays.
  await expect(page.locator('.monitor-number')).toHaveCount(session.displays.length);

  await page.getByRole('button', { name: 'Identify displays' }).click();
  await expect(
    page.getByText(`Each display shows the number on its tile here (${session.displays.length} connected)`),
  ).toBeVisible();
});

test('Identify re-reads a stale display list so the tiles match the glass', async ({ page }) => {
  await installTauriShim(page, { welcomed: true, seedScripts: [SCRIPT], failListDisplays: true });
  await page.goto('/control.html');

  await openPreferences(page);
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Prompter display and rigs', exact: true })
    .click();
  await expect(page.getByText('could not list the connected displays')).toBeVisible();
  await expect(page.locator('.monitor-number')).toHaveCount(0);

  // The panels are there now, but nothing has read the list again — so the
  // overlays will number two panels the tiles have never heard of.
  await page.evaluate(() => window.__E2E__.setFail('list_displays', null));
  await page.getByRole('button', { name: 'Identify displays' }).click();

  await expect(displayTile(page, 'Built-in Display').locator('.monitor-number')).toHaveText(
    'Display 1',
  );
  await expect(displayTile(page, 'Teleprompter Display').locator('.monitor-number')).toHaveText(
    'Display 2',
  );
  await expect(page.getByText('could not list the connected displays')).toHaveCount(0);
  await expect(page.getByText('Each display shows the number on its tile here')).toBeVisible();
});
