/**
 * Store-based route machine (spec §10, §45.1). Routes mirror the spec's
 * route list; navigation runs registered guards so unsaved conflicts and
 * active sessions can block a transition.
 */
import { get, writable, type Readable } from 'svelte/store';

export type SettingsSection =
  | 'general'
  | 'openai'
  | 'audio'
  | 'teleprompter'
  | 'commands'
  | 'listeners'
  | 'privacy';

export type LibraryView = 'all' | 'recent' | 'trash';

export type Route =
  | { name: 'welcome' }
  | { name: 'library'; view: LibraryView }
  | { name: 'editor'; scriptId: string }
  | { name: 'preflight'; scriptId: string }
  | { name: 'live'; sessionId: string; scriptId: string }
  | { name: 'settings'; section: SettingsSection };

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
