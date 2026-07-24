/**
 * The Listener "look" settings, from the settings document to the glass.
 *
 * Each of these was written and never read, or read from a constant:
 *   - `listeners.dimPercent` was written by the Settings screen while Preflight
 *     hard-coded 40 — the same number, which is why nobody noticed;
 *   - `listeners.saturation` was declared by Rust while the stage hard-coded
 *     0.85, and TypeScript typed the whole section as an opaque bag;
 *   - `ListenerGeometryOverrides.mirrorVideo` was never supplied by anything, so
 *     it was permanently false.
 *
 * The chain asserted here is settings value → `buildListenerGeometry` →
 * `ListenerStageSelection` → rendered attribute, because a test that stopped at
 * the geometry object would pass on a stage that ignored it. (The settings
 * document → Preflight control half is asserted in
 * tests/e2e/browser/listener-placement.spec.ts, against the real IPC path.)
 */
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import ListenerLayer from '../../../src/stage/listener/ListenerLayer.svelte';
import {
  buildListenerGeometry,
  type ListenerGeometryOverrides,
} from '../../../src/control/services/listeners';
import { listenerFromRust } from '../../../src/control/services/settings-listener';
import type { ListenerStageSelection } from '../../../src/shared/contracts';

function markup(overrides: ListenerGeometryOverrides): string {
  const selection: ListenerStageSelection = {
    packId: 'mira',
    version: '1.0.0',
    variant: 'default',
    placement: 'background',
    geometry: buildListenerGeometry(1.15, overrides),
    clipUrls: [{ id: 'c1', url: 'blob:clip', mime: 'video/mp4', durationMs: 5000, posterUrl: '' }],
  };
  return render(ListenerLayer, { props: { selection } }).body;
}

/** The `filter` the layer puts on the media box. */
function filter(overrides: ListenerGeometryOverrides): string {
  const match = /filter: (saturate\([^)]*\) blur\([^)]*\))/.exec(markup(overrides));
  expect(match, 'the media box must render a filter').not.toBeNull();
  return match![1]!;
}

/** The layer's own opacity. */
function opacity(overrides: ListenerGeometryOverrides): number {
  const match = /class="listener-layer[^"]*"[^>]*style="opacity: ([\d.]+)/.exec(markup(overrides));
  expect(match, 'the layer must render an opacity').not.toBeNull();
  return Number(match![1]);
}

/** The crop transform. */
function transform(overrides: ListenerGeometryOverrides): string {
  const match = /class="crop[^"]*"[^>]*style="transform: ([^"]*?);?"/.exec(markup(overrides));
  expect(match, 'the crop must render a transform').not.toBeNull();
  return match![1]!;
}

describe('dim reaches the glass', () => {
  it('renders the configured dim, not a constant', () => {
    expect(opacity({ dimPercent: 0 })).toBe(1);
    expect(opacity({ dimPercent: 62 })).toBeCloseTo(0.38, 6);
    expect(opacity({ dimPercent: 80 })).toBeCloseTo(0.2, 6);
  });

  it('never dims all the way to invisible', () => {
    // An invisible Listener is indistinguishable from a broken one, and the
    // media is still decoding either way.
    expect(opacity({ dimPercent: 100 })).toBeGreaterThan(0);
  });
});

describe('blur and colour reach the glass', () => {
  it('renders the configured blur, not a constant', () => {
    expect(filter({ blurPx: 0 })).toContain('blur(0px)');
    expect(filter({ blurPx: 8 })).toContain('blur(8px)');
    expect(filter({ blurPx: 24 })).toContain('blur(24px)');
  });

  it('renders the configured colour, which the stage used to hard-code at 0.85', () => {
    expect(filter({})).toContain('saturate(0.85)');
    expect(filter({ saturationPercent: 40 })).toContain('saturate(0.4)');
    expect(filter({ saturationPercent: 0 })).toContain('saturate(0)');
    expect(filter({ saturationPercent: 100 })).toContain('saturate(1)');
  });

  it('changes exactly one of the two when only one is set', () => {
    const base = filter({ blurPx: 4, saturationPercent: 50 });
    expect(filter({ blurPx: 9, saturationPercent: 50 })).not.toBe(base);
    expect(filter({ blurPx: 4, saturationPercent: 20 })).not.toBe(base);
    expect(filter({ blurPx: 4, saturationPercent: 50 })).toBe(base);
  });
});

describe('mirrorVideo reaches the glass', () => {
  it('flips the media, and only when asked', () => {
    expect(transform({})).toContain('scaleX(1)');
    expect(transform({ mirrorVideo: true })).toContain('scaleX(-1)');
  });

  it('does not move the framing offsets, which is the bug the order prevents', () => {
    const plain = transform({ zoomPercent: 140, offsetXPercent: 5 });
    const mirrored = transform({ zoomPercent: 140, offsetXPercent: 5, mirrorVideo: true });
    expect(plain.startsWith('translate(5%, 0%)')).toBe(true);
    expect(mirrored.startsWith('translate(5%, 0%)')).toBe(true);
  });
});

describe('the settings document is what feeds all of it', () => {
  it('carries a Rust document end to end into the rendered stage', () => {
    // The exact document Rust stores, through the real adapter, into the real
    // producer, into the real layer. Every value non-default.
    const settings = listenerFromRust({ dimPercent: 62, blurPx: 8, saturation: 0.4 });
    const overrides: ListenerGeometryOverrides = {
      dimPercent: settings.dimPercent,
      blurPx: settings.blurPx,
      saturationPercent: Math.round(settings.saturation * 100),
    };
    expect(opacity(overrides)).toBeCloseTo(0.38, 6);
    expect(filter(overrides)).toBe('saturate(0.4) blur(8px)');
  });

  it('renders the shipped look when the document says nothing', () => {
    const settings = listenerFromRust(undefined);
    const overrides: ListenerGeometryOverrides = {
      dimPercent: settings.dimPercent,
      blurPx: settings.blurPx,
      saturationPercent: Math.round(settings.saturation * 100),
    };
    expect(opacity(overrides)).toBeCloseTo(0.6, 6);
    expect(filter(overrides)).toBe('saturate(0.85) blur(0px)');
  });
});
