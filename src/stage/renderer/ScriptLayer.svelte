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

  A plain pixel target is still honoured, but only as the fallback used when no
  alignment snapshot is current — it drives the same jerk-limited controller
  rather than a spring of its own (companion §32.1–5, which replaces primary
  §32).
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import type {
    AlignmentSnapshot,
    SmoothFollowProfile,
    StageMotionAck,
    StageRenderDocument,
    StageSettings,
    StageViewportHintPayload,
  } from '../../shared/contracts';
  import { STAGE_EVENT, VIEWPORT_HINT_INTERVAL_MS } from '../../shared/contracts';
  import { emitStageEvent } from '../events';
  import {
    computeReadingBand,
    bandCorrection,
    clampProvisionalTarget,
    computeSafeRect,
    stagePaddingPx,
    fadeDepthPx,
    columnLeftPx,
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
    alignment = null,
    frozen = false,
    reducedMotion = false,
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
    alignment?: AlignmentSnapshot | null;
    frozen?: boolean;
    reducedMotion?: boolean;
    sessionId?: string;
    sessionGeneration?: number;
    stageGeneration?: number;
    scriptCompileHash?: string;
    /**
     * §47.1/§55. The versioned motion profile this session runs on — the user's
     * Follow feel, resolved by control and validated by the
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
  /*
   * The same measured-with-a-fallback viewport as the mount site, for the same
   * reason: `bind:clientWidth/clientHeight` is a ResizeObserver, and its
   * callback runs during a rendering update that a never-shown window may never
   * perform. The stage completes its whole handshake hidden, and every guard
   * below is `vh === 0` — including the one in front of the measurement pass
   * that sends `layout-ready`, so a zero here deadlocked the start sequence.
   *
   * The layer is full-bleed inside the mirror plane, so the window's inner size
   * is the right stand-in, and the observed value replaces it as soon as there
   * is one. A disagreement between the two is just a layout-input change, which
   * is already the trigger for a map rebuild (§33 re-anchor).
   */
  let measuredVw = $state(0);
  let measuredVh = $state(0);
  let windowVw = $state(0);
  let windowVh = $state(0);
  const vw = $derived(measuredVw || windowVw);
  const vh = $derived(measuredVh || windowVh);

  /**
   * The resolved optical geometry, or null on a rig that has never been
   * calibrated.
   *
   * Null is a first-class case, not a failure: an uncalibrated stage still has
   * to prompt, and it does so from the percentage and line-height fields that
   * have always been there. Every derivation below therefore reads `optics`
   * when it exists and falls back to the historical expression when it does
   * not — which is what keeps this change additive.
   */
  const optics = $derived(settings.optics ?? null);

  /* ---------------------------------------------------------------------
   * The pre-optical layout, preserved exactly.
   *
   * These three reproduce the geometry this file shipped with — the `vh`
   * tables and the <=700px "compact" breakpoint that selected between them —
   * and they are used whenever `settings.optics` is absent.
   *
   * They are kept rather than re-derived because the optical work is meant to
   * be ADDITIVE. The old numbers have a real defect (the closing line stops
   * short of the reading band and only landed inside the old dead zone by
   * luck), and the new solver fixes it — but fixing it for somebody who has
   * never opened the calibration screen would silently change their stage on
   * upgrade. The correction ships to rigs that opted into the new model.
   *
   * Deliberately local, and deliberately not re-exported from geometry.ts:
   * this is a compatibility shim with exactly one caller, and giving it a
   * shared home would invite new code to build on the geometry being replaced.
   * ------------------------------------------------------------------- */

  /** The old §16.8 breakpoint: a display around 1024x600 got the compact table. */
  function legacyIsCompact(widthPx: number, heightPx: number): boolean {
    return heightPx > 0 && heightPx <= 700 && widthPx <= 1280;
  }

  function legacyStagePaddingPx(widthPx: number, heightPx: number): { topPx: number; bottomPx: number } {
    const compact = legacyIsCompact(widthPx, heightPx);
    const topVh = compact ? 34 : 38;
    const bottomVh = compact ? 60 : 55;
    return { topPx: (heightPx * topVh) / 100, bottomPx: (heightPx * bottomVh) / 100 };
  }

  function legacyFadeDepthPx(widthPx: number, heightPx: number): { topPx: number; bottomPx: number } {
    // Equal depths, as before — the asymmetry that favours upcoming context is
    // part of the new model, not a bug fix owed to the old one.
    const depth = (heightPx * (legacyIsCompact(widthPx, heightPx) ? 10 : 16)) / 100;
    return { topPx: depth, bottomPx: depth };
  }

  /**
   * The settings as they are ACTUALLY RENDERED.
   *
   * This exists because of a bug class the layout fingerprint was built to
   * prevent, and which the optical layer reintroduced by the back door.
   *
   * `layoutInputs()` and `buildLayoutFingerprint()` both read the flat
   * `StageSettings` fields, and must agree with each other — an input that
   * moves a glyph but is missing from the fingerprint schedules a rebuild that
   * `sameLayout()` then calls identical, so the map is replaced under the OLD
   * generation and the §33 semantic re-anchor never runs. Once geometry could
   * come from `settings.optics` instead, BOTH of them were reading the wrong
   * numbers: changing the calibrated column re-wraps every line while
   * `columnWidthPercent` sits unchanged, and the rebuild is silently classified
   * coverage-only. (The measured-disagreement check downstream would eventually
   * notice the path moved, but it answers with a position-preserving re-anchor
   * rather than the semantic one, which is the wrong recovery for a change the
   * operator deliberately made.)
   *
   * Projecting the resolved optics back onto the flat fields fixes both sides
   * at once and keeps the exhaustive `IDENTIFIES_LAYOUT` table meaningful:
   * there is one description of the layout, and everything reads it.
   */
  const effective = $derived.by((): StageSettings => {
    if (!optics) return settings;
    return {
      ...settings,
      fontSizePx: optics.bodyFontSizePx,
      lineHeight: optics.lineHeight,
      letterSpacingEm: optics.letterSpacingEm,
      paragraphSpacingEm: optics.paragraphSpacingEm,
      // The column is authored in `ch` but the fingerprint's horizontal term is
      // a percentage, so it is expressed as the percentage of the viewport the
      // resolved column actually occupies. What matters is that it MOVES when
      // the rendered column does; the units are the fingerprint's business.
      columnWidthPercent: vw > 0 ? (columnWidthPx / vw) * 100 : settings.columnWidthPercent,
      readingBandCenterPercent: optics.readingBandY * 100,
      pastOpacity: optics.pastOpacity,
      futureOpacity: optics.futureOpacity,
    };
  });

  const linePx = $derived(
    (optics?.bodyFontSizePx ?? settings.fontSizePx) * (optics?.lineHeight ?? settings.lineHeight),
  );

  /**
   * The rectangle the presenter can actually see through the glass.
   *
   * A hood, and most generic housings, reveal less than the whole panel, so
   * every vertical and horizontal question is answered inside this rather than
   * against the window. All-zero insets mean the whole display is visible,
   * which is the right assumption for a bare monitor and the value an
   * uncalibrated rig carries.
   */
  const safeRect = $derived(
    computeSafeRect(vw, vh, optics?.safeArea ?? { top: 0, right: 0, bottom: 0, left: 0 }),
  );

  /*
   * The band sits on the calibrated LENS when there is one, and at the
   * historical 38% of the viewport when there is not.
   *
   * `readingBandY` is a fraction of the safe rectangle and the band API speaks
   * in percent, which is the only reason for the conversion. The dead zone
   * likewise switches from a viewport percentage to line pitches only once a
   * pitch is known — 4% of viewport height is barely half a line on a 600px
   * panel and a full line on a 1080px one, so the same setting produced
   * materially different twitchiness on the two displays this runs on.
   */
  const bandCenterPx = $derived(
    computeReadingBand(vh, {
      centerPercent: optics ? optics.readingBandY * 100 : settings.readingBandCenterPercent,
      halfHeightPercent: settings.readingBandHalfHeightPercent,
      ...(optics
        ? { linePitchPx: linePx, deadZoneLines: optics.deadZoneLines, safeRect }
        : {}),
    }).centerPx,
  );

  /*
   * Padding, derived rather than chosen.
   *
   * These were 38 and 55 `vh` from a hand-tuned table selected by a viewport
   * breakpoint, and the pair did not agree with each other — 38 + 55 leaves the
   * plane short of what the closing line needs to reach the band. Both edges
   * are now solved from the band position and the measured line pitch, so the
   * first and last words are reachable by construction instead of by luck.
   */
  const bandGeometry = $derived({
    safeRect,
    bandCenterPx,
    linePitchPx: linePx,
    futureReserveLines: optics?.futureReserveLines,
  });
  /*
   * Calibrated rigs get the solved padding; uncalibrated ones keep the exact
   * historical table, compact branch included.
   *
   * The old 38/55 (and compact 34/60) pair really is subtly wrong — the closing
   * line stops short of the band and only landed inside the old dead zone by
   * luck. But correcting it for somebody who has never calibrated would change
   * their stage under them on upgrade, which is precisely what "additive" is
   * supposed to rule out. The fix ships to rigs that opted into the new model.
   */
  const legacyPad = $derived(legacyStagePaddingPx(vw, vh));
  const padTopPx = $derived(optics ? stagePaddingPx(bandGeometry).topPx : legacyPad.topPx);
  // §7.1: the rail's reserved band is folded into the bottom padding, so the
  // reading band, the total document height, and the fallback target all keep
  // the script clear of the rail with no separate bookkeeping.
  const padBottomPx = $derived(
    (optics ? stagePaddingPx(bandGeometry).bottomPx : legacyPad.bottomPx) + bottomInsetPx,
  );

  const gapPx = $derived(
    (optics?.paragraphSpacingEm ?? settings.paragraphSpacingEm ?? 0.7) *
      (optics?.bodyFontSizePx ?? settings.fontSizePx),
  );

  /**
   * The column, measured in characters rather than in a share of the window.
   *
   * A viewport percentage means a different number of characters per line on
   * every panel and at every type size, which is the reason 78% could be right
   * on one display and unreadable on the next. `ch` is font-relative, so the
   * measure survives a change of size or family — and the resolver has already
   * decided how many characters this panel can actually deliver.
   */
  const columnWidthPx = $derived(
    optics
      ? Math.min(safeRect.width, optics.columnCh * 0.55 * optics.bodyFontSizePx)
      : (vw * settings.columnWidthPercent) / 100,
  );

  /**
   * The floor for presenter-readable text that is not body copy, in px.
   *
   * Published as a custom property so the block and inline renderers can clamp
   * to it without either of them needing to know about the optical model. An
   * uncalibrated rig gets the em-relative fallback that stage.css already
   * defines, which is why this is only set when there is a real number.
   */
  const secondaryMinCss = $derived(optics ? `${optics.secondaryMinPx}px` : null);

  /**
   * Whether the per-word dimming ramp is allowed to advance.
   *
   * A cursor keeps arriving after the engine has stopped following: it is the
   * last position anyone believed, and the fallback path publishes it while the
   * aligner searches, holds, or calls two matches equally good. Motion stops
   * there deliberately — weak evidence never moves the glass — but the styling
   * used to keep walking on it, greying words behind a reader who had not been
   * located for seconds.
   *
   * That is the display making a claim the engine explicitly refused to make,
   * and it is the more damaging half of the pair, because a presenter reads
   * dimming as "you are here" rather than as an estimate.
   */
  const dimFrozen = $derived(
    alignment !== null && alignment.state !== 'following',
  );

  /**
   * Where the column sits horizontally.
   *
   * `margin: 0 auto` centres on the DISPLAY. A prompter whose camera is not in
   * the middle of its hood therefore pulls the presenter's gaze sideways by
   * exactly the offset nobody compensated for — and sideways is the direction
   * a viewer notices, roughly twice as readily as vertical.
   *
   * Only a calibrated rig knows where its lens is, so an uncalibrated stage
   * keeps centring: `columnLeftPx` against a centred optical centre returns the
   * centred position anyway, but going through the branch makes the intent
   * legible and keeps the auto-margin as the honest "we do not know" case.
   */
  const columnOffsetPx = $derived(
    optics
      ? columnLeftPx({ safeRect, columnWidthPx, opticalCenterX: optics.opticalCenterX })
      : Math.max(0, (vw - columnWidthPx) / 2),
  );

  /*
   * Fades, in line pitches when calibrated and in the historical `vh` when not.
   *
   * The legacy depths are kept verbatim for the uncalibrated path rather than
   * being re-derived, because this change is meant to be additive: somebody who
   * has never opened the calibration screen must get the stage they had
   * yesterday, including its compact-panel treatment.
   */
  const fades = $derived(
    optics
      ? fadeDepthPx(linePx, { topLines: optics.topFadeLines, bottomLines: optics.bottomFadeLines })
      : legacyFadeDepthPx(vw, vh),
  );
  const imageMaxH = $derived(
    optics ? imageMaxHeightVh(safeRect, vh) : legacyIsCompact(vw, vh) ? 70 : 78,
  );

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

  /**
   * Which rendered block a token position falls in.
   *
   * Resolved through the token→node table rather than carried on the snapshot:
   * the engine reports positions and nothing else, and block identity is a
   * property of THIS layout, which only the stage knows.
   */
  function blockIndexForToken(token: number): number | undefined {
    const entry = findTokenEntry(Math.round(token));
    return entry ? blockIndexById.get(entry.blockId) : undefined;
  }

  /** The sentence containing `token`, for the current-phrase underlay. */
  function sentenceForToken(token: number | null) {
    if (token === null) return undefined;
    for (const sentence of sentencesById.values()) {
      if (token >= sentence.startTokenIndex && token <= sentence.endTokenIndex) return sentence;
    }
    return undefined;
  }
  const currentBlockIndex = $derived(
    activeTokenIndex !== null
      ? (blockIndexById.get(findTokenEntry(activeTokenIndex)?.blockId ?? '') ?? -1)
      : alignment
        ? (blockIndexForToken(alignment.confirmedToken) ?? -1)
        : -1,
  );
  const cursorTokenIndex = $derived(
    activeTokenIndex ?? (alignment ? Math.round(alignment.confirmedToken) : null),
  );

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
    /*
     * A document with nothing to measure IS measured.
     *
     * `els.length > 0` was standing in for "the blocks have rendered", which
     * it is — right up until there are no blocks. An empty source compiles to
     * a valid script with zero blocks and preflight lets it start, so the
     * stage hydrated, mounted this layer, and then waited for an element that
     * was never coming: the handshake could not complete and the take died on
     * `waitForStageReady`'s timeout. Asking the document how many blocks it
     * has separates "not rendered yet" from "nothing to render".
     */
    const rendered = els.length > 0 || doc.blocks.length === 0;
    if (!layoutReadySent && rendered) {
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
    // Read from `effective`, not `settings` — see the note on that derivation.
    // A calibrated rig's geometry lives in `settings.optics`, and reading the
    // flat fields here would miss every change the operator actually made.
    return [
      effective.fontSizePx,
      effective.lineHeight,
      effective.letterSpacingEm,
      effective.paragraphSpacingEm,
      effective.columnWidthPercent,
      effective.fontFamilyId,
      effective.showCues,
      effective.mirrorX,
      effective.mirrorY,
      effective.readingBandCenterPercent,
      effective.readingBandHalfHeightPercent,
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
      // The rendered settings, not the authored ones: the fingerprint has to
      // describe the layout that exists, or `sameLayout()` will call two
      // different layouts the same one.
      settings: effective,
      viewportWidthPx: vw,
      viewportHeightPx: vh,
      displayScaleFactor: displayScale,
      // `listenerGeometryHash` is deliberately left at its default. The listener
      // is an absolutely positioned sibling inside the mirror plane; it does not
      // reflow the script column, so no listener geometry can move a glyph here.
      // `fontHash` is likewise not predicted — a font file swapped under the
      // same family id is caught by the MEASURED check below, which covers it
      // and every other unpredicted cause at once.
      // The real rendered padding, not a hard-coded zero: it is solved from the
      // band position and the measured line pitch, and moves every block.
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
      const anchorUnit = engine.lastDisplayToken;
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
    engine.configureSession(sessionGeneration, performance.now());
  });

  $effect(() => {
    engine.setReducedMotion(reducedMotion);
  });

  $effect(() => {
    engine.setBounds(0, maxScroll);
  });

  /* ---- fallback path: snapshot → pixel target, when the engine holds ---- */
  $effect(() => {
    const snap = alignment;
    if (!snap || vh === 0) return;
    const raf = requestAnimationFrame(() => applyTrackingFallback(snap));
    return () => cancelAnimationFrame(raf);
  });

  function applyTrackingFallback(snap: AlignmentSnapshot) {
    if (performance.now() < manualUntilMs) return;
    const pos = tokenRect(Math.round(snap.confirmedToken));
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
    if (snap.state !== 'following') {
      // Weak or contested evidence never triggers large movement (§16.4). The
      // engine has already stopped advancing the position; this bounds what
      // the fallback may do with the position it is holding.
      target = clampProvisionalTarget(current, target, PROVISIONAL_MAX_CORRECTION_PX);
    } else {
      const cls = classifyTransition({
        decision: snap.decision,
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
    // Read the two inputs that may start or stop the loop BEFORE the untracked
    // region, so they — and only they — are this effect's dependencies.
    const active = !frozen && vh > 0;
    /*
     * `untrack` here is the whole reason the stage scrolls.
     *
     * `startLoop` re-anchors the engine to what is already on the glass, which
     * means it reads `scrollY`. A `$state` read inside an effect body is a
     * DEPENDENCY, and the frame loop writes `scrollY` on every displayed frame
     * — so this effect re-ran once per frame: the cleanup tore the loop down,
     * the body built a fresh one, and `visibilityRestored` zeroed the plant's
     * velocity and acceleration on the way through.
     *
     * A jerk-limited plant restarted from rest every 16 ms never gets out of
     * its own jerk ramp. Measured in the browser preview: the document moved
     * at ~1 px/s while the reading position advanced at ~35 px/s, so the
     * script highlighted the right words, the reader walked off the bottom of
     * the screen, and the page never scrolled — a teleprompter that does not
     * prompt. The effect is guarded rather than the function, because
     * `startLoop` reading the live scroll position is correct; being
     * re-invoked for it is not.
     */
    untrack(() => {
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
    });
    return () => stopLoop();
  });

  $effect(() => {
    if (typeof document === 'undefined') return;
    const onVisibility = () => {
      // §32.4: stop work while hidden; on restore re-anchor to what is on
      // screen rather than replaying all missed motion. The re-anchor is
      // `startLoop`'s, not this handler's — it used to be both, which is one
      // decision with two owners, and the second call landed after the first
      // had already reset the fade.
      if (document.hidden) {
        stopLoop();
      } else if (!frozen && vh > 0) {
        startLoop();
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
      if (result.activeTokenIndex !== null && result.source === 'alignment') {
        activeTokenIndex = result.activeTokenIndex;
      } else if (result.source !== 'alignment') {
        activeTokenIndex = alignment ? Math.round(alignment.confirmedToken) : null;
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
    reportViewport(now);
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
    const sentence = sentenceForToken(token);
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
  export function pushAlignmentSnapshot(snapshot: AlignmentSnapshot): boolean {
    return engine.receiveSnapshot(snapshot, performance.now());
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

  /* ------------------------------------------------------------- viewport --
   * The "this is what I can see" prior.
   *
   * A PRIOR, not a command: it biases the engine's candidate ranking toward
   * the part of the script actually on the glass, which is what makes a lock
   * that starts mid-script fast instead of ambiguous, and makes a far jump to
   * something off-screen need an extra round of evidence before it is taken.
   *
   * It has to travel as an event rather than a command because the stage
   * window holds no invoke permission at all. Debounced, because a flung
   * scroll would otherwise put a hint on the bus for every frame of its
   * travel, and the engine only re-ranks about once a second anyway.
   */
  let lastHintAtMs = 0;
  let lastHintRange: [number, number] | null = null;

  function reportViewport(nowMs: number) {
    if (nowMs - lastHintAtMs < VIEWPORT_HINT_INTERVAL_MS) return;
    const map = lineMap;
    if (!map || !map.valid || vh === 0) {
      // No measured geometry means no honest claim about what is visible.
      // Clearing is the truthful move: an asserted range we cannot stand
      // behind would bias the engine toward the wrong part of the script.
      if (lastHintRange !== null) {
        lastHintRange = null;
        lastHintAtMs = nowMs;
        emitStageEvent<StageViewportHintPayload>(STAGE_EVENT.viewportHint, {
          sessionGeneration,
          firstToken: 0,
          lastToken: 0,
          cleared: true,
        });
      }
      return;
    }

    let first = Number.POSITIVE_INFINITY;
    let last = Number.NEGATIVE_INFINITY;
    for (const line of map.lines) {
      // Document coordinates; the plane is translated by `-scrollY`, so a line
      // is on screen when its box overlaps [scrollY, scrollY + vh].
      if (line.bottomY < scrollY || line.topY > scrollY + vh) continue;
      if (line.firstTokenIndex < first) first = line.firstTokenIndex;
      if (line.lastTokenIndex > last) last = line.lastTokenIndex;
    }
    if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) return;
    if (lastHintRange && lastHintRange[0] === first && lastHintRange[1] === last) return;

    lastHintRange = [first, last];
    lastHintAtMs = nowMs;
    emitStageEvent<StageViewportHintPayload>(STAGE_EVENT.viewportHint, {
      sessionGeneration,
      firstToken: first,
      lastToken: last,
      cleared: false,
    });
  }

  const visibleBlocks = $derived(
    doc.blocks.slice(renderWindow.startIndex, renderWindow.endIndex),
  );
</script>

<!-- Initialised synchronously from `window.innerWidth/innerHeight`, which is
     what makes the viewport nonzero before anything has been painted. -->
<svelte:window bind:innerWidth={windowVw} bind:innerHeight={windowVh} />

<div
  class="script-layer"
  data-degraded={degraded ? 'true' : 'false'}
  bind:clientWidth={measuredVw}
  bind:clientHeight={measuredVh}
  style:--stage-past-opacity={effective.pastOpacity}
  style:--stage-future-opacity={effective.futureOpacity}
  style:--stage-secondary-min={secondaryMinCss}
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
      style:width="{columnWidthPx}px"
      style:margin-left="{columnOffsetPx}px"
      style:font-size="{effective.fontSizePx}px"
      style:line-height={effective.lineHeight}
      style:letter-spacing="{effective.letterSpacingEm}em"
      style:font-weight={optics?.fontWeight ?? settings.fontWeight ?? 500}
      style:font-family={stageFontStack(settings.fontFamilyId)}
    >
      {#if renderWindow.leadingSpacePx > 0}
        <div class="spacer" style:height="{renderWindow.leadingSpacePx}px"></div>
      {/if}
      {#each visibleBlocks as block, i (block.id)}
        <BlockView
          {block}
          {dimFrozen}
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
  <!-- Depths in line pitches, not `vh`: the top fade is deeper than the bottom
       because material above the band has been spoken and is receding, while
       material below it is about to be needed and must stay readable for as
       long as possible. Equal depths treated the two as the same thing. -->
  <div class="fade fade-top" style:height="{fades.topPx}px" aria-hidden="true"></div>
  <div class="fade fade-bottom" style:height="{fades.bottomPx}px" aria-hidden="true"></div>
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
