<!--
  The rig being edited, drawn over the sample text: the safe-area frame and
  where the camera is.

  Settings › Prompter display sets both by eye, so they have to be visible on
  the glass while the sliders move, and on top of the sample rather than
  instead of it — the frame is judged against what the hood hides and the lens
  against where the words sit, and both questions need the words there.

  Drawn in raw viewport fractions, full-bleed, for the reason the wizard's own
  calibration overlays are: the frame IS the safe area, so drawing it inside
  the safe plane would make it chase itself, and the lens is somewhere on the
  PANEL. Pointer-inert throughout; nothing here is a control.
-->
<script lang="ts">
  import type { StageRigMarks } from '../../shared/contracts';

  interface Props {
    marks: StageRigMarks;
  }

  let { marks }: Props = $props();

  function finite(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }

  /** The wizard's own bounds, so the two screens draw the same frame. */
  function clampInset(value: unknown): number {
    return Math.min(0.45, Math.max(0, finite(value, 0)));
  }

  function clampUnit(value: unknown, fallback: number): number {
    return Math.min(1, Math.max(0, finite(value, fallback)));
  }

  const edges = $derived({
    top: clampInset(marks.safeArea?.top),
    right: clampInset(marks.safeArea?.right),
    bottom: clampInset(marks.safeArea?.bottom),
    left: clampInset(marks.safeArea?.left),
  });

  /**
   * The lens on the panel.
   *
   * The profile keeps it as a fraction of the SAFE rectangle, which is what
   * every consumer downstream resolves it against, so the insets are folded
   * back in here — the same conversion `Calibrate.svelte` makes for its
   * crosshair. Skipping it would draw the mark where the lens would be on a
   * panel with no hood, and the text would then seem to be off it.
   */
  const lensOnPanel = $derived({
    x: edges.left + clampUnit(marks.lens?.x, 0.5) * Math.max(0, 1 - edges.left - edges.right),
    y: edges.top + clampUnit(marks.lens?.y, 0.5) * Math.max(0, 1 - edges.top - edges.bottom),
  });

  const placement = $derived(marks.lensPlacement);
</script>

<div class="rig-marks" data-lens-placement={placement} aria-hidden="true">
  <div
    class="rig-frame"
    style:top="{edges.top * 100}%"
    style:right="{edges.right * 100}%"
    style:bottom="{edges.bottom * 100}%"
    style:left="{edges.left * 100}%"
  ></div>

  {#if placement === 'in-panel'}
    <div
      class="rig-lens"
      style:left="{lensOnPanel.x * 100}%"
      style:top="{lensOnPanel.y * 100}%"
    >
      <span class="lens-h"></span>
      <span class="lens-v"></span>
      <span class="lens-ring"></span>
    </div>
  {:else if placement === 'above' || placement === 'below'}
    <!-- A camera off the glass cannot be lined up inside it, but Across still
         centres the column under it, so that is what is marked: a pointer on
         the edge the camera is beyond. -->
    <div
      class="rig-lens-edge"
      class:above={placement === 'above'}
      class:below={placement === 'below'}
      style:left="{lensOnPanel.x * 100}%"
    ></div>
  {/if}
</div>

<style>
  .rig-marks {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  .rig-frame {
    position: absolute;
    border: 2px dashed rgb(245 243 239 / 80%);
    /* Outside the frame is washed faintly, as on the wizard's card, so it
       reads which side is in; faint, because the text inside is the subject. */
    box-shadow: 0 0 0 100vmax rgb(245 243 239 / 5%);
  }

  .rig-lens {
    position: absolute;
    width: 0;
    height: 0;
  }

  .lens-h,
  .lens-v {
    position: absolute;
    background: #ffffff;
    box-shadow: 0 0 0 1px rgb(0 0 0 / 90%);
  }

  .lens-h {
    left: -60px;
    top: -1px;
    width: 120px;
    height: 2px;
  }

  .lens-v {
    top: -60px;
    left: -1px;
    width: 2px;
    height: 120px;
  }

  .lens-ring {
    position: absolute;
    left: -14px;
    top: -14px;
    width: 28px;
    height: 28px;
    border: 2px solid #ffffff;
    border-radius: 50%;
    box-shadow:
      0 0 0 1px rgb(0 0 0 / 90%),
      inset 0 0 0 1px rgb(0 0 0 / 90%);
  }

  .rig-lens-edge {
    position: absolute;
    width: 0;
    height: 0;
    margin-left: -18px;
    border-left: 18px solid transparent;
    border-right: 18px solid transparent;
  }

  .rig-lens-edge.above {
    top: 0;
    border-bottom: 24px solid #ffffff;
  }

  .rig-lens-edge.below {
    bottom: 0;
    border-top: 24px solid #ffffff;
  }
</style>
