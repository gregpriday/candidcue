/**
 * The line beside Present says which shape it opens, at every window width (#412).
 *
 * The main click of Present opens whichever shape was last chosen from its
 * menu, which may have been days ago. Below a 1100px window the readout that
 * says so was hidden entirely, and the window's minimum is 980px, so across
 * that whole range the only way to know was to open the menu and look for the
 * tick. Above it, the readout's fixed slot squeezed the script's title instead:
 * with the default sidebar a 1101px window cut "Recording lesson" to 73px.
 *
 * Two rules from the issue are asserted at every width:
 *
 *   - the title and Present keep their room — the title is drawn whole and the
 *     split button sits inside the toolbar;
 *   - a readout is complete or absent, never clipped ("Telepr…" looks like a
 *     fault).
 *
 * And the point of the issue: at the widths a window can actually be with the
 * default workspace, the shape's own name is on screen beside the button.
 *
 * Geometry is measured in Chromium against the shim. Text widths differ by
 * platform font, so what this cannot prove is the margin on WKWebView, WebView2
 * or WebKitGTK; the tiers leave room for that rather than measure it.
 */
import { test, expect, type Page } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';
import { openScript } from './fixtures/library';

const SCRIPT = {
  id: '41241241-2412-4412-8412-412412412412',
  title: 'Recording lesson',
  source:
    '# Getting started\n\nWelcome to the first recording. This is a short script to practise with.\n\n' +
    '# Second attempt\n\nNow read it again, a little faster this time.\n',
};

const NOUN = { prompter: 'Teleprompter', reader: 'Reading window' } as const;
type Mode = keyof typeof NOUN;

const WORKSPACE_KEY = 'speaking-glass.workspace.v1';

/** Both ids the app may ask about: the catalogue id and the recogniser id. */
const MODEL_IDS = ['x-asr-480ms', 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05'];

function notInstalled(modelId: string): Record<string, unknown> {
  return {
    modelId,
    modelName: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05',
    languages: ['en', 'zh'],
    phase: 'notInstalled',
    source: null,
    installed: false,
    supported: true,
    downloadBytes: 133_895_136,
    installedBytes: 0,
    progressBytes: 0,
    progressTotal: 0,
  };
}

interface Boot {
  mode: Mode;
  width: number;
  workspace?: Record<string, unknown>;
  noModel?: boolean;
  failListDisplays?: boolean;
}

async function boot(page: Page, opts: Boot): Promise<void> {
  await page.setViewportSize({ width: opts.width, height: 700 });
  if (opts.workspace) {
    await page.addInitScript(
      ([key, value]) => window.localStorage.setItem(key, value),
      [WORKSPACE_KEY, JSON.stringify(opts.workspace)] as const,
    );
  }
  await installTauriShim(page, {
    welcomed: true,
    seedScripts: [SCRIPT],
    promptMode: 'voice',
    presentationMode: opts.mode,
    ...(opts.failListDisplays ? { failListDisplays: true } : {}),
    ...(opts.noModel
      ? { modelStatuses: Object.fromEntries(MODEL_IDS.map((id) => [id, notInstalled(id)])) }
      : {}),
  });
  await page.goto('/control.html');
  await openScript(page, SCRIPT.title);
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Present', exact: true })).toBeVisible();
}

/** One label beside Present, as drawn. */
interface Label {
  shown: boolean;
  text: string;
  /** Its text runs past its own box, or its box runs outside the slot. */
  cut: boolean;
  ariaHidden: string | null;
}

interface Readout {
  /** The toolbar's content box — what the container queries measure. */
  content: number;
  mode: Label;
  destination: Label;
  titleClient: number;
  titleScroll: number;
  splitRight: number;
  toolbarRight: number;
}

async function readout(page: Page): Promise<Readout> {
  // Two frames, so a container query reacting to the last resize has applied.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  return page.evaluate(() => {
    const status = document.querySelector('.present-status') as HTMLElement;
    const slot = status.getBoundingClientRect();
    const label = (el: HTMLElement | null) => {
      if (el === null) return { shown: false, text: '', cut: false, ariaHidden: null };
      const box = el.getBoundingClientRect();
      const shown = el.getClientRects().length > 0 && box.width > 0;
      return {
        shown,
        text: (el.textContent ?? '').trim(),
        cut:
          shown &&
          (el.scrollWidth > el.clientWidth + 1 || box.left < slot.left - 0.5 || box.right > slot.right + 0.5),
        ariaHidden: el.getAttribute('aria-hidden'),
      };
    };
    const toolbar = document.querySelector('header.toolbar') as HTMLElement;
    const style = getComputedStyle(toolbar);
    const title = document.querySelector('.title-input') as HTMLInputElement;
    const split = document.querySelector('.present-group > :last-child') as HTMLElement;
    return {
      content: toolbar.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      mode: label(status.querySelector<HTMLElement>('.present-mode')),
      destination: label(status.querySelector<HTMLElement>('.present-destination-text')),
      titleClient: title.clientWidth,
      titleScroll: title.scrollWidth,
      splitRight: split.getBoundingClientRect().right,
      toolbarRight: toolbar.getBoundingClientRect().right,
    };
  });
}

/**
 * The title's width with room to spare — the width every narrower bar has to
 * leave it, so a long title loses nothing more than it does on a wide window.
 */
async function naturalTitleWidth(page: Page): Promise<number> {
  const before = page.viewportSize()!;
  await page.setViewportSize({ width: 1800, height: before.height });
  const width = (await readout(page)).titleClient;
  await page.setViewportSize(before);
  return width;
}

function expectRoomKept(r: Readout, label: string, titleWidth?: number): void {
  expect(r.mode.cut, `${label}: the shape beside Present is clipped`).toBe(false);
  expect(r.destination.cut, `${label}: the destination beside Present is clipped`).toBe(false);
  expect(r.titleScroll, `${label}: the title is cut`).toBeLessThanOrEqual(r.titleClient + 1);
  expect(r.splitRight, `${label}: Present runs off the toolbar`).toBeLessThanOrEqual(r.toolbarRight + 0.5);
  if (titleWidth !== undefined) {
    expect(r.titleClient, `${label}: the title gave up room`).toBeGreaterThanOrEqual(titleWidth - 1);
  }
}

/** Exactly one of the two labels, by the tier the bar's width puts it in. */
function expectTier(r: Readout, mode: Mode, label: string): void {
  if (r.content >= 961) {
    expect(r.destination.shown, `${label} (${r.content}px bar): the whole line`).toBe(true);
    expect(r.destination.text.startsWith(`${NOUN[mode]} · `), `${label}: "${r.destination.text}"`).toBe(true);
    expect(r.mode.shown, `${label}: the shape is said twice`).toBe(false);
  } else if (r.content >= 704) {
    expect(r.mode.shown, `${label} (${r.content}px bar): the shape alone`).toBe(true);
    expect(r.mode.text, label).toBe(NOUN[mode]);
    expect(r.destination.shown, `${label}: the whole line in a short bar`).toBe(false);
  } else {
    expect(r.mode.shown || r.destination.shown, `${label} (${r.content}px bar): nothing fits`).toBe(false);
  }
}

/*
 * The default workspace: the sidebar drawn at its default width. 980 is the
 * window's minimum (tauri.conf.json); 1101..1220 is where the full readout used
 * to squeeze the title; 1400 is a roomy window, where the whole destination
 * line is expected.
 */
const WIDTHS = [980, 1040, 1100, 1101, 1160, 1220, 1400];

for (const mode of ['reader', 'prompter'] as const) {
  test(`${mode}: the shape is named beside Present at every width, without squeezing the title`, async ({
    page,
  }) => {
    await boot(page, { mode, width: WIDTHS[0]! });
    const titleWidth = await naturalTitleWidth(page);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 700 });
      const r = await readout(page);
      const label = `${mode} @ ${width}px`;
      expect(r.mode.shown || r.destination.shown, `${label}: nothing names the shape`).toBe(true);
      expectTier(r, mode, label);
      expectRoomKept(r, label, titleWidth);
      // Said once: the live region speaks the destination, so the short label
      // is not read a second time.
      expect(r.mode.ariaHidden, label).toBe('true');
    }
    expect((await readout(page)).destination.shown).toBe(true);
  });
}

test('each tier starts exactly where the bar can pay for it', async ({ page }) => {
  await boot(page, { mode: 'reader', width: 1100 });
  const r0 = await readout(page);
  const chrome = 1100 - r0.content;
  for (const content of [703, 704, 795, 796, 960, 961]) {
    await page.setViewportSize({ width: content + chrome, height: 700 });
    const r = await readout(page);
    expect(Math.round(r.content), 'the bar did not land on the edge').toBe(content);
    expectTier(r, 'reader', `edge ${content}px`);
    expectRoomKept(r, `edge ${content}px`);
  }
});

test('with the sidebar hidden the minimum window names the shape too', async ({ page }) => {
  await boot(page, { mode: 'reader', width: 980, workspace: { sidebarVisible: false } });
  await expect(page.getByRole('separator', { name: 'Sidebar width' })).toHaveCount(0);
  const titleWidth = await naturalTitleWidth(page);
  const r = await readout(page);
  expectTier(r, 'reader', 'no sidebar @ 980px');
  expect(r.mode.shown || r.destination.shown).toBe(true);
  expectRoomKept(r, 'no sidebar @ 980px', titleWidth);
});

test('a widest sidebar at the minimum window drops the readout whole rather than clip it', async ({ page }) => {
  await boot(page, { mode: 'reader', width: 980, workspace: { sidebarWidth: 360 } });
  await expect(page.getByRole('separator', { name: 'Sidebar width' })).toHaveAttribute('aria-valuenow', '360');
  const r = await readout(page);
  // Nothing rigid is left to pay for it here; complete or absent are the only
  // acceptable answers, and the bar still holds the title and Present.
  expectTier(r, 'reader', 'widest sidebar @ 980px');
  expectRoomKept(r, 'widest sidebar @ 980px');
});

test('the shape comes from the setting, before any display is known', async ({ page }) => {
  await boot(page, { mode: 'reader', width: 1040, failListDisplays: true });
  const r = await readout(page);
  expect(r.mode.shown).toBe(true);
  expect(r.mode.text).toBe(NOUN.reader);
  // Nothing else says it, so it is not hidden from a screen reader.
  expect(r.destination.shown).toBe(false);
  expect(r.mode.ariaHidden).toBeNull();
});

test('a failed save takes the readout away rather than the title its room', async ({ page }) => {
  await boot(page, { mode: 'reader', width: 1040 });
  expect((await readout(page)).mode.shown).toBe(true);
  await page.evaluate(
    (err) => window.__E2E__.setFail('save_script', err),
    { code: 'SCRIPT_SAVE_FAILED', userMessage: 'Speaking Glass could not write the script file.' },
  );
  await page.getByRole('textbox', { name: 'Script Markdown' }).click();
  await page.keyboard.type(' More words.');
  await expect(page.getByRole('button', { name: /Save failed/ })).toBeVisible({ timeout: 10_000 });
  for (const width of [1040, 1400]) {
    await page.setViewportSize({ width, height: 700 });
    const r = await readout(page);
    expect(r.mode.shown || r.destination.shown, `save failed @ ${width}px`).toBe(false);
    expect(r.splitRight).toBeLessThanOrEqual(r.toolbarRight + 0.5);
  }
});

test('the voice warning keeps its glyph and the shape is still named, in Preview at the minimum window', async ({
  page,
}) => {
  await boot(page, { mode: 'prompter', width: 980, noModel: true });
  await page.getByRole('radio', { name: 'Preview' }).click();
  await expect(page.getByRole('radio', { name: 'Preview' })).toHaveAttribute('aria-checked', 'true');
  const warning = page.getByRole('button', { name: /Set up voice following/ });
  await expect(warning).toBeVisible();
  const glyph = await warning.locator('svg').boundingBox();
  expect(glyph?.width).toBeGreaterThan(0);
  // The remedy's words are the button's name and tooltip, not drawn here.
  const words = await warning.locator('.present-voice-text').evaluate((el) => getComputedStyle(el).clip);
  expect(words).toBe('rect(0px, 0px, 0px, 0px)');
  const r = await readout(page);
  expectTier(r, 'prompter', 'voice warning, preview @ 980px');
  expect(r.mode.shown).toBe(true);
  // The live region says the warning instead, so the shape is plain text.
  expect(r.mode.ariaHidden).toBeNull();
  expectRoomKept(r, 'voice warning, preview @ 980px');
});
