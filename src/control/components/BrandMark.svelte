<!--
  The CandidCue mark, in the page.

  The same drawing as the app icon (`src-tauri/icons/source/icon.svg`): the line
  being read, bright, between the two cue arrows the stage draws beside it on
  the glass, with the line already read above it dimmed and the next one below.
  Kept in step with that file by hand — it is five shapes on a 24-unit grid.

  Decorative wherever it appears: the word "CandidCue" always sits beside it,
  so it is hidden from assistive technology rather than given a second name.
-->
<script lang="ts">
  interface Props {
    /** Rendered size in CSS pixels; the drawing is square. */
    size?: number;
  }

  let { size = 24 }: Props = $props();
</script>

<svg
  class="brand-mark"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  aria-hidden="true"
  focusable="false"
>
  <rect width="24" height="24" rx="5.4" fill="var(--accent)" />
  <g fill="#fff7f1">
    <rect x="7" y="5.6" width="10" height="2.4" rx="1.2" opacity="0.45" />
    <rect x="6.5" y="10.8" width="11" height="2.4" rx="1.2" />
    <rect x="8.5" y="16" width="7" height="2.4" rx="1.2" opacity="0.7" />
    <path
      d="M2.9 9.9 L5.3 12 L2.9 14.1 Z M21.1 9.9 L18.7 12 L21.1 14.1 Z"
      stroke="#fff7f1"
      stroke-width="0.7"
      stroke-linejoin="round"
    />
  </g>
</svg>

<style>
  .brand-mark {
    display: block;
    flex: none;
  }
</style>
