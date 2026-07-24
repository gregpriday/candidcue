/**
 * Listener framing geometry (spec §37, §40) — the single source of truth for
 * how the "move Mira around the frame" controls map onto a CSS transform.
 * Pure logic: no DOM, no Svelte. Both the producer
 * (src/control/services/listeners.ts) and the consumer
 * (src/stage/listener/ListenerLayer.svelte) import from here so the unit
 * contract cannot drift between them again.
 *
 * UNIT CONTRACT
 * -------------
 * `cropX` / `cropY` are PERCENT of the media box (the visible listener frame),
 * NOT a 0..1 fraction. `cropX = 7` means "shift the clip 7% of the frame width
 * to the right". Positive x = right, positive y = down. They are fed verbatim
 * into `translate(cropX%, cropY%)`.
 *
 * TRANSFORM ORDER
 * ---------------
 *     translate(cropX%, cropY%) scale(cropZoom) scaleX(mirror)
 *
 * CSS applies a transform list right-to-left, so the mirror flips first, the
 * zoom scales that, and the translate is applied LAST, in unscaled frame
 * coordinates. Both parts of that order are deliberate:
 *
 *   - translate OUTSIDE scale: the offset means the same thing at every zoom
 *     level. With `scale(z) translate(x%)` the translate is composed first and
 *     then scaled, so the on-screen offset would be silently multiplied by z.
 *   - mirror INSIDE translate: with the mirror applied to an outer wrapper the
 *     `scaleX(-1)` negates the offset and "move right" moves her left.
 *
 * (The Electron predecessor composed the same order:
 * `translateY(y%) scale(z) scaleX(mirror)`.)
 *
 * SAFE RANGE
 * ----------
 * Clips are `object-fit: cover`, so at zoom z the media overhangs the frame by
 * (z-1)/2 of the frame size on each side. Offsetting further pulls the media
 * edge into view (black bars). The usable range is therefore
 * ±(z-1)/2 × 100 percent, and it GROWS WITH ZOOM — at the pack default zoom
 * 1.15 it is ±7.5%, at 1.5 it is ±25%. To reposition further, zoom in.
 * At z <= 1 there is no slack at all and the only safe offset is 0.
 */

/** The subset of `ListenerGeometry` that the crop transform depends on. */
export interface ListenerCropGeometry {
  /** Percent of the frame width; positive = right. */
  cropX: number;
  /** Percent of the frame height; positive = down. */
  cropY: number;
  /** Scale factor applied on top of `object-fit: cover` (1 = no zoom). */
  cropZoom: number;
  /** Horizontal mirror, applied inside the crop so it never flips the offset. */
  mirrorVideo?: boolean;
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/** Coerce a possibly-absent/NaN number to a finite value. */
function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Largest offset (percent of the frame) that keeps the media edge outside the
 * frame at this zoom. Zero when the clip has no overhang to spend.
 */
export function maxSafeOffsetPercent(cropZoom: number): number {
  const zoom = finite(cropZoom, 1);
  if (zoom <= 1) return 0;
  return round3(((zoom - 1) / 2) * 100);
}

/** Clamp one axis offset into the zoom-derived safe window. */
export function clampOffsetPercent(offsetPercent: number, cropZoom: number): number {
  const limit = maxSafeOffsetPercent(cropZoom);
  const value = finite(offsetPercent, 0);
  if (value > limit) return limit;
  if (value < -limit) return -limit;
  return round3(value);
}

/**
 * The safe bound rounded DOWN to a slider-friendly tenth, so a slider pinned
 * to its own maximum can never land a hair outside the safe window.
 */
export function offsetSliderBound(cropZoom: number): number {
  return Math.floor(maxSafeOffsetPercent(cropZoom) * 10) / 10;
}

/**
 * Compose the crop transform. See the transform-order note above — this is the
 * only place the order is decided.
 */
export function listenerCropTransform(geometry: ListenerCropGeometry): string {
  const zoom = finite(geometry.cropZoom, 1);
  const x = clampOffsetPercent(geometry.cropX, zoom);
  const y = clampOffsetPercent(geometry.cropY, zoom);
  const mirror = geometry.mirrorVideo ? -1 : 1;
  return `translate(${x}%, ${y}%) scale(${round3(zoom)}) scaleX(${mirror})`;
}

/**
 * Where the clip's visible centre lands, in frame coordinates (0.5, 0.5 = the
 * middle of the frame). Used by lens-target calibration and by tests as an
 * order-independent statement of what the transform is supposed to do.
 */
export function listenerFocusPoint(geometry: ListenerCropGeometry): { x: number; y: number } {
  const zoom = finite(geometry.cropZoom, 1);
  return {
    x: round3(0.5 + clampOffsetPercent(geometry.cropX, zoom) / 100),
    y: round3(0.5 + clampOffsetPercent(geometry.cropY, zoom) / 100),
  };
}
