/**
 * S5 — §61 frame-performance degradation: what is turned off, and what is not.
 *
 * The flag's journey (engine → renderer → mount site → Listener) is asserted in
 * tests/dom/script-layer-degraded.test.ts, where the components are mounted.
 * This file covers the two things better asserted without a DOM:
 *
 *   - step 3, the simplified Listener crossfade, which is a rendered attribute;
 *   - the BOUNDARY of step 1 — that the degraded rule can only shorten
 *     transitions, and cannot reach the reading aids the presenter navigates by.
 *
 * The boundary is the part worth guarding. "Disable nonessential visual
 * effects" is an invitation to disable the wrong thing, and the wrong thing
 * here is not a nice-to-have: past/future dimming, the phrase underlay and the
 * reading band are how a presenter knows where they are on a wall of text.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import ListenerLayer from '../../../src/stage/listener/ListenerLayer.svelte';
import type { ListenerStageSelection } from '../../../src/shared/contracts';

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

function selection(): ListenerStageSelection {
  return {
    packId: 'mira',
    version: '1.0.0',
    variant: '1080p',
    placement: 'background',
    clipUrls: [
      { id: 'c1', url: 'blob:clip', mime: 'video/mp4', durationMs: 5000, posterUrl: '' },
    ],
    geometry: {
      anchorX: 0.5,
      anchorY: 0.5,
      scale: 1,
      cropX: 0,
      cropY: 0,
      cropZoom: 1,
      opacity: 0.6,
      blurPx: 0,
      saturation: 1,
      mirrorVideo: false,
    },
  };
}

function crossfadeMs(props: Record<string, unknown>): string {
  const markup = render(ListenerLayer, { props: { selection: selection(), ...props } }).body;
  const match = /transition-duration:\s*([0-9]+ms)/.exec(markup);
  return match?.[1] ?? 'absent';
}

describe('§61 step 3 — the Listener crossfade is simplified under frame pressure', () => {
  it('runs the full blend when frames are healthy', () => {
    expect(crossfadeMs({})).toBe('180ms');
  });

  it('shortens the blend while the stage is degraded', () => {
    // Two decoding videos composited together is the most expensive thing this
    // layer does, and a clip boundary is the least load-bearing thing on the
    // glass — so this is the cheapest real win §61 offers.
    expect(crossfadeMs({ degraded: true })).toBe('60ms');
  });

  it('leaves the reduced-motion behaviour exactly as it was', () => {
    expect(crossfadeMs({ reducedMotion: true })).toBe('60ms');
    expect(crossfadeMs({ reducedMotion: true, degraded: true })).toBe('60ms');
  });

  it('still plays the Listener — degradation simplifies, it does not remove', () => {
    const markup = render(ListenerLayer, {
      props: { selection: selection(), degraded: true },
    }).body;
    expect(markup).toContain('<video');
    expect(markup).toContain('listener-layer');
  });
});

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
