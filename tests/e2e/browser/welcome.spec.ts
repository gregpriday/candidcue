import { test, expect, type Locator, type Page } from '@playwright/test';
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
 * Four things here are easy to break and invisible when broken:
 *
 *   - TONE. On a genuine first launch nobody has granted the microphone, so
 *     `microphoneGranted` is false for EVERY new user. That is expected setup,
 *     not a fault, and it must not render in the warning treatment reserved for
 *     a rig that has actually degraded. If those two ever collapse into one
 *     tone, the first screen of the product reports a problem to everybody.
 *     Row wash and pill tone are separate fields, so both are asserted — a pill
 *     that turned warning under an unchanged row class would otherwise pass.
 *   - THE SOURCE OF THE MICROPHONE ANSWER. It must be the persisted settings
 *     flag, never a live permission query — see the Chromium note below.
 *   - THE EMPTY LIST. A successful enumeration returning nothing is a different
 *     state from a rejected one, and it is the half of the branch that fails
 *     silently: drop it and the screen names a display it was never told about
 *     while the rejection test stays green.
 *   - NOT DISMISSING. Going to look at a setting is not finishing onboarding,
 *     so a fix-link must leave the welcomed flag alone.
 */

const OVERLAY_KEY = 'candidcue.settings-overlay.v1';
const WELCOMED_KEY = 'candidcue.welcomed.v1';

/** The prompter panel in the shim's fixed display fixtures. */
const PROMPTER_DISPLAY = 'Teleprompter Display';

const heading = { name: 'Speak naturally. Keep your place.' };

const micRow = (page: Page) => page.locator('.readiness-item').filter({ hasText: 'Microphone' });
const displayRow = (page: Page) =>
  page.locator('.readiness-item').filter({ hasText: 'Teleprompter screen' });

/** The status capsule inside a row, whose class carries the tone. */
const pill = (row: Locator) => row.locator('.pill');

/** Exact class-token match — `/setup/` alone would also match `setup-hint`. */
const hasToken = (token: string) => new RegExp(`(?:^|\\s)${token}(?:\\s|$)`);

async function seedOverlay(page: Page, overlay: Record<string, unknown>): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      localStorage.setItem(key as string, value as string);
    },
    [OVERLAY_KEY, JSON.stringify(overlay)] as const,
  );
}

const welcomedFlag = (page: Page) => page.evaluate((key) => localStorage.getItem(key), WELCOMED_KEY);

test('a first launch reports the microphone as setup, not as a fault, and resolves the display', async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  // No `welcomed` flag and no overlay: a genuine first launch.
  await installTauriShim(page);
  await page.goto('/control.html');

  await expect(page.getByRole('heading', heading)).toBeVisible();

  // Expected setup reads accent, NOT the warning treatment — in the row wash
  // AND in the pill, which are set independently.
  await expect(pill(micRow(page))).toHaveText('Set up');
  await expect(pill(micRow(page))).toHaveClass(hasToken('accent'));
  await expect(micRow(page)).toHaveClass(hasToken('setup'));
  await expect(micRow(page)).not.toHaveClass(hasToken('attention'));

  // The display probe settles and names where a take would actually land,
  // rather than leaving "Checking…" on screen forever.
  await expect(pill(displayRow(page))).toHaveText('Automatic');
  await expect(pill(displayRow(page))).toHaveClass(hasToken('neutral'));
  await expect(displayRow(page)).toContainText(PROMPTER_DISPLAY);
  await expect(displayRow(page)).not.toHaveClass(hasToken('attention'));

  // Nothing is gated: all three content actions stay pressable while the rig
  // is unproven. This is the no-preflight rule, asserted rather than assumed.
  for (const name of ['Open the sample script', 'Create your first script', 'Import Markdown']) {
    await expect(page.getByRole('button', { name })).toBeEnabled();
  }

  errors.expectClean();
});

/**
 * The in-flight state, and the guard that has to survive it.
 *
 * Held open from before boot, because `__E2E__.setDelay` is only reachable
 * after navigation — by which point Welcome has already asked. Leaving the
 * screen mid-probe is the case the effect's cleanup exists for: the reply
 * lands after the component is gone, and writing state there is the classic
 * way this pattern throws into the console.
 */
test('the display row shows a checking state and survives leaving while it is in flight', async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await installTauriShim(page, { listDisplaysDelayMs: 3000 });
  await page.goto('/control.html');

  await expect(page.getByRole('heading', heading)).toBeVisible();
  await expect(pill(displayRow(page))).toHaveText('Checking…');
  // An unanswered check is not a fault and must not be dressed as one.
  await expect(displayRow(page)).not.toHaveClass(hasToken('attention'));

  // Leave before the reply arrives, then outlive it.
  await micRow(page).getByRole('button', { name: 'Set up microphone' }).click();
  await expect(
    page
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('button', { name: 'Audio', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await page.waitForTimeout(3500);

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
 *
 * The counters are published only AFTER every wrapper is installed, so a throw
 * during setup fails the test instead of leaving three honest-looking zeroes.
 */
test('the welcome screen never probes microphone hardware to answer its own readiness row', async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await installTauriShim(page);
  await page.addInitScript(() => {
    const counters = { query: 0, getUserMedia: 0, enumerateDevices: 0 };

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

    window.__MIC_PROBES__ = counters;
  });
  await page.goto('/control.html');

  // Read the counters only once the screen has fully settled — both rows in
  // their final state — or this asserts about a render that had not happened.
  await expect(pill(micRow(page))).toHaveText('Set up');
  await expect(pill(displayRow(page))).toHaveText('Automatic');

  expect(await page.evaluate(() => window.__MIC_PROBES__)).toEqual({
    query: 0,
    getUserMedia: 0,
    enumerateDevices: 0,
  });

  // One probe per mount: the effect deliberately reads no reactive state, so a
  // future edit that gives it a dependency would re-ask on every settings tick.
  const calls = await page.evaluate(
    () => window.__E2E__.calls.filter((c) => c.command === 'list_displays').length,
  );
  expect(calls).toBe(1);

  errors.expectClean();
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

  await expect(pill(micRow(page))).toHaveText('Access allowed');
  await expect(pill(micRow(page))).toHaveClass(hasToken('neutral'));
  await expect(micRow(page)).not.toHaveClass(hasToken('setup'));
  // The claim is narrow on purpose. The flag is never cleared when a grant is
  // revoked in System Settings, so it cannot support a present-tense promise
  // that the app can hear you — only that access was allowed here once.
  await expect(micRow(page)).toContainText('Access was allowed on this Mac');
  await expect(micRow(page)).not.toContainText('Ready');

  await expect(pill(displayRow(page))).toHaveText('Connected');
  await expect(pill(displayRow(page))).toHaveClass(hasToken('neutral'));
  await expect(displayRow(page)).toContainText(PROMPTER_DISPLAY);
  await expect(displayRow(page)).not.toHaveClass(hasToken('attention'));

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
  const errors = watchPageErrors(page);
  await installTauriShim(page);
  await seedOverlay(page, { stage: { displayFingerprint: 'dsp-gone-from-this-desk' } });
  await page.goto('/control.html');

  await expect(page.getByRole('heading', heading)).toBeVisible();

  const row = displayRow(page);
  await expect(pill(row)).toHaveText('Needs attention');
  await expect(pill(row)).toHaveClass(hasToken('warning'));
  await expect(row).toHaveClass(hasToken('attention'));
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
  expect(await welcomedFlag(page)).toBeNull();

  errors.expectClean();
});

test('the microphone fix-link opens Audio settings and leaves welcome undismissed', async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await installTauriShim(page);
  await page.goto('/control.html');

  await expect(page.getByRole('heading', heading)).toBeVisible();
  await micRow(page).getByRole('button', { name: 'Set up microphone' }).click();

  await expect(
    page
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('button', { name: 'Audio', exact: true }),
  ).toHaveAttribute('aria-current', 'page');

  expect(await welcomedFlag(page)).toBeNull();

  // And because it was never marked, quitting here brings the screen back
  // rather than stranding a user who has not started.
  await page.goto('/control.html');
  await expect(page.getByRole('heading', heading)).toBeVisible();

  errors.expectClean();
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
  await expect(pill(displayRow(page))).toHaveText('Couldn’t check');
  // Unknown is not broken: no warning tint for a check that merely could not run.
  await expect(pill(displayRow(page))).toHaveClass(hasToken('neutral'));
  await expect(displayRow(page)).not.toHaveClass(hasToken('attention'));

  const sample = page.getByRole('button', { name: 'Open the sample script' });
  await expect(sample).toBeEnabled();
  await sample.click();

  // The sample is the primary path and it works with the rig unverified.
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Script title' })).toHaveValue(
    'Sample: read this aloud',
  );
  // Starting IS the terminal action, so this one does dismiss the screen.
  expect(await welcomedFlag(page)).toBe('1');

  errors.expectClean();
});

/**
 * A successful call that returns nothing is NOT the rejection above.
 *
 * Rust answers `Ok([])` whenever `available_monitors()` succeeds and finds no
 * panel, and the row has to treat that as "cannot say" rather than as a normal
 * list. Without this test, deleting the empty-list half of that branch renders
 * "Automatic — Takes open on the best available display" about a machine that
 * reported no displays at all, and every other spec here stays green.
 */
test('a successful but empty enumeration is reported as unknown, not as automatic', async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await installTauriShim(page, { emptyDisplays: true });
  await page.goto('/control.html');

  await expect(page.getByRole('heading', heading)).toBeVisible();
  await expect(pill(displayRow(page))).toHaveText('Couldn’t check');
  await expect(displayRow(page)).not.toContainText('Automatic');
  await expect(displayRow(page)).not.toHaveClass(hasToken('attention'));

  errors.expectClean();
});

/**
 * Reader mode presents in an ordinary window at desk distance, so there is no
 * second panel to choose. Asking a reader-mode user to pick a teleprompter
 * screen is a readiness item about a rig they do not have — and the action must
 * not say "Choose display" either, because `chooseStageDisplay` ignores the pin
 * entirely in this mode and would be offering a choice nothing reads.
 *
 * The mode comes from the Rust document rather than the localStorage overlay:
 * the overlay is the pre-migration fallback, and seeding it there would prove
 * the migration works instead of proving this row does.
 */
test('reader mode reports the current window instead of asking for a second screen', async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  // Held open so the state can be checked BEFORE the probe answers as well as
  // after: the reader branch short-circuits ahead of the probe, so an assertion
  // that only ran early would pass without the settled render ever happening.
  await installTauriShim(page, { presentationMode: 'reader', listDisplaysDelayMs: 1200 });
  await page.goto('/control.html');

  await expect(page.getByRole('heading', heading)).toBeVisible();
  await expect(pill(displayRow(page))).toHaveText('This window');
  await expect(displayRow(page)).toContainText('No second screen needed');
  await expect(
    displayRow(page).getByRole('button', { name: 'Stage settings' }),
  ).toBeVisible();

  // Still true once enumeration has come back — a display list must not pull a
  // reader-mode user back into a prompter-shaped readiness item.
  await page.waitForTimeout(1600);
  await expect(pill(displayRow(page))).toHaveText('This window');
  await expect(displayRow(page)).not.toHaveClass(hasToken('attention'));
  await expect(displayRow(page)).not.toHaveClass(hasToken('setup'));

  errors.expectClean();
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
  const errors = watchPageErrors(page);
  await installTauriShim(page);
  await page.goto('/control.html');

  await expect(page.getByRole('heading', heading)).toBeVisible();

  const actions = page.locator('.actions button');
  await expect(actions).toHaveText([
    'Open the sample script',
    'Create your first script',
    'Import Markdown',
  ]);
  await expect(actions.first()).toHaveClass(hasToken('primary'));
  await expect(actions.nth(1)).not.toHaveClass(hasToken('primary'));
  await expect(actions.nth(2)).not.toHaveClass(hasToken('primary'));

  errors.expectClean();
});
