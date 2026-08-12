/**
 * Setup for the `dom` vitest project only (see vitest.dom.config.ts).
 *
 * Kept deliberately small. The one thing worth doing globally is tearing down
 * mounted components, because these tests assert on `document.activeElement`
 * and on `document.querySelectorAll('[role="dialog"]')` — a component left
 * mounted by a previous test would make the next one pass or fail for reasons
 * that have nothing to do with it.
 *
 * Note what is NOT here: no `expect` extension, no jest-dom. Assertions in
 * this project use plain DOM reads, so nothing mutates the shared `expect`.
 */
import { cleanup } from '@testing-library/svelte';
import { afterEach, expect } from 'vitest';

afterEach(() => {
  cleanup();
  // Belt and braces: `cleanup()` unmounts what testing-library rendered, but a
  // test that mounts by hand still owes an empty body to the next one.
  document.body.innerHTML = '';
});

/**
 * jsdom performs no layout, and `Range` is where that shows up as a crash
 * rather than a zero: `Range.prototype.getClientRects` is simply absent, so the
 * stage's line-map rebuild — which measures each token's rects to build the
 * unit→pixel path — throws "range.getClientRects is not a function" instead of
 * measuring nothing.
 *
 * That was invisible until the stage stopped needing a painted window to
 * measure: with the viewport falling back to `window.innerHeight`, the rebuild
 * now actually runs here, where before it returned at the `vh === 0` guard.
 *
 * The shim returns an EMPTY list, which is the truthful answer for an
 * environment with no layout — not a fabricated rectangle. Tests in this
 * project therefore must not assert on measured geometry; they assert that the
 * measurement path runs and terminates. Anything needing real rects belongs in
 * the browser E2E layer, which has a real engine.
 */
const emptyRects = (): DOMRectList => {
  const list = [] as unknown as DOMRectList;
  (list as unknown as { item: (i: number) => DOMRect | null }).item = () => null;
  return list;
};
if (typeof Range.prototype.getClientRects !== 'function') {
  Range.prototype.getClientRects = emptyRects;
}
if (typeof Range.prototype.getBoundingClientRect !== 'function') {
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
}

/**
 * `ResizeObserver`, which jsdom does not implement at all.
 *
 * Svelte 5 compiles `bind:clientWidth` into a `ResizeObserver`, so a component
 * that measures its own box — the editor's split pane does, to turn a pointer
 * drag into a fraction of the work area — threw `ResizeObserver is not defined`
 * out of its mount. That surfaced as an *unhandled error* rather than a test
 * failure: the route silently rendered nothing and six unrelated assertions
 * failed with "expected undefined to be truthy".
 *
 * The stub NEVER FIRES a callback, and that is the honest behaviour here: jsdom
 * performs no layout, so there are no size changes to report and any dimension
 * it invented would be a fiction. Bound sizes therefore stay 0 in this project,
 * exactly as `Range.getClientRects` above returns an empty list — tests here
 * assert that measurement paths run and terminate, never what they measured.
 * Real geometry belongs to the browser E2E layer.
 */
class NoLayoutResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = NoLayoutResizeObserver;
}

/**
 * Guard on the environment itself. If jsdom is ever swapped for `node` (or a
 * DOM shim that does not implement focus), these component tests would not
 * fail — `document.activeElement` would simply be undefined and every
 * assertion about focus would be written against nothing. This makes that a
 * loud failure at setup time.
 */
expect(typeof document, 'the dom project must run in a DOM environment').toBe('object');
expect(
  typeof HTMLElement.prototype.focus,
  'the DOM environment must implement HTMLElement.focus()',
).toBe('function');
