<!--
  Compiled-document renderer (spec §16.2–16.5, §32, §51.3).

  - Scroll plane translated by -scrollY; reading-band dead zone decides when
    motion starts; a near-critically damped spring follows; explicit jumps
    glide or fade per the movement class.
  - Windowed rendering kicks in only for extremely long scripts.
  - Past/current/future treatment per block, per token inside the current
    block, plus the current-phrase underlay.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import type {
    StageRenderDocument,
    StageSettings,
    TrackingSnapshot,
  } from '../../shared/contracts';
  import {
    computeReadingBand,
    bandCorrection,
    clampProvisionalTarget,
    stagePadding,
    fadeDepthVh,
    imageMaxHeightVh,
    clamp,
  } from './geometry';
  import {
    createScrollSpring,
    classifyTransition,
    glidePosition,
    PROVISIONAL_MAX_CORRECTION_PX,
    LARGE_JUMP_FADE_OUT_MS,
    LARGE_JUMP_FADE_IN_MS,
    SMOOTH_JUMP_DURATION_MS,
  } from './motion';
  import {
    shouldVirtualize,
    computeOffsets,
    computeWindow,
    estimateBlockHeightPx,
    DEFAULT_OVERSCAN_PX,
  } from './virtualization';
  import { stageFontStack } from './text';
  import BlockView from './BlockView.svelte';

  let {
    doc,
    settings,
    tracking = null,
    frozen = false,
    reducedMotion = false,
    compact = false,
    onlayoutready = undefined,
  }: {
    doc: StageRenderDocument;
    settings: StageSettings;
    tracking?: TrackingSnapshot | null;
    frozen?: boolean;
    reducedMotion?: boolean;
    compact?: boolean;
    onlayoutready?: () => void;
  } = $props();

  /* ---- viewport + derived layout ---- */
  let planeEl: HTMLDivElement | undefined = $state();
  let vw = $state(0);
  let vh = $state(0);

  const padding = $derived(stagePadding(compact));
  const padTopPx = $derived((vh * padding.topVh) / 100);
  const padBottomPx = $derived((vh * padding.bottomVh) / 100);
  const gapPx = $derived((settings.paragraphSpacingEm ?? 0.7) * settings.fontSizePx);
  const columnWidthPx = $derived((vw * settings.columnWidthPercent) / 100);
  const fadeVh = $derived(fadeDepthVh(compact));
  const imageMaxH = $derived(imageMaxHeightVh(compact));

  /* ---- scroll state + motion ---- */
  let scrollY = $state(0);
  const spring = createScrollSpring();
  type AnimMode = 'idle' | 'spring' | 'glide' | 'fade_out' | 'fade_in';
  let animMode: AnimMode = 'idle';
  let planeOpacity = $state(1);
  let glide = { from: 0, to: 0, startedAt: 0, durationMs: SMOOTH_JUMP_DURATION_MS };
  let fadeTarget = 0;
  let fadeStartedAt = 0;
  let rafId = 0;
  let lastFrameAt = 0;
  let manualUntilMs = 0;
  const MANUAL_GRACE_MS = 2500;

  /* ---- measurement + virtualization ---- */
  const virtual = $derived(shouldVirtualize(doc.blocks.length));
  const measuredHeights = new Map<string, number>();
  let measureVersion = $state(0);
  let layoutReadySent = false;

  const heights = $derived.by(() => {
    void measureVersion;
    const colPx = Math.max(1, columnWidthPx);
    return doc.blocks.map((b) => {
      const m = measuredHeights.get(b.id);
      if (m !== undefined) return m;
      return estimateBlockHeightPx(b, settings.fontSizePx, settings.lineHeight, colPx) + gapPx;
    });
  });
  const offsets = $derived(computeOffsets(heights, 0, padTopPx));
  const totalHeight = $derived((offsets[offsets.length - 1] ?? 0) + padBottomPx);
  const maxScroll = $derived(Math.max(0, totalHeight - vh));

  // Recompute the window in ~400px buckets so scrolling doesn't thrash it.
  let scrollBucket = $state(0);
  const renderWindow = $derived.by(() => {
    if (!virtual) {
      return {
        startIndex: 0,
        endIndex: doc.blocks.length,
        leadingSpacePx: 0,
        trailingSpacePx: 0,
      };
    }
    void scrollBucket;
    return computeWindow(offsets, untrack(() => scrollY), vh, DEFAULT_OVERSCAN_PX);
  });

  const blockIndexById = $derived(new Map(doc.blocks.map((b, i) => [b.id, i])));
  const sentencesById = $derived(
    new Map((doc.sentences ?? []).map((s) => [s.id, s])),
  );
  const currentBlockIndex = $derived(
    tracking ? (blockIndexById.get(tracking.blockId) ?? -1) : -1,
  );
  const cursorTokenIndex = $derived(tracking ? tracking.tokenIndex : null);

  function zoneFor(index: number): 'past' | 'current' | 'future' {
    if (currentBlockIndex < 0) return 'future';
    if (index < currentBlockIndex) return 'past';
    if (index === currentBlockIndex) return 'current';
    return 'future';
  }

  /* ---- phrase underlay (spec §16.2) ---- */
  let underlay = $state<{ top: number; left: number; width: number; height: number } | null>(null);

  /* ---- measurement pass ---- */
  $effect(() => {
    // Re-measure when the document, typography, viewport, or window changes.
    void doc;
    void settings.fontSizePx;
    void settings.lineHeight;
    void settings.letterSpacingEm;
    void settings.columnWidthPercent;
    void vw;
    void vh;
    void renderWindow;
    if (!planeEl || vh === 0) return;
    const raf = requestAnimationFrame(() => measureBlocks());
    // Hidden windows can throttle rAF (§43.3 publishes while hidden); a
    // timer fallback keeps the layout-ready handshake from stalling.
    const fallback = window.setTimeout(() => measureBlocks(), 350);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(fallback);
    };
  });

  function measureBlocks() {
    if (!planeEl) return;
    let changed = false;
    const els = planeEl.querySelectorAll<HTMLElement>('[data-block-id]');
    els.forEach((el) => {
      const id = el.dataset.blockId;
      if (!id) return;
      const h = el.offsetHeight;
      const prev = measuredHeights.get(id);
      if (prev === undefined || Math.abs(prev - h) > 0.5) {
        measuredHeights.set(id, h);
        changed = true;
      }
    });
    if (changed) measureVersion++;
    if (!layoutReadySent && els.length > 0) {
      layoutReadySent = true;
      onlayoutready?.();
    }
  }

  /* ---- token position resolution ---- */
  function tokenRect(tokenIndex: number): { topDoc: number; height: number } | null {
    if (!planeEl) return null;
    const planeTop = planeEl.getBoundingClientRect().top;
    const el = planeEl.querySelector<HTMLElement>(`[data-t="${tokenIndex}"]`);
    if (el) {
      const r = el.getBoundingClientRect();
      return { topDoc: r.top - planeTop, height: r.height };
    }
    // Off-window or unmapped: estimate from the block's offsets.
    const entry = findTokenEntry(tokenIndex);
    if (!entry) return null;
    const idx = blockIndexById.get(entry.blockId);
    if (idx === undefined) return null;
    const blockEl = planeEl.querySelector<HTMLElement>(`[data-block-id="${entry.blockId}"]`);
    if (blockEl) {
      const r = blockEl.getBoundingClientRect();
      return { topDoc: r.top - planeTop + r.height / 2, height: settings.fontSizePx * settings.lineHeight };
    }
    const top = offsets[idx] ?? 0;
    const h = heights[idx] ?? settings.fontSizePx * settings.lineHeight;
    const block = doc.blocks[idx];
    let fraction = 0.5;
    if (
      block &&
      block.startTokenIndex !== undefined &&
      block.endTokenIndex !== undefined &&
      block.endTokenIndex > block.startTokenIndex
    ) {
      fraction = clamp(
        (tokenIndex - block.startTokenIndex) / (block.endTokenIndex - block.startTokenIndex),
        0,
        1,
      );
    }
    return { topDoc: top + h * fraction, height: settings.fontSizePx * settings.lineHeight };
  }

  function findTokenEntry(tokenIndex: number): { blockId: string; nodeKey: string } | null {
    const arr = doc.tokenToNode;
    let lo = 0;
    let hi = arr.length - 1;
    let best: { blockId: string; nodeKey: string } | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const entry = arr[mid];
      if (!entry) break;
      if (entry.tokenIndex <= tokenIndex) {
        best = entry;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best ?? (arr.length > 0 ? (arr[0] ?? null) : null);
  }

  /* ---- tracking → motion (spec §16.3–16.5, §32.3) ---- */
  $effect(() => {
    const snap = tracking;
    if (!snap || frozen || vh === 0) return;
    const raf = requestAnimationFrame(() => applyTracking(snap));
    return () => cancelAnimationFrame(raf);
  });

  function applyTracking(snap: TrackingSnapshot) {
    if (performance.now() < manualUntilMs) return;
    const pos = tokenRect(snap.tokenIndex);
    if (!pos) return;
    const band = computeReadingBand(vh, {
      centerPercent: settings.readingBandCenterPercent,
      halfHeightPercent: settings.readingBandHalfHeightPercent,
    });
    const current = scrollY;
    let target = bandCorrection(pos.topDoc, pos.height, current, band);
    updateUnderlay(snap);
    if (target === null) return;
    target = clamp(target, 0, maxScroll);

    if (snap.provisional) {
      // Provisional matches never trigger large jumps (spec §16.4).
      target = clampProvisionalTarget(current, target, PROVISIONAL_MAX_CORRECTION_PX);
      startSpring(target);
      return;
    }

    const cls = classifyTransition({
      movement: snap.movement,
      distancePx: Math.abs(target - current),
      viewportHeightPx: vh,
      reducedMotion,
    });
    if (cls === 'spring') startSpring(target);
    else if (cls === 'smooth_jump') startGlide(target);
    else if (cls === 'fade_jump') startFadeJump(target);
    else snapTo(target);
  }

  function updateUnderlay(snap: TrackingSnapshot) {
    if (!planeEl) return;
    const planeRect = planeEl.getBoundingClientRect();
    const sentence = sentencesById.get(snap.sentenceId);
    const startEl = sentence
      ? planeEl.querySelector<HTMLElement>(`[data-t="${sentence.startTokenIndex}"]`)
      : null;
    const endEl = sentence
      ? planeEl.querySelector<HTMLElement>(`[data-t="${sentence.endTokenIndex}"]`)
      : null;
    const curEl = planeEl.querySelector<HTMLElement>(`[data-t="${snap.tokenIndex}"]`);
    const rects = [startEl, endEl, curEl]
      .filter((el): el is HTMLElement => el !== null)
      .map((el) => el.getBoundingClientRect());
    if (rects.length === 0) {
      underlay = null;
      return;
    }
    let top = Infinity;
    let bottom = -Infinity;
    let left = Infinity;
    let right = -Infinity;
    for (const r of rects) {
      top = Math.min(top, r.top);
      bottom = Math.max(bottom, r.bottom);
      left = Math.min(left, r.left);
      right = Math.max(right, r.right);
    }
    const padX = settings.fontSizePx * 0.35;
    const padY = settings.fontSizePx * 0.12;
    underlay = {
      top: top - planeRect.top - padY,
      left: left - planeRect.left - padX,
      width: right - left + padX * 2,
      height: bottom - top + padY * 2,
    };
  }

  /* ---- animation driving ---- */
  function ensureLoop() {
    if (rafId) return;
    lastFrameAt = performance.now();
    rafId = requestAnimationFrame(frame);
  }

  function frame(now: number) {
    rafId = 0;
    const dt = Math.min(64, now - lastFrameAt);
    lastFrameAt = now;

    if (animMode === 'spring') {
      const r = spring.step(dt);
      setScroll(r.position);
      if (r.settled) animMode = 'idle';
    } else if (animMode === 'glide') {
      const elapsed = now - glide.startedAt;
      setScroll(glidePosition(glide.from, glide.to, elapsed, glide.durationMs));
      if (elapsed >= glide.durationMs) {
        setScroll(glide.to);
        spring.reset(glide.to);
        animMode = 'idle';
      }
    } else if (animMode === 'fade_out') {
      const elapsed = now - fadeStartedAt;
      planeOpacity = Math.max(0, 1 - elapsed / LARGE_JUMP_FADE_OUT_MS);
      if (elapsed >= LARGE_JUMP_FADE_OUT_MS) {
        setScroll(fadeTarget);
        spring.reset(fadeTarget);
        fadeStartedAt = now;
        animMode = 'fade_in';
      }
    } else if (animMode === 'fade_in') {
      const elapsed = now - fadeStartedAt;
      planeOpacity = Math.min(1, elapsed / LARGE_JUMP_FADE_IN_MS);
      if (elapsed >= LARGE_JUMP_FADE_IN_MS) {
        planeOpacity = 1;
        animMode = 'idle';
      }
    }

    if (animMode !== 'idle') rafId = requestAnimationFrame(frame);
  }

  function setScroll(y: number) {
    scrollY = y;
    const bucket = Math.floor(y / 400);
    if (bucket !== scrollBucket) scrollBucket = bucket;
  }

  function startSpring(target: number) {
    if (animMode === 'fade_out' || animMode === 'fade_in') return;
    spring.reset(scrollY);
    spring.setTarget(target);
    animMode = 'spring';
    ensureLoop();
  }

  function startGlide(target: number) {
    glide = {
      from: scrollY,
      to: target,
      startedAt: performance.now(),
      durationMs: SMOOTH_JUMP_DURATION_MS,
    };
    animMode = 'glide';
    ensureLoop();
  }

  function startFadeJump(target: number) {
    fadeTarget = target;
    fadeStartedAt = performance.now();
    animMode = 'fade_out';
    ensureLoop();
  }

  function snapTo(target: number) {
    animMode = 'idle';
    spring.reset(target);
    setScroll(target);
  }

  /**
   * Manual navigation (spec §16.5): applied locally for immediacy; automatic
   * movement is suspended for the grace period while control re-acquires.
   */
  export function manualScrollBy(deltaPx: number) {
    const y = clamp(scrollY + deltaPx, 0, maxScroll);
    animMode = 'idle';
    spring.reset(y);
    setScroll(y);
    manualUntilMs = performance.now() + MANUAL_GRACE_MS;
  }

  /** One text line in logical pixels, for arrow-key steps. */
  export function lineHeightPx(): number {
    return settings.fontSizePx * settings.lineHeight;
  }

  $effect(() => {
    // Cancel any animation frame on teardown.
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
    };
  });

  const visibleBlocks = $derived(
    doc.blocks.slice(renderWindow.startIndex, renderWindow.endIndex),
  );
</script>

<div
  class="script-layer"
  bind:clientWidth={vw}
  bind:clientHeight={vh}
  style:--stage-past-opacity={settings.pastOpacity}
  style:--stage-future-opacity={settings.futureOpacity}
  style:--stage-image-max-h="{imageMaxH}vh"
>
  <div
    class="scroll-plane"
    bind:this={planeEl}
    style:transform="translate3d(0, {-scrollY}px, 0)"
    style:opacity={planeOpacity}
    style:padding-top="{padTopPx}px"
    style:padding-bottom="{padBottomPx}px"
  >
    {#if underlay && settings.currentUnderlayOpacity > 0}
      <div
        class="phrase-underlay"
        style:top="{underlay.top}px"
        style:left="{underlay.left}px"
        style:width="{underlay.width}px"
        style:height="{underlay.height}px"
        style:opacity={settings.currentUnderlayOpacity}
      ></div>
    {/if}
    <div
      class="column"
      style:width="{settings.columnWidthPercent}%"
      style:font-size="{settings.fontSizePx}px"
      style:line-height={settings.lineHeight}
      style:letter-spacing="{settings.letterSpacingEm}em"
      style:font-family={stageFontStack(settings.fontFamilyId)}
    >
      {#if renderWindow.leadingSpacePx > 0}
        <div class="spacer" style:height="{renderWindow.leadingSpacePx}px"></div>
      {/if}
      {#each visibleBlocks as block, i (block.id)}
        <BlockView
          {block}
          zone={zoneFor(renderWindow.startIndex + i)}
          cursor={renderWindow.startIndex + i === currentBlockIndex ? cursorTokenIndex : null}
          assets={doc.assets}
          showCues={settings.showCues}
          {gapPx}
        />
      {/each}
      {#if renderWindow.trailingSpacePx > 0}
        <div class="spacer" style:height="{renderWindow.trailingSpacePx}px"></div>
      {/if}
    </div>
  </div>

  <!-- Focus fades (layer 6): quiet ramps into the background at both edges. -->
  <div class="fade fade-top" style:height="{fadeVh}vh" aria-hidden="true"></div>
  <div class="fade fade-bottom" style:height="{fadeVh}vh" aria-hidden="true"></div>
</div>

<style>
  .script-layer {
    position: absolute;
    inset: 0;
    overflow: hidden;
    color: var(--stage-text);
  }

  .scroll-plane {
    position: relative;
    min-height: 100%;
    will-change: transform;
  }

  .column {
    margin: 0 auto;
    font-weight: 500;
    display: flex;
    flex-direction: column;
  }

  .spacer {
    flex: none;
  }

  /* Subtle low-contrast rounded underlay — not a karaoke marker (§16.2). */
  .phrase-underlay {
    position: absolute;
    border-radius: 0.35em;
    background: var(--stage-accent);
    pointer-events: none;
    transition:
      top 200ms var(--ease-out, ease-out),
      height 200ms var(--ease-out, ease-out),
      left 200ms var(--ease-out, ease-out),
      width 200ms var(--ease-out, ease-out);
  }

  .fade {
    position: absolute;
    left: 0;
    right: 0;
    pointer-events: none;
  }
  .fade-top {
    top: 0;
    background: linear-gradient(180deg, var(--stage-bg) 0%, transparent 100%);
  }
  .fade-bottom {
    bottom: 0;
    background: linear-gradient(0deg, var(--stage-bg) 0%, transparent 100%);
  }
</style>
