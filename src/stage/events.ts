/**
 * Stage event bridge. In Tauri, subscriptions use the core event API (the
 * only privilege the stage capability grants). In the browser preview
 * (?preview=1 / plain `vite dev`), a local EventTarget stands in so the
 * preview driver can feed the same protocol.
 *
 * Outbound emits additionally require `core:event:allow-emit` in
 * src-tauri/capabilities/stage.json. Until integration adds it, emits fail
 * softly: they are caught, logged once, and never break rendering.
 */
import { listen, emit } from '@tauri-apps/api/event';
import type { StageEventName } from '../shared/contracts';

export const isTauri: boolean =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

const localBus = new EventTarget();

/** Preview driver entry point: locally dispatch an inbound stage event. */
export function dispatchLocalStageEvent<T>(name: StageEventName, payload: T): void {
  localBus.dispatchEvent(new CustomEvent(name, { detail: payload }));
}

export type Unsubscribe = () => void;

export async function subscribeStageEvent<T>(
  name: StageEventName,
  handler: (payload: T) => void,
): Promise<Unsubscribe> {
  if (isTauri) {
    return listen<T>(name, (event) => handler(event.payload));
  }
  const fn = (event: Event) => handler((event as CustomEvent<T>).detail);
  localBus.addEventListener(name, fn);
  return () => localBus.removeEventListener(name, fn);
}

let emitBlockedWarned = false;

/**
 * Fire-and-forget emit toward Rust; never throws (spec §40.5 spirit).
 *
 * S1: this is `emit`, not `emitTo`, and that is deliberate — but it means every
 * emission is a BROADCAST. Tauri's manager fans a webview `emit` out to the JS
 * listeners of every webview *and* to the Rust `listen_any` handlers, and a JS
 * listener registered with the default target (`Any`) matches unconditionally,
 * so no `emitTo` target can exclude it (`match_any_or_filter`,
 * tauri/src/event/listener.rs). Narrowing the target here would not have helped.
 *
 * The consequence a caller has to respect: an event the stage emits must NOT
 * share a name with an event control listens for, or control receives it twice
 * — once straight from the stage with no generation check, and once from the
 * Rust relay. `escapePressed`/`motionReport` exist for exactly that reason; see
 * the note in src/shared/contracts/stage.ts.
 */
export function emitStageEvent<T>(name: StageEventName, payload: T): void {
  if (!isTauri) {
    // Preview: surface outbound traffic in the console for manual testing.
    console.debug('[stage → control]', name, payload);
    localBus.dispatchEvent(new CustomEvent(`out:${name}`, { detail: payload }));
    return;
  }
  void emit(name, payload).catch((error) => {
    if (!emitBlockedWarned) {
      emitBlockedWarned = true;
      console.warn(
        `Stage emit for "${name}" was rejected — the stage capability likely ` +
          'needs core:event:allow-emit (integration follow-up).',
        error,
      );
    }
  });
}
