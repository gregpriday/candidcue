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

/** Fire-and-forget emit toward control; never throws (spec §40.5 spirit). */
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
