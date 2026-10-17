import { test, expect, type Page } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';
import { watchPageErrors } from './fixtures/page-errors';
import { moves } from './fixtures/take-motion';

/*
 * #284 — THE SESSION CONTROLS THAT DID NOTHING DURING A TAKE.
 *
 * Live stands down during a take for the keys the embedded stage answers on its
 * own listener, so one Space is not a pause and then a resume. Hard pause and
 * the section jumps were on that list too, and the stage has neither: it read
 * ⌥↓ as a plain ↓ and stepped a line, and ⌘⇧Space as a plain Space. A menu
 * command never reaches the stage at all, so Session › Pause, Next Section and
 * Previous Section stood down for a handler that did not exist.
 *
 * This runs the production single-window path: real keys, the real store and
 * driver, the embedded stage. The menu is driven by `menu://command`, which is
 * what the native menu sends — the menu bar itself cannot be clicked from a
 * browser, and neither can a native accelerator, which in the packaged app
 * takes ⌥↑/⌥↓ before this page would ever see the key.
 */

const SCRIPT = {
  id: '28428428-4284-4284-8284-284284284284',
  title: 'Session shortcuts',
  source:
    '# Opening\n\nWelcome back to the channel. Today we look at the quarter. It was a strange one.\n\n' +
    '## The numbers\n\nQuarterly revenue grew by a third. Costs held flat for once.\n\n' +
    '## What is next\n\nHiring opens in March. Then we ship the new studio.\n',
};

test.beforeEach(async ({ page }) => {
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [SCRIPT],
    engineStatus: {
      available: true,
      loaded: true,
      model: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05',
    },
    promptMode: 'voice',
    // The `.diagnostics` readout's `token:` line is how these specs read where
    // the stage says it is, and it is drawn only in Diagnostic Take (#300).
    diagnosticTake: true,
  });
  await page.setViewportSize({ width: 1280, height: 720 });
});

async function present(page: Page): Promise<void> {
  await page.goto('/control.html');
  await page
    .getByRole('listbox')
    .getByRole('button', { name: 'Present', exact: true })
    .first()
    .click();
  await expect(page.getByRole('region', { name: 'Teleprompter' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator('.stage-root')).toHaveAttribute('data-phase', /ready|live/);
  await expect(page.locator('.scroll-plane')).toBeVisible();
  // A take from the top issues no opening anchor, so every move below is ours.
  expect(await moves(page)).toEqual([]);
}

/** The token a word is painted at — where a section's first sentence starts. */
async function tokenOf(page: Page, word: string): Promise<number> {
  const token = await page.evaluate((text) => {
    const span = [...document.querySelectorAll<HTMLElement>('.stage-root [data-t]')].find(
      (el) => el.textContent?.trim() === text,
    );
    return span ? Number(span.dataset['t']) : null;
  }, word);
  expect(token, `no token painted for "${word}"`).not.toBeNull();
  return token!;
}

/** Fire a native menu command the way Rust delivers it. */
async function chooseMenuCommand(page: Page, id: string): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        (commandId) => window.__E2E__.emit('menu://command', { id: commandId }),
        id,
      ),
    )
    .toBeGreaterThan(0);
}

/** What Session › Pause says now — the label follows the session's pause. */
function pauseLabel(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const call = window.__E2E__.lastCall('set_menu_state');
    const items = (call?.args as { items?: Array<{ id: string; label?: string }> } | null)?.items;
    return items?.find((item) => item.id === 'session.play-pause')?.label ?? null;
  });
}

/**
 * The hard-pause chord for the platform the PAGE says it is on.
 *
 * Not Playwright's `ControlOrMeta`, which follows the machine running the
 * test. The page follows its user agent, and the Desktop Chrome profile these
 * specs run under reports Windows whatever the host — so on a Mac, Meta was
 * pressed at a page that only answers Ctrl.
 */
async function hardPauseChord(page: Page): Promise<string> {
  const platform = await page.locator('html').getAttribute('data-platform');
  return platform === 'macos' ? 'Meta+Shift+Space' : 'Control+Shift+Space';
}

function count(page: Page, command: string): Promise<number> {
  return page.evaluate(
    (name) => window.__E2E__.calls.filter((call) => call.command === name).length,
    command,
  );
}

/**
 * Wait for a section move to land: asked for, answered, and on the screen.
 * Waited out before the next one so each is measured from where the last left
 * the take, which is how a presenter presses them.
 */
async function expectMoves(page: Page, expected: number[]): Promise<void> {
  await expect.poll(() => moves(page)).toEqual(expected);
  await expect(page.locator('.diagnostics')).toContainText(
    `token: ${expected.at(-1)!.toFixed(1)}`,
  );
}

test('⌥↓ and ⌥↑ jump a whole section, from the first press', async ({ page }) => {
  const errors = watchPageErrors(page);
  await present(page);
  const numbers = await tokenOf(page, 'Quarterly');
  const next = await tokenOf(page, 'Hiring');

  // There is no section before the first, so ⌥↑ there asks for nothing.
  await page.keyboard.press('Alt+ArrowUp');

  // From the top, before the take has any position: the first press used to
  // ask for the section already on the glass.
  await page.keyboard.press('Alt+ArrowDown');
  await expectMoves(page, [numbers]);
  await page.keyboard.press('Alt+ArrowDown');
  await expectMoves(page, [numbers, next]);
  await page.keyboard.press('Alt+ArrowUp');
  await expectMoves(page, [numbers, next, numbers]);

  /*
   * And no line step reported behind them. The stage's step reports a moment
   * later, once the gesture has settled, so it is looked for after that. This
   * is the weaker half — a report that lands behind a reposition is dropped —
   * and `stage-embedded-keyboard.test.ts` is the direct proof the stage no
   * longer answers the chord at all.
   */
  await page.waitForTimeout(600);
  expect(await moves(page)).toEqual([numbers, next, numbers]);
  errors.expectClean();
});

test('⌥↓ from between two sentences lands on the next section, not past it', async ({
  page,
}) => {
  /*
   * Section jumps used to be RELATIVE sentence moves, counted from Live's
   * sentence index (the sentence CONTAINING the cursor, or 0 when none does)
   * and applied by the driver from its own (the last sentence STARTING at or
   * before it). A cursor between two sentences read differently to each, and
   * the jump overshot by the difference. Every move above starts exactly on a
   * sentence, where the two agree, so it takes a position from the voice to
   * tell an absolute jump from a relative one.
   */
  const errors = watchPageErrors(page);
  await present(page);
  const numbers = await tokenOf(page, 'Quarterly');
  // After "Today we look at the quarter." and before "It was a strange one."
  const between = (await tokenOf(page, 'It')) - 0.5;

  await page.evaluate((at) => {
    window.__E2E__.emit('align://snapshot', {
      sessionGeneration: window.__E2E__.lastSession?.sessionGeneration ?? 0,
      seq: 1,
      state: 'following',
      decision: 'localConfirmed',
      confirmedToken: at,
      observedToken: at,
      rateTokensPerSecond: 0,
      evidenceAudioMs: 1000,
      atAudioMs: 1000,
      maxPredictionMs: 0,
      pauseOnsetMs: 0,
      leadFloorMs: 0,
      maxLeadTokens: 0,
      leadMarginTokens: 0,
      leadEaseMs: 0,
      leadHoldMs: 0,
      leadDecayMs: 0,
      displayLimitToken: at,
      confidence: 0.95,
      suggestionToken: null,
      scriptLenTokens: 40,
      observedAtom: at,
      confirmedAtom: at,
    });
  }, between);
  await expect(page.locator('.diagnostics')).toContainText(`token: ${between.toFixed(1)}`);

  await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(() => moves(page)).toEqual([numbers]);
  errors.expectClean();
});

test('Session › Next and Previous Section jump the same way', async ({ page }) => {
  const errors = watchPageErrors(page);
  await present(page);
  const numbers = await tokenOf(page, 'Quarterly');
  const next = await tokenOf(page, 'Hiring');

  await chooseMenuCommand(page, 'session.next-chapter');
  await expectMoves(page, [numbers]);
  await chooseMenuCommand(page, 'session.next-chapter');
  await expectMoves(page, [numbers, next]);
  await chooseMenuCommand(page, 'session.previous-chapter');
  await expectMoves(page, [numbers, next, numbers]);
  errors.expectClean();
});

/*
 * What a browser can see of a hard pause is the recogniser session closing —
 * the thing a soft pause deliberately keeps open. That the capture device is
 * released with it is `teardownAudio`'s job, covered with the voice pipeline's
 * own tests.
 */
test('⌘⇧Space hard-pauses, and pressing it again does not reopen anything', async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await present(page);
  // The voice has a session to close.
  await expect
    .poll(() => page.evaluate(() => window.__E2E__.settled.includes('start_transcription')))
    .toBe(true);
  const opened = await count(page, 'start_transcription');
  expect(await count(page, 'stop_transcription')).toBe(0);
  const chord = await hardPauseChord(page);

  await page.keyboard.press(chord);
  await expect.poll(() => count(page, 'stop_transcription')).toBe(1);
  await expect.poll(() => pauseLabel(page)).toBe('Resume');

  // Not a toggle: a second press is still a hard pause, and nothing reopens.
  await page.keyboard.press(chord);
  await page.waitForTimeout(500);
  expect(await count(page, 'start_transcription')).toBe(opened);
  expect(await count(page, 'stop_transcription')).toBe(1);
  expect(await pauseLabel(page)).toBe('Resume');
  errors.expectClean();
});

test('Session › Pause pauses and resumes, and Space still toggles once', async ({ page }) => {
  const errors = watchPageErrors(page);
  await present(page);
  await expect.poll(() => pauseLabel(page)).toBe('Pause');

  await chooseMenuCommand(page, 'session.play-pause');
  await expect.poll(() => pauseLabel(page)).toBe('Resume');
  await chooseMenuCommand(page, 'session.play-pause');
  await expect.poll(() => pauseLabel(page)).toBe('Pause');

  // One press, one pause: Live still leaves the key to the stage, which is
  // what the delegation list was for.
  await page.keyboard.press(' ');
  await expect.poll(() => pauseLabel(page)).toBe('Resume');
  await page.waitForTimeout(300);
  expect(await pauseLabel(page)).toBe('Resume');
  errors.expectClean();
});
