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

  So it is 304 wide, capped just over 430 tall, and every row inside it earns
  its height. The long explanatory paragraphs are gone: they were written for a
  settings screen with room to teach, and this is a panel somebody is operating
  mid-take with a presenter waiting.

  ---------------------------------------------------------------------------
  WHAT IT PROMISES
  ---------------------------------------------------------------------------
  Every move is live: the stage behind re-renders as the slider moves, because a
  control you have to close a panel to evaluate is a control you evaluate twice.
  While a slider is held the glass clears, leaving only that row, so the edges
  and markers it covers can be judged too. Done writes what is on the glass into
  the saved settings, so the next take opens on it, and the footer says where.
  Cancel puts the take back exactly as it was found and saves nothing — which is
  why the caller hands in the appearance it opened with rather than this panel
  remembering it.

  Only Cancel, Escape and Done end it. A click away is not a decision either
  way: closing on it used to put back a minute of tuning the operator had only
  clicked away to look at, and keeping on it would save an experiment into
  every later take. So the dock answers that click by lighting this panel's
  edge, and it stays until somebody says which.

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

  With one exception, which the automatic profile has and a calibrated rig does
  not: its size balance. That is the operator's preference rather than a
  measurement, it is what trades size against how much of a line fits, and it
  DOES recompose the glass. So an automatic take gets that one slider above the
  readout — the readout then being its live consequence — with Cancel and a
  Done that saves the balance and nothing else.

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
  panel is a sheet of warm paper rather than dark glass: it takes the frozen
  paper palette by carrying `data-theme="paper"`, so every control in it is
  the light one, and a dark slab is not dropped onto a light page. Not the
  desk's `workspace` palette: this is a presentation surface, and it must not
  change when the desk is retuned.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import Button from './Button.svelte';
  import Icon from './Icon.svelte';
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
     * The take is a reading window, whichever controls it gets.
     *
     * Usually the same thing as `surface="reader"`, but not always: a reading
     * window with no display to measure runs from the flat fields and gets the
     * prompter's controls, because those are the ones that reach its glass. It
     * is still a window on a desk, so it is not called a prompter and nothing in
     * it mentions a camera lens.
     */
    readingWindow?: boolean;
    /**
     * The automatic profile's size balance as the take is running it, 0 to 1 —
     * or null when the take is not sized automatically.
     *
     * The one thing about an automatic take that is the operator's to choose:
     * every other value there is worked out from the panel, and this is what
     * trades size against how much of a line fits. Settings has the same slider
     * with the same ends.
     */
    sizeBias?: number | null;
    /** Apply a size balance to the running take. Called on every move. */
    onsizebiaschange?: (bias: number) => void;
    /** The calibrated rig this take is running, by the name it was saved under. */
    rigName?: string | null;
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
    readingWindow = false,
    sizeBias = null,
    onsizebiaschange,
    rigName = null,
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
  /** Named for the window it is in, not for which controls it happens to get. */
  const inReadingWindow = $derived(readerView !== null || readingWindow);
  /**
   * An automatically sized prompter: a readout of what the panel resolved, with
   * the size balance above it as the one live control — and so a Cancel and a
   * Done, where a calibrated rig's readout has only Close.
   */
  const balancing = $derived(
    readerView === null && rigResolved && automatic && typeof sizeBias === 'number',
  );
  /** A calibrated rig's readout: values to read, nothing to set. */
  const readoutOnly = $derived(readerView === null && rigResolved && !balancing);

  /*
   * What Done keeps, said beside Done.
   *
   * Cancel and Done both look final, and only one of them reaches past this
   * take. Without the sentence, nothing on the prompter's panel said Done
   * rewrites the defaults every later take opens with — and on a reading window
   * it was there, but below the fold of an inner scroller.
   */
  const scope = $derived(
    readerView
      ? 'Done saves these for every reading window.'
      : balancing
        ? 'Done saves this for every automatic display.'
        : 'Done saves these as your prompter defaults.',
  );

  const uid = $props.id();
  let panel: HTMLElement | null = $state(null);
  let body: HTMLElement | null = $state(null);

  const INTENSITY_LABEL: Record<TextIntensity, string> = {
    soft: 'Soft',
    standard: 'Standard',
    strong: 'Strong',
  };

  /** "1.38" is a ratio on screen and a bare number out loud. */
  const spacingSpoken = (v: number): string => `${v.toFixed(2)} times the text size`;

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
    // The first CONTROL, not the header's eye: that is a look, and the panel
    // was opened to change something. A readout has no control, so its Close.
    const target =
      panel.querySelector<HTMLElement>('[data-autofocus]') ??
      untrack(() => body)?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ??
      panel.querySelector('.foot')?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ??
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

  /*
   * WHILE A SLIDER IS HELD, THE PANEL GETS OUT OF THE WAY.
   *
   * On a 1024x600 prompter this panel covers the left reading-line marker, the
   * column's left edge and the start of the line being read — the very things
   * the width, reading-line and size sliders are judged against. No height cap
   * fixes that across the whole range of either, so for the length of a drag
   * the glass goes clear and every row but the one under the pointer fades,
   * leaving that row on a strip of its own. Nothing moves: the rows keep their
   * boxes, so the track stays exactly under the thumb.
   *
   * Pointer only. A keyboard nudge is one step at a time and the panel coming
   * and going on every arrow press would be worse than the occlusion.
   */
  let peeking = $state(false);

  function onBodyPointerDown(event: PointerEvent): void {
    const target = event.target;
    if (event.button !== 0 || !(target instanceof HTMLInputElement) || target.type !== 'range') {
      return;
    }
    const row = body ? [...body.children].find((child) => child.contains(target)) : undefined;
    if (!row) return;
    row.setAttribute('data-peek', '');
    peeking = true;
    const release = (): void => {
      row.removeAttribute('data-peek');
      peeking = false;
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', release, true);
      window.removeEventListener('blur', release);
    };
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
    window.addEventListener('blur', release);
  }

  /*
   * AND WHENEVER SOMEBODY ASKS, ALL OF IT DOES.
   *
   * The held row still covers a strip of the stage, and a stepper, a segmented
   * choice or an arrow-key nudge has no drag to hang a reveal on — so the eye in
   * the header clears the whole panel for as long as it is held, by pointer or
   * by Space/Return, and puts it back on release. Nothing is applied, kept or
   * reverted by it. The eye itself stays, so the person holding it can see
   * where the panel will come back.
   */
  let revealing = $state(false);

  /**
   * Clear the panel until `released` fires on the window, or the window loses
   * focus — a release that happens in another app must still bring it back.
   */
  function holdReveal(released: Array<[string, (event: Event) => boolean]>): void {
    revealing = true;
    const listeners = released.map(([type, matches]) => {
      const listener = (event: Event): void => {
        if (matches(event)) end();
      };
      return [type, listener] as const;
    });
    function end(): void {
      revealing = false;
      for (const [type, listener] of listeners) window.removeEventListener(type, listener, true);
      window.removeEventListener('blur', end);
    }
    for (const [type, listener] of listeners) window.addEventListener(type, listener, true);
    window.addEventListener('blur', end);
  }

  function onRevealPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    // Focus stays where it was: this is a look, not a move.
    event.preventDefault();
    holdReveal([
      ['pointerup', () => true],
      ['pointercancel', () => true],
    ]);
  }

  function onRevealKeydown(event: KeyboardEvent): void {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    if (event.repeat || revealing) return;
    // Only the key that is holding it. Shift going up under a held Space is
    // not a release.
    const key = event.key;
    holdReveal([['keyup', (up) => (up as KeyboardEvent).key === key]]);
  }

  /*
   * Say when the body scrolls, at the edge it scrolls past.
   *
   * The body scrolls whenever the room above the dock is shorter than the
   * controls — the smallest reading window, a hooded rig — and a clean footer
   * under a cut-off list reads as a complete form. The fades follow the actual
   * overflow, so a panel that fits shows none.
   */
  let moreAbove = $state(false);
  let moreBelow = $state(false);

  function measureOverflow(): void {
    if (!body) return;
    moreAbove = body.scrollTop > 1;
    moreBelow = body.scrollTop + body.clientHeight < body.scrollHeight - 1;
  }

  /*
   * A fade says "this goes on" quietly enough to be read as a dimmed control.
   * In the smallest windows three whole controls can sit below it, so the edge
   * also gets something to press.
   */
  function showMore(event: MouseEvent): void {
    if (!body) return;
    const cue = event.currentTarget as HTMLElement;
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    /*
     * The cue hides itself once nothing is left below, and a focused element
     * that hides drops the keyboard on `<body>`. So when it holds focus, focus
     * goes ahead of the scroll to the first control it was hiding.
     */
    if (document.activeElement === cue) {
      const fold = body.getBoundingClientRect().bottom;
      const next = [...body.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].find(
        (control) => control.getBoundingClientRect().top >= fold - 1,
      );
      next?.focus({ preventScroll: true });
    }
    body.scrollBy({ top: body.clientHeight * 0.75, behavior: still ? 'auto' : 'smooth' });
  }

  $effect(() => {
    if (!body) return undefined;
    measureOverflow();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measureOverflow);
    observer.observe(body);
    for (const child of body.children) observer.observe(child);
    return () => observer.disconnect();
  });
</script>

<div
  class="sheet"
  role="dialog"
  tabindex="-1"
  aria-modal="true"
  aria-labelledby="{uid}-title"
  data-theme={onPaper ? 'paper' : undefined}
  data-window={inReadingWindow ? 'reading' : 'prompter'}
  data-peeking={peeking ? '' : undefined}
  data-revealing={revealing ? '' : undefined}
  bind:this={panel}
>
  <header class="sheet-head">
    <h2 class="title" id="{uid}-title">
      {inReadingWindow ? 'Reading appearance' : 'Prompter appearance'}
    </h2>
    <!-- No badge for a reading window. "Calibrated" and "Automatic" describe
         who sized a prompter; a window's size is the reader's own. -->
    {#if !readerView && rigResolved}
      <!-- A badge rather than a sentence. "This display runs from a saved rig"
           was doing two jobs — naming the state and explaining it — and the
           explanation belongs with the values it applies to, below. A quiet
           tag, not an outlined capsule in capitals: that read as a button. -->
      <span class="badge">{automatic ? 'Automatic' : 'Calibrated'}</span>
    {/if}
    <!-- Last in the header in every branch, so it is always in the same place. -->
    <button
      type="button"
      class="reveal"
      data-focus="control"
      aria-label="Hold to see the whole stage"
      title="Hold to see the whole stage"
      aria-pressed={revealing}
      onpointerdown={onRevealPointerDown}
      onkeydown={onRevealKeydown}
    >
      <Icon name="eye" size={15} />
    </button>
  </header>

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="body"
    bind:this={body}
    data-more-above={moreAbove ? '' : undefined}
    data-more-below={moreBelow ? '' : undefined}
    onscroll={measureOverflow}
    onpointerdown={onBodyPointerDown}
  >
    {#if readerView}
      <!-- Size first, with buttons, for the reason the prompter panel gives:
           it is the one that gets changed, and the one changed by two pixels. -->
      <Slider
        label="Text size"
        value={readerView.fontSizePx}
        min={READER_SIZE.min}
        max={READER_SIZE.max}
        step={READER_SIZE.step}
        format={(v) => `${v} px`}
        onchange={(value) => onreaderchange?.({ fontSizePx: value })}
      >
        {#snippet trailing()}
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
        {/snippet}
      </Slider>

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
            <span class="field-value" id="{uid}-measure">About {charactersPerLine} characters a line</span>
          {/if}
        </div>
        <SegmentedControl
          label="Line width"
          describedby={charactersPerLine ? `${uid}-measure` : undefined}
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
        spoken={spacingSpoken}
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
    {:else if rigResolved}
      {#if balancing}
        <!--
          The one control an automatic take answers to. Settings' own slider,
          ends and all, so the two read as the same setting: the operator who
          finds it here and later in Settings is moving one thing, not two.
        -->
        <Slider
          label="Size balance"
          minLabel="More text on screen"
          maxLabel="Larger, easier text"
          value={Math.round((sizeBias ?? 0) * 100)}
          min={0}
          max={100}
          format={(v) => `${v}%`}
          spoken={(v) => `${v}% toward larger text`}
          onchange={(value) => onsizebiaschange?.(value / 100)}
        />
      {/if}
      <!--
        A readout, not four disabled tracks. A range input pinned at a value it
        cannot reach — a rig may resolve a line height of 2.0, past the top of
        the slider — shows a thumb that disagrees with its own number, which is
        a worse answer than plain text. Under the size balance it is also the
        live consequence of that slider: these are the numbers it moves.
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
          <dt>Line spacing</dt>
          <dd>{appearance.lineHeight.toFixed(2)}</dd>
        </div>
        <div class="row">
          <dt>Reading line</dt>
          <dd>{Math.round(appearance.readingBandCenterPercent)}% from top</dd>
        </div>
        <div class="row">
          <dt>Intensity</dt>
          <dd>{INTENSITY_LABEL[appearance.textIntensity]}</dd>
        </div>
      </dl>
      <p class="hint">
        {#if automatic}
          Assumes a typical viewing distance. Calibrate a rig under
          <strong>Settings → Prompter display and rigs</strong> to measure yours.
        {:else}
          Measured for {rigName ? `“${rigName}”` : 'your calibrated rig'}. Change it under
          <strong>Settings → Prompter display and rigs</strong>.
        {/if}
      </p>
    {:else}
      <!--
        ORDERED BY HOW OFTEN IT IS TOUCHED, AND IN THE READING WINDOW'S ORDER.
        The panel used to open on text intensity, which is a decision somebody
        makes once per room. Size is the one that gets changed, so it is first
        and it is the only control with buttons as well as a track — a
        two-pixel nudge is not a drag anybody can make accurately. Size, width
        and spacing are the shape of the type and come in the same order as a
        reading window's, so moving between the two modes finds them where they
        were; the reading line, which only a prompter has, follows them.
      -->
      <Slider
        label="Text size"
        value={appearance.fontSizePx}
        min={APPEARANCE_LIMITS.fontSizePx.min}
        max={maxFontSizePx}
        step={APPEARANCE_LIMITS.fontSizePx.step}
        format={(v) => `${v} px`}
        onchange={(value) => onchange({ fontSizePx: value })}
      >
        {#snippet trailing()}
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
        {/snippet}
      </Slider>

      <Slider
        label="Text width"
        value={appearance.columnWidthPercent}
        min={APPEARANCE_LIMITS.columnWidthPercent.min}
        max={APPEARANCE_LIMITS.columnWidthPercent.max}
        format={(v) => `${v}%${charactersPerLine ? ` · ${charactersPerLine} chars` : ''}`}
        spoken={(v) =>
          `${v}% of the width${charactersPerLine ? `, about ${charactersPerLine} characters a line` : ''}`}
        onchange={(value) => onchange({ columnWidthPercent: value })}
      />

      <Slider
        label="Line spacing"
        value={appearance.lineHeight}
        min={APPEARANCE_LIMITS.lineHeight.min}
        max={APPEARANCE_LIMITS.lineHeight.max}
        step={APPEARANCE_LIMITS.lineHeight.step}
        format={(v) => v.toFixed(2)}
        spoken={spacingSpoken}
        onchange={(value) => onchange({ lineHeight: value })}
      />

      <!-- One sentence, read with the slider. A reading window has no lens, so
           there it has nothing to say. -->
      <Slider
        label="Reading line"
        value={appearance.readingBandCenterPercent}
        min={APPEARANCE_LIMITS.readingBandCenterPercent.min}
        max={APPEARANCE_LIMITS.readingBandCenterPercent.max}
        format={(v) => `${v}% from top`}
        description={inReadingWindow ? undefined : 'Align the arrows with the camera lens.'}
        onchange={(value) => onchange({ readingBandCenterPercent: value })}
      />

      <div class="field">
        <span class="field-label" aria-hidden="true">Intensity</span>
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
      </div>
    {/if}
  </div>

  <!-- A row of its own whenever the body scrolls at all, so the cue never sits
       on a control and the panel does not jump when it comes and goes; shown
       only while there is more below. -->
  {#if moreAbove || moreBelow}
    <div class="more-row">
      <button
        type="button"
        class="more"
        data-focus="control"
        hidden={!moreBelow}
        onclick={showMore}
      >
        More below <Icon name="chevron-down" size={12} />
      </button>
    </div>
  {/if}

  <footer class="foot">
    {#if readoutOnly}
      <Button variant="primary" size="sm" onclick={oncancel}>Close</Button>
    {:else}
      <p class="scope" id="{uid}-scope">{scope}</p>
      <Button variant="ghost" size="sm" onclick={oncancel}>Cancel</Button>
      <Button variant="primary" size="sm" describedby="{uid}-scope" onclick={onok}>Done</Button>
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
    position: relative;
    display: flex;
    flex-direction: column;
    /* Narrow on purpose: the reading band runs across the middle of the stage
       and the whole point is to watch it while dragging. */
    width: min(304px, calc(100vw - 32px));
    /*
     * 432, not 560. This rises from a control 16px off the bottom of a panel
     * that may be only 600px tall; see the note at the top of the file.
     *
     * The number is what the tallest prompter branch actually measures at this
     * width, measured at 1024x600 rather than guessed: the automatic readout,
     * with its size balance above it. At 360 the intensity control fell below
     * the fold, and a control nobody can see without discovering that a panel
     * scrolls is a control that is not there. The shorter branches are sized by
     * their content and never reach it. The BODY still scrolls when a hooded
     * rig leaves less room, so the title stays readable and Done stays
     * reachable either way, and its fades say so.
     *
     * A PROMPTER's number only. A reading window is on a desk monitor, never on
     * the Elgato, and holding its six controls to the prompter's cap put Reading
     * cue below a fold nobody could see — so it takes the room there is.
     */
    /*
     * `--stage-popover-max-height` is published by the stage from the rig's
     * SAFE rectangle, not from the window: a hood crops the panel, and a sheet
     * sized against the viewport rises straight off the top of the visible area
     * where `.stage-root`'s `overflow: hidden` takes its title and its Done
     * button with it. It inherits down to here through the dock. The viewport
     * fallback is what a plain panel — and the Settings screen — gets.
     */
    max-height: min(432px, var(--stage-popover-max-height, calc(100vh - 96px)));
    /* The glass — the palette's thick weight, which IS this sheet's tuned
       near-black (tokens.css) — and the strip a held row keeps while the rest
       of it clears. */
    --sheet-fill: var(--glass-fill-thick);
    --sheet-strip: rgba(9, 11, 15, 0.94);
    --sheet-edge-called: rgba(255, 255, 255, 0.5);
    border: 1px solid var(--stage-chrome-border, rgba(255, 255, 255, 0.13));
    border-radius: var(--stage-chrome-radius, 12px);
    background: var(--sheet-fill);
    backdrop-filter: var(--glass-backdrop-thick);
    -webkit-backdrop-filter: var(--glass-backdrop-thick);
    box-shadow: var(--shadow-pop);
    overflow: hidden;
    transition:
      background-color var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out),
      box-shadow var(--dur-fast) var(--ease-out);
  }
  .sheet[data-window='reading'] {
    max-height: var(--stage-popover-max-height, calc(100vh - 96px));
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
      --sheet-fill: rgba(9, 11, 15, 0.96);
    }
    .sheet[data-theme='paper'] {
      --sheet-fill: rgba(252, 250, 246, 0.98);
    }
  }

  /*
   * Held: the glass clears and only the row under the pointer stays, on a strip
   * of its own — see `onBodyPointerDown`. Opacity only, so nothing reflows and
   * the track does not move under the thumb. Still one pane at a time: the
   * strip is the only surface left on screen while it shows.
   */
  .sheet[data-peeking] {
    background-color: transparent;
    border-color: transparent;
    box-shadow: none;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
  .sheet-head,
  .foot,
  .body > :global(*) {
    transition: opacity var(--dur-fast) var(--ease-out);
  }
  .sheet[data-peeking] .sheet-head,
  .sheet[data-peeking] .more-row,
  .sheet[data-peeking] .foot,
  .sheet[data-peeking] .body > :global(:not([data-peek])) {
    opacity: 0;
  }
  .sheet[data-peeking] .body {
    mask-image: none;
    -webkit-mask-image: none;
  }
  /*
   * The strip runs the full inner width of the panel — the edge the dock and
   * the panel share — and carries its own blur, so the line it sits on is a
   * smear behind it rather than words competing with the label.
   */
  .body > :global([data-peek]) {
    position: relative;
    /* Its own stacking context, so the strip below sits behind this row's
       controls and in front of everything else, the stage included. */
    isolation: isolate;
  }
  .body > :global([data-peek])::before {
    content: '';
    position: absolute;
    inset: -8px calc(-1 * var(--space-4));
    z-index: -1;
    border-radius: var(--stage-chrome-radius, 12px);
    background: var(--sheet-strip);
    backdrop-filter: var(--glass-backdrop-thick);
    -webkit-backdrop-filter: var(--glass-backdrop-thick);
  }

  /* Held eye: the whole panel clears, the eye stays. */
  .sheet[data-revealing] {
    background-color: transparent;
    border-color: transparent;
    box-shadow: none;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
  .sheet[data-revealing] .title,
  .sheet[data-revealing] .badge,
  .sheet[data-revealing] .body,
  .sheet[data-revealing] .more,
  .sheet[data-revealing] .foot {
    opacity: 0;
  }
  .title,
  .badge,
  .body,
  .more {
    transition: opacity var(--dur-fast) var(--ease-out);
  }

  /*
   * A click away does not close this panel — Cancel, Escape and Done do — so
   * the click is answered here instead: the edge lights for a moment, which is
   * what says "this is still waiting for you" rather than "nothing happened".
   * The dock sets the attribute; it owns the outside click.
   *
   * Drawn on a layer of its own rather than by animating the panel's border:
   * animating the glass itself dropped its blur for the length of the flash,
   * and the script behind came through sharp.
   */
  .sheet::after {
    content: '';
    position: absolute;
    /* Inside the border: the sheet clips at its padding edge. */
    inset: 0;
    border: 1px solid var(--sheet-edge-called);
    border-radius: inherit;
    opacity: 0;
    pointer-events: none;
  }
  :global(.appearance-popover[data-attention]) > .sheet::after {
    opacity: 1;
  }
  @media (prefers-reduced-motion: no-preference) {
    :global(.appearance-popover[data-attention]) > .sheet::after {
      animation: sheet-called 520ms var(--ease-out, ease-out) forwards;
    }
  }
  @keyframes sheet-called {
    0%,
    35% {
      opacity: 1;
    }
    100% {
      opacity: 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .sheet,
    .sheet-head,
    .foot,
    .title,
    .badge,
    .body,
    .more,
    .body > :global(*) {
      transition: none;
    }
  }

  /*
   * On paper: a sheet of warm paper, not a pane of dark glass.
   *
   * `data-theme="paper"` hands everything inside the light palette — the
   * title, the labels, the sliders and segmented controls. What is left here is
   * the panel's own surfaces, which were written as white-on-dark literals and
   * would otherwise draw white hairlines on a light sheet. Translucent for the
   * reason the glass is (the read behind it stays visible), and lifted a shade
   * above the paper field so it reads as a sheet laid over the page, with the
   * stage's quiet chrome border, rather than as a hole in it.
   */
  .sheet[data-theme='paper'] {
    --sheet-strip: rgba(252, 250, 246, 0.96);
    --sheet-edge-called: rgba(36, 30, 20, 0.42);
  }
  /*
   * And where the system asks for less transparency, solid outright — the
   * palette's own surface, as every other glass in the app turns (tokens.css,
   * GLASS POLICY). The held row's strip goes with it. After the paper rule on
   * purpose: the two are equally specific, so the later one wins, and this
   * one has to.
   */
  @media (prefers-reduced-transparency: reduce), (prefers-contrast: more) {
    .sheet,
    .sheet[data-theme='paper'] {
      --sheet-fill: var(--glass-solid);
      --sheet-strip: var(--glass-solid);
    }
  }
  .sheet[data-theme='paper'] .badge,
  .sheet[data-theme='paper'] .reveal:hover {
    background: var(--bg-hover-surface);
  }
  .sheet[data-theme='paper'] .more,
  .sheet[data-theme='paper'][data-revealing] .reveal {
    border-color: var(--border-control);
  }
  .sheet[data-theme='paper'] .nudge button {
    border-color: var(--border-control);
    background: var(--bg-elevated);
  }
  .sheet[data-theme='paper'] .nudge button:hover:not(:disabled) {
    background: var(--bg-hover-surface);
  }
  .sheet[data-theme='paper'] .foot {
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
    flex: 1 1 auto;
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 650;
    color: var(--text-primary);
  }
  /* A quiet header action, at the steppers' size. */
  .reveal {
    flex: 0 0 auto;
    display: inline-grid;
    place-items: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 7px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
  }
  .reveal:hover {
    background: rgba(255, 255, 255, 0.1);
    color: var(--text-primary);
  }
  /* Alone on the stage while held, so it brings its own backing. */
  .sheet[data-revealing] .reveal {
    background: var(--sheet-strip);
    border-color: var(--stage-chrome-border, rgba(255, 255, 255, 0.13));
    color: var(--text-primary);
  }

  /*
   * "More below": under the faded edge, never over a control, and only there
   * while the body really scrolls.
   */
  .more-row {
    flex: 0 0 auto;
    display: flex;
    justify-content: center;
    height: 24px;
    margin: 0 0 var(--space-2);
  }
  .more[hidden] {
    display: none;
  }
  .more {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 24px;
    padding: 0 10px;
    border: 1px solid var(--stage-chrome-border, rgba(255, 255, 255, 0.13));
    border-radius: 999px;
    background: var(--sheet-strip);
    color: var(--text-secondary);
    font: inherit;
    font-size: var(--text-meta);
    font-weight: 600;
    cursor: pointer;
  }
  .more:hover {
    color: var(--text-primary);
  }
  /* A tag, not a control: no outline, no capitals, nothing to press. */
  .badge {
    flex: 0 0 auto;
    padding: 2px 8px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.08);
    font-size: var(--text-meta);
    font-weight: 600;
    color: var(--text-secondary);
  }

  .body {
    display: flex;
    flex-direction: column;
    /* Tighter than the studio rhythm, deliberately: this is six rows on a panel
       that has to clear a 600px display and still leave the reading band in
       view behind it. Eight, not ten: at ten the prompter's five labelled rows
       ran a few pixels past the cap and its last control sat under a fade. */
    gap: 8px;
    padding: var(--space-2) var(--space-4) var(--space-3);
    overflow-y: auto;
  }
  /* The fades sit at the edge the body scrolls past, and only there. */
  .body[data-more-below] {
    -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 28px), transparent);
    mask-image: linear-gradient(to bottom, #000 calc(100% - 28px), transparent);
  }
  .body[data-more-above] {
    -webkit-mask-image: linear-gradient(to bottom, transparent, #000 28px);
    mask-image: linear-gradient(to bottom, transparent, #000 28px);
  }
  .body[data-more-above][data-more-below] {
    -webkit-mask-image: linear-gradient(
      to bottom,
      transparent,
      #000 28px,
      #000 calc(100% - 28px),
      transparent
    );
    mask-image: linear-gradient(to bottom, transparent, #000 28px, #000 calc(100% - 28px), transparent);
  }

  /*
   * The size steppers, on the size slider's own track row.
   *
   * The slider alone cannot be operated accurately at two pixels a step — the
   * whole range is 24 to 320 in a 200px-wide panel — and two pixels is exactly
   * the size of adjustment somebody makes when they are nearly right. On the
   * track's row rather than beside the whole slider, so the label and value
   * above keep the full width and the value lines up with every other one.
   */
  .nudge {
    flex: 0 0 auto;
    display: flex;
    gap: 4px;
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
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4) var(--space-3);
    border-top: 1px solid rgba(255, 255, 255, 0.1);
  }
  /* What Done keeps, in the footer beside it, where it cannot scroll away. */
  .scope {
    flex: 1 1 auto;
    min-width: 0;
    margin: 0 var(--space-2) 0 0;
    font-size: var(--text-meta);
    line-height: 1.35;
    color: var(--text-muted);
    text-wrap: pretty;
  }
</style>
