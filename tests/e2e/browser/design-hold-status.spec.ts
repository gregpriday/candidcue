import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { installTauriShim, type ShimScriptSeed } from './fixtures/tauri-shim';
import { openScript } from './fixtures/library';

/**
 * Capture harness for the presenter's hold status — design review only.
 *
 * Opt-in: it runs only when `DESIGN_CAPTURE_DIR` names a directory, so the
 * normal suite and CI skip every test here. Each test drives one rung or
 * reason of the hold ladder through the seams a real take uses — the shim's
 * `align://snapshot` deliveries, a microphone that opens and carries nothing,
 * the follow switch, the A key, and for control loss a separate stage window
 * whose heartbeat is allowed to lapse. A state is checked on screen BEFORE its
 * file is written, so a capture that did not reach its state fails instead of
 * saving a plausible wrong frame.
 *
 *   DESIGN_CAPTURE_DIR=/tmp/shots CANDIDCUE_E2E_PORT=5322 \
 *     ./node_modules/.bin/playwright test --config=playwright.config.ts \
 *     tests/e2e/browser/design-hold-status.spec.ts --project=chromium
 *
 * Every state is written twice: the whole glass, and `--crop`, a close look at
 * the corner the chip lives in.
 */

const CAPTURE_DIR = process.env.DESIGN_CAPTURE_DIR ?? '';

test.skip(CAPTURE_DIR === '', 'design capture harness: set DESIGN_CAPTURE_DIR to run it');

/** The 9-inch Elgato the product is tuned on, and a desk monitor. */
const PROMPTER = { name: 'prompter', width: 1024, height: 600 } as const;
const DESK = { name: 'desk', width: 1440, height: 900 } as const;
const READER = { name: 'reader', width: 1100, height: 700 } as const;
type Size = { name: string; width: number; height: number };

const SCRIPT: ShimScriptSeed = {
  id: '66666666-6666-4666-8666-666666666666',
  title: 'Launch walkthrough',
  source:
    '# Opening\n\nThank you for joining me today. Here is what changed this quarter, and why it matters for the people who ship it.\n\n' +
    'We spent most of the spring listening to the teams who use this every day, and three things came up again and again.\n\n' +
    '## Pricing\n\nWe moved every plan to annual billing by default. Monthly billing is still there for anyone who asks for it.\n\n' +
    'Thank you for joining me today, and for the questions you sent ahead of time.\n\n' +
    '## What is next\n\nWe ship the new onboarding in March. The team that built it will walk you through it next week.\n',
};

async function boot(
  page: Page,
  size: Size,
  options: { reader?: boolean; paper?: boolean; deadMic?: boolean } = {},
): Promise<void> {
  await page.setViewportSize({ width: size.width, height: size.height });
  if (options.deadMic) {
    /*
     * An input that is asked for and never delivers a frame — another process
     * holding the device, or a permission refused below the app. The pill's
     * own no-capture window expires and it reports "No audio", which is the
     * fault the chip names. (A stream that opens SILENT is deliberately not a
     * fault: that is a presenter collecting their thoughts.)
     */
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => new Promise<MediaStream>(() => {});
    });
  }
  if (options.paper) {
    await page.addInitScript(() => {
      const key = 'candidcue.settings-overlay.v1';
      const overlay = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>;
      const teleprompter = (overlay['teleprompter'] ?? {}) as Record<string, unknown>;
      overlay['teleprompter'] = { ...teleprompter, readerTheme: 'paper' };
      localStorage.setItem(key, JSON.stringify(overlay));
    });
  }
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [SCRIPT],
    /*
     * The control window sits on the prompter panel, so Present lands there,
     * and the panel is the size of the window under test: a 1024x600 grid is
     * the 9-inch Elgato, which resolves the automatic profile a real rig gets.
     * Any other size is a panel the optical model cannot identify.
     */
    windowDisplay: 'dsp-e2e-prompter',
    prompterPanel: { width: size.width, height: size.height, name: 'Monitor #1' },
    presentationMode: options.reader ? 'reader' : 'prompter',
    engineStatus: { available: true, loaded: true, model: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05' },
    promptMode: 'voice',
  });
}

async function present(page: Page, reader = false): Promise<void> {
  await page.goto('/control.html');
  await openScript(page, /Launch walkthrough/);
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeVisible();
  await page.getByRole('button', { name: 'How to present' }).click();
  await page
    .getByRole('menu', { name: 'How to present' })
    .getByRole('menuitemradio', { name: reader ? /Present in a window/ : /Present full screen/ })
    .click();
  await expect(page.locator('.stage-root')).toHaveAttribute('data-phase', /ready|live/, {
    timeout: 20_000,
  });
  await expect(page.locator('.script-layer span.w[data-t]').first()).toBeVisible();
}

async function transcriptionStarted(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__E2E__.settled.includes('start_transcription')), {
      timeout: 15_000,
    })
    .toBe(true);
}

/** Words arriving on the take's own transcription generation. */
async function hear(page: Page, text: string): Promise<void> {
  await transcriptionStarted(page);
  await page.evaluate((spoken) => {
    const generation =
      40 + window.__E2E__.calls.filter((call) => call.command === 'start_transcription').length;
    window.__E2E__.emit('stt://event', { kind: 'transport', generation, state: 'connected' });
    window.__E2E__.emit('stt://event', {
      kind: 'partial',
      generation,
      itemId: `design-${Date.now()}`,
      text: spoken,
    });
  }, text);
}

interface SnapshotOverrides {
  state?: 'searching' | 'following' | 'holding' | 'ambiguous';
  decision?: string;
  token?: number;
  confidence?: number;
  rate?: number;
}

async function snapshot(page: Page, over: SnapshotOverrides = {}): Promise<void> {
  const delivered = await page.evaluate((o) => {
    const token = o.token ?? 6;
    const at = performance.now();
    return window.__E2E__.emit('align://snapshot', {
      sessionGeneration: window.__E2E__.lastSession?.sessionGeneration ?? 0,
      seq: window.__E2E__.nextAlignmentSeq(),
      state: o.state ?? 'following',
      decision: o.decision ?? 'localConfirmed',
      confirmedToken: token,
      observedToken: token,
      rateTokensPerSecond: o.rate ?? 0,
      evidenceAudioMs: at,
      atAudioMs: at,
      maxPredictionMs: 800,
      pauseOnsetMs: 400,
      leadFloorMs: 0,
      maxLeadTokens: 2,
      leadMarginTokens: 2.2,
      leadEaseMs: 450,
      leadHoldMs: 0,
      leadDecayMs: 1200,
      displayLimitToken: token + 6,
      confidence: o.confidence ?? 0.92,
      suggestionToken: null,
      scriptLenTokens: 120,
      observedAtom: token,
      confirmedAtom: token,
    });
  }, over);
  expect(delivered).toBeGreaterThan(0);
}

/**
 * A take that has found the presenter and is reading along.
 *
 * `heard: false` for a take whose microphone never opened: transcription waits
 * on the capture, so no words can arrive — but the place it reached before the
 * input died is still where the glass is.
 */
async function following(page: Page, heard = true): Promise<void> {
  if (heard) await hear(page, 'thank you for joining me today here is what changed');
  await snapshot(page, { token: 4 });
  await snapshot(page, { token: 9 });
}

/** Hold in `state` for long enough to reach the top rung. */
async function holdFor(page: Page, state: SnapshotOverrides['state'], ms: number): Promise<void> {
  await snapshot(page, {
    state,
    decision: state === 'ambiguous' ? 'holdAmbiguous' : 'holdOffScript',
    token: 9,
    confidence: 0.35,
  });
  await page.waitForTimeout(ms);
}

function chip(page: Page): Locator {
  return page.locator('.hold-status');
}

async function chipShows(page: Page, text: string | RegExp): Promise<void> {
  await expect(chip(page)).toHaveAttribute('data-visible', 'true');
  await expect(chip(page)).toContainText(text);
}

async function chipHidden(page: Page): Promise<void> {
  await expect(chip(page)).toHaveAttribute('data-visible', 'false');
}

async function shot(page: Page, state: string, size: Size): Promise<void> {
  // Past the chip's fade and any cue transition.
  await page.waitForTimeout(400);
  mkdirSync(CAPTURE_DIR, { recursive: true });
  await page.screenshot({ path: join(CAPTURE_DIR, `${state}--${size.name}.png`), caret: 'hide' });
  /*
   * The close look: the top-left third of the glass at twice the pixels, where
   * the chip, the reading cue's left tick and the opening lines all sit.
   */
  await page.screenshot({
    path: join(CAPTURE_DIR, `${state}--${size.name}--crop.png`),
    caret: 'hide',
    clip: { x: 0, y: 0, width: Math.round(size.width * 0.5), height: Math.round(size.height * 0.5) },
  });
}

test.describe('hold status on the prompter', () => {
  test('following, nothing withheld', async ({ page }) => {
    await boot(page, PROMPTER);
    await present(page);
    await following(page);
    await page.waitForTimeout(1200);
    await chipHidden(page);
    await shot(page, '01-following', PROMPTER);
  });

  test('the wordless rung: the cue goes hollow', async ({ page }) => {
    await boot(page, PROMPTER);
    await present(page);
    await following(page);
    await holdFor(page, 'holding', 2300);
    await chipHidden(page);
    await shot(page, '02-hollow', PROMPTER);
  });

  test('an ordinary hold, at the top rung', async ({ page }) => {
    await boot(page, PROMPTER);
    await present(page);
    await following(page);
    await holdFor(page, 'holding', 4600);
    await chipShows(page, 'Holding here');
    await shot(page, '03-holding', PROMPTER);
  });

  test('finding your place', async ({ page }) => {
    await boot(page, PROMPTER);
    await present(page);
    await following(page);
    await holdFor(page, 'searching', 4600);
    await chipShows(page, 'Finding your place');
    await shot(page, '04-searching', PROMPTER);
  });

  test('two matching places', async ({ page }) => {
    await boot(page, PROMPTER);
    await present(page);
    await following(page);
    await holdFor(page, 'ambiguous', 4600);
    await chipShows(page, /Two matching places/);
    await shot(page, '05-ambiguous', PROMPTER);
  });

  test('following switched off', async ({ page }) => {
    await boot(page, PROMPTER);
    await present(page);
    await following(page);
    await page.getByRole('button', { name: /Take controls/ }).click();
    const region = page.getByRole('region', { name: 'Take controls' });
    await region.getByRole('button', { name: 'Hold text', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(region).toBeHidden();
    await chipShows(page, /Following off|Text held|Hold/);
    await shot(page, '06-following-off', PROMPTER);
  });

  test('the microphone stops carrying audio', async ({ page }) => {
    test.setTimeout(60_000);
    await boot(page, PROMPTER, { deadMic: true });
    await present(page);
    await following(page, false);
    await expect(chip(page)).toHaveAttribute('data-tone', 'fault', { timeout: 25_000 });
    await expect(chip(page)).toHaveAttribute('data-visible', 'true');
    await shot(page, '07-fault', PROMPTER);
  });

  test('the microphone fault, with the set pace already running', async ({ page }) => {
    test.setTimeout(60_000);
    await boot(page, PROMPTER, { deadMic: true });
    await present(page);
    await following(page, false);
    await expect(chip(page)).toHaveAttribute('data-tone', 'fault', { timeout: 25_000 });
    await page.locator('.stage-root').click({ position: { x: 512, y: 300 } });
    await page.keyboard.press('a');
    await expect(chip(page).locator('.hint')).toHaveCount(0, { timeout: 5_000 });
    await expect(chip(page)).toHaveAttribute('data-visible', 'true');
    await shot(page, '08-fault-pace-running', PROMPTER);
  });

  test('the microphone fault, read through a mirror', async ({ page }) => {
    test.setTimeout(60_000);
    await boot(page, PROMPTER, { deadMic: true });
    await present(page);
    await following(page, false);
    await page.evaluate(() =>
      window.__E2E__.emit('menu://command', { id: 'session.toggle-mirror' }),
    );
    await expect(page.locator('.stage-talent-plane')).toHaveAttribute('data-mirror-x', 'true');
    await expect(chip(page)).toHaveAttribute('data-tone', 'fault', { timeout: 25_000 });
    await expect(chip(page)).toHaveAttribute('data-visible', 'true');
    await shot(page, '09-fault-mirrored', PROMPTER);
  });

  test('the escalation, frame by frame', async ({ page }) => {
    await boot(page, PROMPTER);
    await present(page);
    await following(page);
    await page.waitForTimeout(800);
    await snapshot(page, { state: 'searching', decision: 'holdOffScript', token: 9, confidence: 0.3 });
    const started = Date.now();
    mkdirSync(CAPTURE_DIR, { recursive: true });
    for (const at of [500, 1800, 3000, 4200]) {
      const wait = at - (Date.now() - started);
      if (wait > 0) await page.waitForTimeout(wait);
      await page.screenshot({
        path: join(CAPTURE_DIR, `strip-ladder-t${String(at).padStart(4, '0')}.png`),
        caret: 'hide',
        clip: { x: 0, y: 0, width: 1024, height: 360 },
      });
    }
    await chipShows(page, 'Finding your place');
  });
});

test.describe('hold status on a desk monitor', () => {
  test('two matching places, large panel', async ({ page }) => {
    await boot(page, DESK);
    await present(page);
    await following(page);
    await holdFor(page, 'ambiguous', 4600);
    await chipShows(page, /Two matching places/);
    await shot(page, '10-ambiguous', DESK);
  });

  test('an ordinary hold, large panel', async ({ page }) => {
    await boot(page, DESK);
    await present(page);
    await following(page);
    await holdFor(page, 'holding', 4600);
    await chipShows(page, 'Holding here');
    await shot(page, '11-holding', DESK);
  });
});

test.describe('hold status in a reading window', () => {
  test('two matching places, dark', async ({ page }) => {
    await boot(page, READER, { reader: true });
    await present(page, true);
    await following(page);
    await holdFor(page, 'ambiguous', 4600);
    await chipShows(page, /Two matching places/);
    await shot(page, '12-ambiguous-reader-dark', READER);
  });

  test('an ordinary hold, paper', async ({ page }) => {
    await boot(page, READER, { reader: true, paper: true });
    await present(page, true);
    await following(page);
    await holdFor(page, 'holding', 4600);
    await chipShows(page, 'Holding here');
    await shot(page, '13-holding-reader-paper', READER);
  });

  test('the microphone fault, paper', async ({ page }) => {
    test.setTimeout(60_000);
    await boot(page, READER, { reader: true, paper: true, deadMic: true });
    await present(page, true);
    await following(page, false);
    await expect(chip(page)).toHaveAttribute('data-tone', 'fault', { timeout: 25_000 });
    await expect(chip(page)).toHaveAttribute('data-visible', 'true');
    await shot(page, '14-fault-reader-paper', READER);
  });
});

test.describe('hold status on a separate stage window', () => {
  /*
   * Control loss only exists where control and the stage are two windows: the
   * watchdog freezes the stage when control's heartbeat stops, and a
   * single-window take has no second window to lose. So the stage window is
   * opened on its own and handed a take's envelope — built by the real
   * compiler and the real envelope builder, at the automatic profile this
   * panel resolves to — and then control goes quiet.
   */
  test('control stops responding', async ({ page }) => {
    test.setTimeout(60_000);
    await boot(page, PROMPTER);
    await page.goto('/stage.html');
    await expect(page.locator('.stage-root')).toHaveAttribute('data-phase', 'handshake');
    const stageGeneration = await page.evaluate(
      async ({ source, scriptId, width, height }) => {
        // Through variables: these are the dev server's paths, not ones the
        // typechecker can resolve from this file.
        const compileUrl = '/src/shared/markdown/compile.ts';
        const envelopeUrl = '/src/control/services/stage-envelope.ts';
        const discoveryUrl = '/src/shared/optical-discovery.ts';
        const { compile } = (await import(/* @vite-ignore */ compileUrl)) as {
          compile(source: string, options: { scriptId: string }): unknown;
        };
        const { buildStageSettings, buildStageEnvelope } = (await import(
          /* @vite-ignore */ envelopeUrl
        )) as {
          buildStageSettings(overrides: unknown): unknown;
          buildStageEnvelope(input: unknown): { stageGeneration: number };
        };
        const { automaticProfile } = (await import(/* @vite-ignore */ discoveryUrl)) as {
          automaticProfile(display: unknown): unknown;
        };
        const profile = automaticProfile({
          name: 'Monitor #1',
          physicalSize: { width, height },
          scaleFactor: 1,
        });
        const stageSettings = buildStageSettings(
          profile ? { optical: { profile, viewport: { widthPx: width, heightPx: height } } } : {},
        );
        const envelope = buildStageEnvelope({
          script: compile(source, { scriptId }),
          sessionId: '00000000-0000-4000-8000-0000000000aa',
          sessionGeneration: 1,
          stageGeneration: 1,
          stageSettings,
        });
        window.__E2E__.emit('stage://load-session', envelope);
        return envelope.stageGeneration;
      },
      { source: SCRIPT.source, scriptId: SCRIPT.id, width: PROMPTER.width, height: PROMPTER.height },
    );
    await page.waitForTimeout(500);
    await page.evaluate((generation) => {
      window.__E2E__.emit('stage://heartbeat', {
        stageGeneration: generation,
        revision: 1,
        sentAtMs: 1000,
      });
    }, stageGeneration);
    await expect(page.locator('.script-layer span.w[data-t]').first()).toBeVisible();
    await expect(chip(page)).toHaveAttribute('data-visible', 'true', { timeout: 15_000 });
    await expect(chip(page)).toContainText('Control stopped responding');
    await shot(page, '15-control-lost', PROMPTER);
  });
});
