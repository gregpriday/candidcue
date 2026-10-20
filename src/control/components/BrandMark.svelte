<!--
  The CandidCue mark, in the page.

  The app icon's mark (`src-tauri/icons/source/mark.svg`, path copied verbatim):
  a pane of teleprompter glass in perspective, the line being read, and the two
  cue triangles the stage draws beside that line, grown out of the pane's edges.
  Flat on the icon's tile, because the glass the full icon is rendered in does
  not survive this size. The mark spans 80% of the tile here, against 73% in
  the icon, so its rim keeps a whole device pixel at Welcome's 22 px on a 2x
  screen. Not the 16/32 px drawing (`icon-small.svg`): that one is
  re-proportioned for single pixel rows and reads as clumsy any larger.

  The tile is the icon's petrol (#176b75) in both themes, not `--accent`: the
  accent is retuned per theme, and a mark that changes colour with the theme
  is no longer the app's icon. The tile matches `icon-small.svg`'s flat fill,
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
  <rect width="24" height="24" rx="5.4" fill="#176B75" />
  <path
    transform="translate(1.077 1.331) scale(0.021333)"
    d="M84.6 748L939.4 748A22 22 0 0 0 960.37 719.32L810.51 248.82A22 22 0 0 0 789.55 233.5L234.45 233.5A22 22 0 0 0 213.49 248.82L63.63 719.32A22 22 0 0 0 84.6 748ZM103.68 716.5L160.69 537.5L285.01 495.85A4 4 0 0 0 285.31 488.37L189.36 447.5L246.05 269.5H777.95L834.64 447.5L738.69 488.37A4 4 0 0 0 738.99 495.85L863.31 537.5L920.32 716.5ZM365 452.5H659A40 40 0 0 1 659 532.5H365A40 40 0 0 1 365 452.5Z"
    fill="#F6F7F5"
    fill-rule="evenodd"
  />
</svg>

<style>
  .brand-mark {
    display: block;
    flex: none;
  }
</style>
