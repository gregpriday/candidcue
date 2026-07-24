/**
 * DOM / component test project (spec §55.1 layer 2).
 *
 * Deliberately a SEPARATE config from `vitest.config.ts`. The default project
 * runs ~2000 node-environment tests, and flipping `environment` globally would
 * slow them all down and change global scope under every existing suite. This
 * config owns `tests/dom/**` and nothing else; `vitest.config.ts` does not
 * include that directory, so the two never overlap.
 *
 * Why jsdom rather than happy-dom
 * ------------------------------------------------------------------
 * Every component this layer exists to cover is a FOCUS-management component:
 * Dialog's Tab trap and focus restore, OverflowMenu's roving-tabindex menu,
 * Toggle's `role="switch"`. happy-dom's focus model is an approximation — it
 * does not consistently reflect `:focus-visible`, `document.activeElement`
 * after a `focus()` on a detached-then-attached node, or `HTMLElement.focus()`
 * on elements without an explicit tabindex. jsdom implements the focus
 * algorithm from the HTML spec including the `disabled` and `inert` cases,
 * which is precisely what the accessibility fixes under test depend on.
 * Raw speed is not the constraint here — this project is a few dozen tests.
 *
 * Why NO @testing-library/jest-dom
 * ------------------------------------------------------------------
 * `jest-dom` extends chai/expect at import time. In this repo that has
 * historically produced "Invalid Chai property: toBeInTheDocument" whenever
 * more than one DOM file shared a worker, because the extension is registered
 * against one `expect` instance and asserted against another. The matchers buy
 * nothing that `expect(el.getAttribute('aria-checked')).toBe('true')` does not
 * already say more precisely, so the dependency is simply not taken. The whole
 * directory therefore runs in a single `vitest run` invocation with no
 * per-file isolation workaround.
 */
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [svelte()],
  // Svelte 5 ships separate server/client entry points. Without the browser
  // condition Vite resolves the SSR build, `mount()` throws
  // "lifecycle_function_unavailable", and every test in this project fails
  // with the same unhelpful error.
  resolve: {
    conditions: ['browser'],
  },
  test: {
    name: 'dom',
    include: ['tests/dom/**/*.test.ts'],
    environment: 'jsdom',
    globals: false,
    setupFiles: ['tests/dom/setup.ts'],
  },
});
