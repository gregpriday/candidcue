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
  await installTauriShim(page, { welcomed: true, seedScripts: [SCRIPT], windowDisplay: 'dsp-e2e-builtin' });
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
  // The panel the CandidCue window is on, which is where Present puts an
  // unpinned take (#302).
  await expect(automatic).toContainText('Currently display 1 · Built-in Display');

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
  // The CandidCue window on the primary panel, with an external one beside it.
  await installTauriShim(page, { welcomed: true, seedScripts: [SCRIPT], windowDisplay: 'dsp-e2e-builtin' });
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
  // number of the panel it resolves to — the one the CandidCue window is on,
  // which is where Present puts an unpinned take. Not the external display,
  // which this tile used to name although no take ever opened there (#302).
  const automatic = page.locator('.monitor-tile', {
    has: page.locator('.monitor-name', { hasText: 'Automatic' }),
  });
  await expect(automatic.locator('.monitor-number')).toHaveCount(0);
  const windowPanel = session.displays.find((panel) => panel.primary)!;
  await expect(automatic).toContainText(`Currently display ${windowPanel.number} · ${windowPanel.name}`);

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

test('a re-read overtaken by a topology change waits for the newer list instead of crying wolf', async ({
  page,
}) => {
  await installTauriShim(page, { welcomed: true, seedScripts: [SCRIPT], failListDisplays: true });
  await page.goto('/control.html');

  await openPreferences(page);
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Prompter display and rigs', exact: true })
    .click();
  await expect(page.getByText('could not list the connected displays')).toBeVisible();

  // The panels are back, but every read of them is now slow — so Identify's
  // re-read (A) is still in flight when a topology change starts a newer one
  // (B), and A answers first. A's answer is never shown; B's is.
  await page.evaluate(() => {
    window.__E2E__.setFail('list_displays', null);
    window.__E2E__.setDelay('list_displays', 1500);
  });
  const listCalls = () =>
    page.evaluate(() => window.__E2E__.calls.filter((c) => c.command === 'list_displays').length);
  const listAnswers = () =>
    page.evaluate(() => window.__E2E__.settled.filter((c) => c === 'list_displays').length);
  const before = await listCalls();
  const answeredBefore = await listAnswers();
  await page.getByRole('button', { name: 'Identify displays' }).click();
  await expect.poll(listCalls).toBe(before + 1);
  const { delivered, answered } = await page.evaluate(() => ({
    delivered: window.__E2E__.emit('app://device-or-display-change', {
      kind: 'display',
      displays: [],
    }),
    answered: window.__E2E__.settled.filter((c) => c === 'list_displays').length,
  }));
  expect(delivered).toBeGreaterThan(0);
  // A was still unanswered when B started, or this proves nothing about the
  // overlap: a stalled runner would let A land first and the old code pass.
  expect(answered).toBe(answeredBefore);
  await expect.poll(listCalls).toBeGreaterThanOrEqual(before + 2);

  // Judged against B, which matches the glass: no "the displays changed"
  // alarm, and the tiles carry the numbers.
  await expect(page.getByText('Each display shows the number on its tile here')).toBeVisible();
  await expect(page.getByText('changed while they were being numbered')).toHaveCount(0);
  await expect(displayTile(page, 'Teleprompter Display').locator('.monitor-number')).toHaveText(
    'Display 2',
  );
});

test('a refused Identify says so, announces nothing, and can be pressed again', async ({
  page,
}) => {
  await installTauriShim(page, { welcomed: true, seedScripts: [SCRIPT] });
  await page.goto('/control.html');

  await openPreferences(page);
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Prompter display and rigs', exact: true })
    .click();
  await expect(displayTile(page, 'Teleprompter Display')).toBeVisible();
  await expect(page.locator('.inline-alert')).toHaveCount(0);

  await page.evaluate(() =>
    window.__E2E__.setFail('identify_displays', {
      code: 'HARDWARE_ERROR',
      userMessage: 'The displays could not be numbered.',
    }),
  );
  const identify = page.getByRole('button', { name: 'Identify displays' });
  await identify.click();
  await expect(page.locator('.inline-alert[role="alert"]')).toBeVisible();
  await expect(page.getByText('Each display shows the number on its tile here')).toHaveCount(0);

  await page.evaluate(() => window.__E2E__.setFail('identify_displays', null));
  await expect(identify).toBeEnabled();
  await identify.click();
  await expect(page.getByText('Each display shows the number on its tile here')).toBeVisible();
  await expect(page.locator('.inline-alert')).toHaveCount(0);
});

/**
 * An unplugged pin has TWO fallbacks, and the alert used to name only one of
 * them — the preview target — while saying nothing about where the take goes
 * (#302). Present puts it on the panel the CandidCue window is on; previews,
 * tests and calibration still prefer an external display. Both are named.
 */
test('an unplugged pin names where the take opens and where previews go, separately', async ({
  page,
}) => {
  await installTauriShim(page, { welcomed: true, seedScripts: [SCRIPT], windowDisplay: 'dsp-e2e-builtin' });
  await page.addInitScript(() => {
    localStorage.setItem(
      'candidcue.settings-overlay.v1',
      JSON.stringify({ stage: { displayFingerprint: 'dsp-gone-from-this-desk' } }),
    );
  });
  await page.goto('/control.html');

  await openPreferences(page);
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Prompter display and rigs', exact: true })
    .click();

  const alert = page.locator('.inline-alert[role="alert"]');
  await expect(alert).toContainText('The display you chose is not connected.');
  await expect(alert).toContainText('takes open on Built-in Display, where the CandidCue window is');
  await expect(alert).toContainText('previews, tests and calibration use Teleprompter Display');
});
