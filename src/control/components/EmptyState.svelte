<!--
  Calm empty-state invitation on the warm empty tokens. No illustrations,
  no feature carousel (spec §12.3).

  ---------------------------------------------------------------------------
  THREE VARIANTS, BECAUSE ONE BOX DOES NOT FIT THREE JOBS
  ---------------------------------------------------------------------------
  §10.7 and §19.10: the enclosing card is right for a first-use invitation and
  wrong for everything else. A bordered, padded, serif-titled block sitting in
  the middle of a list is a web landing-page section — and it appears in the two
  places it hurts most, a search that found nothing and a load that failed, where
  the surrounding list structure is exactly the context the user needs kept.

    editorial  the boxed, serif, centred invitation. First run, and nothing else.
    plain      unboxed, still centred. A search miss, an empty Trash, an error
               shown in a list area that is otherwise intact.
    compact    unboxed, left-aligned, small. An inspector or a narrow pane,
               where a centred block with 48px of padding is simply cropped.

  The serif title stays in `editorial` and `plain` as a restrained brand accent
  (§3.3, §10.7) and is dropped in `compact`, where §3.3's other rule applies: no
  display serif in dense panels.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    body?: string;
    /**
     * `plain` is the default, and that is the change.
     *
     * Making the boxed variant opt-in rather than opt-out means a new empty
     * state is correct by construction: a developer who does not think about it
     * gets the unboxed message that suits a list, and the card has to be asked
     * for by the one screen that has earned it.
     */
    variant?: 'plain' | 'editorial' | 'compact';
    /**
     * A secondary line under the body — the technical reason behind an error,
     * kept apart from the sentence that says what to do about it.
     */
    detail?: string;
    actions?: Snippet;
  }

  let { title, body, variant = 'plain', detail, actions }: Props = $props();
</script>

<div class="empty {variant}">
  <h2 class="title">{title}</h2>
  {#if body}<p class="body">{body}</p>{/if}
  {#if detail}<p class="detail">{detail}</p>{/if}
  {#if actions}
    <div class="actions">{@render actions()}</div>
  {/if}
</div>

<style>
  .empty {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .title {
    margin: 0;
    font-weight: 600;
    letter-spacing: var(--ls-title);
    color: var(--text-primary);
  }

  .body {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--lh-label);
    color: var(--empty-text);
  }

  .detail {
    margin: 0;
    max-width: var(--prose-measure-narrow);
    font-size: var(--text-xs);
    line-height: var(--lh-meta);
    color: var(--text-muted);
    overflow-wrap: anywhere;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  /* ---- editorial: the first-run invitation, and only that ---- */
  .editorial {
    align-items: center;
    padding: var(--space-10) var(--space-8);
    border: 1px solid var(--empty-border);
    border-radius: var(--radius-md);
    background: var(--empty-bg);
    text-align: center;
  }
  .editorial .title {
    font-family: var(--font-serif);
    font-size: var(--text-2xl);
  }
  .editorial .body {
    max-width: var(--prose-measure-narrow);
  }
  .editorial .actions {
    margin-top: var(--space-2);
    justify-content: center;
  }

  /* ---- plain: a message inside a list that is otherwise intact ---- */
  .plain {
    align-items: center;
    /* Vertical air without a box. Enough that the message does not look like a
       list row; not so much that the list's structure is pushed off screen. */
    padding: var(--space-9) var(--space-6);
    text-align: center;
  }
  .plain .title {
    font-family: var(--font-serif);
    font-size: var(--text-xl);
  }
  .plain .body {
    max-width: var(--prose-measure-narrow);
  }
  .plain .actions {
    margin-top: var(--space-1);
    justify-content: center;
  }

  /* ---- compact: an inspector or a narrow rail ---- */
  .compact {
    align-items: flex-start;
    gap: var(--space-2);
    padding: var(--space-5) var(--space-4);
    text-align: left;
  }
  .compact .title {
    /* No serif here: §3.3 keeps the display face out of dense panels. */
    font-size: var(--text-sm);
    font-weight: 650;
    letter-spacing: normal;
    color: var(--text-secondary);
  }
  .compact .body {
    font-size: var(--text-xs);
    line-height: var(--lh-meta);
    color: var(--text-muted);
  }
</style>
