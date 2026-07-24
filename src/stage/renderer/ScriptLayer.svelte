<!--
  Compiled-document renderer and the stage's single rAF loop
  (companion §26.2, §31, §32, §33; spec §16.2–16.5).

  Motion is NOT a per-event animation. One persistent `StageMotionEngine` owns
  position, velocity, acceleration and authority for the life of the session;
  this component only:

    1. measures the rendered layout into an immutable RenderedLineMap,
    2. pumps the engine once per animation frame,
    3. applies the resulting scroll offset to one transformed layer,
    4. refreshes active/passed styling at a separately capped rate.

  `TrackingSnapshot` is still honoured, but only as the degraded path used when
  no semantic frame is current — it supplies a pixel target to the same
  jerk-limited controller instead of driving its own spring (companion §32.1–5,
  which replaces primary §32).
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import type {
    SemanticMotionFrame,
    SmoothFollowProfile,
    StageMotionAck,
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
  import { classifyTransition, PROVISIONAL_MAX_CORRECTION_PX } from './motion';
  import {
    shouldVirtualize,
    computeOffsets,
    computeWindow,
    estimateBlockHeightPx,
    DEFAULT_OVERSCAN_PX,
  } from './virtualization';
  import { stageFontStack } from './text';
  import BlockView from './BlockView.svelte';
  import {
    awaitLayoutStable,
    buildLayoutFingerprint,
    buildRenderedLineMap,
    createStageMotionEngine,
    emptyRenderedLineMap,
    maxPathDisagreementPx,
    measureStageLayout,
    sameLayout,
    type FallbackTarget,
    type StageRenderedLineMap,
  } from '../motion';

  let {
    doc,
    settings,
    tracking = null,
    frozen = false,
    reducedMotion = false,
    compact = false,
    sessionId = '',
    sessionGeneration = 0,
    stageGeneration = 0,
    scriptCompileHash = '',
    followProfile = undefined,
    bottomInsetPx = 0,
    onlayoutready = undefined,
    onmotionack = undefined,
    onlayoutgeneration = undefined,
    onlayouterror = undefined,
    ondegraded = undefined,
  }: {
    doc: StageRenderDocument;
    settings: StageSettings;
    tracking?: TrackingSnapshot | null;
    frozen?: boolean;
    reducedMotion?: boolean;
    compact?: boolean;
    sessionId?: string;
    sessionGeneration?: number;
    stageGeneration?: number;
    scriptCompileHash?: string;
    /**
     * §47.1/§55. The versioned motion profile this session runs on — the user's
     * Follow feel and Voice lead, resolved by control and validated by the
     * mount site (`stageFollowProfile`). Given to the engine at construction
     * AND on every change, because the stage window outlives a session.
     */
    followProfile?: SmoothFollowProfile;
    /**
     * §7.1. Extra bottom inset the script must give up for the Coaching Rail's
     * reserved band. Applied by the mount site before the take begins and held
     * for the whole take; the reading band and every measurement fold it into
     * the bottom padding, so the script never scrolls under the rail.
     */
    bottomInsetPx?: number;
    onlayoutready?: () => void;
    onmotionack?: (ack: StageMotionAck) => void;
    onlayoutgeneration?: (generation: number) => void;
    /**
     * §62: the measurement is unusable after a bounded retry; the stage holds.
     * Called again with an EMPTY list once a later rebuild succeeds, so the
     * operator's recoverable-error notice can clear itself.
     */
    onlayouterror?: (issues: string[]) => void;
    /**
     * §61: the frame budget is being missed (or is being met again). The mount
     * site relays this to the layers that can cheapen themselves; the styling
     * cadence and the motion limits already back off inside the engine.
     */
    ondegraded?: (degraded: boolean) => void;
  } = $props();

  /* ---- viewport + derived layout ---- */
  let planeEl: HTMLDivElement | undefined = $state();
  let vw = $state(0);
  let vh = $state(0);

  const padding = $derived(stagePadding(compact));
  const padTopPx = $derived((vh * padding.topVh) / 100);
  // §7.1: the rail's reserved band is folded into the bottom padding, so the
  // reading band, the total document height, and the fallback target all keep
  // the script clear of the rail with no separate bookkeeping.
  const padBottomPx = $derived((vh * padding.bottomVh) / 100 + bottomInsetPx);
  const gapPx = $derived((settings.paragraphSpacingEm ?? 0.7) * settings.fontSizePx);
  const columnWidthPx = $derived((vw * settings.columnWidthPercent) / 100);
  const fadeVh = $derived(fadeDepthVh(compact));
  const imageMaxH = $derived(imageMaxHeightVh(compact));
  const linePx = $derived(settings.fontSizePx * settings.lineHeight);

  /* ---- scroll state ---- */
  let scrollY = $state(0);
  /**
   * §20.4. Opacity of the document layer, owned by the engine's re-anchor
   * transition. `1` for the whole of an ordinary read; it dips to `0` around
   * the single frame on which a large skip, a distant retake or a command jump
   * rewrites the transform, so the presenter sees the text dim and return in
   * place rather than fly across the glass.
   *
   * It is applied to the SAME element as `scrollY`, deliberately: Svelte
   * flushes both style writes in one update, so the browser can never paint a
   * frame with the new transform and the old opacity.
   */
  let documentOpacity = $state(1);
  let manualUntilMs = 0;
  const MANUAL_GRACE_MS = 2500;

  /* ---- the persistent motion controller (companion §26.2) ---- */
  /*
   * §47.1. The engine is constructed with whatever profile is already known —
   * `untrack` because this read is deliberately the initial value, and Svelte is
   * right to warn about any other one — and then KEPT IN SYNC by the effect
   * below.
   *
   * Both halves are load-bearing, for different orderings. The constructor read
   * covers the normal case, where the envelope arrives before this component
   * mounts (the mount site gates on `doc`, which comes from the envelope), so
   * the very first frame already runs the chosen feel. The effect covers the
   * stage window outliving a session: a second take republishes an envelope into
   * this same component instance, and a construction-only read would silently
   * run take two on take one's feel.
   */
  const engine = createStageMotionEngine(
    untrack(() => (followProfile ? { profile: followProfile } : {})),
  );
  $effect(() => {
    if (followProfile) engine.setProfile(followProfile);
  });
  let rafId = 0;
  let loopRunning = false;
  let layoutGeneration = 0;
  let lineMap: StageRenderedLineMap | null = null;
  let lineMapPending = false;
  let lastMapBuildAtMs = 0;
  const MAP_REBUILD_THROTTLE_MS = 250;
  /** §62 recovery: one bounded retry, then report and stay held. */
  let mapRetries = 0;
  let layoutErrorReported = false;
  const MAX_MAP_RETRIES = 1;
  const MAP_RETRY_DELAY_MS = 300;
  /**
   * How far the motion path may move between two rebuilds of the "same" layout
   * before it counts as a new one. Sub-pixel differences are measurement noise;
   * anything the presenter could see is not.
   */
  const GEOMETRY_DRIFT_TOLERANCE_PX = 1;

  /**
   * §61 step 1. The stage is missing its frame budget, so nonessential visual
   * effects come off.
   *
   * What that means here is narrow on purpose. The reading band, the past /
   * future dimming and the current-phrase underlay are how the presenter finds
   * their place on the glass — they are the product, not an effect, and they
   * stay exactly as they are. What goes is the ANIMATION of them: the per-word
   * and per-block opacity tweens and the underlay's geometry tween, each of
   * which asks the compositor to interpolate a property on many elements at the
   * same moment the frame budget is already being missed. Removing them changes
   * nothing about what is shown, only that it arrives at once instead of over
   * 240 ms.
   */
  let degraded = $state(false);

  /* ---- capped-rate styling (§26.2 step 7) ---- */
  let activeTokenIndex = $state<number | null>(null);
  let underlay = $state<{ top: number; left: number; width: number; height: number } | null>(null);

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

  /**
   * The window's IDENTITY, as opposed to the object `computeWindow` returns.
   *
   * `renderWindow` is a fresh object on every 400 px scroll bucket, so anything
   * that reads it re-runs on every bucket — including the line-map effect,
   * which turns a scroll into a full `Range.getClientRects()` measurement pass
   * over the whole rendered document (§63: no layout reads after map creation).
   * Only a change in which blocks are rendered can change the geometry, and
   * that is what this key says.
   */
  const renderWindowKey = $derived(
    `${renderWindow.startIndex}:${renderWindow.endIndex}:${Math.round(renderWindow.leadingSpacePx)}:${Math.round(renderWindow.trailingSpacePx)}`,
  );

  /**
   * Device pixel ratio, as a reactive value.
   *
   * `displayScaleFactor` is in the §7.2 fingerprint, but nothing ever observed
   * it: dragging the stage window between a Retina display and an external
   * monitor re-rasterizes every glyph at a different device scale — which moves
   * sub-pixel advances and therefore line breaks — and scheduled no rebuild at
   * all. A DPR change fires the `resolution` media query, which is the only
   * event browsers offer for it.
   */
  let displayScale = $state(typeof window === 'undefined' ? 1 : window.devicePixelRatio);
  $effect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    let query: MediaQueryList | null = null;
    const onChange = () => {
      displayScale = window.devicePixelRatio;
      watch();
    };
    // The query has to be re-armed after every change: it tests for ONE ratio.
    function watch() {
      query?.removeEventListener?.('change', onChange);
      query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      query.addEventListener?.('change', onChange);
    }
    watch();
    return () => query?.removeEventListener?.('change', onChange);
  });

  const blockIndexById = $derived(new Map(doc.blocks.map((b, i) => [b.id, i])));
  const sentencesById = $derived(new Map((doc.sentences ?? []).map((s) => [s.id, s])));
  const currentBlockIndex = $derived(
    activeTokenIndex !== null
      ? (blockIndexById.get(findTokenEntry(activeTokenIndex)?.blockId ?? '') ?? -1)
      : tracking
        ? (blockIndexById.get(tracking.blockId) ?? -1)
        : -1,
  );
  const cursorTokenIndex = $derived(activeTokenIndex ?? tracking?.tokenIndex ?? null);

  function zoneFor(index: number): 'past' | 'current' | 'future' {
    if (currentBlockIndex < 0) return 'future';
    if (index < currentBlockIndex) return 'past';
    if (index === currentBlockIndex) return 'current';
    return 'future';
  }

  /* ---- block measurement pass ---- */
  $effect(() => {
    // Re-measure when the document, typography, viewport, or window changes.
    // Anything that moves a glyph belongs here AND in `layoutInputs()`.
    void doc;
    void layoutInputs();
    void renderWindowKey;
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
      // `offsetHeight` is a ROUNDED integer. The line map measures the same
      // boxes with `getBoundingClientRect()`, so every block contributed up to
      // half a pixel of disagreement between `maxScroll` (computed from these)
      // and the path (computed from those) — and it accumulates in one
      // direction over a long script. Read the same sub-pixel geometry the map
      // reads; the layout cost is identical.
      const h = el.getBoundingClientRect().height;
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

  /**
   * Every layout-affecting input, read reactively in one place.
   *
   * This list and `buildLayoutFingerprint` have to agree: an input read here but
   * missing from the fingerprint schedules a rebuild that `sameLayout()` then
   * calls identical, so the map is silently replaced under the OLD generation
   * and the §33 semantic re-anchor is skipped. The fingerprint side is now
   * enforced by an exhaustive table in `measure.ts`; this side is enforced by
   * `measure.test.ts`, which walks every settings field that moves a glyph.
   */
  function layoutInputs(): string {
    return [
      settings.fontSizePx,
      settings.lineHeight,
      settings.letterSpacingEm,
      settings.paragraphSpacingEm,
      settings.columnWidthPercent,
      settings.fontFamilyId,
      settings.showCues,
      settings.mirrorX,
      settings.mirrorY,
      settings.readingBandCenterPercent,
      settings.readingBandHalfHeightPercent,
      padTopPx,
      padBottomPx,
      vw,
      vh,
      displayScale,
    ].join('|');
  }

  /* ---- rendered line map (companion §7, §33) ---- */
  $effect(() => {
    // A change here invalidates the map, bumps the layout generation, and
    // requests a bounded layout_recovery re-anchor.
    void doc;
    void layoutInputs();
    void measureVersion;
    void renderWindowKey;
    if (!planeEl || vh === 0 || vw === 0) return;
    scheduleLineMapBuild();
  });

  function scheduleLineMapBuild() {
    if (lineMapPending) return;
    lineMapPending = true;
    void (async () => {
      try {
        // §7.1: measure only once fonts and layout-affecting assets are final.
        if (planeEl) await awaitLayoutStable(planeEl);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        rebuildLineMap();
      } finally {
        lineMapPending = false;
      }
    })();
  }

  function rebuildLineMap() {
    if (!planeEl || vh === 0) return;
    const now = performance.now();

    const base = {
      scriptCompileHash,
      stageGeneration,
      settings,
      viewportWidthPx: vw,
      viewportHeightPx: vh,
      displayScaleFactor: displayScale,
      // `listenerGeometryHash` is deliberately left at its default. The listener
      // is an absolutely positioned sibling inside the mirror plane; it does not
      // reflow the script column, so no listener geometry can move a glyph here.
      // `fontHash` is likewise not predicted — a font file swapped under the
      // same family id is caught by the MEASURED check below, which covers it
      // and every other unpredicted cause at once.
      // The real rendered padding, not a hard-coded zero: `stagePadding()`
      // changes with the compact-viewport breakpoint and moves every block.
      paddingTopPx: padTopPx,
      paddingBottomPx: padBottomPx,
    };
    // A real layout change always rebuilds and bumps the generation; a
    // coverage-only rebuild (windowed rendering scrolled) reuses it and is
    // throttled, because it is the same layout with more of it measured.
    const layoutChanged = !sameLayout(lineMap?.fingerprint ?? null, {
      ...buildLayoutFingerprint({ ...base, layoutGeneration }),
    });
    if (!layoutChanged && lineMap && now - lastMapBuildAtMs < MAP_REBUILD_THROTTLE_MS) return;
    lastMapBuildAtMs = now;
    if (layoutChanged) layoutGeneration += 1;

    const band = computeReadingBand(vh, {
      centerPercent: settings.readingBandCenterPercent,
      halfHeightPercent: settings.readingBandHalfHeightPercent,
    });
    const measurement = measureStageLayout({
      plane: planeEl,
      blocks: doc.blocks,
      fallbackLineHeightPx: linePx,
      // §16.7: the script sits inside the mirror plane, and
      // getBoundingClientRect() reports post-transform viewport space.
      mirrorX: settings.mirrorX,
      mirrorY: settings.mirrorY,
    });
    const fingerprint = buildLayoutFingerprint({ ...base, layoutGeneration });

    const next =
      measurement.tokens.length > 0
        ? buildRenderedLineMap({
            fingerprint,
            tokens: measurement.tokens,
            blocks: measurement.blocks,
            readingLineStartY: band.centerPx,
            // §30.3's upper safety boundary is the corridor's top edge, so what
            // the motion engine needs is the distance from `R` up to it — the
            // computed band, including its clamps, not the raw setting.
            readingBandHalfHeightPx: band.centerPx - band.topPx,
            lineHeightPx: measurement.lineHeightPx,
            viewportHeightPx: vh,
            maxScrollPx: maxScroll,
            // A paragraph, media, or section gap may not produce an unbounded
            // spline slope (§8.5, §8.6).
            maxSlopePxPerUnit: Math.max(1, measurement.lineHeightPx) * 8,
            boundarySlopeClampPxPerUnit: Math.max(1, measurement.lineHeightPx) * 3,
          })
        : emptyRenderedLineMap(fingerprint);

    const previousMap = lineMap;
    const hadValidMap = previousMap !== null && previousMap.valid;

    /* A rebuild the fingerprint called "the same layout" can still have moved
     * every glyph (§33). The two ways it happens in production are a font file
     * swapped under an unchanged family id, and a virtualized height ESTIMATE
     * replaced by a real measurement — the latter shifts the spacer under a
     * scroll transform that did not move, so the text visibly jumps on long
     * scripts and no §33 re-anchor ever runs because the rebuild was classified
     * coverage-only. Measure the disagreement instead of trying to predict its
     * causes: if the path moved where both maps cover it, the §33 re-anchor has
     * to run whatever the declared inputs say.
     *
     * The generation is deliberately NOT bumped here. A generation bump is a
     * claim that what the stage published about this layout is stale, and it
     * costs a re-sync window during which frames are only coasting. Nothing
     * downstream holds pixel geometry — frames and directives are in spoken
     * units, and the stage recomputes every pixel from its own map — so a map
     * that merely got MORE ACCURATE about inputs that did not change has
     * nothing to invalidate. What it does need is the re-anchor, and that is
     * what it gets.
     */
    const disagreementPx =
      !layoutChanged && hadValidMap && next.valid
        ? maxPathDisagreementPx(previousMap, next)
        : 0;
    const geometryMoved = disagreementPx > GEOMETRY_DRIFT_TOLERANCE_PX;

    lineMap = next;
    engine.setBounds(0, maxScroll);

    if (layoutChanged && hadValidMap && next.valid) {
      // Live relayout: preserve semantic position, not raw scrollTop (§33).
      // `layoutRecovery` also advances the receiver gate to the new generation.
      engine.layoutRecovery({ map: next, nowMs: now });
    } else if (geometryMoved && previousMap) {
      // The presenter did not ask for anything: the map simply got more
      // accurate. Preserve the position ON THE GLASS rather than snapping the
      // reading line, so a corrected estimate is invisible instead of a jump.
      const anchorUnit = engine.lastPrediction?.unit ?? null;
      const wasAt = anchorUnit === null ? null : previousMap.sampleMotionPath(anchorUnit)?.scrollPx;
      engine.layoutRecovery({
        map: next,
        nowMs: now,
        ...(anchorUnit !== null && wasAt !== undefined && wasAt !== null
          ? { anchorUnit, anchorViewportY: next.readingLineStartY + wasAt - scrollY }
          : {}),
      });
    } else {
      engine.setLineMap(next);
      engine.receiver.setGate({ layoutGeneration }, now);
    }
    if (layoutChanged) onlayoutgeneration?.(layoutGeneration);

    // §62: an unusable measurement is recoverable — layout may simply not have
    // settled yet. Rebuild ONCE, then stop retrying and report it. The stage
    // holds throughout (the engine suspends both the semantic planner and the
    // guessed snapshot fallback while the map is unresolved), so a retry loop
    // would only burn frames on the presenter's glass.
    if (!next.valid) {
      if (mapRetries < MAX_MAP_RETRIES) {
        mapRetries++;
        window.setTimeout(() => {
          lastMapBuildAtMs = 0;
          scheduleLineMapBuild();
        }, MAP_RETRY_DELAY_MS);
      } else if (!layoutErrorReported) {
        layoutErrorReported = true;
        onlayouterror?.(next.issues.filter((i) => i.fatal).map((i) => i.code));
      }
    } else {
      mapRetries = 0;
      if (layoutErrorReported) {
        // The map came back. A §62 stage-layout error is *recoverable*, and the
        // operator was told about it, so they have to be told it is over too —
        // otherwise the control window keeps offering "Rebuild stage layout"
        // for a stage that rebuilt itself. An empty issue list is the recovery.
        layoutErrorReported = false;
        onlayouterror?.([]);
      }
    }
  }

  /* ---- session gate (companion §26.1) ---- */
  $effect(() => {
    engine.configureSession(
      {
        sessionId,
        sessionGeneration,
        scriptCompileHash,
        layoutGeneration,
      },
      performance.now(),
    );
  });

  $effect(() => {
    engine.setReducedMotion(reducedMotion);
  });

  $effect(() => {
    engine.setBounds(0, maxScroll);
  });

  /* ---- degraded path: TrackingSnapshot → pixel target (§32 fallback) ---- */
  $effect(() => {
    const snap = tracking;
    if (!snap || vh === 0) return;
    const raf = requestAnimationFrame(() => applyTrackingFallback(snap));
    return () => cancelAnimationFrame(raf);
  });

  function applyTrackingFallback(snap: TrackingSnapshot) {
    if (performance.now() < manualUntilMs) return;
    const pos = tokenRect(snap.tokenIndex);
    if (!pos) return;
    // §62: the off-window branch of `tokenRect` estimates a position from block
    // offsets and ESTIMATED heights. That is guessed geometry, and it is exactly
    // what must not drive motion while the rendered map is unresolved. A
    // genuinely measured rect is fine — it is the same DOM the map reads.
    if (!pos.measured && (lineMap === null || !lineMap.valid)) return;
    const band = computeReadingBand(vh, {
      centerPercent: settings.readingBandCenterPercent,
      halfHeightPercent: settings.readingBandHalfHeightPercent,
    });
    const current = scrollY;
    // Inside the dead zone there is no correction to make: hold position.
    let target = bandCorrection(pos.topDoc, pos.height, current, band) ?? current;
    target = clamp(target, 0, maxScroll);

    let disposition: FallbackTarget['disposition'] = 'follow';
    if (snap.provisional) {
      // Provisional matches never trigger large movement (spec §16.4).
      target = clampProvisionalTarget(current, target, PROVISIONAL_MAX_CORRECTION_PX);
    } else {
      const cls = classifyTransition({
        movement: snap.movement,
        distancePx: Math.abs(target - current),
        viewportHeightPx: vh,
        reducedMotion,
      });
      disposition =
        cls === 'smooth_jump'
          ? 'catch_up'
          : cls === 'fade_jump'
            ? 'reanchor'
            : cls === 'instant'
              ? 'instant'
              : 'follow';
    }

    engine.setFallbackTarget({ scrollPx: target, disposition, atMs: performance.now() });
  }

  /**
   * Document-space top of a viewport rect, undoing the mirror plane's flip
   * (§16.7). `getBoundingClientRect()` is post-transform, so under `scaleY(-1)`
   * an element's measured `top` is its distance from the plane's bottom.
   */
  function docTopOf(rect: DOMRect, planeRect: DOMRect): number {
    return settings.mirrorY ? planeRect.bottom - rect.bottom : rect.top - planeRect.top;
  }

  /* ---- token position resolution (degraded path only) ---- */
  function tokenRect(
    tokenIndex: number,
  ): { topDoc: number; height: number; measured: boolean } | null {
    if (!planeEl) return null;
    const planeRect = planeEl.getBoundingClientRect();
    const el = planeEl.querySelector<HTMLElement>(`[data-t="${tokenIndex}"]`);
    if (el) {
      const r = el.getBoundingClientRect();
      return { topDoc: docTopOf(r, planeRect), height: r.height, measured: true };
    }
    // Off-window or unmapped: estimate from the block's offsets.
    const entry = findTokenEntry(tokenIndex);
    if (!entry) return null;
    const idx = blockIndexById.get(entry.blockId);
    if (idx === undefined) return null;
    const blockEl = planeEl.querySelector<HTMLElement>(`[data-block-id="${entry.blockId}"]`);
    if (blockEl) {
      const r = blockEl.getBoundingClientRect();
      // The block is rendered, but the token inside it is not: the position is
      // a midpoint guess, not a measurement.
      return { topDoc: docTopOf(r, planeRect) + r.height / 2, height: linePx, measured: false };
    }
    const top = offsets[idx] ?? 0;
    const h = heights[idx] ?? linePx;
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
    return { topDoc: top + h * fraction, height: linePx, measured: false };
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

  /* ---- the frame loop (companion §26.2, B.5) ---- */
  $effect(() => {
    const active = !frozen && vh > 0;
    if (active) {
      startLoop();
    } else {
      stopLoop();
      /* §20.4 safety net. Nothing advances the fade once the loop is gone, so
       * a freeze landing inside a re-anchor would otherwise leave the script
       * parked at partial opacity for as long as the stage is stopped. The
       * engine clears its own fade on the way back in (`visibilityRestored`,
       * called from `startLoop`), so the two agree at 1 when frames resume. */
      documentOpacity = 1;
    }
    return () => stopLoop();
  });

  $effect(() => {
    if (typeof document === 'undefined') return;
    const onVisibility = () => {
      // §32.4: stop work while hidden; on restore re-anchor to what is on
      // screen rather than replaying all missed motion.
      if (document.hidden) {
        stopLoop();
      } else {
        engine.visibilityRestored(scrollY, performance.now());
        if (!frozen && vh > 0) startLoop();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  });

  function startLoop() {
    if (loopRunning) return;
    loopRunning = true;
    engine.visibilityRestored(scrollY, performance.now());
    rafId = requestAnimationFrame(frame);
  }

  function stopLoop() {
    loopRunning = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function frame(now: number) {
    if (!loopRunning) return;
    const result = engine.frame(now);
    setScroll(result.scrollPx);
    // §20.4: never a CSS transition. The obscuration has to be on the engine's
    // clock, because the guarantee being made is about the ordering of two
    // writes to this element — hand the browser its own easing curve and the
    // transform can land while the layer is still visible.
    if (result.documentOpacity !== documentOpacity) documentOpacity = result.documentOpacity;

    if (result.styleTick) {
      if (result.activeTokenIndex !== null && result.source === 'semantic') {
        activeTokenIndex = result.activeTokenIndex;
      } else if (result.source !== 'semantic') {
        activeTokenIndex = tracking?.tokenIndex ?? null;
      }
      // Layout reads for the underlay happen on the capped styling tick, never
      // on every frame (§63).
      updateUnderlay();
    }

    if (result.degraded !== degraded) {
      degraded = result.degraded;
      // §61 step 3 lives outside this component (the Listener), so the flag has
      // to leave the engine rather than stop at the styling cadence.
      ondegraded?.(degraded);
    }

    if (result.ack) onmotionack?.(result.ack);
    rafId = requestAnimationFrame(frame);
  }

  function setScroll(y: number) {
    scrollY = y;
    const bucket = Math.floor(y / 400);
    if (bucket !== scrollBucket) scrollBucket = bucket;
  }

  function updateUnderlay() {
    if (!planeEl || settings.currentUnderlayOpacity <= 0) {
      underlay = null;
      return;
    }
    const token = cursorTokenIndex;
    if (token === null) {
      underlay = null;
      return;
    }
    const planeRect = planeEl.getBoundingClientRect();
    const sentence = tracking ? sentencesById.get(tracking.sentenceId) : undefined;
    const startEl = sentence
      ? planeEl.querySelector<HTMLElement>(`[data-t="${sentence.startTokenIndex}"]`)
      : null;
    const endEl = sentence
      ? planeEl.querySelector<HTMLElement>(`[data-t="${sentence.endTokenIndex}"]`)
      : null;
    const curEl = planeEl.querySelector<HTMLElement>(`[data-t="${token}"]`);
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
    // Same mirror compensation as the measurement pass: the underlay is
    // positioned in the plane's untransformed coordinate space.
    const docTop = settings.mirrorY ? planeRect.bottom - bottom : top - planeRect.top;
    const docLeft = settings.mirrorX ? planeRect.right - right : left - planeRect.left;
    underlay = {
      top: docTop - padY,
      left: docLeft - padX,
      width: right - left + padX * 2,
      height: bottom - top + padY * 2,
    };
  }

  /* ---- public surface ---- */

  /** Feed one accepted-or-rejected semantic frame to the receiver (§26.1). */
  export function pushSemanticFrame(frame: SemanticMotionFrame): boolean {
    return engine.receiveFrame(frame, performance.now());
  }

  /**
   * Manual navigation (spec §16.5, companion §30.6): immediate authority,
   * automatic correction suspended for a short grace interval.
   */
  export function manualScrollBy(deltaPx: number) {
    const y = clamp(scrollY + deltaPx, 0, maxScroll);
    const now = performance.now();
    engine.manualOverride(y, now);
    manualUntilMs = now + MANUAL_GRACE_MS;
    setScroll(y);
  }

  /** One text line in logical pixels, for arrow-key steps. */
  export function lineHeightPx(): number {
    return linePx;
  }

  /** Operator diagnostics (§64) — never rendered on the presenter's glass. */
  export function motionDiagnostics() {
    return {
      // Which §55 profile the engine is ACTUALLY running: the resolved feel, or
      // `default-v1` if the envelope carried nothing this build could interpret.
      profileId: engine.profile.id,
      profileVersion: engine.profile.version,
      layoutGeneration,
      lineCount: lineMap?.lines.length ?? 0,
      mapValid: lineMap?.valid ?? false,
      mapIssues: lineMap?.issues.map((i) => i.code) ?? [],
      frames: engine.diagnostics.metrics,
      rejections: engine.receiver.stats,
      degraded: engine.diagnostics.degraded,
    };
  }

  const visibleBlocks = $derived(
    doc.blocks.slice(renderWindow.startIndex, renderWindow.endIndex),
  );
</script>

<div
  class="script-layer"
  data-degraded={degraded ? 'true' : 'false'}
  bind:clientWidth={vw}
  bind:clientHeight={vh}
  style:--stage-past-opacity={settings.pastOpacity}
  style:--stage-future-opacity={settings.futureOpacity}
  style:--stage-image-max-h="{imageMaxH}vh"
>
  <!-- §31.1: one immutable document layer moved by the controller. Nothing
       else in the stage moves for ordinary scroll. -->
  <div
    class="scroll-plane"
    bind:this={planeEl}
    data-reanchoring={documentOpacity < 1 ? 'true' : 'false'}
    style:transform="translate3d(0, {-scrollY}px, 0)"
    style:opacity={documentOpacity}
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

  /* §61 step 1: nonessential visual effects off under frame pressure.
     One inherited custom property drives every zoning/underlay tween in this
     subtree — including the child components' scoped rules, which read the same
     variable. Nothing about WHAT is drawn changes: the reading band, the
     past/future opacities and the phrase underlay are all still exactly where
     and what they were; they simply stop being interpolated. */
  .script-layer[data-degraded='true'] {
    --stage-fx-ms: 0ms;
  }

  .scroll-plane {
    position: relative;
    min-height: 100%;
    will-change: transform, opacity;
    /* §31.2: the controller owns motion — no CSS smooth scrolling, no
       per-update transitions on the moving layer. §20.4 extends that to
       opacity: the re-anchor fade is driven frame by frame from the engine, so
       a CSS transition here would race it and let the transform change while
       the document is still visible. */
    scroll-behavior: auto;
    transition: none;
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
    /* The underlay itself is a reading aid and is never disabled; only its
       glide between phrases is (§61 step 1). */
    transition-property: top, height, left, width;
    transition-duration: var(--stage-fx-ms, 200ms);
    transition-timing-function: var(--ease-out, ease-out);
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
