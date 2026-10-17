import { test, expect, devices, type Page } from '@playwright/test';
import { installTauriShim } from './fixtures/tauri-shim';
import { watchPageErrors } from './fixtures/page-errors';

/*
 * #281 — NOTHING ON THE GLASS RUNS PAST THE COLUMN.
 *
 * The script layer clips, so anything wider than the column used to lose its
 * end without a trace: a cue chip held to one line, a URL, a compound word. On
 * the 9-inch Elgato panel, about 19 characters across at the automatic size, a
 * cue past ~25 characters read "LOOK STRAIGHT AT CAMERA AND SMI", and under a
 * mirror the cut was on the left.
 *
 * This is the issue's own repro — its script, presented through the production
 * single-window path with the e2e shim in a 1024x600 window, mirrored and not —
 * plus a list item and a code block, the two block shapes that size their text
 * differently (a flex row, and `pre-wrap`). Every fragment of every word and
 * cue must lie inside the column. And the fix may only ever be drawn, never
 * counted: the long word still breaks inside ONE word span, carrying the token
 * index the aligner was given for it, on both sides of the mirror.
 *
 * SIZING, precisely: the shim presents onto its own 1920x1080 "Teleprompter
 * Display", which no automatic profile recognises, so the type is the flat
 * fallback under the default appearance — 64px in a 78% column, 799px of this
 * 1024px window, about 15 characters a line against the Elgato's ~19 under its
 * automatic profile. That is the geometry the issue measured (column 113..911),
 * and the narrower column is the harder case. Every long run below is wider
 * than its box at that size, list indent and code type included; an
 * appearance default that changed that would fail the multi-row checks
 * loudly, not pass them quietly.
 *
 * jsdom resolves no stylesheets and lays nothing out, so this can only be said
 * in a real engine. It is Chromium; WKWebView, which ships, is not driven here.
 */

const LONG_WORD = 'Pneumonoultramicroscopicsilicovolcanoconiosis';
const LONG_URL = 'candidcue.example.com/documentation/getting-started/installation-guide';
const LIST_WORD = 'Antidisestablishmentarianism';
const CODE_WORD = 'configurationRegistryFactoryProviderInstance';
const INLINE_CUE = 'look straight at camera and smile before continuing';
const BLOCK_CUE = 'hold up the product box and turn it slowly toward the lens';

const SCRIPT = {
  id: '28128128-1281-4281-8281-281281281281',
  title: 'Column overflow',
  source:
    `Hello and welcome to the show. [Cue: ${INLINE_CUE}] Today we talk about pricing.\n\n` +
    `[Cue: ${BLOCK_CUE}]\n\n` +
    `Go to ${LONG_URL} today. Then say ${LONG_WORD}.\n\n` +
    `- Remember ${LIST_WORD} forever.\n\n` +
    '```\n' +
    `const ${CODE_WORD} = createRegistry();\n` +
    '```\n',
};

/** Sub-pixel rounding between a fragment and the column it sits in. */
const TOLERANCE_PX = 1;

/*
 * The mirror shortcut answers the PAGE's primary modifier, so the page is made a
 * Mac and Cmd is pressed literally (see single-window-presentation.spec.ts).
 */
const MAC_CHROME_USER_AGENT = devices['Desktop Chrome'].userAgent.replace(
  'Windows NT 10.0; Win64; x64',
  'Macintosh; Intel Mac OS X 10_15_7',
);

test.use({ userAgent: MAC_CHROME_USER_AGENT });

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
    // The code block has to be on the glass as code for its `pre-wrap` run to
    // be measured, and only Diagnostic Take draws reference blocks in full —
    // Clean Take, the default since #300, shows it as a DEMO CODE cue.
    diagnosticTake: true,
  });
  // The Elgato Prompter's own geometry: the panel this was found on.
  await page.setViewportSize({ width: 1024, height: 600 });
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
  await expect(page.locator('.stage-root .column')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

interface Piece {
  kind: 'word' | 'cue';
  text: string;
  token: string | null;
  /** One rect per line fragment, in viewport space. */
  rects: { left: number; right: number; top: number }[];
}

interface Glass {
  column: { left: number; right: number };
  pieces: Piece[];
}

/**
 * Every word and cue in the column, fragment by fragment — unspoken words (the
 * code block) included, because the glass clips them exactly the same.
 */
async function glass(page: Page): Promise<Glass> {
  return page.evaluate(() => {
    const column = document.querySelector<HTMLElement>('.stage-root .column');
    if (!column) throw new Error('no stage column');
    const c = column.getBoundingClientRect();
    const pieces = Array.from(
      column.querySelectorAll<HTMLElement>('.w, .cue[data-cue-type]'),
    ).map((el) => ({
      kind: el.classList.contains('cue') ? ('cue' as const) : ('word' as const),
      text: el.textContent ?? '',
      token: el.getAttribute('data-t'),
      rects: Array.from(el.getClientRects())
        .filter((r) => r.width > 0 && r.height > 0)
        .map((r) => ({ left: r.left, right: r.right, top: r.top })),
    }));
    return { column: { left: c.left, right: c.right }, pieces };
  });
}

/** Distinct rows a piece is drawn on. */
function rows(piece: Piece): number {
  return new Set(piece.rects.map((r) => Math.round(r.top))).size;
}

/** Every fragment that lies outside the column, described for the failure. */
function escapes(g: Glass): string[] {
  const out: string[] = [];
  for (const piece of g.pieces) {
    for (const r of piece.rects) {
      if (r.left < g.column.left - TOLERANCE_PX || r.right > g.column.right + TOLERANCE_PX) {
        out.push(
          `${piece.kind} "${piece.text}" spans ${Math.round(r.left)}..${Math.round(r.right)} ` +
            `in a column of ${Math.round(g.column.left)}..${Math.round(g.column.right)}`,
        );
      }
    }
  }
  return out;
}

function only(g: Glass, kind: Piece['kind'], text: string): Piece {
  const found = g.pieces.filter((p) => p.kind === kind && p.text.includes(text));
  expect(found, `exactly one ${kind} containing "${text}"`).toHaveLength(1);
  return found[0]!;
}

/** The claims that must hold on either side of the mirror. */
function expectContained(g: Glass): void {
  // The fixture is what it claims to be before anything is asserted about it:
  // both cues and every long run are on the glass, and every piece is laid out
  // — a piece with no box would pass the containment check by being nowhere.
  expect(g.pieces.filter((p) => p.kind === 'cue')).toHaveLength(2);
  const unlaid = g.pieces.filter((p) => p.rects.length === 0).map((p) => p.text);
  expect(unlaid, 'every word and cue is drawn somewhere').toEqual([]);

  expect(escapes(g), 'everything on the glass stays inside the column').toEqual([]);

  // A long cue wraps onto more lines, whole: the label is not cut short.
  for (const label of [INLINE_CUE, BLOCK_CUE]) {
    const cue = only(g, 'cue', label);
    expect(cue.text).toBe(label);
    expect(rows(cue), `"${label}" wraps rather than running off`).toBeGreaterThan(1);
  }

  // A run too wide for the column breaks — inside its ONE span, whole.
  expect(only(g, 'word', LONG_URL).text).toBe(LONG_URL);
  for (const run of [LONG_WORD, LONG_URL, LIST_WORD, CODE_WORD]) {
    expect(rows(only(g, 'word', run)), `"${run}" breaks across rows`).toBeGreaterThan(1);
  }
  expect(only(g, 'word', LONG_WORD).token, 'the long word is still a token').not.toBeNull();
}

/** Where the aligner was told each spoken token is: `start_alignment`'s surfaces. */
async function alignedSurfaces(page: Page): Promise<string[]> {
  await expect
    .poll(() => page.evaluate(() => window.__E2E__.lastCall('start_alignment') !== null))
    .toBe(true);
  return page.evaluate(() => {
    const call = window.__E2E__.lastCall('start_alignment');
    const tokens = (call?.args as { tokens?: { surface: string }[] } | null)?.tokens ?? [];
    return tokens.map((token) => token.surface);
  });
}

test('long cues, a URL and an over-wide word stay inside the column, mirrored or not', async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await present(page);
  await expect(page.locator('html'), 'the page must identify as macOS').toHaveAttribute(
    'data-platform',
    'macos',
  );

  const plane = page.locator('.stage-talent-plane');
  await expect(plane).toHaveAttribute('data-mirror-x', 'false');
  const plain = await glass(page);
  expectContained(plain);
  const tokens = plain.pieces.filter((p) => p.kind === 'word').map((p) => p.token);

  // The broken word's span carries the index of the ONE token the aligner was
  // given for it: the break is drawn inside a token, not between two.
  const surfaces = await alignedSurfaces(page);
  const matches = surfaces.flatMap((s, i) => (s.toLowerCase().includes('pneumono') ? [i] : []));
  expect(matches, 'the aligner sees the long word as one token').toHaveLength(1);
  expect(only(plain, 'word', LONG_WORD).token).toBe(String(matches[0]));

  // Under a mirror the cut used to be on the LEFT. The column is flipped with
  // the text inside it, so the claim is the same one in viewport space.
  await page.keyboard.press('Meta+Shift+M');
  await expect(plane).toHaveAttribute('data-mirror-x', 'true');
  await expect.poll(async () => escapes(await glass(page))).toEqual([]);
  const mirrored = await glass(page);
  expectContained(mirrored);

  // The break is drawn, never counted: the same word spans, the same tokens.
  expect(mirrored.pieces.filter((p) => p.kind === 'word').map((p) => p.token)).toEqual(tokens);

  errors.expectClean();
});
