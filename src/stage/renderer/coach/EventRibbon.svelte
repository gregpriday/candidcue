<!--
  §10 recent-event ribbon.

  The ribbon answers "where, recently, did that happen?" without ever printing
  the word "um" at the presenter (§10.1). Two implementation notes worth keeping:

  - Marks are placed from their own audio timestamps, so a late precision
    result lands at the historical position it describes and only fades in
    there (§10.4). Nothing here can move a mark rightward to "now".
  - Between snapshots the whole track is translated by one transform per frame,
    driven by elapsed wall time rather than by a frame counter, which is what
    "continuous and frame-rate independent" means in §10.2. Individual marks
    are never re-laid-out per frame.
-->
<script lang="ts">
  import { RIBBON_ARRIVAL_FADE_MS, type RibbonMark } from './ribbon';

  let {
    marks = [],
    windowMs,
    epochMonotonicMs,
    heightPx,
    reducedMotion = false,
  }: {
    marks?: RibbonMark[];
    /** §10.2 window width in ms — 20 s in Coach, 30 s in Studio. */
    windowMs: number;
    /** `performance.now()` at the moment `marks` were laid out. */
    epochMonotonicMs: number;
    heightPx: number;
    reducedMotion?: boolean;
  } = $props();

  /** How far the track has slid left since the marks were laid out, in %. */
  let slidePercent = $state(0);
  let seen = new Set<string>();
  let arriving = $state(new Set<string>());

  $effect(() => {
    // A new mark fades in where it belongs; an existing one never re-animates.
    const next = new Set<string>();
    for (const mark of marks) {
      if (!seen.has(mark.eventId)) next.add(mark.eventId);
    }
    seen = new Set(marks.map((mark) => mark.eventId));
    if (next.size > 0) arriving = next;
  });

  $effect(() => {
    // Reduced motion drops the per-frame slide; the ribbon still tracks time,
    // it simply steps forward when a new snapshot is laid out instead of
    // sliding continuously.
    if (reducedMotion) {
      slidePercent = 0;
      return;
    }
    const epoch = epochMonotonicMs;
    const width = windowMs;
    let raf = 0;
    const tick = () => {
      // Elapsed *time*, not accumulated per-frame deltas: a dropped frame
      // leaves the position correct rather than behind.
      slidePercent = ((performance.now() - epoch) / width) * 100;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });
</script>

<div
  class="ribbon"
  style:height="{heightPx}px"
  style:--ribbon-arrival-ms="{reducedMotion ? 0 : RIBBON_ARRIVAL_FADE_MS}ms"
  aria-hidden="true"
>
  <div class="track" style:transform="translate3d({-slidePercent}%, 0, 0)">
    {#each marks as mark (mark.eventId)}
      <span
        class="mark"
        class:arriving={arriving.has(mark.eventId)}
        data-shape={mark.shape}
        data-type={mark.type}
        style:left="{mark.leftPercent}%"
        style:width={mark.widthPercent > 0 ? `${mark.widthPercent}%` : undefined}
      ></span>
    {/each}
  </div>
  <!-- §10.2: the right edge is the current audio time. It does not move. -->
  <span class="now-edge" data-shape="now"></span>
</div>

<style>
  .ribbon {
    position: relative;
    width: 100%;
    overflow: hidden;
  }

  .track {
    position: absolute;
    inset: 0;
    will-change: transform;
  }

  .mark {
    position: absolute;
    top: 0;
    bottom: 0;
    pointer-events: none;
  }

  /* §10.4: a mark that has just arrived fades in *where it belongs*. Nothing
     animates its position — only its opacity. */
  .mark.arriving {
    animation: ribbon-arrive var(--ribbon-arrival-ms) var(--ease-out, ease-out);
  }

  @keyframes ribbon-arrive {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  /* §10.3 shapes. Every rule below differs in geometry, not only in colour:
     strip the palette and a confirmed filler is still a solid full-height
     tick, a probable one is still hollow, a repetition is still a pair. */

  .mark[data-shape='trace'] {
    top: 50%;
    bottom: auto;
    height: 2px;
    transform: translateY(-50%);
    background: rgba(245, 243, 239, 0.22);
  }

  .mark[data-shape='tick'] {
    width: 2px;
    margin-left: -1px;
    background: var(--accent-strong, #ec9d7a);
  }

  .mark[data-shape='hollow-tick'] {
    width: 4px;
    margin-left: -2px;
    box-shadow: inset 0 0 0 1px rgba(236, 157, 122, 0.75);
  }

  .mark[data-shape='double-tick'] {
    width: 5px;
    margin-left: -2px;
    background: linear-gradient(
      90deg,
      var(--accent-strong, #ec9d7a) 0 1.5px,
      transparent 1.5px 3.5px,
      var(--accent-strong, #ec9d7a) 3.5px 5px
    );
  }

  /* A long pause is a thin centred line inside the silence, with end caps so
     it never reads as a shorter speech trace. */
  .mark[data-shape='gap'] {
    top: 50%;
    bottom: auto;
    height: 1px;
    transform: translateY(-50%);
    background: rgba(245, 243, 239, 0.3);
    box-shadow:
      inset 1px 0 0 0 rgba(245, 243, 239, 0.3),
      inset -1px 0 0 0 rgba(245, 243, 239, 0.3);
  }

  /* A backward hook. Direction-implying: verify through real glass (§7.5). */
  .mark[data-shape='hook'] {
    width: 6px;
    margin-left: -3px;
    background: rgba(245, 243, 239, 0.6);
    clip-path: polygon(0 50%, 40% 0, 40% 35%, 100% 35%, 100% 100%, 60% 100%, 60% 65%, 40% 65%, 40% 100%);
  }

  .mark[data-shape='diamond'] {
    top: 50%;
    bottom: auto;
    width: 6px;
    height: 6px;
    margin-left: -3px;
    transform: translateY(-50%) rotate(45deg);
    background: var(--stage-cue, #d8b46a);
  }

  .mark[data-shape='top-block'] {
    bottom: auto;
    height: 2px;
    min-width: 3px;
    background: var(--stage-cue, #d8b46a);
  }

  .now-edge {
    position: absolute;
    top: 0;
    bottom: 0;
    right: 0;
    width: 1px;
    background: rgba(245, 243, 239, 0.75);
  }
</style>
