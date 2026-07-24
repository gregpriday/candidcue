/**
 * The stage's Coaching Rail (§6–§11).
 *
 * The mount site needs exactly two things from here:
 *
 * ```svelte
 * import CoachRail from './renderer/coach/CoachRail.svelte';
 * import { coachRailScriptInsetPx } from './renderer/coach';
 * ```
 *
 * — the component, and the inset the script layer must give up for it. Both
 * read the same geometry, so the band and the hole left for it cannot drift.
 * Everything else exported here exists for tests and for the post-take review
 * screen, which formats the same telemetry.
 */
export * from './railGeometry';
export * from './railClock';
export * from './paceTile';
export * from './deliveryScore';
export * from './statusText';
export * from './activeTip';
export * from './ribbon';
export * from './presenter';
