<!--
  Transient command acknowledgement (spec §33.10): the one short answer the
  glass gives back when the presenter presses a key mid-take — "Pricing",
  "170 wpm", "Mirrored for this take". Visual only: whoever owns the command
  decides what it says; this decides where it sits and how long it stays.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import type { StageAckState } from './stageState';

  interface Props {
    ack?: StageAckState | null;
    /**
     * False while the chip must not be seen: acknowledgements switched off, the
     * stage blanked, or a more urgent prompt holding the top of the glass.
     *
     * A prop rather than an `{#if}` around the component, so the status element
     * stays mounted for the whole take — a live region that is created and
     * destroyed around each message is one a screen reader can miss.
     */
    enabled?: boolean;
    /**
     * The floor from `ResolvedOptics`, in px.
     *
     * Taken as a number rather than left to a CSS custom property, for the same
     * reason `HoldStatus` takes one: the fallback in a `var()` chain is an `em`,
     * and an `em` on an uncalibrated rig resolves against the root font size —
     * about 11px, which is decoration rather than communication. A value that
     * has to be floored is a value the component should be given, not one it
     * should hope a cascade supplies.
     */
    secondaryMinPx?: number;
    /**
     * How far down the safe rectangle the chip starts, in px.
     *
     * The host knows what else is pinned to the top edge of the window — in a
     * single-window take, control's "Take controls" tab — and the chip does not.
     */
    topPx?: number;
    /**
     * The widest the chip may be, in px — the host's budget once the hold chip
     * in the opposite corner has its room. Null leaves the stylesheet's cap.
     */
    maxWidthPx?: number | null;
  }

  let {
    ack = null,
    enabled = true,
    secondaryMinPx = 0,
    topPx = 20,
    maxWidthPx = null,
  }: Props = $props();

  /** The stage's one fade, in and out. */
  const FADE_MS = 150;

  /**
   * How long an answer stays fully in, from how much there is to read.
   *
   * The presenter's eyes are on the reading line when it appears, not on the
   * chip: noticing it and getting there costs a few hundred milliseconds before
   * a word is read, and subtitle practice puts the floor for a short line at
   * about 0.8–1.3 s for a viewer who is ALREADY looking. So 1.5 s is the least
   * any answer gets, and longer ones earn 50 ms a character (20 characters a
   * second, the adult subtitle rate) up to 3 s — past that it is lingering over
   * the script after the information has been taken in.
   *
   * It was a flat 900 ms including the fade in, which left about 750 ms at full
   * strength: less than a late glance needs to land, let alone to read.
   */
  function dwellMs(text: string): number {
    return Math.min(3000, Math.max(1500, 200 + 50 * text.length));
  }

  let shown = $state(false);
  let chip: HTMLDivElement | undefined = $state();
  let dwellTimer = 0;
  let swapFrame = 0;
  /** An answer waiting for the one on the glass to finish leaving. */
  let pending: { label: string; dwellMs: number; sinceMs: number } | null = null;

  /**
   * Whether `next` can replace `current` without the box changing size.
   *
   * Only an answer that differs in its digits — 170 → 180 wpm, Text 64 → 66 px
   * — and those are set in tabular figures, so they keep their width exactly.
   */
  function sameFootprint(current: string, next: string): boolean {
    return current.replace(/\d/g, '0') === next.replace(/\d/g, '0');
  }

  /**
   * The last thing acknowledged, held past the moment it stops being shown.
   *
   * The chip fades out rather than vanishing, and clearing the text at the
   * instant the opacity starts falling would empty the box first and shrink it
   * — movement, beside a script somebody is reading, which is the one thing
   * this surface spends its whole design budget avoiding. Same latch, and same
   * reason, as `HoldStatus`.
   */
  let label = $state('');

  /**
   * Whether any of the chip can be seen — including the tail of a fade out.
   *
   * Read from the element's computed `visibility`, not from a clock: it turns
   * hidden only when the stylesheet's own delay has run out, i.e. once the
   * opacity has actually reached zero — later than any timestamp taken when the
   * fade was asked for, if the browser was slow to start it. Without an element
   * yet, `shown` is the best answer there is.
   */
  function onGlass(): boolean {
    return chip ? getComputedStyle(chip).visibility !== 'hidden' : shown;
  }

  function present(next: string, dwell: number): void {
    pending = null;
    cancelAnimationFrame(swapFrame);
    label = next;
    if (!enabled) return;
    shown = true;
    clearTimeout(dwellTimer);
    dwellTimer = window.setTimeout(() => {
      shown = false;
    }, FADE_MS + dwell);
  }

  /**
   * Hand the waiting answer over the moment nothing of the last one is left.
   *
   * Bounded, because the signal is the stylesheet: somewhere the stylesheet does
   * not apply — a test DOM — `visibility` never turns hidden, and an answer that
   * waits for it forever is an answer the presenter never gets. Four fades' worth
   * is far past any fade that actually started.
   */
  function presentWhenGone(): void {
    if (pending === null) return;
    if (onGlass() && performance.now() - pending.sinceMs < FADE_MS * 4) {
      swapFrame = requestAnimationFrame(presentWhenGone);
      return;
    }
    present(pending.label, pending.dwellMs);
  }

  /*
   * One slot. `seq` is what makes an identical answer — the same section twice —
   * count as a fresh one.
   *
   * A new answer while one is on the glass replaces it, and HOW depends on
   * whether the box would change size. Three presses of the pace key change a
   * digit in place and restart the clock: one number changing, not three things
   * arriving. Anything else — one section and then another — fades the old
   * answer out, waits until the browser reports it fully gone, swaps the words,
   * and fades the new one in. The box never grows or shrinks where it can be
   * seen: a snap in width beside the script is movement, which opacity is not.
   * Under reduced motion there is no fade to wait for and the swap is a frame.
   */
  $effect(() => {
    if (!ack) return;
    const next = ack.label;
    const dwell = ack.durationMs ?? dwellMs(next);
    untrack(() => {
      // Nothing has ever been shown, so there is nothing to wait for.
      if (label !== '' && onGlass() && !sameFootprint(label, next)) {
        clearTimeout(dwellTimer);
        shown = false;
        const waiting = pending !== null;
        // The newest answer is the one that will be shown; a burst does not queue.
        pending = { label: next, dwellMs: dwell, sinceMs: pending?.sinceMs ?? performance.now() };
        if (!waiting) swapFrame = requestAnimationFrame(presentWhenGone);
      } else {
        present(next, dwell);
      }
    });
  });

  // Stood down mid-answer: the answer is over, not postponed. Coming back from
  // a blank must not replay a stale confirmation — nor one that was waiting.
  $effect(() => {
    if (enabled) return;
    untrack(() => {
      pending = null;
      cancelAnimationFrame(swapFrame);
      shown = false;
    });
  });

  $effect(() => () => {
    clearTimeout(dwellTimer);
    cancelAnimationFrame(swapFrame);
  });

  /**
   * The floor, floored again — the identical rule `HoldStatus` applies.
   *
   * 14px catches a resolved value that came out absurdly small; 18px is what a
   * caller that has not resolved optics at all gets, deliberately larger than
   * the hard floor, because "we know nothing about this rig" must not quietly
   * produce the smallest text on the glass.
   */
  const fontSizePx = $derived(
    typeof secondaryMinPx === 'number' && Number.isFinite(secondaryMinPx) && secondaryMinPx > 0
      ? Math.max(14, secondaryMinPx)
      : 18,
  );
</script>

<!--
  Mounted for the whole take, shown by attribute.

  It used to be an `{#if}`, which gave it an entrance animation and no exit at
  all: the chip faded in over 120ms and then disappeared between two frames.
  Every other overlay on this stage fades both ways, and a single-frame
  disappearance in peripheral vision reads as a glitch rather than as something
  finishing — the one impression a status surface cannot afford beside a script
  somebody is speaking.
-->
<div
  class="ack"
  bind:this={chip}
  data-visible={shown && enabled}
  role="status"
  style:font-size="{fontSizePx}px"
  style:top="{topPx}px"
  style:max-width={maxWidthPx === null ? null : `${maxWidthPx}px`}
>
  <span class="text">{label}</span>
</div>

<style>
  /*
   * TOP RIGHT, OVER WORDS ALREADY SPOKEN.
   *
   * It sat at the bottom centre, 7vh up, which put it over the lines the
   * presenter reads NEXT and as far from the reading line as the glass allows —
   * a long look down and a search back up, for one word. Above the reading line
   * there is only script that has already been said, so covering it costs
   * nothing.
   *
   * The right-hand corner, because it is the hold chip's geometry reflected:
   * the same inset and the same width cap from the other side, so the two never
   * meet whatever either says. Both live in the mirrored plane and trade sides
   * together when the glass is flipped. The top centre is the Escape prompt's,
   * which outranks this and hides it while it is up.
   *
   * Sized against the body text, not against the viewport (see `fontSizePx`):
   * this was `clamp(15px, 1.6vw, 22px)` once, a control-window size that nobody
   * at 1.5 m through glass can read.
   */
  .ack {
    position: absolute;
    right: var(--stage-chrome-inset, 20px);
    box-sizing: border-box;
    /* Short answers — a section, a pace, "Mirrored" — share one width. */
    min-width: 6em;
    /* Fallback only: the host passes a budget that keeps clear of the hold
       chip in the opposite corner (`ackMaxWidthPx` in StageApp). */
    max-width: 52%;
    padding: 0.36em 0.95em 0.4em;
    /* Half the height of one line, so a one-line answer is a pill and the rare
       two-line one a rounded slab rather than a lozenge. */
    border-radius: calc(0.955em + 1px);
    /* An edge, so it reads as a card laid over the script rather than as a
       hole cut in it — see `--stage-overlay` in stage.css. */
    border: 1px solid var(--stage-chrome-border, rgba(255, 255, 255, 0.13));
    background: var(--stage-overlay);
    color: var(--stage-text);
    font-weight: 550;
    line-height: 1.15;
    letter-spacing: 0.01em;
    /* Figures that keep their width, so 170 → 180 wpm is a digit changing. */
    font-variant-numeric: tabular-nums;
    text-align: center;
    pointer-events: none;
    opacity: 0;
    /* `visibility` is what takes the spent label out of the accessibility tree,
       so a screen reader is not left holding the last acknowledgement for the
       rest of the take. Delayed by the fade so the word is still there while it
       is fading. */
    visibility: hidden;
    transition:
      opacity 150ms linear,
      visibility 0s linear 150ms;
  }

  /*
   * Two lines at most. A long section title is recognised by its first words;
   * the rest stays in the element for a screen reader.
   *
   * On an inner box with no padding of its own: clamped on the padded plate,
   * the top of a third line showed through the bottom padding.
   */
  .text {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    text-wrap: balance;
  }

  /*
   * A FADE, NOT A RISE.
   *
   * It used to slide up six pixels on the way in. A command acknowledgement is
   * already a new object appearing in the reader's peripheral field — that is
   * the whole signal — and the translation added nothing to the meaning while
   * adding the one thing this surface spends its whole design budget avoiding:
   * something moving beside the words somebody is speaking.
   */
  .ack[data-visible='true'] {
    opacity: 1;
    visibility: visible;
    transition:
      opacity 150ms linear,
      visibility 0s linear 0s;
  }

  @media (prefers-reduced-motion: reduce) {
    .ack,
    .ack[data-visible='true'] {
      transition: none;
    }
  }
</style>
