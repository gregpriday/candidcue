<!--
  What an iPad over Sidecar will not tell you (shared/sidecar.ts).

  ---------------------------------------------------------------------------
  A LIST OF REMINDERS, NOT A LIST OF RESULTS
  ---------------------------------------------------------------------------
  Everything on this panel except the first line is invisible to CandidCue.
  Whether the iPad is extending or mirroring, whether the link is wireless,
  whether the sidebar is showing, whether a Focus is on — macOS hands us a
  name, a pixel size and a scale factor, and nothing else.

  So the panel draws two shapes and never mixes them. One line is a STATEMENT,
  because there is real evidence behind it. The rest are TICKS: the presenter
  confirms them, and a tick is a note to themselves. Rendering an unverifiable
  item with a status pill would turn a reminder into an assurance, and the
  moment somebody trusts the assurance they stop checking the thing that is
  about to end their take.

  The ticks are deliberately NOT persisted. A stored tick is a claim about a rig
  that changes every time the iPad is picked up, and re-reading it a week later
  would be the app asserting something no code ever checked. They live for one
  sitting: the host may hold them (`bind:ticked`) so that stepping away to the
  safe-area step and back does not wipe them, and they go when the host does.
-->
<script lang="ts">
  import Button from './Button.svelte';
  import Icon from './Icon.svelte';
  import StatusPill from './StatusPill.svelte';
  import type { DisplayShape } from '../../shared/optical-discovery';
  import {
    isLikelySidecarDisplay,
    sidecarChecklist,
    sidecarSafeAreaHint,
    type SidecarCheckId,
  } from '../../shared/sidecar';
  import type { OpticalHardwareKind, SafeAreaInsets } from '../../shared/contracts';

  interface Props {
    /** The panel being calibrated, in the shape discovery uses. */
    display?: DisplayShape | null;
    /**
     * What the profile says this rig is.
     *
     * A presenter who picked "iPad via Sidecar" by hand wins over the geometry
     * test — they can see the rig and it cannot.
     */
    hardwareKind?: OpticalHardwareKind;
    /** The panel in CSS pixels, for the safe-area starting point. */
    viewport?: { widthPx: number; heightPx: number } | null;
    /**
     * Seed the safe-area step from the hint.
     *
     * Optional: without it the figures are still shown, because "the sidebar
     * costs about 64 px" is worth knowing even where nothing can act on it.
     */
    onapplysafearea?: (insets: SafeAreaInsets) => void;
    /**
     * The ticks, when the host keeps them for its sitting. Optional: without a
     * binding they live as long as this component does.
     */
    ticked?: Partial<Record<SidecarCheckId, boolean>>;
    /** The frame last handed to `onapplysafearea`, kept the same way. */
    seeded?: SafeAreaInsets | null;
  }

  let {
    display = null,
    hardwareKind,
    viewport = null,
    onapplysafearea,
    ticked = $bindable({}),
    seeded = $bindable(null),
  }: Props = $props();

  const uid = $props.id();

  const looksLikeSidecar = $derived(isLikelySidecarDisplay(display));
  const applies = $derived(looksLikeSidecar || hardwareKind === 'ipad-sidecar');

  const checks = sidecarChecklist();
  const hint = $derived(sidecarSafeAreaHint(viewport));

  /*
   * `seeded` is what lets the panel say what the button did. Pressing it used
   * to change the profile silently, and the only evidence was two steps away.
   */
  function seedSafeArea(): void {
    onapplysafearea?.(hint.insets);
    seeded = hint.insets;
  }

  /** The edges a seeded frame moved, in words. */
  const seededEdges = $derived.by(() => {
    if (!seeded) return '';
    const edges = (['top', 'bottom', 'left', 'right'] as const)
      .filter((edge) => seeded![edge] > 0)
      .map((edge) => `${percent(seeded![edge])} ${edge}`);
    return edges.length === 0 ? 'no edges' : edges.join(', ');
  });

  const tickable = checks.filter((check) => !check.verifiable);
  const done = $derived(tickable.filter((check) => ticked[check.id] === true).length);

  /*
   * The heading has to be true of the panel in front of it. "This looks like"
   * is honest when the geometry matched; it is a small lie when the presenter
   * chose the hardware themselves and the display gave nothing away.
   */
  const title = $derived(
    looksLikeSidecar ? 'This looks like an iPad over Sidecar' : 'Prompting from an iPad over Sidecar',
  );

  const percent = (fraction: number): string => `${Math.round(fraction * 100)}%`;

  /*
   * Built as one string rather than branched inside the paragraph: the two
   * halves of that sentence end in the same full stop, and a `{:else}` holding
   * a lone "." renders it a space away from the word before it.
   */
  const strips = $derived(
    `They cost roughly ${hint.sidebarPx} px along one side and ${hint.touchBarPx} px along one edge`,
  );
  const hintBody = $derived(
    hint.applies
      ? `${strips} — on this panel, about ${percent(hint.insets.left)} of the width and ${percent(hint.insets.bottom)} of the height.`
      : `${strips}.`,
  );
</script>

{#if applies}
  <section class="sidecar" aria-label="Sidecar checklist">
    <div class="head">
      <h3 class="title">{title}</h3>
      <span class="count" aria-live="polite">
        <StatusPill
          tone={done === tickable.length ? 'accent' : 'neutral'}
          label="{done} of {tickable.length} confirmed"
        />
      </span>
    </div>
    <p class="lead">
      Sidecar makes a fine prompter and an awkward one. CandidCue cannot see any of the settings
      below, so these are reminders you tick — not checks it has run.
    </p>

    <!--
      One column for the mark and one for the words, so every label starts at
      the same x whether its row is a tick or a statement. The labels are the
      list; each reason waits behind its own "Why", so the six things to do read
      as six things to do rather than a page of prose — and the text is still
      in the document for anybody who opens it.
    -->
    <ul class="checks">
      {#each checks as check (check.id)}
        <li class="check">
          {#if check.verifiable}
            <span class="mark seen" aria-hidden="true"><Icon name="check" size={12} /></span>
            <div class="words">
              <p class="label-row">
                <span class="label">{check.label}</span>
                <span class="seen-word">Already true</span>
              </p>
              <details class="why-toggle">
                <summary data-focus="control">How CandidCue knows</summary>
                <p class="why">{check.why}</p>
                {#if check.symptom}
                  <p class="symptom">{check.symptom}</p>
                {/if}
              </details>
            </div>
          {:else}
            <input
              id="{uid}-{check.id}"
              class="mark"
              type="checkbox"
              aria-describedby="{uid}-{check.id}-why"
              checked={ticked[check.id] === true}
              onchange={(event) => (ticked = { ...ticked, [check.id]: event.currentTarget.checked })}
            />
            <div class="words">
              <label class="label" for="{uid}-{check.id}">{check.label}</label>
              <details class="why-toggle">
                <summary data-focus="control">Why</summary>
                <p class="why" id="{uid}-{check.id}-why">{check.why}</p>
                {#if check.symptom}
                  <p class="symptom">{check.symptom}</p>
                {/if}
              </details>
              {#if check.id === 'hide-strips'}
                <!-- Beside the item it qualifies: the figures are what keeping
                     the strips costs, and the button acts on exactly that. -->
                <div class="hint">
                  <p class="hint-head">If you keep the sidebar and the Touch Bar</p>
                  <p class="hint-body">{hintBody}</p>
                  <details class="why-toggle">
                    <summary data-focus="control">Only a starting point</summary>
                    <p class="hint-note">
                      A starting point, not a measurement: nothing tells CandidCue whether the
                      strips are showing or which edges they are on. Adjust the edges on the
                      safe-area step while you watch the frame on the glass.
                    </p>
                  </details>
                  {#if onapplysafearea && hint.applies}
                    <div class="hint-action">
                      <Button size="sm" onclick={seedSafeArea}>Start the safe area here</Button>
                      <span class="seeded" role="status">
                        {#if seeded}
                          <Icon name="check" size={12} />
                          Frame set to {seededEdges} — check it on the safe-area step.
                        {/if}
                      </span>
                    </div>
                  {/if}
                </div>
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  /* One white surface with a border all the way round it, on the paper of
     the step — the leading rule on the heading is an inset bar rather than a
     one-sided border (owner rule). */
  .sidecar {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-panel);
    min-width: 0;
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
  }
  .count {
    flex: 0 0 auto;
    display: inline-flex;
  }

  .title {
    position: relative;
    margin: 0;
    padding-left: var(--space-3);
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    font-weight: 650;
    color: var(--text-primary);
  }
  .title::before {
    content: '';
    position: absolute;
    left: 0;
    top: calc(var(--divider-w) * 2);
    bottom: calc(var(--divider-w) * 2);
    width: calc(var(--divider-w) * 3);
    border-radius: var(--radius-pill);
    background: var(--accent);
  }

  .lead {
    margin: 0;
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-secondary);
    max-width: var(--prose-measure-narrow);
  }

  .checks {
    list-style: none;
    margin: var(--space-1) 0 0;
    padding: var(--space-3) 0 0;
    border-top: 1px solid var(--border-faint);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .check {
    display: grid;
    grid-template-columns: var(--space-5) minmax(0, 1fr);
    column-gap: var(--space-3);
    align-items: start;
    min-width: 0;
  }

  /* The box and the statement's tick share one column and one top line,
     level with the first line of the label. */
  .mark {
    width: var(--space-4);
    height: var(--space-4);
    margin: 1px 0 0;
    cursor: pointer;
  }
  .mark.seen {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: var(--success);
    color: var(--accent-contrast);
    cursor: default;
  }

  .words {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  /* "Why": a quiet text toggle under the label, the reason opening beneath
     it. Native <details>, so the reason is in the document either way. */
  .why-toggle {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .why-toggle summary {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    min-height: var(--space-6);
    list-style: none;
    cursor: pointer;
    font-size: var(--text-2xs);
    font-weight: 600;
    color: var(--text-muted);
    text-decoration: underline;
    text-decoration-color: var(--border-strong);
    text-underline-offset: 3px;
  }
  .why-toggle summary::-webkit-details-marker {
    display: none;
  }
  .why-toggle summary:hover {
    color: var(--text-primary);
  }
  .why-toggle[open] summary {
    color: var(--text-secondary);
  }

  .label-row {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 2px var(--space-2);
    margin: 0;
  }

  .label {
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    font-weight: 600;
    color: var(--text-primary);
    min-width: 0;
    cursor: pointer;
  }
  .label-row .label {
    cursor: default;
  }

  .seen-word {
    font-size: var(--text-2xs);
    font-weight: 600;
    color: var(--success);
  }

  .why {
    margin: 0;
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-secondary);
    max-width: var(--prose-measure-narrow);
  }

  /* What the app would notice, and when. Quieter than the reason, because it is
     never the reason to act — by the time it shows, the take is spent. */
  .symptom {
    margin: 0;
    font-size: var(--text-2xs);
    line-height: var(--lh-meta);
    color: var(--text-muted);
    max-width: var(--prose-measure-narrow);
  }

  /*
   * What keeping the strips costs, and the button that acts on it, under the
   * item it qualifies. A tinted block rather than a bordered card, so it is a
   * region of the panel and not a frame inside a frame.
   */
  .hint {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    margin-top: var(--space-2);
    padding: var(--space-3);
    border-radius: var(--radius-sm);
    background: var(--bg-sunken);
  }

  .hint-head {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    font-weight: 600;
    color: var(--text-primary);
  }

  .hint-body {
    margin: 0;
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-secondary);
    max-width: var(--prose-measure-narrow);
  }

  /* The caveat is a qualification, not a warning, so it reads in the quiet
     tone — set in the accent it looked like an error message. */
  .hint-note {
    margin: 0;
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-muted);
    max-width: var(--prose-measure-narrow);
  }

  .hint-action {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    padding-top: var(--space-2);
  }
  .seeded {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--success);
  }
</style>
