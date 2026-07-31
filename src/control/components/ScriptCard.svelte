<!--
  A script in the library list.

  ---------------------------------------------------------------------------
  THE CARD DOES NOT DRAW SELECTION, BECAUSE THIS LIST HAS NO SELECTION TO DRAW
  ---------------------------------------------------------------------------
  It used to. The library store remembers `selectedId` — set by opening a
  script, read by the Present shortcut so it has a target — and the card wore a
  terracotta leading bar to show it.

  That mark could not be earned. Nothing on this screen acts on "the selected
  script": there is no multi-select, no keyboard list navigation, no bulk
  action, and every card carries its own Present button and its own menu. A
  click selects and opens in the same gesture, so the bar was only ever a
  record of which script you were last inside — shown on return from the
  editor, on a screen where that fact changes nothing you can do. An accent
  mark that names a state with no consequences is decoration reading as
  meaning, and it made the top card look singled out for no reason.

  `selectedId` is untouched: the shortcut still resolves, and the flag that
  used to exist purely to keep the boot-time fallback from wearing the bar went
  with the bar.

  The surface itself is white in EVERY state — the ancestor of this component
  set `background: var(--accent-wash)` on selection, a 5%-alpha tint, which did
  not tint the white panel so much as remove it and let 5% clay over the page
  canvas show through. Hover firms the border along a warm ramp
  (`--border` → `--border-control`) and never reaches `--border-strong`, which
  on a white card reads as grime.

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
    status,
    actions,
    onopen,
    onselect,
  }: Props = $props();
</script>

<div class="card" class:interactive={Boolean(onopen ?? onselect)}>
  <button
    type="button"
    class="main"
    data-focus="delegate"
    onclick={() => {
      // Select first: a caller may open by navigating away, and the selection is
      // what the library remembers for when the operator comes back.
      onselect?.();
      onopen?.();
    }}
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
  /*
   * Focus moves to the CARD edge, and it has to be visible enough to count.
   *
   * This used to shift the border to --border-control and lift the shadow —
   * which is character-for-character what `.interactive:hover` already does, so
   * a keyboard user got a state indistinguishable from "the mouse is somewhere
   * near this", and at 1.79:1 against the white card it was under the 3:1 that
   * a border-as-state-signal owes SC 1.4.11 anyway. The inset ring in
   * --focus-quiet clears 3:1 on its own and cannot be confused with hover.
   */
  .card:has(.main:focus-visible) {
    border-color: var(--border-control);
    box-shadow:
      inset 0 0 0 2px var(--focus-quiet),
      var(--shadow-hover);
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
