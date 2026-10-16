/**
 * Monotonic wall clock. `Date.now()` is subject to NTP steps and manual clock
 * changes; a backward step inflates every subsequent age measurement and a
 * forward one hides real staleness.
 */
export function monotonicNowMs(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}
