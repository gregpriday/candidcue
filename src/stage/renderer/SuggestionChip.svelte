<!--
  The off-screen suggestion: "your words fit somewhere else — read from there?"

  ---------------------------------------------------------------------------
  WHY THIS EXISTS
  ---------------------------------------------------------------------------
  The engine refuses to move the document to a match it found off the glass —
  an ad-lib that happened to quote a later paragraph once carried a take six
  hundred words forward — and it reports the place it refused. Until now that
  place reached the stage and went nowhere, so a refusal that was protecting the
  reader looked exactly like a stage that had lost them.

  This says what the engine found, in the reader's own words, and offers the one
  move the leash allows: a deliberate "read from here". It never moves anything
  on its own, it is not a claim that the reader IS there, and it is dismissed
  without ceremony. No green, no chime, no accusation — the house rule for every
  message on the stage.

  Reading windows only: it is a pointer target, and a presenter at the glass
  has no pointer.
-->
<script lang="ts">
  import type { TokenDescription } from './ScriptLayer.svelte';

  interface Props {
    description: TokenDescription;
    /** Chrome text size, the floor every other stage message uses. */
    fontSizePx: number;
    onread: () => void;
    onignore: () => void;
  }

  let { description, fontSizePx, onread, onignore }: Props = $props();

  const uid = $props.id();
  const excerptId = `${uid}-excerpt`;

  const where = $derived(
    description.direction === 'above'
      ? 'Possible match above'
      : description.direction === 'below'
        ? 'Possible match below'
        : 'Possible match on screen',
  );
</script>

<!--
  Announced by the stage's own always-present live region, not here: a region
  that mounts already filled is not reliably read out. The excerpt describes
  the button, so "Read from here" says from where.
-->
<div
  class="suggestion"
  role="group"
  aria-label="Possible match"
  data-stage-chrome
  data-suggestion-chip
  style:font-size="{fontSizePx}px"
>
  <p class="where">
    {where}{#if description.section}<span class="section"> · {description.section}</span>{/if}
  </p>
  <p class="excerpt" id={excerptId}>“{description.excerpt}”</p>
  <div class="actions">
    <button type="button" class="read" aria-describedby={excerptId} onclick={onread}>
      Read from here
    </button>
    <button type="button" class="ignore" onclick={onignore}>Ignore</button>
  </div>
</div>

<style>
  .suggestion {
    position: absolute;
    left: 50%;
    bottom: calc(var(--stage-chrome-bottom-inset, 16px) + 56px);
    transform: translateX(-50%);
    /* A definite width: centred with `left: 50%` and left to shrink-to-fit,
       the card wraps at half the window long before it needs to. */
    width: min(32em, calc(100% - 2 * var(--stage-chrome-inset, 20px)));
    box-sizing: border-box;
    padding: 0.7em 0.9em 0.75em;
    border: 1px solid var(--stage-chrome-border, rgba(255, 255, 255, 0.13));
    border-radius: var(--stage-chrome-radius, 12px);
    background: var(--stage-chrome-bg, rgba(12, 14, 18, 0.74));
    color: var(--stage-chrome-text, rgba(245, 243, 239, 0.88));
    box-shadow: var(--stage-chrome-shadow, none);
    backdrop-filter: blur(16px) saturate(130%);
    -webkit-backdrop-filter: blur(16px) saturate(130%);
    pointer-events: auto;
    line-height: 1.3;
  }
  /* One line each for where and the quote, so a long section title or a
     long word cannot grow the card up into the hold message on a short
     window. The excerpt is already capped at a few words. */
  .where {
    margin: 0;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .section {
    font-weight: 500;
    opacity: 0.78;
  }
  .excerpt {
    margin: 0.3em 0 0;
    opacity: 0.85;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  .actions {
    display: flex;
    gap: 0.5em;
    margin-top: 0.6em;
  }
  button {
    font: inherit;
    font-size: 0.86em;
    font-weight: 600;
    padding: 0.35em 0.8em;
    border-radius: 999px;
    border: 1px solid var(--stage-chrome-border, rgba(255, 255, 255, 0.13));
    background: transparent;
    color: inherit;
    cursor: pointer;
    min-height: 32px;
  }
  .read {
    background: color-mix(in srgb, var(--stage-chrome-text, #f5f3ef) 14%, transparent);
  }
  .ignore {
    opacity: 0.8;
  }
  button:hover {
    background: color-mix(in srgb, var(--stage-chrome-text, #f5f3ef) 20%, transparent);
  }
  @media (prefers-reduced-motion: reduce) {
    .suggestion {
      transition: none;
    }
  }
</style>
