/**
 * The delivery score on the glass (Speaking Score report §11.1–§11.3).
 *
 * ---------------------------------------------------------------------------
 * What these tests are actually for
 * ---------------------------------------------------------------------------
 * "The score renders" is not worth asserting: it would pass on a layout that
 * shoved the pace tile sideways every time the number gained a digit, and on a
 * rail that printed `0` for a speaker it had not yet heard. The properties
 * here are the ones a wrong implementation fails:
 *
 *  - nothing outside the score's own box changes when the score changes;
 *  - the score's box is sized by CSS lengths, never by its contents;
 *  - `null` is `—`, and `—` is never `0`;
 *  - twenty snapshots inside 200 ms produce at most one visible update;
 *  - `steady` draws nothing at all;
 *  - the seven dimensions and the confidence figure never reach the DOM.
 *
 * Rendered with `svelte/server` like the rest of the stage renderer suite: this
 * project's vitest environment is node, and every property above is present in
 * the first paint.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { render } from 'svelte/server';
import CoachRail from '../../../src/stage/renderer/coach/CoachRail.svelte';
import {
  DeliveryScorePresenter,
  SCORE_CARET_GLYPH,
  SCORE_NUMBER_INTERVAL_MS,
  SCORE_WARMING_LABEL,
} from '../../../src/stage/renderer/coach/deliveryScore';
import { CoachRailPresenter } from '../../../src/stage/renderer/coach/presenter';
import { resolveRailLayout } from '../../../src/stage/renderer/coach/railGeometry';
import { resolveRailModules } from '../../../src/shared/coaching/coach/coach-state';
import { deliveryScore, railState } from './coach-rail-fixture';
import type { CoachRailState, DeliveryScoreState } from '../../../src/shared/contracts/coaching';

const RAIL_SOURCE = readFileSync(
  fileURLToPath(new URL('../../../src/stage/renderer/coach/CoachRail.svelte', import.meta.url)),
  'utf8',
);
const RAIL_STYLE = RAIL_SOURCE.slice(RAIL_SOURCE.indexOf('<style>'));

function html(state: CoachRailState | null, textScale = 1): string {
  return render(CoachRail, { props: { snapshot: state, viewportHeightPx: 1080, textScale } }).body;
}

function scored(score: Partial<DeliveryScoreState>): string {
  return html(railState({ score: deliveryScore(score) }));
}

/** The band element's own inline style — the §7.1 reserved geometry. */
function bandStyle(markup: string): string {
  const match = /<div class="coach-rail[^"]*"[^>]*style="([^"]*)"/.exec(markup);
  if (!match) throw new Error('no coach-rail band in markup');
  return match[1]!;
}

const SCORE_ZONE = /<div class="zone zone-score[\s\S]*?data-field="score-state">[^<]*<\/div><\/div>/;

function scoreZone(markup: string): string {
  const match = SCORE_ZONE.exec(markup);
  if (!match) throw new Error(`no score zone in markup: ${markup.slice(0, 300)}`);
  return match[0];
}

/** Everything the rail draws *except* the score's own box. */
function outsideScoreZone(markup: string): string {
  return markup.replace(SCORE_ZONE, '<SCORE-ZONE/>');
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

/* ---------------------------------------------------------------------------
 * §11.1 placement
 * ------------------------------------------------------------------------- */

describe('§11.1 the score is first and left-most', () => {
  it('draws the score zone ahead of the pace zone in document order', () => {
    const markup = scored({});
    const scoreAt = markup.indexOf('data-zone="score"');
    const paceAt = markup.indexOf('data-zone="pace"');
    const tipAt = markup.indexOf('data-zone="tip"');
    expect(scoreAt).toBeGreaterThan(-1);
    expect(scoreAt).toBeLessThan(paceAt);
    expect(paceAt).toBeLessThan(tipAt);
  });

  it('shows the score in Coach and Studio and withholds it everywhere else', () => {
    for (const mode of ['coach', 'studio'] as const) {
      const markup = html(railState({ mode, score: deliveryScore({}) }));
      expect(field(markup, 'score-value')).toBe('84');
    }
    // §6.2 / §6.5: Minimal is pace-only, and Review-only is still scored but
    // never shows it. The producer withholds the payload; the rail withholds
    // the zone. Either alone would be enough — both is the point.
    for (const mode of ['minimal', 'review_only'] as const) {
      const markup = html(railState({ mode, score: deliveryScore({}) }));
      expect(field(markup, 'score-value')).toBeNull();
      expect(markup).not.toContain('data-zone="score"');
    }
  });

  it('honours a custom-mode module toggle rather than guessing (§6.6)', () => {
    const on = resolveRailModules('custom', { deliveryScore: true, liveTips: true });
    const off = resolveRailModules('custom', { deliveryScore: false, liveTips: true });
    expect(resolveRailLayout('custom', 1280, on).showScore).toBe(true);
    expect(resolveRailLayout('custom', 1280, off).showScore).toBe(false);

    const shown = html(railState({ mode: 'custom', modules: on, score: deliveryScore({}) }));
    const hidden = html(railState({ mode: 'custom', modules: off, score: deliveryScore({}) }));
    expect(field(shown, 'score-value')).toBe('84');
    expect(hidden).not.toContain('data-zone="score"');
  });
});

/* ---------------------------------------------------------------------------
 * §7.1 — the property that matters
 * ------------------------------------------------------------------------- */

describe('§7.1 the score cannot reflow anything', () => {
  /** Every state the score is allowed to be in during one take. */
  const STATES: ReadonlyArray<[string, Partial<DeliveryScoreState>]> = [
    ['warming up', { tier: 'warming_up', displayScore: null }],
    ['estimated', { tier: 'estimated', displayScore: 84 }],
    ['usable 84', { tier: 'usable', displayScore: 84 }],
    ['confident 91', { tier: 'confident', displayScore: 91 }],
    ['three digits', { tier: 'confident', displayScore: 100 }],
    ['rising', { tier: 'usable', displayScore: 84, trend: 'rising' }],
    ['falling', { tier: 'usable', displayScore: 84, trend: 'falling' }],
  ];

  it('leaves the reserved band byte-identical in every score state', () => {
    const baseline = bandStyle(scored(STATES[0]![1]));
    for (const [name, state] of STATES) {
      expect(`${name}: ${bandStyle(scored(state))}`).toBe(`${name}: ${baseline}`);
    }
    // And identically for the score being absent altogether.
    expect(bandStyle(html(railState()))).toBe(baseline);
  });

  it('leaves every other zone byte-identical in every score state', () => {
    // A `warming_up` → `usable` transition and an 84 → 91 change must not
    // change one byte of the pace tile, the tip zone, the variety tile or the
    // ribbon. If the score's box could grow, the grid would redistribute and
    // this comparison would fail long before anything was visible on glass.
    const baseline = outsideScoreZone(scored(STATES[0]![1]));
    for (const [name, state] of STATES) {
      expect(`${name}\n${outsideScoreZone(scored(state))}`).toBe(`${name}\n${baseline}`);
    }
  });

  it('keeps the score box itself structurally identical — only its ink changes', () => {
    const openingTag = (markup: string): string =>
      /<div class="zone zone-score[^>]*>/.exec(scoreZone(markup))![0];
    const baseline = openingTag(scored(STATES[0]![1]));
    for (const [name, state] of STATES) {
      expect(`${name}: ${openingTag(scored(state))}`).toBe(`${name}: ${baseline}`);
    }
  });

  it('sizes the score column with a CSS length, never with its contents', () => {
    // This is what makes the three assertions above mean something. A
    // content-sized track (`auto`, `max-content`, `fit-content`) would let
    // `LISTENING…` → `SCORE` shove the whole row sideways, and every
    // byte-identity check would still pass on the *markup*.
    const tracks = [...RAIL_STYLE.matchAll(/data-score='true'\][^{]*\{([^}]*)\}/g)].map(
      (match) => match[1]!,
    );
    expect(tracks.length).toBeGreaterThan(0);
    for (const track of tracks) {
      const columns = /grid-template-columns:\s*([^;]+);/.exec(track)?.[1];
      expect(columns).toBeDefined();
      const first = columns!.trim().split(/\s+(?![^(]*\))/)[0]!;
      expect(first).toBe('var(--score-col)');
    }
    // And `--score-col` is a length, not a keyword.
    expect(RAIL_STYLE).toMatch(/--score-col:\s*[\d.]+em;/);
  });

  it('reserves a fixed character advance for the number and clips the rest', () => {
    // `—`, `84`, `91` and `100` occupy the same box, so the caret beside the
    // number cannot shift when the number changes width.
    expect(RAIL_STYLE).toMatch(/\.score-value\s*\{[^}]*min-width:\s*3ch;/);
    // The rail already sets `font-variant-numeric: tabular-nums`, which is what
    // makes `3ch` an honest reservation rather than an approximation.
    expect(RAIL_STYLE).toContain('font-variant-numeric: tabular-nums;');
    // Anything the fixed track cannot hold is clipped, never allowed to grow it.
    expect(RAIL_STYLE).toMatch(/\.zone-score\s*\{[^}]*overflow:\s*hidden;/);
    expect(RAIL_STYLE).toMatch(/\.zone-score\s*\{[^}]*white-space:\s*nowrap;/);
    // The caret slot is reserved too, so `steady` → `rising` moves nothing.
    expect(RAIL_STYLE).toMatch(/\.caret\s*\{[^}]*min-width:\s*1em;/);
  });

  it('expresses the estimated tier as opacity, never as weight or size', () => {
    // §9.7 asks for a subdued figure. A lighter font-weight would change glyph
    // advance and resize the number, so the only permitted lever is opacity.
    const subdued = /\.score-value\.subdued\s*\{([^}]*)\}/.exec(RAIL_STYLE)?.[1];
    expect(subdued).toBeDefined();
    for (const declaration of subdued!.split(';').map((d) => d.trim()).filter(Boolean)) {
      expect(declaration.split(':')[0]!.trim()).toBe('opacity');
    }
    const scoreRules = [...RAIL_STYLE.matchAll(/\.score-value[^{]*\{([^}]*)\}/g)];
    for (const [, body] of scoreRules) {
      for (const declaration of body!.match(/transition:[^;]+;/g) ?? []) {
        expect(declaration).toContain('opacity');
        expect(declaration).not.toMatch(/transform|height|width|top|bottom|left|right|font/);
      }
    }
  });
});

/* ---------------------------------------------------------------------------
 * §11.3 warm-up
 * ------------------------------------------------------------------------- */

describe('§11.3 warm-up shows an absence, not a bad score', () => {
  it('renders “Listening…” and an em dash for a score that does not exist yet', () => {
    const markup = scored({ tier: 'warming_up', displayScore: null });
    expect(field(markup, 'score-value')).toBe('—');
    expect(field(markup, 'score-state')).toBe(SCORE_WARMING_LABEL);
    expect(SCORE_WARMING_LABEL.toLowerCase()).toContain('listening');
    expect(text(markup).toLowerCase()).toContain('listening');
  });

  it('never puts a zero glyph on the glass while warming up', () => {
    const markup = scoreZone(scored({ tier: 'warming_up', displayScore: null }));
    // Assert the *absence* of the zero, not merely the presence of the dash: a
    // component that rendered both would pass the previous test.
    expect(markup).not.toMatch(/>\s*0\s*</);
    expect(markup).not.toContain('>0<');
    expect(field(markup, 'score-value')).not.toBe('0');
  });

  it('withholds the number when the tier says warming up, whatever the engine left behind', () => {
    // A `displayScore` that survived a confidence collapse is still not a score
    // the rail may show (§9.7: below 0.35 there is no score).
    const markup = scored({ tier: 'warming_up', displayScore: 84 });
    expect(field(markup, 'score-value')).toBe('—');
    expect(markup).not.toContain('>84<');
  });

  it('renders a genuine zero as zero — absence and a bad score are different claims', () => {
    const markup = scored({ tier: 'usable', displayScore: 0 });
    expect(field(markup, 'score-value')).toBe('0');
    expect(field(markup, 'score-state')).not.toBe(SCORE_WARMING_LABEL);
  });

  it('rounds the display score to a whole number', () => {
    expect(field(scored({ displayScore: 84.4 }), 'score-value')).toBe('84');
    expect(field(scored({ displayScore: 84.6 }), 'score-value')).toBe('85');
  });
});

/* ---------------------------------------------------------------------------
 * §11.3 trend
 * ------------------------------------------------------------------------- */

describe('§11.3 the trend caret', () => {
  it('renders nothing at all when the score is steady', () => {
    const markup = scored({ trend: 'steady' });
    expect(markup).not.toContain('data-field="score-trend"');
    // Not a neutral glyph either: a dash or a dot blinking in and out is still
    // movement in the presenter's peripheral vision.
    expect(scoreZone(markup)).not.toContain('data-trend');
  });

  it('renders a distinct caret for rising and for falling', () => {
    const rising = scored({ trend: 'rising' });
    const falling = scored({ trend: 'falling' });
    expect(rising).toContain('data-trend="rising"');
    expect(falling).toContain('data-trend="falling"');
    expect(field(rising, 'score-trend')).toBe(SCORE_CARET_GLYPH.rising);
    expect(field(falling, 'score-trend')).toBe(SCORE_CARET_GLYPH.falling);
    expect(SCORE_CARET_GLYPH.rising).not.toBe(SCORE_CARET_GLYPH.falling);
  });

  it('uses vertical carets, which survive the §7.5 mirror transform', () => {
    // The rail carries no transform of its own and flips with the script, so a
    // left/right arrow would point the wrong way through the glass.
    for (const glyph of Object.values(SCORE_CARET_GLYPH)) {
      expect(glyph).not.toMatch(/[←→◀▶⯇⯈]/);
    }
  });

  it('draws no caret when there is no number to trend', () => {
    const markup = scored({ tier: 'warming_up', displayScore: null, trend: 'rising' });
    expect(markup).not.toContain('data-field="score-trend"');
  });
});

/* ---------------------------------------------------------------------------
 * §11.2 / §9.7 — what must never reach the glass
 * ------------------------------------------------------------------------- */

describe('§11.2 the dimensions and the confidence stay off the rail', () => {
  const state = deliveryScore({});

  it('never renders the seven dimension scores', () => {
    const markup = scored({});
    // The fixture gives every dimension a two-digit score that appears nowhere
    // else on the rail, so a leak is caught by the digits and not by the field
    // name. (The weights are single-digit constants for `clarity` and
    // `consistency`; they collide with ordinary markup and are not evidence.)
    for (const dimension of state.dimensions) {
      expect(markup).not.toContain(String(dimension.score));
    }
    // Nor their names. `pace` and `variety` have captions of their own on the
    // rail, so the four that could only have come from the score are checked.
    for (const name of ['pausing', 'emphasis', 'fluency', 'clarity', 'consistency']) {
      expect(markup.toLowerCase()).not.toContain(name);
    }
    expect(state.dimensions).toHaveLength(7);
  });

  it('never renders the weakest dimension as copy', () => {
    const markup = scored({ weakestDimension: 'consistency' });
    expect(markup.toLowerCase()).not.toContain('consistency');
  });

  it('never renders confidence as a second number (§9.7)', () => {
    const markup = scored({ confidence: 0.62 });
    expect(markup).not.toContain('0.62');
    expect(markup).not.toContain('62%');
    expect(markup).not.toContain('>62<');
    // The tier reaches the glass only as a presentation choice.
    expect(scored({ tier: 'estimated' })).toContain('data-subdued="true"');
    expect(scored({ tier: 'usable' })).toContain('data-subdued="false"');
    expect(scored({ tier: 'estimated' })).not.toContain('estimated');
  });

  it('never renders the raw score', () => {
    // `rawScore` is 57 in the fixture and `displayScore` is 84, so a rail that
    // reached for the unsmoothed value would be caught by the digits.
    const markup = scored({});
    expect(markup).not.toContain('57');
    expect(field(markup, 'score-value')).toBe('84');
  });

  it('carries none of it in the view model either', () => {
    const view = new DeliveryScorePresenter().update(deliveryScore({}), 0);
    const serialised = JSON.stringify(view);
    expect(serialised).not.toContain('57');
    expect(serialised).not.toContain('0.62');
    for (const dimension of deliveryScore({}).dimensions) {
      expect(serialised).not.toContain(String(dimension.score));
    }
    expect(Object.keys(view).sort()).toEqual(['caret', 'label', 'subdued', 'value']);
  });
});

/* ---------------------------------------------------------------------------
 * §11.3 update rate
 * ------------------------------------------------------------------------- */

describe('§11.3 the number updates at 2–5 Hz, not at snapshot rate', () => {
  it('is inside the 2–5 Hz band the spec asks for', () => {
    expect(1000 / SCORE_NUMBER_INTERVAL_MS).toBeGreaterThanOrEqual(2);
    expect(1000 / SCORE_NUMBER_INTERVAL_MS).toBeLessThanOrEqual(5);
  });

  it('turns twenty snapshots in 200 ms into at most one visible change', () => {
    const presenter = new CoachRailPresenter();
    const seen: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const view = presenter.update({
        state: railState({
          stageRevision: i + 1,
          score: deliveryScore({ displayScore: 60 + i }),
        }),
        monotonicMs: i * 10,
        widthPx: 1280,
        viewportHeightPx: 1080,
        textScale: 1,
      });
      seen.push(view.score!.value);
    }
    expect(seen).toHaveLength(20);
    const changes = seen.filter((value, index) => index > 0 && value !== seen[index - 1]!).length;
    expect(changes).toBe(0);
    expect(new Set(seen).size).toBe(1);
    // The one value shown is the first, not the last: the rail does not chase.
    expect(seen[0]).toBe('60');
  });

  it('lets the number move again once the interval has passed', () => {
    const presenter = new DeliveryScorePresenter();
    expect(presenter.update(deliveryScore({ displayScore: 60 }), 0).value).toBe('60');
    expect(presenter.update(deliveryScore({ displayScore: 70 }), SCORE_NUMBER_INTERVAL_MS - 1).value)
      .toBe('60');
    expect(presenter.update(deliveryScore({ displayScore: 70 }), SCORE_NUMBER_INTERVAL_MS).value)
      .toBe('70');
  });

  it('does not advance the limiter when the view is merely recomputed', () => {
    // The component evaluates this inside a `$derived`, which re-runs for
    // reasons that have nothing to do with time passing.
    const presenter = new DeliveryScorePresenter();
    presenter.update(deliveryScore({ displayScore: 60 }), 0);
    for (let i = 0; i < 50; i += 1) {
      expect(presenter.update(deliveryScore({ displayScore: 99 }), 0).value).toBe('60');
    }
    expect(presenter.update(deliveryScore({ displayScore: 99 }), SCORE_NUMBER_INTERVAL_MS).value)
      .toBe('99');
  });

  it('drops to “Listening…” immediately when confidence collapses', () => {
    // §11.3: replace the number rather than let a false one stand. Holding a
    // stale 84 for another 300 ms because of the rate cap would be the rail
    // asserting something the engine has withdrawn.
    const presenter = new DeliveryScorePresenter();
    expect(presenter.update(deliveryScore({ displayScore: 84 }), 0).value).toBe('84');
    const collapsed = presenter.update(
      deliveryScore({ tier: 'warming_up', displayScore: null }),
      10,
    );
    expect(collapsed.value).toBe('—');
    expect(collapsed.label).toBe(SCORE_WARMING_LABEL);
    // And it comes back without waiting out an interval, because there is no
    // stale value left to protect.
    expect(presenter.update(deliveryScore({ displayScore: 84 }), 20).value).toBe('84');
  });

  it('clamps a smoothed overshoot into 0–100', () => {
    const presenter = new DeliveryScorePresenter();
    expect(presenter.update(deliveryScore({ displayScore: 104 }), 0).value).toBe('100');
    expect(new DeliveryScorePresenter().update(deliveryScore({ displayScore: -3 }), 0).value).toBe(
      '0',
    );
  });
});

/* ---------------------------------------------------------------------------
 * §7.3 degradation ladder
 * ------------------------------------------------------------------------- */

describe('§7.3 where the score sits in the drop order', () => {
  it('outranks the sparkline and the numeric variety, and goes with the telemetry', () => {
    const widths = [1280, 820, 700, 560, 420, 320];
    const layouts = widths.map((width) => resolveRailLayout('studio', width));
    expect(layouts.map((l) => l.tier)).toEqual([
      'full',
      'no_sparkline',
      'variety_label',
      'no_filler_count',
      'compact',
      'tip_only',
    ]);
    // Steps 1–4 drop the sparkline, the numeric variety and the filler count.
    // The score survives all of them: it is two glyphs carrying the rail's
    // whole summary, where those three cost far more width for detail their
    // own labels already imply.
    for (const layout of layouts.slice(0, 5)) expect(layout.showScore).toBe(true);
    expect(layouts[1]!.showSparkline).toBe(false);
    expect(layouts[2]!.showVarietyNumber).toBe(false);
    expect(layouts[3]!.showFillerCount).toBe(false);
    // Step 6: the tip is the last thing standing (§7.3 step 5), and the score
    // goes with the rest of the telemetry rather than ahead of it.
    expect(layouts[5]!.showScore).toBe(false);
    expect(layouts[5]!.showPace).toBe(false);
    expect(layouts[5]!.showVariety).toBe(false);
  });

  it('keeps its own fixed track in the compact row too', () => {
    expect(RAIL_STYLE).toMatch(
      /\.row\[data-compact='true'\]\[data-score='true'\]\s*\{\s*grid-template-columns:\s*var\(--score-col\)/,
    );
  });
});
