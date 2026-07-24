<!--
  Listener playback engine + positioning (spec §37, §40).

  Two stacked <video> elements are double-buffered: the active clip plays in
  one while the next neutral loop preloads in the other; near the neutral
  tail the layer crossfades (§38.3, §40.1). Failures are nonfatal — the layer
  degrades to the poster frame and reports health upward (§40.5).

  Positioning model (owner direction): clips are framed loosely, so the crop
  wrapper applies `translate(cropX%, cropY%) scale(cropZoom) scaleX(mirror)` —
  zoom, horizontal/vertical offsets, and mirror in ONE transform — which also
  powers lens-target calibration. cropX/cropY are PERCENT of the media box
  (positive = right/down), never a 0..1 fraction, and the mirror lives inside
  the translate so it cannot invert the offsets. The unit contract, transform
  order, and the zoom-derived safe range all live in
  src/shared/listener/geometry.ts — do not re-derive them here.
-->
<script lang="ts">
  import type { ListenerStageSelection } from '../../shared/contracts';
  import { listenerCropTransform } from '../../shared/listener/geometry';
  import { classifyPlayRejection } from './play-error';
  import {
    createClipScheduler,
    withMeasuredDuration,
    type ClipPlan,
    type ClipScheduler,
  } from './scheduler';

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

  let autoplayRetries = 0;

  let scheduler: ClipScheduler | null = null;
  const slotPlans: (ClipPlan | null)[] = [null, null];
  let slotReady = $state<[boolean, boolean]>([false, false]);

  /**
   * Every pending timer is tracked so a restart can cancel it (§40.3). A bare
   * setTimeout survives the restart $effect and lands on an engine that has
   * already been torn down and rebuilt — retrying a preload into a stale
   * scheduler, or completing a crossfade that no longer exists.
   */
  type Timer = ReturnType<typeof setTimeout>;
  const stallTimers: (Timer | null)[] = [null, null];
  const retryTimers: (Timer | null)[] = [null, null];
  let settleTimer: Timer | null = null;
  let autoplayTimer: Timer | null = null;

  /**
   * A clip that is playing and then goes quiet is broken quickly; a clip that
   * is still loading gets far more rope, because a cold read of a 1080p loop
   * off an external volume legitimately takes seconds.
   */
  const PLAYBACK_STALL_MS = 2500;
  const LOAD_STALL_MS = 12000;

  function clearSlotTimers(slot: number): void {
    if (stallTimers[slot] !== null) clearTimeout(stallTimers[slot]!);
    if (retryTimers[slot] !== null) clearTimeout(retryTimers[slot]!);
    stallTimers[slot] = null;
    retryTimers[slot] = null;
  }

  function clearAllTimers(): void {
    clearSlotTimers(0);
    clearSlotTimers(1);
    if (settleTimer !== null) clearTimeout(settleTimer);
    if (autoplayTimer !== null) clearTimeout(autoplayTimer);
    settleTimer = null;
    autoplayTimer = null;
  }

  function urlFor(clipId: string): string | null {
    return selection.clipUrls.find((c) => c.id === clipId)?.url ?? null;
  }

  function bindVideo(el: HTMLVideoElement, slot: number) {
    videoEls[slot] = el;
    maybeStart();
    return {
      destroy() {
        clearSlotTimers(slot);
        // Release the decoder and the underlying resource, not just playback.
        // Over a 90-minute session these two elements take several hundred src
        // reassignments; leaving the last one attached pins its buffer. This is
        // the ONE place load() is correct — after clearing src it is a release,
        // not a reload (see the deliberate absence of load() in loadSlot).
        el.pause();
        el.removeAttribute('src');
        el.load();
        videoEls[slot] = undefined;
      },
    };
  }

  // Restart the engine whenever the selection identity changes.
  $effect(() => {
    void selection.packId;
    void selection.clipUrls;
    clearAllTimers();
    started = false;
    posterMode = false;
    errorCount = 0;
    autoplayRetries = 0;
    transitioning = false;
    scheduler = null;
    maybeStart();
    return clearAllTimers;
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
    clearSlotTimers(slot);
    slotPlans[slot] = plan;
    slotReady[slot] = false;
    slotReady = [...slotReady] as [boolean, boolean];
    // Assigning `src` starts the load on its own. We deliberately do NOT call
    // el.load() afterwards: the redundant reload aborts the in-flight fetch and
    // can strand the <video> on its first frame. On the back buffer that abort
    // means `canplay` never fires, slotReady stays false, the crossfade never
    // arms, and the current clip hard-loops forever — a visible cut every ~7s
    // with no error anywhere. (Inherited the hard way from the Electron build.)
    el.src = url;
    armStallWatchdog(slot, LOAD_STALL_MS);
  }

  /**
   * A slot that goes quiet — `stalled`/`waiting` with no progress — is a real
   * failure mode on external volumes and network-backed media, and with no
   * watchdog it presents as a frozen frame and no health report at all (§40.5).
   */
  function armStallWatchdog(slot: number, budgetMs: number) {
    if (stallTimers[slot] !== null) clearTimeout(stallTimers[slot]!);
    stallTimers[slot] = setTimeout(() => {
      stallTimers[slot] = null;
      if (posterMode || frozen || hidden) return;
      handleSlotError(slot);
    }, budgetMs);
  }

  function clearStallWatchdog(slot: number) {
    if (stallTimers[slot] !== null) clearTimeout(stallTimers[slot]!);
    stallTimers[slot] = null;
  }

  function onStalled(slot: number) {
    // Paused-on-purpose elements are expected to go quiet.
    if (posterMode || frozen || hidden) return;
    // Mid-playback the active clip must recover fast; a slot that has not
    // reached `canplay` yet is still legitimately loading.
    armStallWatchdog(slot, slot === active && slotReady[slot] ? PLAYBACK_STALL_MS : LOAD_STALL_MS);
  }

  function playActive() {
    const el = videoEls[active];
    if (!el || posterMode || frozen || hidden) return;
    const slot = active;
    void el.play().catch((reason: unknown) => {
      switch (classifyPlayRejection(reason)) {
        case 'ignored':
          // Interrupted by a pause / new src / crossfade. Routine.
          return;
        case 'autoplay_blocked':
          handleAutoplayBlocked(slot);
          return;
        default:
          handleSlotError(slot);
      }
    });
  }

  /**
   * The autoplay policy refused a muted clip. Nothing is wrong with the media,
   * so this must NOT be reported as a decode failure — retry a few times, and
   * fall back to the poster with no error code if the policy keeps refusing.
   */
  function handleAutoplayBlocked(slot: number) {
    if (slot !== active || posterMode) return;
    autoplayRetries++;
    if (autoplayRetries > 3) {
      if (!posterMode) {
        posterMode = true;
        for (const el of videoEls) el?.pause();
        onhealth?.('poster_fallback', undefined, slotPlans[slot]?.clipId);
      }
      return;
    }
    if (autoplayTimer !== null) clearTimeout(autoplayTimer);
    autoplayTimer = setTimeout(() => {
      autoplayTimer = null;
      playActive();
    }, 400 * autoplayRetries);
  }

  function onLoadedMetadata(slot: number) {
    const el = videoEls[slot];
    const plan = slotPlans[slot];
    if (!el || !plan) return;
    // Prefer the element's own duration over the manifest's declared value: an
    // over-long declared duration puts transitionAtMs past the real end, the
    // element's `loop` restarts first, and the crossfade never fires (§40.3).
    slotPlans[slot] = withMeasuredDuration(plan, el.duration * 1000);
  }

  function onCanPlay(slot: number) {
    clearStallWatchdog(slot);
    slotReady[slot] = true;
    slotReady = [...slotReady] as [boolean, boolean];
    if (slot === active && started && !frozen && !hidden) playActive();
  }

  function onPlaying(slot: number) {
    clearStallWatchdog(slot);
    if (slot === active && !posterMode) {
      errorCount = 0;
      autoplayRetries = 0;
      onhealth?.('ok', undefined, slotPlans[slot]?.clipId);
    }
  }

  function onTimeUpdate(slot: number) {
    // Progress is proof of life for either slot, active or not.
    clearStallWatchdog(slot);
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
    void nextEl.play().catch((reason: unknown) => {
      if (classifyPlayRejection(reason) === 'ignored') return;
      handleSlotError(to);
    });
    active = to;
    const settleMs = (slotPlans[to]?.crossfadeMs ?? crossfadeMs) + 80;
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      const oldEl = videoEls[from];
      oldEl?.pause();
      clearStallWatchdog(from);
      const upcoming = scheduler?.next() ?? null;
      if (upcoming) loadSlot(from, upcoming);
      transitioning = false;
    }, settleMs);
  }

  function handleSlotError(slot: number) {
    errorCount++;
    clearStallWatchdog(slot);
    const clipId = slotPlans[slot]?.clipId;
    if (slot === active || errorCount > 2) {
      degradeToPoster('decode_failure', clipId);
      return;
    }
    // Back buffer failed: retry its preload once, later (§40.3).
    if (retryTimers[slot] !== null) clearTimeout(retryTimers[slot]!);
    retryTimers[slot] = setTimeout(() => {
      retryTimers[slot] = null;
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
    clearAllTimers();
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
      <!--
        One transform for zoom + offset + mirror. The mirror used to live on an
        OUTER wrapper, where its scaleX(-1) negated the offsets and "move right"
        moved her left; composing it innermost here fixes that (see geometry.ts).
      -->
      <div class="crop" style:transform={listenerCropTransform(geometry)}>
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
            onloadedmetadata={() => onLoadedMetadata(slot)}
            oncanplay={() => onCanPlay(slot)}
            onplaying={() => onPlaying(slot)}
            ontimeupdate={() => onTimeUpdate(slot)}
            onstalled={() => onStalled(slot)}
            onwaiting={() => onStalled(slot)}
            onerror={() => handleSlotError(slot)}
          ></video>
        {/each}
        {#if posterMode && posterUrl}
          <img class="poster" src={posterUrl} alt="" draggable="false" />
        {/if}
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

  .crop {
    position: absolute;
    inset: 0;
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
