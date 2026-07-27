import { test, expect, type Page } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';
import { watchPageErrors } from './fixtures/page-errors';
import { dismissAllToasts } from './fixtures/toasts';

/**
 * The LIVE SESSION journey, SHIM-BACKED (production IPC path).
 *
 * Present runs the real §29.2 sequence — compile, session record, stage
 * window, envelope, handshake, present — and lands on the Live screen, which is
 * drivable end to end from there. There is no readiness page in between: what
 * used to be Preflight's checks are settings, and what used to be its gate is
 * reported from the running take instead (lib/start-take.ts).
 *
 * ----------------------------------------------------------------------------
 * WHAT A BROWSER CAN AND CANNOT PROVE HERE — read this before adding to it.
 *
 * A genuine TAKE needs a real microphone, a live Inworld transcription session
 * and the Realtime provider. None of that exists in this harness, and nothing
 * below fakes a transcription pipeline. What IS driven is the session SHELL and
 * every state it can honestly reach without audio:
 *
 *   - the whole start sequence on the wire (session record → stage open →
 *     envelope → handshake → present), including the generation/id ownership
 *     that a packaged build depends on;
 *   - the transport: start prompting, pause, resume, and the operator's own
 *     manual moves (sentence steps, outline jumps), which move the reading
 *     position without any voice input at all — this is exactly what MANUAL
 *     mode is, so it is a real take, not a simulated one;
 *   - the §62 stage-closed degradation, delivered on the real Rust → control
 *     event channel;
 *   - stopping: the session record closes and the F.17 summary appears.
 *
 * NOT covered, and not fakeable here: transcription, voice following, wake-word
 * commands, retake detection, the realtime cost meter, and every follow state
 * that only speech can produce. Those need hardware and a provider.
 * ----------------------------------------------------------------------------
 */

const SCRIPT = {
  id: '44444444-4444-4444-8444-444444444444',
  title: 'Quarterly walkthrough',
  source:
    '# Opening\n\nThank you for joining me today. Here is what changed this quarter.\n\n' +
    '## The numbers\n\nRevenue grew steadily. Churn came down.\n\n' +
    '## What is next\n\nWe ship the new onboarding in March.\n',
};

const READY_KEY = { present: true, hint: 'sk-…live', source: 'keychain' };

/** Library → Present → a started take, left on the Live screen. */
async function startManualTake(page: Page): Promise<void> {
  await page.goto('/control.html');
  await page
    .getByRole('list', { name: 'Scripts' })
    .getByRole('button', { name: 'Present', exact: true })
    .first()
    .click();

  /*
   * One press. There is no screen between the library and the stage any more,
   * so the compile, the session record, the stage window and the handshake all
   * happen behind this click — and the Live screen appearing at all is proof
   * that every one of them returned. The timeout covers the compile worker,
   * which is the slow step and the one that used to be broken.
   *
   * The Live screen is up when its always-visible transport is (spec §15.1).
   */
  await expect(page.locator('footer.transport')).toBeVisible({ timeout: 20_000 });
}

test.beforeEach(async ({ page }) => {
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [SCRIPT],
    keyStatus: READY_KEY,
    // Manual mode: the operator drives the script themselves. Everything below
    // is genuinely reachable in this mode with no microphone in the room.
    promptMode: 'manual',
  });
});

test('Start runs the real §29.2 sequence and the Live screen comes up on the presented stage', async ({
  page,
}, testInfo) => {
  const errors = watchPageErrors(page);
  await startManualTake(page);

  // The operator is looking at their own take: title, elapsed clock, mode.
  const statusBar = page.locator('header.statusbar');
  await expect(statusBar.getByText('Quarterly walkthrough')).toBeVisible();
  await expect(statusBar.getByText('Manual', { exact: true })).toBeVisible();
  /*
   * Prompting, not "Ready to start". Present IS the start: a take used to open
   * with the engine paused, so the microphone recorded, the provider
   * transcribed and every word was dropped on the floor until somebody found
   * the differently-named Start button in the transport. The explicit control
   * survives as Pause, which is the one a presenter actually reaches for.
   */
  await expect(statusBar.getByText('Prompting')).toBeVisible();

  // The script really is on this screen — outline from the compiled document.
  const outline = page.getByRole('complementary', { name: 'Sections' });
  await expect(outline.getByRole('button', { name: 'Opening' })).toBeVisible();
  await expect(outline.getByRole('button', { name: 'The numbers' })).toBeVisible();
  await expect(outline.getByRole('button', { name: 'What is next' })).toBeVisible();

  // A blank frame is a failed launch, not a pass.
  await page.screenshot({ path: testInfo.outputPath('live-started.png'), fullPage: true });

  // The start sequence went out in the order §29.2 requires. Getting this wrong
  // is not cosmetic: opening the stage before the session record leaves Rust's
  // coordinator at generation 0 and every stage payload is rejected.
  const order = await page.evaluate(() =>
    window.__E2E__.calls
      .map((c) => c.command)
      .filter((c) =>
        ['start_session', 'open_stage', 'publish_stage_document', 'set_stage_fullscreen'].includes(c),
      ),
  );
  // Sliced from the end because a display test in Settings can have opened a
  // throwaway stage earlier in a longer journey; the sequence that matters is
  // the take's own, and it is the last four.
  expect(order.slice(-4)).toEqual([
    'start_session',
    'open_stage',
    'publish_stage_document',
    'set_stage_fullscreen',
  ]);

  // RUST ASSIGNS, CONTROL ADOPTS. The envelope must carry the id and the
  // generation the session record came back with — not a locally minted id and
  // not a hard-coded 1, which is what `validate_stage_payload_header` rejects.
  const adopted = await page.evaluate(() => {
    const envelopeCall = window.__E2E__.lastCall('publish_stage_document');
    const args = envelopeCall?.args as
      | { sessionId: string; documentEnvelope: { sessionId: string; sessionGeneration: number } }
      | undefined;
    return { row: window.__E2E__.lastSession, args: args ?? null };
  });
  expect(adopted.row).not.toBeNull();
  expect(adopted.args).not.toBeNull();
  expect(adopted.args!.sessionId).toBe(adopted.row!.id);
  expect(adopted.args!.documentEnvelope.sessionId).toBe(adopted.row!.id);
  expect(adopted.args!.documentEnvelope.sessionGeneration).toBe(adopted.row!.sessionGeneration);

  // And the stage was actually PRESENTED, not merely opened hidden.
  const stage = await page.evaluate(() => window.__E2E__.stage);
  expect(stage.visible).toBe(true);
  expect(stage.fullscreen).toBe(true);

  errors.expectClean();
});

/*
 * NEVER SHOW A CONFIDENT STATE YOU DO NOT HAVE.
 *
 * `connection` and `micState` start at 'connected'/'live' and are only ever
 * corrected by a running voice pipeline. A manual take never constructs one, so
 * the status bar read "Connected · Mic live" over a take with no realtime
 * session and no open microphone — and the Tracking panel offered a wake word
 * that nothing was listening for. The operator reads exactly these indicators
 * to decide whether a failure is their microphone or their script.
 *
 * The paired voice-mode assertions live in live-voice-transport.spec.ts, so a
 * "fix" that simply deletes the indicators fails there.
 */
test('a manual take claims no connection, no microphone and no wake word', async ({ page }) => {
  const errors = watchPageErrors(page);
  await startManualTake(page);

  const statusBar = page.locator('header.statusbar');
  await expect(statusBar.getByText('Manual', { exact: true })).toBeVisible();
  await expect(statusBar.getByText('No microphone', { exact: true })).toBeVisible();
  await expect(statusBar.getByText('Connected', { exact: true })).toHaveCount(0);
  await expect(statusBar.getByText('Mic live', { exact: true })).toHaveCount(0);

  // The Tracking panel, before the take has started.
  const tracking = page.locator('.follow-state');
  await expect(tracking.getByText('still listening for')).toHaveCount(0);
  await expect(tracking.getByText('Transcription is still connected')).toHaveCount(0);
  await expect(tracking.getByText('Manual take — nothing is listening.', { exact: false })).toBeVisible();

  // And after a pause, where the wake-word copy used to reappear in both
  // places. The take is already prompting — Present is the start — so Pause is
  // the control that is offered.
  await page.locator('footer.transport').getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(statusBar.getByText('Paused — the script stays where it is')).toBeVisible();
  await expect(statusBar.getByText('still listening for')).toHaveCount(0);
  await expect(tracking.getByText('still listening for')).toHaveCount(0);
  await expect(tracking.getByText('Transcription is still connected')).toHaveCount(0);

  errors.expectClean();
});

/*
 * §27 Coaching Rail toggle. The voice command ("CandidCue, show me my stats")
 * needs a working realtime transport; the button is the half that works when
 * voice does not. Coaching never runs in a manual take, and mode `off`
 * reserves no band at all, so here the button must report that honestly rather
 * than pretending to toggle something that was never reserved.
 */
test('the transport and the outline move the reading position and tell the stage', async ({
  page,
}, testInfo) => {
  const errors = watchPageErrors(page);
  await startManualTake(page);

  const transport = page.locator('footer.transport');
  const statusBar = page.locator('header.statusbar');
  const currentSentence = page.locator('.preview-sentence.current');

  /*
   * The take is already prompting: Present is the start, so the transport opens
   * on Pause and there is a cursor on the first sentence without anyone pressing
   * anything. A take that opened idle is what put the microphone, the provider
   * and the ledger to work on words the aligner then dropped.
   */
  await expect(transport.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await expect(transport.getByRole('button', { name: 'Start', exact: true })).toHaveCount(0);
  // 'Prompting', not 'Following': a manual take has no aligner to follow
  // anything with, and saying otherwise is the confident-state-you-do-not-have
  // failure the pair of tests above and below exists to catch.
  await expect(statusBar.getByText('Prompting')).toBeVisible();
  /*
   * And no reading position yet, which is the honest state: a manual take has
   * heard nothing, so nothing has told it where in the script anyone is. The
   * cursor appears when the operator says — which is the next line.
   */
  await expect(currentSentence).toHaveCount(0);

  // A manual step really moves the reading position...
  await page.getByRole('button', { name: 'Forward one sentence' }).click();
  await expect(currentSentence).toHaveText('here is what changed this quarter');

  /*
   * ...and it went to the ENGINE, which is the single writer of position.
   *
   * This used to assert a `publish_stage_snapshot` call — control computing a
   * position and pushing it at the stage directly. That command no longer
   * exists: alignment lives in Rust, and Rust fans one snapshot out to both
   * windows (`align://snapshot` here, `stage://alignment-snapshot` there), so
   * control and stage cannot disagree about where the reader is. The move a
   * control window makes is therefore `set_alignment_position`, and everything
   * downstream follows from it.
   */
  const moved = await page.evaluate(() => {
    const call = window.__E2E__.lastCall('set_alignment_position');
    return (call?.args as { token: number } | undefined) ?? null;
  });
  expect(moved, 'a manual step must reach the alignment engine').not.toBeNull();
  expect(moved!.token).toBeGreaterThan(0);

  // Back a sentence returns to where it was — the transport is symmetric.
  await page.getByRole('button', { name: 'Back one sentence' }).click();
  await expect(currentSentence).toHaveText('thank you for joining me today');

  // Outline navigation is an absolute jump to a named section.
  await page
    .getByRole('complementary', { name: 'Sections' })
    .getByRole('button', { name: 'What is next' })
    .click();
  await expect(currentSentence).toHaveText('we ship the new onboarding in march');

  await page.screenshot({ path: testInfo.outputPath('live-transport.png'), fullPage: true });

  // §15.3 pause: the position is held and resumable. This is a MANUAL take, so
  // the status line must not offer a wake word nothing is listening for — the
  // voice wording is asserted in live-voice-transport.spec.ts.
  await transport.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(statusBar.getByText('Paused — the script stays where it is')).toBeVisible();
  await transport.getByRole('button', { name: 'Resume' }).click();
  await expect(transport.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await expect(currentSentence).toHaveText('we ship the new onboarding in march');

  errors.expectClean();
});

test('a stage window that disappears mid-take stands the stage controls down (§62)', async ({
  page,
}, testInfo) => {
  const errors = watchPageErrors(page);
  await startManualTake(page);

  const blank = page.getByRole('button', { name: 'Blank stage' });
  await expect(blank).toBeEnabled();

  // A `stage://closed` for a DIFFERENT stage generation is not this session's
  // stage. It must be ignored — otherwise a late event from a previous take
  // strands a healthy session with dead controls.
  const staleDelivered = await page.evaluate(() =>
    window.__E2E__.emit('stage://closed', { stageGeneration: window.__E2E__.stageGeneration + 5 }),
  );
  expect(staleDelivered).toBeGreaterThan(0); // it really was delivered...
  await expect(page.getByText('Stage closed')).toHaveCount(0); // ...and ignored.

  // The real one, on the live generation, is acted on.
  await page.evaluate(() =>
    window.__E2E__.emit('stage://closed', { stageGeneration: window.__E2E__.stageGeneration }),
  );

  await expect(page.getByText('Stage closed')).toBeVisible();
  await expect(blank).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Mirror text' })).toBeDisabled();
  await expect(
    page.getByText('The stage window closed. Stop and restart the session to reopen it —', {
      exact: false,
    }),
  ).toBeVisible();

  await page.screenshot({ path: testInfo.outputPath('live-stage-closed.png'), fullPage: true });

  /*
   * GEOMETRY, not existence. The §62 danger toast never auto-dismisses (by
   * design), and it used to land on top of the centre transport controls and
   * swallow their clicks — so the manual fallback broke in precisely the
   * situation that produces the toast. The region now sits above the transport
   * bar, and both halves of that are asserted: the boxes do not overlap, and
   * the click lands WITHOUT dismissing anything first.
   */
  const toastBox = await page.locator('.toast.danger').first().boundingBox();
  const transportBox = await page.locator('footer.transport').boundingBox();
  expect(toastBox, 'the §62 danger toast must be on screen').not.toBeNull();
  expect(transportBox).not.toBeNull();
  expect(
    toastBox!.y + toastBox!.height,
    'the toast stack must clear the transport bar entirely',
  ).toBeLessThanOrEqual(transportBox!.y);

  // The take itself continues: the operator can still move their own script,
  // with the danger toast still up.
  await expect(page.locator('.toast.danger')).toHaveCount(1);
  await page.getByRole('button', { name: 'Forward one sentence' }).click();
  await expect(page.locator('.preview-sentence.current')).toHaveText(
    'here is what changed this quarter',
  );
  // Sticky is the point: nothing above dismissed it.
  await expect(page.locator('.toast.danger')).toHaveCount(1);

  // And it is still dismissable by hand, and still announced assertively.
  await expect(page.locator('.toast.danger').first().locator('..')).toHaveAttribute(
    'role',
    'alert',
  );
  await dismissAllToasts(page);
  await expect(page.locator('.toast.danger')).toHaveCount(0);

  errors.expectClean();
});

test('stopping the take closes the session record and shows the F.17 summary', async ({
  page,
}, testInfo) => {
  const errors = watchPageErrors(page);
  await startManualTake(page);
  const transport = page.locator('footer.transport');
  await page
    .getByRole('complementary', { name: 'Sections' })
    .getByRole('button', { name: 'The numbers' })
    .click();
  await expect(page.locator('.preview-sentence.current')).toHaveText('revenue grew steadily');

  // Stopping is confirmed first — a take is not something to end by mis-click.
  await transport.getByRole('button', { name: 'Stop session' }).click();
  const confirm = page.getByRole('dialog', { name: 'Stop the session?' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Stop session' }).click();

  // F.17: the summary reports THIS take — its mode and where it ended.
  const summary = page.getByRole('dialog', { name: 'Session complete' });
  await expect(summary).toBeVisible();
  await expect(summary.getByText('Manual', { exact: true })).toBeVisible();
  await expect(summary.getByText('The numbers', { exact: true })).toBeVisible();
  // Retention was off at session start, so the summary must not claim otherwise.
  await expect(summary.getByText('Not saved', { exact: true })).toBeVisible();

  await page.screenshot({ path: testInfo.outputPath('live-summary.png'), fullPage: true });

  // The session ROW was closed against the id Rust minted. An unfinished row is
  // indistinguishable from a crash, so this is not bookkeeping.
  const ended = await page.evaluate(() => ({
    call: window.__E2E__.lastCall('end_session'),
    row: window.__E2E__.lastSession,
  }));
  expect(ended.call).not.toBeNull();
  expect((ended.call!.args as { sessionId: string }).sessionId).toBe(ended.row!.id);

  // And the operator can get back to work from the summary.
  await summary.getByRole('button', { name: 'Return to editor' }).click();
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('Thank you for joining me today');

  errors.expectClean();
});
