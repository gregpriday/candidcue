<!--
  The off-screen suggestion: "your words fit somewhere else — read from there?"

  ---------------------------------------------------------------------------
  WHY THIS EXISTS
  ---------------------------------------------------------------------------
  The engine refuses to move the document to a match it found off the glass —
  an ad-lib that happened to quote a later paragraph once carried a take six
  hundred words forward — and it reports the place it refused. Until now that
  place reached the stage and went nowhere, so a refusal that was protecting the
  reader looked exactly like a stage that had lost them.

  This says what the engine found, in the reader's own words, and offers the one
  move the leash allows: a deliberate "read from there". It never moves anything
  on its own, it is not a claim that the reader IS there, and it is dismissed
  without ceremony. No green, no chime, no accusation — the house rule for every
  message on the stage.

  Reading windows only: it is a pointer target, and a presenter at the glass
  has no pointer.

  ---------------------------------------------------------------------------
  WHAT IT MUST NOT COST
  ---------------------------------------------------------------------------
  Half the time the match is wrong — an ad-lib, a phrase the script uses twice —
  and the reader is exactly where the stage says they are. Then the right answer
  is to do nothing, and doing nothing must not cost them their place. So the
  offer never covers the line being read or the two after it:

  - the CARD, where there is room for it: at the top of the window over words
    already read — the same place every time, so it is somewhere the reader
    learns to look — or, failing that, above the dock below the next two lines;
  - a one-row STRIP in the dock's own row, beside the dock, when the window is
    too short for the card but wide enough for the words and both buttons;
  - a PILL in that row — "Show possible match · 3 paragraphs down" — when it
    is too small for either. It is a disclosure, not a jump: opening it is the
    reader's choice, and the card it opens may then cover script, because they
    asked for it.

  An offer nothing has renewed for a while folds to the pill as well, rather
  than vanishing: the place stays one click away for as long as it still means
  something — until following resumes, the document is moved, or it is
  ignored — without the words sitting in front of the script.

  Their own words lead, because recognising them is the whole decision; the
  arrow says which way before any of it is read, and the line under the words
  says how far and in which section.
-->
<script module lang="ts">
  import type { TokenDescription } from './ScriptLayer.svelte';

  /** "just below", "3 paragraphs up", "on screen" — how far, in the script's own units. */
  export function distancePhrase(description: TokenDescription): string {
    if (description.direction === 'visible') return 'on screen';
    const down = description.direction === 'below';
    const n = description.blocksAway;
    if (n === null) return down ? 'further down' : 'further up';
    if (n === 0) return down ? 'just below' : 'just above';
    return `${n} paragraph${n === 1 ? '' : 's'} ${down ? 'down' : 'up'}`;
  }
</script>

<script lang="ts">
  import { tick } from 'svelte';
  import { fade, fly } from 'svelte/transition';

  interface Props {
    description: TokenDescription;
    /** Chrome text size, the floor every other stage message uses. */
    fontSizePx: number;
    /**
     * The reading line, in the same pixels as the box this is placed in, or
     * null before the script has been laid out.
     */
    readingLine: { centerPx: number; pitchPx: number } | null;
    /** The box this is placed in. */
    areaWidthPx: number;
    areaHeightPx: number;
    /** The dock's row as drawn, or 0 before it has been. */
    dockRowWidthPx: number;
    /** The hold message in the top corner as drawn, 0 while it is not showing. */
    holdHeightPx: number;
    /** Nothing has renewed the offer for a while: it waits, folded, in the dock's row. */
    stale: boolean;
    reducedMotion: boolean;
    onread: () => void;
    onignore: () => void;
    /** The pointer or the keyboard is on the offer — it must not expire under them. */
    onengage: (engaged: boolean) => void;
    /** The reader opened the folded offer. */
    onopen: () => void;
  }

  let {
    description,
    fontSizePx,
    readingLine,
    areaWidthPx,
    areaHeightPx,
    dockRowWidthPx,
    holdHeightPx,
    stale,
    reducedMotion,
    onread,
    onignore,
    onengage,
    onopen,
  }: Props = $props();

  const uid = $props.id();
  const excerptId = `${uid}-excerpt`;
  const whereId = `${uid}-where`;

  /*
   * The corner rows the card must not reach into: the hold message and the
   * take-controls tab across the top, the dock along the bottom. A 40px control
   * at the chrome insets (`--stage-chrome-inset`, `--stage-chrome-bottom-inset`)
   * plus a gap.
   */
  const INSET_PX = 20;
  const FLOOR_PX = 16 + 40 + 12;
  const GAP_PX = 12;
  /** The dock before it has been measured: its widest, a fault label in the readout. */
  const DOCK_GUESS_PX = 320;
  /** The narrowest strip that still shows a useful run of the words beside both buttons. */
  const STRIP_MIN_EM = 34;
  /** The narrowest row a pill can say its distance in. */
  const PILL_MIN_EM = 11;
  /** The width below which the card stacks its buttons — the lane's container query. */
  const NARROW_LANE_EM = 38;

  let cardHeight = $state(0);
  /** The card's height when it was last drawn, kept while another form is showing. */
  let drawnHeight = $state(0);
  let hovered = $state(false);
  let focused = $state(false);
  /** The reader opened the pill in a window with no room to offer the card unasked. */
  let opened = $state(false);
  let readButton = $state<HTMLButtonElement | undefined>();

  $effect(() => {
    onengage(hovered || focused);
  });
  $effect(() => {
    if (stale) opened = false;
  });
  $effect(() => {
    if (cardHeight > 0) drawnHeight = cardHeight;
  });

  const engage = {
    onpointerenter: () => (hovered = true),
    onpointerleave: () => (hovered = false),
    onfocusin: () => (focused = true),
    onfocusout: (event: FocusEvent) => {
      const next = event.relatedTarget;
      const group = event.currentTarget as HTMLElement;
      if (!(next instanceof Node) || !group.contains(next)) focused = false;
    },
  };

  /** Below the corner row — and below a hold message, when one runs to two lines. */
  const ceilingPx = $derived(INSET_PX + Math.max(40, holdHeightPx) + GAP_PX);

  const lineBox = $derived.by(() => {
    if (!readingLine || areaHeightPx === 0) return null;
    const { centerPx, pitchPx } = readingLine;
    return {
      top: centerPx - pitchPx / 2,
      bottom: centerPx + pitchPx / 2,
      pitch: pitchPx,
      floor: areaHeightPx - FLOOR_PX,
    };
  });
  /*
   * Before the card has ever been drawn, an estimate: two rows of text and the
   * padding when it is wide; two lines of words, the place and the padding
   * when it is narrow.
   */
  const height = $derived(
    drawnHeight > 0
      ? drawnHeight
      : (areaWidthPx - 2 * INSET_PX < NARROW_LANE_EM * fontSizePx ? 6.5 : 4.6) * fontSizePx,
  );

  /** A place for the card that leaves the line being read and the two after it in sight. */
  const safeTopPx = $derived.by((): number | null => {
    const line = lineBox;
    if (!line) return null;
    const h = height;
    // Over words already read, keeping the line just read in sight.
    if (line.top - line.pitch - GAP_PX - h >= ceilingPx) return ceilingPx;
    // Below the next two lines, as far down as the dock allows.
    if (line.bottom + 2 * line.pitch + GAP_PX + h <= line.floor) return line.floor - h;
    return null;
  });

  /** Where a card the reader asked for goes when there is no safe place: off the line, if it can be. */
  const openedTopPx = $derived.by((): number | null => {
    const line = lineBox;
    if (!line) return null;
    const h = height;
    if (line.top - GAP_PX - h >= ceilingPx) return line.top - GAP_PX - h;
    if (line.bottom + GAP_PX + h <= line.floor) return line.bottom + GAP_PX;
    return null;
  });

  /** Where the dock's row is free: from just past the dock to the inset. */
  const rowStartPx = $derived(INSET_PX + (dockRowWidthPx > 0 ? dockRowWidthPx : DOCK_GUESS_PX) + GAP_PX);
  const rowWidthPx = $derived(areaWidthPx - INSET_PX - rowStartPx);
  const stripFits = $derived(rowWidthPx >= STRIP_MIN_EM * fontSizePx);
  /** A window too narrow even for the pill beside the dock: it goes just above the dock instead. */
  const rowAboveDock = $derived(rowWidthPx < PILL_MIN_EM * fontSizePx);

  const form = $derived.by((): 'card' | 'strip' | 'pill' => {
    if (stale) return 'pill';
    // Before the layout can say where the line is, the card waits above the dock.
    if (!lineBox || safeTopPx !== null) return 'card';
    if (stripFits) return 'strip';
    return opened ? 'card' : 'pill';
  });
  const cardTopPx = $derived(safeTopPx ?? (opened ? openedTopPx : null));

  const distance = $derived(distancePhrase(description));
  /** The place alone, for a line too short to say "Possible match" as well. */
  const distanceAlone = $derived(distance.charAt(0).toUpperCase() + distance.slice(1));
  /** The pill says what it does when its row has room for it. */
  const pillSaysShow = $derived(rowAboveDock || rowWidthPx >= 24 * fontSizePx);

  async function open(): Promise<void> {
    opened = true;
    onopen();
    // The pill goes as the offer opens; the keyboard goes to what replaced it.
    await tick();
    readButton?.focus({ preventScroll: true });
  }
</script>

{#snippet arrow()}
  {#if description.direction !== 'visible'}
    <svg class="arrow" viewBox="0 0 16 16" aria-hidden="true">
      {#if description.direction === 'above'}
        <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
      {:else}
        <path d="M8 3v10M3.5 8.5 8 13l4.5-4.5" />
      {/if}
    </svg>
  {/if}
{/snippet}

{#snippet where(long: boolean)}
  <p class="where" id={whereId}>
    {#if long}
      <span class="distance long">Possible match {distance}</span>
    {/if}
    <span class="distance short" class:only={!long}>{distanceAlone}</span>
    {#if description.section}
      <span class="section"><span class="sep" aria-hidden="true">{'·'}</span>{description.section}</span>
    {/if}
  </p>
{/snippet}

{#snippet actions()}
  <div class="actions">
    <button
      bind:this={readButton}
      type="button"
      class="read"
      aria-describedby="{whereId} {excerptId}"
      onclick={onread}
    >
      Read from there
    </button>
    <button type="button" class="ignore" onclick={onignore}>Ignore</button>
  </div>
{/snippet}

<!--
  Announced by the stage's own always-present live region, not here: a region
  that mounts already filled is not reliably read out. The place and the words
  describe the button, so "Read from there" says where.

  The transitions are `|global` because each form sits in its own block: a
  local one would play only between forms, never when the offer arrives or
  is withdrawn.
-->
{#if form === 'card'}
  <div
    class="lane"
    style:font-size="{fontSizePx}px"
    style:top={cardTopPx === null ? null : `${cardTopPx}px`}
    style:bottom={cardTopPx === null ? `${FLOOR_PX}px` : null}
  >
    <div
      class="suggestion"
      class:pointing={description.direction !== 'visible'}
      role="group"
      aria-label="Possible match"
      data-stage-chrome
      data-suggestion-chip
      data-direction={description.direction}
      bind:offsetHeight={cardHeight}
      {...engage}
      in:fly|global={{ y: reducedMotion ? 0 : 3, duration: 160 }}
      out:fade|global={{ duration: 120 }}
    >
      {@render arrow()}
      <p class="excerpt" id={excerptId}>“{description.excerpt}”</p>
      <div class="footer">
        {@render where(true)}
        {@render actions()}
      </div>
    </div>
  </div>
{:else}
  <div
    class="row"
    style:font-size="{fontSizePx}px"
    style:left="{rowAboveDock ? INSET_PX : rowStartPx}px"
    style:bottom={rowAboveDock ? `${FLOOR_PX}px` : null}
  >
    {#if form === 'strip'}
      <div
        class="strip"
        class:pointing={description.direction !== 'visible'}
        role="group"
        aria-label="Possible match"
        data-stage-chrome
        data-suggestion-chip
        data-direction={description.direction}
        {...engage}
        in:fade|global={{ duration: 160 }}
        out:fade|global={{ duration: 120 }}
      >
        {@render arrow()}
        <p class="excerpt" id={excerptId}>“{description.excerpt}”</p>
        {@render where(false)}
        {@render actions()}
      </div>
    {:else}
      <div
        class="pill-group"
        role="group"
        aria-label="Possible match"
        data-stage-chrome
        data-suggestion-chip
        data-direction={description.direction}
        {...engage}
        in:fade|global={{ duration: 160 }}
        out:fade|global={{ duration: 120 }}
      >
        <!--
          A disclosure, not a jump: it shows the offer, and moving there is
          still the offer's own button. Named for that, whatever fits on it.
        -->
        <button
          type="button"
          class="pill"
          aria-label="Show possible match, {distance}"
          aria-describedby={excerptId}
          onclick={open}
        >
          {#if pillSaysShow}
            <span class="pill-name">Show possible match</span>
            <span class="pill-place"><span class="sep" aria-hidden="true">{'·'}</span>{distance}</span>
          {:else}
            <span class="pill-place only">{distanceAlone}</span>
          {/if}
          <svg class="disclose" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4.5 9.75 8 6.25l3.5 3.5" />
          </svg>
        </button>
        <p class="pill-words" id={excerptId} hidden>“{description.excerpt}”</p>
      </div>
    {/if}
  </div>
{/if}

<style>
  /*
   * A full-width lane the card is centred in. It is what the card's layout is
   * measured against — a window too narrow for the words, their place and both
   * buttons on two rows gets the buttons in a column of their own instead — and
   * it takes no clicks itself.
   */
  .lane {
    position: absolute;
    left: 0;
    right: 0;
    display: flex;
    justify-content: center;
    padding-inline: var(--stage-chrome-inset, 20px);
    container: suggestion-lane / inline-size;
    pointer-events: none;
  }
  /* The dock's row: the strip and the pill sit at its right, the dock at its
     left. Where the row starts is measured from the dock (`rowStartPx`). */
  .row {
    position: absolute;
    right: var(--stage-chrome-inset, 20px);
    bottom: var(--stage-chrome-bottom-inset, 16px);
    display: flex;
    justify-content: flex-end;
    pointer-events: none;
  }
  .suggestion,
  .strip,
  .pill {
    box-sizing: border-box;
    border: 1px solid var(--stage-chrome-border, rgba(255, 255, 255, 0.13));
    border-radius: var(--stage-chrome-radius, 12px);
    background: var(--stage-chrome-bg, rgba(12, 14, 18, 0.74));
    color: var(--stage-chrome-text, rgba(245, 243, 239, 0.88));
    backdrop-filter: var(--glass-backdrop-thin);
    -webkit-backdrop-filter: var(--glass-backdrop-thin);
    pointer-events: auto;
    line-height: 1.3;
  }
  .suggestion {
    max-width: min(40em, 100%);
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      'excerpt'
      'footer';
    row-gap: 0.4em;
    padding: 0.7em 0.8em 0.7em 1.2em;
    box-shadow: var(--stage-chrome-shadow, none);
  }
  /* The arrow takes a column of its own, so the words and the line under them
     share one left edge. */
  .suggestion.pointing {
    grid-template-columns: auto minmax(0, 1fr);
    grid-template-areas:
      'arrow excerpt'
      '. footer';
    column-gap: 0.85em;
    padding-left: 0.75em;
  }
  .arrow {
    grid-area: arrow;
    flex: none;
    align-self: start;
    width: 1em;
    height: 1em;
    /* Centred on the first line of the words, not the box. */
    margin-top: 0.15em;
    fill: none;
    stroke: var(--stage-chrome-text-strong, #f5f3ef);
    stroke-width: 1.75;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  /* The reader's own words: what they recognise, so what reads first. The
     opening quote hangs, so a second line and the place under them start under
     the first letter rather than under the mark. */
  .excerpt {
    grid-area: excerpt;
    /* Pulled back by the mark's width and padded by it again, so the mark is
       inside the box the line clamp clips to. */
    margin: 0 0 0 -0.4em;
    padding-left: 0.4em;
    text-indent: -0.4em;
    color: var(--stage-chrome-text-strong, #f5f3ef);
    font-weight: 500;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  .footer {
    grid-area: footer;
    display: flex;
    align-items: center;
    gap: 1.2em;
  }
  /*
   * One line. The distance is never shortened — "just bel…" is no distance at
   * all — so a long section name takes only the room that is left, and goes
   * entirely before the distance gives up a letter.
   */
  .where {
    grid-area: where;
    display: flex;
    flex: 1 1 auto;
    min-width: 0;
    margin: 0;
    overflow: hidden;
    color: var(--stage-chrome-text-muted, rgb(245 243 239 / 62%));
    white-space: nowrap;
  }
  .distance {
    flex: none;
  }
  .section {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sep {
    margin-inline: 0.4em;
  }
  .short {
    display: none;
  }
  .short.only {
    display: block;
  }
  .actions {
    grid-area: actions;
    display: flex;
    flex: none;
    gap: 0.45em;
    margin-left: auto;
  }
  /*
   * Narrow: the words and their place on the left, the two buttons stacked on
   * the right — two rows of text tall rather than three, which is what lets
   * the card stay clear of the reading line in a shorter window as well.
   */
  @container suggestion-lane (width < 38em) {
    .suggestion {
      grid-template-columns: minmax(0, 1fr) auto;
      grid-template-areas:
        'excerpt actions'
        'where actions';
      column-gap: 0.9em;
    }
    .suggestion.pointing {
      grid-template-columns: auto minmax(0, 1fr) auto;
      grid-template-areas:
        'arrow excerpt actions'
        '. where actions';
      column-gap: 0.85em;
    }
    .footer {
      display: contents;
    }
    /* "Possible match" is the card's own name, and the first thing to go
       when the line is short: the place is what this line is for. */
    .long {
      display: none;
    }
    .short {
      display: block;
    }
    .actions {
      flex-direction: column;
      align-self: center;
      margin-left: 0;
    }
  }

  /*
   * The strip: the card's parts on one line the height of the dock beside it.
   * The words give way first, to an ellipsis; the place and the buttons keep
   * their length.
   */
  .strip {
    display: flex;
    align-items: center;
    gap: 0.9em;
    min-width: 0;
    min-height: 40px;
    padding: 3px 3px 3px 0.85em;
    box-sizing: border-box;
  }
  .strip.pointing {
    padding-left: 0.7em;
  }
  .strip .arrow {
    align-self: center;
    margin: 0 -0.35em 0 0;
  }
  .strip .excerpt {
    display: block;
    margin: 0;
    padding: 0;
    text-indent: 0;
    flex: 1 1 auto;
    min-width: 4em;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  /* The place keeps its length. There is no room for the section beside the
     words, so it is not drawn, but it is still read: the button's description
     says where on the strip exactly as it does on the card. */
  .strip .where {
    flex: none;
  }
  .strip .section {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  /* The dock's own spacing, and buttons short enough that the strip is the
     dock's height. */
  .strip .actions {
    gap: 6px;
    margin-left: 0;
  }
  .strip .actions button {
    padding-block: 0.12em;
  }

  /*
   * The pill: which way and how far, in the dock's own material and at its
   * height, so it reads as a control in the row rather than a message.
   */
  .pill-group {
    display: flex;
    min-width: 0;
    pointer-events: auto;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 0.4em;
    min-width: 0;
    min-height: 40px;
    padding: 0 0.6em 0 0.85em;
    font: inherit;
    font-weight: 500;
    white-space: nowrap;
    cursor: pointer;
    transition:
      background-color 120ms linear,
      border-color 120ms linear;
  }
  /* The flex gap is the space before it; this is the space after. */
  .pill .sep {
    margin-inline: 0 0.4em;
  }
  .disclose {
    flex: none;
    width: 1em;
    height: 1em;
    fill: none;
    stroke: var(--stage-chrome-text-muted, rgb(245 243 239 / 62%));
    stroke-width: 1.75;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .pill-name {
    color: var(--stage-chrome-text-strong, #f5f3ef);
    font-weight: 600;
  }
  .pill-place {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--stage-chrome-text-muted, rgb(245 243 239 / 62%));
  }
  .pill-place.only {
    color: var(--stage-chrome-text-strong, #f5f3ef);
  }
  .pill:hover {
    background: var(--stage-chrome-bg-hover, rgb(24 28 35 / 88%));
    border-color: var(--stage-chrome-border-hover, rgb(255 255 255 / 30%));
  }

  /*
   * The stage's own button: the confirmation's shape, at the card's full size —
   * the words somebody acts on are never the smallest on it.
   */
  .actions button {
    font: inherit;
    font-weight: 600;
    line-height: 1.2;
    padding: 0.32em 0.8em;
    min-height: 32px;
    border-radius: 8px;
    border: 1px solid transparent;
    cursor: pointer;
    white-space: nowrap;
    transition:
      background-color 120ms linear,
      border-color 120ms linear;
  }
  /* The one thing on the card in the app's own colour. */
  .actions .read {
    background: var(--stage-action-bg, #e08a63);
    border-color: var(--stage-action-bg, #e08a63);
    color: var(--stage-action-text, #241510);
  }
  .actions .read:hover {
    background: var(--stage-action-bg-hover, #ec9d7a);
    border-color: var(--stage-action-bg-hover, #ec9d7a);
  }
  .actions .ignore {
    background: transparent;
    border-color: var(--stage-chrome-control-border, rgb(255 255 255 / 18%));
    color: var(--stage-chrome-text, rgb(245 243 239 / 88%));
  }
  .actions .ignore:hover {
    background: var(--stage-chrome-control-hover, rgb(255 255 255 / 10%));
  }
  button:focus-visible {
    outline: 2px solid var(--stage-focus-ring, rgb(245 243 239 / 70%));
    outline-offset: 2px;
  }
  button:active {
    transform: translateY(1px);
  }
  @media (prefers-reduced-motion: reduce) {
    button:active {
      transform: none;
    }
  }
  /* Where the glass cannot be made, the material is simply darker. */
  @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
    .suggestion,
    .strip,
    .pill {
      background: var(--stage-chrome-bg-solid, rgb(12 14 18 / 92%));
    }
  }
  /* No blur and no transparency under Reduce Transparency or Increase
     Contrast (tokens.css, GLASS POLICY): an opaque plate. */
  @media (prefers-reduced-transparency: reduce), (prefers-contrast: more) {
    .suggestion,
    .strip,
    .pill {
      background: var(--stage-chrome-bg-opaque, rgb(12 14 18));
    }
  }
</style>
