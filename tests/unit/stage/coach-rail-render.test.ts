/**
 * The rail as it actually reaches the glass.
 *
 * The view-model tests prove the arithmetic; these prove the component honours
 * it. Rendered with `svelte/server`, matching the rest of the stage renderer
 * suite (the project's vitest environment is node — there is no DOM to mount
 * into), which is enough for every property here because all of them are
 * present in the first paint.
 *
 * Each assertion is written so that deleting the logic it covers breaks it: an
 * `{#if visible}` around the band, a `0` standing in for an unknown WPM, a set
 * of ribbon markers separated only by colour, or a reduced-motion flag that is
 * read but never used would each turn one of these red.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { render } from 'svelte/server';
import CoachRail from '../../../src/stage/renderer/coach/CoachRail.svelte';
import CoachStrip from '../../../src/stage/renderer/CoachStrip.svelte';
import EventRibbon from '../../../src/stage/renderer/coach/EventRibbon.svelte';
import {
  RAIL_PREFERRED_HEIGHT_PX,
  coachRailReservedHeightPx,
} from '../../../src/stage/renderer/coach/railGeometry';
import { RIBBON_SHAPE } from '../../../src/stage/renderer/coach/ribbon';
import { resolveRailModules } from '../../../src/shared/coaching/coach/coach-state';
import { railState, ribbonEvent, tip } from './coach-rail-fixture';
import type { CoachRailModules, CoachRailState } from '../../../src/shared/contracts/coaching';

function html(
  state: CoachRailState | null,
  props: { viewportHeightPx?: number; textScale?: number } = {},
): string {
  return render(CoachRail, {
    props: { snapshot: state, viewportHeightPx: 1080, textScale: 1, ...props },
  }).body;
}

/** The band element's own inline style. */
function bandStyle(markup: string): string {
  const match = /<div class="coach-rail[^"]*"[^>]*style="([^"]*)"/.exec(markup);
  if (!match) throw new Error(`no coach-rail band in markup: ${markup.slice(0, 200)}`);
  return match[1]!;
}

function heightPx(markup: string): number {
  const match = /height:\s*([\d.]+)px/.exec(bandStyle(markup));
  if (!match) throw new Error(`band has no height: ${bandStyle(markup)}`);
  return Number(match[1]);
}

function field(markup: string, name: string): string | null {
  const match = new RegExp(`data-field="${name}"[^>]*>([\\s\\S]*?)<`).exec(markup);
  return match ? match[1]!.replace(/\s+/g, ' ').trim() : null;
}

function text(markup: string): string {
  return markup
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('§7.1 the band is reserved, not conditional', () => {
  it('keeps an identical reserved height when the rail is hidden', () => {
    for (const viewportHeightPx of [0, 640, 720, 1080, 1600]) {
      const shown = html(railState({ visible: true }), { viewportHeightPx });
      const hidden = html(railState({ visible: false }), { viewportHeightPx });
      expect(heightPx(hidden)).toBe(heightPx(shown));
      expect(heightPx(hidden)).toBe(coachRailReservedHeightPx(viewportHeightPx));
    }
  });

  it('still renders the band element when hidden, and fades only the contents', () => {
    const hidden = html(railState({ visible: false }));
    expect(hidden).toContain('class="coach-rail');
    expect(hidden).toContain('data-visible="false"');
    // The contents are still in the tree — they are faded, not unmounted, so
    // nothing below them can reflow when the rail comes back.
    expect(hidden).toMatch(/class="contents[^"]*hidden/);
    expect(html(railState({ visible: true }))).not.toMatch(/class="contents[^"]*hidden/);
  });

  it('reserves the band before the first snapshot arrives', () => {
    const empty = html(null);
    expect(heightPx(empty)).toBe(RAIL_PREFERRED_HEIGHT_PX);
  });

  it('is absent entirely only in mode off (§6.1)', () => {
    // Only Svelte's own anchor comments remain.
    expect(text(html(railState({ mode: 'off' })))).toBe('');
    expect(html(railState({ mode: 'off' }))).not.toContain('coach-rail');
    expect(html(railState({ mode: 'review_only' }))).toContain('class="coach-rail');
  });
});

describe('§8 telemetry on the glass', () => {
  it('renders — for an unknown pace and never 0', () => {
    const markup = html(railState());
    expect(field(markup, 'pace-number')).toBe('—');
    expect(field(markup, 'pace-number')).not.toBe('0');
    expect(field(markup, 'pace-state')).toBe('LEARNING');
  });

  it('renders VARIETY — / LEARNING before calibration, in the mode that has the figure', () => {
    // §6.4. The numeric variety score is a Studio module (`varietyScore`);
    // §6.3 Coach gets the state word alone, and the settings copy promises the
    // user the same thing — "Hidden, variety still shows as a word".
    const markup = html(railState({ mode: 'studio' }));
    expect(field(markup, 'variety-number')).toBe('—');
    expect(field(markup, 'variety-state')).toBe('LEARNING');
    expect(text(markup)).toContain('VARIETY —');
  });

  it('gives Coach the variety word without the figure (§6.3)', () => {
    // The rail used to draw the figure in Coach too, because the zone was
    // gated on "the mode may show variety at all" rather than on the
    // `varietyScore` module the payload actually carries.
    const coach = html(railState({ variety: { ...railState().variety, level: 68, state: 'balanced' } }));
    expect(field(coach, 'variety-state')).toBe('BALANCED');
    expect(field(coach, 'variety-number')).toBeNull();
    expect(text(coach)).not.toContain('VARIETY');
  });

  it('renders the settled tiles the spec draws in §7.2', () => {
    const markup = html(
      railState({
        // Studio: §7.2's illustration is the fullest layout, numeric variety
        // included.
        mode: 'studio',
        pace: { ...railState().pace, wpm: 142, confidence: 0.9, state: 'on_target' },
        variety: { ...railState().variety, level: 68, state: 'balanced' },
        fillers: { ...railState().fillers, confirmedCount: 2 },
      }),
    );
    expect(text(markup)).toContain('PACE 142');
    expect(field(markup, 'pace-state')).toBe('ON TARGET');
    expect(text(markup)).toContain('VARIETY 68');
    expect(text(markup)).toContain('BALANCED');
    expect(field(markup, 'filler-count')).toBe('FILLERS 2');
  });

  it('withholds variety and fillers in Minimal mode (§6.2)', () => {
    const markup = html(
      railState({
        mode: 'minimal',
        variety: { ...railState().variety, level: 68, state: 'balanced' },
        fillers: { ...railState().fillers, confirmedCount: 2 },
      }),
    );
    expect(field(markup, 'pace-state')).not.toBeNull();
    expect(field(markup, 'variety-state')).toBeNull();
    expect(field(markup, 'filler-count')).toBeNull();
    expect(text(markup)).not.toContain('FILLERS');
  });
});

describe('§6.6 a module the user turned off does not reach the glass', () => {
  const busy = {
    pace: { ...railState().pace, wpm: 142, confidence: 0.9, state: 'on_target' as const },
    variety: { ...railState().variety, level: 68, state: 'balanced' as const },
    fillers: { ...railState().fillers, confirmedCount: 2 },
    ribbonEvents: [ribbonEvent('speech', 0, 10_000), ribbonEvent('confirmed_filler', 8_000, 8_200)],
  };

  /** Everything a user can toggle, on. */
  const ALL = resolveRailModules('studio');

  function custom(overrides: Partial<CoachRailModules>, widthProps = {}): string {
    return html(
      railState({ mode: 'custom', modules: { ...ALL, ...overrides }, ...busy }),
      widthProps,
    );
  }

  /**
   * Each row: the module, and a string that appears on the glass only because
   * that module is on. The failure being guarded is a rail that reads the
   * *mode* — `custom` then renders as Coach and the toggle does nothing.
   */
  const CASES: ReadonlyArray<[keyof CoachRailModules, string, string]> = [
    ['deliveryScore', 'data-zone="score"', 'the score zone'],
    ['paceNumber', 'data-field="pace-number"', 'the WPM figure'],
    ['paceStatus', 'data-field="pace-state"', 'the pace state line'],
    ['varietyScore', 'data-field="variety-number"', 'the numeric variety score'],
    ['varietyLabel', 'data-field="variety-state"', 'the variety word'],
    ['fillerCount', 'data-field="filler-count"', 'the filler count'],
    ['fillerRibbon', 'data-shape="now"', 'the event ribbon'],
  ];

  for (const [module, marker, what] of CASES) {
    it(`hides ${what} when \`${module}\` is off`, () => {
      expect(custom({})).toContain(marker);
      expect(custom({ [module]: false })).not.toContain(marker);
    });
  }

  it('replaces the schedule line with the pace state when `targetDurationStatus` is off', () => {
    const scheduled = {
      ...busy.pace,
      targetDurationMs: 120_000,
      projectedFinishDeltaMs: 42_000,
    };
    const on = html(railState({ mode: 'custom', modules: ALL, ...busy, pace: scheduled }));
    const off = html(
      railState({
        mode: 'custom',
        modules: { ...ALL, targetDurationStatus: false },
        ...busy,
        pace: scheduled,
      }),
    );
    expect(field(on, 'pace-state')).toBe('42 SEC BEHIND');
    // Withheld, not recomputed: the tile falls back to the state it always had.
    expect(field(off, 'pace-state')).toBe('ON TARGET');
  });

  it('keeps a disabled module hidden at every §7.3 width', () => {
    // §7.3 may drop what the user enabled; nothing may restore what they
    // disabled. `viewportHeightPx` is the only width-ish prop the server
    // render takes, so the ladder is asserted on the layout the component is
    // handed — see coach-rail-geometry for the width sweep itself.
    for (const viewportHeightPx of [1080, 720, 600, 400]) {
      const markup = custom({ fillerRibbon: false, deliveryScore: false }, { viewportHeightPx });
      expect(`${viewportHeightPx}: ${markup.includes('data-shape="now"')}`).toBe(
        `${viewportHeightPx}: false`,
      );
      expect(`${viewportHeightPx}: ${markup.includes('data-zone="score"')}`).toBe(
        `${viewportHeightPx}: false`,
      );
    }
  });
});

describe('§9 the single tip surface', () => {
  it('renders the authored tip copy in the centre zone', () => {
    const markup = html(railState({ activeTip: tip(), ribbonEvents: [ribbonEvent('speech', 9_000, 10_000)] }));
    expect(markup).toContain('data-centre="tip"');
    expect(text(markup)).toContain('Use a silent pause');
  });

  it('has exactly one place a tip can appear', () => {
    const markup = html(railState({ activeTip: tip(), ribbonEvents: [ribbonEvent('speech', 9_000, 10_000)] }));
    expect(markup.match(/data-zone="tip"/g)).toHaveLength(1);
    expect(markup.match(/class="tip[ "]/g)).toHaveLength(1);
  });

  it('leaves the centre empty when there is nothing to say (§2.6)', () => {
    const markup = html(railState());
    expect(markup).toContain('data-zone="tip"');
    expect(markup).not.toContain('data-centre=');
  });

  it('does not render a second tip surface from the superseded CoachStrip', () => {
    // The old floating pill is retired; if it ever renders again there are two
    // competing tip surfaces and nothing on either side can tell.
    const strip = render(CoachStrip, {
      props: {
        tip: {
          id: 't',
          code: 'pace',
          text: 'Ease back slightly',
          severity: 'info',
          durationMs: 2_000,
        },
      },
    }).body;
    expect(text(strip)).toBe('');
    expect(strip).not.toContain('coach-strip');
  });
});

describe('§10.3 markers are distinguishable without colour', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../../src/stage/renderer/coach/EventRibbon.svelte', import.meta.url)),
    'utf8',
  );

  /** Every declaration in a shape's rule that is not a colour. */
  function geometryOf(shape: string): string[] {
    const match = new RegExp(`\\[data-shape='${shape}'\\]\\s*\\{([^}]*)\\}`).exec(source);
    if (!match) throw new Error(`no CSS rule for shape ${shape}`);
    return match[1]!
      .split(';')
      .map((declaration) => declaration.trim())
      .filter((declaration) => declaration.length > 0)
      .filter((declaration) => !/^(background|color|border-color|outline-color)/.test(declaration))
      .sort();
  }

  it('renders one shape per event type, tagged on the element', () => {
    const marks = render(EventRibbon, {
      props: {
        marks: Object.entries(RIBBON_SHAPE).map(([type, shape], index) => ({
          eventId: `e${index}`,
          type: type as never,
          shape,
          leftPercent: index * 10,
          widthPercent: 0,
        })),
        windowMs: 20_000,
        epochMonotonicMs: 0,
        heightPx: 6,
      },
    }).body;
    for (const shape of Object.values(RIBBON_SHAPE)) {
      expect(marks).toContain(`data-shape="${shape}"`);
    }
  });

  it('gives each shape geometry that survives the colour being stripped', () => {
    const signatures = new Map<string, string>();
    for (const shape of Object.values(RIBBON_SHAPE)) {
      const geometry = geometryOf(shape);
      expect(geometry.length).toBeGreaterThan(0);
      const signature = geometry.join('|');
      // Two markers whose only difference is a background colour would collide
      // here — which is precisely the failure §10.3 and §7.6 forbid.
      expect(signatures.has(signature)).toBe(false);
      signatures.set(signature, shape);
    }
    expect(signatures.size).toBe(Object.values(RIBBON_SHAPE).length);
  });

  it('marks the current-time edge with its own shape', () => {
    const markup = render(EventRibbon, {
      props: { marks: [], windowMs: 20_000, epochMonotonicMs: 0, heightPx: 6 },
    }).body;
    expect(markup).toContain('data-shape="now"');
  });
});

describe('§10.4 a late event lands in the past', () => {
  it('positions a retroactive filler at its historical offset, not at the right edge', () => {
    const state = railState({
      ribbonEvents: [
        ribbonEvent('speech', 40_000, 60_000),
        // Confirmed 12 s after the fact by precision transcription.
        ribbonEvent('confirmed_filler', 48_000, 48_300),
      ],
    });
    const markup = html(state);
    const mark = /data-shape="tick"[^>]*style="([^"]*)"/.exec(markup);
    expect(mark).not.toBeNull();
    const left = Number(/left:\s*([\d.-]+)%/.exec(mark![1]!)![1]);
    // The clock anchors to the newest stamp (60 000) and the window is 20 s,
    // so 48 000 belongs at 40% — well away from "now".
    expect(left).toBeCloseTo(40, 6);
    expect(left).toBeLessThan(100);
  });
});

describe('§7.4 / §7.6 visual behaviour', () => {
  it('collapses the transition duration to zero under reduced motion', () => {
    const moving = html(railState());
    const still = html(railState({ reducedMotion: true }));
    expect(bandStyle(moving)).toContain('--rail-fade-ms: 160ms');
    expect(bandStyle(still)).toContain('--rail-fade-ms: 0ms');
    expect(still).toContain('data-reduced-motion="true"');
  });

  it('keeps the transition inside the 120–220 ms band when motion is allowed', () => {
    const ms = Number(/--rail-fade-ms:\s*(\d+)ms/.exec(bandStyle(html(railState())))![1]);
    expect(ms).toBeGreaterThanOrEqual(120);
    expect(ms).toBeLessThanOrEqual(220);
  });

  it('drops the ribbon arrival animation under reduced motion', () => {
    const still = render(EventRibbon, {
      props: {
        marks: [{ eventId: 'e', type: 'confirmed_filler', shape: 'tick', leftPercent: 50, widthPercent: 0 }],
        windowMs: 20_000,
        epochMonotonicMs: 0,
        heightPx: 6,
        reducedMotion: true,
      },
    }).body;
    expect(still).toContain('--ribbon-arrival-ms: 0ms');
  });

  it('applies the clamped text scale as a CSS variable', () => {
    expect(bandStyle(html(railState(), { textScale: 3 }))).toContain('--rail-scale: 1.5');
    expect(bandStyle(html(railState(), { textScale: 0.9 }))).toContain('--rail-scale: 0.9');
  });

  it('never animates position or size — only opacity', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../src/stage/renderer/coach/CoachRail.svelte', import.meta.url)),
      'utf8',
    );
    const style = source.slice(source.indexOf('<style>'));
    for (const declaration of style.match(/transition:[^;]+;/g) ?? []) {
      expect(declaration).toContain('opacity');
      expect(declaration).not.toMatch(/transform|height|width|top|bottom|left|right/);
    }
    // §7.4: no pulsing, bouncing, or vertical movement.
    for (const keyframe of style.match(/@keyframes[\s\S]*?\n  \}/g) ?? []) {
      expect(keyframe).not.toMatch(/translate|scale|rotate/);
    }
  });
});

describe('§7.5 mirror boundary', () => {
  it('carries no transform of its own, so it flips with the script', () => {
    const mirrored = html(railState({ mirrored: true }));
    expect(mirrored).toContain('data-mirrored="true"');
    expect(bandStyle(mirrored)).not.toContain('transform');
    const source = readFileSync(
      fileURLToPath(new URL('../../../src/stage/renderer/coach/CoachRail.svelte', import.meta.url)),
      'utf8',
    );
    expect(source).not.toContain('scaleX');
    expect(source).not.toContain('scaleY');
  });
});

describe('§2.1 the rail cannot move the script', () => {
  it('takes no callback and imports nothing from motion', () => {
    const files = [
      'src/stage/renderer/coach/CoachRail.svelte',
      'src/stage/renderer/coach/EventRibbon.svelte',
      'src/stage/renderer/coach/presenter.ts',
    ];
    for (const file of files) {
      const source = readFileSync(fileURLToPath(new URL(`../../../${file}`, import.meta.url)), 'utf8');
      expect(source).not.toMatch(/from '.*\/motion/);
      expect(source).not.toMatch(/lineMap|scrollY|manualScrollBy|setFallbackTarget/);
      // No outbound event or callback prop: the rail is a readout.
      expect(source).not.toMatch(/on[a-z]+\?:|createEventDispatcher|emitStageEvent/);
    }
  });
});
