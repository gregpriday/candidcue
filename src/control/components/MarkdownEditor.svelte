<!--
  CodeMirror 6 Markdown editor (spec §13.2): line wrapping on, no line
  numbers, restrained syntax styling, full-bleed on its panel (no
  border-inside-border). The instance is exposed via `getView()` for the
  toolbar insert controls.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view';
  import { EditorState } from '@codemirror/state';
  import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
  import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
  import { searchKeymap } from '@codemirror/search';
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

  interface Props {
    value: string;
    placeholder?: string;
    /** Accessible name for the editing surface (spec §20). */
    ariaLabel?: string;
    onchange?: (value: string) => void;
  }

  let { value, placeholder = '', ariaLabel = 'Script Markdown', onchange }: Props = $props();

  let host: HTMLElement;
  let view: EditorView | null = null;
  let internalValue = '';

  export function getView(): EditorView | null {
    return view;
  }

  export function focus(): void {
    view?.focus();
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
            ...markdownFormatKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
          ]),
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
