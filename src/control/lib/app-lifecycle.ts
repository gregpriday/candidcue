/**
 * Control-shell lifecycle policy: how boot decides where to land, and whether
 * leaving the editor is safe.
 *
 * These live outside App.svelte so they can be tested as functions rather than
 * as a mounted component. Both decisions used to be single expressions inline
 * in `onMount`, which is exactly why neither was ever asserted: reaching them
 * from a test meant standing up shortcuts, the presentation latch, the router
 * and every global host the shell renders. The shell keeps the I/O and the
 * rendering; the judgement calls are here.
 */
import type { LaunchBehavior } from '../services/settings-types';
import type { Route } from '../stores/router';

/**
 * Boot failures that must STOP the app rather than open it degraded.
 *
 * Everything else that can fail while starting has a defensible fallback — a
 * settings read that fails leaves `defaultAppSettings()`, which is a working
 * app with the wrong preferences. These two do not: both mean the database is
 * structurally unfit to write to, and opening the app anyway invites the
 * operator to type a script into a store that cannot keep it.
 *
 * `DATABASE_INTEGRITY_FAILED` is deliberately NOT here, despite the name. Rust
 * maps every `AppError::Database` to it (`src-tauri/src/errors.rs`), so it is
 * the generic database-error bucket rather than a structural verdict — a busy
 * timeout or a locked file arrives under the same code. Treating it as fatal
 * would turn a transient hiccup into a screen with no way forward, which is a
 * worse trade than opening on defaults and letting the save path report
 * failures as they happen.
 *
 * Honest limitation: neither code can currently reach this check. Both are
 * raised by `database::init()`, which runs inside Tauri's setup hook
 * (`src-tauri/src/app.rs`) and aborts startup before a webview exists, so they
 * never arrive as a `get_settings` rejection. This branch is the policy for if
 * that ever changes; what it actually fixes today is the far broader class of
 * ordinary rejections that used to hang the splash.
 */
const FATAL_BOOT_CODES: ReadonlySet<string> = new Set([
  'DATABASE_MIGRATION_FAILED',
  'DATABASE_CORRUPT',
]);

/**
 * One body for both ways out of a take, so they cannot drift again.
 *
 * They had drifted: one path reassured the presenter their script kept its
 * place and the other did not, and both described "the realtime connection
 * closing" — a network that stopped existing when transcription moved
 * on-device. Neither says "full screen" any more either, because reader-window
 * mode is not full screen.
 *
 * "Ending", not "stopping". §115 settled the vocabulary on one verb for one
 * action: the transport button, the stage dock, the shortcut help and both
 * confirmations all say "end" now, because three names for one action read as
 * three actions and the presenter reaches for whichever they happen to see.
 *
 * It deliberately stops short of promising the take summary, which is the one
 * sentence Live's own dialog would like to add. Live's exit does show a summary
 * — that is what §115 fixed — but the other caller is App's navigation guard,
 * which clears the session on its way to somewhere that is not Live. A shared
 * body that promised a summary would therefore be false on exactly one of the
 * two paths this constant exists to keep honest, which is the class of defect
 * it was extracted to prevent rather than a wording preference.
 */
export const STOP_SESSION_CONFIRM_BODY =
  'Ending the session leaves presentation mode. Your script is unchanged, and ' +
  'presenting again starts a new take from the beginning.';

/** Is this the kind of startup failure that must not be papered over? */
export function isFatalBootCode(code: string | null): boolean {
  return code !== null && FATAL_BOOT_CODES.has(code);
}

/**
 * What a navigation away from the editor is allowed to do.
 *
 * `veto` is not `confirm` with the answer assumed — see below.
 */
export type EditorNavigationDecision = 'allow' | 'confirm' | 'veto';

/**
 * Decide what happens when something navigates away from the editor.
 *
 * The Live destination is deliberately vetoed rather than confirmed. By the
 * time `start-take.ts` navigates, the presentation cover is already up
 * (`present-cover` is `position: fixed` at z-index 9999 and clears the dialog
 * host on purpose), so a confirmation sheet raised here would be asked for
 * behind an opaque black rectangle — the operator would see a frozen screen and
 * no question, which is the same failure as the boot hang this change removes.
 *
 * Vetoing is also the honest answer for that path: a take reads the script from
 * DISK, so presenting with unsaved work means the stage shows text the operator
 * did not write. `start-take.ts` already refuses on `conflict`/`error` before it
 * navigates, and handles a vetoed navigate by abandoning the half-started take
 * and saying so — so this is the backstop for the narrow window between those
 * two points, not the primary gate.
 */
export function editorNavigationDecision(input: {
  to: Route;
  from: Route;
  hasUnsavedWork: boolean;
}): EditorNavigationDecision {
  if (input.from.name !== 'editor') return 'allow';
  if (!input.hasUnsavedWork) return 'allow';
  if (input.to.name === 'live') return 'veto';
  return 'confirm';
}

/**
 * Where the shell lands once boot has its facts.
 *
 * Precedence is first launch, then the operator's stated preference, then the
 * library. Welcome outranks `launchBehavior` because somebody who has never
 * opened this app has no most-recent script to return to, and the setting they
 * would be exercising is one they have not yet been shown.
 */
export function initialRouteForBoot(input: {
  firstLaunch: boolean;
  launchBehavior: LaunchBehavior;
  recentScriptId: string | null;
}): Route {
  if (input.firstLaunch) return { name: 'welcome' };
  if (input.launchBehavior === 'recent' && input.recentScriptId !== null) {
    return { name: 'editor', scriptId: input.recentScriptId };
  }
  return { name: 'library', view: 'all' };
}

/**
 * The script "Open the most recent script" means, or null.
 *
 * Rust stores the CHOICE (`open_to`) and not the script, so the identity has to
 * be looked up here. It is a dedicated `view: 'recent'` query rather than a read
 * of the library store: the store loads `recently_edited` over everything, and
 * "recently edited" is not "recently opened" — sorting by the wrong clock would
 * open a script the operator last touched by renaming it in the library.
 *
 * The lookup is skipped entirely when its answer cannot matter, and a failure
 * resolves to null rather than rejecting. Boot is the one sequence where an
 * unhandled rejection costs the whole app, and the cost of being wrong here is
 * landing on the library — which is where the operator would have been anyway.
 */
export async function recentScriptIdForBoot(input: {
  firstLaunch: boolean;
  launchBehavior: LaunchBehavior;
  listRecent: () => Promise<{ items: readonly { id: string }[] }>;
}): Promise<string | null> {
  if (input.firstLaunch || input.launchBehavior !== 'recent') return null;
  try {
    const page = await input.listRecent();
    return page.items[0]?.id ?? null;
  } catch {
    return null;
  }
}
