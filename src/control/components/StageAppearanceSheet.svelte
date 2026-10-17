<!--
  The in-session appearance inspector.

  ---------------------------------------------------------------------------
  WHY THIS EXISTS AT ALL
  ---------------------------------------------------------------------------
  Every control on it already existed on the Settings screen, where none of them
  can be judged. "Reading line" is aligned against a camera lens; "Text size" is
  answered by standing where you will stand and seeing whether you can read it;
  "Text intensity" is a question about a reflection in a piece of glass. All of
  them have exactly one correct place to be set — in front of the running
  prompter — and until now that was the one place they could not be reached.

  ---------------------------------------------------------------------------
  IT RISES FROM THE DOCK, AND THAT CHANGES ITS SIZE
  ---------------------------------------------------------------------------
  It used to drop from a menu in the top-right corner and was allowed to be
  560px tall. The Elgato Prompter it is judged on is 600px tall in total, so a
  panel that now rises from a control 16px off the BOTTOM edge would cover
  essentially the whole left half of the stage — including the reading band, the
  one part the operator opened the panel to look at.

  So it is 304 wide, capped just above 400 tall, and every row inside it earns
  its height. The long explanatory paragraphs are gone: they were written for a
  settings screen with room to teach, and this is a panel somebody is operating
  mid-take with a presenter waiting.

  ---------------------------------------------------------------------------
  WHAT IT PROMISES
  ---------------------------------------------------------------------------
  Every move is live: the stage behind re-renders as the slider moves, because a
  control you have to close a panel to evaluate is a control you evaluate twice.
  Done writes what is on the glass into the saved settings, so the next take
  opens on it. Cancel puts the take back exactly as it was found and saves
  nothing — which is why the caller hands in the appearance it opened with
  rather than this panel remembering it.

  It is `aria-modal` and traps Tab. It has no scrim: the whole point is that the
  stage stays visible and legible behind it, so it takes one corner of the
  screen and leaves the reading band alone. Modality without a scrim still owes
  the rest of the promise — the dock's other popover closes when this opens, so
  there is nothing live to reach past this panel.

  ---------------------------------------------------------------------------
  A RIG-RESOLVED TAKE GETS A READOUT, NOT CONTROLS
  ---------------------------------------------------------------------------
  Where a saved rig decided the appearance (§17.2), `buildStageSettings` works
  every one of these values out from a measured distance and never consults the
  loose ones — including text intensity, which a calibrated profile carries
  because it was chosen by somebody standing at that glass looking at that
  reflection. Sliders here would move and change nothing, and a Done button
  would write the RIG's numbers into the global defaults, quietly changing what
  every uncalibrated take opens with. So the panel says what the rig resolved,
  says where to change it, and offers nothing it cannot deliver.

  ---------------------------------------------------------------------------
  A READING WINDOW GETS ITS OWN CONTROLS
  ---------------------------------------------------------------------------
  A reading window always runs a profile too, and it used to get the readout
  above — "Calibrated", "worked out from how far away you stand" — over a window
  nobody had calibrated and nobody stands away from. Its text is the reading rig
  with the READER PREFERENCE laid over it, and that preference is what these
  controls set: size, line width, line spacing, intensity and cue, live, with
  Done saving them for every reading window. There is no reading line here,
  because a window has no lens to align it to, and no percentage width: the
  measure a reader feels is characters, and only the stage can count them.

  A reading window also chooses its FIELD — Dark or Paper — which a prompter
  never does (the prompter's black is the point of `stage.css`). On paper the
  panel is a sheet of warm paper rather than dark glass: it takes the
  workspace palette by carrying `data-theme="workspace"`, so every control in
  it is the light one, and a dark slab is not dropped onto a light page.
-->
<script lang="ts">
  import Button from './Button.svelte';
  import SegmentedControl from './SegmentedControl.svelte';
  import Slider from './Slider.svelte';
  import { FOCUSABLE_SELECTOR, nextTrapFocus } from './dialog-focus';
  import {
    APPEARANCE_LIMITS,
    READER_APPEARANCE_LIMITS,
    readerCharactersFor,
    readerLineWidthFor,
    stepReaderFontSize,
    type ReaderAppearance,
    type ReaderLineWidth,
    type StageAppearance,
  } from '../lib/stage-appearance';
  import type { ReaderPreferencePatch, ReaderTheme } from '../services/settings-types';
  import type { ReadingCueStyle, TextIntensity } from '../../shared/contracts';

  interface Props {
    /**
     * Whose controls these are: the prompter's, or a reading window's. A
     * reading window's text answers to the reader preference, not to the
     * fields `appearance` describes, so it gets a different panel rather than
     * a relabelled one. Absent means the prompter.
     */
    surface?: 'reader' | 'prompter';
    /** What the stage is prompting at right now. */
    appearance: StageAppearance;
    /**
     * What the reading window is showing right now — required for the reader
     * panel, which falls back to the prompter's without it rather than
     * offering controls with nothing behind them.
     */
    reader?: ReaderAppearance | null;
    /**
     * The reading window's field as it is drawn now: Dark or Paper. A reading
     * window only — the prompter panel offers no such control. Absent means
     * dark.
     */
    readerTheme?: ReaderTheme;
    /**
     * §17.2: a saved rig decided this take's appearance, so none of it is the
     * panel's to set. It reports and points at the wizard instead.
     */
    rigResolved: boolean;
    /**
     * The rig that resolved it was the automatic one — built from the panel at
     * Present, not calibrated by anybody — so the badge and the hint say so
     * rather than calling a table lookup "Calibrated".
     */
    automatic?: boolean;
    /**
     * The take's size ceiling, fixed when it opened.
     *
     * Handed in rather than derived here so it cannot move under the thumb: a
     * ceiling recomputed from the live value turns a drag downward into a
     * one-way ratchet, and the range the operator was offered when the panel
     * opened stops being the range they have.
     */
    maxFontSizePx: number;
    /**
     * What the stage MEASURED off the face it is drawing, or null before the
     * first line map.
     *
     * A percentage cannot produce consistent reading behaviour across a
     * 1024x600 Prompter, a 1080p Prompter XL and a Sidecar iPad — the same 78%
     * is a different measure on each. The character count is the number that
     * actually governs eye travel, and only the stage can know it: control
     * resolves geometry against DIN fallbacks because control does not render
     * the font. Shown beside the width control rather than instead of it,
     * because the operator is dragging a percentage and reading a consequence.
     */
    charactersPerLine?: number | null;
    /** Apply to the running take. Called on every move. */
    onchange: (patch: Partial<StageAppearance>) => void;
    /**
     * Apply to the running reading window. Called on every move; `null` puts a
     * field back to automatic (the Standard line width).
     */
    onreaderchange?: (patch: ReaderPreferencePatch) => void;
    /** Draw the running reading window in Dark or Paper. Called on every choice. */
    onreaderthemechange?: (theme: ReaderTheme) => void;
    /** Keep it: save to settings and close. */
    onok: () => void;
    /** Put the take back and close. */
    oncancel: () => void;
  }

  let {
    surface = 'prompter',
    appearance,
    reader = null,
    readerTheme = 'dark',
    rigResolved,
    automatic = false,
    maxFontSizePx,
    charactersPerLine = null,
    onchange,
    onreaderchange,
    onreaderthemechange,
    onok,
    oncancel,
  }: Props = $props();

  /** The reading window's panel is up — and has something to drive. */
  const readerView = $derived(surface === 'reader' ? reader : null);
  /** A reading window drawn on paper: the panel goes light with it. */
  const onPaper = $derived(readerView !== null && readerTheme === 'paper');

  const uid = $props.id();
  let panel: HTMLElement | null = $state(null);

  const INTENSITY_LABEL: Record<TextIntensity, string> = {
    soft: 'Soft',
    standard: 'Standard',
    strong: 'Strong',
  };

  /**
   * The step the minus/plus buttons take.
   *
   * Two pixels because that is the smallest change anybody can see through
   * glass at prompting distance, and because it matches the Cmd+= shortcut the
   * same value already has. Shift multiplies it, so an operator who is a long
   * way from the size they want is not clicking twenty times.
   */
  const SIZE_STEP_PX = 2;
  const SIZE_STEP_COARSE_PX = 10;

  function nudgeSize(direction: 1 | -1, event: MouseEvent | KeyboardEvent): void {
    const step = event.shiftKey ? SIZE_STEP_COARSE_PX : SIZE_STEP_PX;
    const next = Math.round(appearance.fontSizePx + direction * step);
    // Clamped here as well as by the caller: a disabled-looking button that
    // silently sends an out-of-range value is worse than one that stops.
    const clamped = Math.min(maxFontSizePx, Math.max(APPEARANCE_LIMITS.fontSizePx.min, next));
    if (clamped === Math.round(appearance.fontSizePx)) return;
    onchange({ fontSizePx: clamped });
  }

  const atMinSize = $derived(Math.round(appearance.fontSizePx) <= APPEARANCE_LIMITS.fontSizePx.min);
  const atMaxSize = $derived(Math.round(appearance.fontSizePx) >= Math.round(maxFontSizePx));

  /*
   * The reading window's nudges: the same two-pixel step and Shift multiplier,
   * so a window and a prompter answer the buttons the same way ⌘= does — over
   * the reader's own range rather than the prompter's.
   */
  const READER_SIZE = READER_APPEARANCE_LIMITS.fontSizePx;
  const READER_LINE_HEIGHT = READER_APPEARANCE_LIMITS.lineHeight;

  function nudgeReaderSize(direction: 1 | -1, event: MouseEvent | KeyboardEvent): void {
    if (!readerView) return;
    const step = event.shiftKey ? SIZE_STEP_COARSE_PX : SIZE_STEP_PX;
    const next = stepReaderFontSize(readerView.fontSizePx, direction * step);
    if (next === Math.round(readerView.fontSizePx)) return;
    onreaderchange?.({ fontSizePx: next });
  }

  const readerAtMinSize = $derived(
    readerView !== null && Math.round(readerView.fontSizePx) <= READER_SIZE.min,
  );
  const readerAtMaxSize = $derived(
    readerView !== null && Math.round(readerView.fontSizePx) >= READER_SIZE.max,
  );

  /**
   * Focus moves in on open and back to the opener on close, the same contract
   * Dialog.svelte keeps. Without the second half, closing the panel unmounts
   * the focused node and leaves focus on `<body>` — which on a full-screen
   * stage means the next Tab starts from the top of a page nobody can see, and
   * the dock button that opened this is no longer where the keyboard is.
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
   * Dialog.svelte states: clicking the panel's own prose drops focus on
   * `<body>`, and a panel-scoped handler then never sees the key again.
   *
   * Escape here means "cancel", not "end the take". The stage stands its own
   * key handling down while this is open (`chromeOpen`), so this is the only
   * thing answering — a presenter who opens the panel mid-take and hits Escape
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
  data-theme={onPaper ? 'workspace' : undefined}
  bind:this={panel}
>
  <header class="sheet-head">
    <h2 class="title" id="{uid}-title">
      {readerView ? 'Reading appearance' : 'Prompter appearance'}
    </h2>
    <!-- No badge for a reading window. "Calibrated" and "Automatic" describe
         who sized a prompter; a window's size is the reader's own. -->
    {#if !readerView && rigResolved}
      <!-- A badge rather than a sentence. "This display runs from a saved rig"
           was doing two jobs — naming the state and explaining it — and the
           explanation belongs with the values it applies to, below. -->
      <span class="badge">{automatic ? 'Automatic' : 'Calibrated'}</span>
    {/if}
  </header>

  <div class="body">
    {#if readerView}
      <!-- Size first, with buttons, for the reason the prompter panel gives:
           it is the one that gets changed, and the one changed by two pixels. -->
      <div class="size-row">
        <Slider
          label="Text size"
          value={readerView.fontSizePx}
          min={READER_SIZE.min}
          max={READER_SIZE.max}
          step={READER_SIZE.step}
          format={(v) => `${v} px`}
          onchange={(value) => onreaderchange?.({ fontSizePx: value })}
        />
        <div class="nudge">
          <button
            type="button"
            data-focus="control"
            aria-label="Smaller text"
            title="Smaller text (hold Shift for a bigger step)"
            disabled={readerAtMinSize}
            onclick={(event) => nudgeReaderSize(-1, event)}>−</button
          >
          <button
            type="button"
            data-focus="control"
            aria-label="Larger text"
            title="Larger text (hold Shift for a bigger step)"
            disabled={readerAtMaxSize}
            onclick={(event) => nudgeReaderSize(1, event)}>+</button
          >
        </div>
      </div>

      <!--
        Three widths, not a percentage. What a reader feels is characters per
        line, so the choice is a measure and the readout is the stage's own
        count of what fits — the window may be narrower than the line asked for,
        and saying "Wider" over a line that cannot widen would be the readout
        lying.
      -->
      <div class="field">
        <div class="field-head">
          <span class="field-label" aria-hidden="true">Line width</span>
          {#if charactersPerLine}
            <span class="field-value">About {charactersPerLine} characters a line</span>
          {/if}
        </div>
        <SegmentedControl
          label="Line width"
          size="sm"
          value={readerLineWidthFor(readerView.characters)}
          options={[
            { value: 'narrower', label: 'Narrower' },
            { value: 'standard', label: 'Standard' },
            { value: 'wider', label: 'Wider' },
          ]}
          onchange={(value) =>
            onreaderchange?.({ characters: readerCharactersFor(value as ReaderLineWidth) })}
        />
      </div>

      <Slider
        label="Line spacing"
        value={readerView.lineHeight}
        min={READER_LINE_HEIGHT.min}
        max={READER_LINE_HEIGHT.max}
        step={READER_LINE_HEIGHT.step}
        format={(v) => v.toFixed(2)}
        onchange={(value) => onreaderchange?.({ lineHeight: value })}
      />

      <!--
        The field itself, beside the one control that changes the ink on it.
        Neither is offered as the healthier choice: rooms, displays and eyes
        differ, and the reader is the one who can tell.
      -->
      <div class="field">
        <span class="field-label" aria-hidden="true">Appearance</span>
        <SegmentedControl
          label="Appearance"
          size="sm"
          value={readerTheme}
          options={[
            { value: 'dark', label: 'Dark' },
            { value: 'paper', label: 'Paper' },
          ]}
          onchange={(value) => onreaderthemechange?.(value === 'paper' ? 'paper' : 'dark')}
        />
      </div>

      <div class="field">
        <span class="field-label" aria-hidden="true">Intensity</span>
        <SegmentedControl
          label="Intensity"
          size="sm"
          value={readerView.textIntensity}
          options={[
            { value: 'soft', label: 'Soft' },
            { value: 'standard', label: 'Standard' },
            { value: 'strong', label: 'Strong' },
          ]}
          onchange={(value) => onreaderchange?.({ intensity: value as TextIntensity })}
        />
      </div>

      <div class="field">
        <span class="field-label" aria-hidden="true">Reading cue</span>
        <SegmentedControl
          label="Reading cue"
          size="sm"
          value={readerView.readingCue}
          options={[
            { value: 'ticks', label: 'Ticks' },
            { value: 'wash', label: 'Wash' },
            { value: 'none', label: 'None' },
          ]}
          onchange={(value) => onreaderchange?.({ readingCue: value as ReadingCueStyle })}
        />
      </div>
      <p class="hint">Done saves these for every reading window.</p>
    {:else if rigResolved}
      <!--
        A readout, not four disabled tracks. A range input pinned at a value it
        cannot reach — a rig may resolve a line height of 2.0, past the top of
        the slider — shows a thumb that disagrees with its own number, which is
        a worse answer than plain text.
      -->
      <dl class="readout">
        <div class="row">
          <dt>Text size</dt>
          <dd>{Math.round(appearance.fontSizePx)} px</dd>
        </div>
        <div class="row">
          <dt>Text width</dt>
          <dd>
            {Math.round(appearance.columnWidthPercent)}%{charactersPerLine
              ? ` · ${charactersPerLine} chars`
              : ''}
          </dd>
        </div>
        <div class="row">
          <dt>Reading line</dt>
          <dd>{Math.round(appearance.readingBandCenterPercent)}%</dd>
        </div>
        <div class="row">
          <dt>Line spacing</dt>
          <dd>{appearance.lineHeight.toFixed(2)}</dd>
        </div>
        <div class="row">
          <dt>Intensity</dt>
          <dd>{INTENSITY_LABEL[appearance.textIntensity]}</dd>
        </div>
      </dl>
      <p class="hint">
        {#if automatic}
          Sized automatically for this display and a typical viewing distance. Trade size against
          how much of a line fits with the size slider under
          <strong>Settings → Prompter display and rigs</strong>; calibrating a rig there is what
          replaces the assumed distance with a measured one.
        {:else}
          Worked out from how far away you stand. Change them under
          <strong>Settings → Prompter display and rigs</strong>.
        {/if}
      </p>
    {:else}
      <!--
        ORDERED BY HOW OFTEN IT IS TOUCHED.
        The panel used to open on text intensity, which is a decision somebody
        makes once per room. Size is the one that gets changed, so it is first
        and it is the only control with buttons as well as a track — a
        two-pixel nudge is not a drag anybody can make accurately.
      -->
      <div class="size-row">
        <Slider
          label="Text size"
          value={appearance.fontSizePx}
          min={APPEARANCE_LIMITS.fontSizePx.min}
          max={maxFontSizePx}
          step={APPEARANCE_LIMITS.fontSizePx.step}
          format={(v) => `${v} px`}
          onchange={(value) => onchange({ fontSizePx: value })}
        />
        <div class="nudge">
          <button
            type="button"
            data-focus="control"
            aria-label="Smaller text"
            title="Smaller text (hold Shift for a bigger step)"
            disabled={atMinSize}
            onclick={(event) => nudgeSize(-1, event)}>−</button
          >
          <button
            type="button"
            data-focus="control"
            aria-label="Larger text"
            title="Larger text (hold Shift for a bigger step)"
            disabled={atMaxSize}
            onclick={(event) => nudgeSize(1, event)}>+</button
          >
        </div>
      </div>

      <Slider
        label="Text width"
        value={appearance.columnWidthPercent}
        min={APPEARANCE_LIMITS.columnWidthPercent.min}
        max={APPEARANCE_LIMITS.columnWidthPercent.max}
        format={(v) => `${v}%${charactersPerLine ? ` · ${charactersPerLine} chars` : ''}`}
        onchange={(value) => onchange({ columnWidthPercent: value })}
      />

      <Slider
        label="Reading line"
        value={appearance.readingBandCenterPercent}
        min={APPEARANCE_LIMITS.readingBandCenterPercent.min}
        max={APPEARANCE_LIMITS.readingBandCenterPercent.max}
        format={(v) => `${v}%`}
        onchange={(value) => onchange({ readingBandCenterPercent: value })}
      />
      <!-- One sentence. The three-line version of this was the tallest thing
           in the panel and said the same thing. -->
      <p class="hint">Align the side markers with the camera lens.</p>

      <Slider
        label="Line spacing"
        value={appearance.lineHeight}
        min={APPEARANCE_LIMITS.lineHeight.min}
        max={APPEARANCE_LIMITS.lineHeight.max}
        step={APPEARANCE_LIMITS.lineHeight.step}
        format={(v) => v.toFixed(2)}
        onchange={(value) => onchange({ lineHeight: value })}
      />

      <SegmentedControl
        label="Intensity"
        size="sm"
        value={appearance.textIntensity}
        options={[
          { value: 'soft', label: 'Soft' },
          { value: 'standard', label: 'Standard' },
          { value: 'strong', label: 'Strong' },
        ]}
        onchange={(value) => onchange({ textIntensity: value as TextIntensity })}
      />
    {/if}
  </div>

  <footer class="foot">
    {#if !readerView && rigResolved}
      <Button variant="primary" size="sm" onclick={oncancel}>Close</Button>
    {:else}
      <Button variant="ghost" size="sm" onclick={oncancel}>Cancel</Button>
      <Button variant="primary" size="sm" onclick={onok}>Done</Button>
    {/if}
  </footer>
</div>

<style>
  /*
   * A pane of dark glass, not a panel.
   *
   * It rises from the dock over a running prompter and WILL overlap the script.
   * That is allowed: what it may not do is hide what is going on behind it. So
   * the fill is translucent and dark, which lets the shape and motion of the
   * text read through while dropping white script type far enough below the
   * panel's own text to keep this readable. A solid slab would be a hole in the
   * stage at exactly the moment the operator is judging the stage.
   *
   * It is a little MORE opaque than the dock beneath it (0.74). Sliders and
   * numbers need stronger separation than a waveform does, and the rule the
   * whole surface follows is one sheet of glass at a time — never glass inside
   * glass, which is why no row here has a translucent card of its own.
   */
  .sheet {
    display: flex;
    flex-direction: column;
    /* Narrow on purpose: the reading band runs across the middle of the stage
       and the whole point is to watch it while dragging. */
    width: min(304px, calc(100vw - 32px));
    /*
     * 412, not 560. This rises from a control 16px off the bottom of a panel
     * that may be only 600px tall; see the note at the top of the file.
     *
     * The number is what the five controls plus their one hint actually measure
     * at this width, measured at 1024x600 rather than guessed: at 360 the
     * intensity control fell below the fold, and a control nobody can see
     * without discovering that a panel scrolls is a control that is not there.
     * The BODY still scrolls if a longer rig readout needs it, so the title
     * stays readable and Done stays reachable either way.
     */
    /*
     * `--stage-popover-max-height` is published by the stage from the rig's
     * SAFE rectangle, not from the window: a hood crops the panel, and a sheet
     * sized against the viewport rises straight off the top of the visible area
     * where `.stage-root`'s `overflow: hidden` takes its title and its Done
     * button with it. It inherits down to here through the dock. The viewport
     * fallback is what a plain panel — and the Settings screen — gets.
     */
    max-height: min(412px, var(--stage-popover-max-height, calc(100vh - 96px)));
    border: 1px solid var(--stage-chrome-border, rgba(255, 255, 255, 0.13));
    border-radius: var(--stage-chrome-radius, 12px);
    background: rgba(9, 11, 15, 0.88);
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
   * Without a blur behind it, translucency over moving white type is unreadable
   * in both directions — the panel's text and the script's compete. Opacity is
   * the only honest fallback: still translucent enough to see that something is
   * there, opaque enough to read.
   */
  @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
    .sheet {
      background: rgba(9, 11, 15, 0.96);
    }
    .sheet[data-theme='workspace'] {
      background: rgba(252, 250, 246, 0.98);
    }
  }

  /*
   * On paper: a sheet of warm paper, not a pane of dark glass.
   *
   * `data-theme="workspace"` hands everything inside the light palette — the
   * title, the labels, the sliders and segmented controls. What is left here is
   * the panel's own surfaces, which were written as white-on-dark literals and
   * would otherwise draw white hairlines on a light sheet. Translucent for the
   * reason the glass is (the read behind it stays visible), and lifted a shade
   * above the paper field so it reads as a sheet laid over the page, with the
   * stage's quiet chrome border, rather than as a hole in it.
   */
  .sheet[data-theme='workspace'] {
    background: rgba(252, 250, 246, 0.9);
  }
  .sheet[data-theme='workspace'] .nudge button {
    border-color: var(--border-control);
    background: var(--bg-elevated);
  }
  .sheet[data-theme='workspace'] .nudge button:hover:not(:disabled) {
    background: var(--bg-hover-surface);
  }
  .sheet[data-theme='workspace'] .foot {
    border-top-color: var(--divider);
  }

  .sheet-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4) var(--space-2);
  }
  .title {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 650;
    color: var(--text-primary);
  }
  .badge {
    flex: 0 0 auto;
    padding: 2px 7px;
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 999px;
    font-size: var(--text-meta);
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-secondary);
  }

  .body {
    display: flex;
    flex-direction: column;
    /* Tighter than the studio rhythm, deliberately: this is six rows on a panel
       that has to clear a 600px display and still leave the reading band in
       view behind it. */
    gap: 10px;
    padding: var(--space-2) var(--space-4) var(--space-3);
    overflow-y: auto;
  }

  /*
   * The size row: a track plus two buttons that step it.
   *
   * The slider alone cannot be operated accurately at two pixels a step — the
   * whole range is 24 to 320 in a 200px-wide panel — and two pixels is exactly
   * the size of adjustment somebody makes when they are nearly right.
   */
  .size-row {
    display: flex;
    align-items: flex-end;
    gap: var(--space-2);
  }
  .size-row :global(.slider) {
    flex: 1 1 auto;
  }
  .nudge {
    flex: 0 0 auto;
    display: flex;
    gap: 4px;
    padding-bottom: 2px;
  }
  .nudge button {
    width: 24px;
    height: 24px;
    padding: 0;
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 7px;
    background: rgba(255, 255, 255, 0.06);
    color: var(--text-secondary);
    font: inherit;
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
  }
  .nudge button:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.14);
    color: var(--text-primary);
  }
  .nudge button:disabled {
    opacity: 0.4;
    cursor: default;
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

  /*
   * A labelled segmented row. The control names itself to assistive tech
   * (`aria-label` on the group), so the visible label is hidden from it rather
   * than read twice; it is styled as the sliders' own label so the column of
   * controls reads as one list.
   */
  .field {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
  }
  .field-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    align-self: stretch;
  }
  /* A setting's name, like the shared Slider's beside it. */
  .field-label {
    font-size: var(--text-label);
    line-height: var(--lh-label);
    font-weight: 500;
    color: var(--text-primary);
  }
  .field-value {
    font-size: var(--text-meta);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .hint {
    margin: -4px 0 0;
    font-size: var(--text-meta);
    line-height: 1.4;
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
    padding: var(--space-2) var(--space-4) var(--space-3);
    border-top: 1px solid rgba(255, 255, 255, 0.1);
  }
</style>
