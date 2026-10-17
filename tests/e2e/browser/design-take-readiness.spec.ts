/**
 * Design capture harness for the "Before this take" readiness sheet.
 *
 * Not a test of behaviour — `editor-model-readiness.spec.ts` and the DOM tests
 * own that. This drives the sheet into every state that carries design weight
 * and writes a screenshot of each, for a design review to look at. It never
 * runs in the normal suite:
 *
 *     DESIGN_CAPTURE=1 DESIGN_CAPTURE_DIR=/abs/out CANDIDCUE_E2E_PORT=5315 \
 *       ./node_modules/.bin/playwright test --config=playwright.config.ts \
 *       tests/e2e/browser/design-take-readiness.spec.ts
 *
 * Every condition arrives through the seam the app really reads: the shim's
 * model status, the settings overlay for a pinned microphone, Rust's
 * `get_microphone_permission`, and `navigator.mediaDevices` for the device
 * list and the permission request. The request can be held open, which is the
 * only way to see the sheet while the OS prompt is up.
 *
 * Each shot is checked for the text it is meant to show AFTER the sheet has
 * settled, and the harness throws rather than write a frame of the wrong state.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { installTauriShim, type ShimConfig } from './fixtures/tauri-shim';
import { openScript } from './fixtures/library';

const CAPTURE = process.env['DESIGN_CAPTURE'] === '1';
const OUT = process.env['DESIGN_CAPTURE_DIR'];

test.skip(!CAPTURE, 'design capture harness — set DESIGN_CAPTURE=1');

const SCRIPT = {
  id: '30130130-1301-4301-8301-301301301399',
  title: 'Quarterly update',
  source:
    '# Opening\n\nThank you for joining me today. Here is what changed this quarter.\n\n' +
    '## What is next\n\nWe ship the new onboarding in March, and the pricing page after it.\n',
};

/** Headings only: nothing a take could follow. */
const SILENT_SCRIPT = {
  id: '30130130-1301-4301-8301-301301301398',
  title: 'Outline only',
  source: '# Opening\n\n## What changed\n\n## What is next\n',
};

const CATALOGUE_ID = 'x-asr-480ms';
const RECOGNIZER_ID = 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05';

function nothingInstalled(): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    [CATALOGUE_ID, RECOGNIZER_ID].map((id) => [
      id,
      {
        modelId: id,
        modelName: RECOGNIZER_ID,
        languages: ['en', 'zh'],
        phase: 'notInstalled',
        source: null,
        installed: false,
        supported: true,
        downloadBytes: 133_895_136,
        installedBytes: 0,
        progressBytes: 0,
        progressTotal: 0,
        operationId: null,
        error: null,
      },
    ]),
  );
}

const VIEWPORTS = [
  { name: 'normal', width: 1240, height: 820 },
  { name: 'narrow', width: 980, height: 680 },
] as const;

interface MicSeed {
  /** What Rust answers to `get_microphone_permission`; null is "cannot say". */
  permission: 'granted' | 'denied' | 'restricted' | 'prompt' | null;
  /** A pinned microphone that is not in the device list. */
  pinnedMissing?: boolean;
  /** Hold `getUserMedia` until the spec answers it. */
  holdRequest?: boolean;
}

interface Scenario {
  name: string;
  script: typeof SCRIPT;
  shim: ShimConfig;
  mic: MicSeed;
  /** Reach the sheet by asking for it, rather than by pressing Present. */
  requested?: boolean;
  /** Text the sheet must show before the frame is written. */
  expects: string[];
}

const SCENARIOS: Scenario[] = [
  {
    name: 'healthy-review',
    script: SCRIPT,
    shim: {},
    mic: { permission: null },
    requested: true,
    expects: ['Everything needed for this take is ready.'],
  },
  {
    name: 'single-warning-mic-unplugged',
    script: SCRIPT,
    shim: {},
    mic: { permission: 'granted', pinnedMissing: true },
    expects: ['is not connected'],
  },
  {
    name: 'missing-model',
    script: SCRIPT,
    shim: { modelStatuses: nothingInstalled() },
    mic: { permission: null },
    expects: ['No speech model is installed'],
  },
  {
    name: 'several-warnings',
    script: SCRIPT,
    shim: { modelStatuses: nothingInstalled() },
    mic: { permission: 'granted', pinnedMissing: true },
    expects: ['No speech model is installed', 'is not connected'],
  },
  {
    name: 'blocking-empty-script',
    script: SILENT_SCRIPT,
    shim: {},
    mic: { permission: null },
    expects: ['There are no spoken words'],
  },
  {
    name: 'blocking-with-warnings',
    script: SILENT_SCRIPT,
    shim: { modelStatuses: nothingInstalled() },
    mic: { permission: 'denied' },
    expects: ['There are no spoken words', 'No speech model is installed', 'not allowed to use'],
  },
  {
    name: 'mic-refused',
    script: SCRIPT,
    shim: {},
    mic: { permission: 'denied' },
    expects: ['not allowed to use the microphone'],
  },
  {
    name: 'mic-restricted',
    script: SCRIPT,
    shim: {},
    mic: { permission: 'restricted' },
    expects: ['restricted'],
  },
];

/**
 * The microphone, as the page sees it.
 *
 * Registered after the shim, so its `__TAURI_INTERNALS__` is already there to
 * wrap. Only the one command the shim leaves unanswered is taken over.
 */
async function installMicrophone(page: Page, seed: MicSeed): Promise<void> {
  await page.addInitScript((cfg: MicSeed) => {
    type Pending = { resolve: (stream: MediaStream) => void; reject: (err: unknown) => void; constraints: MediaStreamConstraints };
    const state = { permission: cfg.permission, pending: [] as Pending[] };
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const invoke = internals.invoke.bind(internals);
    internals.invoke = (command: string, args?: unknown) => {
      if (command === 'get_microphone_permission') return Promise.resolve(state.permission);
      if (command === 'open_microphone_settings') return Promise.resolve(null);
      return invoke(command, args);
    };

    const media = navigator.mediaDevices;
    const realGetUserMedia = media.getUserMedia.bind(media);
    const realEnumerate = media.enumerateDevices.bind(media);

    if (cfg.pinnedMissing) {
      // Whatever is really there, plus a built-in — and never the pinned one.
      media.enumerateDevices = async () => {
        const builtIn = {
          deviceId: 'built-in-0001',
          groupId: 'group-built-in',
          kind: 'audioinput' as const,
          label: 'MacBook Pro Microphone',
          toJSON() {
            return this;
          },
        };
        return [...(await realEnumerate()), builtIn as unknown as MediaDeviceInfo];
      };
    }
    if (cfg.holdRequest) {
      media.getUserMedia = (constraints?: MediaStreamConstraints) =>
        new Promise<MediaStream>((resolve, reject) => {
          state.pending.push({ resolve, reject, constraints: constraints ?? { audio: true } });
        });
    }

    (window as unknown as Record<string, unknown>)['__DESIGN_MIC__'] = {
      pending: () => state.pending.length,
      answer(granted: boolean) {
        const due = state.pending.splice(0);
        state.permission = granted ? 'granted' : 'denied';
        for (const request of due) {
          if (granted) void realGetUserMedia(request.constraints).then(request.resolve, request.reject);
          else request.reject(new DOMException('Permission denied', 'NotAllowedError'));
        }
      },
    };
  }, seed);
}

function sheet(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Before this take' });
}

async function openSheet(page: Page, scenario: Scenario): Promise<void> {
  const shim: ShimConfig = {
    welcomed: true,
    seedScripts: [scenario.script],
    promptMode: 'voice',
    ...scenario.shim,
  };
  await installTauriShim(page, shim);
  if (scenario.mic.pinnedMissing) {
    await page.addInitScript(() => {
      localStorage.setItem(
        'candidcue.settings-overlay.v1',
        JSON.stringify({
          audio: {
            followSystemDefault: false,
            preferredDeviceId: 'shure-mv7-usb-0001',
            preferredDeviceLabel: 'Shure MV7+',
          },
        }),
      );
    });
  }
  await installMicrophone(page, scenario.mic);
  await page.goto('/control.html');
  await openScript(page, scenario.script.title);
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeVisible();

  // The compile has to have settled, or a silent script reads as one word and
  // the sheet never says it is empty.
  const foot = page.locator('.panel-foot');
  await expect(foot).not.toContainText('Reading the script', { timeout: 15_000 });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const asked = window.__E2E__.calls.filter((c) => c.command === 'get_speech_model_status').length;
        const answered = window.__E2E__.settled.filter((c) => c === 'get_speech_model_status').length;
        return asked > 0 && answered >= asked;
      }),
    )
    .toBe(true);

  if (scenario.requested) {
    await page.getByRole('button', { name: 'How to present' }).click();
    await page
      .getByRole('menu', { name: 'How to present' })
      .getByRole('menuitem', { name: /Review take setup/ })
      .click();
  } else {
    await page.locator('header.toolbar').getByRole('button', { name: 'Present', exact: true }).click();
  }
  await expect(sheet(page)).toBeVisible();
}

/** Verify, let the entrance finish, then write the window and the sheet alone. */
async function capture(page: Page, file: string, expects: string[]): Promise<void> {
  if (!OUT) throw new Error('DESIGN_CAPTURE_DIR must be set to a directory outside the repo');
  const dialog = sheet(page);
  for (const text of expects) await expect(dialog).toContainText(text);
  await page.waitForFunction(() => {
    const scrim = document.querySelector('.scrim');
    return scrim !== null && getComputedStyle(scrim).opacity === '1';
  });
  await page.waitForTimeout(250);
  // After the settle, not before: a frame of the wrong state is worse than none.
  for (const text of expects) await expect(dialog).toContainText(text);

  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, `${file}--window.png`) });
  const box = await dialog.boundingBox();
  if (box === null) throw new Error(`${file}: the sheet has no box — refusing to write`);
  const viewport = page.viewportSize()!;
  const margin = 20;
  const x = Math.max(0, box.x - margin);
  const y = Math.max(0, box.y - margin);
  await page.screenshot({
    path: join(OUT, `${file}--sheet.png`),
    clip: {
      x,
      y,
      width: Math.min(viewport.width - x, box.width + margin * 2),
      height: Math.min(viewport.height - y, box.height + margin * 2),
    },
  });
}

test.use({ deviceScaleFactor: 2 });

for (const viewport of VIEWPORTS) {
  test.describe(`readiness sheet — ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    for (const scenario of SCENARIOS) {
      test(scenario.name, async ({ page }) => {
        await openSheet(page, scenario);
        await capture(page, `${scenario.name}--${viewport.name}`, scenario.expects);
      });
    }

    test('permission-pending and recovered', async ({ page }) => {
      const scenario: Scenario = {
        name: 'permission',
        script: SCRIPT,
        shim: { modelStatuses: nothingInstalled() },
        mic: { permission: 'prompt', holdRequest: true },
        expects: ['has not been allowed to use the microphone yet', 'No speech model is installed'],
      };
      await openSheet(page, scenario);
      await capture(page, `permission-asking--${viewport.name}`, scenario.expects);

      await sheet(page).getByRole('button', { name: 'Allow microphone' }).click();
      await expect
        .poll(() => page.evaluate(() => (window as unknown as { __DESIGN_MIC__: { pending: () => number } }).__DESIGN_MIC__.pending()))
        .toBeGreaterThan(0);
      await capture(page, `permission-pending--${viewport.name}`, scenario.expects);

      await page.evaluate(() =>
        (window as unknown as { __DESIGN_MIC__: { answer: (granted: boolean) => void } }).__DESIGN_MIC__.answer(true),
      );
      await expect(sheet(page)).not.toContainText('has not been allowed to use the microphone yet');
      await capture(page, `recovered--${viewport.name}`, ['No speech model is installed']);
    });
  });
}
