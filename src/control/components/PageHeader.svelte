<!--
  Sticky page header: optional back control, 28px editorial title (optionally
  inline-editable), metadata line, trailing status + actions.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';

  interface Props {
    title: string;
    meta?: string;
    backLabel?: string;
    onback?: () => void;
    editableTitle?: boolean;
    ontitlechange?: (title: string) => void;
    status?: Snippet;
    actions?: Snippet;
  }

  let { title, meta, backLabel, onback, editableTitle = false, ontitlechange, status, actions }: Props =
    $props();

  /*
   * The input is a DRAFT of `title`, not the thing itself.
   *
   * Binding the element straight to the prop left no saved value to fall back
   * on: clearing the field committed nothing (an empty name is not a name) yet
   * the header went on showing the blank, so the screen claimed the script had
   * lost its title when nothing had changed. Escape had nothing to restore
   * from either. `$derived` re-seeds the draft whenever the saved title
   * changes underneath us — a rename from elsewhere, or a different script
   * loading into the same header.
   *
   * This makes the header a CONTROLLED input: it assumes `ontitlechange` leads
   * to a new `title` coming back. The one caller does that synchronously before
   * its first await (`stores/editor.ts`, `setTitle`). A caller that never
   * updated the prop would leave the committed draft on screen with the heading
   * still named after the old title, so keep that contract if another one
   * appears.
   */
  let draft = $derived(title);

  function commitTitle(): void {
    const next = draft.trim();
    // Nothing to save, so put the saved name back on the glass rather than
    // leaving a blank the operator never chose.
    if (!next) {
      draft = title;
      return;
    }
    draft = next;
    if (next !== title) ontitlechange?.(next);
  }

  function titleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      (event.currentTarget as HTMLInputElement).blur();
      return;
    }
    if (event.key === 'Escape') {
      // Abandon the edit.
      //
      // `stopPropagation` keeps the key from reaching an ancestor that would
      // read it as "close me". It does NOT currently rescue an editable header
      // placed inside a `Dialog`: that component listens on the window in the
      // CAPTURE phase, so it sees Escape before this handler runs and would
      // close before the edit could be cancelled. No caller nests the two today
      // — if one ever does, Dialog needs to learn that an inner control can own
      // the key, and stopping it here is not enough on its own.
      event.preventDefault();
      event.stopPropagation();
      draft = title;
      (event.currentTarget as HTMLInputElement).blur();
    }
  }
</script>

<header class="header">
  {#if onback}
    <button type="button" class="back" data-focus="control" onclick={onback}>
      <Icon name="chevron-left" size={15} />
      <span>{backLabel ?? 'Back'}</span>
    </button>
  {/if}
  <div class="bar">
    <div class="title-block">
      <!--
        The heading is unconditional. Swapping it for a bare input when the
        title is editable left the Editor — the screen an operator spends most
        of its time on — with no level-one heading at all, so nothing announced
        what the page was and heading navigation skipped straight past it. The
        input lives INSIDE the h1 instead: `input` is phrasing content, so this
        is valid, and the heading takes its accessible name from the saved
        title rather than from whatever is half-typed in the field.
      -->
      <h1 class="title" class:editing={editableTitle} aria-label={editableTitle ? title : undefined}>
        {#if editableTitle}
          <input
            class="title-input"
            bind:value={draft}
            aria-label="Script title"
            onblur={commitTitle}
            onkeydown={titleKeydown}
          />
        {:else}
          {title}
        {/if}
      </h1>
      {#if meta}<p class="meta">{meta}</p>{/if}
    </div>
    <div class="right">
      {#if status}<div class="status">{@render status()}</div>{/if}
      {#if actions}<div class="actions">{@render actions()}</div>{/if}
    </div>
  </div>
</header>

<style>
  .header {
    position: sticky;
    top: 0;
    z-index: 5;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-4) var(--page-x);
    background: var(--bg-canvas);
    border-bottom: 1px solid var(--border);
  }

  .back {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    height: 28px;
    padding: 0 var(--space-2) 0 var(--space-1);
    margin-left: calc(-1 * var(--space-1));
    border: none;
    background: transparent;
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font-size: var(--text-sm);
    font-weight: 600;
    transition:
      background var(--dur-fast) var(--ease-out),
      color var(--dur-fast) var(--ease-out);
  }
  .back:hover {
    color: var(--text-primary);
    background: var(--bg-hover-chrome);
  }

  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-5);
    min-width: 0;
  }

  .title-block {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1 1 auto;
  }
  .title {
    margin: 0;
    font-size: var(--text-page-title);
    line-height: var(--lh-page-title);
    font-weight: 650;
    letter-spacing: var(--ls-title);
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* Wrapping the input, the heading is a layout box and nothing else — the
     input carries the type. */
  .title.editing {
    display: flex;
    min-width: 0;
  }

  /* Editable title looks identical at rest; focus is a quiet surface shift —
     the inset edge comes from the central focus policy in tokens.css. */
  .title-input {
    margin: 0;
    padding: 0 var(--space-2);
    margin-left: calc(-1 * var(--space-2));
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    font-family: inherit;
    font-size: var(--text-page-title);
    line-height: var(--lh-page-title);
    font-weight: 650;
    letter-spacing: var(--ls-title);
    color: var(--text-primary);
    min-width: 0;
    width: 100%;
    transition:
      background var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out);
  }
  .title-input:hover {
    background: var(--bg-hover-chrome);
  }
  .title-input:focus {
    background: var(--bg-panel);
    border-color: var(--border);
  }

  .meta {
    margin: 0;
    font-size: var(--text-sm);
    line-height: 18px;
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-variant-numeric: tabular-nums;
  }

  .right {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex: 0 0 auto;
  }
  .status {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
</style>
