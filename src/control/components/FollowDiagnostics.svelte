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

  /*
   * Both describe ONE export of ONE take. Live outlives a session ("Present
   * again" builds the next take inside it), so without this a "Copied." from
   * the last take would sit under the next one. Keyed on a derived because the
   * `follow` prop is a fresh object on every snapshot, and an effect reading it
   * directly would wipe the note within a frame of writing it.
   */
  const sessionId = $derived(follow.sessionId);
  $effect(() => {
    void sessionId;
    exportNote = '';
    manualPayload = null;
  });

  const lastExplanation = $derived(follow.lastMovement ? describeMovement(follow.lastMovement) : null);
  /** Newest first — the interesting record is always the most recent one. */
  const recentMovements = $derived([...follow.movements].reverse().slice(0, 12));
  const recentTimeline = $derived([...follow.timeline].reverse().slice(0, 40));

  async function copyDiagnostics(): Promise<void> {
    const payload = JSON.stringify(smoothFollow.exportDiagnostics(), null, 2);
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard) {
        throw new Error('clipboard unavailable');
      }
      await navigator.clipboard.writeText(payload);
      manualPayload = null;
      exportNote = 'Copied. Paste it into a bug report — it contains no script or transcript text.';
    } catch {
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

    {#if recentMovements.length > 0}
      <ol class="records">
        {#each recentMovements as record (`${record.seq}-${record.audioMs}`)}
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
              <span class="stamp">
                {entry.sessionTimeMs === null ? '—' : formatSessionTime(entry.sessionTimeMs)}
              </span>
              <span class="entry-kind">{entry.kind}</span>
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

    <div class="actions">
      <Button size="sm" onclick={() => void copyDiagnostics()}>Copy diagnostics</Button>
      {#if exportNote}<span class="note">{exportNote}</span>{/if}
    </div>
    {#if manualPayload !== null}
      <textarea
        class="manual-export"
        aria-label="Follow diagnostics export"
        readonly
        rows="6"
        value={manualPayload}
        onfocus={(event) => event.currentTarget.select()}
      ></textarea>
    {/if}
  </div>
</Disclosure>

<style>
  .follow-diagnostics {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
  }

  .headline {
    margin: 0;
    font-size: var(--text-xs);
    font-weight: 650;
    color: var(--text-primary);
  }
  .detail,
  .empty,
  .bounded,
  .note {
    margin: 0;
    font-size: var(--text-2xs);
    line-height: 1.5;
    color: var(--text-muted);
  }

  .records,
  .timeline ol {
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
    gap: 2px;
    padding: var(--space-2);
    border: 1px solid var(--border-faint);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
  }
  .record-head {
    display: flex;
    gap: var(--space-2);
    margin: 0;
    font-size: var(--text-2xs);
    color: var(--text-secondary);
  }
  .record-summary {
    font-weight: 600;
    color: var(--text-primary);
  }
  .stamp {
    flex: 0 0 auto;
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }

  .facts {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 2px var(--space-2);
    font-size: var(--text-2xs);
    color: var(--text-muted);
  }
  .fact-label {
    color: var(--text-faint);
  }

  .section-label {
    margin: 0 0 var(--space-1);
    font-size: var(--text-2xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: var(--ls-caps);
    color: var(--text-muted);
  }

  .timeline ol {
    gap: 2px;
    max-height: 240px;
    overflow-y: auto;
  }
  .entry {
    display: grid;
    grid-template-columns: 62px 58px minmax(0, 1fr);
    gap: var(--space-2);
    font-size: var(--text-2xs);
    color: var(--text-secondary);
  }
  .entry-kind {
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: var(--ls-caps);
  }
  .entry-summary {
    min-width: 0;
  }
  .entry-detail {
    display: block;
    color: var(--text-faint);
  }

  .actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .manual-export {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    padding: var(--space-2);
    border: 1px solid var(--border-faint);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    line-height: 1.5;
  }
</style>
