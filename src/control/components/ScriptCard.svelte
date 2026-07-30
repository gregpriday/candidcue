<!--
  A script in the library list.

  Replaces the generic `ListRow`, which only this screen ever used and which was
  wrong for it in one specific way: SELECTION REPLACED THE SURFACE. The rule was
  `background: var(--accent-wash)`, and `--accent-wash` is a 5%-alpha tint — so
  the card's white `--bg-panel` was not tinted, it was removed, and what showed
  through was 5% clay over the page canvas. Paired with `--border-strong`
  (a cold grey), a selected card became precisely the muddy-grey-plus-peachy-wash
  combination the design language forbids, and it looked like a disabled row
  rather than the chosen one.

  So here the surface is white in EVERY state and selection is additive: an inset
  leading bar (never a one-sided border on a rounded box) plus a firmer edge.
  Hover firms the border along a warm ramp — `--border` → `--border-control` —
  and never reaches `--border-strong`, which on a white card reads as grime.

  A single click selects AND opens; see the click handler for why the row does
  not wait for a second one.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    /** First plain-text line or so of the script — the thing that identifies it. */
    excerpt?: string;
    meta?: string[];
    selected?: boolean;
    /** Status capsule, rendered beside the title where it describes the script. */
    status?: Snippet;
    /** Present / Restore and the overflow menu. */
    actions?: Snippet;
    onopen?: () => void;
    onselect?: () => void;
  }

  let {
    title,
    excerpt,
    meta = [],
    selected = false,
    status,
    actions,
    onopen,
    onselect,
  }: Props = $props();
</script>

<div class="card" class:selected class:interactive={Boolean(onopen ?? onselect)}>
  <button
    type="button"
    class="main"
    onclick={() => {
      // Select first: a caller may open by navigating away, and the selection is
      // what the library remembers for when the operator comes back.
      onselect?.();
      onopen?.();
    }}
    aria-current={selected ? 'true' : undefined}
  >
    <span class="heading">
      <span class="title">{title}</span>
      <!--
        Rendered bare rather than in a wrapper span: the status snippet is often
        empty (most scripts are neither warned nor prepared), and a wrapper would
        still be a flex item, so the heading would carry a phantom 8px gap after
        the title on every card that has nothing to report.
      -->
      {@render status?.()}
    </span>
    {#if excerpt}<span class="excerpt">{excerpt}</span>{/if}
    {#if meta.length > 0}
      <span class="meta">
        {#each meta as part, index (part)}
          {#if index > 0}<span class="dot" aria-hidden="true">·</span>{/if}<span>{part}</span>
        {/each}
      </span>
    {/if}
  </button>
  {#if actions}
    <div class="actions">{@render actions()}</div>
  {/if}
</div>

<style>
  .card {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-panel);
    box-shadow: var(--shadow-card);
    transition:
      border-color var(--motion-base) var(--ease-out),
      box-shadow var(--motion-base) var(--ease-out);
  }
  .interactive:hover {
    border-color: var(--border-control);
    box-shadow: var(--shadow-hover);
  }

  /*
   * Selection is a leading bar INSIDE the card, inset from both ends.
   *
   * Not a left border: a 3px edge on one side of a 12px-radius box leaves the
   * rounded corners half-painted, which is the crescent the design language
   * rules out. An inset `::before` sits clear of the corners entirely.
   */
  .selected {
    border-color: var(--border-control);
  }
  .selected::before {
    content: '';
    position: absolute;
    left: -1px;
    top: var(--space-4);
    bottom: var(--space-4);
    width: 3px;
    border-radius: 0 var(--radius-pill) var(--radius-pill) 0;
    background: var(--accent);
  }

  .main {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-1);
    flex: 1 1 auto;
    min-width: 0;
    border: none;
    background: transparent;
    padding: 0;
    text-align: left;
    color: inherit;
    /* Card focus is a quiet edge shift, not an accent ring around a surface. */
    outline: none;
  }
  .main:focus-visible {
    outline: none;
  }
  .card:has(.main:focus-visible) {
    border-color: var(--border-control);
    box-shadow: var(--shadow-hover);
  }

  .heading {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    max-width: 100%;
    min-width: 0;
  }
  .title {
    font-size: var(--text-lg);
    line-height: 24px;
    font-weight: 650;
    letter-spacing: var(--ls-title);
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .heading :global(.pill) {
    flex: 0 0 auto;
  }

  /*
   * Two lines of real prose, clipped on a LINE boundary.
   *
   * Deliberately not `-webkit-line-clamp`. Clamping appends its own ellipsis at
   * the visual cut, and that cut is a character position, so it breaks words —
   * which is the artifact being removed here ("…begin slowl…"). It would have
   * silently undone the word-boundary fix in `preview_text`, one layer further
   * down, and only on the widths where 200 characters happen to overflow.
   *
   * A max-height of exactly two line boxes instead: the text wraps normally, the
   * third line is clipped in full, and the last thing visible is therefore always
   * a whole word at a natural wrap point. `--prose-measure` keeps the column at a
   * readable width rather than letting it run the length of the card.
   */
  .excerpt {
    display: block;
    max-height: 40px; /* 2 × the 20px line-height below */
    overflow: hidden;
    max-width: var(--prose-measure);
    font-size: var(--text-sm);
    line-height: 20px;
    color: var(--text-secondary);
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 2px;
    font-size: var(--text-xs);
    line-height: var(--lh-meta);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .dot {
    color: var(--text-faint);
  }

  .actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex: 0 0 auto;
    align-self: center;
  }
</style>
