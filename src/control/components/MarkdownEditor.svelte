<!--
  CodeMirror 6 Markdown editor (spec §13.2): line wrapping on, no line
  numbers, restrained syntax styling, full-bleed on its panel (no
  border-inside-border). The instance is exposed via `getView()` for the
  toolbar insert controls.

  ---------------------------------------------------------------------------
  THERE IS DELIBERATELY NO CUSTOM CONTEXT MENU HERE
  ---------------------------------------------------------------------------
  Desktop refinement §11.9 asks for editor context actions — and then says, in
  the same line, "without replacing standard text editing commands". In a
  webview those two cannot both be had: the only way to show a custom menu on
  right-click is to `preventDefault()` the platform's, and the platform's is
  carrying spelling suggestions, Look Up, Share, text substitutions and
  Services. A hand-rolled menu offering "Insert cue" in exchange for all of that
  is a straight downgrade for the one surface in the app where somebody is
  writing prose.

  So the editor keeps the system menu, and the insertions it would have offered
  live in two places instead: the formatting row above the text, where they are
  visible and tooltipped, and the native INSERT MENU (§11.4). Both call the same
  functions in `lib/markdown-insert.ts` — the menu reaches this component
  through the route command bus, so a menu item and the button beside it cannot
  drift into meaning different things.

-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view';
  import { EditorState } from '@codemirror/state';
  import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
  import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
  import {
    closeSearchPanel,
    findNext,
    findPrevious,
    highlightSelectionMatches,
    openSearchPanel,
    search,
    searchKeymap,
  } from '@codemirror/search';
  import { editorTheme } from './cm-theme';
  import { insertBold, insertItalic } from '../lib/markdown-insert';

  /**
   * Bold and italic on the keys every editor on the machine uses for them.
   *
   * They were toolbar-only, in a Markdown editor — the one place a writer
   * reaches for Cmd+B without looking. The commands themselves already existed
   * and are the same ones the toolbar buttons call, so this adds a way in
   * rather than a second behaviour to keep in step.
   *
   * These sit BEFORE `...defaultKeymap` in the SAME `keymap.of` array, which is
   * what makes them win. `Mod-i` is not free: CodeMirror's defaults bind it to
   * `selectParentSyntax`. Bindings for one key at one precedence are merged
   * into a single ordered list and tried until one returns true, so being first
   * in the array IS the override — and returning true is what stops the default
   * from also running. Raising the precedence of the whole keymap instead would
   * claim far more of the editor's keyboard than these two keys need.
   */
  const markdownFormatKeymap = [
    {
      key: 'Mod-b',
      run: (view: EditorView) => {
        insertBold(view);
        return true;
      },
    },
    {
      key: 'Mod-i',
      run: (view: EditorView) => {
        insertItalic(view);
        return true;
      },
    },
  ];

  /**
   * ⌘↩ is Present, and the editor must not answer it as well (issue #268).
   *
   * CodeMirror's `defaultKeymap` binds `Mod-Enter` to `insertBlankLine`. The
   * editor's keydown runs before the window listener in `lib/shortcuts.ts`, so
   * pressing Present with the caret in a paragraph used to split it, autosave
   * the split, and only then start the take — one more paragraph break per
   * press. The search panel has the same problem in its own handler: any Enter
   * in the Replace field runs `replaceNext`, modifiers or not.
   *
   * This binding claims the chord and does nothing with it. Returning true is
   * what stops the default and makes CodeMirror prevent the event; it does NOT
   * stop propagation, and must not — the window listener is what actually
   * presents, through the same readiness check as the Present button. Emitting
   * Present from here instead would launch twice. The `search-panel` scope is
   * what reaches the panel's fields: they sit outside `contentDOM`, and the
   * panel runs that scope's bindings before its own Enter fallback.
   */
  const presentReservationKeymap = [
    { key: 'Mod-Enter', scope: 'editor search-panel', run: () => true },
  ];

  interface Props {
    value: string;
    placeholder?: string;
    /** Accessible name for the editing surface (spec §20). */
    ariaLabel?: string;
    onchange?: (value: string) => void;
    /**
     * The caret's UTF-16 offset, whenever it moves.
     *
     * Reported rather than polled because "Present from here" needs it at the
     * moment the menu opens, and reaching into the view from the route would
     * put CodeMirror's API in a second file.
     */
    onselectionchange?: (offset: number) => void;
  }

  let {
    value,
    placeholder = '',
    ariaLabel = 'Script Markdown',
    onchange,
    onselectionchange,
  }: Props = $props();

  let host: HTMLElement;
  let view: EditorView | null = null;
  let internalValue = '';

  export function getView(): EditorView | null {
    return view;
  }

  export function focus(): void {
    view?.focus();
  }

  /**
   * Find and Replace, driven from the native Edit menu (§11.9).
   *
   * `searchKeymap` was already installed, so ⌘F worked for anybody who knew it
   * existed. Nothing NAMED it — there was no menu, so Find, Find Next, Find
   * Previous and Replace were four undiscoverable keys. These are the same
   * CodeMirror commands the keymap binds, exposed so `Editor.svelte` can hand
   * the menu's commands to the live view.
   *
   * `openSearchPanel` focuses its own field, which is the behaviour anybody
   * pressing Find expects; Replace opens the same panel with the replace row
   * shown, which is what `search({ ... })`'s configuration below controls.
   */
  export function openFind(): void {
    if (view) openSearchPanel(view);
  }

  export function findNextMatch(): void {
    if (view) findNext(view);
  }

  export function findPreviousMatch(): void {
    if (view) findPrevious(view);
  }

  /**
   * Replace opens the SAME panel as Find, then focuses its replace field.
   *
   * CodeMirror's default search panel carries the replace inputs already, so
   * there is no second panel to open and no "replace mode" to switch into —
   * Find and Replace differ only in which field the caret lands in. Both menu
   * items exist because both are what a user looks for; pretending they open
   * different surfaces would be inventing a distinction the editor does not
   * have.
   */
  export function openReplace(): void {
    if (!view) return;
    openSearchPanel(view);
    // The panel is added to the DOM synchronously by `openSearchPanel`, but the
    // field is only focusable once it has been laid out.
    requestAnimationFrame(() => {
      const field = view?.dom.querySelector<HTMLInputElement>(
        '.cm-search input[name="replace"]',
      );
      field?.focus();
      field?.select();
    });
  }

  /** Close the search panel — used when the editor unmounts mid-search. */
  export function closeFind(): void {
    if (view) closeSearchPanel(view);
  }

  onMount(() => {
    internalValue = value;
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keymap.of([
            ...presentReservationKeymap,
            ...markdownFormatKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
          ]),
          /*
           * The search extension declared EAGERLY, and configured.
           *
           * `openSearchPanel` will append the search extensions itself if they
           * are missing, so ⌘F worked before this line existed — the honest
           * difference is that the state now exists from the start, the panel is
           * pinned to the top rather than the bottom, and match highlighting is
           * on. Without `highlightSelectionMatches` a search told you where the
           * caret went and nothing about the other hits.
           */
          search({ top: true }),
          highlightSelectionMatches(),
          markdown({ base: markdownLanguage }),
          EditorView.lineWrapping,
          cmPlaceholder(placeholder),
          // CodeMirror's contenteditable is the editing surface; without this
          // it is an unnamed textbox to a screen reader (spec §20).
          EditorView.contentAttributes.of({ 'aria-label': ariaLabel }),
          editorTheme,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              internalValue = update.state.doc.toString();
              onchange?.(internalValue);
            }
            /*
             * `docChanged` too, not only `selectionSet`: typing moves the caret
             * without always reporting a selection change, and a stale offset
             * would aim "Present from here" at wherever the caret used to be.
             */
            if (update.selectionSet || update.docChanged) {
              onselectionchange?.(update.state.selection.main.head);
            }
          }),
        ],
      }),
    });
    return () => {
      view?.destroy();
      view = null;
    };
  });

  /* External value replacement (opening another script) without clobbering
     in-progress typing: only rewrite when the change came from outside. */
  $effect(() => {
    const next = value;
    if (view && next !== internalValue) {
      internalValue = next;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: next },
      });
    }
  });
</script>

<div class="editor-host" bind:this={host}></div>

<style>
  .editor-host {
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    display: flex;
    background: var(--bg-panel);
  }
  .editor-host :global(.cm-editor) {
    flex: 1 1 auto;
    min-width: 0;
  }
</style>
