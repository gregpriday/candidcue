<!--
  The script syntax reference (#305): every construct CandidCue adds to
  Markdown, what it looks like on the glass and what following does with it.

  Rendered from `SYNTAX_REFERENCE` and nothing else. That table's examples are
  compiled by its own test against the real compiler, so the page cannot teach
  a form the compiler has stopped accepting. The examples are text
  interpolations, never `{@html}`: a reference full of brackets, braces and
  fences must show them exactly as typed.

  Bundled with the app rather than linked, so it answers offline.
-->
<script lang="ts">
  import Dialog from './Dialog.svelte';
  import Button from './Button.svelte';
  import { SYNTAX_REFERENCE } from '../../shared/markdown/syntax-reference';

  interface Props {
    open: boolean;
    onclose: () => void;
  }
  let { open, onclose }: Props = $props();

  const uid = $props.id();
</script>

<Dialog {open} size="lg" title="Script syntax reference" {onclose}>
  <!--
    The large panel hands the scroll boundary to its content, so this region
    owns it, and the footer's Done stays in view however long the page grows.
  -->
  <div class="scroll">
    <!-- Focus opens on the top of the page, as in Keyboard Shortcuts. -->
    <p class="intro" data-autofocus tabindex="-1">
      Scripts are Markdown, plus a few additions for the prompter. Each example shows what to
      type, what appears on the glass, and what following does with it.
    </p>

    {#each SYNTAX_REFERENCE as group (group.id)}
      <section class="group" aria-labelledby="{uid}-{group.id}">
        <h3 class="group-title" id="{uid}-{group.id}">{group.title}</h3>
        {#each group.entries as entry (entry.id)}
          <article class="entry" data-entry={entry.id}>
            <pre class="example"><code>{entry.example}</code></pre>
            <div class="about">
              <h4 class="name">{entry.title}</h4>
              <dl>
                <dt>On the glass</dt>
                <dd>{entry.glass}</dd>
                <dt>Following</dt>
                <dd>{entry.following}</dd>
              </dl>
              {#if entry.note}<p class="note">{entry.note}</p>{/if}
            </div>
          </article>
        {/each}
      </section>
    {/each}
  </div>
  {#snippet footer()}
    <Button variant="primary" onclick={onclose}>Done</Button>
  {/snippet}
</Dialog>

<style>
  .scroll {
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    /* Room for the scrollbar, so it never sits on the examples. */
    padding-right: var(--space-2);
  }
  .intro {
    margin: 0;
    color: var(--text-secondary);
  }
  .intro:focus {
    outline: none;
  }
  .group {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .group-title {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 650;
    color: var(--text-primary);
  }
  .entry {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: var(--space-4);
    align-items: start;
    padding-top: var(--space-3);
    border-top: 1px solid var(--border);
  }
  .example {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    background: var(--bg-sunken);
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: 1.55;
    color: var(--text-primary);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
  }
  .about {
    min-width: 0;
  }
  .name {
    margin: 0 0 var(--space-1);
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-primary);
  }
  dl {
    margin: 0;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    column-gap: var(--space-3);
    row-gap: var(--space-1);
  }
  dt {
    font-size: var(--text-xs);
    color: var(--text-muted);
    white-space: nowrap;
  }
  dd {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
  .note {
    margin: var(--space-2) 0 0;
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
  /* One column once the panel is too narrow for an example beside its prose. */
  @media (max-width: 720px) {
    .entry {
      grid-template-columns: minmax(0, 1fr);
      gap: var(--space-2);
    }
  }
</style>
