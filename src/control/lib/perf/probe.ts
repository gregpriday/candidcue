/**
 * The benchmark build's marks (issue #240), and nothing in any other build.
 *
 * `window.__SPEAKING_GLASS_PERF__` is set by Rust's `perf` plugin, and it is
 * `true` only in an app built under the benchmark identifier AND launched by
 * `scripts/perf-run.mjs` (see `src-tauri/src/perf.rs` for why both). In every
 * build people use it is `false`, so each function here is one property read
 * and a return: no observer, no timer, no buffer, no IPC.
 *
 * This file is imported statically by `main.ts` and `App.svelte`, so it stays
 * tiny. Everything that measures — the scenario, its waits, its frame sampler
 * and its fixture — is in `scenario.ts`, which only an armed launch loads.
 */
import { tick } from 'svelte';

declare global {
  interface Window {
    __SPEAKING_GLASS_PERF__?: boolean;
  }
}

/** Is this launch a benchmark run? */
export function perfArmed(): boolean {
  return typeof window !== 'undefined' && window.__SPEAKING_GLASS_PERF__ === true;
}

/** The launch milestones, on the page clock (ms since navigation start). */
export type LaunchMark = 'entry' | 'mounted' | 'ready';

const marks = new Map<LaunchMark, number>();

/**
 * Record a launch milestone. Also a `performance.mark`, so Web Inspector's
 * timeline shows the same points the report does.
 */
export function perfMark(name: LaunchMark): void {
  if (!perfArmed() || marks.has(name)) return;
  marks.set(name, performance.now());
  try {
    performance.mark(`speaking-glass:${name}`);
  } catch {
    // An engine without User Timing still has the number above.
  }
}

/** A milestone's time, if it was recorded. For the scenario's launch record. */
export function perfMarkTime(name: LaunchMark): number | undefined {
  return marks.get(name);
}

/**
 * The shell is up: mark the first painted frame after it, and start the
 * scenario. Called once, from `App.svelte`, right after `ready = true`.
 *
 * `tick()` puts the route Svelte has just chosen into the DOM; the first
 * animation frame after that is the one that paints it, and the second
 * callback runs only once that paint has happened. That frame is "ready": the
 * window shows something a person can act on. The scenario then checks that
 * what is showing is what it expected (Welcome on a fresh profile, the
 * Library with the fixture on a relaunch) before it believes the number.
 */
export function perfShellReady(): void {
  if (!perfArmed()) return;
  void (async () => {
    await tick();
    await nextFrame();
    await nextFrame();
    perfMark('ready');
    const { runScenario } = await import('./scenario');
    await runScenario();
  })();
}

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}
