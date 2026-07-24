/**
 * §10 recent-event ribbon.
 *
 * Two properties matter more than anything else here:
 *
 *  1. **Position is a function of the event's own timestamps** — never of when
 *     the stage first saw it. A precision-transcription result that lands eight
 *     seconds late therefore appears where the speech was, already scrolled
 *     leftward, and fades in there (§10.4). "Jump to now" is not a bug we have
 *     to avoid; it is a shape the code cannot express.
 *  2. **Shape carries the meaning, colour only reinforces it** (§10.3, §7.6).
 *     Strip every colour and a confirmed filler is still a solid full-height
 *     tick, a probable one is still hollow, a repetition is still a double tick.
 *
 * §10.5: the default ribbon is speech activity, confirmed fillers, and the
 * current-time edge. It is not an oscilloscope.
 */
import type {
  CoachRailMode,
  CoachRibbonEvent,
  CoachRibbonEventType,
} from '../../../shared/contracts/coaching';

/** §10.2 window per mode. */
export const RIBBON_WINDOW_COACH_MS = 20_000;
export const RIBBON_WINDOW_STUDIO_MS = 30_000;

export function ribbonWindowMs(mode: CoachRailMode): number {
  return mode === 'studio' ? RIBBON_WINDOW_STUDIO_MS : RIBBON_WINDOW_COACH_MS;
}

/** §10.4 fade-in for a mark the stage has not drawn before (150–250 ms). */
export const RIBBON_ARRIVAL_FADE_MS = 200;

/**
 * §10.3. One shape per event type, all distinguishable without colour:
 * a `trace` is a wide low bar, `tick` a solid full-height rule, `hollow-tick`
 * an outlined one, `double-tick` a pair, `gap` a thin centred line inside the
 * silence, `hook` a small backward-facing hook, `diamond` a rotated square, and
 * `top-block` a short bar clamped to the top edge.
 */
export type RibbonShape =
  | 'trace'
  | 'tick'
  | 'hollow-tick'
  | 'double-tick'
  | 'gap'
  | 'hook'
  | 'diamond'
  | 'top-block';

export const RIBBON_SHAPE: Record<CoachRibbonEventType, RibbonShape> = {
  speech: 'trace',
  confirmed_filler: 'tick',
  probable_filler: 'hollow-tick',
  repetition: 'double-tick',
  pause: 'gap',
  retake: 'hook',
  critical_mismatch: 'diamond',
  clipping: 'top-block',
};

/** Shapes that occupy their event's whole interval rather than a point in it. */
const SPANNING_SHAPES: ReadonlySet<RibbonShape> = new Set<RibbonShape>(['trace', 'gap', 'top-block']);

const DEFAULT_TYPES: readonly CoachRibbonEventType[] = ['speech', 'confirmed_filler'];
const STUDIO_TYPES: readonly CoachRibbonEventType[] = [
  'speech',
  'confirmed_filler',
  'probable_filler',
  'repetition',
  'pause',
  'retake',
  'critical_mismatch',
  'clipping',
];

/** §10.5 restraint. Everything beyond the default set is a Studio-mode option. */
export function ribbonTypesFor(mode: CoachRailMode): ReadonlySet<CoachRibbonEventType> {
  return new Set(mode === 'studio' ? STUDIO_TYPES : DEFAULT_TYPES);
}

export interface RibbonMark {
  eventId: string;
  type: CoachRibbonEventType;
  shape: RibbonShape;
  /** Percentage of the ribbon width; 100 is the current-time edge. */
  leftPercent: number;
  /** Percentage width for spanning shapes; `0` for point markers. */
  widthPercent: number;
}

/**
 * Lay events out against a window whose right edge is `nowMs`.
 *
 * Positions are *not* clamped into the window. An event that has aged past the
 * left edge yields a negative `leftPercent` and is dropped; an event still
 * within it keeps whatever fraction of the window it actually occupies. The
 * caller clips with `overflow: hidden` rather than by moving anything.
 */
export function layoutRibbon(
  events: readonly CoachRibbonEvent[],
  nowMs: number,
  windowMs: number,
  allowed: ReadonlySet<CoachRibbonEventType>,
): RibbonMark[] {
  const windowStartMs = nowMs - windowMs;
  const marks: RibbonMark[] = [];
  for (const event of events) {
    if (!allowed.has(event.type)) continue;
    if (event.endMs < windowStartMs) continue;
    const shape = RIBBON_SHAPE[event.type];
    const leftPercent = ((event.startMs - windowStartMs) / windowMs) * 100;
    const spanPercent = SPANNING_SHAPES.has(shape)
      ? (Math.max(0, event.endMs - event.startMs) / windowMs) * 100
      : 0;
    // A mark whose whole span is off the left edge is gone; a span that
    // straddles the edge keeps its true left and is clipped by the container.
    if (leftPercent + spanPercent < 0) continue;
    marks.push({
      eventId: event.eventId,
      type: event.type,
      shape,
      leftPercent,
      widthPercent: spanPercent,
    });
  }
  return marks;
}
