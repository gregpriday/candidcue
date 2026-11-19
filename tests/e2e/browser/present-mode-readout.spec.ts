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
    ...(opts.noModel
      ? { modelStatuses: Object.fromEntries(MODEL_IDS.map((id) => [id, notInstalled(id)])) }
      : {}),
  });
  await page.goto('/control.html');
  await openScript(page, SCRIPT.title);
  await expect(page.getByRole('textbox', { name: 'Script Markdown' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Present', exact: true })).toBeVisible();
}

interface Readout {
  /** What the slot beside Present shows, as drawn (`innerText` skips hidden boxes). */
  text: string;
  /** Drawn boxes in the slot whose text is cut by their own box. */
  clipped: string[];
  titleClient: number;
  titleScroll: number;
  splitRight: number;
  toolbarRight: number;
  warningGlyph: boolean;
}

async function readout(page: Page): Promise<Readout> {
  // Two frames, so a container query reacting to the last resize has applied.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  return page.evaluate(() => {
    const status = document.querySelector('.present-status') as HTMLElement;
    const clipped = Array.from(status.querySelectorAll<HTMLElement>('*'))
      .filter((el) => el.getClientRects().length > 0 && el.clientWidth > 0)
      // Text collapsed on purpose for a screen reader is not a clipped readout.
      .filter((el) => getComputedStyle(el).clip !== 'rect(0px, 0px, 0px, 0px)')
      .filter((el) => el.scrollWidth > el.clientWidth + 1)
      .map((el) => `${el.className}: ${el.scrollWidth} > ${el.clientWidth}`);
    const title = document.querySelector('.title-input') as HTMLInputElement;
    const split = document.querySelector('.present-group > :last-child') as HTMLElement;
    const toolbar = document.querySelector('header.toolbar') as HTMLElement;
    const glyph = status.querySelector('.present-voice') as HTMLElement | null;
    return {
      text: status.innerText.trim(),
      clipped,
      titleClient: title.clientWidth,
      titleScroll: title.scrollWidth,
      splitRight: split.getBoundingClientRect().right,
      toolbarRight: toolbar.getBoundingClientRect().right,
      warningGlyph: glyph !== null && glyph.getClientRects().length > 0,
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
  expect(r.clipped, `${label}: a readout beside Present is clipped`).toEqual([]);
  expect(r.titleScroll, `${label}: the title is cut`).toBeLessThanOrEqual(r.titleClient + 1);
  if (titleWidth !== undefined) {
    expect(r.titleClient, `${label}: the title gave up room`).toBeGreaterThanOrEqual(titleWidth - 1);
  }
  expect(r.splitRight, `${label}: Present runs off the toolbar`).toBeLessThanOrEqual(r.toolbarRight + 0.5);
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
      expect(r.text.startsWith(NOUN[mode]), `${label}: "${r.text}" does not name the shape`).toBe(true);
      expectRoomKept(r, label, titleWidth);
    }
    // A roomy window still gets the whole destination, not just the shape.
    expect((await readout(page)).text).toContain('·');
  });
}

test('with the sidebar hidden the minimum window names the shape too', async ({ page }) => {
  await boot(page, { mode: 'reader', width: 980, workspace: { sidebarVisible: false } });
  const titleWidth = await naturalTitleWidth(page);
  const r = await readout(page);
  expect(r.text.startsWith(NOUN.reader), `"${r.text}"`).toBe(true);
  expectRoomKept(r, 'no sidebar @ 980px', titleWidth);
});

test('a widest sidebar at the minimum window drops the readout whole rather than clip it', async ({ page }) => {
  await boot(page, { mode: 'reader', width: 980, workspace: { sidebarWidth: 360 } });
  const r = await readout(page);
  // Nothing rigid is left to pay for it here; complete or absent are the only
  // acceptable answers.
  expect(r.text === '' || r.text === NOUN.reader, `"${r.text}"`).toBe(true);
  expect(r.clipped).toEqual([]);
});

test('the voice warning keeps its glyph and the shape is still named, in Preview at the minimum window', async ({
  page,
}) => {
  await boot(page, { mode: 'prompter', width: 980, noModel: true });
  await page.getByRole('radio', { name: 'Preview' }).click();
  await expect(page.getByRole('button', { name: /Set up voice following/ })).toBeVisible();
  const r = await readout(page);
  expect(r.warningGlyph).toBe(true);
  expect(r.text.endsWith(NOUN.prompter), `"${r.text}"`).toBe(true);
  expectRoomKept(r, 'voice warning, preview @ 980px');
});
