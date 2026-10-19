<!--
  One script in the Library collection (desktop refinement §10.1).

  ---------------------------------------------------------------------------
  A ROW, NOT A CARD
  ---------------------------------------------------------------------------
  `ScriptCard` drew each script as a rounded, bordered, shadowed surface that
  lifted on hover, with two lines of excerpt and its own miniature metadata
  layout. Fifty of those is a stack of floating tiles: nothing lines up column to
  column, the eye has to re-find the title on every row, and the hover lift makes
  a list feel like a page of links.

  This is a 52px row on one continuous surface, separated by hairlines, with the
  metadata in stable columns. §10.1's anatomy, in order: selection highlight,
  title (with readiness beside it, when there is any), one line of excerpt,
  duration, modified, trailing action.

  ---------------------------------------------------------------------------
  ONE HIGHLIGHT FOR HOVER, SELECTION AND FOCUS
  ---------------------------------------------------------------------------
  §10.2 and §23.3 insist that selected-and-focused be told apart from
  selected-and-not, and it is the property most easily lost. A list that draws
  them the same tells a keyboard user nothing about where their next keystroke
  lands.

  Every state is the same rounded highlight, inset from the row's edges, in one
  neutral ink at rising strength — hover, selected, selected with the list
  focused — plus the quiet 2px edge on that highlight when the keyboard put
  focus there. The ramp is in tokens.css (`--bg-row-*`).

  WHAT IT REPLACED
  ----------------
  Hover was a warm grey and selection a clay tint with an accent bar at its
  leading edge: two unrelated colours, so hover never read as a lighter version
  of selection, and the faintest selection step was so close to white that only
  the bar found it. Any clay light enough to sit behind body text reads pink or
  peach on white. The bar was a second signal for a state the fill already
  carries, and on a focused row it stacked against the keyboard edge.

  ---------------------------------------------------------------------------
  ACTIONS APPEAR ON HOVER, FOCUS OR SELECTION
  ---------------------------------------------------------------------------
  §10.1: keep row actions hidden until hover, focus or selection so the list does
  not become button-heavy. `visibility` rather than conditional rendering, so the
  row's layout does not shift when the pointer crosses it — and so the buttons
  stay in the tab order for the selected row, which is the one a keyboard user is
  operating.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    excerpt?: string;
    /** Right-aligned columns, in a fixed order the caller keeps stable. */
    duration: string;
    modified: string;
    /** Shown only when it is actionable (§10.1). */
    status?: Snippet;
    actions?: Snippet;
    selected?: boolean;
    /** The list containing this row has DOM focus. */
    listFocused?: boolean;
    /** Compact density, for large libraries (§10.1). */
    compact?: boolean;
    /** Withheld in Trash, where the body does nothing. */
    onselect?: () => void;
    onopen?: () => void;
    oncontextmenu?: (event: MouseEvent) => void;
    /** The row element, so the list can scroll it into view and focus it. */
    element?: HTMLElement | null;
    onkeydown?: (event: KeyboardEvent) => void;
    /** Roving tabindex: only the selected row is a tab stop. */
    tabindex?: 0 | -1;
  }

  let {
    title,
    excerpt,
    duration,
    modified,
    status,
    actions,
    selected = false,
    listFocused = false,
    compact = false,
    onselect,
    onopen,
    oncontextmenu,
    element = $bindable(null),
    onkeydown,
    tabindex = -1,
  }: Props = $props();

  const interactive = $derived(Boolean(onopen ?? onselect));

  let titleElement: HTMLElement | null = $state(null);
  /**
   * The full title as a tooltip, offered only when the row has cut it short.
   *
   * Measured when the pointer arrives rather than kept up to date, because
   * the pointer arriving is the only moment the answer is wanted — and a long
   * title beside a "Needs attention" pill in a narrow window is exactly the
   * one a reader cannot otherwise finish without selecting the row.
   */
  let titleTip: string | undefined = $state(undefined);

  function measureTitle(): void {
    titleTip =
      titleElement !== null && titleElement.scrollWidth > titleElement.clientWidth ? title : undefined;
  }

  /**
   * Whether the duration column holds a measurement or a placeholder.
   *
   * Tested for a digit rather than compared against "—", so it stays correct if
   * `formatSpeakingDuration` ever picks a different placeholder, and so this
   * component needs no knowledge of which string that is.
   */
  const hasDuration = $derived(/\d/.test(duration));

  /**
   * Controls that own their own events. Anything inside one of these is not the
   * row's business.
   */
  const CONTROL_SELECTOR =
    'button, a[href], input, select, textarea, [role="menu"], [role="menuitem"], [role="menuitemcheckbox"]';

  /**
   * Did this event belong to the row, or to a control sitting inside it?
   *
   * ---------------------------------------------------------------------------
   * THE BUG THIS EXISTS TO PREVENT
   * ---------------------------------------------------------------------------
   * The row carries Present/Restore and an overflow menu. Their events BUBBLE.
   * Without this test, the row's own handlers ran for all of them:
   *
   *   - Enter on Present opened the script instead of presenting it, because the
   *     row saw Enter first, called `preventDefault()`, and opened;
   *   - in Trash, where there is no `onopen`, Enter on Restore did nothing at
   *     all — the row consumed the key and had nothing to do with it;
   *   - arrows pressed inside the open overflow menu also moved the Library's
   *     selection underneath it, and Delete inside the menu trashed the row.
   *
   * ---------------------------------------------------------------------------
   * WHY NOT `event.target === event.currentTarget`
   * ---------------------------------------------------------------------------
   * That was the first version and it was too strict, in a way only a real
   * browser showed: a pointer event aimed at the row lands on whatever is under
   * the cursor, which for most of the row's area is the `.title` span or the
   * `.main` wrapper — not the row element. So double-clicking a script's NAME,
   * the most obvious way to open one, did nothing at all.
   *
   * The question is not "was the row the exact target" but "did this come from
   * something that owns the event", so the test is for an enclosing control,
   * bounded to this row.
   */
  function fromRowItself(event: Event): boolean {
    const target = event.target;
    // `Element`, not `HTMLElement`: a press on a button's icon targets the
    // SVG inside it, and a double click on the overflow trigger's dots counted
    // as the row's own surface and opened the script.
    if (!(target instanceof Element)) return true;
    if (target === event.currentTarget) return true;
    const control = target.closest(CONTROL_SELECTOR);
    // A control OUTSIDE this row cannot have produced an event that bubbled to
    // it, but bounding the search is what makes this safe against portals.
    return control === null || !(event.currentTarget as HTMLElement).contains(control);
  }

  function click(event: MouseEvent): void {
    // A single click SELECTS; it does not open. That is the desktop collection
    // model §10.2 asks for, and it is what makes the inspector, the context
    // menu and the File commands meaningful — they all act on "the selected
    // script", which single-click-to-open would never leave standing.
    //
    // A click on a nested button still selects the row — pressing Present on a
    // row plainly means "this one" — but it must not also open it.
    onselect?.();
    void event;
  }

  function dblclick(event: MouseEvent): void {
    // Only a double click on the row's own surface opens. Double-clicking a
    // button inside it is two activations of that button, not an open.
    if (!fromRowItself(event)) return;
    onopen?.();
  }

  function keydown(event: KeyboardEvent): void {
    // A key pressed inside a nested control belongs to that control, and to
    // nothing else. Returning without calling `onkeydown` also keeps it away
    // from the LIST's handler, which owns arrows, Home/End and Delete.
    if (!fromRowItself(event)) return;
    // Enter opens the row it is on. Everything else — arrows, Home/End, Delete
    // — belongs to the list, which owns cross-row movement.
    if (event.key === 'Enter') {
      event.preventDefault();
      onopen?.();
      return;
    }
    onkeydown?.(event);
  }
</script>

<!--
  The linter reads `role="option"` as non-interactive and objects to the
  tabindex. It is wrong here: an option inside a listbox that uses ROVING
  TABINDEX is focusable by definition — that is what makes the pattern work —
  and removing the tabindex would leave the list reachable only by pointer.
-->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  class="row"
  class:selected
  class:list-focused={listFocused}
  class:compact
  class:interactive
  role={interactive ? 'option' : 'presentation'}
  aria-selected={interactive ? selected : undefined}
  tabindex={interactive ? tabindex : undefined}
  bind:this={element}
  data-focus="surface"
  onclick={interactive ? click : undefined}
  ondblclick={interactive ? dblclick : undefined}
  oncontextmenu={oncontextmenu}
  onkeydown={interactive ? keydown : undefined}
  onpointerenter={measureTitle}
>
  <div class="main">
    <!--
      The status rides on the title's line, after it. It used to have a column
      of its own, which was empty on every healthy row and too narrow for the
      pill on the rest — so "Needs attention" printed over the date beside it.
      Here the title truncates before the pill does.
    -->
    <span class="title-line">
      <span class="title" bind:this={titleElement} title={titleTip}>{title}</span>
      {@render status?.()}
    </span>
    <!--
      ONE line of excerpt, and only outside compact density. §10.1: two full
      lines in the default list is harder to scan than one, and the second line
      is what turned every card into a paragraph.

      The line is kept even when there is no excerpt, so every title sits at the
      same height in its row. A script with nothing in it used to centre its
      title, and the column of titles stepped up and down as the eye ran it.
      Kept blank, it read as a gap where something had failed to load; it says
      the script is empty instead.
    -->
    {#if !compact}
      {#if excerpt}
        <span class="excerpt">{excerpt}</span>
      {:else}
        <span class="excerpt absent">No text yet</span>
      {/if}
    {/if}
  </div>

  <!--
    Stable columns, tabular numerals, fixed widths. The point of a column is
    that the eye can run down it; a duration that starts at a different x on
    every row is not a column, it is trailing text. The widths come from the
    list, which draws the column headings over them.
  -->
  <span class="col duration" class:empty={!hasDuration}>{duration}</span>
  <span class="col modified">{modified}</span>

  {#if actions}
    <div class="actions">{@render actions()}</div>
  {/if}
</div>

<style>
  .row {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    height: var(--list-row-h);
    padding: 0 var(--space-3);
    min-width: 0;
    /* No radius, no border, no shadow. The rows sit on one continuous surface
       and are separated by the list's own hairlines (§10.1). */
    background: transparent;
    /* The highlight below is positioned against this. NOT a stacking context
       (no isolation, no z-index): the overflow menu opens inside this row and
       has to paint over the rows after it, and a row that isolated itself
       trapped the menu under the next row's dates. */
    position: relative;
  }
  /* Same gap as comfortable, so switching density does not slide the columns
     sideways under the headings. */
  .compact {
    height: var(--list-row-h-compact);
  }
  .interactive {
    cursor: default;
  }

  /*
   * ONE HIGHLIGHT, FIVE STRENGTHS.
   *
   * Every row state is the same rounded shape, inset from the row's edges, in
   * one colour family at rising strength:
   *
   *   hover  <  selected  <  selected + hover  <  focused  <  focused + hover
   *
   * so hover reads as a lighter version of selection rather than as a second,
   * unrelated colour, and "the keyboard is here" (§23.3) is the same mark,
   * firmer. There is no marker bar: the fill is the selection.
   *
   * Drawn on a pseudo-element rather than on the row, so the row keeps its full
   * height — the list's paging arithmetic reads a row's height as its pitch —
   * and inset so the highlight never meets the collection's border or its
   * rounded corners.
   */
  .row::before {
    content: '';
    position: absolute;
    inset: 2px 4px;
    border-radius: var(--radius-sm);
    background: transparent;
    transition: background var(--dur-fast) var(--ease-out);
  }
  /* A compact row's Present button is 28px in a 38px row: inset the
     highlight less, so the keyboard edge keeps clear of the button. */
  .compact::before {
    inset: 1px 4px;
  }
  .interactive:hover::before {
    background: var(--bg-row-hover);
  }
  .selected::before {
    background: var(--bg-row-selected-quiet);
  }
  .selected:hover::before {
    background: var(--bg-row-selected-quiet-hover);
  }
  .selected.list-focused::before {
    background: var(--bg-row-selected);
  }
  .selected.list-focused:hover::before {
    background: var(--bg-row-selected-hover);
  }
  /*
   * The keyboard edge goes on the highlight, not around the full-width row.
   * Drawn on the row it was a square frame pressed against the collection's
   * own border; here it is the same quiet 2px inset edge the central focus
   * policy uses, following the highlight's corners.
   */
  .row:focus-visible {
    outline: none;
  }
  .row:focus-visible::before {
    outline: 2px solid var(--focus-quiet);
    outline-offset: -2px;
  }

  /*
   * Positioned (with no z-index) so each paints after the highlight, which is
   * the row's first positioned box — the order that keeps text on top of the
   * fill without making the row a stacking context.
   */
  .main,
  .col,
  .actions {
    position: relative;
  }

  .main {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 1px;
    flex: 1 1 auto;
    min-width: 0;
  }

  /* A fixed line box, so a row carrying a status pill puts its title at the
     same height as one that does not. */
  .title-line {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    height: 20px;
    min-width: 0;
  }

  .title {
    flex: 0 1 auto;
    min-width: 0;
    font-size: var(--text-sm);
    line-height: 20px;
    font-weight: 600;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .selected .title {
    color: var(--text-primary);
  }

  .excerpt {
    font-size: var(--text-xs);
    line-height: var(--lh-meta);
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* Says the script is empty, in the voice the app uses for anything absent
     (the editor outline's untitled section): italic, so it cannot be mistaken
     for a script that happens to begin with those words. */
  .excerpt.absent {
    font-style: italic;
    color: var(--text-faint);
  }

  .col {
    flex: 0 0 auto;
    font-size: var(--text-xs);
    line-height: 20px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    text-align: right;
  }
  /*
   * On the title's line, not floating between the title and the excerpt where
   * it lines up with neither. The offset is where the centred two-line text
   * block starts: the row less the title line, the gap and the excerpt line,
   * halved. Compact rows are one line, and everything there stays centred.
   */
  .row:not(.compact) .col {
    align-self: flex-start;
    margin-top: calc((var(--list-row-h) - 21px - var(--lh-meta)) / 2);
  }
  .duration {
    width: var(--col-length, 72px);
  }
  /*
   * A script with nothing in it has no duration, and a column of em dashes at
   * full metadata weight competes with the durations that mean something. The
   * placeholder recedes; the real values stay where they were.
   */
  .col.empty {
    color: var(--text-faint);
  }
  .modified {
    width: var(--col-modified, 112px);
  }

  /*
   * Hidden until hover, focus or selection — but still occupying their space,
   * so nothing reflows as the pointer travels down the list. A fixed width
   * rather than the width of whatever is in it, so the columns to its left
   * line up under their headings whether the row offers Present or Restore.
   */
  .actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-1);
    flex: 0 0 auto;
    width: var(--col-actions, 120px);
    visibility: hidden;
  }
  .row:hover .actions,
  .row:focus-within .actions,
  .selected .actions {
    visibility: visible;
  }

  /*
   * At narrow widths the columns go before the excerpt does.
   *
   * §21.3 in miniature: collapse optional things before compressing the core.
   * The title is the core; a last-modified stamp is not, and squeezing it to
   * four characters is worse than dropping it.
   */
  @media (max-width: 900px) {
    .duration {
      display: none;
    }
  }
</style>
