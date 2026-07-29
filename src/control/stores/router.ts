/**
 * Store-based route machine (spec §10, §45.1). Routes mirror the spec's
 * route list; navigation runs registered guards so unsaved conflicts and
 * active sessions can block a transition.
 */
import { get, writable, type Readable } from 'svelte/store';

export type SettingsSection =
  | 'general'
  | 'speech'
  | 'audio'
  | 'stage'
  | 'teleprompter'
  /** Companion §47 follow settings. */
  | 'following'
  | 'privacy';

export type LibraryView = 'all' | 'recent' | 'trash';

/**
 * There is no route between Editor and Live. Present opens the stage directly
 * (`lib/start-take.ts`); what the old Preflight page configured is in Settings.
 *
 * `calibrate` is the one exception to "everything is set in Settings", and it
 * earns it by being the only screen that DRIVES THE RIG: it opens a real stage
 * window on the real panel and asks the presenter what they can see through the
 * glass. That is a sequence with a beginning and an end rather than a page of
 * controls, and it holds a live stage window while it runs — so it is a route
 * that can be entered and left, not a disclosure inside a section. It carries
 * the panel it is calibrating rather than reading it back out of settings,
 * because the display can change while the wizard is open.
 */
export type Route =
  | { name: 'welcome' }
  | { name: 'library'; view: LibraryView }
  | { name: 'editor'; scriptId: string }
  | { name: 'live'; sessionId: string; scriptId: string }
  | { name: 'settings'; section: SettingsSection }
  | { name: 'calibrate'; displayFingerprint: string; rigName: string };

export type NavigationGuard = (to: Route, from: Route) => boolean | Promise<boolean>;

const routeStore = writable<Route>({ name: 'library', view: 'all' });

/** Read-only route store for components. */
export const route: Readable<Route> = { subscribe: routeStore.subscribe };

const guards = new Set<NavigationGuard>();

/** Register a guard; returns an unregister function. */
export function registerNavigationGuard(guard: NavigationGuard): () => void {
  guards.add(guard);
  return () => guards.delete(guard);
}

/** Navigate, honoring guards. Resolves true when the transition happened. */
export async function navigate(to: Route): Promise<boolean> {
  const from = get(routeStore);
  for (const guard of guards) {
    const allowed = await guard(to, from);
    if (!allowed) return false;
  }
  routeStore.set(to);
  return true;
}

/** Initial-route setter used once at startup (bypasses guards). */
export function setInitialRoute(to: Route): void {
  routeStore.set(to);
}

export function currentRoute(): Route {
  return get(routeStore);
}
