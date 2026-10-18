<!--
  The audio display — whether CandidCue is picking up what the presenter says.

  ---------------------------------------------------------------------------
  IT IS OPERATOR CHROME NOW, AND THAT IS A CHANGE OF ADDRESS
  ---------------------------------------------------------------------------
  This used to sit in the mirrored talent plane, on the argument that a
  beamsplitter reflects every pixel equally so anything the presenter reads has
  to ride the corrective flip. That argument is still correct, and it is about
  the fault NAME — the one string on this readout somebody has to read at a
  glance from where they are standing.

  That name is no longer this component's only route to the presenter.
  `resolveHoldStatus` puts a named fault at the top of the hold ladder, so "No
  audio" reaches the glass through the mirrored hold chip in presenter-sized
  type. What is left here is a waveform and a mark, which are read by whoever
  is standing at the rig — and they now live in the dock with the two controls
  that same person uses, unmirrored, at the physical bottom left.

  The fault label stays on the pill as well. It costs nothing when things are
  fine (it is not drawn), and on an unmirrored rig — which is most desks — it
  is the fastest place to read what broke.

  It holds no audio state and no thresholds. Control owns the capture and sends
  a fully resolved view (`StageVoicePillPayload`), so what is drawn here cannot
  drift from what was decided there. The only thing this component knows how to
  do that control does not is turn an array of amplitudes into a waveform.

  Never unmounted while a take is live — `visible` fades it instead. A pill that
  was removed and re-added would pop back into existence at full opacity beside
  a script somebody is reading, which is exactly the kind of movement the stage
  is supposed to be free of.

  It is laid out by the dock, not positioned by itself. See StageDock.
-->
<script lang="ts">
  import { STAGE_VOICE_PILL_TRACE_SAMPLES, type StageVoicePillPayload } from '../shared/contracts';

  interface Props {
    pill: StageVoicePillPayload;
  }

  let { pill }: Props = $props();

  /**
   * Bars, oldest at the left.
   *
   * Padded to a fixed count from the left so the trace GROWS INTO the pill from
   * the right rather than stretching to fill it. A trace that rescaled as
   * samples accumulated would read as the level changing when it had not, which
   * on the one element whose job is to report a level is the single illusion
   * that cannot be tolerated.
   */
  const BARS = STAGE_VOICE_PILL_TRACE_SAMPLES;
  const bars = $derived.by(() => {
    const levels = pill.levels;
    const padding = Math.max(0, BARS - levels.length);
    return [...new Array<number>(padding).fill(0), ...levels.slice(-BARS)];
  });

  /*
   * THE TRACE IS ALWAYS DRAWN.
   *
   * There used to be a `prominence` field that could collapse it to the mark
   * alone, on the reasoning that a waveform is the only thing on the glass
   * besides the script that MOVES, and that once recognition has come back it
   * has said everything it exists to say.
   *
   * The second half is what was wrong. "Audio is arriving" is not a fact that
   * settles — a microphone that worked a minute ago tells the presenter nothing
   * about now, and the moment they most need to ask is the one where the script
   * has stopped moving and they cannot tell whether it is them or the rig. The
   * trace answers that continuously or it does not answer it at all.
   *
   * The MARK is the part that settles, and it does: the tick is held briefly
   * and then becomes a quiet solid dot (see `StageVoicePillReading`). So the
   * only thing still moving here once a take is under way is the waveform, dim,
   * in the corner furthest from the reading line.
   */
</script>

<!-- role="status": the reading changes as the take learns things, and a
     presenter using a screen reader needs those changes announced without the
     pill stealing focus from a window that has none to give. -->
<!--
  `aria-hidden` tracks the visual state, and that is not decoration.

  `visible` is set false by a PAUSE, where the question this answers has no
  answer: a hard pause has muted the device. Fading the pixels while leaving the
  live region in the accessibility tree meant a screen reader could still be
  told "Hearing you" — or, worse, left holding the fault from before the pause —
  about a microphone that is deliberately switched off. The element stays
  MOUNTED either way, so returning fades it back in rather than making it appear
  from nowhere.
-->
<div
  class="voice-pill"
  data-reading={pill.reading}
  data-visible={pill.visible}
  role="status"
  aria-live="polite"
  aria-hidden={!pill.visible}
  aria-label={pill.label}
>
  <!-- aria-hidden: the waveform is the same fact as the label, drawn.
       Announcing two dozen bars would be noise. -->
  <div class="wave" aria-hidden="true">
    {#each bars as level, index (index)}
      <!-- A floor keeps the baseline visible while silent, so the trace reads
           as "listening and hearing nothing" rather than as a component that
           has failed to render. -->
      <span class="bar" style:height="{Math.max(12.5, level * 100)}%"></span>
    {/each}
  </div>

  <!--
    The mark, and there are only four of them.

      hollow dot — listening, nothing has come back yet;
      tick       — it just did, held for under a second;
      solid dot  — and it is still fine;
      cross      — something is wrong, in the cue colour, with its name beside.

    Three of the four are still. Only the tick appears and goes, and it only
    does so on news: the first lock of a take, and a recovery.
  -->
  <span class="mark" aria-hidden="true">
    {#if pill.reading === 'confirmed'}
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
        <path d="M5 12.8 L10 17.5 L19 7" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    {:else if pill.reading === 'fault'}
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
        <path d="M7 7 L17 17 M17 7 L7 17" stroke-linecap="round" />
      </svg>
    {:else}
      <span class="dot"></span>
    {/if}
  </span>

  <!--
    §20: state is never colour alone. A fault the presenter cannot name is a
    fault they cannot fix.

    -------------------------------------------------------------------------
    THE SLOT IS NOT RESERVED, AND THAT IS DELIBERATE
    -------------------------------------------------------------------------
    This briefly reserved its width in every reading, so that a fault arriving
    could not widen the pill and shove the button row sideways. The trade was
    bad: the shove is rare and momentary, the reserved slot was 126px of empty
    glass in every take. Faults are the exception, so the exception pays.

    The element stays in the markup in both states and only `display` changes,
    so there is one place to look for the label rather than two branches.

    `aria-hidden` while there is nothing to say, so a screen reader is not
    handed an empty element on every reading change; the pill's own `aria-label`
    carries the reading the rest of the time.
  -->
  <span class="label" data-visible={pill.reading === 'fault'} aria-hidden={pill.reading !== 'fault'}
    >{pill.reading === 'fault' ? pill.label : ''}</span
  >
</div>

<style>
  /*
   * Dock geometry: 40px tall, on the same material and radius as the two
   * buttons beside it. It is laid out in the dock's row rather than positioned
   * against a corner, which is the whole reason the three read as one
   * instrument instead of three chips that happen to be near each other.
   *
   * The width is the CONTENT's: trace + mark + padding, 106px at rest. It was
   * briefly a fixed 232px slot sized for the longest fault label, so that a
   * fault could arrive without shoving the button row. That bought a rare,
   * momentary stability with 126px of dead space on the glass for the whole of
   * every take, which is the wrong way round — the empty slot is on screen
   * always and the shove almost never.
   */
  .voice-pill {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 40px;
    padding: 0 10px;
    border: 1px solid var(--stage-chrome-border);
    border-radius: var(--stage-chrome-radius);
    background: var(--stage-chrome-bg);
    box-shadow: var(--stage-chrome-shadow);
    -webkit-backdrop-filter: blur(16px) saturate(130%);
    backdrop-filter: blur(16px) saturate(130%);
    /* A readout, not a control. It must never eat a click meant for the window
       beneath, and it is skipped in the tab order for the same reason. */
    pointer-events: none;
    opacity: 0;
    /* Slow enough to read as a fade rather than a blink. */
    transition: opacity 420ms ease;
  }

  .voice-pill[data-visible='true'] {
    opacity: 1;
  }

  .wave {
    display: flex;
    align-items: center;
    /* Packed against the mark, so the one spare pixel of the 60 is at the
       old end of the history rather than between the trace and its mark. */
    justify-content: flex-end;
    gap: 1px;
    /* Fixed, so the pill does not resize as the trace fills — a container that
       grew with its contents would drag the mark across the screen. */
    width: 60px;
    height: 16px;
    overflow: hidden;
    /* Below the body text it sits beside, deliberately. It is the only thing
       on this surface that moves. */
    opacity: 0.64;
  }

  /* Whole pixels on a 1x panel: twenty 2px bars and 1px gaps make 59 of the
     60, and the floor is 2px (12.5% of 16) rather than a 1.3px smudge. */
  .bar {
    flex: 0 0 2px;
    border-radius: var(--radius-pill, 999px);
    background: var(--stage-text, #f5f3ef);
    /* Just longer than the ~100 ms publish cadence, so the trace flows instead
       of strobing, and short enough that it still reads as a direct response to
       the presenter's voice. */
    transition: height 110ms linear;
  }

  .mark {
    display: grid;
    place-items: center;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    color: var(--stage-text, #f5f3ef);
  }

  .mark svg {
    width: 12px;
    height: 12px;
  }

  /*
   * Hollow before the first lock, solid after.
   *
   * The distinction is the whole reason the tick is allowed to be transient:
   * without it, settling would mean "nothing has ever come back" and "we are
   * fine" drew the same mark, and the readout would stop answering the only
   * question anybody asks it.
   */
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    border: 1px solid currentColor;
    opacity: 0.55;
  }

  .voice-pill[data-reading='steady'] .dot {
    background: currentColor;
    opacity: 0.62;
  }

  /* Confirmed: the mark fills for its brief hold, the way the reference does —
     a positive state reads as solid, not as an outline. */
  .voice-pill[data-reading='confirmed'] .mark {
    background: var(--stage-text, #f5f3ef);
    /* The FIELD's colour, cut out of the disc: black on a dark stage, as it
       always was, and paper on a paper reading window — where black on a disc
       of near-black ink would be no mark at all. */
    color: var(--stage-mark-ink, #000);
    border-radius: 50%;
  }

  /* Fault: the cue colour the stage already uses for authored cues and for the
     hold chip's fault tone, so somebody who has seen one recognises this as the
     app talking to them. Emphatically not red. */
  .voice-pill[data-reading='fault'] .mark {
    background: var(--stage-cue, #d8b46a);
    color: var(--stage-mark-ink, #000);
  }
  .voice-pill[data-reading='fault'] .bar {
    background: var(--stage-cue, #d8b46a);
  }
  .voice-pill[data-reading='fault'] .wave {
    opacity: 0.55;
  }

  /*
   * The fault label, at chrome size rather than at the optical floor.
   *
   * It used to clamp to `--stage-secondary-min`, and that was right while this
   * readout was presenter-facing: a fault name set at 12px is unreadable at
   * prompting distance, which makes naming the fault pointless. It is the wrong
   * rule here. A calibrated rig resolves that floor at 20–30px, and a 30px word
   * inside a 40px dock would blow the whole instrument apart — while the
   * presenter's copy of the same sentence, in presenter-sized type, is already
   * on the glass in the mirrored hold chip.
   *
   * So this one is sized for the person standing at the panel, like every other
   * string in the dock.
   */
  /*
   * Out of the flow entirely until there is a fault to name, so the resting
   * pill is trace + mark and nothing else. `display: none` rather than
   * `visibility: hidden` is the point: a hidden-but-laid-out slot is exactly
   * the 126px of permanent dead space this replaced.
   *
   * The cost is honest and bounded: when a fault does arrive the pill grows by
   * the width of one short word and the buttons beside it shift once. All four
   * labels are short (`No audio`, `Voice off`, `Not hearing you`,
   * `Control lost`) and a fault is rare, so the row settles immediately and
   * stays put. `white-space: nowrap` keeps the name on one line; there is no
   * ellipsis because nothing truncates when the pill sizes to its content.
   */
  .label {
    flex: 0 0 auto;
    padding-right: 2px;
    font-size: 12px;
    letter-spacing: 0.01em;
    font-weight: 600;
    white-space: nowrap;
    color: var(--stage-cue, #d8b46a);
    display: none;
  }

  .label[data-visible='true'] {
    display: block;
  }

  @media (prefers-reduced-motion: reduce) {
    .voice-pill,
    .wave,
    .bar {
      transition: none;
    }
  }

  @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
    .voice-pill {
      background: var(--stage-chrome-bg-solid, rgb(12 14 18 / 92%));
    }
  }
</style>
