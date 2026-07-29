<!--
  Notes on how a script will read out loud — the advisory lint from
  `lib/script-lint.ts`, surfaced in the editor rail.

  Advisory means advisory, and the surface has to say so before the copy does.
  There is no badge, no severity colour, nothing that reads as stop, and no
  path from here into Present. A presenter who is about to record must never be
  argued with about prose, so the loudest this is ever allowed to be is a
  collapsed row saying how many notes there are — and when there are none it
  renders nothing at all. A standing "0 notes" row is still an accusation that
  the script is being marked.

  The disclosure is written here rather than reused from `Disclosure.svelte`
  because that one carries the settings page's rhythm and owns its own
  horizontal edges. The rail needs a full-bleed seam (to match `.panel-foot`
  above the compile status) with its text inset to the rail's 16px gutter, and
  reaching in to move those from outside would mean styling another component's
  private class names. Same `<details>`, same chevron, rail density.
-->
<script lang="ts">
  import Icon from './Icon.svelte';
  import type { ScriptLintCode, ScriptLintFinding } from '../lib/script-lint';

  interface Props {
    findings: ScriptLintFinding[];
    /** Reveal a finding's run in the editor. */
    ongoto?: (finding: ScriptLintFinding) => void;
  }

  let { findings, ongoto }: Props = $props();

  let expanded = $state(false);

  /*
   * Two words above each note, so an author scanning the list can find the one
   * they already read without reading all of them again. They live here and
   * not in `script-lint.ts` because that file's `message` is the note itself —
   * a colleague's sentence, written to be read once — and a rail label is a
   * different job with a different budget.
   *
   * Typed as a total record on purpose: a lint code cannot be added upstream
   * without this failing to compile, which is the only thing standing between
   * a new rule and a row headed `undefined`.
   */
  const LABELS: Record<ScriptLintCode, string> = {
    'long-paragraph': 'Long paragraph',
    'very-long-sentence': 'Long sentence',
    'all-caps-run': 'Run of capitals',
    'no-terminal-punctuation': 'No closing mark',
  };

  const summary = $derived(
    findings.length === 1 ? '1 note on how this reads' : `${findings.length} notes on how this reads`,
  );
</script>

{#if findings.length > 0}
  <section class="lint" aria-label="Reading notes">
    <details bind:open={expanded}>
      <summary class="summary">
        <span class="chevron" class:rotated={expanded}>
          <Icon name="chevron-right" size={14} />
        </span>
        <span>{summary}</span>
      </summary>
      <div class="body">
        <p class="preamble">
          None of this blocks a take. These are the places the script will be hardest to follow
          out loud.
        </p>
        <ul class="findings">
          <!-- Deliberately keyless: two rules can land on the same line, and a
               duplicate key is a thrown error in the middle of someone's
               editor. These rows are static text, so keying buys nothing. -->
          {#each findings as finding}
            <li>
              <button type="button" class="finding" onclick={() => ongoto?.(finding)}>
                <span class="head">
                  <span class="label" class:firm={finding.severity === 'warn'}>
                    {LABELS[finding.code]}
                  </span>
                  <span class="where">line {finding.line}</span>
                </span>
                <span class="message">{finding.message}</span>
                {#if finding.hint}
                  <span class="hint">{finding.hint}</span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      </div>
    </details>
  </section>
{/if}

<style>
  /* Never shrinks: if the rail runs short the outline above it gives up its
     room first, because a note you cannot see is the same as no note. */
  .lint {
    flex: 0 0 auto;
    border-top: 1px solid var(--border);
  }

  .summary {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    cursor: pointer;
    list-style: none;
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-secondary);
    transition:
      background var(--dur-fast) var(--ease-out),
      color var(--dur-fast) var(--ease-out);
  }
  .summary::-webkit-details-marker {
    display: none;
  }
  .summary:hover {
    background: var(--bg-hover-chrome);
    color: var(--text-primary);
  }

  .chevron {
    display: inline-flex;
    flex: 0 0 auto;
    color: var(--text-muted);
    transition: transform var(--dur-med) var(--ease-out);
  }
  .rotated {
    transform: rotate(90deg);
  }

  /* Same text edge as the outline above it: a finding row carries a 10px inset
     for its hover pill, so the container gives that much back rather than
     stacking a second full-width padding on top of it. */
  .body {
    --rail-pill-inset: 10px;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: 0 calc(var(--space-4) - var(--rail-pill-inset)) var(--space-3);
  }

  .preamble {
    margin: 0;
    padding: 0 var(--rail-pill-inset);
    font-size: var(--text-2xs);
    line-height: var(--lh-meta);
    color: var(--text-faint);
  }

  /* Capped rather than left to grow: the rail is one column and the outline is
     the reason it exists. A pixel ceiling (bounded by a viewport fraction for
     short windows) rather than a pure `vh` so the list starts scrolling at the
     same place on a laptop as on a 27-inch panel. */
  .findings {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    max-height: min(260px, 40vh);
    overflow-y: auto;
  }

  .finding {
    display: flex;
    flex-direction: column;
    gap: 3px;
    width: 100%;
    padding: var(--space-2) 10px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    text-align: left;
    transition: background var(--dur-fast) var(--ease-out);
  }
  .finding:hover {
    background: var(--bg-hover-chrome);
  }

  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2);
  }
  /* `warn` is one step of contrast, not a colour that means anything. The lint
     raises its voice by being easier to read, never by turning amber. */
  .label {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-secondary);
  }
  .label.firm {
    color: var(--text-primary);
  }
  .where {
    flex: 0 0 auto;
    font-size: var(--text-2xs);
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }

  .message {
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-muted);
  }
  /* The half the author can act on carries the warm accent — `--accent-strong`
     because small terracotta text needs it to clear AA on the light paper. */
  .hint {
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--accent-strong);
  }
</style>
