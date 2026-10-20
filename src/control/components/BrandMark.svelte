<!--
  The CandidCue mark, in the page.

  The same drawing as the app icon (`src-tauri/icons/source/icon.svg`): the line
  being read, bright, between the two cue ticks the stage draws beside it on
  the glass, with the lines already read above it dimming away and the next two
  below. Kept in step with that file by hand — it is seven shapes on a 24-unit
  grid.

  The tile is the icon's petrol (#176b75; the opaque current line and ticks
  are white on it at 6.2:1) in both themes, not `--accent`: the accent is
  retuned per theme, and the dark theme's is a light coral that the white
  lines wash out against; a mark that changes colour with the theme is
  no longer the app's icon. The tile matches `icon-small.svg`'s flat fill,
  which a unit test holds it to.

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
  <rect width="24" height="24" rx="5.4" fill="#176b75" />
  <g fill="#ffffff">
    <rect x="6.5" y="4" width="8.5" height="1.8" rx="0.9" opacity="0.25" />
    <rect x="6.5" y="7.55" width="10" height="1.8" rx="0.9" opacity="0.5" />
    <rect x="6.5" y="10.8" width="11" height="2.4" rx="1.2" />
    <rect x="6.5" y="14.65" width="9.3" height="1.8" rx="0.9" opacity="0.85" />
    <rect x="6.5" y="18.2" width="6.5" height="1.8" rx="0.9" opacity="0.85" />
    <path
      d="M2.75 10.33 L5.38 12 L2.75 13.67 Z M21.25 10.33 L18.62 12 L21.25 13.67 Z"
      stroke="#ffffff"
      stroke-width="0.53"
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
