<!--
  The session dock — one quiet control location, bottom left.

  ---------------------------------------------------------------------------
  THE DESKTOP REFINEMENT'S §13.2 AUDIT: NOTHING CHANGED HERE, ON PURPOSE
  ---------------------------------------------------------------------------
  The desktop-structure pass reduced radii, control heights and shadow use
  across the whole control window. It stopped at this file, and the reason is
  written into the review itself: §29.6 says to change stage appearance only
  where real-device testing demonstrates a problem, and §31.5 lists weakening
  the stage architecture among the changes that would make the product worse.

  What the audit found, and why each item stands:

    40px buttons        §13.2 asks whether they remain usable viewed directly
                        at the rig. They are sized for exactly that — see the
                        note below on the 48px pointer target claimed by a
                        pseudo-element — and shrinking them to match the
                        workspace's new 32px would be applying a density rule
                        to the one surface §31.3 exempts from it.

    12px radius         §13.2 offers a flatter dock "if the current control
                        group looks too pill-like". At 12px on a 40px square
                        this is a squircle rather than a capsule, and deciding
                        it looks wrong needs eyes on a real panel at a real
                        viewing distance. Nobody has had those since the
                        question was asked.

    the chrome shadow   §9.3 keeps shadows for genuinely floating things. This
                        dock floats over moving text on glass, which is the
                        clearest case for one in the product.

  So the honest state is: audited, unchanged, and waiting on the one kind of
  evidence that could justify changing it. The control window's tokens no
  longer reach in here — `--stage-chrome-*` are the stage's own — so a future
  density pass cannot alter this surface by accident.

  ---------------------------------------------------------------------------
  WHY IT IS ONE THING AND WHY IT IS UNMIRRORED
  ---------------------------------------------------------------------------
  The stage used to distribute its furniture between five independent anchors:
  a hold chip top left, a menu top right, an audio pill bottom right, a
  transcript bar under it, and an exit affordance in a third corner. Each was
  individually defensible. Together they made a screen with five things
  competing for the corner of the eye of somebody trying to read the middle.

  Everything that takes a POINTER now lives here, and this dock is operator
  chrome: it is drawn in the unmirrored plane, at the physical bottom left,
  whatever the mirror settings are. That last part is the whole reason it could
  not simply be folded into the existing pill. The pill is presenter-facing and
  rides the corrective flip; a button that rode the same flip would jump to the
  opposite side of the screen the moment somebody turned mirroring on, and a
  slider inside it would move the wrong way under the hand dragging it.

  Nothing presenter-facing was lost by moving the audio readout out of the
  mirror plane. The one part of it a presenter has to READ is the fault name,
  and `resolveHoldStatus` already puts a named fault at the top of the hold
  ladder — so "No audio" reaches the glass through the mirrored hold chip, in
  presenter-sized type, whether or not anybody is looking at this corner.

  ---------------------------------------------------------------------------
  THE AUDIO DISPLAY STAYS; THE BUTTONS GO AWAY
  ---------------------------------------------------------------------------
  They are different kinds of thing. "Is my voice getting through" is a question
  asked continuously and answered continuously, so the trace runs for the whole
  take. "Adjust the prompter" and "end the session" are things somebody reaches
  for with a mouse, and a take is exactly when nobody is touching the mouse.

  So the buttons fade out and the audio display does not — and the audio display
  is FIRST in the row, hard against the corner, with every fading control after
  it. Nothing that disappears is allowed to sit between the readout and the edge
  of the screen.

  It used to be third, behind three buttons that kept their space while
  invisible. That was stable — the readout never moved — but at rest it left the
  one permanently visible instrument floating a hundred and fifty pixels in from
  the corner with nothing around it, which reads as misplaced rather than as
  parked, and reads worst in a small presentation window where that gap is a
  large fraction of the width. Putting it first costs nothing: the buttons still
  hold their space so they do not shuffle among themselves, and now the thing
  that never hides is the thing in the corner.

  ---------------------------------------------------------------------------
  THREE SLOTS, NOT FIVE: ONE MENU AND ONE WAY OUT
  ---------------------------------------------------------------------------
  Every verb the dock offers used to have a button of its own, so the row grew
  by forty pixels every time one was added and ran to roughly two hundred and
  sixty. On a windowed take that is a bar across the bottom of the script — the
  thing this dock is drawn small and quiet to avoid being.

  So the verbs collapsed into one trigger and a menu behind it, and the row is
  now the readout, the menu, and the way out. Ending the take keeps a control of
  its own because it is the one thing somebody may need to find in a hurry and
  the one thing they must never hit by accident; putting it behind the same
  trigger as "adjust the text size" would have made both worse.

  A GEAR, not a hamburger and not an ellipsis. Three horizontal lines mean
  global navigation — a drawer of places to go — and this menu goes nowhere. An
  ellipsis means "the rest of the actions", which reads as leftovers. What is
  actually behind here is how the prompter behaves, and every fullscreen player
  a presenter has ever used (YouTube, Vimeo, VLC) puts exactly that behind a
  cog. The menu also mixes settings with live mode switches, which is what those
  players' cogs contain too.

  ---------------------------------------------------------------------------
  A MODE THAT IS OFF MAY NOT HIDE INSIDE THE MENU
  ---------------------------------------------------------------------------
  Voice following used to be a button that stayed lit while it was off, for the
  reason set out at that button's old markup: a presenter staring at a script
  that will not move must not have to go looking for the reason. Folding it into
  a menu would put that answer one click behind a cog — recall instead of
  recognition, and the failure it prevents is the whole take.

  So the state came out with the button: while following is off the TRIGGER
  carries it — amber, with a mark on its shoulder — and the trigger stops
  fading. It is drawn twice on purpose, because a hue shift and a shape fail in
  different conditions and this dock is judged through a beamsplitter. The
  mirrored hold chip still says it in words in presenter-sized type
  (`resolveHoldStatus`); this is the half somebody can click.
-->
<script lang="ts">
  import { tick, type Snippet } from 'svelte';
  import type { PresentationMode, StageVoicePillPayload } from '../shared/contracts';
  import {
    firstEnabledIndex,
    menuItemTabIndex,
    nextMenuIndex,
    openIndexForTriggerKey,
  } from '../shared/menu-nav';
  import VoicePill from './VoicePill.svelte';

  interface Props {
    /** The audio reading, or null before control has said anything about it. */
    pill: StageVoicePillPayload | null;
    /**
     * The pointer has been moved, or something wants the controls up.
     *
     * Only the two BUTTONS obey it. See the note above.
     */
    revealed: boolean;
    /**
     * The appearance panel — the menu's second level.
     *
     * A snippet rather than a component, because the stage does not own stage
     * settings and must not start pretending to: the standalone stage window
     * receives a resolved envelope and has nothing to adjust, so it passes
     * nothing and the menu row is simply not there. Single-window presentation
     * hands in the host's own sheet, which keeps the transaction — live
     * preview, Done saves, Cancel restores — where the state it is transacting
     * on actually lives.
     */
    appearancePanel?: Snippet | null;
    /** Whether that panel is open. Owned by the host, for the same reason. */
    appearanceOpen?: boolean;
    onappearanceopen?: () => void;
    /** Escape, a click outside, or the trigger again. Means "cancel". */
    onappearanceclose?: () => void;
    /**
     * Whether the take is filling its display or sitting in a window.
     *
     * Given rather than inferred: the stage renders inside whatever window it is
     * handed and has no way to tell a borderless monitor-sized one from a
     * maximised ordinary one. Only the host knows, because only the host asked
     * for it.
     */
    presentationMode?: PresentationMode;
    /**
     * The presentation-mode control was activated. Absent means "do not offer
     * it" — see the note at the button.
     */
    onpresentationtoggle?: () => void;
    /** §48. Voice following is off; the presenter is driving the script. */
    followPaused?: boolean;
    /** The follow control was activated. The host owns the decision (§16.9). */
    onfollowtoggle?: () => void;
    /** End the take. Called only after the anchored confirmation. */
    onend: () => void;
    /**
     * The dock is holding itself up: the pointer is over it, something in it
     * has the keyboard, or a popup is open. The caller suspends its idle timer
     * — chrome that fades while you are reaching for it is worse than chrome
     * that never hides.
     */
    onhold?: (held: boolean) => void;
    /**
     * A pane of glass is up over the dock.
     *
     * The caller uses it to get anything else out from behind the popup — the
     * diagnostic transcript sits directly above this dock and would otherwise
     * be read through a panel.
     */
    onpopover?: (open: boolean) => void;
  }

  let {
    pill,
    revealed,
    presentationMode = 'prompter',
    onpresentationtoggle,
    followPaused = false,
    onfollowtoggle,
    appearancePanel = null,
    appearanceOpen = false,
    onappearanceopen,
    onappearanceclose,
    onend,
    onhold,
    onpopover,
  }: Props = $props();

  let confirmOpen = $state(false);
  let menuOpen = $state(false);
  let pointerInside = $state(false);
  let focusInside = $state(false);

  let dockRoot: HTMLElement | null = $state(null);
  let endButton: HTMLButtonElement | null = $state(null);
  let menuButton: HTMLButtonElement | null = $state(null);
  let menuPanel: HTMLElement | null = $state(null);
  let confirmPanel: HTMLElement | null = $state(null);
  let cancelButton: HTMLButtonElement | null = $state(null);

  /**
   * WHAT IS ACTUALLY IN THE MENU, IN ORDER.
   *
   * Built rather than written out, because two of the three rows depend on what
   * the host handed in and `menu-nav`'s arithmetic walks this array to work out
   * what the arrow keys do. A row that is not offered may not occupy an index.
   *
   * `kind` separates the two ARIA shapes below: a `menuitemcheckbox` reports
   * `aria-checked` and flips a mode where it stands, and the panel row is a
   * plain `menuitem` that says `aria-haspopup="dialog"` because the level it
   * opens is a dialog with sliders in it — form controls inside `role="menu"`
   * lose their own arrow keys to the menu's.
   */
  type MenuRow =
    | { kind: 'panel'; id: 'appearance'; label: string; select: () => void }
    | { kind: 'checkbox'; id: 'present' | 'follow'; label: string; checked: boolean; select: () => void };

  const rows = $derived<MenuRow[]>([
    ...(appearancePanel
      ? [
          {
            kind: 'panel' as const,
            id: 'appearance' as const,
            // The ellipsis is the desktop convention it has always been: this
            // row asks for more input rather than doing something.
            label: 'Adjust the prompter…',
            select: openAppearance,
          },
        ]
      : []),
    ...(onpresentationtoggle
      ? [
          {
            kind: 'checkbox' as const,
            id: 'present' as const,
            label: 'Fill the display',
            checked: presentationMode === 'prompter',
            select: () => onpresentationtoggle?.(),
          },
        ]
      : []),
    {
      kind: 'checkbox' as const,
      id: 'follow' as const,
      label: 'Follow my voice',
      checked: !followPaused,
      select: () => onfollowtoggle?.(),
    },
  ]);

  /** Which row the arrows have walked to. -1 before focus has landed. */
  let activeIndex = $state(-1);
  /**
   * Whether that row should LOOK chosen — the same distinction `OverflowMenu`
   * makes. The menu-button pattern requires focus to move in on open, so
   * `activeIndex` always points at something; a menu opened with the MOUSE has
   * not been told which row the operator wants, and painting the top one as
   * chosen makes it look one Return away from firing.
   */
  let highlighted = $state(false);

  /**
   * A fault holds the dock up on its own.
   *
   * The one moment somebody needs to find these controls without having been
   * warned is the one where the rig has stopped working, and that is also the
   * moment they are least likely to have their hand on the mouse.
   */
  const faulted = $derived(pill !== null && pill.reading === 'fault' && pill.visible);

  const held = $derived(
    pointerInside || focusInside || confirmOpen || menuOpen || appearanceOpen || faulted,
  );
  const buttonsVisible = $derived(revealed || held);

  const popoverOpen = $derived(confirmOpen || menuOpen || appearanceOpen);

  $effect(() => {
    onhold?.(held);
  });

  $effect(() => {
    onpopover?.(popoverOpen);
  });

  /* ------------------------------------------------------------ the menu */

  function menuItems(): HTMLElement[] {
    return menuPanel ? [...menuPanel.querySelectorAll<HTMLElement>('[data-menu-row]')] : [];
  }

  function focusRow(index: number, highlight = true): void {
    activeIndex = index;
    if (highlight) highlighted = true;
    // The row only exists once the menu has rendered.
    void tick().then(() => {
      if (menuOpen) menuItems()[index]?.focus();
    });
  }

  function openMenu(index = firstEnabledIndex(rows), highlight = true): void {
    confirmOpen = false;
    // Through the owner's own path, so the appearance panel's
    // cancel-restores-the-snapshot promise is kept rather than bypassed.
    if (appearanceOpen) onappearanceclose?.();
    menuOpen = true;
    focusRow(index, highlight);
  }

  function closeMenu(restoreFocus: boolean): void {
    if (!menuOpen) return;
    menuOpen = false;
    activeIndex = -1;
    highlighted = false;
    // Focus dropped on `<body>` is focus nobody can see on a full-screen stage.
    if (restoreFocus) menuButton?.focus();
  }

  /**
   * The trigger, deciding whether the highlight has anything to say.
   *
   * `detail` is the discriminator `OverflowMenu` uses for the same reason: a
   * pointer click carries a click count of at least one, and a click
   * synthesised from Enter/Space — or dispatched by assistive technology —
   * carries zero. Modality is not otherwise recoverable from a click event, and
   * a keyboard user left inside a menu with nothing drawn to say where has no
   * way to tell what Return would fire.
   */
  function toggleMenu(event?: MouseEvent): void {
    if (menuOpen) {
      closeMenu(true);
      return;
    }
    /*
     * The trigger is also the way OUT of the second level.
     *
     * Pressing it while the appearance panel is up means "put this away", the
     * same as pressing the old settings button again did — and putting the
     * panel away means cancel, which is what every other dismissal of it
     * already means. Re-opening onto the menu instead would answer a dismissal
     * gesture by showing more chrome.
     */
    if (appearanceOpen) {
      onappearanceclose?.();
      return;
    }
    openMenu(firstEnabledIndex(rows), !event || event.detail === 0);
  }

  function onTriggerKeydown(event: KeyboardEvent): void {
    if (menuOpen) return;
    // Enter/Space reach the click handler as well; letting both run would
    // toggle twice, so only the arrows are handled here.
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const index = openIndexForTriggerKey(rows, event.key);
    if (index === null) return;
    event.preventDefault();
    openMenu(index);
  }

  /**
   * A press that lands on the menu's own padding keeps the keyboard where it is.
   *
   * Without this the press blurs the focused row onto `<body>`, and a key aimed
   * at the open menu then arrives at the stage with a target that is not inside
   * `[data-stage-chrome]` — so ArrowDown scrolls the script, Space toggles the
   * transport and `[`/`]` change the auto-scroll pace, all behind a menu the
   * operator is looking at. Preventing the default of `pointerdown` is what
   * stops the browser moving focus at all.
   */
  function onMenuPointerDown(event: PointerEvent): void {
    const target = event.target;
    if (target instanceof Element && target.closest('[data-menu-row]') !== null) return;
    event.preventDefault();
  }

  /**
   * A checkbox row flips its mode and the menu STAYS OPEN.
   *
   * These are settings, not commands: "fill the display" and "follow my voice"
   * are things somebody may want to see take effect and then reconsider, and a
   * menu that closes on every tick makes reconsidering a second hunt for the
   * cog. The panel row is the other way round — it replaces the menu with the
   * level it opens — which is why the two paths are not one.
   */
  function chooseRow(row: MenuRow): void {
    if (row.kind === 'panel') {
      /*
       * Focus goes back to the TRIGGER before the level below opens, and that
       * ordering is the point.
       *
       * `StageAppearanceSheet` reads `document.activeElement` when it mounts and
       * puts focus back there when it closes. Unmounting the row first would
       * leave it reading `<body>` — so closing the panel would drop the keyboard
       * on a full-screen stage, which is the one defect every dismissal path in
       * this file is careful about.
       */
      closeMenu(true);
      row.select();
      return;
    }
    row.select();
  }

  function openConfirm(): void {
    closeMenu(false);
    if (appearanceOpen) onappearanceclose?.();
    confirmOpen = true;
  }

  /*
   * Never two panes of glass over the same dock. Opening one closes the other,
   * and the close goes through the owner's own path so the appearance panel's
   * cancel-restores-the-snapshot promise is kept rather than bypassed.
   */
  function openAppearance(): void {
    confirmOpen = false;
    if (appearanceOpen) onappearanceclose?.();
    else onappearanceopen?.();
  }

  function closeConfirm(): void {
    if (!confirmOpen) return;
    confirmOpen = false;
    // Back to the control that opened it. Focus dropped on `<body>` is focus
    // nobody can see on a full-screen stage.
    endButton?.focus();
  }

  /*
   * THE WHOLE MENU KEYBOARD, ON THE WINDOW AND IN THE CAPTURE PHASE.
   *
   * Not on the menu element, which is where this kind of handler usually goes
   * and where `OverflowMenu` correctly puts its own. Two things force it up
   * here, and both are properties of the surface rather than of the menu:
   *
   *   - The stage answers ArrowUp/ArrowDown, PageUp/PageDown, Space, `a` and
   *     `[`/`]` on the WINDOW, and it counts Escape towards the double press
   *     that ends a take. A key this menu handles must therefore be stopped
   *     before the stage sees it, not merely acted on afterwards — a menu that
   *     closed on Escape without stopping it would spend the presenter's first
   *     press on itself and leave the second one ending the session.
   *   - An element-scoped handler only fires while something inside it has
   *     focus, and focus on this surface is not guaranteed to be anywhere in
   *     particular. `onMenuPointerDown` above keeps it on a row where it can;
   *     catching the keys here means the arrows still walk the menu even if
   *     something else took the keyboard.
   */
  $effect(() => {
    if (!menuOpen) return undefined;
    const onKeydown = (event: KeyboardEvent): void => {
      // A real modal stacked over the menu keeps its own keyboard, for the
      // reason spelled out at the confirmation's handler below.
      if (document.querySelector('[role="dialog"][aria-modal="true"]') !== null) return;

      if (event.key === 'Escape') {
        event.stopPropagation();
        event.preventDefault();
        closeMenu(true);
        return;
      }
      if (event.key === 'Tab') {
        /*
         * A menu is not part of the tab ring, so Tab dismisses it — and it
         * hands the keyboard back to the TRIGGER before doing so, rather than
         * leaving it on a row that is about to unmount.
         *
         * That is not tidiness. The menu is rendered after the button row, so
         * tabbing out of a row skips the End control entirely and Shift+Tab
         * walks backwards INTO it, both of which disagree with where the menu
         * visibly hangs from. Returning to the trigger first makes Tab continue
         * from the control the operator actually opened. Deliberately not
         * prevented: the browser's own Tab then does the moving.
         */
        closeMenu(true);
        return;
      }

      const index = nextMenuIndex(rows, activeIndex, event.key);
      if (index === null) return;
      event.stopPropagation();
      event.preventDefault();
      focusRow(index);
    };
    /*
     * `pointerdown` rather than `click`, so a press that starts outside cannot
     * be completed on a row. Scoped to the whole dock rather than to the panel:
     * the trigger's own click already toggles, and letting this fire on it too
     * would close the menu and immediately re-open it.
     */
    const onPointerDown = (event: PointerEvent): void => {
      /*
       * A stacked modal's own clicks are not "outside".
       *
       * Cmd+. can raise the host's "Stop the session?" dialog over this menu.
       * That dialog records whatever had focus as the control to return it to —
       * a menu row — so closing the menu underneath its first click detaches
       * that node and leaves the dialog's own dismissal dropping focus on
       * `<body>`. The same guard the keyboard half above already makes.
       */
      if (document.querySelector('[role="dialog"][aria-modal="true"]') !== null) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (dockRoot?.contains(target)) return;
      // Focus back on the trigger, like every other route out of a popover in
      // this file. A genuinely focusable thing that was clicked still wins,
      // because the browser's own focus happens after this capture handler.
      closeMenu(true);
    };
    window.addEventListener('keydown', onKeydown, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKeydown, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  });

  function confirmEnd(): void {
    confirmOpen = false;
    onend();
  }

  /*
   * Escape closes the confirmation, on the window and in the capture phase.
   *
   * Capture, and `stopPropagation`, because the whole point is that Escape
   * inside an open confirmation may not also reach the stage's own key handler
   * — where it would be counted towards the double press that ends the take.
   * The one key somebody presses to back out of "end the session?" must never
   * be the key that ends the session.
   *
   * `[role="dialog"][aria-modal="true"]` is deliberately not claimed by this
   * panel: it is anchored, scrimless, and dismissed by clicking away, so
   * claiming modality would put it in the topmost-dialog contest that
   * `StageAppearanceSheet` and `Dialog` run between themselves and let it
   * silently take Escape from a sheet layered over it.
   */
  $effect(() => {
    if (!confirmOpen) return undefined;
    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      /*
       * A real modal stacked over this one keeps its own Escape.
       *
       * The reachable case is Cmd+. — which is NOT one of the shortcuts Live
       * delegates to the stage, so it still raises the host's "Stop the
       * session?" dialog, and it can do so while this confirmation is up
       * (nothing here claims `aria-modal`, so `isModalOpen` correctly does not
       * see it). Without this guard the capture listener below would swallow
       * the Escape that dialog is waiting for, and the operator would be left
       * with a confirm sheet that cannot be dismissed by keyboard.
       */
      if (document.querySelector('[role="dialog"][aria-modal="true"]') !== null) return;
      event.stopPropagation();
      event.preventDefault();
      closeConfirm();
    };
    /*
     * A click anywhere else cancels — never confirms. `pointerdown` rather than
     * `click` so a press that starts outside the panel cannot be completed
     * inside it.
     */
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      // A stacked modal's own clicks are not "outside" — see the menu's handler
      // above for the defect this stops.
      if (document.querySelector('[role="dialog"][aria-modal="true"]') !== null) return;
      if (!(target instanceof Node)) return;
      if (confirmPanel?.contains(target) || endButton?.contains(target)) return;
      /*
       * Through `closeConfirm`, not by clearing the flag.
       *
       * Cancel holds the keyboard while this is open, and clicking away
       * unmounts it — so a bare `confirmOpen = false` drops focus on `<body>`,
       * on a full-screen stage, which is the same "where did the keyboard go"
       * defect every other dismissal path here is careful about. Every route
       * out has to put focus back on the control that opened it.
       */
      closeConfirm();
    };
    window.addEventListener('keydown', onKeydown, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKeydown, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  });

  /** Cancel takes the keyboard, so Enter can never reach the destructive half. */
  $effect(() => {
    if (confirmOpen) cancelButton?.focus();
  });

  /*
   * The appearance panel dismisses on an outside click too, so the two behave
   * the same way. Its Escape is answered by the panel itself (it is a real
   * modal and traps Tab), which is why only the pointer half is here.
   */
  $effect(() => {
    if (!appearanceOpen) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (dockRoot?.contains(target)) return;
      onappearanceclose?.();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  });
</script>

<!--
  `data-stage-chrome` is read by the stage's own key handler: a key that landed
  on something in here was not addressed to the script.
-->
<div
  class="stage-dock"
  data-stage-chrome
  role="group"
  aria-label="Session controls"
  bind:this={dockRoot}
  onpointerenter={() => (pointerInside = true)}
  onpointerleave={() => (pointerInside = false)}
  onfocusin={() => (focusInside = true)}
  onfocusout={(event) => {
    const next = event.relatedTarget;
    if (next instanceof Node && dockRoot?.contains(next)) return;
    focusInside = false;
  }}
>
  <div class="dock-row">
    <!--
      The audio readout, in the corner, first in the row. See the note above:
      the one control that never hides is the one nothing that hides may sit
      outside of.
    -->
    <div class="dock-audio">
      {#if pill}
        <VoicePill {pill} />
      {:else}
        <!-- The audio display's space, held before control has said anything.
             Without it the buttons would start the take against the corner and
             then step sideways the moment the first level frame arrived. -->
        <div class="audio-placeholder" aria-hidden="true"></div>
      {/if}
    </div>

    <!--
      THE MENU TRIGGER, AND WHY IT DOES NOT FADE WHILE FOLLOWING IS OFF.

      Everything behind it is a verb somebody reaches for and then forgets:
      adjust the prompter, take the display, hand it back. One of them is not —
      voice following sets a MODE, and a mode that hides itself is how a
      presenter ends up staring at a script that will not move, with the control
      that explains it invisible until they happen to move the mouse.

      So the trigger obeys `buttonsVisible` in exactly one direction. While
      following is on — the ordinary case, the whole take — it fades with the
      rest, because it is then reporting the state everybody already assumes.
      While it is off it stays lit and amber, because it is then the answer to
      the only question the presenter is going to ask.

      It is NOT stood down while the appearance panel is up, unlike everything
      else in this row: pressing it is how somebody puts that panel away with
      the mouse, and it means cancel — the same as Escape and the same as
      clicking off it. A control the modal's own dismissal gesture runs through
      is not a control reaching past the modal.
    -->
    <button
      type="button"
      class="dock-button menu-trigger"
      class:flagged={followPaused}
      data-hidden={!buttonsVisible && !followPaused}
      aria-haspopup="menu"
      aria-expanded={menuOpen || appearanceOpen}
      aria-label={followPaused ? 'Session menu — voice following is off' : 'Session menu'}
      title={followPaused ? 'Session menu — voice following is off' : 'Session menu'}
      bind:this={menuButton}
      onclick={toggleMenu}
      onkeydown={onTriggerKeydown}
    >
      <!--
        Lucide's cog, inlined.

        Inlined rather than taken from `Icon.svelte` because that component
        lives in control's tree, and the standalone stage window is a separate
        entry point that must not pull control in behind one glyph. Every other
        icon in this dock is drawn here for the same reason.
      -->
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path
          d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
        />
        <circle cx="12" cy="12" r="3" />
      </svg>
      <!--
        The mode mark, drawn as well as tinted.

        A hue shift and a shape fail under different conditions — colour goes
        first through a beamsplitter, geometry goes first at 16px on a
        non-Retina panel — so the state that must never be missed is carried by
        both. `aria-hidden`, because the trigger's own name already says it.
      -->
      {#if followPaused}
        <span class="flag" aria-hidden="true"></span>
      {/if}
    </button>

    <!-- The destructive control is deliberately further away. It is the one
         thing in this dock nobody wants to hit while reaching for something
         else. -->
    <!--
      Stood down while the appearance panel is up, because that panel says it is
      `aria-modal`.

      A live control beside a modal is a promise the modal does not keep: it is
      told to the keyboard and to assistive technology that everything outside
      is inert, while a pointer can still reach this one — and reaching it here
      does two things at once, cancelling the appearance transaction and opening
      a second popover. The old top-right corner solved the same problem by
      removing its trigger entirely; the dock cannot do that without the row
      collapsing, so it disables instead. Escape and Cancel are still the way
      out of the panel, so nothing is trapped.
    -->
    <button
      type="button"
      class="dock-button end"
      data-hidden={!buttonsVisible}
      disabled={appearanceOpen}
      aria-label="End session"
      aria-expanded={confirmOpen}
      title="End session"
      bind:this={endButton}
      onclick={openConfirm}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path d="M18 6 6 18M6 6l12 12" stroke-linecap="round" />
      </svg>
    </button>
  </div>

  <!--
    LEVEL ONE. It is not rendered at the same time as level two: choosing the
    panel row replaces the menu with it, in the same place, rising from the same
    control.

    `role="menu"` ends here on purpose. The level it opens is a form with
    sliders in it, and inside a menu a slider loses its own left/right arrows to
    the menu's — so the appearance popover below claims `dialog` and this claims
    nothing about it beyond `aria-haspopup` on the row.
  -->
  <!--
    `!appearanceOpen` makes the two levels exclusive STRUCTURALLY rather than by
    every path that opens one happening to close the other. The dock does not
    own `appearanceOpen` — the host does — so a second opener added over there
    later would otherwise put both levels on the glass at once, and this file
    promises in several places that it cannot.
  -->
  {#if menuOpen && !appearanceOpen}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="dock-popover menu-popover"
      role="menu"
      tabindex="-1"
      aria-label="Session menu"
      bind:this={menuPanel}
      onpointerdown={onMenuPointerDown}
    >
      {#each rows as row, index (row.id)}
        <button
          type="button"
          class="menu-row"
          class:active={highlighted && index === activeIndex}
          data-menu-row={row.id}
          role={row.kind === 'checkbox' ? 'menuitemcheckbox' : 'menuitem'}
          aria-checked={row.kind === 'checkbox' ? row.checked : undefined}
          aria-haspopup={row.kind === 'panel' ? 'dialog' : undefined}
          tabindex={menuItemTabIndex(activeIndex, index)}
          onclick={() => chooseRow(row)}
          onpointerenter={() => focusRow(index)}
        >
          <!--
            A fixed gutter, filled only by a checked row.

            The tick is the state — `aria-checked` says it to a screen reader
            and this says it to an eye — and it has to hold its column whether
            or not it is drawn, or every label in the menu shifts sideways as
            modes are flipped from inside it.
          -->
          <span class="menu-mark" aria-hidden="true">
            {#if row.kind === 'checkbox' && row.checked}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <path d="m5 12.5 4.5 4.5L19 7" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            {/if}
          </span>
          <span class="menu-label">{row.label}</span>
          {#if row.kind === 'panel'}
            <!-- The chevron says "there is another level", which is the one
                 thing the ellipsis in the label cannot say on its own. -->
            <svg
              class="menu-into"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              aria-hidden="true"
            >
              <path d="m9 6 6 6-6 6" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          {/if}
        </button>
      {/each}
    </div>
  {/if}

  {#if appearanceOpen && appearancePanel}
    <div class="dock-popover appearance-popover">
      {@render appearancePanel()}
    </div>
  {/if}

  {#if confirmOpen}
    <div
      class="dock-popover confirm-popover"
      role="dialog"
      aria-label="End session"
      bind:this={confirmPanel}
    >
      <p class="confirm-title">End session?</p>
      <p class="confirm-body">Your place in the script will be saved.</p>
      <div class="confirm-actions">
        <button type="button" class="confirm-cancel" bind:this={cancelButton} onclick={closeConfirm}>
          Cancel
        </button>
        <button type="button" class="confirm-end" onclick={confirmEnd}>End session</button>
      </div>
    </div>
  {/if}
</div>

<style>
  /*
   * Bottom left of whatever rectangle it is given — which is the SAFE
   * rectangle, so a hood that crops the panel crops the dock with it rather
   * than leaving it under the bezel.
   *
   * `pointer-events: auto` is load-bearing: the operator plane above it is
   * `none` so a stray click over a diagnostic lands on the stage root and
   * reports focus. Inherited, this dock would paint perfectly and do nothing.
   */
  .stage-dock {
    position: absolute;
    left: var(--stage-chrome-inset, 20px);
    bottom: var(--stage-chrome-bottom-inset, 16px);
    pointer-events: auto;
  }

  .dock-row {
    display: flex;
    align-items: center;
    /* Three slots, and the two gaps between them are not the same: the readout
       and the way out are each pushed clear of the middle by the larger margins
       below. */
    gap: 6px;
  }

  /*
   * A little more air after the readout than between the buttons (6 + 4).
   *
   * It is a different KIND of thing from what follows it — an instrument that
   * runs for the whole take, against a group of verbs that come and go — and at
   * rest it is the only thing left in the corner. The gap is what stops it
   * reading as the first item of a toolbar during the moments the toolbar is up.
   */
  /*
   * THE AUDIO SLOT IS SIZED BY ITS CONTENTS.
   *
   * This was briefly a fixed 232px, wide enough to hold the readout carrying
   * its longest fault label (`No audio`, `Not connected`, `Not hearing you`,
   * and the stage's own `Control lost`) so that a fault could not widen the
   * pill and shove the button row sideways.
   *
   * It is not worth it. An 88px word cannot share a 106px pill with a 60px
   * trace and a 16px mark, so buying that stability meant carrying 126px of
   * empty glass in every take for a shove that almost never happens. The pill
   * now grows by one short word on a fault and the row settles; see the note
   * on `.label` in `VoicePill.svelte`.
   *
   * The placeholder below therefore states the resting width once, in the one
   * place that needs a number: 60 (trace) + 8 (gap) + 16 (mark) + 20 (padding)
   * + 2 (borders) = 106px, which is what the pill measures with no label.
   */
  .dock-audio {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    margin-right: 4px;
  }

  /*
   * 40px of visible surface, 44px of target.
   *
   * The extra four pixels are claimed by a pseudo-element rather than by
   * padding, so the material and the border stay exactly 40px square on a
   * 1024x600 panel while the thing a mouse has to hit is comfortably bigger
   * than the 24px WCAG floor. This is a control that may be aimed at from
   * across a room.
   */
  .dock-button {
    position: relative;
    flex: 0 0 auto;
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    padding: 0;
    border: 1px solid var(--stage-chrome-border);
    border-radius: var(--stage-chrome-radius);
    background: var(--stage-chrome-bg);
    box-shadow: var(--stage-chrome-shadow);
    -webkit-backdrop-filter: blur(16px) saturate(130%);
    backdrop-filter: blur(16px) saturate(130%);
    color: var(--stage-chrome-text);
    cursor: pointer;
    transition:
      opacity 140ms var(--ease-out, ease-out),
      transform 140ms var(--ease-out, ease-out),
      color 120ms linear,
      border-color 120ms linear,
      background-color 120ms linear;
  }

  .dock-button::after {
    content: '';
    position: absolute;
    inset: -2px;
  }

  .dock-button svg {
    /* Whole pixels. A 15.5px icon on a non-Retina 1024x600 panel is a soft
       icon, and the whole dock is judged through a beamsplitter. */
    width: 16px;
    height: 16px;
  }

  .menu-trigger {
    color: rgb(245 243 239 / 72%);
  }

  /*
   * A mode that is off is a STATE, so it is drawn as one rather than left to
   * the glyph alone.
   *
   * Amber rather than the red the end button borrows, because nothing is wrong
   * — the presenter asked for this. The mark is a disc on the shoulder of the
   * button, outside the glass rather than inside the cog: a badge overlapping a
   * 16px icon with twelve notches in it is two shapes fighting for the same
   * pixels on a non-Retina panel.
   */
  .menu-trigger.flagged {
    color: #e8b661;
    background: rgb(232 182 97 / 12%);
    border-color: rgb(232 182 97 / 38%);
  }

  .menu-trigger.flagged:hover,
  .menu-trigger.flagged:focus-visible {
    color: #f2c97e;
    background: rgb(232 182 97 / 18%);
    border-color: rgb(232 182 97 / 52%);
  }

  .flag {
    position: absolute;
    top: -2px;
    right: -2px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #e8b661;
    /* A ring in the dock's own material, so the disc reads as a mark ON the
       button rather than as a speck of script showing through it. */
    box-shadow: 0 0 0 2px rgb(12 14 18 / 92%);
  }

  .end {
    /* Quietest of the three at rest. It is not tinted at all until somebody is
       actually pointing at it: a persistent red mark in the corner of a take
       would be the loudest thing on a black field, reporting nothing. */
    color: rgb(245 243 239 / 58%);
  }

  .dock-button:hover,
  .dock-button:focus-visible {
    background: rgb(24 28 35 / 88%);
    border-color: rgb(255 255 255 / 30%);
    color: #fff;
  }

  .end:hover,
  .end:focus-visible {
    color: #ef7168;
    background: rgb(239 113 104 / 12%);
    border-color: rgb(239 113 104 / 38%);
  }

  .dock-button:focus-visible {
    outline: 2px solid rgb(245 243 239 / 70%);
    outline-offset: 2px;
  }

  .dock-button:active {
    transform: translateY(1px);
  }

  /*
   * Gone, but still in the layout.
   *
   * Both halves matter. `opacity: 0` alone leaves an invisible button that
   * still takes a click, which is a trap in the exact corner a pointer is
   * likely to be resting; `display: none` would take it out of the tab order
   * and collapse the row, so the buttons would shuffle sideways against each
   * other every time one of them changed state.
   *
   * The audio readout is no longer downstream of any of this — it is first in
   * the row — but the rule stands for the cluster itself.
   */
  .dock-button[data-hidden='true'] {
    opacity: 0;
    pointer-events: none;
    transform: translateY(2px);
  }

  /* Stood down behind the modal appearance panel — see the markup. */
  .dock-button:disabled {
    opacity: 0.35;
    pointer-events: none;
    cursor: default;
  }

  /* The larger gap before the destructive control (6px + 4px). */
  .end {
    margin-left: 4px;
  }

  /*
   * The pill's OUTER width, borders included: 1 + 10 + 60 + 8 + 16 + 10 + 1.
   *
   * It was 104, which is the content box, and the two pixels showed: the row
   * stepped sideways the instant the first level frame arrived — the exact
   * movement this placeholder exists to prevent, just smaller than the one it
   * was written for.
   */
  /* The resting pill's own measurement, so the dock does not jump when the
     first payload swaps this out for the real readout. See `.dock-audio`. */
  .audio-placeholder {
    width: 106px;
    height: 40px;
  }

  /*
   * Popovers rise from the control that opened them, 8px clear, and never
   * behind a scrim — the stage behind is the thing being judged.
   */
  .dock-popover {
    position: absolute;
    bottom: calc(100% + 8px);
    /* The room there actually is above this dock inside the rig's safe
       rectangle — see `dockPopoverMaxPx` in StageApp. The fallback is the
       viewport, which is right for a plain panel and wrong for a hooded one. */
    max-height: var(--stage-popover-max-height, calc(100vh - 96px));
    animation: dock-pop-in 140ms var(--ease-out, ease-out);
  }

  .appearance-popover {
    left: 0;
  }

  /*
   * Left-aligned with the dock, like the other two, and for the reason set out
   * at `.confirm-popover` below: a panel hung off the right edge of a control
   * this close to the left edge of the screen starts at a negative x and is
   * silently cropped by `.stage-root`'s `overflow: hidden`.
   *
   * Sized to its longest row rather than to a round number. It carries three
   * short labels and nothing else, and a menu wider than its content over a
   * running script is glass bought for nothing.
   */
  .menu-popover {
    left: 0;
    min-width: 196px;
    display: flex;
    flex-direction: column;
    /* No gap: the highlight is a full-width wash, and gaps between washes read
       as a list of buttons rather than as a menu. */
    padding: 6px;
    border: 1px solid var(--stage-chrome-border);
    border-radius: var(--stage-chrome-radius);
    /* The same slightly-more-opaque glass the confirmation uses. This one
       carries prose over moving white type too. */
    background: rgb(12 14 18 / 90%);
    box-shadow: var(--stage-chrome-shadow);
    -webkit-backdrop-filter: blur(18px) saturate(130%);
    backdrop-filter: blur(18px) saturate(130%);
    color: var(--stage-chrome-text);
    overflow-y: auto;
  }

  .menu-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    /* 34, not 32: this is aimed at from across a room with a mouse somebody is
       not looking at, the same reason the dock buttons carry a 44px target. */
    min-height: 34px;
    padding: 0 10px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: #f5f3ef;
    font: inherit;
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
    text-align: left;
    cursor: pointer;
    transition: background-color 120ms linear;
  }

  /*
   * A menu highlights, it does not ring.
   *
   * Driven by `activeIndex` rather than by `:focus`/`:hover`, so exactly one
   * row is ever marked no matter which device is driving it — and so the mark
   * does not depend on how the engine chooses to interpret programmatic focus
   * for `:focus-visible`. An outline as well would read as a second selection
   * sitting underneath the wash marking the very same row.
   */
  .menu-row:focus,
  .menu-row:focus-visible {
    outline: none;
  }
  .menu-row.active {
    background: rgb(255 255 255 / 12%);
  }

  .menu-mark {
    flex: 0 0 auto;
    display: grid;
    place-items: center;
    width: 14px;
    height: 14px;
  }
  .menu-mark svg {
    width: 14px;
    height: 14px;
  }

  .menu-label {
    flex: 1 1 auto;
  }

  .menu-into {
    flex: 0 0 auto;
    width: 14px;
    height: 14px;
    color: rgb(245 243 239 / 52%);
  }

  /*
   * LEFT-ALIGNED, NOT RIGHT-ALIGNED TO THE × IT BELONGS TO.
   *
   * Anchoring it to the right edge of its own button is the tidier idea and it
   * does not survive the geometry: the dock is about 150px wide and starts 20px
   * from the edge of the panel, so a 236px panel hung off its right edge starts
   * at roughly minus sixty — off the screen, and silently cropped by
   * `.stage-root`'s `overflow: hidden`. Verified at 1024x600, which is the
   * panel this is actually judged on.
   *
   * Left-aligning costs nothing in the connection it was protecting: the panel
   * is wider than the dock, so it still sits directly over the × that raised
   * it. It just does so from the other end.
   */
  .confirm-popover {
    left: 0;
    width: 236px;
    padding: 12px 14px 12px;
    border: 1px solid var(--stage-chrome-border);
    border-radius: var(--stage-chrome-radius);
    /* A little more opaque than the dock: this one carries prose and two
       buttons over moving white type, and glass that reads is worth more here
       than glass that is see-through. */
    background: rgb(12 14 18 / 90%);
    box-shadow: var(--stage-chrome-shadow);
    -webkit-backdrop-filter: blur(18px) saturate(130%);
    backdrop-filter: blur(18px) saturate(130%);
    color: var(--stage-chrome-text);
  }

  .confirm-title {
    margin: 0;
    font-size: 14px;
    font-weight: 650;
    color: #f5f3ef;
  }

  .confirm-body {
    margin: 4px 0 0;
    font-size: 12px;
    line-height: 1.4;
    color: rgb(245 243 239 / 62%);
  }

  .confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 12px;
  }

  .confirm-actions button {
    padding: 6px 12px;
    border-radius: 8px;
    border: 1px solid transparent;
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }

  .confirm-cancel {
    border-color: rgb(255 255 255 / 18%);
    background: transparent;
    color: rgb(245 243 239 / 88%);
  }
  .confirm-cancel:hover {
    background: rgb(255 255 255 / 10%);
  }

  .confirm-end {
    border-color: rgb(239 113 104 / 55%);
    background: rgb(239 113 104 / 18%);
    color: #ffb4a2;
  }
  .confirm-end:hover {
    background: rgb(239 113 104 / 30%);
    color: #fff;
  }

  .confirm-actions button:focus-visible {
    outline: 2px solid rgb(245 243 239 / 70%);
    outline-offset: 2px;
  }

  @keyframes dock-pop-in {
    from {
      opacity: 0;
      transform: translateY(2px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  /* Opacity only. Nothing on this surface earns a spring. */
  @media (prefers-reduced-motion: reduce) {
    .dock-button,
    .dock-button[data-hidden='true'],
    .dock-button:active {
      transition: opacity 140ms linear;
      transform: none;
    }
    .dock-popover {
      animation: none;
    }
  }

  /* Where the glass cannot be made, the material is simply darker. */
  @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
    .dock-button {
      background: rgb(12 14 18 / 92%);
    }
    .menu-popover,
    .confirm-popover {
      background: rgb(12 14 18 / 96%);
    }
  }
</style>
