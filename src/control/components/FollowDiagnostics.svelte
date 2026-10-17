<!--
  "Why did it move?" and the diagnostics timeline (companion §64, §65).

  Kept behind a disclosure so the calm default UI is untouched. The movement
  records are always available — they are the answer to the only question a
  presenter asks about a teleprompter that moved oddly. The full timeline
  (assist dispositions, budget breaches) appears when developer
  diagnostics are switched on in Settings, per primary §15.2.

  Text is redacted by default (§57.3): records carry ids, scores, states, and
  timings — never script or transcript content.
-->
<script lang="ts">
  import Button from './Button.svelte';
  import Disclosure from './Disclosure.svelte';
  import { describeMovement, formatSessionTime } from '../lib/follow-language';
  import { smoothFollow, type SmoothFollowState } from '../stores/smooth-follow';

  interface Props {
    follow: SmoothFollowState;
    /** §15.2 developer mode — reveals the full §64 timeline. */
    developerMode?: boolean;
  }
  let { follow, developerMode = false }: Props = $props();

  let exportNote = $state('');
  /**
   * The export, shown for copying by hand when the clipboard refused it.
   *
   * This replaced a blob download whose note said "Saved as a JSON file." on
   * nothing more than `anchor.click()` not throwing — a click that WKWebView is
   * free to ignore, so the note could describe a file that never existed. The
   * record still must not be trapped in the window, and text the operator can
   * select is the one fallback whose success they can see for themselves.
   */
  let manualPayload = $state<string | null>(null);
  /**
   * Which copy is allowed to report. Only the newest one is: a slow, older
   * `writeText` settling after a newer one would otherwise replace its result
   * with an older snapshot, and one settling after a session change would
   * describe the previous take under the next.
   */
  let copyRequest = 0;

  /*
   * The note and the fallback describe ONE export of ONE take, so a new session
   * clears them. A normal take mounts this afresh (ending one navigates away
   * from Live), so this is what keeps the component honest when an instance IS
   * handed a second session rather than the path every take takes. Keyed on a
   * derived because the `follow` prop is a fresh object on every snapshot, and
   * an effect reading it directly would wipe the note within a frame of writing
   * it.
   */
  const sessionId = $derived(follow.sessionId);
  $effect(() => {
    void sessionId;
    copyRequest += 1;
    exportNote = '';
    manualPayload = null;
  });

  const lastExplanation = $derived(follow.lastMovement ? describeMovement(follow.lastMovement) : null);
  /** Newest first — the interesting record is always the most recent one. */
  const recentMovements = $derived([...follow.movements].reverse().slice(0, 12));
  /**
   * The history UNDER the lead, without it. The newest record is the lead
   * explanation above, and listing it again first put the same headline on
   * screen twice, one line apart.
   */
  const earlierMovements = $derived(
    follow.lastMovement !== null && recentMovements[0]?.seq === follow.lastMovement.seq
      ? recentMovements.slice(1)
      : recentMovements,
  );
  const recentTimeline = $derived([...follow.timeline].reverse().slice(0, 40));

  async function copyDiagnostics(): Promise<void> {
    const request = ++copyRequest;
    // Cleared first so a retry that ends the same way still changes the status
    // region — an identical string is no update, and a screen reader hears nothing.
    exportNote = '';
    const payload = JSON.stringify(smoothFollow.exportDiagnostics(), null, 2);
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard) {
        throw new Error('clipboard unavailable');
      }
      await navigator.clipboard.writeText(payload);
      if (request !== copyRequest) return;
      manualPayload = null;
      exportNote = 'Copied. Paste it into a bug report — it contains no script or transcript text.';
    } catch {
      if (request !== copyRequest) return;
      manualPayload = payload;
      exportNote =
        'Could not copy to the clipboard. Select the text below and copy it — it contains no script or transcript text.';
    }
  }
</script>

<Disclosure label="Why did it move?">
  <div class="follow-diagnostics">
    {#if lastExplanation}
      <div class="last">
        <p class="headline">{lastExplanation.headline}</p>
        <p class="detail">{lastExplanation.detail}</p>
      </div>
    {:else}
      <p class="empty">
        No movement decisions recorded yet. Ordinary steady reading is not logged — only
        corrections, retakes, skips, and holds.
      </p>
    {/if}

    <!--
      The export comes straight after the answer, before the history. It is
      the one thing in here somebody does on purpose — for a bug report, often
      mid-take — and it used to sit under forty timeline rows, with its
      fallback further down still.
    -->
    <div class="export">
      <div class="actions">
        <Button size="sm" onclick={() => void copyDiagnostics()}>Copy diagnostics</Button>
        <!-- Always mounted, so the result is announced: focus stays on the button. -->
        <span class="note" class:failed={manualPayload !== null} role="status">{exportNote}</span>
      </div>
      {#if manualPayload !== null}
        <textarea
          class="manual-export"
          aria-label="Follow diagnostics export"
          readonly
          rows="6"
          wrap="off"
          value={manualPayload}
          onfocus={(event) => event.currentTarget.select()}
        ></textarea>
      {/if}
    </div>

    {#if earlierMovements.length > 0}
      <div class="history">
        <p class="section-label">Earlier</p>
        <ol class="records">
          {#each earlierMovements as record (`${record.seq}-${record.audioMs}`)}
            {@const explanation = describeMovement(record)}
            <li class="record">
              <p class="record-head">
                <span class="stamp">{formatSessionTime(record.audioMs)}</span>
                <span class="record-summary">{explanation.headline}</span>
              </p>
              <ul class="facts">
                {#each explanation.facts as fact (fact.label)}
                  <li><span class="fact-label">{fact.label}</span> {fact.value}</li>
                {/each}
              </ul>
            </li>
          {/each}
        </ol>
      </div>
    {/if}
    {#if recentMovements.length > 0}
      <p class="bounded">
        Showing the most recent {recentMovements.length} of {follow.movements.length} kept records.
      </p>
    {/if}

    {#if developerMode}
      <div class="timeline">
        <p class="section-label">Timeline</p>
        <ol>
          {#each recentTimeline as entry (entry.seq)}
            <li class="entry {entry.kind}">
              <span class="entry-meta">
                <span class="stamp">
                  {entry.sessionTimeMs === null ? '—' : formatSessionTime(entry.sessionTimeMs)}
                </span>
                <span class="entry-kind">{entry.kind}</span>
              </span>
              <span class="entry-summary">
                {entry.summary}
                {#if entry.detail}<span class="entry-detail">{entry.detail}</span>{/if}
              </span>
            </li>
          {/each}
        </ol>
        <p class="bounded">
          Timeline holds the most recent {follow.timeline.length} entries · {follow.counts.frames} frames
          · {follow.counts.acks} stage reports.
        </p>
      </div>
    {:else}
      <p class="bounded">
        Turn on developer diagnostics in Settings → Following to see the full timeline of frames,
        stage reports, and assist decisions.
      </p>
    {/if}
  </div>
</Disclosure>

<style>
  .follow-diagnostics {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    min-width: 0;
  }

  .last {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .headline {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 650;
    color: var(--text-primary);
    text-wrap: pretty;
  }
  .detail,
  .empty,
  .bounded,
  .note {
    margin: 0;
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-muted);
    text-wrap: pretty;
  }
  .detail {
    color: var(--text-secondary);
  }

  .export {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  /* The result under its button, full width: beside it, a refusal wrapped
     into five lines of a column narrower than the words it was explaining. */
  .actions {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-2);
  }
  .note {
    max-width: 100%;
  }
  /* A refusal reads as one: the words are the signal, the colour backs them. */
  .note.failed {
    color: var(--warning);
  }

  .history {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .records {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .record {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-faint);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
  }
  .record-head {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
  }
  .record-summary {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-primary);
    text-wrap: pretty;
  }
  .stamp {
    flex: 0 0 auto;
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .facts {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 2px var(--space-3);
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-secondary);
  }
  .fact-label {
    color: var(--text-faint);
  }

  .section-label {
    margin: 0;
    font-size: var(--text-2xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: var(--ls-caps);
    color: var(--text-muted);
  }

  /*
   * No scroller of its own. The drawer's body scrolls, and a second scroller
   * inside it cut entries in half at its edge — a row showing its detail with
   * no time and no kind above it.
   */
  .timeline {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .timeline ol {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  /* Stacked, not three narrow columns: "MOVEMENT" ran into its own summary. */
  .entry {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: var(--space-2) 0;
    border-top: 1px solid var(--border-faint);
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-secondary);
  }
  .entry:first-child {
    border-top: none;
    padding-top: 0;
  }
  .entry-meta {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
  }
  .entry-kind {
    font-size: var(--text-2xs);
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: var(--ls-caps);
  }
  .entry-summary {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .entry-detail {
    display: block;
    color: var(--text-muted);
  }

  .manual-export {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    padding: var(--space-2);
    border: 1px solid var(--border-control);
    border-radius: var(--radius-sm);
    background: var(--bg-sunken);
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    line-height: 1.5;
    white-space: pre;
    overflow: auto;
  }
  /* Quiet focus: a border shift, never an accent ring on a field. */
  .manual-export:focus-visible {
    outline: none;
    border-color: var(--focus-quiet);
  }
</style>
