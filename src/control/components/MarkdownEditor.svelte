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

  interface Props {
    value: string;
    placeholder?: string;
    onchange?: (value: string) => void;
  }

  let { value, placeholder = '', onchange }: Props = $props();

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
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
          markdown({ base: markdownLanguage }),
          EditorView.lineWrapping,
          cmPlaceholder(placeholder),
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
