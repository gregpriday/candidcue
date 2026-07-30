import { test, expect, type Page } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';
import { watchPageErrors } from './fixtures/page-errors';

/**
 * The first-launch readiness rows, SHIM-BACKED.
 *
 * Real behaviour asserted: the two setup tasks Welcome names now REPORT state
 * and link to the control that fixes them, and they do it without becoming a
 * gate. The regression these pin is the one the screen shipped with — two lines
 * of prose that named the microphone and the prompter panel, checked neither,
 * and left a wrong answer to be discovered at Present.
 *
 * Three things here are easy to break and invisible when broken:
 *
 *   - TONE. On a genuine first launch nobody has granted the microphone, so
 *     `microphoneGranted` is false for EVERY new user. That is expected setup,
 *     not a fault, and it must not render in the warning treatment reserved for
 *     a rig that has actually degraded. If those two ever collapse into one
 *     tone, the first screen of the product reports a problem to everybody.
 *   - THE SOURCE OF THE MICROPHONE ANSWER. It must be the persisted settings
 *     flag, never a live permission query — see the Chromium note below.
 *   - NOT DISMISSING. Going to look at a setting is not finishing onboarding,
 *     so a fix-link must leave the welcomed flag alone.
 */

const OVERLAY_KEY = 'candidcue.settings-overlay.v1';
const WELCOMED_KEY = 'candidcue.welcomed.v1';

/** The prompter panel in the shim's fixed display fixtures. */
const PROMPTER_DISPLAY = 'Teleprompter Display';

async function seedOverlay(page: Page, overlay: Record<string, unknown>): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      localStorage.setItem(key as string, value as string);
    },
    [OVERLAY_KEY, JSON.stringify(overlay)] as const,
  );
}

const heading = { name: 'Speak naturally. Keep your place.' };

const micRow = (page: Page) => page.locator('.readiness-item').filter({ hasText: 'Microphone' });
const displayRow = (page: Page) =>
  page.locator('.readiness-item').filter({ hasText: 'Teleprompter screen' });

test('a first launch reports the microphone as setup, not as a fault, and resolves the display', async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  // No `welcomed` flag and no overlay: a genuine first launch.
  await installTauriShim(page);
  await page.goto('/control.html');

  await expect(page.getByRole('heading', heading)).toBeVisible();

  // Expected setup reads accent, NOT the warning treatment.
  await expect(micRow(page)).toContainText('Set up');
  await expect(micRow(page)).toHaveClass(/setup/);
  await expect(micRow(page)).not.toHaveClass(/attention/);

  // The display probe settles and names where a take would actually land,
  // rather than leaving "Checking…" on screen forever.
  await expect(displayRow(page)).toContainText('Automatic');
  await expect(displayRow(page)).toContainText(PROMPTER_DISPLAY);
  await expect(displayRow(page)).not.toHaveClass(/attention/);

  // Nothing is gated: all three content actions stay pressable while the rig
  // is unproven. This is the no-preflight rule, asserted rather than assumed.
  for (const name of ['Open the sample script', 'Create your first script', 'Import Markdown']) {
    await expect(page.getByRole('button', { name })).toBeEnabled();
  }

  errors.expectClean();
});

/**
 * The microphone row must read the REMEMBERED grant, not ask the browser.
 *
 * WKWebView — the only webview this app ships in — does not implement
 * `navigator.permissions.query({ name: 'microphone' })`, which is why the
 * product records the grant in `audio.microphoneGranted` instead. Chromium DOES
 * implement it, and this suite grants the microphone globally, so a Welcome
 * screen that queried live would answer "granted" here and look correct while
 * being broken on macOS. Counting the calls is the only way to see the
 * difference: the assertion is that Welcome asked nothing at all.
 */
test('the welcome screen never probes microphone hardware to answer its own readiness row', async ({
  page,
}) => {
  await installTauriShim(page);
  await page.addInitScript(() => {
    const counters = { query: 0, getUserMedia: 0, enumerateDevices: 0 };
    window.__MIC_PROBES__ = counters;

    const query = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (descriptor: PermissionDescriptor) => {
      if (descriptor.name === ('microphone' as PermissionName)) counters.query += 1;
      return query(descriptor);
    };
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (constraints?: MediaStreamConstraints) => {
      counters.getUserMedia += 1;
      return getUserMedia(constraints);
    };
    const enumerateDevices = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
    navigator.mediaDevices.enumerateDevices = () => {
      counters.enumerateDevices += 1;
      return enumerateDevices();
    };
  });
  await page.goto('/control.html');

  await expect(page.getByRole('heading', heading)).toBeVisible();
  await expect(micRow(page)).toContainText('Set up');

  expect(await page.evaluate(() => window.__MIC_PROBES__)).toEqual({
    query: 0,
    getUserMedia: 0,
    enumerateDevices: 0,
  });
});

test('a remembered grant and a connected pinned display both read quiet', async ({ page }) => {
  const errors = watchPageErrors(page);
  await installTauriShim(page);
  await seedOverlay(page, {
    audio: { microphoneGranted: true },
    stage: { displayFingerprint: 'dsp-e2e-prompter' },
  });
  await page.goto('/control.html');

  await expect(page.getByRole('heading', heading)).toBeVisible();

  await expect(micRow(page)).toContainText('Access allowed');
  await expect(micRow(page)).not.toHaveClass(/setup|attention/);
  // The claim is narrow on purpose: the flag records a grant, not a working
  // rig, so nothing here says "Ready".
  await expect(micRow(page)).not.toContainText('Ready');

  await expect(displayRow(page)).toContainText('Connected');
  await expect(displayRow(page)).toContainText(PROMPTER_DISPLAY);
  await expect(displayRow(page)).not.toHaveClass(/setup|attention/);

  errors.expectClean();
});

/**
 * The one state that earns the warning treatment.
 *
 * A fingerprint is panel IDENTITY, so a display that gets unplugged simply
 * stops matching and the take quietly opens somewhere else. Saying so here is
 * the whole point of the row — this is the case the issue described as being
 * discovered at Present.
 */
test('a pinned display that is not connected warns and names where the take will land', async ({
  page,
}) => {
  await installTauriShim(page);
  await seedOverlay(page, { stage: { displayFingerprint: 'dsp-gone-from-this-desk' } });
  await page.goto('/control.html');

  await expect(page.getByRole('heading', heading)).toBeVisible();

  const row = displayRow(page);
  await expect(row).toContainText('Needs attention');
  await expect(row).toHaveClass(/attention/);
  // Named, not merely flagged: the fallback comes from the same resolver the
  // real take uses, so this is where the prompt would actually appear.
  await expect(row).toContainText(PROMPTER_DISPLAY);

  await row.getByRole('button', { name: 'Fix display' }).click();

  await expect(
    page
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('button', { name: 'Stage display', exact: true }),
  ).toHaveAttribute('aria-current', 'page');

  // Looking at a setting is not finishing onboarding.
  expect(await page.evaluate((key) => localStorage.getItem(key), WELCOMED_KEY)).toBeNull();
});

test('the microphone fix-link opens Audio settings and leaves welcome undismissed', async ({
  page,
}) => {
  await installTauriShim(page);
  await page.goto('/control.html');

  await expect(page.getByRole('heading', heading)).toBeVisible();
  await micRow(page).getByRole('button', { name: 'Set up microphone' }).click();

  await expect(
    page
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('button', { name: 'Audio', exact: true }),
  ).toHaveAttribute('aria-current', 'page');

  expect(await page.evaluate((key) => localStorage.getItem(key), WELCOMED_KEY)).toBeNull();

  // And because it was never marked, quitting here brings the screen back
  // rather than stranding a user who has not started.
  await page.goto('/control.html');
  await expect(page.getByRole('heading', heading)).toBeVisible();
});

/**
 * A readiness check that cannot answer must not take the screen down with it.
 *
 * Stage settings already reports enumeration failure properly and offers a
 * retry; Welcome's job is to stay calm, stay out of the way, and let the user
 * get on with the thing they came here to do.
 */
test('a rejecting display enumeration leaves welcome usable and still dismissible by starting', async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await installTauriShim(page, { failListDisplays: true });
  await page.goto('/control.html');

  await expect(page.getByRole('heading', heading)).toBeVisible();
  await expect(displayRow(page)).toContainText('Couldn’t check');
  // Unknown is not broken: no warning tint for a check that merely could not run.
  await expect(displayRow(page)).not.toHaveClass(/attention/);

  const sample = page.getByRole('button', { name: 'Open the sample script' });
  await expect(sample).toBeEnabled();
  await sample.click();

  // The sample is the primary path and it works with the rig unverified.
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Script title' })).toHaveValue(
    'Sample: read this aloud',
  );
  // Starting IS the terminal action, so this one does dismiss the screen.
  expect(await page.evaluate((key) => localStorage.getItem(key), WELCOMED_KEY)).toBe('1');

  errors.expectClean();
});

/**
 * Reader mode presents in an ordinary window at desk distance, so there is no
 * second panel to choose. Asking a reader-mode user to pick a teleprompter
 * screen is a readiness item about a rig they do not have.
 */
test('reader mode reports the current window instead of asking for a second screen', async ({
  page,
}) => {
  await installTauriShim(page);
  await seedOverlay(page, { stage: { presentationMode: 'reader' } });
  await page.goto('/control.html');

  await expect(page.getByRole('heading', heading)).toBeVisible();
  await expect(displayRow(page)).toContainText('This window');
  await expect(displayRow(page)).not.toHaveClass(/setup|attention/);
});

/**
 * The sample script leads now.
 *
 * It is the only one of the three that hands back something written to be read
 * ALOUD, and reading aloud is the only way to see what this app does. A blank
 * stub cannot demonstrate following, so offering it first asked new users to
 * supply the demo themselves.
 */
test('the sample script is the primary action and leads the three CTAs', async ({ page }) => {
  await installTauriShim(page);
  await page.goto('/control.html');

  await expect(page.getByRole('heading', heading)).toBeVisible();

  const actions = page.locator('.actions button');
  await expect(actions).toHaveText([
    'Open the sample script',
    'Create your first script',
    'Import Markdown',
  ]);
  await expect(actions.first()).toHaveClass(/primary/);
  await expect(actions.nth(1)).not.toHaveClass(/primary/);
  await expect(actions.nth(2)).not.toHaveClass(/primary/);
});
