import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { installTauriShim, type ShimScriptSeed } from './fixtures/tauri-shim';

/**
 * Capture harness for the take-controls drawer — design review only.
 *
 * Opt-in: it runs only when `DESIGN_CAPTURE_DIR` names a directory, so the
 * normal suite and CI skip every test here. Each test drives one state of the
 * drawer through the seams a real take uses — the shim's `align://snapshot` and
 * `stt://event` deliveries, a refused or ended `getUserMedia` track, a refused
 * `start_transcription`, a rejected clipboard — and writes one PNG per window
 * size. A state is checked on screen BEFORE its file is written, so a capture
 * that did not reach its state fails instead of saving a plausible wrong frame.
 *
 *   DESIGN_CAPTURE_DIR=/tmp/shots CANDIDCUE_E2E_PORT=5311 \
 *     ./node_modules/.bin/playwright test --config=playwright.config.ts \
 *     tests/e2e/browser/design-take-controls.spec.ts --project=chromium
 */

const CAPTURE_DIR = process.env.DESIGN_CAPTURE_DIR ?? '';

test.skip(CAPTURE_DIR === '', 'design capture harness: set DESIGN_CAPTURE_DIR to run it');

const SIZES = [
  { name: 'prompter', width: 1024, height: 600 },
  { name: 'window', width: 1440, height: 900 },
] as const;

const SCRIPT: ShimScriptSeed = {
  id: '77777777-7777-4777-8777-777777777777',
  title: 'Quarterly update',
  source:
    '# Opening\n\nThank you for joining me today. Here is what changed this quarter, and why it matters for the people who ship it.\n\n' +
    '## Pricing\n\nWe moved every plan to annual billing by default. Monthly billing is still there for anyone who asks for it.\n\n' +
    '## What is next\n\nWe ship the new onboarding in March. The team that built it will walk you through it next week.\n',
};

const LONG_PART_TITLE = 'Quarterly results for the enterprise customer segment, renewals included';

const PARTS_SCRIPT: ShimScriptSeed = {
  id: '88888888-8888-4888-8888-888888888888',
  title: 'Investor update',
  source:
    '[Take: Opening]\n\nWelcome back, everyone. This is the second recording of the morning.\n\n' +
    `[Take: ${LONG_PART_TITLE}]\n\nRenewals came in ahead of plan for the third quarter running. Expansion revenue carried most of it.\n`,
};

type Size = (typeof SIZES)[number];

async function boot(page: Page, size: Size, seeds: ShimScriptSeed[] = [SCRIPT]): Promise<void> {
  await page.setViewportSize({ width: size.width, height: size.height });
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: seeds,
    engineStatus: { available: true, loaded: true, model: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05' },
    promptMode: 'voice',
    following: { developerDiagnostics: true },
  });
}

async function present(page: Page): Promise<void> {
  await page.goto('/control.html');
  await page.getByRole('listbox').getByRole('button', { name: 'Present', exact: true }).first().click();
  await expect(page.getByRole('region', { name: 'Teleprompter' })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.stage-root')).toHaveAttribute('data-phase', /ready|live/, { timeout: 20_000 });
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
  atMs?: number;
}

async function snapshot(page: Page, over: SnapshotOverrides = {}): Promise<void> {
  const delivered = await page.evaluate((o) => {
    const holder = window as unknown as { __designSeq?: number };
    holder.__designSeq = (holder.__designSeq ?? 0) + 1;
    const token = o.token ?? 6;
    return window.__E2E__.emit('align://snapshot', {
      sessionGeneration: window.__E2E__.lastSession?.sessionGeneration ?? 0,
      seq: holder.__designSeq,
      state: o.state ?? 'following',
      decision: o.decision ?? 'localConfirmed',
      confirmedToken: token,
      observedToken: token,
      rateTokensPerSecond: o.rate ?? 2.4,
      evidenceAudioMs: o.atMs ?? 4_000,
      atAudioMs: o.atMs ?? 4_000,
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
      scriptLenTokens: 60,
      observedAtom: token,
      confirmedAtom: token,
    });
  }, over);
  expect(delivered).toBeGreaterThan(0);
}

/** A take that is following a voice, steadily, with a pace and a section. */
async function following(page: Page): Promise<void> {
  await hear(page, 'thank you for joining me today here is what changed');
  await snapshot(page, { token: 4, atMs: 2_000 });
  await snapshot(page, { token: 9, atMs: 4_200 });
}

function tab(page: Page): Locator {
  return page.getByRole('button', { name: /Take controls/ });
}

function panel(page: Page): Locator {
  return page.getByRole('region', { name: 'Take controls' });
}

async function openDrawer(page: Page): Promise<Locator> {
  await tab(page).click();
  const region = panel(page);
  await expect(region).toBeVisible();
  await expect(tab(page)).toHaveAttribute('aria-expanded', 'true');
  return region;
}

async function openDiagnostics(region: Locator): Promise<void> {
  await region.getByText('Why did it move?').click();
  await expect(region.getByRole('button', { name: 'Copy diagnostics' })).toBeVisible();
}

/** Scroll the drawer's own scroller to its end, for the below-the-fold half. */
async function scrollDrawerToEnd(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scrollers = [
      ...document.querySelectorAll<HTMLElement>('#take-controls-panel, #take-controls-panel *'),
    ].filter((node) => node.scrollHeight > node.clientHeight + 1 && getComputedStyle(node).overflowY !== 'visible');
    for (const node of scrollers) node.scrollTop = node.scrollHeight;
  });
}

async function shot(page: Page, state: string, size: Size): Promise<void> {
  // Past the drawer's slide and any status transition, and the caret blink.
  await page.waitForTimeout(450);
  mkdirSync(CAPTURE_DIR, { recursive: true });
  await page.screenshot({ path: join(CAPTURE_DIR, `${state}--${size.name}.png`), caret: 'hide' });
}

for (const size of SIZES) {
  test.describe(`take controls at ${size.width}x${size.height}`, () => {
    test(`closed, healthy — ${size.name}`, async ({ page }) => {
      await boot(page, size);
      await present(page);
      await following(page);
      await expect(tab(page)).toHaveAttribute('aria-expanded', 'false');
      await expect(tab(page)).not.toHaveAttribute('aria-label', /needs attention/);
      await shot(page, '01-closed-healthy', size);
    });

    test(`open, ready before any speech — ${size.name}`, async ({ page }) => {
      await boot(page, size);
      await present(page);
      await transcriptionStarted(page);
      const region = await openDrawer(page);
      await expect(region).toContainText(/Starting voice following|Ready to follow|Listening/);
      await shot(page, '02-open-ready', size);
    });

    test(`open, healthy following — ${size.name}`, async ({ page }) => {
      await boot(page, size);
      await present(page);
      await following(page);
      const region = await openDrawer(page);
      await expect(region).toContainText('Following');
      await expect(region).toContainText('words per minute');
      await shot(page, '03-open-following', size);
      await scrollDrawerToEnd(page);
      await expect(region.getByRole('button', { name: /End take/ })).toBeInViewport();
      await shot(page, '03b-open-following-end', size);
    });

    test(`open, text held — ${size.name}`, async ({ page }) => {
      await boot(page, size);
      await present(page);
      await following(page);
      const region = await openDrawer(page);
      await region.getByRole('button', { name: 'Hold text', exact: true }).click();
      await expect(region.getByRole('button', { name: 'Follow voice', exact: true })).toBeVisible();
      await expect(region).toContainText('Text held');
      await shot(page, '04-open-held', size);
    });

    test(`open, searching with candidates — ${size.name}`, async ({ page }) => {
      await boot(page, size);
      await present(page);
      await hear(page, 'and the team that built it will');
      await snapshot(page, { state: 'following', token: 9, atMs: 2_000 });
      await snapshot(page, { state: 'searching', decision: 'holdAmbiguous', confidence: 0.22, rate: 0, token: 9, atMs: 6_400 });
      await page.evaluate(async () => {
        // Through a variable: the path is the dev server's, not one the
        // typechecker can resolve from this file.
        const storeUrl = '/src/control/stores/smooth-follow.ts';
        const store = (await import(/* @vite-ignore */ storeUrl)) as {
          smoothFollow: { setCandidates(candidates: unknown[]): void };
        };
        store.smoothFollow.setCandidates([
          {
            id: 'c1',
            label: 'The team that built it will walk you through it next week.',
            sectionTitle: 'What is next',
            tokenIndex: 44,
            score: 0.71,
          },
          {
            id: 'c2',
            label: 'Here is what changed this quarter, and why it matters for the people who ship it.',
            sectionTitle: 'Opening',
            tokenIndex: 7,
            score: 0.52,
          },
          {
            id: 'c3',
            label: 'Monthly billing is still there for anyone who asks for it.',
            sectionTitle: 'Pricing',
            tokenIndex: 31,
            score: 0.4,
          },
        ]);
      });
      const region = await openDrawer(page);
      await expect(region).toContainText('Monthly billing is still there');
      await shot(page, '05-open-candidates', size);
    });

    test(`microphone lost — ${size.name}`, async ({ page }) => {
      test.setTimeout(60_000);
      /*
       * An input that opens and then carries nothing. The take's own §28.6
       * detector — the level meter AND the PCM tap both silent for five
       * seconds — is what reports the device gone, exactly as a dead USB
       * microphone does.
       */
      await page.addInitScript(() => {
        navigator.mediaDevices.getUserMedia = async () => {
          const context = new AudioContext();
          return context.createMediaStreamDestination().stream;
        };
      });
      await boot(page, size);
      await present(page);
      await following(page);
      await expect(tab(page)).toHaveAttribute('aria-label', /needs attention/, { timeout: 20_000 });
      await shot(page, '06-closed-attention', size);
      const region = await openDrawer(page);
      await expect(region.getByRole('combobox', { name: 'Input device' })).toBeVisible();
      await expect(region).toContainText('Microphone disconnected');
      await shot(page, '07-open-mic-lost', size);
    });

    test(`microphone refused — ${size.name}`, async ({ page }) => {
      await page.addInitScript(() => {
        navigator.mediaDevices.getUserMedia = () =>
          Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
      });
      await boot(page, size);
      await present(page);
      await expect(tab(page)).toHaveAttribute('aria-label', /needs attention/, { timeout: 15_000 });
      const region = await openDrawer(page);
      await expect(region.getByRole('button', { name: 'Open System Settings' })).toBeVisible();
      await shot(page, '08-open-mic-refused', size);
    });

    test(`voice unavailable — ${size.name}`, async ({ page }) => {
      await boot(page, size);
      await page.goto('/control.html');
      await page.evaluate(() =>
        window.__E2E__.setFail('start_transcription', {
          code: 'STT_MODEL_LOAD_FAILED',
          userMessage: 'The speech model could not be used.',
        }),
      );
      await page.getByRole('listbox').getByRole('button', { name: 'Present', exact: true }).first().click();
      await expect(page.getByRole('region', { name: 'Teleprompter' })).toBeVisible({ timeout: 20_000 });
      const region = await openDrawer(page);
      await expect(region).toContainText('Voice unavailable');
      await shot(page, '09-open-voice-unavailable', size);
    });

    test(`long part title — ${size.name}`, async ({ page }) => {
      await boot(page, size, [PARTS_SCRIPT]);
      await page.goto('/control.html');
      await page.getByRole('listbox').getByText(PARTS_SCRIPT.title).first().dblclick();
      await page.getByRole('button', { name: 'How to present' }).click();
      await page.getByRole('menuitem', { name: /Part 2/ }).click();
      await expect(page.getByRole('region', { name: 'Teleprompter' })).toBeVisible({ timeout: 20_000 });
      await hear(page, 'renewals came in ahead of plan');
      await snapshot(page, { token: 14, atMs: 2_400 });
      const region = await openDrawer(page);
      await expect(region).toContainText(LONG_PART_TITLE);
      await shot(page, '10-open-long-part', size);
    });

    test(`diagnostics expanded — ${size.name}`, async ({ page }) => {
      await boot(page, size);
      await present(page);
      await hear(page, 'thank you for joining me today');
      await snapshot(page, { token: 4, atMs: 1_800 });
      await snapshot(page, { state: 'holding', decision: 'holdOffScript', confidence: 0.4, rate: 0, token: 4, atMs: 5_200 });
      await snapshot(page, { decision: 'retakeAccepted', confidence: 0.81, token: 2, atMs: 7_900 });
      await snapshot(page, { decision: 'jumpForwardAccepted', confidence: 0.86, token: 30, atMs: 14_300 });
      await snapshot(page, { token: 33, atMs: 16_000 });
      const region = await openDrawer(page);
      await openDiagnostics(region);
      await expect(region.locator('.timeline')).toBeVisible();
      await shot(page, '11-open-diagnostics', size);
      await scrollDrawerToEnd(page);
      await shot(page, '11b-open-diagnostics-end', size);
    });

    test(`a fault while the drawer was left scrolled — ${size.name}`, async ({ page }) => {
      test.setTimeout(60_000);
      await page.addInitScript(() => {
        navigator.mediaDevices.getUserMedia = async () => {
          const context = new AudioContext();
          return context.createMediaStreamDestination().stream;
        };
      });
      await boot(page, size);
      await present(page);
      await following(page);
      const region = await openDrawer(page);
      await openDiagnostics(region);
      await scrollDrawerToEnd(page);
      await page.keyboard.press('Escape');
      await expect(tab(page)).toHaveAttribute('aria-expanded', 'false');
      await expect(tab(page)).toHaveAttribute('aria-label', /needs attention/, { timeout: 20_000 });
      await openDrawer(page);
      await expect(region.getByRole('combobox', { name: 'Input device' })).toBeInViewport();
      await shot(page, '13-reopen-on-fault', size);
    });

    test(`take paused — ${size.name}`, async ({ page }) => {
      await boot(page, size);
      await present(page);
      await following(page);
      await page.keyboard.press('Space');
      const region = await openDrawer(page);
      await expect(region).toContainText('Take paused');
      await shot(page, '14-open-take-paused', size);
    });

    test(`clipboard failure — ${size.name}`, async ({ page }) => {
      await boot(page, size);
      await present(page);
      await following(page);
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: { writeText: () => Promise.reject(new Error('denied')) },
        });
      });
      const region = await openDrawer(page);
      await openDiagnostics(region);
      await region.getByRole('button', { name: 'Copy diagnostics' }).click();
      const field = region.getByRole('textbox', { name: 'Follow diagnostics export' });
      await expect(field).toBeVisible();
      await field.scrollIntoViewIfNeeded();
      await shot(page, '12-open-clipboard-failure', size);
    });
  });
}
