<!--
  A draggable boundary between two panes (desktop refinement §21.1).

  ---------------------------------------------------------------------------
  WHY THIS EXISTS AT ALL
  ---------------------------------------------------------------------------
  Every side rail in this application used to be `flex: 0 0 264px` with a media
  query that hid it below some width. That is a LAID-OUT application: the
  designer decided how wide the outline is and the user lives with it. A desktop
  tool is an OPERATED one — you drag the rail to suit the script you are working
  on, and it is still that width tomorrow.

  ---------------------------------------------------------------------------
  ONE PIXEL OF LINE, TEN PIXELS OF GRAB
  ---------------------------------------------------------------------------
  The visible rule is `--divider-w` and the pointer target is `--divider-hit`,
  centred on it with negative margins so widening the grab area does not move
  the panes. A one-pixel target is one nobody hits; a ten-pixel visible line is a
  gutter. They are two different measurements and they get two tokens.

  ---------------------------------------------------------------------------
  KEYBOARD, BECAUSE A SEPARATOR IS A CONTROL
  ---------------------------------------------------------------------------
  `role="separator"` with `aria-valuenow` is the ARIA window-splitter pattern,
  and it comes with an obligation: arrow keys must move it. §23.1 lists splitter
  keyboard resize as a requirement rather than a nicety, and it is the one
  affordance a pointer-only implementation silently removes from anybody who
  cannot drag. Arrows step by 16px, Shift+arrows by 64, Home/End go to the
  extremes, and Enter restores the default — the same thing a double-click does.

  ---------------------------------------------------------------------------
  A CLICK CAN DO WHAT A DRAG DOES
  ---------------------------------------------------------------------------
  The keyboard is not an alternative for somebody who can point and click but
  cannot hold a button down and move — a head pointer, a tremor, a trackpad on
  a bad day. WCAG 2.5.7 asks for a single-pointer route to everything a drag
  does, so a secondary click (or Control-click, the Menu key, Shift+F10) opens a
  menu that widens, narrows and resets the pane. It is also the one place the
  reset is written down, with the key that does it beside it.

  ---------------------------------------------------------------------------
  THE CURSOR SAYS WHICH WAY IT CAN STILL GO
  ---------------------------------------------------------------------------
  At a limit the cursor turns one-directional, as an AppKit split view's does
  (WebKit draws `e-resize`/`w-resize` as NSCursor's resizeRight/resizeLeft). And
  for the length of a drag the whole document wears that cursor and refuses to
  select text: once the divider stops at a limit the pointer carries on over the
  pane beside it, and without this the cursor turned into whatever was under it
  — the preview's pointing hand — so a limit read as the drag having let go.

  ---------------------------------------------------------------------------
  THE DRAG IS NOT THE WRITE
  ---------------------------------------------------------------------------
  `onresize` fires per pointer frame so the layout tracks the cursor; `oncommit`
  fires once when the gesture ends. Writing storage per frame was the specific
  thing §21.1 asks not to do, and on a 120Hz trackpad it is a JSON serialise per
  8ms in the middle of the one gesture the user is judging the app's
  responsiveness by. The workspace store debounces its own writes, so a caller
  that writes through it needs no `oncommit` at all — and none of them pass one,
  which is why every gesture here must apply its value whether or not anybody is
  listening for the end of it.
-->
<script lang="ts">
  import { anchorFor, contextMenu, openContextMenu, type ContextMenuItem } from '../stores/context-menu';
  import { formatAccelerator } from '../lib/commands';
  import { detectPlatform } from '../lib/platform';

  interface Props {
    /** Which way the panes are stacked. A vertical divider resizes width. */
    orientation?: 'vertical' | 'horizontal';
    /** The current size of the pane this divider controls. */
    value: number;
    min: number;
    max: number;
    /** Restored by double-click and Enter. */
    defaultValue: number;
    /**
     * Which side the controlled pane is on.
     *
     * Dragging right must GROW a left-hand pane and SHRINK a right-hand one.
     * Getting this wrong produces a divider that runs away from the cursor,
     * which is the single most common bug in hand-rolled splitters.
     */
    side?: 'leading' | 'trailing';
    label: string;
    /**
     * The visible name of the pane this divider sizes ("Outline"), for its menu:
     * "Make Outline Wider" says which side grows, where a bare "Wider" on a line
     * between two panes does not.
     */
    pane?: string;
    /**
     * What a screen reader hears for a value, given the clamped size. Defaults to
     * "264 pixels wide"; a caller whose size means something else (a split that
     * is really a proportion) says so.
     */
    valuetext?: (value: number) => string;
    /** Live, per pointer frame. */
    onresize: (value: number) => void;
    /** Once, at the end of the gesture. */
    oncommit?: (value: number) => void;
  }

  let {
    orientation = 'vertical',
    value,
    min,
    max,
    defaultValue,
    side = 'leading',
    label,
    pane,
    valuetext,
    onresize,
    oncommit,
  }: Props = $props();

  let dragging = $state(false);
  let element: HTMLElement | null = $state(null);
  /*
   * This divider's menu is the one open. It holds the hover look while it is,
   * so it is plain which edge the menu is about — as a Mac control stays lit
   * while its own menu is down.
   */
  const menuOpen = $derived(element !== null && $contextMenu?.trigger === element);
  /** Where the pointer was, and how big the pane was, when the drag began. */
  let origin = 0;
  let originSize = 0;

  const STEP = 16;
  const COARSE_STEP = 64;

  function clamp(next: number): number {
    return Math.min(max, Math.max(min, next));
  }

  /*
   * The size as the divider understands it, never outside its own range.
   *
   * A caller's range can move under a stored size — the split's limits are
   * derived from the window, and a split saved on a wide window can sit past
   * the maximum of a small one. Announcing "150" for a range of 100 to 100, or
   * starting a drag from there, are both wrong; the first gesture snaps it in.
   */
  const current = $derived(clamp(value));
  const atMin = $derived(current <= min);
  const atMax = $derived(current >= max);

  /*
   * The cursor, pointing only the way the divider can still go.
   *
   * "Grow" is the direction that enlarges the controlled pane: right or down
   * for a leading pane, left or up for a trailing one. At the minimum it can
   * only grow; at the maximum it can only shrink; with no room at all it does
   * not move, and a resize cursor would be a promise it cannot keep.
   */
  const cursor = $derived.by(() => {
    if (min >= max) return 'default';
    const vertical = orientation === 'vertical';
    if (!atMin && !atMax) return vertical ? 'col-resize' : 'row-resize';
    const forward = side === 'leading' ? atMin : atMax;
    if (vertical) return forward ? 'e-resize' : 'w-resize';
    return forward ? 's-resize' : 'n-resize';
  });

  const spoken = $derived(
    valuetext
      ? valuetext(current)
      : `${Math.round(current)} pixels ${orientation === 'vertical' ? 'wide' : 'tall'}`,
  );

  function apply(next: number): number {
    const bounded = clamp(next);
    onresize(bounded);
    return bounded;
  }

  /*
   * A whole gesture: apply it, THEN tell anybody listening for the end of one.
   *
   * Written as `oncommit?.(apply(next))` this was a bug in every caller: an
   * optional call skips evaluating its argument when the callee is missing, and
   * no caller passes `oncommit`, so Enter, the arrows, Home, End and
   * double-click all did nothing at all.
   */
  function commit(next: number): void {
    const bounded = apply(next);
    oncommit?.(bounded);
  }

  /*
   * The whole document wears the drag's cursor while it lasts.
   *
   * Pointer capture routes the events here, but the cursor is still drawn from
   * whatever is under the pointer — the I-beam over the editor, the hand over
   * the preview — and that is where the pointer is the moment the divider stops
   * at a limit. Set on the root rather than on `body`, so nothing outside the
   * app's own element can out-specify it, and taken off however the drag ends,
   * including by this component unmounting in the middle of one.
   */
  $effect(() => {
    if (!dragging) return;
    const root = document.documentElement;
    root.style.setProperty('--pane-resize-cursor', cursor);
    root.setAttribute('data-pane-resizing', '');
    return () => {
      root.removeAttribute('data-pane-resizing');
      root.style.removeProperty('--pane-resize-cursor');
    };
  });

  function pointerdown(event: PointerEvent): void {
    /*
     * Primary button only, and not with Control held. A right-click opens this
     * divider's menu rather than beginning a drag the user cannot see
     * themselves having started, and on a Mac a Control-click IS a right-click:
     * it arrives as button 0 and then as a `contextmenu`.
     */
    if (event.button !== 0 || event.ctrlKey) return;
    event.preventDefault();
    dragging = true;
    origin = orientation === 'vertical' ? event.clientX : event.clientY;
    originSize = current;
    /*
     * Pointer capture, not a window listener.
     *
     * The element keeps receiving moves even when the cursor leaves it — which
     * it will, constantly, because the whole gesture is about moving away from
     * the divider. It also guarantees a `pointerup` on this element, so the
     * commit cannot be lost to a pointer released over the webview's edge.
     */
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function pointermove(event: PointerEvent): void {
    if (!dragging) return;
    const position = orientation === 'vertical' ? event.clientX : event.clientY;
    const delta = position - origin;
    apply(originSize + (side === 'leading' ? delta : -delta));
  }

  /*
   * Ends the drag on release, on cancel, and on capture lost any other way —
   * the window losing focus mid-drag, say, which sends neither of the others.
   */
  function endDrag(event: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    const target = event.currentTarget as HTMLElement;
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
    oncommit?.(current);
  }

  function keydown(event: KeyboardEvent): void {
    /*
     * The two keyboard routes to a context menu. A Mac keyboard has no Menu key,
     * so Shift+F10 is the only one there.
     */
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault();
      const target = event.currentTarget as HTMLElement;
      openMenu(menuAnchor(target), target);
      return;
    }

    const step = event.shiftKey ? COARSE_STEP : STEP;
    // Which arrow grows the pane depends on which side it is, exactly as the
    // drag does. A keyboard user gets the same mental model as a pointer user.
    const grow = side === 'leading' ? 1 : -1;
    let next: number | null = null;

    switch (event.key) {
      case 'ArrowLeft':
        if (orientation === 'vertical') next = current - step * grow;
        break;
      case 'ArrowRight':
        if (orientation === 'vertical') next = current + step * grow;
        break;
      case 'ArrowUp':
        if (orientation === 'horizontal') next = current - step * grow;
        break;
      case 'ArrowDown':
        if (orientation === 'horizontal') next = current + step * grow;
        break;
      case 'Home':
        next = min;
        break;
      case 'End':
        next = max;
        break;
      case 'Enter':
        next = defaultValue;
        break;
      default:
        return;
    }
    if (next === null) return;
    event.preventDefault();
    // Committed immediately: a keypress is a whole gesture, not the middle of
    // one, so there is no pointer release to wait for.
    commit(next);
  }

  function doubleclick(): void {
    commit(defaultValue);
  }

  /*
   * The menu: wider, narrower, and back to the default.
   *
   * Steps are the Shift+arrow step, and each item shows the key that does the
   * same thing while the divider has focus — which it does when the menu
   * closes, so the hint is true the moment it can be used.
   */
  function menuItems(): ContextMenuItem[] {
    const isMac = detectPlatform() === 'macos';
    const vertical = orientation === 'vertical';
    const name = pane ?? 'Pane';
    const growKey = vertical
      ? side === 'leading' ? 'Right' : 'Left'
      : side === 'leading' ? 'Down' : 'Up';
    const shrinkKey = vertical
      ? side === 'leading' ? 'Left' : 'Right'
      : side === 'leading' ? 'Up' : 'Down';
    return [
      {
        label: `Make ${name} ${vertical ? 'Wider' : 'Taller'}`,
        shortcut: formatAccelerator(`Shift+${growKey}`, isMac),
        disabled: atMax,
        onselect: () => commit(current + COARSE_STEP),
      },
      {
        label: `Make ${name} ${vertical ? 'Narrower' : 'Shorter'}`,
        shortcut: formatAccelerator(`Shift+${shrinkKey}`, isMac),
        disabled: atMin,
        onselect: () => commit(current - COARSE_STEP),
      },
      {
        label: `Reset ${name} ${vertical ? 'Width' : 'Height'}`,
        shortcut: formatAccelerator('Return', isMac),
        // Against the size as stored, not as clamped: a split saved on a wide
        // window can sit outside a narrow one's range while the clamped value
        // already equals the default, and that is exactly when Reset is the
        // way back to a layout that fits.
        disabled: Math.round(value) === Math.round(clamp(defaultValue)),
        separated: true,
        onselect: () => commit(defaultValue),
      },
    ];
  }

  function openMenu(at: { x: number; y: number }, trigger: HTMLElement): void {
    openContextMenu({ x: at.x, y: at.y, label, items: menuItems(), trigger });
  }

  /*
   * Where a keyboard-opened menu goes. `anchorFor` puts one under a row's
   * leading edge, and the bottom of a divider is the bottom of the window — so
   * a divider's opens beside the line, a third of the way down, where the eye
   * already is.
   */
  function menuAnchor(target: HTMLElement): { x: number; y: number } {
    const rect = target.getBoundingClientRect();
    if (orientation === 'horizontal') return anchorFor(target);
    return { x: Math.round(rect.right), y: Math.round(rect.top + rect.height / 3) };
  }

  function contextmenu(event: MouseEvent): void {
    event.preventDefault();
    const target = event.currentTarget as HTMLElement;
    // A keyboard-raised `contextmenu` carries no pointer position.
    if (event.clientX === 0 && event.clientY === 0) {
      openMenu(menuAnchor(target), target);
      return;
    }
    /*
     * At the pointer, but clear of the line: opened from the strip's centre the
     * menu's straight edge landed exactly on the rule and merged with it, with
     * the rounded corners peeling off it. The far edge of the hit strip is at
     * most five pixels away.
     */
    const rect = target.getBoundingClientRect();
    const at =
      orientation === 'vertical'
        ? { x: Math.max(event.clientX, Math.round(rect.right)), y: event.clientY }
        : { x: event.clientX, y: Math.max(event.clientY, Math.round(rect.bottom)) };
    openMenu(at, target);
  }
</script>

<!--
  The a11y linter reads `role="separator"` as non-interactive and objects to
  both the tabindex and the listeners. It is wrong here, and specifically so: a
  separator with `aria-valuenow` is the ARIA WINDOW SPLITTER — the one variant of
  the role that is explicitly focusable and explicitly keyboard-operable. Silencing
  the rule rather than dropping the tabindex, because dropping it is what would
  actually break accessibility: §23.1 lists splitter keyboard resize as a
  requirement, and a splitter nobody can focus is a pane only a pointer can move.
-->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="divider {orientation} {side}"
  class:dragging
  class:menu-open={menuOpen}
  bind:this={element}
  role="separator"
  tabindex="0"
  aria-orientation={orientation}
  aria-label={label}
  aria-valuenow={Math.round(current)}
  aria-valuemin={min}
  aria-valuemax={max}
  aria-valuetext={spoken}
  data-focus="surface"
  style:cursor
  onpointerdown={pointerdown}
  onpointermove={pointermove}
  onpointerup={endDrag}
  onpointercancel={endDrag}
  onlostpointercapture={endDrag}
  onkeydown={keydown}
  ondblclick={doubleclick}
  oncontextmenu={contextmenu}
></div>

<style>
  /*
   * The element IS the hit target; the visible rule is drawn by ::before.
   *
   * The alternative — a one-pixel element with a large transparent outline — was
   * tried and is wrong: the outline does not take pointer events, so it looks
   * bigger and grabs the same. This way the box is `--divider-hit` wide, its
   * negative margins pull the surrounding panes back over the extra width, and
   * what shows is the one-pixel line in the middle.
   */
  .divider {
    /* How far the hit box reaches over the leading pane — which is exactly
       where the line starts, since the margin pulls the box back by as much. */
    --lead: calc((var(--divider-hit) - var(--divider-w)) / 2);
    /* The drawn line's thickness in the current state. */
    --line: var(--divider-w);
    position: relative;
    flex: 0 0 auto;
    border: none;
    padding: 0;
    background: transparent;
    align-self: stretch;
    z-index: 2;
  }
  .divider.vertical {
    width: var(--divider-hit);
    margin-inline: calc(-1 * var(--lead));
  }
  .divider.horizontal {
    height: var(--divider-hit);
    margin-block: calc(-1 * var(--lead));
  }

  /*
   * Placed by offset, not centred with a transform.
   *
   * The hit box starts half a pixel into the leading pane (ten pixels of grab
   * around a one-pixel line leaves 4.5 on each side), and `left: 50%` with
   * `translateX(-50%)` landed the line half a pixel off the pane boundary: a
   * lighter seam of app background beside it, and across the toolbar bands the
   * route's chrome painting over half of it — a one-device-pixel line there, and
   * a focus bar with a notch in it. `--lead` from the box's own edge is the pane
   * boundary exactly, the two half pixels cancelling in layout rather than in a
   * rasterised transform.
   */
  .divider::before {
    content: '';
    position: absolute;
    background: var(--divider);
    /* The thickness moves with the colour, so a delayed hover does not jump to
       three pixels of the resting tone first and darken afterwards. */
    transition-property: background, width, left, height, top;
    transition-duration: var(--dur-fast);
    transition-timing-function: var(--ease-out);
  }
  /*
   * A thicker line grows INTO the pane this divider sizes, from the boundary.
   *
   * Centred, the three-pixel states put a pixel into each neighbour — and the
   * sidebar's neighbour across the top of the window is the route's sticky
   * toolbar, which sits above this in the stacking order and painted over that
   * pixel: a focus bar two pixels wide beside the toolbar and three beside the
   * editor. Raising this above the toolbar would put the line over the
   * toolbar's own menus wherever they cross it. Growing one way instead keeps
   * the boundary edge fixed, and the thick line reads as the edge of the pane
   * that is about to move.
   */
  .divider.vertical::before {
    inset-block: 0;
    left: var(--lead);
    width: var(--line);
  }
  .divider.vertical.leading::before {
    left: calc(var(--lead) + var(--divider-w) - var(--line));
  }
  .divider.horizontal::before {
    inset-inline: 0;
    top: var(--lead);
    height: var(--line);
  }
  .divider.horizontal.leading::before {
    top: calc(var(--lead) + var(--divider-w) - var(--line));
  }

  /*
   * Hover and drag firm the LINE rather than fill the target.
   *
   * A ten-pixel band that tints on hover would announce the size of the hit
   * area, which is not information anybody wants — the point of an oversized
   * target is that it is invisible.
   *
   * Hover waits a beat before it shows. The cursor changes at once, which is
   * the platform's own answer to "can I grab this"; the line answers "you are
   * about to", and a pointer only passing over a pane edge on its way somewhere
   * else should not make the edge flash.
   */
  .divider:hover,
  .divider.menu-open {
    --line: 3px;
  }
  .divider:hover::before {
    background: var(--divider-hover);
    transition-delay: 300ms;
  }
  .divider.menu-open::before {
    background: var(--divider-hover);
    transition-delay: 0s;
  }
  /* Three pixels while dragging, so the line is visible under the cursor, and
     the strong border tone the tokens keep for an active drag. Immediate. */
  .divider.dragging {
    --line: 3px;
  }
  .divider.dragging::before {
    background: var(--border-strong);
    transition-delay: 0s;
  }

  /*
   * Keyboard focus is drawn ON THE LINE, not around the box.
   *
   * `data-focus="surface"` in tokens.css would give this the inset quiet edge —
   * a 2px rectangle around a 10px transparent strip, which reads as a floating
   * sliver rather than as "this divider has focus". Overridden here to thicken
   * and colour the rule itself, which is the thing the arrow keys will move.
   */
  .divider:focus-visible {
    outline: none;
    --line: 3px;
  }
  .divider:focus-visible::before {
    background: var(--focus);
    transition-delay: 0s;
  }

  /*
   * When the system asks for more contrast, the resting line is drawn in the
   * quiet focus neutral, which clears 3:1 against every pane it divides (see
   * its note in tokens.css). By default it stays the app's one hairline tone,
   * shared with the toolbar and status-bar rules it meets at both ends.
   */
  @media (prefers-contrast: more) {
    .divider::before {
      background: var(--focus-quiet);
    }
    .divider:hover::before,
    .divider.menu-open::before {
      background: var(--focus-quiet);
    }
    .divider.dragging::before {
      background: var(--text-faint);
    }
    .divider:focus-visible::before {
      background: var(--focus);
    }
  }

  /*
   * Forced colours replace every background with the system canvas, and this
   * line IS a background — so in Windows High Contrast it simply vanished.
   * Opted out of the forcing and drawn in the system's own text and highlight
   * colours instead, which is what forced-colour mode exists to guarantee.
   */
  @media (forced-colors: active) {
    .divider::before {
      forced-color-adjust: none;
      background: CanvasText;
    }
    .divider:hover::before,
    .divider.menu-open::before,
    .divider.dragging::before {
      background: CanvasText;
    }
    .divider:focus-visible::before {
      background: Highlight;
    }
  }

  /*
   * For the length of a drag, the drag's cursor everywhere and no selection.
   * See the script: the attribute and the cursor are set on the root by the
   * divider being dragged, and removed however the drag ends.
   */
  :global(html[data-pane-resizing]),
  :global(html[data-pane-resizing] *) {
    cursor: var(--pane-resize-cursor) !important;
    -webkit-user-select: none !important;
    user-select: none !important;
  }
</style>
