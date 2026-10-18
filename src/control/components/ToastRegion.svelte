<!--
  Floating toast notices, docked in the bottom trailing corner. Announced via
  live regions (spec §20) — streaming transcript text never routes through here.

  PLACEMENT. The stack sits in the bottom-right corner, above the status band,
  the way a desktop tool with a status bar places its notices. It used to float
  bottom-centre, which put every notice over the middle of the editor's last
  lines — the place the caret usually is — and, at the narrowest window, over
  nearly the whole writing column. The corner still covers something (the foot
  of the outline rail, the ends of a few lines), but never the middle of the
  line being written, and on the prompter never the middle of the lines about
  to be read.

  BOTTOM INSET. The region floats over whatever is beneath it, and each toast
  is `pointer-events: auto` because it owns a dismiss button. Anchored a flat
  24px from the viewport bottom, that put every toast squarely on top of the
  Live screen's always-visible transport bar and ate its clicks — and `danger`
  toasts never auto-dismiss (deliberately: a failure must not scroll past
  unseen), so the manual transport was unreachable in exactly the situations
  that produce a danger toast. Rather than shortening the timeout or making the
  toast non-interactive, the region reads `--toast-safe-bottom`: a route that
  owns a fixed bottom bar publishes that bar's height plus the normal inset,
  and the toasts stack above it. Everywhere else the floor is the status band
  plus a gap, so a toast never sits on the band's top edge.

  ONE TRAY. Open notices share one floating surface, divided by hairlines,
  rather than each casting its own shadow. Separate cards filled every gap
  between them with the card above's shadow, and showed slivers of the script
  through the gaps, cut through the middle of the letters.

  DURING A TAKE. The window is the prompter then, read from a metre or more
  away, so the notice is set larger, only the newest one is open, and it lines
  up with the stage's own dock in the opposite corner. The document root's
  `data-theme` is how this region knows: App.svelte sets it to `studio` for
  exactly the length of a running take, and this region is mounted outside
  the routes that know more.
-->
<script lang="ts">
  import { tick } from 'svelte';
  import {
    toasts,
    dismissToast,
    holdToasts,
    splitLead,
    type Toast,
    type ToastTone,
  } from '../stores/toasts';
  import Icon from './Icon.svelte';
  import type { IconName } from './icon-names';

  /* Severity is a shape as well as a colour (WCAG 1.4.1): a failure reads as a
     failure before a word of it is read, in either theme, and to somebody who
     cannot tell the reds from the clays. */
  const GLYPH: Record<ToastTone, IconName> = {
    danger: 'alert',
    success: 'check',
    info: 'info',
  };

  let region = $state<HTMLElement>();

  let presenting = $state(false);
  $effect(() => {
    const root = document.documentElement;
    const read = () => {
      presenting = root.dataset['theme'] === 'studio';
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  });

  /* The card under the pointer and the card holding focus: neither may be
     folded away by an arrival while somebody is reading or operating it. */
  let hoveredId = $state<number | null>(null);
  let focusedId = $state<number | null>(null);

  /*
   * Which notices are open. The rest are folded behind one control that says
   * how many there are, because a wall of notices covers the document it is
   * reporting on. During a take only one is open: a second on a 600px prompter
   * is another two lines of script gone.
   *
   * Failures take the open places first, newest first, and then everything
   * else, newest first. A failure stays until it is dismissed; folding it
   * behind a count because a receipt arrived after it is how it goes unseen.
   */
  const limit = $derived(presenting ? 1 : 3);
  let expanded = $state(false);
  const shown = $derived.by(() => {
    if (expanded) return new Set($toasts.map((t) => t.id));
    const open = new Set<number>();
    for (const id of [focusedId, hoveredId]) {
      if (id !== null && $toasts.some((t) => t.id === id)) open.add(id);
    }
    const newestFirst = [...$toasts].reverse();
    const ranked = [
      ...newestFirst.filter((t) => t.tone === 'danger'),
      ...newestFirst.filter((t) => t.tone !== 'danger'),
    ];
    for (const toast of ranked) {
      if (open.size >= limit) break;
      open.add(toast.id);
    }
    return open;
  });
  const folded = $derived($toasts.filter((t) => !shown.has(t.id)));
  const foldedFailures = $derived(folded.filter((t) => t.tone === 'danger').length);
  $effect(() => {
    if ($toasts.length <= limit) expanded = false;
  });

  function foldLabel(count: number, failed: number): string {
    if (failed === count) return `${count} more ${count === 1 ? 'failure' : 'failures'}`;
    const notices = `${count} more ${count === 1 ? 'notice' : 'notices'}`;
    return failed === 0 ? notices : `${notices}, ${failed} ${failed === 1 ? 'failure' : 'failures'}`;
  }

  /* Failures are announced assertively and stay until dismissed; everything
     else is polite and self-clearing (spec §20). Folded notices stay in their
     live region, only out of sight, so a failure that arrives folded is still
     announced the moment it arrives, and opening the fold announces nothing
     old as new. */
  const failures = $derived($toasts.filter((t) => t.tone === 'danger'));
  const notices = $derived($toasts.filter((t) => t.tone !== 'danger'));
  const openCount = $derived($toasts.length - folded.length);
  /** Open notices top to bottom, as the tray draws them. */
  const openOrder = $derived([...notices, ...failures].filter((t) => shown.has(t.id)).map((t) => t.id));

  /*
   * A notice arriving while the pile is opened out could land below the
   * tray's scrollport with nothing to say so. Nobody on the stack: fold back,
   * which puts the arrival open (failures first). Somebody reading or
   * operating it: keep their place and their view, and bring the arrival into
   * sight only if it is a failure.
   */
  let tray = $state<HTMLElement>();
  let lastSeenId = 0;
  $effect(() => {
    // Everything newer than last time: several can land in one update.
    const arrivals = $toasts.filter((t) => t.id > lastSeenId);
    if (arrivals.length === 0) return;
    lastSeenId = Math.max(...arrivals.map((t) => t.id));
    if (!expanded) return;
    if (!hovered && !focused) {
      expanded = false;
      return;
    }
    const failure = arrivals.filter((t) => t.tone === 'danger').at(-1);
    if (!failure) return;
    void tick().then(() => reveal(failure.id));
  });

  /**
   * Scroll a notice fully into the part of the tray that nothing covers: the
   * "more below" control sits over the foot of the scrollport, so its height
   * is kept clear, whether or not it is showing yet.
   */
  function reveal(id: number): void {
    const row = tray?.querySelector<HTMLElement>(`[data-toast-id="${id}"]`);
    if (!tray || !row) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    const visibleBottom = tray.scrollTop + tray.clientHeight - belowHeight();
    if (bottom > visibleBottom) tray.scrollTop += bottom - visibleBottom;
    else if (top < tray.scrollTop) tray.scrollTop = top;
    measureBelow();
  }

  /*
   * Opened out and taller than the tray, the pile scrolls — and with the
   * overlay scrollbar hidden at rest it looked complete. A count of what is
   * below the fold says otherwise, and scrolls to it.
   */
  let below = $state(0);
  /** Until it has been drawn once, the control's height is this estimate. */
  let belowEstimatePx = 30;

  function belowHeight(): number {
    const control = tray?.querySelector<HTMLElement>('.below');
    if (control) belowEstimatePx = control.offsetHeight;
    return belowEstimatePx;
  }

  /*
   * Every row not wholly above the control counts, a half-hidden one included:
   * "2 more below" over a clipped row and two more beneath it undersold the
   * pile by one. The control's own height is measured, and the count is taken
   * again once the control exists, since its arrival moves the edge.
   */
  function measureBelow(): void {
    if (!tray || !expanded || tray.scrollHeight <= tray.clientHeight + 1) {
      below = 0;
      return;
    }
    const edge = tray.scrollTop + tray.clientHeight - belowHeight();
    const count = [...tray.querySelectorAll<HTMLElement>('.toast:not(.folded)')].filter(
      (row) => row.offsetTop + row.offsetHeight > edge + 1,
    ).length;
    const appeared = below === 0 && count > 0;
    below = count;
    if (appeared) void tick().then(measureBelow);
  }
  $effect(() => {
    void $toasts;
    void expanded;
    void tick().then(measureBelow);
  });
  $effect(() => {
    if (!tray) return;
    const observer = new ResizeObserver(measureBelow);
    observer.observe(tray);
    for (const stack of tray.querySelectorAll('.stack')) observer.observe(stack);
    return () => observer.disconnect();
  });

  function showBelow(): void {
    if (!tray) return;
    tray.scrollBy({ top: tray.clientHeight - belowHeight() * 2 });
  }

  function toastIdOf(target: EventTarget | null): number | null {
    const card = target instanceof Element ? target.closest<HTMLElement>('[data-toast-id]') : null;
    return card ? Number(card.dataset['toastId']) : null;
  }

  /*
   * Countdowns stop while somebody is on the stack (WCAG 2.2.1): the pointer
   * over it, or keyboard focus inside it. `pointerout` does not fire for a
   * card removed from under the pointer, so once hovered the document's next
   * pointer move decides whether it still is.
   */
  const hovered = $derived(hoveredId !== null);
  const focused = $derived(focusedId !== null);
  $effect(() => {
    holdToasts(hovered || focused);
  });
  $effect(() => () => holdToasts(false));

  function onpointerover(event: PointerEvent): void {
    hoveredId = toastIdOf(event.target) ?? hoveredId ?? -1;
  }

  $effect(() => {
    if (!hovered) return;
    const check = (event: PointerEvent) => {
      if (event.target instanceof Node && region?.contains(event.target)) {
        hoveredId = toastIdOf(event.target) ?? -1;
      } else {
        hoveredId = null;
      }
    };
    const leave = () => {
      hoveredId = null;
    };
    document.addEventListener('pointermove', check);
    document.documentElement.addEventListener('pointerleave', leave);
    window.addEventListener('blur', leave);
    return () => {
      document.removeEventListener('pointermove', check);
      document.documentElement.removeEventListener('pointerleave', leave);
      window.removeEventListener('blur', leave);
    };
  });

  /**
   * Where keyboard focus came from before it entered the stack, so the last
   * notice leaving can hand it back instead of dropping it on the page.
   */
  let returnTo: HTMLElement | null = null;
  /** The position, among open notices, of the one that last held focus. */
  let focusIndex = 0;

  function openDismissButtons(): HTMLElement[] {
    return [...(region?.querySelectorAll<HTMLElement>('.toast:not(.folded) .dismiss') ?? [])];
  }

  function onfocusin(event: FocusEvent): void {
    const from = event.relatedTarget;
    if (from instanceof HTMLElement && !region?.contains(from)) returnTo = from;
    focusedId = toastIdOf(event.target) ?? -1;
  }

  /*
   * Follow the focused notice's position as arrivals move it, and keep the
   * last one it had once it is gone — that is the place its successor takes.
   */
  $effect(() => {
    const at = focusedId === null ? -1 : openOrder.indexOf(focusedId);
    if (at >= 0) focusIndex = at;
  });

  function onfocusout(event: FocusEvent): void {
    const to = event.relatedTarget;
    if (!(to instanceof Node) || !region?.contains(to)) focusedId = null;
  }

  /**
   * Put focus somewhere sensible after the notice holding it has gone: the
   * notice that took its place (or the one above, if it was last), else back
   * where focus came from before it entered the stack.
   */
  function recoverFocus(): void {
    const buttons = openDismissButtons();
    const next = buttons[Math.min(focusIndex, buttons.length - 1)];
    if (next) next.focus();
    else {
      focusedId = null;
      if (returnTo?.isConnected) returnTo.focus();
    }
  }

  /*
   * A focused notice can also leave without its dismiss button being pressed —
   * its condition ended. Removing a focused element fires no focusout, so
   * after any change the region checks whether it still has the focus it
   * thinks it has.
   */
  $effect(() => {
    void $toasts;
    void tick().then(() => {
      if (!focused || region?.contains(document.activeElement)) return;
      if (document.activeElement === document.body || document.activeElement === null) recoverFocus();
      else focusedId = null;
    });
  });

  /**
   * Dismiss from the keyboard or pointer. Focus moves on only when the dismiss
   * button itself had it — a click with the pointer leaves focus where the
   * author was working.
   */
  async function dismiss(toast: Toast, button: HTMLElement): Promise<void> {
    const hadFocus = document.activeElement === button;
    if (hadFocus) focusIndex = Math.max(0, openDismissButtons().indexOf(button));
    dismissToast(toast.id);
    if (!hadFocus) return;
    await tick();
    recoverFocus();
  }
</script>

<!--
  The first sentence leads and the rest is detail: set as one run of text, the
  reader had to find the verdict inside the paragraph.
-->
{#snippet card(toast: Toast)}
  {@const text = splitLead(toast.message)}
  {@const open = shown.has(toast.id)}
  <div class="toast {toast.tone}" class:folded={!open} data-toast-id={toast.id}>
    <span class="glyph" aria-hidden="true"><Icon name={GLYPH[toast.tone]} size={presenting ? 20 : 16} /></span>
    <div class="body">
      <p class="message" id="toast-{toast.id}-message">
        <span class="lead">{text.lead}</span>
        {#if text.rest}<span class="rest">{text.rest}</span>{/if}
      </p>
      {#if toast.count}
        <p class="count">{toast.count} times</p>
      {/if}
      {#if toast.action}
        {@const action = toast.action}
        <button
          type="button"
          class="action"
          data-focus="control"
          tabindex={open ? undefined : -1}
          onclick={() => action.run()}
        >
          {action.label}
        </button>
      {/if}
    </div>
    <button
      type="button"
      class="dismiss"
      data-focus="control"
      aria-label="Dismiss notification"
      aria-describedby="toast-{toast.id}-message"
      tabindex={open ? undefined : -1}
      onclick={(event) => void dismiss(toast, event.currentTarget)}
    >
      <Icon name="x" size={presenting ? 18 : 14} />
    </button>
  </div>
{/snippet}

<!--
  `data-stage-chrome`: during a take the stage answers Space for pause, and it
  stands back only for keys landing on its own chrome. A toast floats over the
  take with buttons in it — the dismiss, and an action like "Open System
  Settings" (#303) — and Space on one of those must press it, not pause.

  `aria-atomic="false"` on both live regions: `status` and `alert` are atomic
  by default, which would read every notice still standing each time a new
  one arrived.
-->
<div class="region" class:presenting data-stage-chrome bind:this={region} {onpointerover} {onfocusin} {onfocusout}>
  {#if folded.length > 0 || expanded}
    <button
      type="button"
      class="fold"
      data-focus="control"
      aria-expanded={expanded}
      onclick={() => (expanded = !expanded)}
    >
      {#if !expanded && foldedFailures > 0}
        <span class="fold-glyph" aria-hidden="true"><Icon name="alert" size={presenting ? 16 : 13} /></span>
      {/if}
      {expanded ? 'Show fewer' : foldLabel(folded.length, foldedFailures)}
    </button>
  {/if}
  <div class="tray" class:empty={openCount === 0} bind:this={tray} onscroll={measureBelow}>
    <div class="stack" role="status" aria-live="polite" aria-atomic="false">
      {#each notices as toast (toast.id)}
        {@render card(toast)}
      {/each}
    </div>
    <div class="stack" role="alert" aria-atomic="false">
      {#each failures as toast (toast.id)}
        {@render card(toast)}
      {/each}
    </div>
    {#if below > 0}
      <button type="button" class="below" data-focus="control" onclick={showBelow}>
        {below} more below
      </button>
    {/if}
  </div>
</div>

<style>
  .region {
    /* Above the status band with a gap, or above whatever a route publishes
       (Live's transport), whichever is higher. */
    --toast-bottom: max(var(--toast-safe-bottom, 0px), calc(var(--statusbar-h) + var(--space-3)));
    position: fixed;
    right: var(--page-x);
    bottom: var(--toast-bottom);
    /* As wide as its longest notice needs, within limits: a one-line receipt
       does not take a paragraph's width of the document with it. */
    min-width: min(288px, calc(100vw - 2 * var(--page-x)));
    max-width: min(400px, calc(100vw - 2 * var(--page-x)));
    z-index: 120;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    pointer-events: none;
  }
  /* On the glass there is no status band; the tray lines up with the stage's
     dock in the opposite corner instead. */
  /* Live's published figure carries the workspace's 24px gap above its
     transport (0px tall during a take); on the glass the gap is the dock's. */
  .region.presenting {
    --toast-bottom: max(
      calc(var(--toast-safe-bottom, 0px) - var(--space-6) + var(--stage-chrome-bottom-inset, 16px)),
      var(--stage-chrome-bottom-inset, 16px)
    );
    right: var(--stage-chrome-inset, 20px);
    min-width: min(320px, calc(100vw - 2 * var(--stage-chrome-inset, 20px)));
    max-width: min(480px, calc(100vw - 2 * var(--stage-chrome-inset, 20px)));
  }

  .tray {
    /* Opened out, a long pile scrolls inside the tray rather than climbing
       over the toolbar bands with its fold control above it. */
    max-height: calc(
      100vh - var(--toast-bottom) - var(--toolbar-h) - var(--toolbar-h-secondary) - var(--space-10) -
        var(--space-9)
    );
    position: relative;
    overflow-y: auto;
    overscroll-behavior: contain;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-pop);
    pointer-events: auto;
  }
  /* No open notices: the live regions stay in the tree, the surface goes. */
  .tray.empty {
    border: none;
    background: none;
    box-shadow: none;
    pointer-events: none;
  }

  .toast {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    column-gap: var(--space-3);
    align-items: start;
    padding: var(--space-3) var(--space-2) var(--space-3) var(--space-4);
    /* A hairline between neighbours; the first one's falls outside the tray's
       scrollport and is clipped away. */
    box-shadow: 0 -1px 0 var(--border);
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    color: var(--text-primary);
    animation: toast-in var(--dur-med) var(--ease-out);
  }

  /* A failure also carries a rule down its leading edge, inset clear of the
     tray's corners, so a failure among receipts is found before its glyph is. */
  .toast.danger {
    position: relative;
  }
  .toast.danger::before {
    content: '';
    position: absolute;
    left: var(--space-1);
    top: var(--space-2);
    bottom: var(--space-2);
    width: 3px;
    border-radius: 2px;
    background: var(--danger);
  }

  /* Folded: out of sight and out of the tab order, still in its live region. */
  .toast.folded {
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

  @keyframes toast-in {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  /* Centred on the first line of text, however many lines follow. */
  .glyph {
    display: inline-flex;
    margin-top: 1px;
  }
  .danger .glyph {
    color: var(--danger);
  }
  .success .glyph {
    color: var(--success);
  }
  .info .glyph {
    color: var(--text-secondary);
  }

  .body {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-1);
    min-width: 0;
  }

  .message {
    margin: 0;
    overflow-wrap: anywhere;
    text-wrap: pretty;
  }
  .lead {
    font-weight: 600;
  }

  .count {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  /* Text, not a second button shape: the toast is already a surface, and a
     filled button inside it would outweigh the message it acts on. It sits on
     its own line under the message, its text aligned with the message's, so a
     long label never squeezes the words it acts on into a column. */
  .action {
    margin: var(--space-1) 0 0 calc(-1 * var(--space-2));
    padding: var(--space-1) var(--space-2);
    border: none;
    background: transparent;
    font: inherit;
    font-weight: 600;
    color: var(--accent-strong);
    border-radius: var(--radius-sm);
    white-space: nowrap;
    transition: background var(--dur-fast) var(--ease-out);
  }
  .action:hover {
    background: var(--bg-hover-surface);
  }

  /* Its centre on the first line, like the glyph's. */
  .dismiss {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    /* Overhangs the line equally above and below, so a one-line notice is as
       tall as its text, not as its button. */
    margin: -5px 0;
    border: none;
    background: transparent;
    color: var(--text-muted);
    border-radius: var(--radius-sm);
    transition:
      background var(--dur-fast) var(--ease-out),
      color var(--dur-fast) var(--ease-out);
  }
  .dismiss:hover {
    color: var(--text-primary);
    background: var(--bg-hover-surface);
  }

  /* What is below the tray's scrollport: pinned to its bottom edge, so it
     stays in sight however far the pile is scrolled. */
  .below {
    position: sticky;
    bottom: 0;
    display: block;
    width: 100%;
    padding: var(--space-1) var(--space-4);
    border: none;
    box-shadow: 0 -1px 0 var(--border);
    background: var(--bg-panel);
    font: inherit;
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--text-secondary);
    text-align: center;
    transition: background var(--dur-fast) var(--ease-out);
  }
  .below:hover {
    background: var(--bg-hover-surface);
  }

  /* The folded notices: a flat control at the far end of the stack from the
     edge, naming any failure it holds. */
  .fold {
    align-self: flex-end;
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    margin-bottom: var(--space-2);
    padding: var(--space-1) var(--space-3);
    border: 1px solid var(--border-control);
    border-radius: var(--radius-pill);
    background: var(--bg-panel);
    font: inherit;
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--text-secondary);
    pointer-events: auto;
    transition: background var(--dur-fast) var(--ease-out);
  }
  .fold:hover {
    background: var(--bg-hover-surface);
  }
  .fold-glyph {
    display: inline-flex;
    color: var(--danger);
  }

  /* On the glass: read from a metre away, pressed at arm's length. */
  .presenting .toast {
    column-gap: var(--space-4);
    padding: var(--space-4) var(--space-3) var(--space-4) var(--space-5);
    font-size: var(--text-lg);
    line-height: 1.4;
  }
  .presenting .glyph {
    margin-top: 2px;
  }
  .presenting .dismiss {
    width: 40px;
    height: 40px;
    margin: -8px 0;
  }
  .presenting .action {
    padding: var(--space-2) var(--space-2);
  }
  .presenting .count,
  .presenting .fold,
  .presenting .below {
    font-size: var(--text-sm);
  }
</style>
