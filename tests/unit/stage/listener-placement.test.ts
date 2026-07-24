/**
 * Listener placement (spec §37.4) — the four modes that were built and
 * unreachable.
 *
 * `placement` was hard-coded to 'background' in the producer, so `lens_left`,
 * `lens_right`, `top_strip` and `pip` existed only as CSS rules nothing could
 * select, and `anchorX` / `anchorY` / `scale` were constants no reader ever
 * saw. A test that only asserted the picker renders would have proved nothing
 * about any of that, so these go end to end: a placement chosen in the producer
 * has to arrive at the stage AND change the box the stage draws.
 *
 * The layer is rendered with `svelte/server` rather than mounted, for the same
 * reason tests/unit/stage/degradation.test.ts does: the media box's geometry is
 * inline style, which SSR emits verbatim, and no video pipeline is needed to
 * read it.
 */
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import ListenerLayer from '../../../src/stage/listener/ListenerLayer.svelte';
import {
  LISTENER_PLACEMENTS,
  defaultPlacementGeometry,
  listenerLensTarget,
  listenerOverlapsScriptColumn,
  listenerPlacementBox,
  listenerPlacementDescriptor,
} from '../../../src/shared/listener/placement';
import {
  buildListenerGeometry,
  buildListenerSelection,
} from '../../../src/control/services/listeners';
import type { ListenerPlacementMode, ListenerStageSelection } from '../../../src/shared/contracts';

const SELECTABLE: ListenerPlacementMode[] = [
  'background',
  'lens_left',
  'lens_right',
  'top_strip',
  'pip',
];

/**
 * The REAL producer, not a hand-built selection: `buildListenerSelection` is
 * where `placement: 'background'` used to be hard-coded, so a test that
 * assembled its own `ListenerStageSelection` would pass with the bug still in
 * place. (It was written that way first, and the mutation check caught it.)
 */
async function selectionFor(
  placement: ListenerPlacementMode,
  overrides: Parameters<typeof buildListenerGeometry>[1] = {},
): Promise<ListenerStageSelection> {
  return buildListenerSelection('mira', '1.0.0', { placement, ...overrides });
}

/** The `style` attribute of the rendered media box. */
function mediaBoxStyle(selection: ListenerStageSelection): string {
  const markup = render(ListenerLayer, { props: { selection } }).body;
  const match = /class="media-box[^"]*"[^>]*style="([^"]*)"/.exec(markup);
  expect(match, 'the media box must render with inline geometry').not.toBeNull();
  return match![1]!;
}

function boxNumbers(style: string): { left: number; top: number; width: number; height: number } {
  const read = (property: string): number => {
    const match = new RegExp(`(?:^|;)\\s*${property}:\\s*([-\\d.]+)%`).exec(style);
    expect(match, `${property} must be an inline percentage: ${style}`).not.toBeNull();
    return Number(match![1]);
  };
  return { left: read('left'), top: read('top'), width: read('width'), height: read('height') };
}

describe('every placement mode reaches the stage', () => {
  it.each(SELECTABLE)('%s survives producer → selection → rendered box', async (placement) => {
    const selection = await selectionFor(placement);
    // The producer wrote it...
    expect(selection.geometry.placement).toBe(placement);
    // ...it reached the stage contract...
    expect(selection.placement).toBe(placement);
    const markup = render(ListenerLayer, { props: { selection } }).body;
    // ...and the layer rendered under it.
    expect(markup).toContain(`data-placement="${placement}"`);
  });

  it('gives each mode a geometrically distinct box', async () => {
    const boxes = await Promise.all(
      SELECTABLE.map(async (placement) => ({
        placement,
        box: boxNumbers(mediaBoxStyle(await selectionFor(placement))),
      })),
    );
    const seen = new Set(boxes.map((b) => JSON.stringify(b.box)));
    expect(seen.size, `two placements drew the same box: ${JSON.stringify(boxes)}`).toBe(
      SELECTABLE.length,
    );
  });

  /*
   * The mutation guard for the whole feature. Each assertion below is a
   * statement about WHERE the mode puts her that would fail if `placement` went
   * back to being hard-coded to 'background' — which is exactly what the bug
   * was.
   */
  it('puts a lens Listener beside the lens, not behind the text', async () => {
    const left = boxNumbers(mediaBoxStyle(await selectionFor('lens_left')));
    const right = boxNumbers(mediaBoxStyle(await selectionFor('lens_right')));
    const background = boxNumbers(mediaBoxStyle(await selectionFor('background')));

    expect(background).toEqual({ left: 0, top: 0, width: 100, height: 100 });

    // Neither lens box covers the stage, and they are mirror images of each
    // other about the centre line.
    expect(left.width).toBeLessThan(50);
    expect(right.width).toBeLessThan(50);
    expect(left.left).toBe(0);
    expect(right.left + right.width).toBeCloseTo(100, 6);
    expect(left.left + left.width / 2).toBeCloseTo(100 - (right.left + right.width / 2), 6);
    // And neither fills the height, so the script column is not overprinted.
    expect(left.height).toBeLessThan(100);
  });

  it('puts the strip above the script and the corner card below it', async () => {
    const strip = boxNumbers(mediaBoxStyle(await selectionFor('top_strip')));
    const pip = boxNumbers(mediaBoxStyle(await selectionFor('pip')));
    expect(strip.top).toBe(0);
    expect(strip.width).toBe(100);
    expect(strip.height).toBeLessThan(50);
    // Bottom-right, clear of both edges of the stage.
    expect(pip.left).toBeGreaterThan(50);
    expect(pip.top).toBeGreaterThan(50);
    expect(pip.left + pip.width).toBeLessThanOrEqual(100);
    expect(pip.top + pip.height).toBeLessThanOrEqual(100);
  });

  it('renders nothing at all for the off mode', async () => {
    const selection = { ...(await selectionFor('background')), placement: 'off' as const };
    expect(render(ListenerLayer, { props: { selection } }).body).not.toContain('listener-layer');
  });

  it('keeps the background scrim to the one mode that sits behind the text', async () => {
    expect(
      render(ListenerLayer, { props: { selection: await selectionFor('background') } }).body,
    ).toContain('scrim');
    for (const placement of SELECTABLE.filter((p) => p !== 'background')) {
      expect(
        render(ListenerLayer, { props: { selection: await selectionFor(placement) } }).body,
      ).not.toContain('scrim');
    }
  });
});

describe('placement geometry', () => {
  it('anchors each mode where its own descriptor says, not at a shared constant', () => {
    // The producer used to write (0.5, 0.45) for every mode — only 'background'
    // ignores the anchor, so every other mode would have landed centre-stage,
    // behind the script.
    const anchors = SELECTABLE.map((p) => defaultPlacementGeometry(p));
    expect(new Set(anchors.map((a) => `${a.anchorX},${a.anchorY}`)).size).toBeGreaterThan(1);
    for (const placement of SELECTABLE) {
      const geometry = buildListenerGeometry(1.15, { placement });
      const descriptor = listenerPlacementDescriptor(placement);
      expect(geometry.anchorX).toBe(descriptor.anchorX);
      expect(geometry.anchorY).toBe(descriptor.anchorY);
    }
  });

  it('scales the box about its anchor and never off the stage', () => {
    for (const placement of SELECTABLE.filter((p) => p !== 'background')) {
      for (const scale of [0.5, 1, 1.5, 4]) {
        const box = listenerPlacementBox(placement, { scale });
        expect(box.left).toBeGreaterThanOrEqual(0);
        expect(box.top).toBeGreaterThanOrEqual(0);
        expect(box.left + box.width).toBeLessThanOrEqual(1 + 1e-9);
        expect(box.top + box.height).toBeLessThanOrEqual(1 + 1e-9);
      }
      // A bigger scale really is a bigger box. Compared by AREA, because
      // top_strip is already full width and can only grow downwards.
      const area = (scale: number): number => {
        const box = listenerPlacementBox(placement, { scale });
        return box.width * box.height;
      };
      expect(area(1.5)).toBeGreaterThan(area(1));
      expect(area(0.5)).toBeLessThan(area(1));
    }
  });

  it('refuses to let a scaled background uncover the stage behind it', () => {
    for (const scale of [0.2, 1, 3]) {
      expect(listenerPlacementBox('background', { scale })).toEqual({
        left: 0,
        top: 0,
        width: 1,
        height: 1,
      });
    }
  });

  it('survives a malformed geometry without emitting NaN into CSS', () => {
    const box = listenerPlacementBox('pip', {
      scale: Number.NaN,
      anchorX: Number.NaN,
      anchorY: Number.POSITIVE_INFINITY,
    });
    for (const value of Object.values(box)) expect(Number.isFinite(value)).toBe(true);
  });

  it('falls back to background for an unknown persisted placement', () => {
    const unknown = 'lens_up' as ListenerPlacementMode;
    expect(listenerPlacementDescriptor(unknown).id).toBe('background');
    expect(listenerPlacementBox(unknown)).toEqual({ left: 0, top: 0, width: 1, height: 1 });
  });

  it('never offers "off" as a placement choice', () => {
    // "No Listener" is the pack picker's job; a placement list that can also
    // mean "none" is two controls wearing one hat.
    expect(LISTENER_PLACEMENTS.map((p) => p.id)).not.toContain('off');
    expect(LISTENER_PLACEMENTS.map((p) => p.id).sort()).toEqual([...SELECTABLE].sort());
  });

  /*
   * The honest half of the lens modes. A panel wide enough to hold a face
   * reaches ~30% of the stage, and the default script column spans 11%-89%, so
   * they overlap unless the column is narrowed. Rather than shipping picker
   * copy that claims "clear of the text", Preflight says so and names the
   * control that fixes it — and no descriptor may make the claim either.
   */
  it('reports the overlap between a lens panel and the script column', () => {
    expect(listenerOverlapsScriptColumn('lens_left', 78)).toBe(true);
    expect(listenerOverlapsScriptColumn('lens_right', 78)).toBe(true);
    // Narrow the column past the panel and the overlap is gone.
    expect(listenerOverlapsScriptColumn('lens_left', 38)).toBe(false);
    expect(listenerOverlapsScriptColumn('lens_right', 38)).toBe(false);
    // A wider panel needs a narrower column.
    expect(listenerOverlapsScriptColumn('lens_left', 38, { scale: 1.6 })).toBe(true);
    // Only the lens modes make the claim, so only they can break it.
    for (const placement of ['background', 'top_strip', 'pip'] as const) {
      expect(listenerOverlapsScriptColumn(placement, 78)).toBe(false);
    }
  });

  it('never claims a lens panel is clear of the text', () => {
    for (const descriptor of LISTENER_PLACEMENTS) {
      expect(`${descriptor.summary} ${descriptor.eyeline}`).not.toContain('clear of the text');
    }
  });

  it('describes every mode in terms of where the presenter should look', () => {
    for (const descriptor of LISTENER_PLACEMENTS) {
      expect(descriptor.label.length).toBeGreaterThan(0);
      expect(descriptor.summary.length).toBeGreaterThan(0);
      expect(descriptor.eyeline.length).toBeGreaterThan(0);
      expect(descriptor.eyeline).not.toBe(descriptor.summary);
    }
  });
});

describe('listenerLensTarget — where the presenter should look', () => {
  const centred = { cropX: 0, cropY: 0, cropZoom: 1.15 };

  it('lands inside the placement box, on the stage', () => {
    for (const placement of SELECTABLE) {
      const target = listenerLensTarget(placement, centred);
      const box = listenerPlacementBox(placement, {});
      expect(target.x).toBeGreaterThanOrEqual(box.left);
      expect(target.x).toBeLessThanOrEqual(box.left + box.width);
      expect(target.y).toBeGreaterThanOrEqual(box.top);
      expect(target.y).toBeLessThanOrEqual(box.top + box.height);
    }
  });

  it('separates the two lens modes across the stage centre line', () => {
    expect(listenerLensTarget('lens_left', centred).x).toBeLessThan(0.5);
    expect(listenerLensTarget('lens_right', centred).x).toBeGreaterThan(0.5);
  });

  it('moves with the crop offset, scaled by the box the crop lives in', () => {
    // 10% of the frame inside a 30%-wide box is 3% of the stage — the
    // composition is the reason this function exists rather than either half
    // alone.
    const shifted = { cropX: 10, cropY: 0, cropZoom: 1.5 };
    const before = listenerLensTarget('lens_left', { ...shifted, cropX: 0 });
    const after = listenerLensTarget('lens_left', shifted);
    expect(after.x - before.x).toBeCloseTo(0.3 * 0.1, 6);
    // On the full-stage background the same offset moves the full 10%.
    const bgBefore = listenerLensTarget('background', { ...shifted, cropX: 0 });
    const bgAfter = listenerLensTarget('background', shifted);
    expect(bgAfter.x - bgBefore.x).toBeCloseTo(0.1, 6);
  });

  it('is not moved by mirroring the video', () => {
    expect(listenerLensTarget('lens_right', { cropX: 5, cropY: 0, cropZoom: 1.5 })).toEqual(
      listenerLensTarget('lens_right', {
        cropX: 5,
        cropY: 0,
        cropZoom: 1.5,
        mirrorVideo: true,
      }),
    );
  });
});
