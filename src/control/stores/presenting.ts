/**
 * The black cover that spans a presentation transition.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT THE PLATE IN `StageApp`
 * ---------------------------------------------------------------------------
 * `StageApp` already has an opening plate, and it covers a real interval: the
 * font wait, the line-map measurement, the plant reaching the opening. But it
 * is rendered by `StageApp`, which means it does not exist until `StageApp`
 * mounts — and `StageApp` mounting is the expensive thing we are trying to keep
 * OFF the screen until the window has finished changing shape. A cover that
 * arrives with the thing it is meant to cover is not a cover.
 *
 * So this one lives in the shell, above every route, and it is raised BEFORE
 * anything moves. The two overlap on purpose: this covers window geometry
 * changing, the plate covers the script finding its position, and there is
 * never a frame owned by neither.
 *
 * It also owns `data-presenting` on the document element, which is what turns
 * the page canvas black. That matters independently of the cover: `body`'s
 * background is the workspace theme's porcelain (`--bg-app`), the stage's own
 * black comes from `.stage-root`, and an area the viewport has grown into but
 * the layout has not reached yet is painted by the canvas, not by either of
 * them.
 */
import { writable } from 'svelte/store';

/**
 * `opening` and `closing` are distinct from `on` because only the transitions
 * need the cover. Presentation itself must NOT be covered — the stage is the
 * thing the presenter is reading.
 */
export type PresentingPhase = 'off' | 'opening' | 'on' | 'closing';

const phase = writable<PresentingPhase>('off');

export const presentingPhase = { subscribe: phase.subscribe };

export function setPresentingPhase(next: PresentingPhase): void {
  phase.set(next);
}

/** The cover is up for both transitions and down for the steady states. */
export function coverIsUp(value: PresentingPhase): boolean {
  return value === 'opening' || value === 'closing';
}

/**
 * The canvas stays black for the whole take, not just the transitions.
 *
 * A take is not one geometry change but potentially several — the appearance
 * sheet does not resize the window, but an operator moving the app to another
 * display mid-session does, and so does a display waking up and renegotiating
 * its mode. Reverting the canvas the moment the opening finished would put the
 * white back for every one of those.
 */
export function canvasIsBlack(value: PresentingPhase): boolean {
  return value !== 'off';
}
