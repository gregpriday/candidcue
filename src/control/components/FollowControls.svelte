<!--
  Live following controls (companion §48; action copy in the primary
  Appendix F.12 voice).

  Pausing *following* is deliberately separate from pausing the *session*
  (§15.3): this stops automatic movement while transcription keeps running.
  The transport in the footer still owns session pause.
-->
<script lang="ts">
  import Button from './Button.svelte';
  import Icon from './Icon.svelte';
  import { MOVEMENT_DETAIL, TAKE_ACTIONS } from '../../shared/take-vocabulary';
  import { smoothFollow, type SmoothFollowState } from '../stores/smooth-follow';

  interface Props {
    follow: SmoothFollowState;
    /**
     * Which half to render. The take-controls drawer puts the candidate lines
     * INSIDE the status block they answer and the routine controls below it,
     * so it asks for each separately; anything else gets both.
     */
    part?: 'all' | 'candidates' | 'routine';
    /**
     * Following was switched off by somebody (see `FollowStatePanel`).
     *
     * `follow.followingPaused` is also raised by a dead input, and painting
     * "Follow voice" as the primary action there offered a button as the cure
     * for a microphone it cannot fix. Only a decision is undone with emphasis.
     * Unwired callers keep the old reading of the store flag.
     */
    heldByUser?: boolean;
  }
  let { follow, part = 'all', heldByUser }: Props = $props();

  const userHold = $derived(heldByUser ?? follow.followingPaused);
</script>

<!--
  ONE VOCABULARY (CCUX-002).

  Every label here came from `take-vocabulary.ts` rather than being written in
  place, because writing them in place is how the app ended up with three names
  for the same act: this panel said "Pause following", the stage dock said
  "Follow my voice", and the summary called the resulting take "Fixed speed".

  The renames are not cosmetic. "Pause following" shares a verb with pausing the
  TAKE and pausing the MICROPHONE, which are different things with different
  consequences, and the presenter deciding between them is usually on camera.
  "Re-find me here" described the engine's job rather than the user's assertion.
  "Nudge forward" never said how far, and the answer — exactly one sentence — is
  the only thing anybody needs before pressing it.
-->
<div class="follow-controls">
  <!--
    §48: offer the local candidates instead of guessing when lost.

    The WHOLE line, wrapped. These are near-identical sentences by
    construction — that is why the tracker could not choose — and an ellipsis
    cut them at exactly the words that tell them apart.
  -->
  {#if part !== 'routine' && follow.candidates.length > 0}
    <ol class="candidates" aria-label="Lines you might be on">
      {#each follow.candidates as candidate (candidate.id)}
        <li>
          <button
            type="button"
            class="candidate"
            onclick={() => smoothFollow.acceptCandidate(candidate.id)}
          >
            <span class="candidate-text">
              <span class="candidate-label">{candidate.label}</span>
              {#if candidate.sectionTitle}
                <span class="candidate-section">{candidate.sectionTitle}</span>
              {/if}
            </span>
            <span class="candidate-go" aria-hidden="true">
              <Icon name="chevron-right" size={16} />
            </span>
          </button>
        </li>
      {/each}
    </ol>
  {/if}

  <!--
    Four equal controls in two rows: the movement switch and the assertion,
    then the two single steps. The promise each one makes is on its tooltip;
    the status above already says what the text is doing, and repeating it
    under the buttons put the same sentence on screen twice.
  -->
  {#if part !== 'candidates'}
    <div class="routine">
      <Button
        variant={follow.followingPaused && userHold ? 'primary' : 'default'}
        title={follow.followingPaused ? MOVEMENT_DETAIL.follow : MOVEMENT_DETAIL.hold}
        onclick={() => smoothFollow.toggleFollowingPaused()}
      >
        {follow.followingPaused ? TAKE_ACTIONS.follow : TAKE_ACTIONS.hold}
      </Button>
      <Button onclick={() => smoothFollow.reAnchorHere()}>{TAKE_ACTIONS.setPlace}</Button>
      <Button onclick={() => smoothFollow.nudge('back')}>{TAKE_ACTIONS.previousSentence}</Button>
      <Button onclick={() => smoothFollow.nudge('forward')}>{TAKE_ACTIONS.nextSentence}</Button>
    </div>
  {/if}
</div>

<style>
  .follow-controls {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
  }

  .routine {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-2);
  }

  .candidates {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .candidate {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
    text-align: left;
    padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
    border: 1px solid var(--border-control);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
    color: var(--text-primary);
    font: inherit;
    cursor: pointer;
    transition:
      background var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out);
  }
  .candidate:hover {
    background: var(--bg-hover-surface);
    border-color: var(--border-strong);
  }
  .candidate-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1 1 auto;
    min-width: 0;
  }
  .candidate-label {
    font-size: var(--text-base);
    line-height: 1.4;
    font-weight: 500;
    overflow-wrap: anywhere;
    text-wrap: pretty;
  }
  .candidate-section {
    font-size: var(--text-meta);
    line-height: var(--lh-meta);
    color: var(--text-muted);
  }
  .candidate-go {
    display: inline-flex;
    flex: 0 0 auto;
    color: var(--text-muted);
    transition: color var(--dur-fast) var(--ease-out);
  }
  .candidate:hover .candidate-go {
    color: var(--text-primary);
  }

  @media (prefers-reduced-motion: reduce) {
    .candidate,
    .candidate-go {
      transition: none;
    }
  }
</style>
