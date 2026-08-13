/**
 * ScriptLibraryStore (spec §45.2) — summaries, search, sort, selection.
 *
 * Every mutation reports its own outcome, success and failure both, exactly
 * once, from here. It used to report neither: the mutators had no `try`/`catch`
 * and every call site invoked them as `void moveScriptToTrash(id)`, so a
 * rejection reached nothing at all — there is no `unhandledrejection` handler
 * in the app, and the console is not a user interface. The success toasts sat
 * after the await at the call sites, which meant a failure produced no notice
 * of any kind: you clicked Restore and the row simply stayed where it was.
 */
import { derived, get, writable } from 'svelte/store';
import type { ScriptSummary } from '../../shared/contracts';
import { describeError } from '../services/errors';
import * as scriptsService from '../services/scripts';
import type { LibraryView, ScriptPage, ScriptSort } from '../services/scripts-types';
import { showToast } from './toasts';

/**
 * One page, at the largest size Rust will serve.
 *
 * `PageRequest` defaults to 100 and clamps to 500 (`scripts/repo.rs`), and this
 * store used to send no page at all — so a library of 340 scripts showed 240 of
 * them nowhere, with `total` arriving on the wire and being dropped on the
 * floor. Asking for the maximum is not a fix for pagination; it is the honest
 * ceiling until there is some, which is why `total` is kept and reported.
 */
const PAGE_SIZE = 500;

export interface LibraryState {
  loading: boolean;
  /** True while a `loadMore` is in flight, so the button can say so. */
  loadingMore: boolean;
  scripts: ScriptSummary[];
  view: LibraryView;
  query: string;
  sort: ScriptSort;
  /**
   * The selected script — drawn, and the target of every command that acts on
   * "the script in the Library" (desktop refinement §10.2).
   *
   * ---------------------------------------------------------------------------
   * IT USED TO BE INVISIBLE, AND THAT WAS THE PROBLEM
   * ---------------------------------------------------------------------------
   * This was the Present shortcut's target and nothing else. Nothing drew it, so
   * "the selected script" was a fiction: ⌘⏎ presented a script the user had no
   * way of identifying, and there was no object for a context menu, an
   * inspector, or a File menu command to act on. The Library was a list of links
   * rather than a collection.
   *
   * It is now drawn, it survives opening a script and coming back, and the
   * arrows move it. `loadLibrary` still falls back to the first row so the
   * collection has a selection the moment it loads — which is what every desktop
   * document manager does, and what makes the keyboard usable without a click
   * first.
   *
   * THE TRASH EXCLUSION IS GONE. It existed because an invisible selection in
   * Trash meant ⌘⏎ aimed at a deleted script; now that selection is visible and
   * Present is greyed out in Trash by `lib/commands.ts` and refused by the
   * route's own shortcut handler, a Trash selection is exactly what Restore and
   * Delete Permanently need to act on.
   */
  selectedId: string | null;
  error: string | null;
  /** How many scripts match the current view and query, loaded or not. */
  total: number;
  /**
   * Everything in Trash, ignoring the search box — `null` when it is not known.
   *
   * Empty Trash empties Trash, not the rows a search happens to have left on
   * screen, so the confirmation has to count the former. Searching Trash for
   * two scripts and being asked to confirm deleting "2 scripts" before all
   * forty go is the kind of undercount there is no undo for.
   */
  trashTotal: number | null;
}

const state = writable<LibraryState>({
  loading: false,
  loadingMore: false,
  scripts: [],
  view: 'all',
  query: '',
  sort: 'recently_edited',
  selectedId: null,
  error: null,
  total: 0,
  trashTotal: null,
});

export const library = { subscribe: state.subscribe };

export const librarySelection = derived(state, ($s) =>
  $s.scripts.find((script) => script.id === $s.selectedId) ?? null,
);

/**
 * How many scripts are in Trash altogether, for the Empty Trash confirmation.
 *
 * With no search active the page just read already answers it. With one, the
 * page has been narrowed and one extra count-only read is the difference
 * between naming the right number and naming a comfortable one.
 */
async function trashCount(
  view: LibraryView,
  query: string,
  page: ScriptPage,
): Promise<number | null> {
  if (view !== 'trash') return null;
  if (query.trim() === '') return page.total;
  try {
    const all = await scriptsService.listScripts({ view: 'trash' }, undefined, {
      page: 0,
      pageSize: 1,
    });
    return all.total;
  } catch {
    // An unknown count is not a reason to hide the Trash. The confirmation
    // drops to copy that names no number rather than naming a wrong one.
    return null;
  }
}

/**
 * Which load is allowed to commit.
 *
 * Every setter fires its own `void loadLibrary()`, so switching view while a
 * search is still in flight leaves two reads racing — and the loser resolving
 * last would write live scripts into a Trash view, under a menu whose entries
 * delete permanently. Only the newest read commits anything: rows, totals,
 * `loading`, or an error.
 */
let loadGeneration = 0;

/**
 * How many pages are loaded — counted, not inferred from the row count.
 *
 * `Math.floor(scripts.length / PAGE_SIZE)` looks equivalent and is not, because
 * the append below DE-DUPLICATES: a script renamed between two reads can shift
 * the ordering so that page 1 repeats a row from page 0, one row is dropped,
 * and the length lands at 999 instead of 1000. The derived cursor then asks for
 * page 1 again — and again, and again, because every answer is dropped as a
 * duplicate. Show more would spin for ever on a library that had done nothing
 * more exotic than be edited while it was open.
 *
 * Reset wherever the query changes underneath it, which is the same place
 * `loadGeneration` moves.
 */
let loadedPages = 1;

/**
 * How many pages the NEXT full reload should re-read.
 *
 * Returning from the editor calls `loadLibrary()`, which reads page 0 — so a
 * selection on row 700 was replaced by row 1, and the offset saved for the
 * scroll position pointed past the end of a list that had just shrunk back to
 * 500 rows. §10.2 names that journey specifically: selection survives returning
 * from the editor. Now the reload restores the depth it was left at.
 */
function pagesToRestore(): number {
  return loadedPages;
}

/**
 * Back to one page — the list the next read produces is a DIFFERENT list.
 *
 * Called wherever the query changes underneath the cursor: a new view, a new
 * search, a new sort. Without it, typing one letter into the search box would
 * re-read as deep as the unfiltered list had been scrolled, which is both a
 * much larger read than the screen can use and a paging cursor pointing into a
 * result set that no longer has those pages.
 */
/**
 * Ask the NEXT read to start from one page.
 *
 * A flag rather than an immediate reset, because a reset that lands before the
 * read is a lie for as long as the read takes — and if the read fails, it is a
 * permanent one: the rows on screen are still the two pages the old query
 * loaded, while the cursor says there is one, so the next Show more re-reads a
 * page that is already there. `loadLibrary` applies it once the new page has
 * actually committed.
 */
function resetPaging(): void {
  pagingReset = true;
}

let pagingReset = false;

export async function loadLibrary(): Promise<void> {
  const generation = (loadGeneration += 1);
  const current = get(state);
  const depth = pagingReset ? 1 : pagesToRestore();
  state.update((s) => ({ ...s, loading: true, error: null }));
  try {
    const page = await scriptsService.listScripts(
      { view: current.view, query: current.query },
      current.sort,
      { page: 0, pageSize: PAGE_SIZE },
    );
    const trashTotal = await trashCount(current.view, current.query, page);
    if (generation !== loadGeneration) return;
    state.update((s) => {
      const kept = page.items.some((i) => i.id === s.selectedId);
      return {
        ...s,
        loading: false,
        loadingMore: false,
        scripts: page.items,
        total: page.total,
        trashTotal,
        /*
         * A choice survives a reload as long as the script is still in the
         * list; otherwise the fallback picks up the top of whatever is there
         * now, so the collection always has a selection to act on. Applies in
         * Trash too — see the note on `selectedId`.
         *
         * DEFERRED while deeper pages are still to come. Judging it here on
         * page zero alone is what §10.2's journey trips over: the script you
         * were editing is on row 700, page zero cannot contain it, and the
         * fallback replaced the selection with row 1 before the page holding it
         * had been read. The restore loop below makes the same decision once
         * the list is whole.
         */
        selectedId: depth > 1 ? s.selectedId : kept ? s.selectedId : page.items[0]?.id ?? null,
      };
    });
    loadedPages = 1;
    pagingReset = false;
    /*
     * RE-READ AS DEEP AS THE LIST WAS, one page at a time.
     *
     * Not one request with a bigger ceiling: `list_scripts` clamps `pageSize`
     * to 500 in Rust (`scripts/repo.rs`), so asking for 1000 quietly returned
     * 500 while this store believed it held two pages — and the next Show more
     * then asked for page 2 and skipped five hundred scripts. The clamp is not
     * visible from here, and the unit test's mock honoured whatever size it was
     * given, which is exactly how that passed.
     *
     * Sequential rather than parallel: each page is appended to the one before
     * it, and the de-duplication that makes appending safe reads the rows
     * already held.
     */
    for (let page = 1; page < depth; page += 1) {
      if (generation !== loadGeneration) return;
      /*
       * STOP on the first page that did not arrive.
       *
       * `loadMoreScripts` reports its own failure into the store and resolves,
       * which is right for a button press and wrong for a loop: carrying on
       * would leave `loadedPages` counting pages that are not in the list, and
       * the next Show more would skip whatever the failed page held.
       */
      if (!(await loadMoreScripts())) break;
    }
    /*
     * And NOW settle the selection, against the whole list.
     *
     * Deferred above so a selection deeper than page zero survives the trip
     * back from the editor. If the script really is gone — trashed from
     * another window, or the search narrowed past it — this is where the
     * fallback to the first row happens, on the same rule as before.
     */
    if (depth > 1 && generation === loadGeneration) {
      state.update((s) => ({
        ...s,
        selectedId: s.scripts.some((script) => script.id === s.selectedId)
          ? s.selectedId
          : s.scripts[0]?.id ?? null,
      }));
    }
  } catch (err) {
    if (generation !== loadGeneration) return;
    // The rows already on screen stay. A failed re-query is a failure to
    // refresh, not the discovery that the library is empty, and blanking the
    // list would put a database read error behind the first-run invitation to
    // start writing — which is what a wiped library looks like.
    state.update((s) => ({ ...s, loading: false, loadingMore: false, error: describeError(err) }));
  }
}

/**
 * Load the next page and append it (§10.2).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS HAD TO EXIST
 * ---------------------------------------------------------------------------
 * `loadLibrary` asks for page zero and a ceiling of `PAGE_SIZE`, and that was
 * the whole of the transport. The count line said "Showing 500 of 812", which
 * was honest — and the other 312 were unreachable by keyboard AND by pointer.
 * There was no gesture in the product that could see them.
 *
 * Appending rather than replacing, and guarded three ways: nothing to fetch,
 * a fetch already running, and a generation that has moved. The last is the
 * important one — switching view or typing in the search box starts a fresh
 * read, and a page that arrives afterwards belongs to a list that is gone. It
 * would append Trash rows under live ones, beneath a menu whose entries delete
 * permanently.
 */
export async function loadMoreScripts(): Promise<boolean> {
  const current = get(state);
  if (current.loadingMore || current.loading) return false;
  if (current.scripts.length >= current.total) return false;

  const generation = loadGeneration;
  let landed = false;
  state.update((s) => ({ ...s, loadingMore: true }));
  try {
    const page = await scriptsService.listScripts(
      { view: current.view, query: current.query },
      current.sort,
      { page: loadedPages, pageSize: PAGE_SIZE },
    );
    if (generation !== loadGeneration) return false;
    landed = true;
    state.update((s) => {
      // De-duplicated by id: a script created or renamed between the two reads
      // can shift the ordering, and appending blindly would show it twice —
      // which for a keyed `{#each}` is a crash rather than a cosmetic fault.
      const seen = new Set(s.scripts.map((script) => script.id));
      const added = page.items.filter((item) => !seen.has(item.id));
      /*
       * A page that answered with nothing is the END, whatever `total` says.
       *
       * `total` is counted by a separate query and can disagree with the rows
       * after a concurrent delete — and while it says there are more, the guard
       * at the top of this function goes on offering Show more, which reads as
       * a button that does nothing. Trusting the rows over the count is the
       * right way round: the rows are what the list can actually display.
       */
      /*
       * A SHORT page is the last one, whatever `total` says — and an empty one
       * does not move the cursor at all.
       *
       * `total` comes from a separate count query and can disagree with the
       * rows after a concurrent delete. While it says there are more, the guard
       * at the top of this function goes on offering Show more, which reads as
       * a button that does nothing. Trusting the rows over the count is the
       * right way round: the rows are what the list can display.
       */
      const exhausted = page.items.length < PAGE_SIZE;
      if (page.items.length > 0) {
        // The cursor moves per PAGE, not per row kept — see `loadedPages`.
        loadedPages += 1;
      }
      const scripts = [...s.scripts, ...added];
      return {
        ...s,
        loadingMore: false,
        scripts,
        total: exhausted ? scripts.length : page.total,
      };
    });
  } catch (err) {
    landed = false;
    if (generation !== loadGeneration) return false;
    state.update((s) => ({ ...s, loadingMore: false, error: describeError(err) }));
  } finally {
    if (generation === loadGeneration) {
      state.update((s) => (s.loadingMore ? { ...s, loadingMore: false } : s));
    }
  }
  return landed;
}

export function setLibraryView(view: LibraryView): void {
  /*
   * Re-choosing the CURRENT view is a refresh, not a change.
   *
   * The sidebar calls this on every click, including a click on the row that is
   * already current — which is exactly what somebody does coming back from the
   * editor. Clearing unconditionally meant that trip discarded the selection,
   * so "open a script, come back" always landed on the top of the list rather
   * than on the script you had just been working in. That is the one journey
   * §10.2 names: selection must survive returning from the editor.
   */
  if (get(state).view === view) {
    void loadLibrary();
    return;
  }
  // The rows on screen belong to the view being left. Holding them while the
  // next one loads would render live scripts as Trash rows, under a menu whose
  // entries delete permanently.
  resetPaging();
  state.update((s) => ({
    ...s,
    view,
    scripts: [],
    total: 0,
    trashTotal: null,
    selectedId: null,
  }));
  void loadLibrary();
}

export function setLibraryQuery(query: string): void {
  resetPaging();
  state.update((s) => ({ ...s, query }));
  void loadLibrary();
}

export function setLibrarySort(sort: ScriptSort): void {
  resetPaging();
  state.update((s) => ({ ...s, sort }));
  void loadLibrary();
}

export function selectScript(id: string | null): void {
  state.update((s) => ({ ...s, selectedId: id }));
}

/**
 * Run one library mutation and say what happened.
 *
 * Failures are reported and swallowed rather than rethrown: every caller on
 * this screen is fire-and-forget, so a rejection that escapes is a rejection
 * nobody handles. The boolean is for the one caller that sequences something
 * afterwards — the editor navigates to the library once a script is trashed,
 * and should not make that trip when the script is still there.
 */
async function mutate(failure: string, run: () => Promise<void>): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (err) {
    showToast(`${failure} ${describeError(err)}`, 'danger');
    return false;
  }
}

export async function duplicateScript(id: string): Promise<boolean> {
  const ok = await mutate('The script could not be duplicated.', async () => {
    await scriptsService.duplicateScript(id);
  });
  if (ok) showToast('Script duplicated', 'success');
  // Reload either way: a failure is often the library holding a stale row, and
  // the next attempt should be made against what is actually there.
  await loadLibrary();
  return ok;
}

/** Look up the revision the library currently believes a script is at. */
function revisionOf(id: string): number {
  const found = get(state).scripts.find((script) => script.id === id);
  if (found === undefined) {
    throw new Error('That script is no longer in the library. Refresh the list, then try again.');
  }
  return found.scriptRevision;
}

export async function moveScriptToTrash(id: string): Promise<boolean> {
  const ok = await mutate('The script could not be moved to Trash.', async () => {
    await scriptsService.trashScript(id, revisionOf(id));
  });
  if (ok) showToast('Moved to Trash', 'info');
  await loadLibrary();
  return ok;
}

export async function restoreScriptFromTrash(id: string): Promise<boolean> {
  const ok = await mutate('The script could not be restored.', async () => {
    await scriptsService.restoreScript(id, revisionOf(id));
  });
  if (ok) showToast('Script restored', 'success');
  await loadLibrary();
  return ok;
}

export async function deleteScriptPermanently(id: string): Promise<boolean> {
  const ok = await mutate('The script could not be deleted permanently.', async () => {
    await scriptsService.permanentlyDeleteScript(id);
  });
  if (ok) showToast('Script deleted permanently', 'success');
  await loadLibrary();
  return ok;
}

/**
 * Every script in Trash, read unfiltered.
 *
 * Pages are only stable while nothing is being removed, so the whole list is
 * enumerated before a single delete goes out and the deletes then work from
 * that fixed set. Reading a page, deleting it and re-reading page zero — the
 * obvious shape — has three separate faults: a row that cannot be deleted parks
 * itself at the top and hides everything behind it, a script trashed while the
 * loop runs gets swept up by a confirmation that never mentioned it, and the
 * denominator moves under the count being reported against it.
 *
 * Two independent exits, because this loop stands in front of permanent
 * deletion: a short page, which is the ordinary end of the list, and a page
 * that contributed no new id, which is what a backend repeating itself looks
 * like from here. `total` is deliberately not a termination condition — it is a
 * separate COUNT(*) and can disagree with the rows in either direction.
 */
async function listTrashedIds(): Promise<string[]> {
  const ids = new Set<string>();
  for (let page = 0; ; page += 1) {
    const result = await scriptsService.listScripts({ view: 'trash' }, undefined, {
      page,
      pageSize: PAGE_SIZE,
    });
    const before = ids.size;
    for (const script of result.items) ids.add(script.id);
    if (result.items.length < PAGE_SIZE || ids.size === before) break;
  }
  return [...ids];
}

/**
 * The scripts Empty Trash would remove, read before the confirmation is shown.
 *
 * The sheet has to name the set that will actually be deleted. Counting first
 * and enumerating afterwards means anything trashed while the sheet is open
 * gets deleted by a confirmation that never mentioned it — and the number the
 * operator agreed to was, by then, simply the wrong number.
 *
 * `null` means the Trash could not be read: there is nothing to confirm, and
 * the failure has already been reported.
 */
export async function collectTrashTargets(): Promise<string[] | null> {
  try {
    return await listTrashedIds();
  } catch (err) {
    showToast(`Trash could not be emptied. ${describeError(err)}`, 'danger');
    return null;
  }
}

/**
 * Delete exactly the scripts that were confirmed, and say how it went.
 *
 * It used to walk `state.scripts`, which is one page of Trash as narrowed by
 * whatever is in the search box, so "Empty Trash" could leave most of the trash
 * in it.
 *
 * The deletes are serial. These are SQLite writes behind IPC, so running them
 * together buys lock contention rather than speed, and one at a time is what
 * makes "deleted N of M" a count rather than an estimate. Each target is
 * attempted exactly once: a failure is a failure, not something to be retried
 * into a report that contradicts itself.
 */
export async function emptyTrash(targets: string[]): Promise<boolean> {
  let deleted = 0;
  let firstError: unknown = null;
  for (const id of targets) {
    try {
      await scriptsService.permanentlyDeleteScript(id);
      deleted += 1;
    } catch (err) {
      firstError ??= err;
    }
  }

  await loadLibrary();

  if (firstError === null) {
    showToast('Trash emptied', 'success');
    return true;
  }

  const opening = deleted === 0 ? 'Trash could not be emptied.' : 'Trash was only partly emptied.';
  const scripts = `${targets.length} ${targets.length === 1 ? 'script' : 'scripts'}`;
  showToast(
    `${opening} Deleted ${deleted} of ${scripts}. ${describeError(firstError)}`,
    'danger',
  );
  return false;
}
