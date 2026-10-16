import { test, expect, devices, type Page } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';
import { watchPageErrors } from './fixtures/page-errors';
import { openScript } from './fixtures/library';

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
    .getByRole('listbox')
    .getByRole('button', { name: 'Present', exact: true })
    .first()
    .click();
  await expect(page.getByRole('region', { name: 'Teleprompter' })).toBeVisible({
    timeout: 20_000,
  });
}

/**
 * Open the appearance panel the way an operator does: through the dock's menu.
 *
 * The dock is one trigger and a way out; adjusting the prompter is the menu's
 * second level, so getting there is two gestures rather than one. Both are
 * asserted on the real surface here because the seam between them — the menu
 * closing as the panel it opened rises in the same place — is exactly what a
 * unit test of either half cannot see.
 */
async function openAppearancePanel(page: Page): Promise<void> {
  await page.locator('.stage-root').hover();
  await page.locator('.stage-dock .dock-button.menu-trigger').click();
  await page.locator('.stage-dock [data-menu-row="appearance"]').click();
}

/**
 * The `enabled` flag of every `set_control_presenting`, in order.
 *
 * The command name alone cannot tell a present from an un-present, and the
 * pairing is the interesting part: one of each, in that order, is a take that
 * gave the window back.
 */
function presentationSwitches(
  calls: Array<{ command: string; args: unknown }>,
): boolean[] {
  return calls
    .filter((call) => call.command === 'set_control_presenting')
    .map((call) => (call.args as { enabled?: boolean } | null)?.enabled === true);
}

test.beforeEach(async ({ page }) => {
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [SCRIPT],
    engineStatus: { available: true, loaded: true, model: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05' },
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
  expect(calls).toContain('set_control_presenting');
  expect(calls).not.toContain('open_stage');
  expect(calls).not.toContain('publish_stage_document');
  expect(calls).not.toContain('set_stage_fullscreen');
  /*
   * And NOT through the core window plugin.
   *
   * Presentation is borderless (src-tauri/src/windows/present.rs). The renderer
   * calling OS full screen directly is what animated the window into a new
   * macOS Space and left a white bar over the half-painted webview for the
   * length of the animation. The capability no longer grants
   * `core:window:allow-set-fullscreen`, so a reintroduction would fail at the
   * ACL — but it would fail at RUNTIME, on a machine, which is exactly the
   * place this project cannot test. So it is asserted here too.
   */
  expect(calls).not.toContain('plugin:window|set_fullscreen');
  expect(await page.evaluate(() => window.__E2E__.presenting)).toBe(true);

  errors.expectClean();
});

/*
 * THE COVER, AND THE BLACK UNDERNEATH IT.
 *
 * The artifact this whole change exists to remove — a window mid-shape-change
 * with a half-painted webview in it — cannot be reproduced here: Playwright
 * never performs a native window transition and the shim resizes nothing. What
 * CAN be proved is the two things the fix does inside the page, and both of
 * them were previously untested:
 *
 *   - the stage does not mount until the window has finished changing shape,
 *     and something opaque is over the whole window for that entire interval;
 *   - the page CANVAS is black for the take. `src/styles/stage.css` blacks
 *     html/body but is loaded only by the separate stage window's entry point,
 *     so in single-window presentation the canvas stayed `--bg-app` — warm paper
 *     — and painted every strip the viewport grew into before layout reached it.
 *
 * The presentation command is held open to make the interval observable at all;
 * on a real machine it is the window move that takes the time.
 */
test('nothing of the take is on screen until the window has finished changing shape', async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.goto('/control.html');
  await page.evaluate(() => window.__E2E__.setDelay('set_control_presenting', 1500));

  await page
    .getByRole('listbox')
    .getByRole('button', { name: 'Present', exact: true })
    .first()
    .click();

  // Mid-transition: the cover is up, and the stage does not exist yet.
  const cover = page.locator('.present-cover');
  await expect(cover).toBeVisible();
  await expect(page.getByRole('region', { name: 'Teleprompter' })).toHaveCount(0);
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
    'rgb(0, 0, 0)',
  );
  expect(
    await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor),
  ).toBe('rgb(0, 0, 0)');
  // Opaque, and over everything — a cover that let the editor through would be
  // showing exactly what it exists to hide.
  expect(await cover.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');

  // Settled: the stage is up, the cover is gone, the canvas is still black.
  await page.evaluate(() => window.__E2E__.setDelay('set_control_presenting', null));
  await expect(page.getByRole('region', { name: 'Teleprompter' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(cover).toHaveCount(0);
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
    'rgb(0, 0, 0)',
  );

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
      leadMarginTokens: 2.2,
      leadEaseMs: 450,
      leadHoldMs: 0,
      leadDecayMs: 1200,
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
 * WHERE THE SCRIPT IS SITTING THE MOMENT THE GLASS LIGHTS UP.
 *
 * The document's top padding puts the first LINE on the reading mark at scroll
 * zero, and this script — like nearly every script — opens on a heading nobody
 * is going to say out loud. So the mark used to point above the words, and the
 * first thing the presenter heard themselves do was make the document jump
 * down to the sentence they had already started reading.
 *
 * Measured on the real glass because that is the only place it exists: the
 * position comes from the rendered line map, which is built from measured
 * rects and is all zeroes without layout.
 */
test('the take opens with the first spoken word on the reading mark, not the heading', async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.setViewportSize({ width: 1024, height: 600 });
  await present(page);

  const firstWord = page.locator('[data-t="0"]');
  await expect(firstWord).toBeVisible();
  /*
   * The PAINTED arrow, not the box it is positioned in.
   *
   * The tick's span is a `unitPx`-tall slot centred on the band by transform,
   * and the triangle is an SVG drawn inside it. Measuring the slot would prove
   * a claim about the layout; what the presenter looks at is the triangle, so
   * the path's own rendered rect — stroke included — is what this measures.
   */
  const mark = page.locator('.script-layer .cue .tick svg path').first();
  await expect(mark).toBeAttached();

  // The map is built a frame or two after the first paint, and the opening
  // placement rides on it.
  const centreOf = async (locator: typeof firstWord) => {
    const box = await locator.boundingBox();
    return box === null ? null : box.y + box.height / 2;
  };
  /**
   * The centre of the first spoken ROW, unioned across every token on it —
   * which is what the opening actually promises. One token's box is the same
   * number on a homogeneous row and a different one the moment a row mixes
   * sizes, so measure the promise rather than a proxy for it.
   */
  const rowCentre = async () =>
    page.evaluate(() => {
      const first = document.querySelector('[data-t="0"]');
      if (!first) return null;
      const firstTop = Math.round(first.getBoundingClientRect().top);
      let top = Number.POSITIVE_INFINITY;
      let bottom = Number.NEGATIVE_INFINITY;
      document.querySelectorAll('[data-t]').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (Math.round(r.top) !== firstTop) return;
        top = Math.min(top, r.top);
        bottom = Math.max(bottom, r.bottom);
      });
      return Number.isFinite(top) ? (top + bottom) / 2 : null;
    });

  const markCentre = (await centreOf(mark))!;
  const lineHeight = (await firstWord.boundingBox())!.height;

  /*
   * ON the line, and the claim is exact rather than "near": the opening is the
   * measured ink centre of the first spoken line placed on the measured mark,
   * so the only slack this needs is the pixel rounding of two rects. A tenth of
   * a line fails both phases this replaced — the path's own position for unit 0
   * (half a pitch high, on the line's top edge) and the pitch-arithmetic that
   * followed it (about a seventh of a line low, on the baseline).
   */
  await expect
    .poll(async () => Math.abs((await rowCentre())! - markCentre), {
      message: 'the first spoken line should open centred on the reading mark',
      timeout: 10_000,
    })
    .toBeLessThan(lineHeight / 10);

  /*
   * ...and the same claim at four shapes of glass. The opening is derived from
   * measured geometry, so the way it fails is a rig whose numbers differ from
   * the developer's — a short wide prompter strip, a large panel — which is
   * exactly what a single viewport cannot see. (A 1920x520 stage is in the list
   * because it is the shape that caught the map merging two rendered rows into
   * one map line, which put the mark exactly half a row low and nowhere else.)
   */
  for (const size of [
    { width: 1920, height: 520 },
    { width: 2560, height: 900 },
    { width: 1280, height: 720 },
  ]) {
    await page.setViewportSize(size);
    await expect
      .poll(
        async () => {
          const arrow = await centreOf(mark);
          const row = await rowCentre();
          return arrow === null || row === null ? Number.POSITIVE_INFINITY : Math.abs(arrow - row);
        },
        { message: `arrow centred on the first line at ${size.width}x${size.height}`, timeout: 10_000 },
      )
      .toBeLessThan(1.5);
  }

  // ...and the heading it skipped is still on screen, above the mark, where a
  // presenter can see what section they are in.
  const heading = page.getByText('Opening', { exact: true }).first();
  expect((await centreOf(heading))!).toBeLessThan(markCentre);

  errors.expectClean();
});

/*
 * THE SCRIPT IS NEVER PAINTED SOMEWHERE IT IS NOT GOING TO STAY.
 *
 * The opening position cannot be known until the document has been laid out and
 * measured, and the map that measures it lands a frame or more after the first
 * paint — behind a font wait with no bound. So the honest sequence was: the
 * script appears at scroll zero, then moves to where it belongs. One frame,
 * entirely correct, and it reads as a teleprompter twitching as it opens.
 *
 * This is the assertion that the presenter's own report becomes: sample every
 * animation frame from before Present is pressed, and require that every frame
 * in which the script was actually PAINTED shows it in the same place.
 */
test('the script is never painted at a position it then leaves', async ({ page }) => {
  const errors = watchPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/control.html');

  // Sampling starts BEFORE Present, so the first painted frame is in the trace.
  await page.evaluate(() => {
    (window as unknown as { __TRACE__: unknown[] }).__TRACE__ = [];
    const tick = () => {
      const el = document.querySelector('.scroll-plane') as HTMLElement | null;
      if (el) {
        const m = /translate3d\(0(?:px)?,\s*(-?[\d.]+)px/.exec(el.style.transform);
        (window as unknown as { __TRACE__: unknown[] }).__TRACE__.push({
          y: m?.[1] === undefined ? 0 : -Number(m[1]),
          // COMPUTED, so it sees the gate wherever it is applied — the layer
          // holds the whole reading composition, and visibility inherits.
          painted: getComputedStyle(el).visibility !== 'hidden',
        });
      }
      requestAnimationFrame(tick);
    };
    tick();
  });

  await page
    .getByRole('listbox')
    .getByRole('button', { name: 'Present', exact: true })
    .first()
    .click();
  await expect(page.getByRole('region', { name: 'Teleprompter' })).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(2000);

  const trace = (await page.evaluate(
    () => (window as unknown as { __TRACE__: unknown[] }).__TRACE__,
  )) as Array<{ y: number; painted: boolean }>;

  const paintedAt = [...new Set(trace.filter((f) => f.painted).map((f) => Math.round(f.y)))];
  expect(paintedAt.length, `painted at ${paintedAt.join(', ')}`).toBe(1);

  // ...and it did get painted. A gate that never opened would satisfy the line
  // above and leave the presenter looking at a blank stage.
  expect(trace.some((f) => f.painted)).toBe(true);
  await expect(page.getByText('Thank you for joining me today.')).toBeVisible();

  errors.expectClean();
});

/*
 * ...INCLUDING WHEN THE FACE LANDS LATE, WHICH IS WHEN IT USED TO FAIL.
 *
 * The test above passes on a warm start and always did: the map is measured
 * about 150 ms in and the gate opens on the placed position. The presenter's
 * report was of a COLD one — "it always starts with the top of the screen black
 * and the text all the way down", then a jump.
 *
 * The map cannot be built until the layout is final, and `awaitLayoutStable`
 * waits on `document.fonts.ready` and on every image to decide that. The reveal
 * deadline was a flat 700 ms, so any rig where that wait ran longer — a cold
 * bundled face, a full-screen transition, a busy first second — showed the
 * script at scroll zero, where the first spoken line sits a fifth of a viewport
 * BELOW the mark and the glass above it is empty, and then hopped it into
 * place. Measured before the fix at 1440x900 with the woff2 responses held for
 * 1.5 s: painted unplaced at 823 ms, jumped 207 px at 1646 ms.
 *
 * Delaying the font is the mechanism itself rather than a stand-in for it, and
 * it is the one input this harness can hold back on demand. The assertion is
 * the same one as above — one painted position, ever — plus the plate that now
 * covers the wait, because a gate with nothing behind it is just a dark stage.
 */
test('a font that lands late does not open the take at a position it then leaves', async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route('**/*.woff2', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.continue();
  });
  await page.goto('/control.html');

  await page.evaluate(() => {
    (window as unknown as { __TRACE__: unknown[] }).__TRACE__ = [];
    const tick = () => {
      const el = document.querySelector('.scroll-plane') as HTMLElement | null;
      const plate = document.querySelector('.waiting') as HTMLElement | null;
      if (el) {
        const m = /translate3d\(0(?:px)?,\s*(-?[\d.]+)px/.exec(el.style.transform);
        (window as unknown as { __TRACE__: unknown[] }).__TRACE__.push({
          y: m?.[1] === undefined ? 0 : -Number(m[1]),
          painted: getComputedStyle(el).visibility !== 'hidden',
          // The plate covers the stage only while it is opaque and not blanked.
          covered:
            plate !== null &&
            getComputedStyle(plate).visibility !== 'hidden' &&
            Number(getComputedStyle(plate).opacity) > 0.9,
        });
      }
      requestAnimationFrame(tick);
    };
    tick();
  });

  await page
    .getByRole('listbox')
    .getByRole('button', { name: 'Present', exact: true })
    .first()
    .click();
  await expect(page.getByRole('region', { name: 'Teleprompter' })).toBeVisible({ timeout: 20_000 });
  // Past the held font, the map build it gates, and the plate's own fade.
  await page.waitForTimeout(3000);

  const trace = (await page.evaluate(
    () => (window as unknown as { __TRACE__: unknown[] }).__TRACE__,
  )) as Array<{ y: number; painted: boolean; covered: boolean }>;

  const paintedAt = [...new Set(trace.filter((f) => f.painted).map((f) => Math.round(f.y)))];
  expect(paintedAt.length, `painted at ${paintedAt.join(', ')}`).toBe(1);
  expect(trace.some((f) => f.painted)).toBe(true);

  // The wait was covered rather than merely dark, and the cover did lift.
  const beforeReveal = trace.slice(
    0,
    trace.findIndex((f) => f.painted),
  );
  expect(beforeReveal.length).toBeGreaterThan(0);
  expect(beforeReveal.every((f) => f.covered)).toBe(true);
  await expect(page.locator('.waiting')).toHaveCount(0);

  await expect(page.getByText('Thank you for joining me today.')).toBeVisible();

  errors.expectClean();
});

/*
 * ...AND IT IS STILL SITTING THERE AFTER THE LAYOUT MOVES UNDER IT.
 *
 * A scroll position is a pixel, and before the first spoken word there is no
 * anchor to carry a pixel across a relayout: §33 re-anchors on the unit the
 * aligner was on, and there is no unit yet. So an opening that was placed once
 * and left alone is stale the moment anything re-wraps the script — the bundled
 * font landing after the bounded wait, a virtualized height estimate being
 * replaced by a measurement, the type size being nudged while the presenter
 * settles. It lands about a line out, which is exactly far enough to point at
 * the wrong line and no further.
 *
 * A viewport change is the relayout this harness can order on demand; the
 * mechanism it stands in for is the font.
 */
test('the opening position survives a relayout that happens before the first word', async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await present(page);

  /** How far down the script the document is painted, in pixels. */
  const scrollPx = async () =>
    page.locator('.scroll-plane').evaluate((el) => {
      const match = /translate3d\(0(?:px)?,\s*(-?[\d.]+)px/.exec((el as HTMLElement).style.transform);
      return match?.[1] === undefined ? 0 : -Number(match[1]);
    });

  const arrow = page.locator('.script-layer .cue .tick svg path').first();
  const firstWord = page.locator('[data-t="0"]');
  const centreOf = async (locator: typeof firstWord) => {
    const box = await locator.boundingBox();
    return box === null ? null : box.y + box.height / 2;
  };
  const arrowOffFirstLine = async () => {
    const a = await centreOf(arrow);
    const line = await centreOf(firstWord);
    return a === null || line === null ? Number.POSITIVE_INFINITY : Math.abs(a - line);
  };

  /*
   * Relayouts with nothing spoken between them. A viewport change is the one
   * this harness can order on demand; the mechanism it stands in for is a font
   * landing late. The shapes are chosen to move the WRAP as well as the height,
   * because a re-wrap is what makes a remembered pixel meaningless.
   */
  for (const size of [
    { width: 980, height: 820 },
    { width: 1600, height: 620 },
    { width: 1920, height: 520 },
  ]) {
    await page.setViewportSize(size);
    await expect
      .poll(arrowOffFirstLine, {
        message: `the arrow should still be on the first line at ${size.width}x${size.height}`,
        timeout: 10_000,
      })
      .toBeLessThan(1.5);
  }

  /*
   * ...and when the aligner finally speaks, it does not drag the document
   * BACKWARD to say it.
   *
   * The opening is the middle of the first line; the path's own position for
   * unit 0 is that line's entry, a fraction of a line earlier. The engine holds
   * rather than un-reads (the forward latch), and the difference is absorbed as
   * the presenter reads into the line. Backwards is the direction that matters:
   * a teleprompter that reverses under someone mid-sentence has lost them.
   */
  const opened = await scrollPx();
  await page.evaluate(() => {
    const generation = window.__E2E__.lastSession?.sessionGeneration ?? 0;
    window.__E2E__.emit('align://snapshot', {
      sessionGeneration: generation,
      seq: 1,
      state: 'following',
      decision: 'localConfirmed',
      confirmedToken: 0,
      observedToken: 0,
      rateTokensPerSecond: 2,
      evidenceAudioMs: 1000,
      atAudioMs: 1000,
      maxPredictionMs: 0,
      pauseOnsetMs: 400,
      leadFloorMs: 0,
      maxLeadTokens: 0,
      leadMarginTokens: 2.2,
      leadEaseMs: 450,
      leadHoldMs: 0,
      leadDecayMs: 1200,
      displayLimitToken: 0,
      confidence: 0.95,
      suggestionToken: null,
      scriptLenTokens: 30,
      observedAtom: 0,
      confirmedAtom: 0,
    });
  });
  await expect(page.locator('.stage-root')).toHaveAttribute('data-phase', 'live');
  await page.waitForTimeout(2000);

  expect(
    (await scrollPx()) - opened,
    'the first snapshot must never move the document backward',
  ).toBeGreaterThanOrEqual(-1);

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
test('the first Escape prompts and the second ends the take, un-presents, and shows the summary', async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await present(page);

  await page.keyboard.press('Escape');
  await expect(page.locator('.escape-hint')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Teleprompter' })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: 'Teleprompter' })).toHaveCount(0);

  /*
   * THE SUMMARY, OVER THE EDITOR — and the two halves of that are separate
   * claims that have each been wrong at different times.
   *
   * The summary itself used to be destroyed on the way out: ending a take
   * navigated away and called `clearSession()` under the still-raised black
   * cover, so the F.17 dialog's condition held for a few frames behind an opaque
   * plate and no presenter ever saw one. Fixing that left the take ending where
   * it ran, on Live — which put the summary over an operator console built for a
   * rig where the stage has its own window, offering to Start and End a session
   * that had just ended.
   *
   * So both, now: the report survives, AND it opens on the script the presenter
   * just read. The navigation happens under the cover and the report is hosted
   * by App rather than by the route it came from, which is what lets those two
   * be true at once.
   */
  const summary = page.getByRole('dialog', { name: 'Take complete' });
  await expect(summary).toBeVisible();
  // The cover must be DOWN: it sits above the dialog host at z-index 9999, so a
  // summary shown while it is up is a summary nobody can see.
  await expect(page.locator('.present-cover')).toHaveCount(0);

  /*
   * ...and the editor is ALREADY behind it, before anybody presses anything.
   *
   * Scoped to the source pane: Split mode renders the words twice, once in
   * CodeMirror and once in the preview beside it, so an unscoped match is
   * ambiguous. And the console the take used to end on must be gone — its
   * transport offers Start and End session, which is the contradiction that
   * made the old landing screen unreadable.
   */
  await expect(page.locator('aside.sidebar')).toBeVisible();
  await expect(
    page.locator('.cm-content').getByText('Thank you for joining me today.'),
  ).toBeVisible();
  await expect(page.locator('.live')).toHaveCount(0);
  await expect(page.locator('footer.transport')).toHaveCount(0);

  /*
   * This was a single-window take, so there was no stage window to hear back
   * from. The three bridge rows must be replaced by one honest line rather than
   * reporting their empty counters as three separate failures — which is what
   * every embedded take used to be told.
   */
  await expect(summary).toContainText('Stage diagnostics');
  await expect(summary).toContainText('Not applicable');
  await expect(summary).not.toContainText('Stage updates');
  await expect(summary).not.toContainText('Script moved');
  await expect(summary).not.toContainText('Transcript to stage');
  // And no engine units in presenter-facing copy.
  await expect(summary).not.toContainText('Token ');

  const result = await page.evaluate(() => ({
    commands: window.__E2E__.calls.map((call) => call.command),
    calls: window.__E2E__.calls.map((call) => ({ command: call.command, args: call.args })),
    presenting: window.__E2E__.presenting,
    session: window.__E2E__.lastSession,
  }));
  /*
   * Three switches, and each one is load-bearing.
   *
   * The leading `false` is startup reconciliation. The presentation latch lives
   * in Rust and outlives the renderer, but nothing else about a take does — so
   * a reload mid-take (⌘R, an HMR failure, a web-content crash) would otherwise
   * boot the Library inside a borderless, monitor-sized, above-the-menu-bar
   * window that no remaining code path knows to undo. The app therefore gives
   * the window back before it paints anything, and this is where that is
   * pinned: a startup that stopped doing it would land here as `[true, false]`.
   *
   * Then the take: presented once, un-presented once. The un-present is the
   * half that used to be missable — it is what returns the titlebar and the old
   * bounds, so a take that ended without it left the operator borderless and
   * monitor-sized with no obvious way out.
   */
  expect(presentationSwitches(result.calls)).toEqual([false, true, false]);
  expect(result.commands).not.toContain('plugin:window|set_fullscreen');
  expect(result.commands).toContain('end_session');
  expect(result.presenting).toBe(false);

  /*
   * Dismissal is now a plain close, and it has to leave the presenter somewhere
   * they can work.
   *
   * The button used to say "Return to editor" and perform a navigation. Once
   * the take lands there by itself that name promised a journey to a place the
   * presenter was already standing in — so it read as the safe default while
   * doing nothing visible, which is the worst combination available for the
   * button most people press.
   */
  await page.getByRole('button', { name: 'Back to the script' }).click();
  await expect(page.getByRole('dialog', { name: 'Take complete' })).toHaveCount(0);
  await expect(
    page.locator('.cm-content').getByText('Thank you for joining me today.'),
  ).toBeVisible();
  /*
   * That the session was genuinely CLEARED — rather than the dialog merely
   * hidden — is proved by the retake test below rather than re-asserted here:
   * `presenting` is a native-window fact and was already false before this
   * click, so checking it again would pass with `clearSession()` deleted.
   */

  errors.expectClean();
});

/*
 * THE RETAKE LOOP, WHICH NOW HAS TO FIND ITS OWN SCRIPT.
 *
 * "Present again" used to be a button on the Live route and read the script id
 * from that route's props. The summary is hosted by App now — it opens over the
 * editor, and it has no route props to read — so it takes the id off the session
 * that just ended, which `stopSession` deliberately leaves behind and only
 * dismissal clears.
 *
 * That is a silent failure if it is wrong: a null id would clear the session,
 * start nothing, and leave the presenter looking at the editor as though the
 * button had simply been a slow "close". So it is worth a take of its own.
 */
test('Present again starts a second take of the same script from the summary', async ({ page }) => {
  const errors = watchPageErrors(page);
  await present(page);

  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Take complete' })).toBeVisible();

  await page.getByRole('button', { name: 'Present again' }).click();
  await expect(page.getByRole('region', { name: 'Teleprompter' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('dialog', { name: 'Take complete' })).toHaveCount(0);
  await expect(page.getByText('Thank you for joining me today.')).toBeVisible();

  // Presented, un-presented, presented again — the pairing is what says the
  // second take is a real one rather than the first one's window left over.
  const calls = await page.evaluate(() => window.__E2E__.calls.map((c) => ({ command: c.command, args: c.args })));
  expect(presentationSwitches(calls)).toEqual([false, true, false, true]);
  expect(await page.evaluate(() => window.__E2E__.presenting)).toBe(true);

  errors.expectClean();
});

/*
 * §115 — the controls for a take only existed when there was no take.
 *
 * The status readout, the tracking panel and — worst of all — the microphone
 * recovery picker all lived in the `{:else}` arm of `{#if $session.active}`, so
 * the surface built to be used DURING a read rendered only before and after
 * one. The picker's own condition required an active voice take, which made it
 * `active && !active`: not hidden, unsatisfiable.
 */
test('the take controls are reachable during a take and do not remount the stage', async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await present(page);

  const tab = page.getByRole('button', { name: /Take controls/ });
  await expect(tab).toBeVisible();

  /*
   * The stage must SURVIVE the drawer. Svelte 5 does not reparent, so a fix
   * that moved StageApp to a different template path would destroy it and
   * restart the read from its opening plate with the follower's state gone.
   * Stamping the live node and re-reading it afterwards is what proves the
   * element is the same one rather than a fresh mount that merely looks alike.
   */
  await page.locator('.stage-root').evaluate((node) => {
    (node as HTMLElement).dataset.e2eStageInstance = 'original';
  });

  await tab.click();
  const panel = page.getByRole('region', { name: 'Take controls' });
  await expect(panel).toBeVisible();
  await expect(tab).toHaveAttribute('aria-expanded', 'true');
  // The script is still on the glass behind it — this layer never replaces it.
  await expect(page.locator('.script-layer')).toBeVisible();

  /*
   * Escape closes the drawer and must NOT reach the stage's double-Escape
   * counter, or dismissing a panel would arm the teardown.
   *
   * The drawer really has to CLOSE, and that is asserted directly. Checking
   * only "no escape hint appeared" would pass with the drawer's Escape handler
   * deleted entirely, because StageApp stands its keyboard down while control
   * chrome is open — so the hint would be absent either way.
   */
  await page.keyboard.press('Escape');
  await expect(tab).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.tc-panel')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('.escape-hint')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Teleprompter' })).toBeVisible();

  // And with the drawer closed the key belongs to the stage again — the first
  // press arms, it does not end the take.
  await page.keyboard.press('Escape');
  await expect(page.locator('.escape-hint')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Teleprompter' })).toBeVisible();

  await expect(page.locator('.stage-root')).toHaveAttribute(
    'data-e2e-stage-instance',
    'original',
  );

  errors.expectClean();
});

/*
 * A MAC'S CHROME, AND THE CHORD A MAC ANSWERS TO.
 *
 * The mirror shortcut's modifier is the PAGE's primary modifier — Cmd where the
 * page identifies as macOS, Ctrl everywhere else (`isMacPlatform` in
 * `src/control/lib/shortcuts.ts`) — and the page decides that from the browser
 * it runs in, never from the machine running the suite. The chromium project's
 * `devices['Desktop Chrome']` reports a WINDOWS platform through
 * `navigator.userAgentData`, so the journey that used to choose its chord from
 * `process.platform` pressed Cmd on a Mac host into a page waiting for Ctrl,
 * and nothing mirrored.
 *
 * So the page is made a Mac, on every host, and the chord is pressed literally.
 * That is the one that ships: the packaged app runs WKWebView, and the native
 * "Mirror Stage" menu item carries no accelerator to cover for a key that went
 * nowhere. Playwright derives the client hints from the user agent string, so
 * `userAgentData.platform` follows it; deriving the string from the descriptor
 * keeps its Chrome version the one Playwright actually launches. If that
 * derivation ever stops producing a Mac, the `data-platform` assertion in each
 * test says so before any key is pressed.
 *
 * Scoped to this block, not the file: every other test here runs as the
 * descriptor says, and the file's `beforeEach` shim still applies to both.
 */
const MAC_CHROME_USER_AGENT = devices['Desktop Chrome'].userAgent.replace(
  'Windows NT 10.0; Win64; x64',
  'Macintosh; Intel Mac OS X 10_15_7',
);

test.describe('on a page that identifies as macOS', () => {
  test.use({ userAgent: MAC_CHROME_USER_AGENT });

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
   *
   * It is also the only browser coverage of the mirror shortcut reaching the
   * glass, and in single-window presentation that is a specific path: the take
   * runs at stage generation 0, where `sendDirective` is a silent no-op, so the
   * flip has to travel through the recomposed `stageEnvelope`. Pressing the key
   * — not calling the store — is what keeps that path under test.
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
    await expect(page.locator('html'), 'the page must identify as macOS').toHaveAttribute(
      'data-platform',
      'macos',
    );

    const dock = page.locator('.stage-dock');
    await expect(dock).toBeVisible();
    const before = await dock.boundingBox();
    expect(before).not.toBeNull();

    // Bottom left of the window, not merely somewhere.
    const viewport = page.viewportSize()!;
    expect(before!.x).toBeLessThan(viewport.width / 2);
    expect(before!.y).toBeGreaterThan(viewport.height / 2);

    /*
     * Cmd+Shift+M is the mirror shortcut; the script flips, the dock does not.
     *
     * One press, and the plane reads mirrored after it — a key handled twice
     * would toggle there and back and read `false`, which is the other way this
     * step can be wrong.
     */
    const plane = page.locator('.stage-talent-plane');
    await expect(plane).toHaveAttribute('data-mirror-x', 'false');
    await page.keyboard.press('Meta+Shift+M');
    await expect(plane).toHaveAttribute('data-mirror-x', 'true');
    const after = await dock.boundingBox();
    expect(after!.x).toBeCloseTo(before!.x, 0);
    expect(after!.y).toBeCloseTo(before!.y, 0);

    /*
     * LEVEL ONE FITS TOO, AND IS CLICKABLE.
     *
     * The same claim already made for the appearance sheet below, made one level
     * earlier: the menu is the only route to every routine control now, so a menu
     * that ran off the top of a 9-inch panel or needed scrolling to reach its
     * last row would put those controls out of reach entirely. jsdom cannot see
     * any of this — it resolves no stylesheets and measures nothing — so the
     * geometry has to be judged in a real engine at the Prompter's own size.
     */
    await page.locator('.stage-root').hover();
    await page.locator('.stage-dock .dock-button.menu-trigger').click();
    const menu = page.locator('.stage-dock .menu-popover');
    await expect(menu).toBeVisible();
    const menuBox = await menu.boundingBox();
    expect(menuBox!.x).toBeGreaterThanOrEqual(0);
    expect(menuBox!.y, 'the menu must not run off the top of a 1024x600 Prompter').toBeGreaterThanOrEqual(0);
    expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(before!.y + 1);
    expect(
      await menu.evaluate((el) => el.scrollHeight - el.clientHeight),
      'and no row of it may need scrolling to reach',
    ).toBe(0);
    // Painted AND hit-testable: the operator plane above this dock is
    // `pointer-events: none`, so a row that inherited it would look perfect and
    // do nothing. `.hover()` fails if anything else is on top of it.
    await menu.locator('[data-menu-row="follow"]').hover();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    // The appearance panel opens upward from the dock and stays on screen.
    await openAppearancePanel(page);
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

    /*
     * And it is a toggle. Pressed again only now, after everything above has
     * been checked against the MIRRORED plane — the hit-testing claims are the
     * ones a transform could break — so the text comes back the right way round
     * and the dock still has not moved.
     */
    await page.keyboard.press('Meta+Shift+M');
    await expect(plane).toHaveAttribute('data-mirror-x', 'false');
    const restored = await dock.boundingBox();
    expect(restored!.x).toBeCloseTo(before!.x, 0);
    expect(restored!.y).toBeCloseTo(before!.y, 0);

    errors.expectClean();
  });

  /*
   * A READING WINDOW IS NEVER MIRRORED, AND THE CHORD DOES NOT CHANGE THAT.
   *
   * The mirror describes a beamsplitter; a reading window has no glass in the
   * optical path, so `stageSettingsFromSettings` forces both axes off in reader
   * mode whatever the take holds (`src/control/services/stage-envelope.ts`).
   * The unit suite proves the forcing; this proves it survives the real key on
   * the real surface, where the toggle is still ACCEPTED — Live flips the take's
   * own mirror — and only the composed envelope refuses it.
   *
   * An unmirrored plane is also exactly what a key that went nowhere looks
   * like, so the toast is waited for first: `toggleMirror` raises it only after
   * `toggleStageMirror` has recomposed and written the envelope, synchronously.
   * Once it is up, the plane below is the answer and not a race.
   */
  test('a reading window stays unmirrored when the mirror chord is pressed', async ({ page }) => {
    const errors = watchPageErrors(page);
    await page.goto('/control.html');
    // Double click: the collection selects on a single click (§10.2).
    await openScript(page, /Single-window walkthrough/);
    await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeVisible();

    await page.getByRole('button', { name: 'How to present' }).click();
    await page
      .getByRole('menu', { name: 'How to present' })
      .getByRole('menuitemradio', { name: /Present in a window/ })
      .click();
    await expect(page.getByRole('region', { name: 'Teleprompter' })).toBeVisible({
      timeout: 20_000,
    });

    // A reading window, or the assertion at the end is about the wrong mode.
    const modes = await page.evaluate(() =>
      window.__E2E__.calls
        .filter((c) => c.command === 'set_control_presenting')
        .map((c) => c.args as { enabled?: boolean; mode?: string } | null)
        .filter((args) => args?.enabled === true)
        .map((args) => args?.mode ?? null),
    );
    expect(modes[0]).toBe('reader');
    await expect(page.locator('html'), 'the page must identify as macOS').toHaveAttribute(
      'data-platform',
      'macos',
    );

    const plane = page.locator('.stage-talent-plane');
    await expect(plane).toHaveAttribute('data-mirror-x', 'false');

    await page.keyboard.press('Meta+Shift+M');
    await expect(page.getByRole('status').getByText('Text mirrored')).toBeVisible();
    await expect(plane).toHaveAttribute('data-mirror-x', 'false');
    await expect(plane).toHaveAttribute('data-mirror-y', 'false');

    errors.expectClean();
  });
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

  await openAppearancePanel(page);
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
  await openAppearancePanel(page);
  await expect(panel).toBeVisible();
  await width.fill('50');
  await width.dispatchEvent('input');
  await expect.poll(widthOf).toBeLessThan(opened - 20);
  await page.mouse.click(900, 120);
  await expect(panel).toHaveCount(0);
  await expect.poll(widthOf).toBeCloseTo(opened, 0);

  errors.expectClean();
});

/* ------------------------------------------------ choosing how to present */

/**
 * The Present split button.
 *
 * The launch mode used to be reachable only from Settings, three levels from
 * the button, so in practice the only control anybody found was the mid-take
 * chord — and that one is deliberately take-scoped, which is why the app read
 * as forgetting the choice. These prove the two halves of the fix: the choice
 * is reachable where the decision is made, and making it once is enough.
 */
test('the Present menu offers both shapes and marks the current default', async ({ page }) => {
  const errors = watchPageErrors(page);
  await page.goto('/control.html');
  // Double click: the collection selects on a single click (§10.2).
  await openScript(page, /Single-window walkthrough/);
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeVisible();

  // The main half still says Present and still presents — the common case must
  // not have grown a question.
  await expect(page.getByRole('button', { name: 'Present', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'How to present' }).click();
  const menu = page.getByRole('menu', { name: 'How to present' });
  await expect(menu).toBeVisible();

  // Modes, not commands: the menu says which one a take would open in.
  const fullScreen = menu.getByRole('menuitemradio', { name: /Present full screen/ });
  const inWindow = menu.getByRole('menuitemradio', { name: /Present in a window/ });
  await expect(fullScreen).toHaveAttribute('aria-checked', 'true');
  await expect(inWindow).toHaveAttribute('aria-checked', 'false');

  errors.expectClean();
});

test('choosing a shape presents in it and makes it the default for next time', async ({ page }) => {
  const errors = watchPageErrors(page);
  await page.goto('/control.html');
  // Double click: the collection selects on a single click (§10.2).
  await openScript(page, /Single-window walkthrough/);
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeVisible();

  await page.getByRole('button', { name: 'How to present' }).click();
  await page
    .getByRole('menu', { name: 'How to present' })
    .getByRole('menuitemradio', { name: /Present in a window/ })
    .click();

  await expect(page.getByRole('region', { name: 'Teleprompter' })).toBeVisible({
    timeout: 20_000,
  });

  /*
   * The window was asked for the shape that was chosen, not the saved default.
   *
   * Filtered to the calls that PRESENT: App.svelte un-presents once at startup
   * to give the window back after a reload mid-take, and that call carries no
   * mode at all.
   */
  const modes = await page.evaluate(() =>
    window.__E2E__.calls
      .filter((c) => c.command === 'set_control_presenting')
      .map((c) => c.args as { enabled?: boolean; mode?: string } | null)
      .filter((args) => args?.enabled === true)
      .map((args) => args?.mode ?? null),
  );
  expect(modes[0]).toBe('reader');

  // And the choice was PERSISTED, which is the half that stops the app looking
  // like it forgets. The mid-take toggle deliberately writes nothing.
  const wrote = await page.evaluate(() =>
    window.__E2E__.calls
      .filter((c) => c.command === 'update_settings')
      .map((c) => (c.args as { patch?: Record<string, Record<string, unknown>> } | null)?.patch)
      .filter((patch) => patch?.['stageBehavior']?.['presentationMode'] !== undefined),
  );
  expect(wrote.length, 'an explicit launch choice must reach the settings document').toBeGreaterThan(0);
  expect(wrote[0]!['stageBehavior']!['presentationMode']).toBe('reader');

  errors.expectClean();
});
