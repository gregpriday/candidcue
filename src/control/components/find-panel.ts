/**
 * The editor's find and replace panel, as CodeMirror sees it.
 *
 * CodeMirror's stock panel is a row of unthemed web controls ("next",
 * "previous", "all", three checkboxes, "replace all") with no count, no
 * no-results state, no sign that a regular expression failed to parse and no
 * trace of what Replace All did. `search({ createPanel })` swaps the panel out
 * and keeps the query state, the replace commands and the match highlighting,
 * so this file is the panel — the DOM CodeMirror docks at the top of the pane
 * and the snapshot of the search that `FindPanel.svelte` draws — plus the one
 * way of stepping between hits that the panel, the Edit menu and ⌘G all share.
 *
 * The snapshot is computed here rather than in the component so the component
 * never reads editor state on its own schedule: CodeMirror calls `update` once
 * per view update, and that is the one moment the count, the current match and
 * the last Replace All are all known to agree with the document.
 */
import { mount, unmount } from 'svelte';
import type { EditorState, Transaction } from '@codemirror/state';
import { EditorView, type Panel, type ViewUpdate } from '@codemirror/view';
import { getSearchQuery, openSearchPanel, setSearchQuery, type SearchQuery } from '@codemirror/search';
import FindPanel from './FindPanel.svelte';

export type FindStatus =
  /** Nothing typed yet. */
  | { kind: 'idle' }
  /** A regular expression that does not parse, and the engine's reason. */
  | { kind: 'invalid'; reason: string }
  | { kind: 'none' }
  /** `current` is 1-based, or null when the selection is not on a match. */
  | { kind: 'found'; total: number; current: number | null }
  /** What the last Replace All did, until the next edit or query. */
  | { kind: 'replaced'; count: number };

export interface FindSnapshot {
  search: string;
  replace: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regexp: boolean;
  /** How many hits the query has now — what stepping visits. */
  total: number;
  /** How many of them Replace All would change (see `Hit.precise`). */
  replaceable: number;
  /** What the status slot says, which after a Replace All is the receipt. */
  status: FindStatus;
}

/**
 * One hit. `precise` is CodeMirror's: false when a plain-text match starts or
 * ends inside a composed character — the "e" of a decomposed "é" — which it
 * will find and step to but will not replace.
 */
export interface Hit {
  from: number;
  to: number;
  precise: boolean;
}

/**
 * Every hit of `query` in the document, in order and never overlapping.
 *
 * The same walk CodeMirror's highlighter makes, so the count, the stepping and
 * the highlighted words are one list. (Its own Find Previous scans OVERLAPPING
 * hits, which in "banana" reaches an "ana" nothing else counts or highlights.)
 */
export function matchesOf(query: SearchQuery, state: EditorState): Hit[] {
  const found: Hit[] = [];
  const cursor = query.getCursor(state);
  for (let step = cursor.next(); !step.done; step = cursor.next()) {
    const { from, to, precise } = step.value as { from: number; to: number; precise?: boolean };
    found.push({ from, to, precise: precise !== false });
  }
  return found;
}

/**
 * Why a pattern does not parse, in the engine's words minus the pattern.
 *
 * Built with CodeMirror's own flags (`gm`, plus `u` where the engine has it),
 * because those are what made it invalid: `\q` parses without `u` and fails
 * with it. Engines spell the reason differently — "Invalid regular
 * expression: missing )" in WebKit, "…: /(a/: Unterminated group" in V8 — and
 * the useful part is always after the last colon.
 */
function regexpProblem(source: string): string {
  try {
    new RegExp(source, /x/.unicode === undefined ? 'gm' : 'gmu');
    return 'Invalid pattern';
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const reason = message.slice(message.lastIndexOf(':') + 1).trim();
    return reason ? reason.charAt(0).toUpperCase() + reason.slice(1) : 'Invalid pattern';
  }
}

export function describeSearch(state: EditorState, replaced: number | null): FindSnapshot {
  const query = getSearchQuery(state);
  const base = {
    search: query.search,
    replace: query.replace,
    caseSensitive: query.caseSensitive,
    wholeWord: query.wholeWord,
    regexp: query.regexp,
  };
  if (query.search === '') return { ...base, total: 0, replaceable: 0, status: { kind: 'idle' } };
  if (!query.valid) {
    return {
      ...base,
      total: 0,
      replaceable: 0,
      status: { kind: 'invalid', reason: regexpProblem(query.search) },
    };
  }
  const hits = matchesOf(query, state);
  const total = hits.length;
  const replaceable = hits.filter((hit) => hit.precise).length;
  const counts = { ...base, total, replaceable };
  if (replaced !== null) return { ...counts, status: { kind: 'replaced', count: replaced } };
  if (total === 0) return { ...counts, status: { kind: 'none' } };
  const { from, to } = state.selection.main;
  const index = hits.findIndex((hit) => hit.from === from && hit.to === to);
  return { ...counts, status: { kind: 'found', total, current: index === -1 ? null : index + 1 } };
}

/**
 * The words around a hit and its line, for a screen reader.
 *
 * The bar's status says "4 of 19"; this says WHICH one — the hit in its
 * sentence, trimmed to whole words about 30 characters either side. It is
 * the context CodeMirror's own stepping announced, kept when stepping became
 * ours.
 */
function context(view: EditorView, hit: Hit): string {
  const margin = 30;
  const doc = view.state.doc;
  const line = doc.lineAt(hit.from);
  const lineEnd = doc.lineAt(hit.to).to;
  const start = Math.max(line.from, hit.from - margin);
  const end = Math.min(lineEnd, hit.to + margin);
  let before = view.state.sliceDoc(start, hit.from);
  let after = view.state.sliceDoc(hit.to, end);
  // Drop the part-words the margins cut through — never the hit itself.
  if (start > line.from) before = before.replace(/^\S*\s+/, '');
  if (end < lineEnd) after = after.replace(/\s+\S*$/, '');
  const text = before + view.state.sliceDoc(hit.from, hit.to) + after;
  return `${text.trim()}, line ${line.number}`;
}

/**
 * Select a hit and bring it into view, as a search step. `announce` for an
 * explicit step only: find-as-you-type would otherwise read a sentence per
 * keystroke.
 */
function select(view: EditorView, hit: Hit, announce: boolean): void {
  const effects = [EditorView.scrollIntoView(hit.from, { y: 'nearest', yMargin: 48 })];
  if (announce) effects.push(EditorView.announce.of(context(view, hit)));
  view.dispatch({
    selection: { anchor: hit.from, head: hit.to },
    effects,
    userEvent: 'select.search',
  });
}

/**
 * Step to the next (1) or previous (-1) hit, wrapping at either end.
 *
 * Replaces CodeMirror's findNext/findPrevious everywhere they were reachable —
 * the panel, the Edit menu, ⌘G — so stepping visits exactly the hits the
 * count numbers. Like theirs, it opens the panel when there is nothing valid
 * to step through.
 */
export function stepMatch(view: EditorView, direction: 1 | -1): boolean {
  const query = getSearchQuery(view.state);
  if (!query.valid) return openSearchPanel(view);
  const hits = matchesOf(query, view.state);
  if (hits.length === 0) return false;
  const { from, to } = view.state.selection.main;
  const isCurrent = (hit: Hit) => hit.from === from && hit.to === to;
  let target: Hit | undefined;
  if (direction === 1) {
    target = hits.find((hit) => hit.from >= to && !isCurrent(hit)) ?? hits[0];
  } else {
    for (let i = hits.length - 1; i >= 0 && !target; i--) {
      const hit = hits[i]!;
      if (hit.to <= from && !isCurrent(hit)) target = hit;
    }
    target ??= hits[hits.length - 1];
  }
  if (target) select(view, target, true);
  return true;
}

/**
 * Find as you type: land on the first hit at or after the selection's START.
 *
 * From the start, not the end, so typing the next letter of a word that
 * already matched keeps the same hit rather than stepping on. When the query
 * stops describing anything — no hits, a pattern that does not parse, or an
 * empty field — the selection collapses to where it began: a half-typed
 * query's last partial hit left selected reads as a result (and lights up
 * every other occurrence of it as a selection match) under "No results".
 */
export function landOn(view: EditorView, query: SearchQuery): void {
  const { state } = view;
  const { from, empty } = state.selection.main;
  const hits = query.valid ? matchesOf(query, state) : [];
  const hit = hits.find((candidate) => candidate.from >= from) ?? hits[0];
  if (hit) select(view, hit, false);
  else if (!empty) view.dispatch({ selection: { anchor: from }, userEvent: 'select.search' });
}

export function createFindPanel(view: EditorView): Panel {
  const dom = document.createElement('div');
  dom.className = 'cm-search';
  let replaced: number | null = null;
  const panel = mount(FindPanel, {
    target: dom,
    props: { view, initial: describeSearch(view.state, null) },
  });

  return {
    dom,
    top: true,
    mount() {
      // Opening Find puts the caret in the field with its text selected, so
      // typing replaces the last query — the stock panel's behaviour, kept.
      const field = dom.querySelector<HTMLInputElement>('[main-field]');
      field?.focus();
      field?.select();
    },
    update(update: ViewUpdate) {
      const before = replaced;
      let queryChanged = false;
      for (const tr of update.transactions) {
        if (tr.effects.some((effect) => effect.is(setSearchQuery))) queryChanged = true;
        if (tr.isUserEvent('input.replace.all')) replaced = replacementCount(tr);
        // Any other edit, a new query or a move of the selection retires the
        // report: it describes a moment, and the document has moved on.
        else if (tr.docChanged || tr.selection || tr.effects.some((e) => e.is(setSearchQuery))) {
          replaced = null;
        }
      }
      if (update.docChanged || update.selectionSet || queryChanged || replaced !== before) {
        panel.sync(describeSearch(update.state, replaced));
      }
    },
    destroy() {
      void unmount(panel);
    },
  };
}

/**
 * How many matches a Replace All transaction replaced.
 *
 * Counted as the replaceable hits the query had in the document the
 * transaction started from — what Replace All acted on. Not from the
 * transaction's changes: CodeMirror joins adjacent ones, so deleting "um "
 * from "um um um " is three replacements and one change range.
 */
function replacementCount(tr: Transaction): number {
  return matchesOf(getSearchQuery(tr.startState), tr.startState).filter((hit) => hit.precise).length;
}
