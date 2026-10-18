<!--
  A primary action with its alternatives one click away.

  ---------------------------------------------------------------------------
  WHY A SPLIT BUTTON AND NOT TWO BUTTONS, OR A SETTING
  ---------------------------------------------------------------------------
  This exists for Present, which has two shapes — take the display, or present
  in an ordinary window — and one of them is right about nine times in ten.

  Two co-equal buttons would make the operator choose on every take, including
  the nine where there is nothing to decide, and would say by their equal weight
  that the choice matters more than it does. A setting alone is what the app had:
  correct, persistent, and three levels away from the button, so in practice the
  only reachable control was the transient mid-take toggle and the launch mode
  looked like it was being forgotten.

  The split button is what Google Slides, and every toolbar that has faced this,
  settles on: the main click does the common thing without asking, and the
  alternative is visible rather than remembered. See `PRESENT_MODE_ITEMS` in the
  Present call sites for the copy.
-->
<script lang="ts">
  import { tick } from 'svelte';
  import Icon from './Icon.svelte';
  import {
    firstEnabledIndex,
    menuItemTabIndex,
    nextMenuIndex,
    openIndexForTriggerKey,
  } from '../../shared/menu-nav';

  export interface SplitMenuItem {
    label: string;
    /** A second line, for a choice that is not self-explanatory from its label. */
    description?: string;
    /**
     * Draw a check. This is a menu of MODES rather than of commands, so it owes
     * the operator an answer to "which one am I in?" — without it the menu says
     * what could happen and not what will.
     */
    selected?: boolean;
    disabled?: boolean;
    /**
     * A row that informs rather than acts — the parts-overflow notice. It is
     * never chosen (give it `disabled` too, so the arrows skip it), but unlike a
     * command that happens to be unavailable it is drawn at full contrast in the
     * secondary colour: a greyed-out instruction is one nobody reads.
     */
    note?: boolean;
    /**
     * Starts a new group: a rule above this row and, when given, a small
     * heading naming the group. The Present menu mixes three kinds of row —
     * where to start, how to show it, and the rarer commands — and drawn as
     * one undivided list they read as eight alternatives to the same question.
     */
    group?: { heading?: string };
    onselect: () => void;
  }

  interface Props {
    /** The main button's label. */
    label: string;
    /** Accessible name for the menu half, e.g. "Presentation options". */
    menuLabel: string;
    variant?: 'default' | 'primary';
    disabled?: boolean;
    items: SplitMenuItem[];
    onclick?: () => void;
  }

  let {
    label,
    menuLabel,
    variant = 'default',
    disabled = false,
    items,
    onclick,
  }: Props = $props();

  const uid = $props.id();

  /**
   * The rows in their groups, for the markup only — `items` stays the flat
   * array every index refers to, because `menu-nav.ts` walks it and the DOM
   * order of the rows is unchanged by wrapping them.
   *
   * A headed group is a named `role="group"`: the WAI-ARIA pattern for radio
   * items sharing a menu with unrelated commands, and the only way the heading
   * a sighted operator reads ("Present as") reaches anybody else. A row that
   * cannot be chosen is information rather than a command — the arrows skip it
   * — so its group carries it as a description instead.
   */
  interface MenuGroup {
    heading?: string;
    rows: { item: SplitMenuItem; index: number }[];
  }

  const groups = $derived.by(() => {
    const out: MenuGroup[] = [];
    items.forEach((item, index) => {
      if (item.group || out.length === 0) out.push({ heading: item.group?.heading, rows: [] });
      out[out.length - 1]!.rows.push({ item, index });
    });
    return out;
  });

  function groupDescription(group: MenuGroup): string | undefined {
    const ids = group.rows
      .filter(({ item }) => item.disabled)
      .flatMap(({ item, index }) => [`${uid}-label-${index}`, ...(item.description ? [`${uid}-desc-${index}`] : [])]);
    return ids.length > 0 ? ids.join(' ') : undefined;
  }

  let open = $state(false);
  let activeIndex = $state(-1);
  /**
   * Whether the active item should LOOK chosen — the same split OverflowMenu
   * draws, and for the same reason: the ARIA pattern moves focus into the menu
   * on open, but a menu opened with the mouse has not been told which item the
   * operator wants, and painting one as chosen would arm it invisibly.
   */
  let highlighted = $state(false);
  let root: HTMLElement | null = $state(null);
  let menu: HTMLElement | null = $state(null);

  /**
   * `menuitemradio` for a menu of modes, plain `menuitem` for a menu of
   * commands.
   *
   * `aria-checked` is not a property `menuitem` supports, and the distinction is
   * not pedantry here: a check drawn beside "Present full screen" tells a
   * sighted operator which mode they are defaulted to, and without the radio
   * role there is nothing that tells anybody else. The two members are mutually
   * exclusive and choosing one deselects the other, which is what the role
   * means.
   *
   * Items are only given the radio role when the caller has actually said
   * something about selection, so a future menu of plain actions is unaffected.
   */
  function menuItemRole(item: SplitMenuItem): Record<string, unknown> {
    return item.selected === undefined
      ? { role: 'menuitem' }
      : { role: 'menuitemradio', 'aria-checked': item.selected };
  }

  // Both roles, because one menu may hold both kinds.
  const ITEM_SELECTOR = '[role="menuitem"],[role="menuitemradio"]';

  function itemButtons(): HTMLElement[] {
    return menu ? [...menu.querySelectorAll<HTMLElement>(ITEM_SELECTOR)] : [];
  }

  function focusItem(index: number, highlight = true): void {
    activeIndex = index;
    if (highlight) highlighted = true;
    void tick().then(() => {
      if (open) itemButtons()[index]?.focus();
    });
  }

  function openMenu(index = firstEnabledIndex(items), highlight = true): void {
    open = true;
    focusItem(index, highlight);
  }

  function closeMenu(restoreFocus: boolean): void {
    if (!open) return;
    open = false;
    activeIndex = -1;
    highlighted = false;
    if (restoreFocus) root?.querySelector<HTMLElement>('.caret')?.focus();
  }

  /**
   * `detail` tells a pointer click from a key-synthesised one — see
   * OverflowMenu, which documents why that is the only available discriminator
   * and why getting it wrong leaves a keyboard user inside a menu with nothing
   * drawn to say where they are.
   */
  function toggle(event?: MouseEvent): void {
    if (open) {
      closeMenu(true);
      return;
    }
    openMenu(firstEnabledIndex(items), !event || event.detail === 0);
  }

  function onTriggerKeydown(event: KeyboardEvent): void {
    if (open) return;
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const index = openIndexForTriggerKey(items, event.key);
    if (index === null) return;
    event.preventDefault();
    openMenu(index);
  }

  function onMenuKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
      return;
    }
    if (event.key === 'Tab') {
      closeMenu(false);
      return;
    }
    const index = nextMenuIndex(items, activeIndex, event.key);
    if (index !== null) {
      event.preventDefault();
      focusItem(index);
      return;
    }
    // First-letter navigation, as ContextMenu does it — and for its reasons:
    // one printable character, never Space (it activates the row), never a
    // modified key (that is a command).
    if (event.key.length === 1 && event.key !== ' ' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      typeahead(event.key);
    }
  }

  /** Wraps from the active row, so a second F walks on to the next F. */
  function typeahead(key: string): void {
    const lower = key.toLowerCase();
    const count = items.length;
    for (let step = 1; step <= count; step += 1) {
      const index = (Math.max(activeIndex, 0) + step) % count;
      const item = items[index];
      if (item && !item.disabled && item.label.toLowerCase().startsWith(lower)) {
        focusItem(index);
        return;
      }
    }
  }

  function choose(item: SplitMenuItem): void {
    if (item.disabled) return;
    closeMenu(true);
    item.onselect();
  }

  $effect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (root && !root.contains(event.target as Node)) closeMenu(false);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  });

  // A closed menu must not keep a stale highlight for the next open, and a
  // button that becomes disabled mid-menu (a take starting) must not leave one
  // on screen over a control that no longer does anything.
  $effect(() => {
    if (disabled && open) closeMenu(false);
  });
</script>

<div class="split {variant}" class:open bind:this={root}>
  <button type="button" class="main" data-focus="control" {disabled} onclick={() => onclick?.()}>
    {label}
  </button>
  <span class="divider" aria-hidden="true"></span>
  <button
    type="button"
    class="caret"
    data-focus="control"
    {disabled}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label={menuLabel}
    onclick={toggle}
    onkeydown={onTriggerKeydown}
  >
    <Icon name="chevron-down" size={15} />
  </button>

  {#if open}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div class="menu" role="menu" tabindex="-1" aria-label={menuLabel} bind:this={menu} onkeydown={onMenuKeydown}>
      {#each groups as group, g (group.rows[0]?.index ?? g)}
        {#if g > 0}<div class="separator" role="separator"></div>{/if}
        {#snippet rows()}
          {#each group.rows as { item, index } (item.label)}
            <!--
              Named by the label alone and described by the second line: a
              button's text content would otherwise make its whole explanation
              its name, and first-letter navigation and every announcement would
              run through it.
            -->
            <button
              type="button"
              class="item"
              class:note={item.note}
              class:active={highlighted && index === activeIndex}
              {...menuItemRole(item)}
              aria-labelledby="{uid}-label-{index}"
              aria-describedby={item.description ? `${uid}-desc-${index}` : undefined}
              tabindex={menuItemTabIndex(activeIndex, index)}
              disabled={item.disabled}
              onclick={() => choose(item)}
              onpointerenter={() => {
                if (!item.disabled) focusItem(index);
              }}
            >
              <span class="tick" aria-hidden="true">
                {#if item.selected}<Icon name="check" size={15} />{/if}
              </span>
              <span class="text">
                <span class="item-label" id="{uid}-label-{index}">{item.label}</span>
                {#if item.description}<span class="item-desc" id="{uid}-desc-{index}">{item.description}</span>{/if}
              </span>
            </button>
          {/each}
        {/snippet}
        {#if group.heading}
          <div role="group" aria-labelledby="{uid}-group-{g}" aria-describedby={groupDescription(group)}>
            <!-- Drawn for the eye; reaches assistive tech as the group's name. -->
            <div class="group-label" id="{uid}-group-{g}" aria-hidden="true">{group.heading}</div>
            {@render rows()}
          </div>
        {:else}
          {@render rows()}
        {/if}
      {/each}
    </div>
  {/if}
</div>

<style>
  /*
    ONE bordered box with an internal divider, not two adjacent buttons.

    Two buttons would each carry their own rounded border, which is the
    "border inside a border" the workspace avoids — and butting two rounded
    rectangles together produces exactly the one-sided-border look that is
    banned elsewhere in this app. So the container owns the border and the
    radius, and the two halves are transparent regions inside it.
  */
  .split {
    position: relative;
    display: inline-flex;
    align-items: stretch;
    min-height: var(--button-h);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-control);
    background: var(--bg-elevated);
    transition:
      background var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out),
      opacity var(--dur-fast) var(--ease-out);
  }

  .main,
  .caret {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: transparent;
    color: inherit;
    font: inherit;
    transition:
      background var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out);
  }

  .main {
    padding-inline: 14px;
    font-size: var(--text-sm);
    font-weight: 600;
    letter-spacing: -0.01em;
    white-space: nowrap;
    border-start-start-radius: var(--radius-sm);
    border-end-start-radius: var(--radius-sm);
  }
  .caret {
    padding-inline: var(--space-2);
    border-start-end-radius: var(--radius-sm);
    border-end-end-radius: var(--radius-sm);
  }

  /*
    Inset top and bottom so the rule never reaches the rounded corners — a
    divider that ran the full height would read as a seam between two boxes
    rather than as one control with two halves.
  */
  .divider {
    width: 1px;
    margin-block: 5px;
    background: var(--border-control);
    transition: background var(--dur-fast) var(--ease-out);
  }

  /*
    Only the outlined variant firms its border, and only for a hover over one of
    its own halves. A bare `.split:hover` matched the open MENU too — it is a
    descendant — and outranked `.primary`, so pointing at any row repainted the
    clay button with a grey ring.
  */
  .split:not(.primary):has(> .main:hover:not(:disabled), > .caret:hover:not(:disabled)) {
    border-color: var(--border-strong);
  }
  .main:hover:not(:disabled),
  .caret:hover:not(:disabled) {
    background: var(--bg-hover-surface);
  }
  /* Darkens rather than shrinks (§23.5, §9.3) — see `Button.svelte`. */
  .main:active:not(:disabled),
  .caret:active:not(:disabled) {
    background: var(--bg-secondary);
  }

  /* Primary — the same flat clay fill and 13px label as Button: no lip, no
     shadow, no bigger hero label (see the note at the top of Button.svelte). */
  .primary {
    /* The hero action's height (36px, tokens.css §9.1): Present is the one
       control on the route that is taller than its neighbours, and at 32px it
       sat shorter than the Edit / Preview / Both track beside it. */
    min-height: var(--control-h-lg);
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-contrast);
  }
  .primary .divider {
    /* A wash of the contrast colour, so the rule reads on the clay fill
       without introducing a second hue. */
    background: color-mix(in srgb, var(--accent-contrast) 34%, transparent);
  }
  .primary .main:hover:not(:disabled),
  .primary .caret:hover:not(:disabled),
  .primary.open .caret {
    background: var(--accent-strong);
  }

  .split:has(.main:disabled) {
    box-shadow: none;
  }
  .primary:has(.main:disabled) {
    background: var(--bg-secondary);
    border-color: var(--border);
    color: var(--text-muted);
  }
  .primary:has(.main:disabled) .divider {
    background: var(--border);
  }
  .split:not(.primary):has(.main:disabled) {
    opacity: 0.5;
  }
  .main:disabled,
  .caret:disabled {
    cursor: not-allowed;
  }

  .menu {
    position: absolute;
    top: calc(100% + 6px);
    /*
      Right-aligned and always downwards. Both Present buttons live in a page
      header at the top of a screen, so there is no case where the room is
      below — the flip arithmetic OverflowMenu needs (it opens on rows in a
      scrolling list) would be dead code here.
    */
    right: 0;
    z-index: 40;
    /*
      As wide as its longest line, like a native menu, so a description sits on
      one line instead of wrapping in a fixed column — within a ceiling, past
      which a line wraps rather than the menu reaching across the editor.
    */
    width: max-content;
    min-width: 264px;
    max-width: min(360px, calc(100vw - 2 * var(--space-4)));
    /*
      Bounded by the window. The menu grows with the script — a start row per
      part, "From here", "From last ending" — and at the 680px minimum window a
      long script pushed Practise and Review take setup off the bottom. It
      opens from the toolbar, so the room below is the window less the toolbar
      band and a margin; past that it scrolls, and focusing an item (arrowing,
      or the first one on open) scrolls it into view.
    */
    max-height: calc(100vh - var(--toolbar-h) - var(--space-5));
    overflow-y: auto;
    overscroll-behavior: contain;
    display: flex;
    flex-direction: column;
    padding: var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-pop);
    /* The trigger may be a clay fill; the menu is never one. */
    color: var(--text-primary);
    /*
      A quiet shade at whichever edge has more menu beyond it, and nothing when
      it all fits. Without it a menu clipped by the window ended on a whole row
      with its full bottom padding and read as complete — the shapes, Practise
      and setup were simply not there. The covers scroll with the content and
      the shades stay put, so a shade shows only while there is more to see.
    */
    background:
      linear-gradient(var(--bg-elevated) 30%, transparent) top / 100% 32px,
      linear-gradient(transparent, var(--bg-elevated) 70%) bottom / 100% 32px,
      radial-gradient(farthest-side at 50% 0, var(--menu-shade), transparent) top / 100% 10px,
      radial-gradient(farthest-side at 50% 100%, var(--menu-shade), transparent) bottom / 100% 10px,
      var(--bg-elevated);
    background-repeat: no-repeat;
    background-attachment: local, local, scroll, scroll;
    --menu-shade: color-mix(in srgb, var(--text-primary) 14%, transparent);
  }
  /*
    Nothing in a scrolling column may give up height to fit: a rule is 1px with
    no content, so a bounded menu squeezed it to nothing — on the smallest
    window, exactly where the groups most needed telling apart.
  */
  .menu > :global(*),
  .menu [role='group'] > :global(*) {
    flex: none;
  }

  .item {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    width: 100%;
    text-align: left;
    /*
      With the label's 24px line, a one-line row is 32px — the height
      OverflowMenu's rows are — and a row with a description is still clearly
      one target rather than two lines that happen to touch.
    */
    padding: var(--space-1) var(--space-2);
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-primary);
    transition: background var(--dur-fast) var(--ease-out);
  }
  /* A menu highlights, it does not ring — see OverflowMenu's note. */
  .item:focus,
  .item:focus-visible {
    outline: none;
  }
  /* A solid clay fill with an inverse label and description: the highlight is
     the only focus indicator a menu row has — see OverflowMenu. */
  .item.active:not(:disabled) {
    background: var(--accent-strong);
    color: var(--accent-contrast);
  }
  .item.active:not(:disabled) .tick {
    color: inherit;
  }
  /* Inverse, but a step back from the label so the row keeps its two levels —
     5.1:1 on the clay, still clear of AA. */
  .item.active:not(:disabled) .item-desc {
    color: color-mix(in srgb, var(--accent-contrast) 88%, transparent);
  }
  .item:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  /* Information, not an unavailable command: readable (6.1:1), and no
     forbidden cursor over text that is only there to be read. */
  .item.note:disabled {
    opacity: 1;
    cursor: default;
    color: var(--text-secondary);
  }

  .tick {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    /* Reserved whether or not a check is drawn, so the labels of a checked and
       an unchecked item start at the same x; as tall as the label's line, so
       the check sits on it. */
    width: 15px;
    height: 24px;
    flex: none;
    color: var(--accent-strong);
  }

  .text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .item-label {
    font-size: var(--text-sm);
    font-weight: 500;
    line-height: 24px;
  }
  .item-desc {
    font-size: var(--text-xs);
    color: var(--text-secondary);
    line-height: 1.35;
    /* When a quotation does run long, no single word is left on the last line. */
    text-wrap: pretty;
  }

  /*
    As wide as the row highlight, in the hairline the other menus use: a rule
    narrower than the clay fill beside it read as a second, unrelated inset.
  */
  .separator {
    height: 1px;
    margin: var(--space-1) 0;
    background: var(--border-faint);
  }
  .group-label {
    /* Lines up with the item labels: the item's inset, the tick, the gap. */
    padding: var(--space-1) var(--space-2) var(--space-1) calc(var(--space-2) + 15px + var(--space-2));
    font-size: var(--text-2xs);
    font-weight: 600;
    letter-spacing: var(--ls-caps);
    text-transform: uppercase;
    color: var(--text-muted);
  }
</style>
