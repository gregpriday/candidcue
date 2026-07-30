<!--
  The session dock — one quiet control location, bottom left.

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
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { PresentationMode, StageVoicePillPayload } from '../shared/contracts';
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
     * The appearance panel, rendered by whoever owns the settings.
     *
     * A snippet rather than a component, because the stage does not own stage
     * settings and must not start pretending to: the standalone stage window
     * receives a resolved envelope and has nothing to adjust, so it passes
     * nothing and the button is simply not there. Single-window presentation
     * hands in the host's own sheet, which keeps the transaction — live
     * preview, Done saves, Cancel restores — where the state it is transacting
     * on actually lives.
     */
    appearancePanel?: Snippet | null;
    /** Whether that panel is open. Owned by the host, for the same reason. */
    appearanceOpen?: boolean;
    onappearanceopen?: () => void;
    /** Escape, a click outside, or the settings button again. Means "cancel". */
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
  let pointerInside = $state(false);
  let focusInside = $state(false);

  let dockRoot: HTMLElement | null = $state(null);
  let endButton: HTMLButtonElement | null = $state(null);
  let confirmPanel: HTMLElement | null = $state(null);
  let cancelButton: HTMLButtonElement | null = $state(null);

  /**
   * A fault holds the dock up on its own.
   *
   * The one moment somebody needs to find these controls without having been
   * warned is the one where the rig has stopped working, and that is also the
   * moment they are least likely to have their hand on the mouse.
   */
  const faulted = $derived(pill !== null && pill.reading === 'fault' && pill.visible);

  const held = $derived(
    pointerInside || focusInside || confirmOpen || appearanceOpen || faulted,
  );
  const buttonsVisible = $derived(revealed || held);

  const popoverOpen = $derived(confirmOpen || appearanceOpen);

  $effect(() => {
    onhold?.(held);
  });

  $effect(() => {
    onpopover?.(popoverOpen);
  });

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

  function openConfirm(): void {
    if (appearanceOpen) onappearanceclose?.();
    confirmOpen = true;
  }

  function closeConfirm(): void {
    if (!confirmOpen) return;
    confirmOpen = false;
    // Back to the control that opened it. Focus dropped on `<body>` is focus
    // nobody can see on a full-screen stage.
    endButton?.focus();
  }

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
      THE FOLLOW SWITCH, AND WHY IT DOES NOT FADE WHEN IT IS OFF.

      Every other control in this dock is a verb somebody reaches for and then
      forgets: adjust the prompter, end the session. This one sets a MODE, and a
      mode that hides itself is how a presenter ends up staring at a script that
      will not move, with the control that explains it invisible until they
      happen to move the mouse.

      So it obeys `buttonsVisible` in exactly one direction. While following is
      on — the ordinary case, the whole take — it fades with the rest, because
      it is then reporting the state everybody already assumes. While it is off
      it stays lit, because it is then the answer to the only question the
      presenter is going to ask.

      The hold chip says the same thing in words, in the mirror plane, in
      presenter-sized type (`resolveHoldStatus`). This is the half somebody can
      click.
    -->
    <!--
      Stood down while the appearance panel is up, for the reason set out in
      full above the end button below: that panel says `aria-modal`, and a live
      control beside a modal is a promise the modal does not keep.

      This one had been left out of that stand-down, which made it the worst of
      the three to leave live: it is a MODE switch, so a stray click while the
      panel is open does not merely cancel the appearance transaction, it also
      stops the script following the presenter's voice — and leaves them to work
      out from a stationary script that something they did not intend to touch
      is now off.
    -->
    <button
      type="button"
      class="dock-button follow"
      class:paused={followPaused}
      data-hidden={!buttonsVisible && !followPaused}
      disabled={appearanceOpen}
      aria-pressed={!followPaused}
      aria-label={followPaused
        ? 'Voice following is off — switch it on'
        : 'Voice following is on — switch it off'}
      title={followPaused ? 'Follow my voice' : 'Stop following my voice'}
      onclick={() => onfollowtoggle?.()}
    >
      <!-- The reading line, and the script advancing under it. Struck through
           when nothing is advancing it. Deliberately not a waveform: the audio
           display sits inches away in this same row and two waveforms in one
           corner would read as two claims about the microphone. -->
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path d="M4 9h16" stroke-linecap="round" />
        <path d="M9 14l3 3 3-3" stroke-linecap="round" stroke-linejoin="round" />
        {#if followPaused}
          <path d="M5 19 19 5" stroke-linecap="round" />
        {/if}
      </svg>
    </button>

    <!--
      Full display, or a window.

      Present in the dock rather than only on the keyboard because of the fault
      the dock exists for (see the note on `revealed`): a prompter filling a
      display with no visible way out reads as a hang, and "give me my window
      back" is the most literal instance of that there is. Somebody who pressed
      Present without realising it would take the screen needs to be able to
      point at the way back, not know a chord.

      Only rendered when the host supplies the handler — the standalone stage
      window is a separate window on a second display, and there is no
      presentation mode to toggle for it.
    -->
    {#if onpresentationtoggle}
      <!-- Stood down with the panel open, like the follow and end buttons
           beside it: taking the display over or handing it back underneath an
           open modal is the largest thing this dock can do by accident. -->
      <button
        type="button"
        class="dock-button present-mode"
        data-hidden={!buttonsVisible}
        disabled={appearanceOpen}
        aria-pressed={presentationMode === 'prompter'}
        aria-label={presentationMode === 'prompter'
          ? 'Filling the display — show in a window instead'
          : 'Showing in a window — fill the display instead'}
        title={presentationMode === 'prompter' ? 'Show in a window' : 'Fill the display'}
        onclick={() => onpresentationtoggle?.()}
      >
        <!-- The two states drawn as what they ARE rather than as an arrow: a
             frame filling its bounds, or a smaller frame inside them. An
             enter/exit chevron pair would need the presenter to know which
             direction they are currently in to read it. -->
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          {#if presentationMode === 'prompter'}
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <rect x="8" y="9" width="8" height="6" rx="1" />
          {:else}
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M8 9h8M8 12h8M8 15h5" stroke-linecap="round" />
          {/if}
        </svg>
      </button>
    {/if}

    {#if appearancePanel}
      <button
        type="button"
        class="dock-button adjust"
        data-hidden={!buttonsVisible}
        aria-label="Adjust the prompter"
        aria-expanded={appearanceOpen}
        title="Adjust the prompter"
        onclick={openAppearance}
      >
        <!-- Sliders, not an ellipsis. Once ending the session has a control of
             its own an overflow menu would open onto a single real action, and
             a glyph that names the thing beats a glyph that names a list. -->
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M20 7h-9M14 17H5" stroke-linecap="round" />
          <circle cx="17" cy="17" r="3" />
          <circle cx="7" cy="7" r="3" />
        </svg>
      </button>
    {/if}

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
    /* The buttons sit together as one cluster; the audio readout and the end
       button are pushed clear of it by the larger gaps below. */
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

  .follow {
    color: rgb(245 243 239 / 72%);
  }

  /*
   * Off is a STATE, so it is drawn as one rather than left to the icon alone.
   *
   * A 16px glyph with a stroke through it is a legible difference on a monitor
   * and a coin toss through a beamsplitter at two metres, which is where this
   * is read from. The tint does the work the geometry cannot; it is the amber
   * end of the palette rather than the red the end button borrows, because
   * nothing is wrong — the presenter asked for this.
   */
  .follow.paused {
    color: #e8b661;
    background: rgb(232 182 97 / 12%);
    border-color: rgb(232 182 97 / 38%);
  }

  .follow.paused:hover,
  .follow.paused:focus-visible {
    color: #f2c97e;
    background: rgb(232 182 97 / 18%);
    border-color: rgb(232 182 97 / 52%);
  }

  .adjust {
    color: rgb(245 243 239 / 72%);
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
    .confirm-popover {
      background: rgb(12 14 18 / 96%);
    }
  }
</style>
