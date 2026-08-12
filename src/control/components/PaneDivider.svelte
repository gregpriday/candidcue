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
  THE DRAG IS NOT THE WRITE
  ---------------------------------------------------------------------------
  `onresize` fires per pointer frame so the layout tracks the cursor; `oncommit`
  fires once when the pointer is released. Callers persist in `oncommit` only.
  Writing storage per frame was the specific thing §21.1 asks not to do, and on
  a 120Hz trackpad it is a JSON serialise per 8ms in the middle of the one
  gesture the user is judging the app's responsiveness by.
-->
<script lang="ts">
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
    /** Live, per pointer frame. */
    onresize: (value: number) => void;
    /** Once, at the end of the gesture. Persist here. */
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
    onresize,
    oncommit,
  }: Props = $props();

  let dragging = $state(false);
  /** Where the pointer was, and how big the pane was, when the drag began. */
  let origin = 0;
  let originSize = 0;

  const STEP = 16;
  const COARSE_STEP = 64;

  function clamp(next: number): number {
    return Math.min(max, Math.max(min, next));
  }

  function apply(next: number): number {
    const bounded = clamp(next);
    onresize(bounded);
    return bounded;
  }

  function pointerdown(event: PointerEvent): void {
    /*
     * Primary button only. A right-click on a divider should open whatever
     * context menu the surrounding pane offers, not begin a drag the user
     * cannot see themselves having started.
     */
    if (event.button !== 0) return;
    event.preventDefault();
    dragging = true;
    origin = orientation === 'vertical' ? event.clientX : event.clientY;
    originSize = value;
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

  function pointerup(event: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    oncommit?.(value);
  }

  function keydown(event: KeyboardEvent): void {
    const step = event.shiftKey ? COARSE_STEP : STEP;
    // Which arrow grows the pane depends on which side it is, exactly as the
    // drag does. A keyboard user gets the same mental model as a pointer user.
    const grow = side === 'leading' ? 1 : -1;
    let next: number | null = null;

    switch (event.key) {
      case 'ArrowLeft':
        if (orientation === 'vertical') next = value - step * grow;
        break;
      case 'ArrowRight':
        if (orientation === 'vertical') next = value + step * grow;
        break;
      case 'ArrowUp':
        if (orientation === 'horizontal') next = value - step * grow;
        break;
      case 'ArrowDown':
        if (orientation === 'horizontal') next = value + step * grow;
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
    oncommit?.(apply(next));
  }

  function doubleclick(): void {
    oncommit?.(apply(defaultValue));
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
  class="divider {orientation}"
  class:dragging
  role="separator"
  tabindex="0"
  aria-orientation={orientation}
  aria-label={label}
  aria-valuenow={Math.round(value)}
  aria-valuemin={min}
  aria-valuemax={max}
  data-focus="surface"
  onpointerdown={pointerdown}
  onpointermove={pointermove}
  onpointerup={pointerup}
  onpointercancel={pointerup}
  onkeydown={keydown}
  ondblclick={doubleclick}
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
    margin-inline: calc(-1 * (var(--divider-hit) - var(--divider-w)) / 2);
    cursor: col-resize;
  }
  .divider.horizontal {
    height: var(--divider-hit);
    margin-block: calc(-1 * (var(--divider-hit) - var(--divider-w)) / 2);
    cursor: row-resize;
  }

  .divider::before {
    content: '';
    position: absolute;
    background: var(--divider);
    transition: background var(--dur-fast) var(--ease-out);
  }
  .divider.vertical::before {
    inset-block: 0;
    left: 50%;
    width: var(--divider-w);
    transform: translateX(-50%);
  }
  .divider.horizontal::before {
    inset-inline: 0;
    top: 50%;
    height: var(--divider-w);
    transform: translateY(-50%);
  }

  /*
   * Hover and drag firm the LINE rather than fill the target.
   *
   * A ten-pixel band that tints on hover would announce the size of the hit
   * area, which is not information anybody wants — the point of an oversized
   * target is that it is invisible.
   */
  .divider:hover::before,
  .divider.dragging::before {
    background: var(--divider-hover);
  }
  /* Three pixels while dragging, so the line is visible under the cursor. */
  .divider.dragging.vertical::before {
    width: 3px;
  }
  .divider.dragging.horizontal::before {
    height: 3px;
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
  }
  .divider:focus-visible::before {
    background: var(--focus);
  }
  .divider.vertical:focus-visible::before {
    width: 3px;
  }
  .divider.horizontal:focus-visible::before {
    height: 3px;
  }
</style>
