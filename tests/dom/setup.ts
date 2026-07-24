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
