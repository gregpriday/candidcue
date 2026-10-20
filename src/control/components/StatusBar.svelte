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

<!--
  A NAMED landmark (§23.2). `<footer>` at the top level of a route is already
  `contentinfo`; the name is what lets a screen-reader user jump to the
  document's state instead of walking the route to find it.
-->
<footer class="statusbar" aria-label="Status">
  {#if announcement !== undefined}
    <p class="announcement" role="status" aria-live="polite">{announcement}</p>
  {/if}
  <div class="group">
    {#each items as item (item.key)}{@render entry(item)}{/each}
  </div>

  <div class="group trailing">
    {#if extra}{@render extra()}{/if}
    {#each trailing as item (item.key)}{@render entry(item)}{/each}
  </div>
</footer>

{#snippet content(item: StatusBarItem)}
  {#if item.parts}
    {#each item.parts as part (part.key)}
      <span class="part {part.tone ?? 'normal'}">
        {#if part.icon}<Icon name={part.icon} size={13} />{/if}
        <span class="label">{part.label}</span>
      </span>
    {/each}
  {:else}
    {#if item.icon}<Icon name={item.icon} size={13} />{/if}
    <span class="label">{item.label}</span>
  {/if}
{/snippet}

{#snippet entry(item: StatusBarItem)}
  {#if item.onclick}
    <button
      type="button"
      class="item interactive {item.tone ?? 'normal'}"
      data-focus="control"
      title={item.title}
      onclick={item.onclick}
    >
      {@render content(item)}
    </button>
  {:else}
    <span class="item {item.tone ?? 'normal'}" title={item.title}>
      {@render content(item)}
    </span>
  {/if}
{/snippet}

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
    /*
     * The type is set HERE, once, and inherited — never on `.item`. A button
     * needs `font: inherit`, and that shorthand resets size and line height to
     * whatever the button's parent has. When the size lived on `.item`, the
     * button's own `font: inherit` overrode it, and the one clickable fact in
     * the bar was drawn at body size beside 11px neighbours. (The global
     * button reset in tokens.css supplies the `font: inherit` now.)
     */
    font-size: var(--text-2xs);
    /* Room for descenders: labels clip their overflow (to truncate), and a
       line box of exactly 1em cut the tails off "scripts" and "agents". */
    line-height: 16px;
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

  /*
   * No `overflow: hidden` on the group. It used to clip there, and the 24px
   * band is shorter than a focused button and its ring, so keyboard focus on
   * the one button in the bar was cut down to a lone terracotta "(". Each
   * item clips its own contents instead (an element's overflow never clips
   * its own outline), and labels ellipsize inside it.
   */
  .group {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    flex: 0 1 auto;
    min-width: 0;
  }
  /*
   * When the band runs out of room the trailing group gives way first, and
   * its labels ellipsize rather than pushing the leading facts out of view.
   * It used to refuse to shrink at all, so a long selected title in a narrow
   * window clipped the script count instead of itself.
   *
   * A zero basis, not a bigger shrink factor: shrinking is shared out by size,
   * so a long enough title still took a share out of the leading group and
   * cut the search phrase off before its closing quote. With no basis of its
   * own, the trailing group has only the room the leading facts leave.
   */
  .trailing {
    justify-content: flex-end;
    flex: 1 1 0;
  }
  /* The first leading fact (a count, a word total) is never the one cut. */
  .group:not(.trailing) > .item:first-child {
    flex-shrink: 0;
  }

  .item {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--text-muted);
    white-space: nowrap;
    min-width: 0;
    overflow: hidden;
  }
  /* Two runs in one item ("1 error", "2 notes"): each keeps its own glyph and
     tone, held closer together than two separate facts — clearly closer, so
     the pair reads as one control rather than as a gap drawn slightly wrong. */
  .part {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
  }
  .item > .part + .part {
    margin-left: var(--space-1);
  }
  .label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .interactive {
    border: none;
    background: transparent;
    padding: 0 5px;
    /*
     * The fill reaches past the text into the gap, so the text itself sits on
     * the same rhythm as the facts beside it. Without this the one button in
     * the bar stood 5px further off its neighbour than any other item did.
     */
    margin-inline: -5px;
    /* The band's content box is 23px under its 1px rule: 19 leaves an even
       2px above and below, where 18 sat a half pixel low. */
    height: 19px;
    border-radius: 4px;
    transition:
      background var(--dur-fast) var(--ease-out),
      color var(--dur-fast) var(--ease-out);
  }
  /* The target is taller than the fill: 19px is what the band has room to
     DRAW, and a pointer target under 24px (WCAG 2.5.8) is a miss waiting to
     happen at the bottom edge of the window. The extension is invisible and
     reaches past the band's own edge, which nothing else claims. */
  .interactive {
    position: relative;
    /* `.item` clips, for the label's ellipsis — and a clipped box clips the
       extension below with it. The label inside does its own truncating. */
    overflow: visible;
  }
  .interactive::after {
    content: '';
    position: absolute;
    inset: -3px 0;
  }
  /*
   * On the window's material the status band is chrome like the toolbar band,
   * and wears the same glass (tokens.css, WINDOW MATERIAL): the frame closes
   * at the bottom as it does at the top. Its own opaque tone matched the
   * chrome in light and the paper in dark — a band in one appearance and a
   * well in the other.
   */
  :global(html[data-window-material][data-material-rail]) .statusbar {
    --bg-hover-statusbar: var(--material-hover);
    background: var(--material-tint);
    border-top-color: var(--material-rule);
  }
  .interactive:hover {
    background: var(--bg-hover-statusbar);
  }
  .interactive:active {
    background: var(--bg-active-statusbar);
  }
  /* Only a plain item darkens on hover. A toned one keeps its tone: a fault
     that turned charcoal under the pointer stopped looking like a fault at the
     moment somebody went to look at it. */
  .interactive.normal:hover,
  .interactive.normal:active {
    color: var(--text-primary);
  }
  /*
   * What it does is named at rest, not only under the pointer: a quiet
   * underline in the item's own colour, the mark the outline's diagnostic
   * links already carry. Without it "125%" read as one more fact.
   */
  .interactive .label {
    text-decoration-line: underline;
    text-decoration-thickness: 1px;
    text-decoration-color: color-mix(in srgb, currentColor 40%, transparent);
    text-underline-offset: 2px;
  }
  /*
   * The accent ring (`data-focus="control"`) drawn on the fill's own edge
   * rather than 2px out from it. Out, a ring needs 4px more than the button
   * and the band has 2 to spare on each side, so it ran into the rule above
   * and the window's edge below.
   */
  .interactive:focus-visible {
    outline-offset: -2px;
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
