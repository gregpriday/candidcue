<!--
  Live following controls (companion §48; action copy in the primary
  Appendix F.12 voice).

  Pausing *following* is deliberately separate from pausing the *session*
  (§15.3): this stops automatic movement while transcription keeps running.
  The transport in the footer still owns session pause.
-->
<script lang="ts">
  import Button from './Button.svelte';
  import { smoothFollow, type SmoothFollowState } from '../stores/smooth-follow';

  interface Props {
    follow: SmoothFollowState;
  }
  let { follow }: Props = $props();
</script>

<div class="follow-controls">
  <div class="row">
    <Button
      size="sm"
      variant={follow.followingPaused ? 'primary' : 'default'}
      onclick={() => smoothFollow.toggleFollowingPaused()}
    >
      {follow.followingPaused ? 'Resume following' : 'Pause following'}
    </Button>
    <Button size="sm" onclick={() => smoothFollow.reAnchorHere()}>Re-find me here</Button>
  </div>
  <p class="hint">
    {follow.followingPaused
      ? 'Automatic movement is stopped. Transcription is still connected.'
      : 'Pausing following stops the text moving on its own — the session keeps running.'}
  </p>

  <div class="row">
    <Button size="sm" variant="ghost" onclick={() => smoothFollow.nudge('back')}>Nudge back</Button>
    <Button size="sm" variant="ghost" onclick={() => smoothFollow.nudge('forward')}>
      Nudge forward
    </Button>
    <span class="hint inline">One sentence at a time</span>
  </div>

  <!-- §48: offer the local candidates instead of guessing when lost. -->
  {#if follow.candidates.length > 0}
    <div class="candidates">
      <p class="hint">CandidCue is not sure where you are. Pick the line you are on:</p>
      <ul>
        {#each follow.candidates as candidate (candidate.id)}
          <li>
            <button type="button" class="candidate" onclick={() => smoothFollow.acceptCandidate(candidate.id)}>
              <span class="candidate-label">{candidate.label}</span>
              {#if candidate.sectionTitle}
                <span class="candidate-section">{candidate.sectionTitle}</span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    </div>
  {/if}

</div>

<style>
  .follow-controls {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .hint {
    margin: 0;
    font-size: var(--text-2xs);
    line-height: 1.45;
    color: var(--text-muted);
  }
  .hint.inline {
    flex: 0 0 auto;
  }



  .candidates ul {
    list-style: none;
    margin: var(--space-1) 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .candidate {
    display: flex;
    flex-direction: column;
    gap: 1px;
    width: 100%;
    text-align: left;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-control);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
    color: var(--text-primary);
    font-size: var(--text-xs);
    cursor: pointer;
    transition: background var(--dur-fast) var(--ease-out);
  }
  .candidate:hover {
    background: var(--bg-hover-surface);
  }
  .candidate-label {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .candidate-section {
    font-size: var(--text-2xs);
    color: var(--text-muted);
  }


  @media (prefers-reduced-motion: reduce) {
    .candidate {
      transition: none;
    }
  }
</style>
