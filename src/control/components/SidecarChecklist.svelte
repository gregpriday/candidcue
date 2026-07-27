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
  would be the app asserting something no code ever checked. They live for as
  long as the panel is open, which is exactly as long as they mean anything.
-->
<script lang="ts">
  import Button from './Button.svelte';
  import Disclosure from './Disclosure.svelte';
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
  }

  let { display = null, hardwareKind, viewport = null, onapplysafearea }: Props = $props();

  const looksLikeSidecar = $derived(isLikelySidecarDisplay(display));
  const applies = $derived(looksLikeSidecar || hardwareKind === 'ipad-sidecar');

  const checks = sidecarChecklist();
  const hint = $derived(sidecarSafeAreaHint(viewport));

  /** Ticks for this sitting only — see the note at the top of the file. */
  let ticked = $state<Partial<Record<SidecarCheckId, boolean>>>({});
  let open = $state(true);

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
      <StatusPill
        tone={done === tickable.length ? 'accent' : 'neutral'}
        label="{done} of {tickable.length} confirmed"
      />
    </div>
    <p class="lead">
      Sidecar makes a fine prompter and an awkward one. CandidCue cannot see any of the settings
      below, so these are reminders you tick — not checks it has run.
    </p>

    <Disclosure label="What Sidecar will not tell CandidCue" bind:open>
      <ul class="checks">
        {#each checks as check (check.id)}
          <li class="check">
            {#if check.verifiable}
              <div class="seen-head">
                <span class="label">{check.label}</span>
                <StatusPill tone="success" label="Already true" />
              </div>
            {:else}
              <label class="tick">
                <input
                  type="checkbox"
                  checked={ticked[check.id] === true}
                  onchange={(event) => (ticked[check.id] = event.currentTarget.checked)}
                />
                <span class="label">{check.label}</span>
              </label>
            {/if}
            <p class="why">{check.why}</p>
            {#if check.symptom}
              <p class="symptom">{check.symptom}</p>
            {/if}
          </li>
        {/each}
      </ul>
    </Disclosure>

    <div class="hint">
      <p class="hint-head">If you keep the sidebar and the Touch Bar</p>
      <p class="hint-body">{hintBody}</p>
      <p class="hint-note">
        A starting point, not a measurement: nothing tells CandidCue whether the strips are showing
        or which edges they are on. The frame you drag on the glass is the real answer.
      </p>
      {#if onapplysafearea && hint.applies}
        <div class="hint-action">
          <Button size="sm" onclick={() => onapplysafearea?.(hint.insets)}>
            Start the safe area here
          </Button>
        </div>
      {/if}
    </div>
  </section>
{/if}

<style>
  /* One rounded surface with a border all the way round it — the leading rule
     on the heading is an inset bar rather than a one-sided border (owner rule). */
  .sidecar {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-secondary);
    min-width: 0;
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
  }

  .title {
    position: relative;
    margin: 0;
    padding-left: 10px;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    font-weight: 600;
    color: var(--text-primary);
  }
  .title::before {
    content: '';
    position: absolute;
    left: 0;
    top: 2px;
    bottom: 2px;
    width: 2px;
    border-radius: var(--radius-pill);
    background: var(--accent);
  }

  .lead {
    margin: 0;
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-muted);
    max-width: var(--prose-measure-narrow);
  }

  .checks {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .check {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }

  .tick {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    cursor: pointer;
  }
  .tick input {
    flex: 0 0 auto;
  }

  .seen-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .label {
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    font-weight: 600;
    color: var(--text-primary);
    min-width: 0;
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
    color: var(--text-faint);
    max-width: var(--prose-measure-narrow);
  }

  .hint {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
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

  /* The half the presenter can act on carries the warm accent —
     `--accent-strong` because small terracotta text needs it to clear AA on the
     light paper. */
  .hint-note {
    margin: 0;
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--accent-strong);
    max-width: var(--prose-measure-narrow);
  }

  .hint-action {
    display: flex;
    padding-top: var(--space-2);
  }
</style>
