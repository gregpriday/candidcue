/**
 * Listener placement (spec §37.4) — where on the stage the Listener's frame
 * sits, and where the presenter should be looking when it is there.
 *
 * This is the single source of truth for placement geometry. It used to live
 * only in `ListenerLayer.svelte`'s stylesheet, which meant the four non-default
 * modes could not be described, previewed, or tested — and, because nothing
 * could set `placement`, could not be reached at all. Expressing the boxes as
 * plain numbers here lets the stage layer, the Preflight picker and the tests
 * all agree by construction rather than by inspection.
 *
 * COORDINATES
 * -----------
 * Everything is a FRACTION OF THE STAGE (0..1), origin top-left. `anchorX` /
 * `anchorY` name the CENTRE of the media box; the box is emitted as
 * left/top/width/height so the layer needs no centring transform. That matters:
 * the crop layer inside the box already owns a transform (see geometry.ts), and
 * a second one on the box would compose with it in ways nobody could predict
 * from either file alone.
 *
 * SCALE
 * -----
 * `ListenerGeometry.scale` multiplies the box's size about its anchor. The
 * result is clamped into the stage, so a large scale grows the box until it
 * fills the stage rather than hanging off the edge. `background` ignores scale
 * and anchor entirely — it IS the stage.
 */
import type { ListenerGeometry, ListenerPlacementMode } from '../contracts/listener';
import { listenerFocusPoint, type ListenerCropGeometry } from './geometry';

/** A media box in stage fractions, origin top-left. */
export interface ListenerBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The placement-dependent half of `ListenerGeometry`. */
export interface ListenerPlacementGeometry {
  anchorX: number;
  anchorY: number;
  scale: number;
}

export interface ListenerPlacementDescriptor {
  id: ListenerPlacementMode;
  /** Picker label. */
  label: string;
  /** What the mode does, in one line. */
  summary: string;
  /** Where the presenter's eyes end up — the reason to choose this mode. */
  eyeline: string;
  /** Default box size, as a fraction of the stage. */
  width: number;
  height: number;
  /** Default box centre. */
  anchorX: number;
  anchorY: number;
}

/**
 * The five renderable modes, in picker order. `off` is deliberately absent:
 * "no Listener" is expressed by not selecting a pack, and a placement picker
 * that can also mean "none" is two controls wearing one hat.
 *
 * The vertical anchors are not decoration. A teleprompter's reading band sits
 * around 38% of the stage height, so a Listener centred near 45% keeps the
 * presenter's eyeline within a few degrees of the line they are reading — which
 * is the entire point of the lens modes.
 */
export const LISTENER_PLACEMENTS: readonly ListenerPlacementDescriptor[] = [
  {
    id: 'background',
    label: 'Behind the script',
    summary: 'Fills the stage; the script reads over the top of her.',
    eyeline: 'You look at the script, and she is already there. Best when the lens sits behind the glass, dead centre.',
    width: 1,
    height: 1,
    anchorX: 0.5,
    anchorY: 0.5,
  },
  {
    id: 'lens_left',
    label: 'Beside the lens — left',
    summary: 'A tall panel against the left edge of the stage.',
    eyeline: 'Look left, at her, and the lens is right next to your eyeline. Use this when the camera is to the left of the display.',
    width: 0.3,
    height: 0.62,
    anchorX: 0.15,
    anchorY: 0.45,
  },
  {
    id: 'lens_right',
    label: 'Beside the lens — right',
    summary: 'A tall panel against the right edge of the stage.',
    eyeline: 'Look right, at her, and the lens is right next to your eyeline. Use this when the camera is to the right of the display.',
    width: 0.3,
    height: 0.62,
    anchorX: 0.85,
    anchorY: 0.45,
  },
  {
    id: 'top_strip',
    label: 'Above the script',
    summary: 'A full-width band across the top of the stage.',
    eyeline: 'Lifts your eyeline above the text — the natural choice for a camera mounted on top of the display.',
    width: 1,
    height: 0.34,
    anchorX: 0.5,
    anchorY: 0.17,
  },
  {
    id: 'pip',
    label: 'Corner card',
    summary: 'A small card in the bottom-right corner.',
    eyeline: 'Keeps her out of the way. Your eyeline stays on the script, so use this when you want company rather than a place to look.',
    width: 0.17,
    height: 0.38,
    anchorX: 0.855,
    anchorY: 0.77,
  },
];

const DESCRIPTORS = new Map(LISTENER_PLACEMENTS.map((p) => [p.id, p]));

export function listenerPlacementDescriptor(
  placement: ListenerPlacementMode | undefined,
): ListenerPlacementDescriptor {
  return DESCRIPTORS.get(placement ?? 'background') ?? LISTENER_PLACEMENTS[0]!;
}

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const round4 = (value: number): number => Math.round(value * 10000) / 10000;

/**
 * The default anchors and scale for a placement — what `buildListenerGeometry`
 * writes when the caller does not override them. Kept here so the producer
 * cannot invent a fifth set of numbers.
 */
export function defaultPlacementGeometry(
  placement: ListenerPlacementMode | undefined,
): ListenerPlacementGeometry {
  const descriptor = listenerPlacementDescriptor(placement);
  return { anchorX: descriptor.anchorX, anchorY: descriptor.anchorY, scale: 1 };
}

/**
 * The media box for a placement, in stage fractions.
 *
 * `background` is the whole stage by definition — scale and anchor are ignored
 * rather than clamped, because a "background" that did not cover the background
 * would expose the stage behind it, which is the same class of failure the crop
 * zoom floor exists to prevent (geometry.ts).
 */
export function listenerPlacementBox(
  placement: ListenerPlacementMode | undefined,
  geometry?: Partial<ListenerPlacementGeometry>,
): ListenerBox {
  const descriptor = listenerPlacementDescriptor(placement);
  if (descriptor.id === 'background') return { left: 0, top: 0, width: 1, height: 1 };

  const scale = Math.max(0.1, finite(geometry?.scale, 1));
  const width = clamp01(descriptor.width * scale);
  const height = clamp01(descriptor.height * scale);
  const anchorX = clamp01(finite(geometry?.anchorX, descriptor.anchorX));
  const anchorY = clamp01(finite(geometry?.anchorY, descriptor.anchorY));

  // Centre on the anchor, then slide back inside the stage rather than
  // overhanging it: an off-stage box is invisible media the operator paid the
  // decode cost for.
  const left = Math.min(Math.max(anchorX - width / 2, 0), 1 - width);
  const top = Math.min(Math.max(anchorY - height / 2, 0), 1 - height);
  return { left: round4(left), top: round4(top), width: round4(width), height: round4(height) };
}

/**
 * Where on the stage the presenter should look: the point the Listener's own
 * framing puts her face at, expressed in stage coordinates.
 *
 * This is the composition the placement picker draws its "look here" marker
 * from — the media box says where her frame is, `listenerFocusPoint` says where
 * she is inside it, and the two are only meaningful together. Before this
 * existed `listenerFocusPoint` had no caller outside its own test and its
 * doc-comment claimed a consumer that had never been written.
 */
export function listenerLensTarget(
  placement: ListenerPlacementMode | undefined,
  geometry: ListenerCropGeometry & Partial<ListenerPlacementGeometry>,
): { x: number; y: number } {
  const box = listenerPlacementBox(placement, geometry);
  const focus = listenerFocusPoint(geometry);
  return {
    x: round4(box.left + box.width * focus.x),
    y: round4(box.top + box.height * focus.y),
  };
}

/**
 * Whether a placement's box overlaps the script column, given the column's
 * width as a percentage of the stage.
 *
 * Worth stating out loud: at the default column width of 78% the script spans
 * 11%-89% of the stage, and a lens panel wide enough to hold a face reaches
 * about 30% — so the two DO overlap unless the column is narrowed. Rather than
 * claim in the picker copy that the lens modes are "clear of the text", which
 * would be false for most users' defaults, Preflight says so and points at the
 * control that fixes it.
 */
export function listenerOverlapsScriptColumn(
  placement: ListenerPlacementMode | undefined,
  columnWidthPercent: number,
  geometry?: Partial<ListenerPlacementGeometry>,
): boolean {
  const mode = listenerPlacementDescriptor(placement).id;
  if (mode !== 'lens_left' && mode !== 'lens_right') return false;
  const width = finite(columnWidthPercent, 78) / 100;
  const columnLeft = (1 - clamp01(width)) / 2;
  const box = listenerPlacementBox(placement, geometry);
  return box.left < 1 - columnLeft && box.left + box.width > columnLeft;
}

/** CSS percentages for the media box, ready for inline styles. */
export function listenerBoxStyle(
  placement: ListenerPlacementMode | undefined,
  geometry: Partial<ListenerPlacementGeometry> | ListenerGeometry,
): { left: string; top: string; width: string; height: string } {
  const box = listenerPlacementBox(placement, geometry);
  return {
    left: `${round4(box.left * 100)}%`,
    top: `${round4(box.top * 100)}%`,
    width: `${round4(box.width * 100)}%`,
    height: `${round4(box.height * 100)}%`,
  };
}
