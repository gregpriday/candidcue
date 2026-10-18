/**
 * Paper, for reading windows — and never for glass.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PINS
 * ---------------------------------------------------------------------------
 * 1. Composition. `teleprompter.readerTheme` reaches a READING WINDOW's
 *    `StageSettings` as `themeId: 'reader-paper'`, with the paper field and
 *    ink written honestly and the past text floored at a value that still
 *    reads on a light field. A prompter is composed exactly as it was, black,
 *    whatever is stored — and so is a reading window with no choice made, or
 *    with a value this build does not recognise.
 *
 * 2. Contrast, as composed. The paper block is not a colour swap: the same
 *    alpha does not give the same contrast with dark ink on a light field. So
 *    the values are read OUT OF THE STYLESHEETS, laid together with the
 *    opacities `buildStageSettings` actually writes, and every reading state
 *    (each intensity: unread, upcoming, each ramp step, the far past, and the
 *    far past under the Wash band and on the phrase underlay, stage
 *    directions, and an authored cue on its own chip) is held at 4.5:1. A
 *    tiny WCAG helper does the arithmetic; nothing here trusts a number
 *    written in a comment.
 *
 * 3. Dark is unchanged. The dark token block keeps its literals, and every
 *    colour that became a role keeps its old literal as the `var()` fallback,
 *    with no dark declaration that could shadow it.
 *
 * 4. Settings reaches a read in progress, and a change there replaces the
 *    sheet's take-local choice, the way a slider moved in Settings does.
 *
 * jsdom resolves no stylesheets, so the rendered colours themselves are the
 * Playwright spec's to assert (`reader-paper-theme.spec.ts`).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import {
  PAPER_FIELD_BACKGROUND,
  PAPER_FIELD_FOREGROUND,
  PAPER_PAST_OPACITY,
  READER_PAPER_THEME_ID,
  STAGE_DARK_THEME_ID,
  buildStageEnvelope,
  buildStageSettings,
  readerThemeOfStage,
  stagePreviewSettingsFromSettings,
  stageSettingsFromSettings,
} from '../../../src/control/services/stage-envelope';
import {
  defaultAppSettings,
  readerThemeFor,
  type AppSettings,
} from '../../../src/control/services/settings-types';
import {
  adoptPresentationMode,
  applyReaderTheme,
  clearSession,
  installLiveSettingsFollow,
  session,
  startLiveSession,
  suspendReaderPaper,
  takeReaderThemeSetting,
} from '../../../src/control/stores/session';
import { patchSettings, settings } from '../../../src/control/stores/settings';
import { defaultOpticalProfile, type CompiledScript } from '../../../src/shared/contracts';
import type { DisplayDescriptor } from '../../../src/control/services/stage-types';

/* ---------------------------------------------------------------------------
 * Fixtures
 * ------------------------------------------------------------------------- */

/** A 16" MacBook Pro at default scaling — a desk, where reading windows live. */
const DESK: DisplayDescriptor = {
  id: 'display-1',
  name: 'Built-in Retina Display',
  primary: true,
  physicalPosition: { x: 0, y: 0 },
  physicalSize: { width: 3456, height: 2234 },
  logicalSize: { width: 1728, height: 1117 },
  scaleFactor: 2,
  fingerprint: 'panel-desk',
  topologyHash: 'topology-1',
};

function settingsFor(
  mode: 'prompter' | 'reader',
  teleprompter: Partial<AppSettings['teleprompter']> & Record<string, unknown> = {},
): AppSettings {
  const base = defaultAppSettings();
  return {
    ...base,
    stage: { ...base.stage, presentationMode: mode },
    teleprompter: { ...base.teleprompter, ...teleprompter } as AppSettings['teleprompter'],
  };
}

/* ---------------------------------------------------------------------------
 * A WCAG 2.x contrast helper — sRGB, alpha composed in gamma space the way a
 * browser composites a translucent colour or an `opacity` over its field.
 * ------------------------------------------------------------------------- */

type Rgba = [number, number, number, number];
type Rgb = [number, number, number];

function parseColour(text: string): Rgba {
  const value = text.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const h = hex[1]!;
    return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)).concat(1) as Rgba;
  }
  const comma = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(
    value,
  );
  if (comma) {
    return [Number(comma[1]), Number(comma[2]), Number(comma[3]), Number(comma[4] ?? 1)];
  }
  const space = /^rgba?\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)(%?)\s*)?\)$/.exec(
    value,
  );
  if (space) {
    const alpha = space[4] === undefined ? 1 : Number(space[4]) / (space[5] ? 100 : 1);
    return [Number(space[1]), Number(space[2]), Number(space[3]), alpha];
  }
  throw new Error(`unparseable colour: ${text}`);
}

/** `fg` at `alpha` over an opaque `bg`. */
function over(fg: Rgb | Rgba, bg: Rgb, alpha = fg.length === 4 ? fg[3] : 1): Rgb {
  return [0, 1, 2].map((i) => alpha * fg[i]! + (1 - alpha) * bg[i]!) as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const rgb = (text: string): Rgb => over(parseColour(text), [0, 0, 0], 1);

/* ---------------------------------------------------------------------------
 * The stylesheets, read as text
 * ------------------------------------------------------------------------- */

const source = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');

const STAGE_APP = source('src/stage/StageApp.svelte');
const STAGE_CSS = source('src/styles/stage.css');

/** The custom properties a rule declares, by exact selector. */
function tokensOf(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  expect(start, `no "${selector}" rule`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const body = css.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, '');
  const tokens: Record<string, string> = {};
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    tokens[match[1]!] = match[2]!.replace(/\s+/g, ' ').trim();
  }
  return tokens;
}

const PAPER = ".stage-root[data-theme='reader-paper']";
const paper = tokensOf(STAGE_APP, PAPER);
const paperSoft = tokensOf(STAGE_APP, `${PAPER}[data-text-intensity='soft']`);
const paperStrong = tokensOf(STAGE_APP, `${PAPER}[data-text-intensity='strong']`);

/* ---------------------------------------------------------------------------
 * 1. Composition
 * ------------------------------------------------------------------------- */

describe('composing a reading window on paper', () => {
  it('writes the paper theme, field and ink for a reading window that asked for it', () => {
    const composed = stageSettingsFromSettings(settingsFor('reader', { readerTheme: 'paper' }), DESK);
    expect(composed.themeId).toBe(READER_PAPER_THEME_ID);
    expect(composed.background).toBe(PAPER_FIELD_BACKGROUND);
    expect(composed.foreground).toBe(PAPER_FIELD_FOREGROUND);
    expect(composed.readingContext).toBe('reader');
    expect(readerThemeOfStage(composed)).toBe('paper');
  });

  it('floors the past text, because the dark field’s alpha fails on paper', () => {
    const dark = stageSettingsFromSettings(settingsFor('reader'), DESK);
    const onPaper = stageSettingsFromSettings(settingsFor('reader', { readerTheme: 'paper' }), DESK);
    // The dark reading window keeps the resolver's value, unraised.
    expect(dark.pastOpacity).toBeLessThan(PAPER_PAST_OPACITY);
    expect(onPaper.pastOpacity).toBe(PAPER_PAST_OPACITY);
    // Nothing else about the read moves with the field.
    const { themeId: _a, background: _b, foreground: _c, pastOpacity: _d, ...rest } = onPaper;
    const { themeId: _e, background: _f, foreground: _g, pastOpacity: _h, ...darkRest } = dark;
    expect(rest).toEqual(darkRest);
  });

  it('floors an uncalibrated reading window too', () => {
    // No display: no optics, the 0.42 uncalibrated past.
    const composed = stageSettingsFromSettings(settingsFor('reader', { readerTheme: 'paper' }));
    expect(composed.optics).toBeUndefined();
    expect(composed.themeId).toBe(READER_PAPER_THEME_ID);
    expect(composed.pastOpacity).toBe(PAPER_PAST_OPACITY);
  });

  it('keeps a lighter dim a rig asked for — the floor is a floor', () => {
    const lighter = buildStageSettings({
      readingContext: 'reader',
      readerTheme: 'paper',
      optical: {
        profile: { ...defaultOpticalProfile(), overrides: { pastOpacity: 0.85 } },
        viewport: { widthPx: 1440, heightPx: 900 },
      },
    });
    expect(lighter.pastOpacity).toBe(0.85);
  });

  it('leaves "past-text dimming off" exactly as it is written', () => {
    const composed = stageSettingsFromSettings(
      settingsFor('reader', { readerTheme: 'paper', pastDimming: false }),
      DESK,
    );
    expect(composed.pastOpacity).toBe(0.92);
  });

  it('never composes a prompter on paper, whatever is stored', () => {
    const plain = stageSettingsFromSettings(settingsFor('prompter'), DESK);
    const asked = stageSettingsFromSettings(settingsFor('prompter', { readerTheme: 'paper' }), DESK);
    expect(asked).toEqual(plain);
    expect(asked.themeId).toBe(STAGE_DARK_THEME_ID);
    expect(asked.background).toBe('#000000');
    expect(asked.foreground).toBe('#f5f3ef');
    expect(readerThemeOfStage(asked)).toBe('dark');
    // And not by a direct caller either: the theme needs a reader context.
    expect(buildStageSettings({ readerTheme: 'paper' }).themeId).toBe(STAGE_DARK_THEME_ID);
  });

  it('draws a reading window dark when nothing, or nothing it knows, was chosen', () => {
    const absent = stageSettingsFromSettings(settingsFor('reader'), DESK);
    expect(absent.themeId).toBe(STAGE_DARK_THEME_ID);
    expect(absent.background).toBe('#000000');
    for (const stored of ['dark', 'sepia', 'PAPER', 1, null, true]) {
      const composed = stageSettingsFromSettings(
        settingsFor('reader', { readerTheme: stored as never }),
        DESK,
      );
      expect(composed, `stored ${JSON.stringify(stored)}`).toEqual(absent);
    }
  });

  it('reads only a stored "paper" as paper', () => {
    expect(readerThemeFor({ readerTheme: 'paper' })).toBe('paper');
    expect(readerThemeFor({})).toBe('dark');
    expect(readerThemeFor(null)).toBe('dark');
    expect(readerThemeFor({ readerTheme: 'Paper' })).toBe('dark');
  });

  it('previews on the stage display in black, even for a paper reading window', () => {
    // Settings' preview is a stage window FILLING the chosen display — glass.
    const asked = settingsFor('reader', { readerTheme: 'paper' });
    const preview = stagePreviewSettingsFromSettings(asked, DESK);
    expect(preview.themeId).toBe(STAGE_DARK_THEME_ID);
    expect(preview.background).toBe('#000000');
    // Everything else is the take's own composition.
    expect(preview).toEqual(stageSettingsFromSettings(settingsFor('reader'), DESK));
    expect(stagePreviewSettingsFromSettings(settingsFor('prompter'), DESK)).toEqual(
      stageSettingsFromSettings(settingsFor('prompter'), DESK),
    );
  });

  it('is not a default, so a whole-section save cannot freeze one in', () => {
    // See the note on `teleprompter.readerTheme`: absent must mean dark.
    expect('readerTheme' in defaultAppSettings().teleprompter).toBe(false);
  });

});

/* ---------------------------------------------------------------------------
 * 2. Contrast, as composed
 * ------------------------------------------------------------------------- */

describe('every reading state on paper clears 4.5:1', () => {
  const field = rgb(paper['--stage-bg']!);
  const inks = {
    standard: paper['--stage-text']!,
    soft: paperSoft['--stage-text']!,
    strong: paperStrong['--stage-text']!,
  };
  const steps = ['--stage-dim-1', '--stage-dim-2', '--stage-dim-3'].map((name) =>
    Number(paper[name]),
  );
  const wash = parseColour(paper['--stage-wash']!);

  /** The opacities a paper read is actually composed with, both paths. */
  const composedPaths = {
    calibrated: stageSettingsFromSettings(settingsFor('reader', { readerTheme: 'paper' }), DESK),
    uncalibrated: stageSettingsFromSettings(settingsFor('reader', { readerTheme: 'paper' })),
  };

  it('agrees with the envelope about the field and the ink', () => {
    expect(paper['--stage-bg']).toBe(PAPER_FIELD_BACKGROUND);
    expect(paper['--stage-text']).toBe(PAPER_FIELD_FOREGROUND);
  });

  it('declares opaque inks, so intensity never stacks with a dim', () => {
    for (const [name, ink] of Object.entries(inks)) {
      expect(parseColour(ink)[3], name).toBe(1);
    }
  });

  for (const [path, composed] of Object.entries(composedPaths)) {
    for (const [intensity, ink] of Object.entries(inks)) {
      it(`${intensity} ink, ${path}: unread, upcoming, every ramp step, the far past`, () => {
        const text = rgb(ink);
        const past = composed.pastOpacity;
        const states: Record<string, number> = {
          unread: 1,
          upcoming: composed.futureOpacity,
          // `InlineNodes`: each step is floored at the past opacity.
          ...Object.fromEntries(steps.map((s, i) => [`ramp ${i + 1}`, Math.max(past, s)])),
          'far past': past,
        };
        for (const [state, alpha] of Object.entries(states)) {
          const ratio = contrast(over(text, field, alpha), field);
          expect(ratio, `${state} at ${alpha}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
        }
      });

      it(`${intensity} ink, ${path}: the far past under the Wash band`, () => {
        // The band is drawn OVER the line being read, so it lands on both.
        const band = over(wash, field);
        const text = over(wash, over(rgb(ink), field, composed.pastOpacity));
        expect(contrast(text, band)).toBeGreaterThanOrEqual(4.5);
      });

      it(`${intensity} ink, ${path}: the far past on the phrase underlay`, () => {
        // Drawn BEHIND the column, at the element's own opacity.
        const accent = parseColour(paper['--stage-accent']!);
        const underlay = over(accent, field, accent[3] * composed.currentUnderlayOpacity);
        const text = over(rgb(ink), underlay, composed.pastOpacity);
        expect(contrast(text, underlay)).toBeGreaterThanOrEqual(4.5);
      });

      it(`${intensity} ink: stage directions, which the renderer draws at a flat opacity`, () => {
        // `.unspoken` replaces the block's zoning with its own opacity, which
        // the paper field lifts from the dark field's 0.45.
        const alpha = Number(paper['--stage-unspoken-opacity']);
        expect(STAGE_APP).toContain(
          ".stage-root[data-theme='reader-paper'] :global(.unspoken) {\n    opacity: var(--stage-unspoken-opacity",
        );
        expect(contrast(over(rgb(ink), field, alpha), field)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it('keeps the four-word ramp graded above the floor rather than collapsed onto it', () => {
    const past = composedPaths.calibrated.pastOpacity;
    expect(steps[0]!).toBeGreaterThan(steps[1]!);
    expect(steps[1]!).toBeGreaterThan(steps[2]!);
    expect(steps[2]!).toBeGreaterThan(past);
  });

  it('reads the authored cue, unread and upcoming, on its own chip', () => {
    const cue = rgb(paper['--stage-cue']!);
    const future = composedPaths.calibrated.futureOpacity;
    // The inline cue chip (12%) and the take marker (14%) are washes of the
    // cue's own colour behind it, and the whole block is zoned over both.
    for (const mix of [0.12, 0.14]) {
      for (const zone of [1, future]) {
        const chip = over(over(cue, field, mix), field, zone);
        const text = over(cue, field, zone);
        const ratio = contrast(text, chip);
        expect(ratio, `${mix} chip at ${zone}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('reads the chrome: dock text, the menu, the end confirmation, the plate', () => {
    const chrome = over(parseColour(paper['--stage-chrome-bg']!), field);
    const popover = over(parseColour(paper['--stage-chrome-popover-bg']!), field);
    const on = (fg: string, bg: Rgb) => contrast(over(parseColour(fg), bg), bg);
    expect(on(paper['--stage-chrome-text']!, chrome)).toBeGreaterThanOrEqual(4.5);
    expect(on(paper['--stage-chrome-text-strong']!, popover)).toBeGreaterThanOrEqual(4.5);
    expect(on(paper['--stage-chrome-text-muted']!, popover)).toBeGreaterThanOrEqual(4.5);
    expect(on(paper['--stage-text-past']!, field)).toBeGreaterThanOrEqual(4.5);
    expect(on(paper['--stage-text-past']!, chrome)).toBeGreaterThanOrEqual(4.5);
    const danger = over(parseColour(paper['--stage-danger-strong-bg']!), popover);
    expect(on(paper['--stage-danger-text']!, danger)).toBeGreaterThanOrEqual(4.5);
    expect(on(paper['--stage-diag-fault']!, chrome)).toBeGreaterThanOrEqual(4.5);
    // Icons and state marks: the 3:1 non-text floor.
    for (const icon of ['--stage-dock-icon', '--stage-dock-end', '--stage-chrome-text-faint']) {
      expect(on(paper[icon]!, chrome), icon).toBeGreaterThanOrEqual(3);
    }
    expect(on(paper['--stage-flag']!, chrome)).toBeGreaterThanOrEqual(4.5);
    expect(on(paper['--stage-danger']!, chrome)).toBeGreaterThanOrEqual(4.5);
    // The voice pill's mark is the field cut out of an ink or cue disc.
    const ink = rgb(paper['--stage-mark-ink']!);
    expect(contrast(ink, rgb(paper['--stage-text']!))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(ink, rgb(paper['--stage-cue']!))).toBeGreaterThanOrEqual(4.5);
  });
});

/* ---------------------------------------------------------------------------
 * 3. The two stylesheets agree, and Dark is what it was
 * ------------------------------------------------------------------------- */

describe('the stage window and the embedded stage draw the same paper', () => {
  it('mirrors every paper token, intensity variants included', () => {
    expect(tokensOf(STAGE_CSS, PAPER)).toEqual(paper);
    expect(tokensOf(STAGE_CSS, `${PAPER}[data-text-intensity='soft']`)).toEqual(paperSoft);
    expect(tokensOf(STAGE_CSS, `${PAPER}[data-text-intensity='strong']`)).toEqual(paperStrong);
  });

  it('paints the presentation canvas and the preparing plate in the same paper', () => {
    const canvas = source('src/styles/tokens.css');
    expect(canvas).toContain(
      "html[data-presenting='true'][data-presenting-theme='reader-paper'] body {\n  background: #f6f2ea;",
    );
    const live = source('src/control/routes/Live.svelte');
    expect(live).toMatch(/\.stage-preparing\.paper \{\s*background: #f6f2ea;/);
    expect(PAPER_FIELD_BACKGROUND).toBe('#f6f2ea');
  });

  it('keys the stage theme on the same id control writes', () => {
    expect(STAGE_APP).toContain(`settings.themeId === '${READER_PAPER_THEME_ID}'`);
    expect(STAGE_APP).toContain(`data-theme={stageTheme}`);
  });
});

describe('a dark stage is exactly the stage it was', () => {
  const DARK_ROOT = {
    '--stage-bg': '#000000',
    '--stage-text': '#f5f3ef',
    '--stage-text-past': 'rgba(245, 243, 239, 0.42)',
    '--stage-text-future': 'rgba(245, 243, 239, 0.86)',
    '--stage-accent': 'rgba(210, 205, 255, 0.2)',
    '--stage-cue': '#d8b46a',
    '--stage-overlay': 'rgb(14 16 20)',
    '--stage-chrome-border': 'rgba(255, 255, 255, 0.13)',
    '--stage-chrome-bg': 'rgba(12, 14, 18, 0.74)',
    '--stage-chrome-text': 'rgba(245, 243, 239, 0.88)',
    '--stage-dim-1': '0.78',
    '--stage-dim-2': '0.64',
    '--stage-dim-3': '0.52',
  };

  it('keeps every dark token’s value in both stylesheets', () => {
    const embedded = tokensOf(STAGE_APP, '.stage-root');
    const window = tokensOf(STAGE_CSS, ':root');
    for (const [name, value] of Object.entries(DARK_ROOT)) {
      expect(embedded[name], `StageApp ${name}`).toBe(value);
      expect(window[name], `stage.css ${name}`).toBe(value);
    }
  });

  /*
   * Every colour that became a role, with the literal it used to be. The role
   * is used with that literal as its fallback and has no dark declaration, so
   * a dark stage resolves to exactly the old colour.
   */
  const FALLBACKS: Array<[file: string, role: string, literal: string]> = [
    ['src/stage/renderer/ReadingCue.svelte', '--stage-wash-clear', 'rgb(245 243 239 / 0%)'],
    ['src/stage/renderer/ReadingCue.svelte', '--stage-wash', 'rgb(245 243 239 / 6%)'],
    ['src/stage/renderer/ReadingCue.svelte', '--stage-reading-mark-opacity', '0.5'],
    ['src/stage/VoicePill.svelte', '--stage-mark-ink', '#000'],
    ['src/stage/VoicePill.svelte', '--stage-chrome-bg-solid', 'rgb(12 14 18 / 92%)'],
    ['src/stage/StageApp.svelte', '--stage-diag-fault', '#ffb4a2'],
    ['src/stage/StageDock.svelte', '--stage-dock-icon', 'rgb(245 243 239 / 72%)'],
    ['src/stage/StageDock.svelte', '--stage-dock-end', 'rgb(245 243 239 / 58%)'],
    ['src/stage/StageDock.svelte', '--stage-flag', '#e8b661'],
    ['src/stage/StageDock.svelte', '--stage-flag-hover', '#f2c97e'],
    ['src/stage/StageDock.svelte', '--stage-flag-bg', 'rgb(232 182 97 / 12%)'],
    ['src/stage/StageDock.svelte', '--stage-flag-bg-hover', 'rgb(232 182 97 / 18%)'],
    ['src/stage/StageDock.svelte', '--stage-flag-border', 'rgb(232 182 97 / 38%)'],
    ['src/stage/StageDock.svelte', '--stage-flag-border-hover', 'rgb(232 182 97 / 52%)'],
    ['src/stage/StageDock.svelte', '--stage-flag-ring', 'rgb(12 14 18 / 92%)'],
    ['src/stage/StageDock.svelte', '--stage-chrome-bg-hover', 'rgb(24 28 35 / 88%)'],
    ['src/stage/StageDock.svelte', '--stage-chrome-border-hover', 'rgb(255 255 255 / 30%)'],
    ['src/stage/StageDock.svelte', '--stage-chrome-text-hover', '#fff'],
    ['src/stage/StageDock.svelte', '--stage-danger', '#ef7168'],
    ['src/stage/StageDock.svelte', '--stage-danger-bg', 'rgb(239 113 104 / 12%)'],
    ['src/stage/StageDock.svelte', '--stage-danger-border', 'rgb(239 113 104 / 38%)'],
    ['src/stage/StageDock.svelte', '--stage-focus-ring', 'rgb(245 243 239 / 70%)'],
    ['src/stage/StageDock.svelte', '--stage-chrome-popover-bg', 'rgb(12 14 18 / 90%)'],
    ['src/stage/StageDock.svelte', '--stage-chrome-popover-bg-solid', 'rgb(12 14 18 / 96%)'],
    ['src/stage/StageDock.svelte', '--stage-chrome-bg-solid', 'rgb(12 14 18 / 92%)'],
    ['src/stage/StageDock.svelte', '--stage-chrome-text-strong', '#f5f3ef'],
    ['src/stage/StageDock.svelte', '--stage-chrome-highlight', 'rgb(255 255 255 / 12%)'],
    ['src/stage/StageDock.svelte', '--stage-chrome-text-faint', 'rgb(245 243 239 / 52%)'],
    ['src/stage/StageDock.svelte', '--stage-chrome-text-muted', 'rgb(245 243 239 / 62%)'],
    ['src/stage/StageDock.svelte', '--stage-chrome-control-border', 'rgb(255 255 255 / 18%)'],
    ['src/stage/StageDock.svelte', '--stage-chrome-control-hover', 'rgb(255 255 255 / 10%)'],
    ['src/stage/StageDock.svelte', '--stage-danger-strong-border', 'rgb(239 113 104 / 55%)'],
    ['src/stage/StageDock.svelte', '--stage-danger-strong-bg', 'rgb(239 113 104 / 18%)'],
    ['src/stage/StageDock.svelte', '--stage-danger-strong-bg-hover', 'rgb(239 113 104 / 30%)'],
    ['src/stage/StageDock.svelte', '--stage-danger-text', '#ffb4a2'],
    ['src/stage/StageDock.svelte', '--stage-danger-text-hover', '#fff'],
  ];

  it('uses each new role with its old literal as the fallback', () => {
    for (const [file, role, literal] of FALLBACKS) {
      expect(source(file), `${file}: ${role}`).toContain(`var(${role}, ${literal})`);
    }
  });

  it('never declares a fallback-only role for the dark field, so nothing shadows it', () => {
    const embedded = tokensOf(STAGE_APP, '.stage-root');
    const window = tokensOf(STAGE_CSS, ':root');
    for (const [, role] of FALLBACKS) {
      expect(embedded[role], `StageApp declares ${role}`).toBeUndefined();
      expect(window[role], `stage.css declares ${role}`).toBeUndefined();
      // …and paper does, or the role would be dark on paper.
      expect(paper[role], `paper is missing ${role}`).toBeDefined();
    }
  });

  it('leaves the dock, the pill and the cue no colour literal outside a fallback', () => {
    for (const file of [
      'src/stage/StageDock.svelte',
      'src/stage/VoicePill.svelte',
      'src/stage/renderer/ReadingCue.svelte',
    ]) {
      const style = source(file).split('<style>')[1]!.replace(/\/\*[\s\S]*?\*\//g, '');
      const bare = style
        .split('\n')
        .filter((line) => /#[0-9a-f]{3,8}\b|rgba?\(/i.test(line) && !line.includes('var(--'));
      expect(bare, file).toEqual([]);
    }
  });
});

/* ---------------------------------------------------------------------------
 * 4. Settings reaches a read in progress
 * ------------------------------------------------------------------------- */

describe('a theme chosen in Settings during a read', () => {
  const SCRIPT = {
    scriptId: 'script-1',
    sourceHash: 'hash-1',
    title: 'Launch video',
    blocks: [],
    cues: [],
    outline: [],
    sentences: [],
    spokenTokens: [],
    assets: [],
    navigationTargets: [],
    diagnostics: [],
  } as unknown as CompiledScript;

  let teardown: (() => void) | null = null;

  afterEach(async () => {
    teardown?.();
    teardown = null;
    clearSession();
    await patchSettings('teleprompter', { readerTheme: 'dark' });
  });

  function startReading(): void {
    const current = get(settings);
    const opening = stageSettingsFromSettings(
      { ...current, stage: { ...current.stage, presentationMode: 'reader' } },
      DESK,
    );
    startLiveSession({
      scriptId: 'script-1',
      scriptTitle: 'Launch video',
      mode: 'manual',
      displayLabel: 'This window',
      outline: [],
      sentences: [],
      totalTokens: 200,
      stageSettings: opening,
      stageEnvelope: buildStageEnvelope({
        script: SCRIPT,
        sessionId: 'session-1',
        sessionGeneration: 1,
        stageGeneration: 0,
        stageSettings: opening,
      }),
      teleprompter: current.teleprompter,
      presentationMode: 'reader',
      stageDisplay: DESK,
    });
  }

  const rendered = () => get(session).stageEnvelope!.stageSettings;

  it('reaches the glass of the reading window that is already open', async () => {
    startReading();
    teardown = installLiveSettingsFollow();
    expect(rendered().themeId).toBe(STAGE_DARK_THEME_ID);

    await patchSettings('teleprompter', { readerTheme: 'paper' });

    expect(rendered().themeId).toBe(READER_PAPER_THEME_ID);
    expect(rendered().pastOpacity).toBe(PAPER_PAST_OPACITY);
    expect(takeReaderThemeSetting()).toBe('paper');
  });

  it('cannot light the glass while a switch to the prompter is in flight', async () => {
    // A DARK reading window on its way to the prompter: the window is moving
    // onto the glass, and Paper saved now must wait for the switch to land.
    startReading();
    teardown = installLiveSettingsFollow();
    suspendReaderPaper(true);

    await patchSettings('teleprompter', { readerTheme: 'paper' });
    expect(rendered().themeId).toBe(STAGE_DARK_THEME_ID);

    adoptPresentationMode('prompter', DESK);
    expect(rendered().themeId).toBe(STAGE_DARK_THEME_ID);
    adoptPresentationMode('reader', DESK);
    expect(rendered().themeId).toBe(READER_PAPER_THEME_ID);
  });

  it('replaces a choice the sheet made for this take, like a slider moved there', async () => {
    await patchSettings('teleprompter', { readerTheme: 'paper' });
    startReading();
    teardown = installLiveSettingsFollow();
    // The sheet chose paper for this take, over a saved paper.
    applyReaderTheme('paper');
    expect(rendered().themeId).toBe(READER_PAPER_THEME_ID);

    await patchSettings('teleprompter', { readerTheme: 'dark' });

    // Held on to, the take's own paper would have outlived the Settings change.
    expect(rendered().themeId).toBe(STAGE_DARK_THEME_ID);
    expect(takeReaderThemeSetting()).toBe('dark');
  });
});
