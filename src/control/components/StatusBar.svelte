<!--
  The bottom status band (desktop refinement §10.8, §11.7).

  ---------------------------------------------------------------------------
  WHAT GOES HERE, AND WHY IT IS NOT A NOTIFICATION FEED
  ---------------------------------------------------------------------------
  A status bar carries facts that are ALWAYS TRUE of what is on screen — how
  many scripts matched, how many words the script has, whether it compiled. That
  is a different category from an event, which is what a toast is for, and from a
  fault, which needs to be next to the thing that failed.

  §24.1's rule is state ownership: every state appears closest to the object that
  owns it, and exactly one surface is canonical. So this band is deliberately
  narrow in what it will accept — §10.8 says so directly: do not turn the status
  bar into a notification feed.

  ---------------------------------------------------------------------------
  24px, AND THE LAYOUT DOES NOT MOVE
  ---------------------------------------------------------------------------
  Counts change constantly. Tabular numerals stop a word count from jittering as
  it crosses 999, and the height is fixed for the same reason the toolbar's is:
  a band that grew when a warning appeared would shove the document.

  ---------------------------------------------------------------------------
  ITEMS ARE BUTTONS ONLY WHEN CLICKING THEM DOES SOMETHING
  ---------------------------------------------------------------------------
  §11.7: let each item act as a button only when clicking it opens a meaningful
  panel. An item with an `onclick` renders as a button and takes focus; one
  without renders as plain text and is skipped by the keyboard, because a tab
  stop that does nothing is worse than no tab stop.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';
  import type { StatusBarItem } from './status-bar-item';

  interface Props {
    /** Left group: what this screen is showing. */
    items?: StatusBarItem[];
    /** Right group: what the application is doing. */
    trailing?: StatusBarItem[];
    /** An escape hatch for a control that is not a label (a density toggle). */
    extra?: Snippet;
    /**
     * A short sentence announced when it changes (§23.2).
     *
     * The Library's result count moved into this band, and a band that is only
     * painted tells a screen-reader user nothing when a search narrows fifty
     * scripts to two. This is a SEPARATE, polite live region rather than
     * `aria-live` on the whole bar: making the bar live would re-announce every
     * word count and cursor position as it changed, which is the interruption
     * §23.2 warns about in the same breath.
     *
     * Absent means "this screen has nothing worth announcing", which is the
     * right default — the editor's word count changes on every keystroke.
     */
    announcement?: string;
  }

  let { items = [], trailing = [], extra, announcement }: Props = $props();
</script>

<footer class="statusbar">
  {#if announcement !== undefined}
    <p class="announcement" role="status" aria-live="polite">{announcement}</p>
  {/if}
  <div class="group">
    {#each items as item (item.key)}
      {#if item.onclick}
        <button
          type="button"
          class="item interactive {item.tone ?? 'normal'}"
          data-focus="control"
          title={item.title}
          onclick={item.onclick}
        >
          {#if item.icon}<Icon name={item.icon} size={13} />{/if}
          <span>{item.label}</span>
        </button>
      {:else}
        <span class="item {item.tone ?? 'normal'}" title={item.title}>
          {#if item.icon}<Icon name={item.icon} size={13} />{/if}
          <span>{item.label}</span>
        </span>
      {/if}
    {/each}
  </div>

  <div class="group trailing">
    {#if extra}{@render extra()}{/if}
    {#each trailing as item (item.key)}
      {#if item.onclick}
        <button
          type="button"
          class="item interactive {item.tone ?? 'normal'}"
          data-focus="control"
          title={item.title}
          onclick={item.onclick}
        >
          {#if item.icon}<Icon name={item.icon} size={13} />{/if}
          <span>{item.label}</span>
        </button>
      {:else}
        <span class="item {item.tone ?? 'normal'}" title={item.title}>
          {#if item.icon}<Icon name={item.icon} size={13} />{/if}
          <span>{item.label}</span>
        </span>
      {/if}
    {/each}
  </div>
</footer>

<style>
  .statusbar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    height: var(--statusbar-h);
    padding-inline: var(--page-x);
    background: var(--bg-statusbar);
    border-top: var(--divider-w) solid var(--divider);
    /* Tabular everywhere: this band is mostly numbers, and proportional digits
       make a live word count shuffle sideways as it counts. */
    font-variant-numeric: tabular-nums;
    /* No radius. §9.2: permanent panes have straight edges. */
    border-radius: 0;
    user-select: none;
  }

  /* Announced, never drawn — the visible items already carry the same words. */
  .announcement {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .group {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    min-width: 0;
    overflow: hidden;
  }
  .trailing {
    justify-content: flex-end;
    flex: 0 0 auto;
  }

  .item {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: var(--text-2xs);
    line-height: 1;
    color: var(--text-muted);
    white-space: nowrap;
  }

  .interactive {
    border: none;
    background: transparent;
    padding: 0 4px;
    height: 18px;
    border-radius: 4px;
    font: inherit;
    color: inherit;
    transition:
      background var(--dur-fast) var(--ease-out),
      color var(--dur-fast) var(--ease-out);
  }
  .interactive:hover {
    background: var(--bg-hover-chrome);
    color: var(--text-primary);
  }

  /*
   * Tones carry an icon as well as a colour at every call site that uses them
   * (§9.4: colour is never the only state signal). The component cannot enforce
   * that — it can only make the colours available — so the icon is required by
   * convention and checked in review rather than by the type.
   */
  .warning {
    color: var(--warning);
  }
  .danger {
    color: var(--danger);
  }
  .accent {
    color: var(--accent-strong);
  }
</style>
