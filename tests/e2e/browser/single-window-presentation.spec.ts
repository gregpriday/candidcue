import { test, expect, type Page } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';
import { watchPageErrors } from './fixtures/page-errors';

const SCRIPT = {
  id: '44444444-4444-4444-8444-444444444444',
  title: 'Single-window walkthrough',
  source:
    '# Opening\n\nThank you for joining me today. Here is what changed this quarter.\n\n' +
    '## The numbers\n\nRevenue grew steadily. Churn came down.\n\n' +
    '## What is next\n\nWe ship the new onboarding in March.\n',
};

async function present(page: Page): Promise<void> {
  await page.goto('/control.html');
  await page
    .getByRole('list', { name: 'Scripts' })
    .getByRole('button', { name: 'Present', exact: true })
    .first()
    .click();
  await expect(page.getByRole('region', { name: 'Teleprompter' })).toBeVisible({
    timeout: 20_000,
  });
}

test.beforeEach(async ({ page }) => {
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [SCRIPT],
    keyStatus: { present: true, hint: 'sk-…live', source: 'keychain' },
    promptMode: 'voice',
  });
});

test('Present mounts the production stage in this webview and never opens another', async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await present(page);

  await expect(page.locator('aside.sidebar')).toHaveCount(0);
  await expect(page.locator('footer.transport')).toHaveCount(0);
  await expect(page.locator('.stage-root')).toHaveAttribute('data-phase', 'ready');
  await expect(page.locator('.script-layer')).toBeVisible();
  await expect(page.getByText('Thank you for joining me today.')).toBeVisible();
  await expect(page.locator('.diagnostics')).toBeVisible();
  await expect(page.locator('.transcript-tap')).toContainText('listening — no words yet');
  await expect(page.locator('.voice-pill')).toBeAttached({ timeout: 10_000 });

  const calls = await page.evaluate(() => window.__E2E__.calls.map((call) => call.command));
  expect(calls).toContain('start_session');
  expect(calls).toContain('start_alignment');
  expect(calls).toContain('plugin:window|set_fullscreen');
  expect(calls).not.toContain('open_stage');
  expect(calls).not.toContain('publish_stage_document');
  expect(calls).not.toContain('set_stage_fullscreen');

  errors.expectClean();
});

test('the one-screen script follows the control alignment position', async ({ page }) => {
  const errors = watchPageErrors(page);
  await present(page);

  await expect(page.locator('[data-t=\"0\"]')).not.toHaveClass(/past/);
  const delivered = await page.evaluate(() => {
    const generation = window.__E2E__.lastSession?.sessionGeneration ?? 0;
    return window.__E2E__.emit('align://snapshot', {
      sessionGeneration: generation,
      seq: 1,
      state: 'following',
      decision: 'localConfirmed',
      confirmedToken: 6,
      observedToken: 6,
      rateTokensPerSecond: 2,
      evidenceAudioMs: 1000,
      atAudioMs: 1000,
      maxPredictionMs: 800,
      pauseOnsetMs: 400,
      leadFloorMs: 0,
      maxLeadTokens: 2,
      displayLimitToken: 12,
      confidence: 0.95,
      suggestionToken: null,
      scriptLenTokens: 30,
      observedAtom: 6,
      confirmedAtom: 6,
    });
  });
  expect(delivered).toBeGreaterThan(0);
  await expect(page.locator('.stage-root')).toHaveAttribute('data-phase', 'live');
  await expect(page.locator('[data-t=\"0\"]')).toHaveClass(/past/);
  await expect(page.locator('.diagnostics')).toContainText('token: 6.0');

  errors.expectClean();
});

/*
 * ONE ESCAPE ASKS; TWO END IT — the same rule the standalone stage window has
 * always had.
 *
 * Presentation used to end the take on the first press, because the host was
 * right there and the round trip the two-press rule exists to cover did not
 * apply. That made the same key on the same screen mean two different things
 * depending on an architectural detail nobody using it can see, and the case
 * that matters is a presenter hitting Escape by reflex when a full-screen
 * window takes over their display.
 */
test('the first Escape prompts and the second ends the take, leaves full screen, and returns to the editor', async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await present(page);

  await page.keyboard.press('Escape');
  await expect(page.locator('.escape-hint')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Teleprompter' })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: 'Teleprompter' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Present', exact: true })).toBeVisible();

  const result = await page.evaluate(() => ({
    commands: window.__E2E__.calls.map((call) => call.command),
    session: window.__E2E__.lastSession,
  }));
  expect(result.commands.filter((command) => command === 'plugin:window|set_fullscreen')).toHaveLength(
    2,
  );
  expect(result.commands).toContain('end_session');

  errors.expectClean();
});

/*
 * The session dock, on the surface it actually ships on.
 *
 * Three claims that only a real browser can settle: that the routine controls
 * are all in one corner and the other three are empty in a Clean Take; that the
 * appearance panel rises from the button that raised it and fits; and that
 * turning the text mirror on does not move a single mouse target — a CSS
 * transform carries hit-testing with it, so a control inside the mirror plane
 * is clickable exactly where it appears, on the opposite side of the screen
 * from where it was a moment ago.
 */
test('the session dock is the only routine control surface, and mirroring does not move it', async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  /*
   * The Elgato Prompter's own geometry, not the default 1280x720.
   *
   * Everything this test asserts about fit is only interesting on the panel the
   * product is judged on — a 9-inch, 1024x600, non-Retina display behind glass.
   * At 720 tall the appearance panel has room to spare and the assertions below
   * pass whether or not the layout is right, which is worse than not having
   * them.
   */
  await page.setViewportSize({ width: 1024, height: 600 });
  await present(page);

  const dock = page.locator('.stage-dock');
  await expect(dock).toBeVisible();
  const before = await dock.boundingBox();
  expect(before).not.toBeNull();

  // Bottom left of the window, not merely somewhere.
  const viewport = page.viewportSize()!;
  expect(before!.x).toBeLessThan(viewport.width / 2);
  expect(before!.y).toBeGreaterThan(viewport.height / 2);

  // Cmd/Ctrl+Shift+M is the mirror shortcut; the script flips, the dock does not.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+M' : 'Control+Shift+M');
  await expect(page.locator('.stage-talent-plane')).toHaveAttribute('data-mirror-x', 'true');
  const after = await dock.boundingBox();
  expect(after!.x).toBeCloseTo(before!.x, 0);
  expect(after!.y).toBeCloseTo(before!.y, 0);

  // The appearance panel opens upward from its own button and stays on screen.
  await page.locator('.stage-root').hover();
  await page.locator('.stage-dock .dock-button.adjust').click();
  const panel = page.locator('.stage-dock .appearance-popover');
  await expect(panel).toBeVisible();
  const panelBox = await panel.boundingBox();
  expect(panelBox!.y).toBeGreaterThanOrEqual(0);
  expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(before!.y + 1);

  /*
   * ...and every control in it is REACHABLE without discovering that the panel
   * scrolls. A control below the fold of a scrimless popover somebody is
   * operating mid-take, with a presenter waiting, is a control that is not
   * there. Asserted at the Prompter's own 1024x600 rather than at whatever the
   * developer's display happens to be.
   */
  const overflow = await panel
    .locator('.sheet .body')
    .evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(overflow, 'the appearance panel must fit on a 1024x600 Prompter').toBe(0);

  // Escape closes the panel and does NOT begin ending the take.
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(page.locator('.escape-hint')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Teleprompter' })).toBeVisible();

  errors.expectClean();
});

/*
 * The appearance transaction, end to end, on the real surface.
 *
 * This is the seam nothing else covers: the panel is control's, the button that
 * raises it is the stage's, and the snapshot that Cancel restores is the
 * session store's. Each of the three is unit-tested and the promise only exists
 * where they meet — every drag reaches the glass on the way past, and backing
 * out puts the take back exactly as it was found.
 *
 * Both dismissals are checked because the dock routes them to the same place
 * for a reason: a click away that merely CLOSED would silently keep changes
 * nobody confirmed, with the button that would have undone them gone.
 */
test('the appearance panel applies live and restores what it opened on', async ({ page }) => {
  const errors = watchPageErrors(page);
  await page.setViewportSize({ width: 1024, height: 600 });
  await present(page);

  const scriptColumn = page.locator('.script-layer .column').first();
  const widthOf = async () => (await scriptColumn.boundingBox())!.width;

  await page.locator('.stage-root').hover();
  await page.locator('.stage-dock .dock-button.adjust').click();
  const panel = page.locator('.stage-dock .appearance-popover');
  await expect(panel).toBeVisible();

  const opened = await widthOf();
  const width = panel.locator('input[type="range"]').nth(1); // Text width
  await width.fill('50');
  await width.dispatchEvent('input');
  // Live, on the way past — not on the way out.
  await expect.poll(widthOf).toBeLessThan(opened - 20);

  // Escape means cancel, and cancel means exactly what it was found as.
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect.poll(widthOf).toBeCloseTo(opened, 0);

  // And a click away is the same promise, not a quiet keep.
  await page.locator('.stage-dock .dock-button.adjust').click();
  await expect(panel).toBeVisible();
  await width.fill('50');
  await width.dispatchEvent('input');
  await expect.poll(widthOf).toBeLessThan(opened - 20);
  await page.mouse.click(900, 120);
  await expect(panel).toHaveCount(0);
  await expect.poll(widthOf).toBeCloseTo(opened, 0);

  errors.expectClean();
});
