<!--
  The CandidCue mark, in the page.

  The app icon's mark: a pane of teleprompter glass in perspective, the line
  being read, and the two cue triangles the stage draws beside that line,
  grown out of the pane's edges. The path is copied from
  `src-tauri/icons/source/sizes/icon-brand-44.svg`, the mark drawn for 44
  device pixels, which is what Welcome's 22 px is on a 2x screen: the rim, the
  line and the tile's edges land on whole pixels there, where the master's
  mark scaled down put them between rows and turned them into grey bands.
  Regenerate it with scripts/fit-icon-sizes.py and copy the path back here.

  The tile is the icon's Optical Blue (#3d63b8) in both themes, not
  `--accent`: the accent is retuned per theme, and a mark that changes colour
  with the theme is no longer the app's icon. The tile matches the small icon
  drawings' flat fill (`sizes/icon-32.svg`), which a unit test holds it to.

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
  viewBox="0 0 44 44"
  aria-hidden="true"
  focusable="false"
>
  <rect width="44" height="44" rx="9.9" fill="#3D63B8" />
  <path
    d="M5 32H39L32.633 12H11.367ZM7.736 30L9.328 25L13.5 21.5L11.556 18L12.83 14H31.17L32.444 18L30.5 21.5L34.672 25L36.264 30ZM16.5 20H27.5A1.5 1.5 0 0 1 27.5 23H16.5A1.5 1.5 0 0 1 16.5 20Z"
    fill="#ffffff"
    fill-rule="evenodd"
  />
</svg>

<style>
  .brand-mark {
    display: block;
    flex: none;
  }
</style>
