/**
 * The channel for commands only the mounted route can carry out.
 *
 * Most commands are answerable from the shell: it can navigate, it can call a
 * store, it can flip a workspace flag. A handful cannot, because what they do
 * lives inside a component's own instance — Find opens CodeMirror's search
 * panel, Rename focuses the title field, Stage Appearance opens a sheet that
 * belongs to Live. The shell has no reference to any of those and should not
 * grow one: a shell holding component handles is a shell that has to know which
 * route is mounted, which is the coupling the router exists to remove.
 *
 * So the shell publishes and the route subscribes, exactly as `shortcuts.ts`
 * already does for keys. A command with no listener is DROPPED, silently and on
 * purpose: the only way to reach that state is a command dispatched at a route
 * that does not own it, and the availability predicate in `lib/commands.ts` has
 * already declared that impossible. Reporting it would be reporting a bug to the
 * user in the form of a toast they cannot act on.
 */
import type { CommandId } from '../../shared/contracts/commands';

/** The subset of commands that only a mounted route can perform. */
export type RouteCommand = Extract<
  CommandId,
  | 'edit.find'
  | 'edit.find-next'
  | 'edit.find-previous'
  | 'edit.replace'
  | 'file.rename-script'
  | 'view.stage-appearance'
>;

type Handler = (command: RouteCommand) => void;

const handlers = new Set<Handler>();

/** Subscribe a route to the commands it owns; returns an unsubscribe function. */
export function onRouteCommand(handler: Handler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

/** Publish a route command. Returns true when something was listening. */
export function dispatchRouteCommand(command: RouteCommand): boolean {
  if (handlers.size === 0) return false;
  for (const handler of handlers) handler(command);
  return true;
}
