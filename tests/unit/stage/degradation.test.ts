/**
 * S5 — §61 frame-performance degradation: what is turned off, and what is not.
 *
 * The flag's journey (engine → renderer → mount site) is asserted in
 * tests/dom/script-layer-degraded.test.ts, where the components are mounted.
 * This file covers the BOUNDARY of step 1 — that the degraded rule can only
 * shorten transitions, and cannot reach the reading aids the presenter
 * navigates by.
 *
 * The boundary is the part worth guarding. "Disable nonessential visual
 * effects" is an invitation to disable the wrong thing, and the wrong thing
 * here is not a nice-to-have: past/future dimming, the phrase underlay and the
 * reading band are how a presenter knows where they are on a wall of text.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

describe('§61 step 1 — what "nonessential" is allowed to mean', () => {
  const css = source('../../../src/stage/renderer/ScriptLayer.svelte');

  /** The body of the one rule degradation adds. */
  const degradedRule = (() => {
    const start = css.indexOf(".script-layer[data-degraded='true']");
    expect(start).toBeGreaterThan(-1);
    const open = css.indexOf('{', start);
    return css.slice(open + 1, css.indexOf('}', open));
  })();

  it('changes exactly one thing: how long transitions last', () => {
    expect(degradedRule).toContain('--stage-fx-ms: 0ms');
    expect(degradedRule.replace('--stage-fx-ms: 0ms;', '').trim()).toBe('');
  });

  it('cannot touch the reading aids, because it only sets a duration', () => {
    // Anything that hid or re-coloured a reading aid would have to appear here.
    for (const forbidden of ['opacity', 'display', 'visibility', 'background', 'color']) {
      expect(degradedRule).not.toContain(forbidden);
    }
  });

  it('leaves the reading band and the zoning opacities out of the variable', () => {
    // The band geometry and the past/future opacities are set from settings on
    // the layer, unconditionally — `--stage-fx-ms` governs `transition-duration`
    // and appears nowhere else.
    for (const file of [
      '../../../src/stage/renderer/ScriptLayer.svelte',
      '../../../src/stage/renderer/BlockView.svelte',
      '../../../src/stage/renderer/InlineNodes.svelte',
    ]) {
      const text = source(file).replace(/\/\*[\s\S]*?\*\//g, '');
      for (const line of text.split('\n')) {
        if (!line.includes('--stage-fx-ms')) continue;
        const usesIt = line.includes('transition-duration') || line.includes('--stage-fx-ms: 0ms');
        expect(usesIt, `--stage-fx-ms used outside a transition duration: ${line.trim()}`).toBe(
          true,
        );
      }
    }
  });

  it('keeps the phrase underlay itself, and only stops it gliding', () => {
    const underlay = css.slice(css.indexOf('.phrase-underlay {'));
    const body = underlay.slice(0, underlay.indexOf('}'));
    // Still drawn: position, radius and the accent fill are untouched.
    expect(body).toContain('background: var(--stage-accent)');
    // Only its movement is variable.
    expect(body).toContain('transition-duration: var(--stage-fx-ms');
  });
});
