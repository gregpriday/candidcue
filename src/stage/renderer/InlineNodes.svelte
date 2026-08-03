<!--
  Safe inline render-node presenter (spec §45.6): hydrates SafeRenderNodes
  into known elements only — never arbitrary HTML. Word segments carry
  data-t="<tokenIndex>" anchors so tracking can position individual tokens.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import type { SafeRenderNode } from '../../shared/contracts';
  import { segmentText } from './text';
  import Self from './InlineNodes.svelte';

  let {
    nodes,
    cursor = null,
    assets = {},
    showCues = true,
    dimFrozen = false,
    dimRollback = false,
    breakAfterTokens = null,
  }: {
    nodes: SafeRenderNode[];
    /**
     * The boundary between spoken and unspoken: word tokens below it get the
     * past treatment. Nothing marks the token itself — see the note on `.past`.
     */
    cursor?: number | null;
    assets?: Record<string, { url: string; mime: string; width?: number; height?: number }>;
    showCues?: boolean;
    /**
     * Alignment is holding, ambiguous or searching: the ramp stays where it is.
     *
     * A cursor is still published while the engine is not following — it is the
     * last position anyone believed — and letting the dimming keep walking
     * through the ramp on it would have the display assert progress the engine
     * has explicitly refused to claim. Motion has honestly stopped, so the
     * styling stops too. It costs nothing when the estimate turns out to be
     * right (the ramp resumes from where it was) and costs the presenter
     * nothing when it was wrong (no words were greyed out under them while
     * nobody knew where they were).
     */
    dimFrozen?: boolean;
    /** Explicit engine withdrawal of a reversible provisional frontier. */
    dimRollback?: boolean;
    /**
     * Spoken tokens after which the line ends, chosen by the line breaker.
     *
     * The break is drawn as a `<br>` immediately after the word's span, and the
     * space that follows is left exactly where it was: a space at the start of
     * a line is collapsed away by ordinary white-space processing, and the
     * stage's prose never sets `pre-wrap` (only `.code` does, which is not
     * planned). Emitting after the WORD rather than in place of the space is
     * what keeps this correct when the two land in different render nodes.
     *
     * Every other space stays breakable, so a plan that misjudged a width by a
     * pixel costs one browser-wrapped line rather than an overflowing one.
     * `null` — no plan — is the pre-existing behaviour, unchanged.
     */
    breakAfterTokens?: ReadonlySet<number> | null;
  } = $props();

  /**
   * How many words behind the cursor the ramp spans before reaching the far
   * past. Four is chosen against the failure it replaces: alignment error of
   * one or two tokens is ordinary, and a step at the boundary turned exactly
   * that error into a word erased out from under the reader. Four steps put
   * the operator's own past opacity a comfortable margin behind the worst
   * ordinary wobble, while still leaving spoken text visibly spoken.
   */
  const DIM_RAMP_WORDS = 4;

  /*
   * The ramp is drawn from a HELD cursor, not the live one.
   *
   * `dimFrozen` says the engine stopped believing in the position; the position
   * itself keeps arriving regardless. Latching it here rather than asking the
   * caller to stop sending one keeps `cursor` meaning the same thing in every
   * state — the best available estimate — and puts the decision not to act on
   * it next to the styling that would have acted.
   *
   * `null` is the one value never held, in either direction, because it is not
   * an estimate that might be wrong: it is this block saying it is not the one
   * the reader is in. Blocks trade that title DURING a hold — the fallback path
   * keeps moving `confirmedToken` after following stops — and both halves of
   * that trade go wrong if `null` is treated as a position:
   *
   *   - the block that inherits the title has only ever seen `null`, so unless
   *     it is allowed to latch the first real cursor it is handed, it has
   *     nothing to hold and walks the live one instead. That is the ramp
   *     advancing through a hold, which is the whole thing this flag exists to
   *     stop, on the one block the presenter is actually reading.
   *   - the block that loses it would otherwise keep per-word past opacity
   *     frozen on, underneath the whole-block past zoning it just gained. Two
   *     opacities multiply, so its tail would go visibly darker than the past
   *     around it.
   *
   * On the server there is no effect and so nothing is ever latched, which is
   * why the derivation falls through to the live cursor: for a single render,
   * refusing to dim at all would be a bigger lie than a fresh ramp.
   *
   * The latch is read back through `untrack` because it is this effect's own
   * memory rather than an input — tracked, every latch would invalidate the
   * effect that wrote it and run the whole thing twice per token.
   */
  /**
   * How long the frontier must sit behind its own latch before it retreats.
   *
   * The cursor is a whole token taken from a CONTINUOUS position, so it chatters
   * across every token boundary: the tracker's lead margin fades in and out at
   * each Following↔Holding edge, and the plant's approach is not monotone at
   * sub-token scale. Every chatter re-BRIGHTENED a word that had already gone
   * grey behind the presenter, and Tier C measured it at 213 corrections per
   * thousand words — a word flickering back roughly every fifth word spoken.
   *
   * Two cheaper fixes were measured and rejected. A monotone ratchet removed the
   * flicker and made an overshoot PERMANENT: never-spoken unread exposure went
   * 0.55 → 2.78 word-seconds, because the engine came back and the glass did
   * not. A one-token spatial deadband halved that and still carried it, because
   * a deadband wide enough to reject the noise is wide enough to hold a real
   * one-token overshoot.
   *
   * The property that separates noise from a real retreat is DURATION, not
   * distance: chatter is frames long, and a reader backing up to re-read takes
   * the better part of a second. So a retreat is honoured at any distance once it
   * has lasted this long. 80 ms is comfortably more than a frame at 30 Hz (33 ms)
   * and far less than any retreat a person can produce.
   */
  const DIM_RETREAT_DEBOUNCE_MS = 80;

  let heldCursor = $state<number | null>(null);
  /** When the live cursor first fell behind `heldCursor`; null while it has not. */
  let retreatSince: number | null = null;
  $effect(() => {
    const live = cursor;
    if (dimRollback) {
      /*
       * An explicit engine withdrawal outranks the debounce below, and the two
       * arrived from different branches, so the precedence is worth stating.
       * `provisional_retracted` is the engine saying a speculative frontier was
       * WRONG — that is a real retreat with authority behind it, not the
       * sub-token chatter the duration test exists to reject, so it must not be
       * made to wait one out.
       *
       * The pending window is cleared with it. Leaving it set would let the next
       * ordinary retreat inherit a clock started before a frontier that no longer
       * exists, and fire early by up to the whole window.
       */
      retreatSince = null;
      heldCursor = live;
      return;
    }
    if (dimFrozen && live !== null && untrack(() => heldCursor) !== null) return;
    const held = untrack(() => heldCursor);
    if (live === null || held === null) {
      retreatSince = null;
      heldCursor = live;
      return;
    }
    const liveToken = wholeToken(live);
    const heldToken = wholeToken(held);
    if (liveToken === null || heldToken === null || liveToken >= heldToken) {
      retreatSince = null;
      heldCursor = live;
      return;
    }
    // Behind the latch. Hold the old frontier until the retreat has persisted;
    // `performance.now` rather than a frame count so the window means the same
    // thing at 30 and 120 Hz.
    const now = performance.now();
    retreatSince ??= now;
    if (now - retreatSince >= DIM_RETREAT_DEBOUNCE_MS) {
      retreatSince = null;
      heldCursor = live;
    }
  });

  /**
   * `data-dim` is a key into the stylesheet, not a number anyone reads, so a
   * step outside the ramp is not a wrong shade — it is no shade at all, and the
   * word drops straight through to `.past`, which is the hard boundary this
   * replaced. The cursor is pinned to a whole token here rather than trusted to
   * arrive as one, and arithmetic that came out non-finite is treated as no
   * cursor: the honest answer to not knowing where the reader is, is to mark
   * nothing.
   */
  function wholeToken(at: number | null): number | null {
    if (at === null || !Number.isFinite(at)) return null;
    /*
     * FLOOR, not round.
     *
     * `Math.round` is symmetric, so for half of every token the frontier claimed
     * a word the estimate had not actually passed. That half-token was invisible
     * in every benchmark that scored the engine's position — it is created here,
     * in the renderer — and Tier C found it while sweeping the tracker's lead
     * margin: the gaze-weighted "never spoken at all" exposure refused to come
     * down at ANY margin, because shrinking the trailing distance simply moved
     * more of the distribution into the half where rounding overshoots. The
     * margin was paying for the rounding.
     *
     * Flooring makes the claim conservative by construction: a word is marked
     * passed only once the estimate is wholly beyond it. It costs up to half a
     * token of dimming latency and let the tracker give back three times that
     * (`lead_margin_atoms` 1.6 → 1.0), so the trade is strongly positive in both
     * directions at once — less unread ink AND faster dimming.
     */
    return Math.floor(at);
  }
  const dimCursor = $derived(wholeToken(dimFrozen && heldCursor !== null ? heldCursor : cursor));

  /**
   * How many words behind the ramp cursor this token sits, capped at the depth
   * of the ramp. `null` is "at or after the cursor" — no claim at all.
   */
  function dimStep(tokenIndex: number): number | null {
    const at = dimCursor;
    if (at === null) return null;
    const behind = at - tokenIndex;
    if (behind <= 0) return null;
    return behind < DIM_RAMP_WORDS ? behind : DIM_RAMP_WORDS;
  }

  function markClasses(marks?: ('strong' | 'em' | 'strike' | 'code')[]): string {
    if (!marks || marks.length === 0) return '';
    return marks.map((m) => `m-${m}`).join(' ');
  }
</script>

{#each nodes as node}
  {#if node.type === 'text'}
    {#each segmentText(node.text, node.tokenIndexes) as seg}
      {#if seg.space}
        <span class="sp">{seg.text}</span>
      {:else if seg.tokenIndex !== null}
        <span
          class="w {markClasses(node.marks)}"
          class:past={dimCursor !== null && seg.tokenIndex < dimCursor}
          data-dim={dimStep(seg.tokenIndex)}
          data-t={seg.tokenIndex}>{seg.text}</span
        >{#if breakAfterTokens?.has(seg.tokenIndex)}<br data-planned-break="1" />{/if}
      {:else}
        <span class="w {markClasses(node.marks)}">{seg.text}</span>
      {/if}
    {/each}
  {:else if node.type === 'line_break'}
    <br />
  {:else if node.type === 'link'}
    <!-- Links are inert on stage: label only, never navigable. -->
    <span class="link"><Self nodes={node.label} {cursor} {assets} {showCues} {dimFrozen} {dimRollback} {breakAfterTokens} /></span>
  {:else if node.type === 'image'}
    {#if assets[node.assetId]}
      <img class="inline-img" src={assets[node.assetId]?.url} alt={node.alt} draggable="false" />
    {:else}
      <!-- Unresolved asset: readable alt text rather than a silent hole. -->
      <span class="img-fallback">{node.alt || 'Image unavailable'}</span>
    {/if}
  {:else if node.type === 'table'}
    <!-- A table nested in inline flow (a stage-only or quoted block that wraps
         one) still renders as rows, not as nothing. -->
    <table class="inline-table">
      <tbody>
        {#each node.rows as row}
          <tr>
            {#each row as cell, colIndex}
              <td style:text-align={node.align[colIndex] ?? 'left'}>
                <Self nodes={cell} {assets} {showCues} />
              </td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  {:else if node.type === 'cue'}
    {#if showCues}
      <span class="cue" data-cue-type={node.cueType}>{node.label}</span>
    {/if}
  {/if}
{/each}

<style>
  /* Per-word past dimming. The opacity below is how the presenter sees where
     they are and never changes; the tween is a §61 nonessential effect and is
     zeroed by `--stage-fx-ms` on the script layer while frames are being
     missed — this is the biggest single win of the three, because it is one
     interpolation per rendered WORD. The ramp below moves four words per cursor
     advance where the old step moved one, but it is the same property on the
     same elements, so the one degraded rule still takes all of them off at
     once. */
  /*
   * 240ms, and it was MEASURED down to 150 and put back.
   *
   * The reasoning for shortening it was sound as far as it went: the perceived
   * moment of an opacity change sits near the onset rather than the completion,
   * an ease-out puts its largest delta first, and published guidance for a
   * subtle state change that must feel immediate lands at 100-150ms. Tier C
   * agreed about the benefit — at 150ms `ink.first_response_p50` fell 697 -> 617
   * and `ink.half_dim_p50` 1091 -> 986, so roughly 90ms of real dim latency.
   *
   * It also showed what the number is actually FOR, which the guidance could not
   * know: the tween absorbs the frontier's residual chatter. A word that dims and
   * is then corrected travels less far before the correction lands, so a longer
   * fade hides a wobble that a shorter one completes. At 150ms
   * `ink.corrections_per_1k` went 294 -> 427 and the gaze-weighted never-spoken
   * safety gate 2.903 -> 3.278 word-seconds — 45% more words flickering back, and
   * a 13% worse safety gate, for 90ms.
   *
   * Safety is lexicographically first here, and 45% more flicker also undoes over
   * half of what `DIM_RETREAT_DEBOUNCE_MS` had just bought (315 -> 227). So this
   * stays at 240: it is not decoration, it is part of the anti-flicker mechanism.
   * Latency is bought from `lead_margin_atoms`, where it is a tracking choice
   * rather than a legibility one.
   *
   * `cc_bench::stage::DIM_TWEEN_MS` is the Tier-C port of this number, and
   * `crates/cc-bench/tests/tween_parity.rs` fails if the two drift apart.
   */
  .w {
    transition-property: opacity;
    transition-duration: var(--stage-fx-ms, 240ms);
    transition-timing-function: var(--ease-out, ease-out);
  }
  /*
   * The dimming is the ONLY per-word state, and deliberately so.
   *
   * There used to be an underline on the token at the cursor, justified as
   * proof the take was alive. In use it read as a claim — "you are here, on
   * this word" — that alignment cannot honestly make: the estimate is a
   * position on a continuous axis, not a word, and every one of its ordinary
   * wobbles became a mark twitching under the reader's eye. Being told you
   * are somewhere you are not is worse than being told nothing.
   *
   * Dimming makes the weaker claim on purpose. It marks a boundary rather
   * than a word, so an estimate that is a token or two off shades one extra
   * word slightly grey instead of pointing confidently at the wrong one, and
   * it degrades quietly as certainty drops. Liveness comes from the scroll,
   * which is continuous and cannot lie about precision it does not have.
   *
   * If a current-word cue is ever wanted again, it needs to carry the
   * engine's confidence in its treatment — not assert a single token.
   *
   * That argument also condemns a HARD boundary, which is what this used to be.
   * A single step made the edge as brittle as the pointer it replaced: one
   * token of ordinary alignment error dropped a word to the far past while the
   * presenter was still saying it, and a word at 0.42 opacity in the middle of
   * a line you are reading is worse than no marking at all. `data-dim` grades
   * the same boundary over four words, so that error now costs a shade nobody
   * notices instead of erasing a word, and the deepest step is only reached
   * once the reader is genuinely clear of it.
   *
   * The steps are an attribute plus stylesheet rules rather than an inline
   * opacity per word, and that is load-bearing twice over: the values stay
   * reachable from one place above (they are custom properties on an inherited
   * subtree, which is how §61 and the operator's own settings reach them at
   * all), and the styling tick stays a class/attribute write rather than a
   * per-word style mutation on every rendered word.
   */
  .w.past {
    opacity: var(--stage-past-opacity, 0.42);
  }
  /*
   * The ramp, counted backwards from the boundary. `data-dim="4"` has no rule
   * of its own on purpose: four words back IS the far past, so it falls through
   * to `.past` and there stays exactly ONE binding to the operator's setting.
   * These match `.w.past` on specificity, so they have to stay below it.
   *
   * Every step is floored at that same setting, because `pastOpacity` is not
   * only a taste dial: turning past dimming off is encoded as 0.92, and a fixed
   * ladder would then have dimmed the four words behind the cursor MORE than
   * the rest of the spoken script — the display quietly overruling a setting
   * the operator went and switched off.
   */
  .w[data-dim='3'] {
    opacity: max(var(--stage-past-opacity, 0.42), var(--stage-dim-3, 0.52));
  }
  .w[data-dim='2'] {
    opacity: max(var(--stage-past-opacity, 0.42), var(--stage-dim-2, 0.64));
  }
  .w[data-dim='1'] {
    opacity: max(var(--stage-past-opacity, 0.42), var(--stage-dim-1, 0.78));
  }
  .m-strong {
    font-weight: 700;
  }
  .m-em {
    font-style: italic;
  }
  .m-strike {
    text-decoration: line-through;
  }
  /*
   * THE SECONDARY-TEXT FLOOR.
   *
   * Everything below that a presenter has to READ is floored at
   * `--stage-secondary-min`, an absolute pixel size the script layer resolves
   * from the rig's optics (`secondaryTextFloorPx`). The em value stays as the
   * proportion we want; the floor is what stops that proportion from taking
   * the text under the angular size at which reading works.
   *
   * It has to be absolute, and it has to be a floor rather than a size, for the
   * same reason: `em` compounds. A cue inside a silent block inside a table is
   * three multiplications away from the body size, and each of those factors
   * was chosen on its own against body text. The measured px value does not
   * care how deep it is nested.
   */
  .m-code {
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: max(var(--stage-secondary-min, 0.67em), 0.92em);
  }
  .link {
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, currentColor 40%, transparent);
    text-underline-offset: 0.14em;
  }
  .inline-img {
    max-width: 100%;
    max-height: var(--stage-image-max-h, 78vh);
    border-radius: 12px;
    display: block;
    margin: 0.4em auto;
  }
  .img-fallback {
    color: color-mix(in srgb, currentColor 70%, transparent);
    font-style: italic;
  }
  .inline-table {
    border-collapse: collapse;
    font-size: max(var(--stage-secondary-min, 0.67em), 0.85em);
  }
  .inline-table td {
    padding: 0.2em 0.5em;
    vertical-align: baseline;
  }
  /* An inline cue is an instruction to the performer — "beat", "to camera" —
     read at the same distance as the line it sits in. 0.55em was a chip drawn
     for a laptop screen; two thirds of body is the point at which it still
     reads as an aside without becoming decoration. */
  .cue {
    color: var(--stage-cue);
    font-size: max(var(--stage-secondary-min, 0.67em), 0.67em);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    vertical-align: middle;
    padding: 0.1em 0.55em;
    border-radius: 999px;
    background: color-mix(in srgb, var(--stage-cue) 12%, transparent);
    white-space: nowrap;
  }
</style>
