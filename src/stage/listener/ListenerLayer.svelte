<!--
  Listener playback engine + positioning (spec §37, §40).

  Two stacked <video> elements are double-buffered: the active clip plays in
  one while the next neutral loop preloads in the other; near the neutral
  tail the layer crossfades (§38.3, §40.1). Failures are nonfatal — the layer
  degrades to the poster frame and reports health upward (§40.5).

  Positioning model (owner direction): clips are framed loosely, so the crop
  wrapper applies `scale(cropZoom) translate(cropX%, cropY%)` — zoom plus
  horizontal/vertical offsets — which also powers lens-target calibration.
  cropX/cropY are percent of the media box (positive = right/down).
-->
<script lang="ts">
  import type { ListenerStageSelection } from '../../shared/contracts';
  import { createClipScheduler, type ClipPlan, type ClipScheduler } from './scheduler';

  let {
    selection,
    frozen = false,
    hidden = false,
    reducedMotion = false,
    onhealth = undefined,
  }: {
    selection: ListenerStageSelection;
    /** Freeze frame (hard pause / stage frozen): keep the current frame. */
    frozen?: boolean;
    /** Blanked without keep-listener: invisible AND paused, state preserved. */
    hidden?: boolean;
    reducedMotion?: boolean;
    onhealth?: (
      status: 'ok' | 'poster_fallback' | 'failed',
      code?: 'decode_failure' | 'unsupported_codec' | 'source_unavailable',
      clipId?: string,
    ) => void;
  } = $props();

  const geometry = $derived(selection.geometry);
  const placement = $derived(selection.placement ?? 'background');
  const crossfadeMs = $derived(reducedMotion ? 60 : 180);
  const posterUrl = $derived(selection.clipUrls[0]?.posterUrl ?? '');

  let videoEls: (HTMLVideoElement | undefined)[] = [undefined, undefined];
  let active = $state(0);
  let posterMode = $state(false);
  let started = false;
  let transitioning = false;
  let errorCount = 0;

  let scheduler: ClipScheduler | null = null;
  const slotPlans: (ClipPlan | null)[] = [null, null];
  let slotReady = $state<[boolean, boolean]>([false, false]);

  function urlFor(clipId: string): string | null {
    return selection.clipUrls.find((c) => c.id === clipId)?.url ?? null;
  }

  function bindVideo(el: HTMLVideoElement, slot: number) {
    videoEls[slot] = el;
    maybeStart();
    return {
      destroy() {
        el.pause();
        videoEls[slot] = undefined;
      },
    };
  }

  // Restart the engine whenever the selection identity changes.
  $effect(() => {
    void selection.packId;
    void selection.clipUrls;
    started = false;
    posterMode = false;
    errorCount = 0;
    transitioning = false;
    scheduler = null;
    maybeStart();
  });

  function maybeStart() {
    if (started || posterMode) return;
    const a = videoEls[0];
    const b = videoEls[1];
    if (!a || !b) return;
    scheduler = createClipScheduler(
      selection.clipUrls.map((c) => ({ id: c.id, durationMs: c.durationMs })),
      { seed: Date.now() % 100000, crossfadeMs },
    );
    const first = scheduler.next();
    if (!first) {
      degradeToPoster('source_unavailable');
      return;
    }
    started = true;
    active = 0;
    loadSlot(0, first);
    const second = scheduler.next();
    if (second) loadSlot(1, second);
    playActive();
  }

  function loadSlot(slot: number, plan: ClipPlan) {
    const el = videoEls[slot];
    const url = urlFor(plan.clipId);
    if (!el || !url) {
      degradeToPoster('source_unavailable', plan.clipId);
      return;
    }
    slotPlans[slot] = plan;
    slotReady[slot] = false;
    slotReady = [...slotReady] as [boolean, boolean];
    el.src = url;
    el.load();
  }

  function playActive() {
    const el = videoEls[active];
    if (!el || posterMode || frozen || hidden) return;
    void el.play().catch(() => {
      // Autoplay is muted; a rejection here means decode/source trouble.
      handleSlotError(active);
    });
  }

  function onCanPlay(slot: number) {
    slotReady[slot] = true;
    slotReady = [...slotReady] as [boolean, boolean];
    if (slot === active && started && !frozen && !hidden) playActive();
  }

  function onPlaying(slot: number) {
    if (slot === active && !posterMode) {
      errorCount = 0;
      onhealth?.('ok', undefined, slotPlans[slot]?.clipId);
    }
  }

  function onTimeUpdate(slot: number) {
    if (slot !== active || transitioning || frozen || hidden || posterMode) return;
    const el = videoEls[slot];
    const plan = slotPlans[slot];
    if (!el || !plan) return;
    const other = 1 - slot;
    // Transition only when the next buffer is genuinely ready (§40.3);
    // otherwise the current clip loops cleanly and we retry next cycle.
    if (el.currentTime * 1000 >= plan.transitionAtMs && slotReady[other] && slotPlans[other]) {
      beginCrossfade(slot, other);
    }
  }

  function beginCrossfade(from: number, to: number) {
    const nextEl = videoEls[to];
    if (!nextEl) return;
    transitioning = true;
    try {
      nextEl.currentTime = 0;
    } catch {
      /* not seekable yet — play from wherever it is */
    }
    void nextEl.play().catch(() => handleSlotError(to));
    active = to;
    const settleMs = (slotPlans[to]?.crossfadeMs ?? crossfadeMs) + 80;
    setTimeout(() => {
      const oldEl = videoEls[from];
      oldEl?.pause();
      const upcoming = scheduler?.next() ?? null;
      if (upcoming) loadSlot(from, upcoming);
      transitioning = false;
    }, settleMs);
  }

  function handleSlotError(slot: number) {
    errorCount++;
    const clipId = slotPlans[slot]?.clipId;
    if (slot === active || errorCount > 2) {
      degradeToPoster('decode_failure', clipId);
      return;
    }
    // Back buffer failed: retry its preload once, later (§40.3).
    setTimeout(() => {
      if (posterMode) return;
      const retry = scheduler?.next() ?? null;
      if (retry) loadSlot(slot, retry);
    }, 1500);
  }

  function degradeToPoster(
    code: 'decode_failure' | 'unsupported_codec' | 'source_unavailable',
    clipId?: string,
  ) {
    if (posterMode) return;
    posterMode = true;
    for (const el of videoEls) el?.pause();
    onhealth?.('poster_fallback', code, clipId);
  }

  // Freeze / hidden / page-visibility pause behavior (§40.4, §16.6).
  $effect(() => {
    const shouldPause = frozen || hidden;
    const el = videoEls[active];
    if (!el || posterMode || !started) return;
    if (shouldPause) el.pause();
    else playActive();
  });

  $effect(() => {
    const onVisibility = () => {
      const el = videoEls[active];
      if (!el || posterMode || !started) return;
      if (document.hidden) el.pause();
      else if (!frozen && !hidden) playActive();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  });
</script>

{#if placement !== 'off'}
  <div
    class="listener-layer"
    class:invisible={hidden}
    data-placement={placement}
    style:opacity={hidden ? 0 : geometry.opacity}
  >
    <div
      class="media-box"
      style:left={placement === 'background' || placement === 'top_strip'
        ? null
        : `${geometry.anchorX * 100}%`}
      style:top={placement === 'background' || placement === 'top_strip'
        ? null
        : `${geometry.anchorY * 100}%`}
      style:scale={placement === 'background' ? null : geometry.scale}
      style:filter="saturate({geometry.saturation}) blur({geometry.blurPx}px)"
    >
      <div class="flip" class:flipped={geometry.mirrorVideo}>
        <div
          class="crop"
          style:transform="scale({geometry.cropZoom}) translate({geometry.cropX}%, {geometry.cropY}%)"
        >
          {#each [0, 1] as slot (slot)}
            <video
              class="clip"
              class:front={active === slot && !posterMode}
              style:transition-duration="{crossfadeMs}ms"
              muted
              playsinline
              loop
              preload="auto"
              use:bindVideo={slot}
              oncanplay={() => onCanPlay(slot)}
              onplaying={() => onPlaying(slot)}
              ontimeupdate={() => onTimeUpdate(slot)}
              onerror={() => handleSlotError(slot)}
            ></video>
          {/each}
          {#if posterMode && posterUrl}
            <img class="poster" src={posterUrl} alt="" draggable="false" />
          {/if}
        </div>
      </div>
      <div class="vignette" aria-hidden="true"></div>
    </div>
    {#if placement === 'background'}
      <!-- Subtle dark gradient behind the text column (§37.5). -->
      <div class="scrim" aria-hidden="true"></div>
    {/if}
  </div>
{/if}

<style>
  .listener-layer {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
    transition: opacity 240ms var(--ease-out, ease-out);
  }
  .listener-layer.invisible {
    visibility: hidden;
  }

  .media-box {
    position: absolute;
    overflow: hidden;
    background: transparent;
  }
  /* Full background, centered behind text (§37.4 default). */
  [data-placement='background'] .media-box {
    inset: 0;
  }
  [data-placement='lens_left'] .media-box,
  [data-placement='lens_right'] .media-box {
    width: 30%;
    height: 62%;
    transform: translate(-50%, -50%);
    border-radius: 0;
  }
  [data-placement='top_strip'] .media-box {
    left: 0;
    right: 0;
    top: 0;
    height: 36%;
  }
  /* PiP is the one mode allowed a hard-edged card (§37.5). */
  [data-placement='pip'] .media-box {
    width: 22%;
    aspect-ratio: 3 / 4;
    transform: translate(-50%, -50%);
    border-radius: 16px;
  }

  .flip,
  .crop {
    position: absolute;
    inset: 0;
  }
  .flip.flipped {
    transform: scaleX(-1);
  }
  .crop {
    transform-origin: 50% 50%;
    will-change: transform;
  }

  .clip,
  .poster {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    opacity: 0;
    transition-property: opacity;
    transition-timing-function: var(--ease-inout, ease-in-out);
  }
  .clip.front,
  .poster {
    opacity: 1;
  }

  .vignette {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background: radial-gradient(ellipse 78% 72% at 50% 46%, transparent 55%, rgba(0, 0, 0, 0.55) 100%);
  }

  .scrim {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background: radial-gradient(ellipse 62% 70% at 50% 40%, rgba(0, 0, 0, 0.5), transparent 72%);
  }
</style>
