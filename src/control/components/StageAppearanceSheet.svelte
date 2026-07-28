<!--
  The in-session appearance sheet.

  ---------------------------------------------------------------------------
  WHY THIS EXISTS AT ALL
  ---------------------------------------------------------------------------
  Every control on it already existed on the Settings screen, where none of them
  can be judged. "Reading band position" is aligned against a camera lens;
  "Default font size" is answered by standing where you will stand and seeing
  whether you can read it; "Text intensity" is a question about a reflection in
  a piece of glass. All of them have exactly one correct place to be set — in
  front of the running prompter — and until now that was the one place they
  could not be reached.

  ---------------------------------------------------------------------------
  WHAT IT PROMISES
  ---------------------------------------------------------------------------
  Every move is live: the stage behind the sheet re-renders as the slider moves,
  because a control you have to close a panel to evaluate is a control you
  evaluate twice. OK writes what is on the glass into the saved settings, so the
  next take opens on it. Cancel puts the take back exactly as it was found and
  saves nothing — which is why the caller hands in the appearance it opened
  with rather than this sheet remembering it.

  The sheet is `aria-modal` and traps Tab. It has no scrim: the whole point is
  that the stage stays visible and legible behind it, so it takes one corner of
  the screen and leaves the reading band alone. Modality without a scrim still
  owes the rest of the promise — the caller hides the chrome behind it, so there
  is nothing live to reach past this panel.

  ---------------------------------------------------------------------------
  A RIG-RESOLVED TAKE GETS A READOUT, NOT CONTROLS
  ---------------------------------------------------------------------------
  Where a saved rig decided the appearance (§17.2), `buildStageSettings` works
  every one of these values out from a measured distance and never consults the
  loose ones — including text intensity, which a calibrated profile carries
  because it was chosen by somebody standing at that glass looking at that
  reflection. Sliders here would move and change nothing, and an OK button would
  write the RIG's numbers into the global defaults, quietly changing what every
  uncalibrated take opens with. So the sheet says what the rig resolved, says
  where to change it, and offers nothing it cannot deliver.
-->
<script lang="ts">
  import Button from './Button.svelte';
  import SegmentedControl from './SegmentedControl.svelte';
  import Slider from './Slider.svelte';
  import { FOCUSABLE_SELECTOR, nextTrapFocus } from './dialog-focus';
  import { APPEARANCE_LIMITS, type StageAppearance } from '../lib/stage-appearance';
  import type { TextIntensity } from '../../shared/contracts';

  interface Props {
    /** What the stage is prompting at right now. */
    appearance: StageAppearance;
    /**
     * §17.2: a saved rig decided this take's appearance, so none of it is the
     * sheet's to set. It reports and points at the wizard instead.
     */
    rigResolved: boolean;
    /**
     * The take's size ceiling, fixed when it opened.
     *
     * Handed in rather than derived here so it cannot move under the thumb: a
     * ceiling recomputed from the live value turns a drag downward into a
     * one-way ratchet, and the range the operator was offered when the panel
     * opened stops being the range they have.
     */
    maxFontSizePx: number;
    /** Apply to the running take. Called on every move. */
    onchange: (patch: Partial<StageAppearance>) => void;
    /** Keep it: save to settings and close. */
    onok: () => void;
    /** Put the take back and close. */
    oncancel: () => void;
  }

  let { appearance, rigResolved, maxFontSizePx, onchange, onok, oncancel }: Props = $props();

  const uid = $props.id();
  let panel: HTMLElement | null = $state(null);

  const INTENSITY_LABEL: Record<TextIntensity, string> = {
    soft: 'Soft',
    standard: 'Standard',
    strong: 'Strong',
  };

  /**
   * Focus moves in on open and back to the opener on close, the same contract
   * Dialog.svelte keeps. Without the second half, closing the sheet unmounts
   * the focused node and leaves focus on `<body>` — which on a full-screen
   * stage means the next Tab starts from the top of a page nobody can see, and
   * the menu button that opened this is no longer where the keyboard is.
   */
  $effect(() => {
    if (!panel) return undefined;
    const opener = document.activeElement as HTMLElement | null;
    const target =
      panel.querySelector<HTMLElement>('[data-autofocus]') ??
      panel.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ??
      panel; // the panel itself is tabindex="-1"
    target.focus();
    return () => opener?.focus();
  });

  /*
   * Escape and Tab, on the window and in the capture phase, for the reason
   * Dialog.svelte states: clicking the sheet's own prose drops focus on
   * `<body>`, and a panel-scoped handler then never sees the key again.
   *
   * Escape here means "cancel", not "end the take". The stage stands its own
   * key handling down while this is open (`chromeOpen`), so this is the only
   * thing answering — a presenter who opens the sheet mid-take and hits Escape
   * out of reflex gets their panel closed, not their session ended.
   */
  $effect(() => {
    if (!panel) return undefined;
    const onKeydown = (event: KeyboardEvent): void => {
      if (!panel) return;
      /*
       * Topmost only, so a confirm sheet opened over this one keeps its own
       * Escape. Same guard as Dialog's, and for the same reason: two capture
       * listeners on the window both answer, and the one underneath must not.
       */
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (dialogs.length > 0 && dialogs[dialogs.length - 1] !== panel) return;

      if (event.key === 'Escape') {
        event.stopPropagation();
        event.preventDefault();
        oncancel();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusables = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
      const active = document.activeElement as HTMLElement | null;
      const next = nextTrapFocus(focusables, active, event.shiftKey, panel.contains(active));
      if (next) {
        event.preventDefault();
        next.focus();
      }
    };
    window.addEventListener('keydown', onKeydown, true);
    return () => window.removeEventListener('keydown', onKeydown, true);
  });
</script>

<div
  class="sheet"
  role="dialog"
  tabindex="-1"
  aria-modal="true"
  aria-labelledby="{uid}-title"
  bind:this={panel}
>
  <header class="sheet-head">
    <h2 class="title" id="{uid}-title">Adjust the prompter</h2>
    <p class="sub">
      {rigResolved
        ? 'This display runs from a saved rig.'
        : 'Changes show on the stage as you make them.'}
    </p>
  </header>

  <div class="body">
    {#if rigResolved}
      <!--
        A readout, not four disabled tracks. A range input pinned at a value it
        cannot reach — a rig may resolve a line height of 2.0, past the top of
        the slider — shows a thumb that disagrees with its own number, which is
        a worse answer than plain text.
      -->
      <dl class="readout">
        <div class="row">
          <dt>Text intensity</dt>
          <dd>{INTENSITY_LABEL[appearance.textIntensity]}</dd>
        </div>
        <div class="row">
          <dt>Font size</dt>
          <dd>{Math.round(appearance.fontSizePx)} px</dd>
        </div>
        <div class="row">
          <dt>Line height</dt>
          <dd>{appearance.lineHeight.toFixed(2)}</dd>
        </div>
        <div class="row">
          <dt>Text column width</dt>
          <dd>{Math.round(appearance.columnWidthPercent)}%</dd>
        </div>
        <div class="row">
          <dt>Reading band position</dt>
          <dd>{Math.round(appearance.readingBandCenterPercent)}%</dd>
        </div>
      </dl>
      <p class="hint">
        Every one of these was worked out from how far away you stand, which is the
        only way they can be right on two panels of different sizes at once. To
        change them, recalibrate this display under <strong>Settings → Stage display</strong>.
      </p>
    {:else}
      <SegmentedControl
        label="Text intensity"
        size="sm"
        value={appearance.textIntensity}
        options={[
          { value: 'soft', label: 'Soft' },
          { value: 'standard', label: 'Standard' },
          { value: 'strong', label: 'Strong' },
        ]}
        onchange={(value) => onchange({ textIntensity: value as TextIntensity })}
      />
      <p class="hint">How bright the words burn over the stage's black field.</p>

      <Slider
        label="Font size"
        value={appearance.fontSizePx}
        min={APPEARANCE_LIMITS.fontSizePx.min}
        max={maxFontSizePx}
        step={APPEARANCE_LIMITS.fontSizePx.step}
        format={(v) => `${v} px`}
        onchange={(value) => onchange({ fontSizePx: value })}
      />
      <Slider
        label="Line height"
        value={appearance.lineHeight}
        min={APPEARANCE_LIMITS.lineHeight.min}
        max={APPEARANCE_LIMITS.lineHeight.max}
        step={APPEARANCE_LIMITS.lineHeight.step}
        format={(v) => v.toFixed(2)}
        onchange={(value) => onchange({ lineHeight: value })}
      />
      <Slider
        label="Text column width"
        value={appearance.columnWidthPercent}
        min={APPEARANCE_LIMITS.columnWidthPercent.min}
        max={APPEARANCE_LIMITS.columnWidthPercent.max}
        format={(v) => `${v}%`}
        onchange={(value) => onchange({ columnWidthPercent: value })}
      />
      <Slider
        label="Reading band position"
        value={appearance.readingBandCenterPercent}
        min={APPEARANCE_LIMITS.readingBandCenterPercent.min}
        max={APPEARANCE_LIMITS.readingBandCenterPercent.max}
        format={(v) => `${v}%`}
        onchange={(value) => onchange({ readingBandCenterPercent: value })}
      />
      <p class="hint">
        The marks at the sides of the stage are the reading band. Drag it until they
        sit over your camera lens — that is where your eyes rest, so it is where the
        lens should be.
      </p>
    {/if}
  </div>

  <footer class="foot">
    {#if rigResolved}
      <Button variant="primary" size="sm" onclick={oncancel}>Close</Button>
    {:else}
      <Button variant="ghost" size="sm" onclick={oncancel}>Cancel</Button>
      <Button variant="primary" size="sm" onclick={onok}>OK</Button>
    {/if}
  </footer>
</div>

<style>
  /*
   * A pane of dark glass, not a panel.
   *
   * It drops down from the corner over a running prompter, and on a narrow
   * screen — or a wide column — it WILL overlap the script. That is allowed:
   * what it may not do is hide what is going on behind it. So the fill is
   * translucent and dark, which lets the shape and motion of the text read
   * through while dropping white script type far enough below the panel's own
   * text to keep this readable. A solid slab would be a hole in the stage at
   * exactly the moment the operator is judging the stage.
   */
  .sheet {
    display: flex;
    flex-direction: column;
    /* Narrow on purpose: the reading band runs across the middle of the stage
       and the whole point is to watch it while dragging. */
    width: min(304px, calc(100vw - 32px));
    /*
     * Never taller than the screen it floats over, and the BODY is what
     * scrolls — the title stays readable and OK stays reachable without a
     * scroll, which on a panel somebody is operating mid-take is the
     * difference between a control and a hunt.
     */
    max-height: min(560px, calc(100vh - 96px));
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: var(--radius-md);
    background: rgba(9, 11, 15, 0.76);
    /* Saturation lifted a little so the terracotta on the controls survives the
       blur instead of going grey behind it. */
    backdrop-filter: blur(22px) saturate(140%);
    -webkit-backdrop-filter: blur(22px) saturate(140%);
    box-shadow: var(--shadow-pop);
    overflow: hidden;
  }

  /*
   * Where the glass cannot be made, the panel is simply darker.
   *
   * Without a blur behind it, 76% over moving white type is unreadable in both
   * directions — the panel's text and the script's compete. Opacity is the only
   * honest fallback: still translucent enough to see that something is there,
   * opaque enough to read.
   */
  @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
    .sheet {
      background: rgba(9, 11, 15, 0.94);
    }
  }

  .sheet-head {
    padding: var(--space-4) var(--space-4) var(--space-2);
  }
  .title {
    margin: 0;
    font-size: var(--text-md);
    font-weight: 600;
    color: var(--text-primary);
  }
  .sub {
    margin: 2px 0 0;
    font-size: var(--text-xs);
    color: var(--text-muted);
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-3) var(--space-4) var(--space-4);
    overflow-y: auto;
  }

  .readout {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-4);
    padding: 5px 0;
  }
  .row + .row {
    border-top: 1px solid rgba(255, 255, 255, 0.08);
  }
  .row dt {
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
  .row dd {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--text-primary);
  }

  .hint {
    margin: -6px 0 0;
    font-size: var(--text-xs);
    line-height: 1.45;
    color: var(--text-muted);
  }

  /*
   * A hairline, not a filled bar. A second surface colour on a pane of glass
   * reads as two panels stacked, and the whole thing is meant to be one sheet
   * held over the stage.
   */
  .foot {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border-top: 1px solid rgba(255, 255, 255, 0.1);
  }
</style>
