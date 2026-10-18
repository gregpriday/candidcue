/**
 * Design capture harness for the Present split button's menu.
 *
 * Not a test of behaviour — `present-parts-menu.test.ts` and the take specs own
 * that. This opens the menu in every state that carries design weight and
 * writes a screenshot of each, for a design review to look at. It never runs in
 * the normal suite:
 *
 *     DESIGN_CAPTURE=1 DESIGN_CAPTURE_DIR=/abs/out CANDIDCUE_E2E_PORT=5316 \
 *       ./node_modules/.bin/playwright test --config=playwright.config.ts \
 *       tests/e2e/browser/design-present-menu.spec.ts
 *
 * The rows arrive through the seams the Editor really reads: the compile of a
 * seeded script for the parts, the editor's own caret for "From here", Rust's
 * `list_sessions` for "From last ending", and the settings document for which
 * shape is checked. Each frame is checked for the rows it is meant to show
 * AFTER the menu has settled, and the harness throws rather than write a frame
 * of the wrong state.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';
import { openScript } from './fixtures/library';

const CAPTURE = process.env['DESIGN_CAPTURE'] === '1';
const OUT = process.env['DESIGN_CAPTURE_DIR'];

test.skip(!CAPTURE, 'design capture harness — set DESIGN_CAPTURE=1');

interface Seed {
  id: string;
  title: string;
  source: string;
}

/** Two parts on its top-level headings, and a sub-section the last take stopped in. */
const LESSON: Seed = {
  id: '40140140-1401-4401-8401-401401401401',
  title: 'Recording lesson',
  source:
    '# Getting started\n\n' +
    'Welcome to the first recording. This is a short script to practise with before the real thing.\n\n' +
    '## Read this part out loud\n\n' +
    'Keep going at whatever pace feels natural to you. The text will follow along as you speak.\n\n' +
    'If you stumble, just carry on from the start of the sentence.\n\n' +
    '# Second attempt\n\n' +
    'Now read it again, a little faster this time, and notice how the scrolling keeps up.\n',
};

/** No headings, no markers: an undivided script. */
const NOTE: Seed = {
  id: '40140140-1401-4401-8401-401401401402',
  title: 'Short note',
  source:
    'Thank you for joining me today. Here is what changed this quarter, and why it matters for the next one.\n',
};

/** Fourteen sections: two more than the menu lists. */
const COURSE: Seed = {
  id: '40140140-1401-4401-8401-401401401403',
  title: 'Course module',
  source: [
    'Introduction',
    'Why this matters',
    'Setting up the rig',
    'Positioning the glass',
    'Lighting the subject',
    'Choosing a microphone',
    'Writing for the ear',
    'Pacing and breath',
    'Recovering from a stumble',
    'Retakes without starting over',
    'Reviewing a take',
    'Exporting the edit',
    'Publishing the lesson',
    'What to try next',
  ]
    .map((heading, i) => `# ${heading}\n\nThis is section ${i + 1}, which covers ${heading.toLowerCase()} in a few sentences.\n`)
    .join('\n'),
};

interface Scenario {
  name: string;
  script: Seed;
  viewport: { width: number; height: number };
  mode: 'prompter' | 'reader';
  /** Text of the editor line to put the caret on, or none to leave it at the top. */
  caretOn?: string;
  /** Where the last take stopped, as a spoken-token index; none is "no history". */
  lastEndToken?: number;
  /** How the menu is opened. */
  open: 'pointer' | 'keyboard';
  /** After opening, hover the row whose name matches. */
  hover?: RegExp;
  /** Row names (regex) the menu must show before the frame is written. */
  expects: RegExp[];
  /** Also write the whole window. */
  window?: boolean;
}

const NORMAL = { width: 1240, height: 820 };
const NARROW = { width: 980, height: 680 };

const SCENARIOS: Scenario[] = [
  {
    name: 'full-rest',
    script: LESSON,
    viewport: NORMAL,
    mode: 'reader',
    caretOn: 'Welcome to the first recording',
    lastEndToken: 30,
    open: 'pointer',
    expects: [/^From beginning/, /^From here/, /^From last ending/, /Getting started/, /Second attempt/, /Practise/, /Review take setup/],
    window: true,
  },
  {
    name: 'full-keyboard',
    script: LESSON,
    viewport: NORMAL,
    mode: 'reader',
    caretOn: 'Welcome to the first recording',
    lastEndToken: 30,
    open: 'keyboard',
    expects: [/^From beginning/, /^From here/, /^From last ending/],
  },
  {
    name: 'full-hover-checked',
    script: LESSON,
    viewport: NORMAL,
    mode: 'prompter',
    caretOn: 'Welcome to the first recording',
    lastEndToken: 30,
    open: 'pointer',
    hover: /Teleprompter/,
    expects: [/^From beginning/, /^Teleprompter/],
  },
  {
    name: 'simple',
    script: NOTE,
    viewport: NORMAL,
    mode: 'prompter',
    open: 'pointer',
    expects: [/^From beginning/, /Practise/],
  },
  {
    name: 'many-parts',
    script: COURSE,
    viewport: NORMAL,
    mode: 'prompter',
    lastEndToken: 60,
    open: 'pointer',
    expects: [/^From beginning/, /Introduction/, /more parts not listed/],
    window: true,
  },
  {
    name: 'full-narrow-window',
    script: LESSON,
    viewport: NARROW,
    mode: 'reader',
    caretOn: 'Welcome to the first recording',
    lastEndToken: 30,
    open: 'pointer',
    expects: [/^From beginning/, /^From here/],
    window: true,
  },
];

/** Make the page report macOS before any app code reads `navigator`. */
async function pretendMac(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' });
    Object.defineProperty(Navigator.prototype, 'userAgentData', {
      get: () => ({ platform: 'macOS', brands: [], mobile: false }),
    });
  });
}

/**
 * The session history, as Rust would answer `list_sessions`.
 *
 * Registered after the shim, so its `__TAURI_INTERNALS__` is already there to
 * wrap. Only the one command is taken over.
 */
async function installHistory(page: Page, scriptId: string, endTokenIndex: number | undefined): Promise<void> {
  await page.addInitScript(
    (cfg: { scriptId: string; endTokenIndex: number | null }) => {
      const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
      const invoke = internals.invoke.bind(internals);
      internals.invoke = (command: string, args?: unknown) => {
        if (command === 'list_sessions' && cfg.endTokenIndex !== null) {
          return Promise.resolve([
            {
              id: 'session-design-0001',
              sessionGeneration: 3,
              scriptId: cfg.scriptId,
              scriptSourceHash: 'design',
              startedAt: '2026-10-17T09:00:00.000Z',
              endedAt: '2026-10-17T09:02:10.000Z',
              mode: 'voice',
              startTokenIndex: 0,
              endTokenIndex: cfg.endTokenIndex,
              durationMs: 130_000,
              softPauseMs: 0,
              commandCount: 0,
              retakeCount: 0,
              reconnectCount: 0,
              manualCorrectionCount: 0,
            },
          ]);
        }
        return invoke(command, args);
      };
    },
    { scriptId, endTokenIndex: endTokenIndex ?? null },
  );
}

function menu(page: Page): Locator {
  return page.getByRole('menu', { name: 'How to present' });
}

function trigger(page: Page): Locator {
  return page.getByRole('button', { name: 'How to present' });
}

async function openMenu(page: Page, scenario: Scenario): Promise<void> {
  await pretendMac(page);
  await page.setViewportSize(scenario.viewport);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [scenario.script],
    promptMode: 'voice',
    presentationMode: scenario.mode,
  });
  await installHistory(page, scenario.script.id, scenario.lastEndToken);
  await page.goto('/control.html');
  await openScript(page, scenario.script.title);
  const editor = page.getByRole('textbox', { name: 'Script Markdown' });
  await expect(editor).toBeVisible();
  await expect(page.locator('.panel-foot')).not.toContainText('Reading the script', { timeout: 15_000 });

  if (scenario.caretOn) {
    await page.locator('.cm-line', { hasText: scenario.caretOn }).click();
  }

  if (scenario.open === 'keyboard') {
    await trigger(page).focus();
    await page.keyboard.press('ArrowDown');
  } else {
    await trigger(page).click();
  }
  await expect(menu(page)).toBeVisible();

  if (scenario.hover) {
    await menu(page).locator('[role="menuitem"],[role="menuitemradio"]').filter({ hasText: scenario.hover }).first().hover();
  } else if (scenario.open === 'pointer') {
    // Park the pointer away from the menu, so no row is hovered.
    const size = page.viewportSize()!;
    await page.mouse.move(24, size.height - 24);
  }
}

/** Every row name the menu exposes, menuitem and menuitemradio alike. */
async function rowNames(page: Page): Promise<string[]> {
  return menu(page)
    .locator('[role="menuitem"],[role="menuitemradio"]')
    .evaluateAll((els) => els.map((el) => (el.textContent ?? '').trim().replace(/\s+/g, ' ')));
}

async function verify(page: Page, scenario: Scenario): Promise<void> {
  const names = await rowNames(page);
  for (const pattern of scenario.expects) {
    if (!names.some((n) => pattern.test(n))) {
      throw new Error(`${scenario.name}: no row matches ${pattern} — rows were ${JSON.stringify(names)}`);
    }
  }
}

async function capture(page: Page, scenario: Scenario): Promise<void> {
  if (!OUT) throw new Error('DESIGN_CAPTURE_DIR must be set to a directory outside the repo');
  await verify(page, scenario);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  await page.waitForTimeout(200);
  // After the settle, not before: a frame of the wrong state is worse than none.
  await verify(page, scenario);
  await expect(menu(page)).toBeVisible();

  mkdirSync(OUT, { recursive: true });
  const box = await menu(page).boundingBox();
  const anchor = await trigger(page).boundingBox();
  if (box === null || anchor === null) throw new Error(`${scenario.name}: the menu has no box — refusing to write`);
  const viewport = page.viewportSize()!;
  const margin = 24;
  // The menu and the button that opened it, with the destination readout to its left.
  const left = Math.max(0, Math.min(box.x, anchor.x - 160) - margin);
  const top = Math.max(0, anchor.y - margin);
  const right = Math.min(viewport.width, Math.max(box.x + box.width, anchor.x + anchor.width) + margin);
  const bottom = Math.min(viewport.height, box.y + box.height + margin);
  await page.screenshot({
    path: join(OUT, `${scenario.name}--menu.png`),
    clip: { x: left, y: top, width: right - left, height: bottom - top },
  });
  if (scenario.window) await page.screenshot({ path: join(OUT, `${scenario.name}--window.png`) });
}

test.use({ deviceScaleFactor: 2 });

test.describe('present menu', () => {
  for (const scenario of SCENARIOS) {
    test(scenario.name, async ({ page }) => {
      await openMenu(page, scenario);
      await capture(page, scenario);
    });
  }
});
