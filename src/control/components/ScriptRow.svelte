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
  metadata in stable columns. §10.1's anatomy, in order: selection background,
  title (with readiness beside it, when there is any), one line of excerpt,
  duration, modified, trailing action.

  ---------------------------------------------------------------------------
  SELECTION AND FOCUS ARE DIFFERENT THINGS, DRAWN DIFFERENTLY
  ---------------------------------------------------------------------------
  §10.2 and §23.3 both insist on this and it is the property most easily lost.
  Three states have to be told apart:

    selected, list focused      accent marker + accent tint
    selected, list NOT focused  the same marker, dimmed, over the faintest tint
    focused, not selected       the quiet inset edge from the central focus policy

  A list that draws all three the same way tells a keyboard user nothing about
  where their next keystroke lands, which is the entire content of §23.3.

  WHAT CHANGED, AND WHY THE OLD PAIR WAS WRONG
  --------------------------------------------
  Selection used to be a FILL, and the unfocused half of it was a flat warm grey
  (#e8e3db). Two things went wrong with that. Spread across a full-width row on a
  white list it read as dirt rather than as a state — this project's own design
  rules name that failure and forbid it. And the pair was incoherent:
  neutral-grey and terracotta are not two steps of one idea, so the two states
  looked like two unrelated things rather than "selected" and "selected, and the
  keyboard is here".

  So selection is carried by a MARKER — the inset accent bar used everywhere
  else in this codebase for exactly this — and focus is carried by the strength
  of that marker and its tint. One idea, two intensities. The row stays white,
  so a run of them still reads as a table, and nothing is grey-on-white.

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
    if (!(target instanceof HTMLElement)) return true;
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
    -->
    {#if !compact}
      <span class="excerpt" aria-hidden={excerpt ? undefined : 'true'}>{excerpt || '\u00a0'}</span>
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
    /* The selection marker below is positioned against this. */
    position: relative;
    transition: background var(--dur-fast) var(--ease-out);
  }
  /* Same gap as comfortable, so switching density does not slide the columns
     sideways under the headings. */
  .compact {
    height: var(--list-row-h-compact);
  }
  .interactive {
    cursor: default;
  }

  .interactive:hover {
    background: var(--bg-hover-surface);
  }

  /*
   * SELECTION IS A MARKER, NOT A WASH.
   *
   * The bar is the state; the tint only ties the row to it. That ordering is
   * what keeps a selected row from looking soiled — the strongest thing on the
   * row is 3px of brand colour rather than a full-width block of grey.
   *
   * Inset, never a one-sided border: the list has a radius and clips its rows,
   * so a border-left would cut a straight edge through the rounded corner on
   * the first and last row.
   */
  .selected::before {
    content: '';
    position: absolute;
    left: 5px;
    top: 6px;
    bottom: 6px;
    width: 3px;
    border-radius: var(--radius-pill);
    background: var(--accent);
    /*
     * Dimmed while the keyboard is elsewhere. Opacity rather than a second
     * colour, so the two states are visibly the same mark at two strengths —
     * which is the distinction §23.3 actually wants drawn.
     *
     * Dimmed, not faded out: the selection is still what every File command
     * acts on, so it must still be findable. 0.85 keeps the bar at 3.4:1
     * against the resting tint (SC 1.4.11's 3:1 for a state); the 0.45 it
     * used to be was 1.8:1, and with search focused the selected script was
     * barely distinguishable from its neighbours.
     */
    opacity: 0.85;
    transition: opacity var(--dur-fast) var(--ease-out);
  }
  .selected {
    background: var(--accent-wash);
  }
  .selected.list-focused::before {
    opacity: 1;
  }
  .selected.list-focused,
  .selected.list-focused:hover {
    background: var(--bg-row-selected);
  }
  /*
   * Hover over an already-selected row DEEPENS rather than resets. The old rule
   * repainted it with the resting selection colour, so passing the pointer over
   * the selected row was the one place in the list where hover did nothing.
   */
  .selected:hover {
    background: var(--bg-row-selected-hover);
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

  .col {
    flex: 0 0 auto;
    font-size: var(--text-xs);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    text-align: right;
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
