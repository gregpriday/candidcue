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
<script module lang="ts">
  import type { FontMetrics } from '../../shared/optics';

  /**
   * What the stage learned about the face it is actually drawing.
   *
   * The optical model turns ratios into millimetres: a body size is a cap
   * height divided by `capHeightRatio`, a reading measure is a width divided by
   * `avgCharWidthRatio`. Control resolves those against DIN fallbacks because
   * control does not render the font — only the window that paints it can
   * measure it. So the stage measures, and hands the numbers back, and the
   * calibration screen can finally say whether it is describing this rig or a
   * plausible average of every rig.
   *
   * `charactersPerLine` is the RENDERED median rather than the resolver's
   * capacity figure: the resolver says how many characters the column should
   * hold, this says how many the presenter is looking at. When they disagree,
   * the resolver's font metrics are wrong, which is the whole reason to report
   * both.
   */
  export interface StageLayoutMeasurement {
    fontMetrics: FontMetrics;
    /** The pitch the layout is built on — measured once a map exists. */
    linePitchPx: number;
    /** False while `linePitchPx` is still the typographic line box. */
    linePitchMeasured: boolean;
    /** Median characters per rendered line, or null before anything is measured. */
    charactersPerLine: number | null;
  }
</script>

<script lang="ts">
  import { untrack } from 'svelte';
  import type {
    AlignmentSnapshot,
    RenderedLine,
    ResolvedOptics,
    SafeRenderNode,
    SmoothFollowProfile,
    StageAutoScrollEndReason,
    StageAutoScrollPayload,
    StageMotionAck,
    StageRenderDocument,
    StageSettings,
    StageViewportHintPayload,
  } from '../../shared/contracts';
  import {
    STAGE_EVENT,
    VIEWPORT_HINT_INTERVAL_MS,
    VIEWPORT_HINT_REFRESH_MS,
  } from '../../shared/contracts';
  import { resolveStageGeometry } from '../../shared/optical-resolve';
  import { emitStageEvent } from '../events';
  import {
    computeReadingBand,
    bandCorrection,
    clampProvisionalTarget,
    computeSafeRect,
    lineEntryOffsetPx,
    stagePaddingPx,
    fadeDepthPx,
    columnLeftPx,
    imageMaxHeightVh,
    VIEWPORT_REFLOW_SETTLE_MS,
    clamp,
  } from './geometry';
  import { classifyTransition, provisionalMaxCorrectionPx } from './motion';
  import {
    advanceAutoScrollTarget,
    autoScrollAtEnd,
    autoScrollBlockBoxes,
    autoScrollNowhereToGo,
    autoScrollPxPerSecond,
    measureAutoScrollScale,
    type AutoScrollScale,
  } from './autoscroll';
  import {
    shouldVirtualize,
    computeOffsets,
    computeWindow,
    estimateBlockHeightPx,
    seedScrollForToken,
    DEFAULT_OVERSCAN_PX,
  } from './virtualization';
  import { segmentText, stageFontStack } from './text';
  import { projectForPerformance, type PerformanceMode } from '../../shared/performance-view';
  import { clearFontMetricsCache, measureFontMetrics } from './fontMetrics';
  import { clearAdvanceCache } from './advance';
  import { EMPTY_WRAP_PLAN, planScriptBreaks } from './wrap-plan';
  import BlockView from './BlockView.svelte';
  import ReadingCue from './ReadingCue.svelte';
  import {
    awaitLayoutStable,
    buildLayoutFingerprint,
    buildRenderedLineMap,
    createStageMotionEngine,
    emptyRenderedLineMap,
    maxPathDisagreementPx,
    measureStageLayout,
    sameLayout,
    tokenFragmentRects,
    type AlignmentReceiverStats,
    type FallbackTarget,
    type MeasuredTokenRect,
    type StageRenderedLineMap,
  } from '../motion';

  let {
    doc,
    settings,
    alignment = null,
    frozen = false,
    followPaused = false,
    reducedMotion = false,
    sessionId = '',
    sessionGeneration = 0,
    stageGeneration = 0,
    scriptCompileHash = '',
    followProfile = undefined,
    bottomInsetPx = 0,
    openingTokenIndex = 0,
    cueHollow = false,
    rehearsal = false,
    autoScroll = null,
    onautoscrollend = undefined,
    onlayoutready = undefined,
    onlayoutmeasured = undefined,
    onmotionack = undefined,
    onlayoutgeneration = undefined,
    onlayouterror = undefined,
    ondegraded = undefined,
    onplacedchange = undefined,
  }: {
    doc: StageRenderDocument;
    settings: StageSettings;
    /**
     * The token this take OPENS at (CCUX-014). Zero for a take from the top,
     * which is every take that does not ask otherwise.
     *
     * The envelope has carried `initialTokenIndex` since it was written and
     * nothing here read it, so a take asked to start at a section opened at the
     * top of the script and then travelled — a jerk-limited crawl through six
     * minutes of text before the presenter could say a word. The opening
     * placement is deliberately `instant`, so honouring this costs no motion:
     * it changes WHICH row is put on the mark, not how it gets there.
     */
    openingTokenIndex?: number;
    alignment?: AlignmentSnapshot | null;
    frozen?: boolean;
    /**
     * §48. Voice following is switched off: the presenter is driving the script
     * themselves, by wheel or by key.
     *
     * Distinct from `frozen`, which stops the frame loop outright — the loop
     * has to keep running here, because the plant still has to settle, the
     * wheel still writes positions into it, and the fade still has to be able
     * to unwind. What stops is automatic motion.
     */
    followPaused?: boolean;
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
    /**
     * The first rung of the hold ladder: the reading cue goes solid → outline.
     *
     * Decided at the mount site, because the ladder is timed from how long the
     * ALIGNMENT STATE has been away from `following` and this component sees
     * snapshots rather than durations. Passing the resolved rung down keeps one
     * stopwatch for the whole disclosure — the cue and the chip cannot disagree
     * about how long the hold has lasted, which is what a second timer here
     * would guarantee they eventually did.
     */
    cueHollow?: boolean;
    /**
     * This reading is a rehearsal, so show the whole document (§practice).
     *
     * The performance projection replaces a table, an image, a diagram and a
     * code fence with four words apiece, which is right in front of a camera
     * and wrong at a desk: the reference table is the thing being rehearsed
     * against. `performance-view.ts` has drawn this distinction since it was
     * written and had only the diagnostic stage mode to select it with.
     *
     * Safe to flip per take because the projection cannot move a spoken token —
     * it only touches blocks that carry none — so the aligner's indices are the
     * same document either way.
     */
    rehearsal?: boolean;
    /**
     * The fixed-pace transport, when the operator has taken the wheel.
     *
     * Null and `running: false` are the same instruction — do not drive — and
     * both are ordinary: the second is a paused transport that still remembers
     * its pace, which is what the operator gets back when they resume.
     *
     * This never competes with voice following. The engine prefers an accepted
     * alignment frame over any fallback target, so on the frames where
     * recognition is working the pace set here is simply not consulted, and the
     * one place the two could actually collide — the alignment path's own
     * fallback corrections — stands down below while this is running.
     */
    autoScroll?: StageAutoScrollPayload | null;
    /**
     * The transport reached the end of the script.
     *
     * Reported rather than handled here, because "there is no more script" is
     * not the renderer's decision to act on: the mount site owns the transport's
     * running flag, and a stage that quietly stopped itself would leave control
     * showing a Pause button for a document that cannot move.
     *
     * The reason travels with it because the two ends mean different things to
     * the take: one is a place in the script, the other moved nothing. See
     * `StageAutoScrollEndReason`.
     */
    onautoscrollend?: (reason: StageAutoScrollEndReason) => void;
    /**
     * The layout settled. Carries what the stage measured about the face it
     * drew, because the window that paints the font is the only one that can
     * measure it and control needs those numbers during calibration.
     */
    onlayoutready?: (measurement: StageLayoutMeasurement) => void;
    /**
     * A rebuilt line map produced new numbers.
     *
     * `onlayoutready` fires one frame before the first map exists — the
     * measurement pass that completes the handshake runs on an earlier rAF than
     * the one that measures token rects — so the handshake payload necessarily
     * carries the typographic pitch and no character count. This is how the real
     * measurement catches up, and it keeps firing for the life of the take, which
     * is what makes it useful while somebody is dragging a calibration control.
     */
    onlayoutmeasured?: (measurement: StageLayoutMeasurement) => void;
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
    /**
     * Whether the reading composition may be shown, and the plate lifted.
     *
     * Named for what the caller does with it rather than for a guarantee it
     * cannot make. On every ordinary path this IS "placed in its final
     * position" — the frame loop reports it the frame the plant reaches its
     * target. On the two §62 paths it is not: an unusable map after the retry
     * budget is spent, and the reveal ceiling, both show the script without
     * knowing where it belongs, because the alternative is a stage that stays
     * dark. Waiting is bounded; hiding is not a state a take can be left in.
     *
     * It has to come from here rather than be recomputed at the mount site:
     * `manualScrollBy` reveals SYNCHRONOUSLY on a wheel gesture, and a plate
     * driven by a parallel predicate would sit over a script the presenter has
     * just put where they want it.
     */
    onplacedchange?: (placed: boolean) => void;
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
  const rawVw = $derived(measuredVw || windowVw);
  const rawVh = $derived(measuredVh || windowVh);

  /*
   * The settle interval is `VIEWPORT_REFLOW_SETTLE_MS`, imported rather than
   * declared, because the mid-take mode switch has to wait out the same interval
   * before it recomposes. See the note at its definition in `geometry.ts`.
   *
   * Why it exists at all, having not been needed for three years: until reader
   * mode the viewport changed exactly ONCE per take — `startTake` presents the
   * window and waits for it to settle BEFORE the stage mounts, precisely so the
   * line map is measured once at the size it will be read at. There was nothing
   * to coalesce. A reading window has an edge somebody can drag, and a drag
   * delivers a resize per frame; each one is a layout input, so each one asks for
   * a `document.fonts.ready` wait, a full re-measure of every block, and a §33
   * semantic re-anchor.
   */

  /**
   * The viewport the LAYOUT is computed against: the real one, once it has
   * stopped moving.
   *
   * Deliberately the value everything downstream reads, rather than a second
   * viewport beside the live one. A split — live geometry, settled wrapping —
   * means the band, the padding and the fades track a window whose line map
   * describes a different width, and every one of those disagreements is a real
   * pixel offset in where the reading position is. One viewport, slightly late,
   * is a document that lags a drag by a tenth of a second; two viewports is a
   * document that is wrong about itself.
   */
  let vw = $state(0);
  let vh = $state(0);

  $effect(() => {
    const width = rawVw;
    const height = rawVh;
    if (width === 0 || height === 0) return;
    /*
     * The FIRST measurement lands immediately, with no debounce.
     *
     * Everything about the opening is a wait already — the font settle, the
     * measurement pass, the plant reaching the opening — and all of it is behind
     * the plate. Spending another 120 ms before the layout can even begin would
     * add that delay to every take to coalesce a resize sequence that, at open,
     * has exactly one member.
     */
    if (vw === 0 || vh === 0) {
      vw = width;
      vh = height;
      return;
    }
    if (width === vw && height === vh) return;
    // Trailing edge: the cleanup below cancels this the moment the raw viewport
    // moves again, so a continuous drag schedules once and fires once.
    const timer = setTimeout(() => {
      vw = width;
      vh = height;
    }, VIEWPORT_REFLOW_SETTLE_MS);
    return () => clearTimeout(timer);
  });

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
  const envelopeOptics = $derived(settings.optics ?? null);

  /**
   * Reader mode resolves its own geometry, here, against the window it is
   * actually in.
   *
   * ---------------------------------------------------------------------------
   * WHY CONTROL'S ANSWER IS NOT USABLE FOR A READING WINDOW
   * ---------------------------------------------------------------------------
   * `stageSettingsFromSettings` resolves against `display.logicalSize` — the
   * whole panel. For a prompter that is exactly right, because the window IS the
   * panel. A reading window is some fraction of it, and the fraction changes
   * whenever somebody drags an edge.
   *
   * Type SIZE survives that (it is angular, and `mmPerCssPx` is a property of the
   * display rather than of the window), which is why reader mode works at all
   * without this. What does not survive is the MEASURE: the character target was
   * chosen against a width the reader does not have, and `columnWidthPx` below
   * clamps the resulting column to `safeRect.width` — silently, without running
   * the fit check's narrowing pass. So a reading window could sit under the
   * character floor with no warning, and `hardwareFitCheck` — described in
   * `optics.ts` as "the primary mechanism of the width system" — would never run.
   *
   * Resolving here also gets the MEASURED font metrics rather than the DIN
   * fallbacks, which control's own note says it cannot supply: "Control cannot
   * measure a font it does not render... which the stage improves on once it has
   * painted its own text."
   *
   * ---------------------------------------------------------------------------
   * AND WHY PROMPTER MODE STILL DOES NOT
   * ---------------------------------------------------------------------------
   * Because it works, and this is the one path in the app that a benchmark
   * describes. Prompter geometry is what every Tier A/B/C number was measured
   * against, and moving its resolve — even to a place that would produce the same
   * answer for a window that fills its panel, plus better font metrics — is a
   * change that has to be PROVEN not to move the numbers rather than argued not
   * to. It is phase 5 of the reader-mode spec for that reason, and it is
   * deliberately last.
   *
   * The fork is temporary and it is the kind this codebase warns about (see
   * `bench/README.md` on Tier C drifting from `src/stage/motion/`). What keeps it
   * honest meanwhile is that both arms call the SAME `resolveStageGeometry` with
   * the same profile — the difference is which viewport and whose metrics, not
   * which model.
   */
  const readerOptics = $derived.by((): ResolvedOptics | null => {
    if (settings.readingContext !== 'reader') return null;
    const profile = settings.opticalProfile;
    if (!profile) return null;
    if (vw <= 0 || vh <= 0) return null;
    return resolveStageGeometry({
      profile,
      metrics: fontMetrics,
      viewport: { widthPx: vw, heightPx: vh },
      readingContext: 'reader',
    }).optics;
  });

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
  const optics = $derived(readerOptics ?? envelopeOptics);

  /**
   * Take mode reads; rehearsal mode reads AND shows the working.
   *
   * Derived from `stageMode` rather than given a control of its own. The two
   * questions — how much instrumentation, how much rich content — are genuinely
   * different axes, but nobody wants a clean take that still renders a code card
   * at prompting distance, and nobody rehearsing wants their reference table
   * replaced by the words REFER TO TABLE. One choice, stated once.
   *
   * The projection replaces non-spoken visual blocks with short readable cues.
   * It cannot move a spoken token — `projectForPerformance` only touches blocks
   * that carry none — which is what makes it safe to apply after the compiler
   * has assigned the indices the aligner tracks against.
   */
  const performanceMode = $derived<PerformanceMode>(
    rehearsal || (settings.stageMode ?? 'clean') === 'diagnostic' ? 'rehearsal' : 'take',
  );

  /**
   * The blocks as they will actually be drawn.
   *
   * Everything downstream reads THIS rather than `doc.blocks`: the measurement
   * pass, the virtualization estimates, the line map and the render all have to
   * agree about what exists, or the map describes a document nobody is looking
   * at. Switching mode swaps a full-height table for a one-line chip, which
   * moves every glyph below it — so it is a layout input too, and is declared
   * as one below.
   */
  const performanceBlocks = $derived(projectForPerformance(doc.blocks, performanceMode));

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
      /*
       * Opacity is deliberately NOT taken from the optics here.
       *
       * `buildStageSettings` already flattens the resolved values onto these
       * fields, and it is the layer that knows whether the presenter also
       * turned past-dimming OFF — which it encodes by writing a flat opacity
       * near 1. Overwriting that with `optics.pastOpacity` made the
       * "Past-text dimming" toggle inert on every calibrated rig: the setting
       * persisted, the envelope carried it, and the glass ignored it.
       *
       * Neither field is a layout-fingerprint input, so leaving them on the
       * flat values costs the projection nothing.
       */
    };
  });

  const linePx = $derived(
    (optics?.bodyFontSizePx ?? settings.fontSizePx) * (optics?.lineHeight ?? settings.lineHeight),
  );

  /* ---------------------------------------------------------------------
   * The face, measured.
   * ------------------------------------------------------------------- */

  /**
   * Bumped when a font finishes loading, to force a re-measure.
   *
   * `measureFontMetrics` caches by stack, weight and reference size, and the
   * cache key cannot see the one thing that matters here: the same stack
   * resolving to a different FACE. A measurement taken before a bundled font
   * lands describes the fallback, and would then be served for the rest of the
   * session — cap height, and therefore every angular claim made about this
   * rig, wrong by however far the two faces differ.
   */
  let fontEpoch = $state(0);

  /**
   * The proportions of the font this stage is drawing, not of "a sans".
   *
   * Measured at the weight that will be rendered: a bold face has different
   * advances from its regular, so measuring 400 and drawing 600 measures a
   * different font. Everything downstream that needs a ratio reads this — the
   * reading cue's size, the rendered character count, the layout fingerprint's
   * font term — so there is one answer to "what face is on the glass".
   */
  const fontMetrics = $derived.by((): FontMetrics => {
    void fontEpoch;
    /*
     * `envelopeOptics`, NOT `optics` — and this is load-bearing, not tidiness.
     *
     * `readerOptics` resolves FROM these metrics, so reading the merged `optics`
     * here would be a derivation cycle: metrics → resolve → weight → metrics.
     * Svelte 5 detects that and throws rather than settling on a value.
     *
     * Breaking it on the envelope side is correct as well as convenient. The
     * weight is the one input to the measurement that the viewport cannot change
     * — `resolveStageGeometry` reads it off the profile's overrides or a constant,
     * never off the panel — so control's answer and the stage's are the same
     * answer, and taking the one that does not close the loop costs nothing.
     */
    return measureFontMetrics(stageFontStack(settings.fontFamilyId), {
      fontWeight: envelopeOptics?.fontWeight ?? settings.fontWeight ?? 500,
    });
  });

  $effect(() => {
    const fonts = typeof document === 'undefined' ? undefined : document.fonts;
    if (!fonts?.ready) return;
    let disposed = false;
    void fonts.ready.then(
      () => {
        if (disposed) return;
        // The cache is global and keyed on the stack, so this clears the
        // fallback measurement for every stack at once — which is right: a font
        // finishing is evidence about the whole document, not about one family.
        clearFontMetricsCache();
        // Same reasoning, same moment: every advance measured before the real
        // face arrived was measured against a fallback, and a line planned on
        // those widths is planned for a font nobody is looking at.
        clearAdvanceCache();
        fontEpoch += 1;
      },
      () => {
        // A font that never resolves leaves the estimate in place, and
        // `metrics.measured` already says the numbers are an estimate.
      },
    );
    return () => {
      disposed = true;
    };
  });

  /**
   * One cap height in CSS pixels — the size of a capital letter on this glass.
   *
   * The reading cue is drawn in this rather than in pixels or `em` so the mark
   * stays exactly the size of a letter at every viewing distance and on every
   * panel. A fixed 24px tick is a letter on a 15.6-inch panel at arm's length
   * and a speck on a 9-inch one calibrated for two metres.
   */
  const capHeightPx = $derived(effective.fontSizePx * fontMetrics.capHeightRatio);

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
  /*
   * ONE band, read by everything.
   *
   * This used to publish only its centre, and the two places that actually
   * drive motion — the rendered line map and the snapshot fallback — each
   * recomputed a band of their own from the flat `readingBandCenterPercent` and
   * the 4%-of-viewport half height. So on a calibrated rig the ticks, the
   * padding and the fades marked the lens while the engine drove to 38% of the
   * window, and `deadZoneLines` was resolved, fingerprinted, and read by
   * nothing: the corridor stayed a viewport fraction on every panel, which is
   * the exact defect the line-unit model was built to remove.
   *
   * The band is a property of the rig, not of a caller, so it is derived once
   * here and handed to both. The uncalibrated path is unaffected by
   * construction — with no `optics` this is the same call those two were
   * already making.
   */
  const readingBand = $derived(
    computeReadingBand(vh, {
      centerPercent: optics ? optics.readingBandY * 100 : settings.readingBandCenterPercent,
      halfHeightPercent: settings.readingBandHalfHeightPercent,
      ...(optics
        ? {
            linePitchPx: linePx,
            deadZoneLines: optics.deadZoneLines,
            safeRect,
            lensPlacement: optics.lensPlacement,
          }
        : {}),
    }),
  );
  const bandCenterPx = $derived(readingBand.centerPx);

  /**
   * `R` — where a line ENTERS, which is not where the mark is.
   *
   * See `lineEntryOffsetPx`. The document (padding included) sits this far below
   * the mark — half a cap height, the baseline-to-cap-centre correction — so that
   * the mark and the letters share a centre at the instant a line is entered,
   * rather than the mark pointing at the gap under the text.
   *
   * Derived from the typographic pitch rather than the measured one on purpose:
   * the same number has to reach the top padding and the line map, and those are
   * computed at different moments. A pitch the two could disagree about would
   * put the offset in the document twice with different values, which is the
   * one way this can go wrong.
   */
  const lineEntryPx = $derived(lineEntryOffsetPx(linePx, capHeightPx));

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
    // The plane is `inset: 0` and bounded by `totalHeight - vh`, so the
    // padding has to be solved against the same height. See `stagePaddingPx`.
    viewportHeightPx: vh,
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
  /*
   * The line-entry offset is paid here, once, in the paper above the first line.
   *
   * Adding it to the top padding AND to `R` is what makes the change a pure
   * shift: every knot is `baselineY - R`, both terms grow by the same amount,
   * and the path comes out numerically identical to the one this stage was
   * tuned and benchmarked against. It also carries the tail — the padding is
   * part of the height `maxScroll` is derived from, so the ceiling a clamped
   * closing knot rests on rises with it and the last line ends up exactly where
   * it always did on the glass. Only the phase between the document and the
   * mark moves.
   *
   * Skipping it here would instead compress the opening lines — the first knot
   * would clamp at scroll 0 and the script would crawl through line one — and
   * strand the closing line an offset short of the mark. Real artefacts, not
   * rounding differences.
   *
   * Both branches, calibrated and legacy: the mark points at the wrong line on
   * every rig, so the correction belongs to every rig.
   */
  /**
   * The legacy table cannot be allowed to strand an END of the script.
   *
   * ---------------------------------------------------------------------------
   * THE DEFECT
   * ---------------------------------------------------------------------------
   * `legacyStagePaddingPx` is a fixed 38/55 (or 34/60) `vh` and knows nothing
   * about `readingBandCenterPercent`, which the presenter may set anywhere in
   * 20..70 (`APPEARANCE_LIMITS`). The MARK moves with that setting and the paper
   * above the first line did not, so past about 45% the opening wanted a NEGATIVE
   * scroll: `placeOpeningPosition` clamps to 0, the first line came to rest above
   * the mark, and no gesture could bring it down because 0 is also the floor for
   * manual scrolling. Measured on a 1440x900 panel at 64px/1.32, the first line
   * sat 42px above the mark at a 50% band, 132px at 60% and 222px at 70% — and
   * the presenter could only watch it.
   *
   * The same hole exists at the other end. The closing line needs
   * `vh - centre - pitch/2` of paper beneath it to reach the mark; the legacy 55
   * `vh` is short of that for any band below ~24%, so a high band stranded the
   * LAST line instead of the first.
   *
   * ---------------------------------------------------------------------------
   * WHY THE TWO EDGES ARE TREATED DIFFERENTLY
   * ---------------------------------------------------------------------------
   * Both only ever ADD paper, and only when the band asks for it, so a rig that
   * has never moved its reading band renders byte-identically and the literals
   * pinned in `tests/dom/script-layer-uncalibrated-parity.test.ts` still hold.
   * They reach that promise by different routes, and the difference is not
   * arbitrary:
   *
   *   TOP — the requirement is computed directly (`centre - pitch/2`, which is
   *   exactly what the calibrated solver uses). At a 38% band the table is
   *   already the larger number on BOTH the roomy and the compact panel, so this
   *   changes nothing at the default and simply becomes correct once the band
   *   moves down.
   *
   *   BOTTOM — the same computation would change the default, because the legacy
   *   55 `vh` is genuinely ~33px short of what the closing line needs even at 38%.
   *   That shortfall is the KNOWN defect the parity file preserves on purpose:
   *   it fell inside the old dead zone, and correcting it belongs to rigs that
   *   opted into the optical model rather than to everyone's stage on upgrade. So
   *   the bottom is compensated only for how far the band has MOVED from the 38%
   *   the tables were tuned beside. The documented defect survives; the unbounded
   *   version of it — 228px, nearly three lines, at a 20% band — does not.
   *
   * `maxScrollPx` is `totalHeight - vh` and the padding is part of `totalHeight`,
   * so raising either edge raises the ceiling with it: the tail stays reachable.
   */
  /** The band the legacy `vh` tables were hand-tuned beside (`APPEARANCE_LIMITS`). */
  const LEGACY_TUNED_BAND_FRACTION = 0.38;

  function reachableTopPx(tablePx: number, needPx: number): number {
    // A non-finite or negative need is not a claim about geometry, so it cannot
    // be allowed to become the padding. The table stands on its own.
    if (!Number.isFinite(needPx) || needPx <= 0) return tablePx;
    return Math.max(tablePx, needPx);
  }

  function reachableBottomPx(tablePx: number, bandCentre: number, heightPx: number): number {
    if (!Number.isFinite(bandCentre) || !Number.isFinite(heightPx) || heightPx <= 0) {
      return tablePx;
    }
    const movedUpPx = LEGACY_TUNED_BAND_FRACTION * heightPx - bandCentre;
    return movedUpPx > 0 ? tablePx + movedUpPx : tablePx;
  }

  const padTopPx = $derived(
    (optics
      ? stagePaddingPx(bandGeometry).topPx
      : reachableTopPx(legacyPad.topPx, bandCenterPx - linePx / 2)) + lineEntryPx,
  );
  // §7.1: the rail's reserved band is folded into the bottom padding, so the
  // reading band, the total document height, and the fallback target all keep
  // the script clear of the rail with no separate bookkeeping.
  const padBottomPx = $derived(
    (optics
      ? stagePaddingPx(bandGeometry).bottomPx
      : reachableBottomPx(legacyPad.bottomPx, bandCenterPx, vh)) + bottomInsetPx,
  );

  const gapPx = $derived(
    (optics?.paragraphSpacingEm ?? settings.paragraphSpacingEm ?? 0.7) *
      (optics?.bodyFontSizePx ?? settings.fontSizePx),
  );

  /* ---------------------------------------------------------------------
   * The sentence microgap
   *
   * Extra space after a full stop, INSIDE a long paragraph only.
   *
   * A paragraph is a block on the glass, and the space between blocks is what
   * tells a reader where they are. Inside a six-line paragraph there is no such
   * signal: a presenter who looks away and back has to re-read to find which
   * sentence they were in, and the one place their eye can re-enter cleanly —
   * the start of a sentence — looks exactly like the middle of one.
   *
   * A short paragraph does not have that problem, which is why the gap is
   * withheld from them: two sentences are held in one glance, and spacing them
   * apart would only make an ordinary paragraph look broken.
   *
   * It is DISPLAY ONLY. Nothing here touches the script, the token stream or
   * anything spoken — the words, their order and their token indexes are
   * untouched, and the compiled document is not consulted for anything but
   * where its sentences end. What it does do is MOVE GLYPHS, which is why it is
   * a layout input (see `layoutInputs`) and why a change to it has to be
   * classified as a relayout rather than as the same layout measured again.
   * ------------------------------------------------------------------- */

  /**
   * Sentences a paragraph must hold before its sentence boundaries are spaced.
   *
   * Three, not two. Two sentences in a block are read as one thought and the
   * block boundary is still close enough to orient by; from the third the
   * reader is genuinely inside undifferentiated text. Counting SENTENCES rather
   * than rendered lines is deliberate: rendered height depends on the gap
   * itself, so a height threshold would let a paragraph add a gap, grow past the
   * threshold, and qualify for the gap it already has.
   */
  const MICROGAP_MIN_SENTENCES = 3;

  /**
   * Strong sentence punctuation, closing quotes and brackets allowed after it.
   *
   * The compiler's sentence spans are the authority on WHERE a sentence ends;
   * this is the check that the ending is one a reader can see. A span that ends
   * on "Dr" or on a line break is a segmentation artefact, and spacing after it
   * would put a hole in the middle of a clause.
   */
  const STRONG_SENTENCE_END = /[.!?…][)\]"'”’]*$/;

  /** Rendered text per spoken token, for punctuation and character counting. */
  const tokenTextByIndex = $derived.by(() => {
    const out = new Map<number, string>();
    const walk = (nodes: readonly SafeRenderNode[]): void => {
      for (const node of nodes) {
        if (node.type === 'text') {
          for (const segment of segmentText(node.text, node.tokenIndexes, node.wordTokens)) {
            if (segment.space || segment.tokenIndex === null) continue;
            out.set(segment.tokenIndex, segment.text);
          }
        } else if (node.type === 'link') {
          walk(node.label);
        } else if (node.type === 'table') {
          for (const row of node.rows) for (const cell of row) walk(cell);
        }
      }
    };
    for (const block of performanceBlocks) walk(block.renderNodes);
    return out;
  });

  const microgapPx = $derived(
    optics && optics.sentenceMicrogapLines > 0
      ? Math.max(0, optics.sentenceMicrogapLines) * linePx
      : 0,
  );

  /** Tokens the gap is drawn after: sentence-final, punctuated, not block-final. */
  const microgapTokens = $derived.by(() => {
    const out = new Set<number>();
    if (microgapPx <= 0) return out;
    const byBlock = new Map<string, number[]>();
    for (const sentence of doc.sentences ?? []) {
      const ends = byBlock.get(sentence.blockId);
      if (ends) ends.push(sentence.endTokenIndex);
      else byBlock.set(sentence.blockId, [sentence.endTokenIndex]);
    }
    for (const ends of byBlock.values()) {
      if (ends.length < MICROGAP_MIN_SENTENCES) continue;
      const sorted = [...ends].sort((a, b) => a - b);
      // Every boundary but the last: a gap after the closing sentence would
      // only pad the block's own bottom margin, where the paragraph gap already
      // is.
      for (let i = 0; i < sorted.length - 1; i++) {
        const token = sorted[i];
        if (token === undefined) continue;
        if (!STRONG_SENTENCE_END.test(tokenTextByIndex.get(token) ?? '')) continue;
        out.add(token);
      }
    }
    return out;
  });

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
   * Where the lines break, chosen rather than discovered.
   *
   * The browser breaks at the last word that fits; a prompter wants the break
   * at the phrase boundary the eye returns from comfortably. `wrap-plan.ts`
   * measures each word in the face it will be drawn in and asks the solver.
   *
   * Planned over the WHOLE document, not the render window. Per-block plans are
   * independent, so windowing them would give the same lines — but the
   * signature below is a layout fingerprint input, and one that moved every
   * time the window scrolled would rebuild the line map mid-take for no reason.
   *
   * `fontEpoch` is read for its dependency alone: every advance measured before
   * the real face loaded was measured against a fallback.
   */
  const wrapPlan = $derived.by(() => {
    void fontEpoch;
    // Off is exactly the pre-existing behaviour: nothing measured, nothing
    // planned, the browser wraps. Absent means on — see the contract note. On
    // is a request, not a promise: a column under `MIN_PLANNED_COLUMN_CHARS`
    // (every prompter take under the automatic profile) is left to the browser
    // too, and the planner says so with its own signature.
    if (settings.semanticLineBreaks === false) return EMPTY_WRAP_PLAN;
    return planScriptBreaks(performanceBlocks, {
      columnWidthPx,
      baseStyle: {
        fontStack: stageFontStack(settings.fontFamilyId),
        fontSizePx: effective.fontSizePx,
        fontWeight: optics?.fontWeight ?? settings.fontWeight ?? 500,
        italic: false,
        mono: false,
        letterSpacingPx: effective.letterSpacingEm * effective.fontSizePx,
      },
      /*
       * The microgap is drawn onto sentence-final tokens as `margin-inline-end`
       * after this plan is made, and at ordinary stage sizes it is several
       * times the safety margin. Planning without it would put a line over the
       * column, the browser would wrap it, and the planned break would then
       * strand the word it moved — the one way this feature could make a line
       * worse rather than merely no better.
       */
      microgapPx,
      microgapTokens,
    });
  });

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
  /**
   * Scroll position the alignment feed last asked for, or null before it has
   * asked for anything. See `alignmentGapPx`.
   */
  let lastAlignmentTargetPx: number | null = null;

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
  // §48. The engine holds the document while following is off, and arms the
  // §30.6 re-grab on the way back on — see `setPaused`.
  $effect(() => {
    engine.setPaused(followPaused, performance.now());
  });
  let rafId = 0;
  let loopRunning = false;
  let layoutGeneration = 0;
  let lineMap: StageRenderedLineMap | null = null;
  /**
   * The transport's words-to-pixels scale for `lineMap`, measured with it.
   *
   * Built at the rebuild rather than in `driveAutoScroll`, because the block
   * boxes it needs to tell words from screenshots exist only there — the map
   * keeps the lines and drops the measurement. Replaced on every rebuild along
   * with the map it describes, so a size change mid-roll still re-derives it.
   */
  let autoScrollScale: AutoScrollScale | null = null;
  let lineMapPending = false;
  let lastMapBuildAtMs = 0;
  const MAP_REBUILD_THROTTLE_MS = 250;
  /** §62 recovery: one bounded retry, then report and stay held. */
  let mapRetries = 0;
  /**
   * A §62 rebuild is scheduled but has not run.
   *
   * Read by the opening's reveal deadline, which must not call a wait that is
   * 300 ms from its answer a wait that failed.
   */
  let mapRetryPending = false;
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
   * The MEASURED line pitch, or null before anything has been measured.
   *
   * Null is not a defect and is never papered over with the typographic value:
   * the motion bounds that read it (`provisionalMaxCorrectionPx`,
   * `classifyTransition`) each fall back to their pixel constant when the pitch
   * is unknown, and a guessed pitch would let them license a screen-sized
   * correction off a font that never loaded.
   */
  let measuredLinePitchPx: number | null = null;
  /** Median characters per rendered line; null until a valid map exists. */
  let measuredCharactersPerLine: number | null = null;
  /** The microgap the CURRENT map was measured at — see `rebuildLineMap`. */
  let mappedMicrogapPx: number | null = null;

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
  /** One box per rendered line of the current sentence; empty when not drawn. */
  let underlay = $state<Array<{ top: number; left: number; width: number; height: number }>>([]);

  /**
   * Whether the phrase underlay is drawn at all.
   *
   * The fixed reading cue replaces it, so it is no longer what an ordinary rig
   * gets: it survives for the presenter who has chosen the loud cue AND left
   * phrase highlighting on, which is the one combination where marking the
   * sentence adds something the band mark does not already say. Every other rig
   * gets the mark that cannot be wrong about the script, and nothing underneath
   * it.
   */
  const underlayEnabled = $derived(
    (settings.readingCue ?? 'ticks') === 'wash' && settings.currentUnderlayOpacity > 0,
  );

  /* ---- measurement + virtualization ---- */
  const virtual = $derived(shouldVirtualize(performanceBlocks.length));
  const measuredHeights = new Map<string, number>();
  let measureVersion = $state(0);
  let layoutReadySent = false;

  /*
   * Block ids survive the performance projection, and that is exactly why this
   * cache has to be emptied when the projection changes.
   *
   * Keeping the id is right — it keys the `{#each}`, the `[data-block-id]`
   * lookups and this cache, and changing it would tear down and rebuild every
   * rendered block for a change that is mostly cosmetic. But it means a table
   * and the one-line chip that replaces it are the SAME key, so a mode switch
   * leaves a six-line measurement standing in for a chip (or the reverse).
   *
   * Off-window blocks are the damaging case: they are never re-measured, so the
   * stale height sits in `offsets` and therefore in `maxScroll`, and the reverse
   * transition can under-estimate the document enough that its final lines
   * cannot be scrolled to at all.
   *
   * Emptying is safe rather than clever: the measurement pass refills it on the
   * next frame, and a switch is a settings change, not something that happens
   * per frame.
   */
  $effect(() => {
    void performanceMode;
    untrack(() => {
      if (measuredHeights.size === 0) return;
      measuredHeights.clear();
      measureVersion++;
    });
  });

  const heights = $derived.by(() => {
    void measureVersion;
    const colPx = Math.max(1, columnWidthPx);
    return performanceBlocks.map((b) => {
      const m = measuredHeights.get(b.id);
      if (m !== undefined) return m;
      // The rendered type, not the authored fields: on a calibrated rig those
      // two differ, and this estimate is what stands in for every block outside
      // the virtualization window — so the wrong size biases `maxScroll` for as
      // long as the far end of a long script stays unmeasured.
      return estimateBlockHeightPx(b, effective.fontSizePx, effective.lineHeight, colPx) + gapPx;
    });
  });
  const offsets = $derived(computeOffsets(heights, 0, padTopPx));
  const totalHeight = $derived((offsets[offsets.length - 1] ?? 0) + padBottomPx);
  const maxScroll = $derived(Math.max(0, totalHeight - vh));

  // Recompute the window in ~400px buckets so scrolling doesn't thrash it.
  let scrollBucket = $state(0);

  /**
   * SEED THE VIRTUAL WINDOW FOR A FAR-DOWN OPENING (CCUX-014).
   *
   * ---------------------------------------------------------------------------
   * WITHOUT THIS, "PRESENT FROM HERE" IS BROKEN ON EXACTLY THE SCRIPTS IT IS FOR
   * ---------------------------------------------------------------------------
   * Above 300 blocks only the window around `scrollY` is rendered, and `scrollY`
   * starts at zero. Measurement can only see rendered `[data-t]` nodes, so for
   * an opening token further down the document:
   *
   *   - `firstSpokenRowCentre` finds no token at or after it and returns null;
   *   - `map.covers(openingTokenIndex)` correctly refuses the top-of-document
   *     map, because answering from it would be a guess wearing a
   *     measurement's clothes;
   *   - so no opening target is ever armed, and the stage reveals at the top.
   *
   * Neither guard is wrong — the missing piece is that nothing ever rendered
   * the region being asked for. The estimated offsets are enough to put the
   * window in the right place; `placeOpeningPosition` then refines to the real
   * measured position, instantly, once the ink is on the glass.
   *
   * Runs once per opening. `openingHandedOver` is the same latch the placement
   * uses, so a presenter who has begun reading is never yanked by a late seed.
   */
  let seededForToken = $state(-1);
  let seededForSession = $state(-1);
  $effect(() => {
    /*
     * Scoped to the SESSION, not just to the token.
     *
     * A stage outlives a take. Latching on the token alone meant a second take
     * that opened at the same place — the obvious case, "Retry last section"
     * twice — was suppressed, and `openingHandedOver` is plain state that a new
     * session resets without waking this effect. Reading the generation makes
     * the effect re-run when a take begins and gives the latch something that
     * actually changes between takes.
     */
    const session = sessionGeneration;
    if (session !== seededForSession) {
      seededForSession = session;
      seededForToken = -1;
    }
    if (!virtual || openingTokenIndex <= 0 || openingHandedOver) return;
    if (seededForToken === openingTokenIndex) return;
    // Estimated heights are enough; this only has to land in the right region.
    // The arithmetic lives in `virtualization.ts` so it can be tested without a
    // laid-out document — jsdom measures nothing, so a component test here
    // would prove only that the effect ran.
    const seed = seedScrollForToken(performanceBlocks, offsets, openingTokenIndex, vh, maxScroll);
    if (seed === null) return;
    seededForToken = openingTokenIndex;
    scrollY = seed;
    scrollBucket = Math.round(scrollY / 400);
  });
  const renderWindow = $derived.by(() => {
    if (!virtual) {
      return {
        startIndex: 0,
        endIndex: performanceBlocks.length,
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

  const blockIndexById = $derived(new Map(performanceBlocks.map((b, i) => [b.id, i])));
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
  /*
   * When exact evidence commits a provisional frontier, the motion plant may
   * still be physically behind it. Dropping straight back to
   * `activeTokenIndex` would briefly brighten the very words just confirmed.
   * Latch the old provisional frontier until the plant catches it. An explicit
   * retraction clears the latch instead — that is the one transition that is
   * supposed to brighten words.
   */
  let previousProvisionalToken = $state<number | null>(null);
  let committedDimFloor = $state<number | null>(null);
  $effect(() => {
    const provisional = alignment?.provisionalToken ?? null;
    const retracted = alignment?.provisionalRetracted === true;
    const active = activeTokenIndex;
    const previous = untrack(() => previousProvisionalToken);
    let floor = untrack(() => committedDimFloor);

    if (retracted) {
      floor = null;
    } else if (previous !== null && provisional === null) {
      floor = Math.max(floor ?? 0, previous);
    }
    if (floor !== null && active !== null && active >= floor) floor = null;

    previousProvisionalToken = provisional;
    committedDimFloor = floor;
  });
  const cursorTokenIndex = $derived.by(() => {
    if (alignment?.provisionalToken !== null && alignment?.provisionalToken !== undefined) {
      return alignment.provisionalToken;
    }
    const committed = alignment?.provisionalRetracted ? null : committedDimFloor;
    const ordinary =
      activeTokenIndex ?? (alignment ? Math.round(alignment.confirmedToken) : null);
    if (committed === null) return ordinary;
    return ordinary === null ? committed : Math.max(ordinary, committed);
  });
  const dimRollback = $derived(alignment?.provisionalRetracted === true);

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

  /**
   * Write the microgap onto the rendered spans.
   *
   * A DOM write rather than markup, and that needs justifying on a surface this
   * disciplined. The gap lands on the space FOLLOWING one particular word, and
   * the only thing that identifies that word is its token index — which no
   * stylesheet can select on and no ancestor can inherit. The alternatives were
   * a prop threaded through two presentational components that would then both
   * need to know about sentences, or a generated stylesheet; this is the
   * narrowest of the three and it lives beside the measurement pass, which is
   * the only other place in this file that touches the rendered DOM.
   *
   * Idempotent and cheap: it writes only where the value differs, so re-running
   * it before every measurement costs one style read per rendered word and
   * never invalidates layout on its own.
   */
  function applySentenceMicrogap() {
    if (!planeEl) return;
    const gap = microgapPx;
    const tokens = microgapTokens;
    for (const el of Array.from(planeEl.querySelectorAll<HTMLElement>('[data-t]'))) {
      const raw = el.dataset.t;
      if (raw === undefined) continue;
      const index = Number.parseInt(raw, 10);
      const want =
        gap > 0 && Number.isFinite(index) && tokens.has(index) ? `${gap.toFixed(2)}px` : '';
      if (el.style.marginInlineEnd !== want) el.style.marginInlineEnd = want;
    }
  }

  function measureBlocks() {
    if (!planeEl) return;
    // Before the tape measure comes out: the gap moves glyphs, so a height read
    // without it is a height of a layout that is about to change.
    applySentenceMicrogap();
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
    const rendered = els.length > 0 || performanceBlocks.length === 0;
    if (!layoutReadySent && rendered) {
      layoutReadySent = true;
      onlayoutready?.(layoutMeasurement());
    }
  }

  /**
   * A stable identity for the FACE, from its measured proportions.
   *
   * Not a file digest — nothing in a browser offers one — but it answers the
   * question `fontHash` is asked: two different faces do not share a cap
   * height, an x-height, a zero advance AND a mean prose advance to four
   * decimal places. The estimate/measurement flag leads it, so the DIN
   * fallbacks can never collide with a real measurement that happens to be
   * close to them.
   */
  function fontFingerprint(metrics: FontMetrics): string {
    return [
      metrics.measured ? 'measured' : 'estimated',
      metrics.capHeightRatio.toFixed(4),
      metrics.xHeightRatio.toFixed(4),
      metrics.zeroAdvanceRatio.toFixed(4),
      metrics.avgCharWidthRatio.toFixed(4),
    ].join(':');
  }

  /**
   * Median characters on a rendered line, counted rather than derived.
   *
   * The resolver already publishes a `charactersPerLine`, but that is a
   * CAPACITY computed from the column width and an assumed average advance.
   * This is what the presenter is actually looking at, counted off the token
   * rows the line map measured — and where the two disagree, the resolver's
   * font metrics are wrong, which is a thing the calibration screen should be
   * able to say out loud.
   *
   * The median rather than the mean: a heading, a cue chip and every
   * paragraph's short closing line are all real lines with atypical counts, and
   * a mean lets a long script's ragged edges decide the answer.
   */
  function medianCharactersPerLine(map: StageRenderedLineMap): number | null {
    const counts: number[] = [];
    for (const line of map.lines) {
      let characters = 0;
      let words = 0;
      for (const stop of line.tokenStops) {
        const text = tokenTextByIndex.get(stop.tokenIndex);
        if (text === undefined) continue;
        characters += text.length;
        words += 1;
      }
      // The spaces between the words count: a reading measure is about how far
      // the eye travels, and it travels across the gaps too.
      if (words > 0) counts.push(characters + Math.max(0, words - 1));
    }
    if (counts.length === 0) return null;
    counts.sort((a, b) => a - b);
    return counts[Math.floor(counts.length / 2)] ?? null;
  }

  /**
   * What the stage currently knows about the face and the layout.
   *
   * Honest about its own provenance in both directions: `fontMetrics.measured`
   * says whether the ratios came off a canvas or out of the DIN table, and
   * `linePitchMeasured` says whether the pitch is the median of measured token
   * rows or the typographic line box that stands in until the first map exists.
   * A calibration screen that cannot tell those apart would present a guess as
   * a measurement, which is the failure the whole optical layer is built to
   * avoid.
   */
  function layoutMeasurement(): StageLayoutMeasurement {
    return {
      fontMetrics,
      linePitchPx: measuredLinePitchPx ?? linePx,
      linePitchMeasured: measuredLinePitchPx !== null,
      charactersPerLine: measuredCharactersPerLine,
    };
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
      // Switching this swaps whole visual blocks for one-line chips while the
      // document and every other input sit unchanged — `sameLayout()` would
      // otherwise call that the same layout and skip the §33 re-anchor.
      performanceMode,
      padTopPx,
      padBottomPx,
      /*
       * The FACE, not the family id.
       *
       * `fontHash` is in the fingerprint now, and a fingerprint term nothing
       * reads reactively is a term that never gets looked at: a bundled font
       * landing after the bounded wait changes the measured ratios, re-wraps
       * every line, and — with this missing — scheduled no measurement pass at
       * all, because none of the other inputs here moved. The hash would have
       * caught it; nothing asked it to.
       */
      fontFingerprint(fontMetrics),
      // The sentence microgap re-wraps every paragraph it touches, so it is a
      // layout input in exactly the sense this list means. It has no home in the
      // shared §7.2 fingerprint yet, which is why `rebuildLineMap` carries its
      // own record of the value the current map was built at — see the note
      // there.
      microgapPx,
      /*
       * The chosen line breaks, for exactly the reason the font hash above is
       * here: a fingerprint term nothing reads reactively is a term that never
       * gets looked at.
       *
       * The clearest case is the presenter turning the breaker off mid-session.
       * Every line in the document re-wraps at that moment and not one other
       * input in this list moves, so without this no measurement pass would be
       * scheduled at all — the map would keep describing lines that are no
       * longer on the glass, which is worse than never having planned them.
       */
      wrapPlan.signature,
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

  /**
   * A rebuild was asked for while one was already running.
   *
   * ---------------------------------------------------------------------------
   * WHY DROPPING IT WAS SAFE AND IS NOT ANY MORE
   * ---------------------------------------------------------------------------
   * The guard below used to be a bare `if (lineMapPending) return`, and the
   * dropped request was almost always harmless: `rebuildLineMap` reads the
   * CURRENT inputs when it eventually runs, so a request that arrives mid-build
   * is usually satisfied by the build already in flight.
   *
   * Almost. A change landing after `rebuildLineMap()` has read its inputs but
   * before the `finally` clears the flag is dropped by a build that did not see
   * it — and nothing reschedules, because the reactive effect that would have
   * has already run. The map then describes a layout that no longer exists until
   * the next unrelated input moves.
   *
   * That window is a couple of frames wide, and until reader mode nothing could
   * fire into it: the viewport changed once per take, before the stage mounted.
   * A window with a draggable edge fires into it repeatedly, and the settle
   * debounce on the viewport does not help — it makes each request arrive alone,
   * which is exactly the case with nothing following it to paper over the drop.
   */
  let lineMapDirty = false;

  function scheduleLineMapBuild() {
    if (lineMapPending) {
      lineMapDirty = true;
      return;
    }
    lineMapPending = true;
    void (async () => {
      try {
        lineMapDirty = false;
        // §7.1: measure only once fonts and layout-affecting assets are final.
        if (planeEl) await awaitLayoutStable(planeEl);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        rebuildLineMap();
      } finally {
        lineMapPending = false;
      }
      /*
       * Outside the `try`, and after the flag is clear, so the follow-up is a
       * fresh scheduling rather than recursion inside a build that is still
       * marked as running. A rebuild that threw still gets its retry: the
       * `finally` above releases the flag either way, and a dirty map is worth
       * another attempt more than a clean one is.
       */
      if (lineMapDirty) scheduleLineMapBuild();
    })();
  }

  function rebuildLineMap() {
    if (!planeEl || vh === 0) return;
    const now = performance.now();
    // The map is about to be measured off the DOM, so the DOM has to be the one
    // the settings describe. Cheap and idempotent; see the note on the function.
    applySentenceMicrogap();

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
      // The real rendered padding, not a hard-coded zero: it is solved from the
      // band position and the measured line pitch, and moves every block.
      paddingTopPx: padTopPx,
      paddingBottomPx: padBottomPx,
      /*
       * `fontHash`, populated at last.
       *
       * The §7.2 contract has carried this field since it was written and no
       * renderer had ever filled it in, because a family id is a settings string
       * and nothing in the browser hands out a font file digest. What the stage
       * does now have is a MEASUREMENT of the face it drew — and two different
       * faces under one family id have different cap heights and different
       * advances, which is precisely what this hash needs to notice.
       *
       * The case it fixes is the ordinary one: a bundled font that lands after
       * the bounded font wait has already revealed the script. Every glyph moves,
       * every line re-wraps, and until now no declared input changed — so the
       * rebuild was classified coverage-only and the §33 re-anchor never ran. It
       * was caught downstream by the measured-disagreement check, which answers
       * with a position-preserving re-anchor; correct for an estimate that got
       * better, and the weaker of the two answers for a layout that genuinely
       * changed.
       */
      fontHash: fontFingerprint(fontMetrics),
      /*
       * Where the lines were chosen to break. Not derivable from anything else
       * here: two documents at one measure in one face plan differently,
       * because the solver is trading line fullness against the quality of the
       * seam, and that depends on the words.
       */
      wrapPlanSignature: wrapPlan.signature,
      /*
       * The projection ON THE GLASS, not the one the settings imply.
       *
       * `layoutInputs()` below reads `performanceMode`, so a practice schedules
       * a rebuild — but the fingerprint used to re-derive the same field from
       * `stageMode` alone, which a practice never touches. `sameLayout()` would
       * then have called a rendered table and the words REFER TO TABLE the same
       * layout, replaced the map under the OLD generation and skipped the §33
       * semantic re-anchor: the precise failure the note on `layoutInputs()`
       * warns about. One description of the layout, and both sides read it.
       */
      performanceView: performanceMode,
    };
    /*
     * The microgap, tracked here rather than in the fingerprint.
     *
     * It moves glyphs, so a change to it is a relayout — but `LayoutFingerprint`
     * is a shared contract owned by the motion layer and has no term for it yet
     * (the follow-up is one field on the interface, one line in
     * `buildLayoutFingerprint` and one `true` in the exhaustive
     * `IDENTIFIES_LAYOUT` table). Until it does, the stage keeps its own record
     * of the one layout input it knows the fingerprint cannot see, so a rebuild
     * caused by the microgap is still classified as a new layout and still gets
     * the §33 semantic re-anchor. Missing that classification is the exact
     * failure the fingerprint exists to prevent, and it is not made less bad by
     * being the fingerprint's omission rather than this file's.
     */
    const microgapMoved =
      mappedMicrogapPx !== null && Math.abs(mappedMicrogapPx - microgapPx) > 0.01;
    // A real layout change always rebuilds and bumps the generation; a
    // coverage-only rebuild (windowed rendering scrolled) reuses it and is
    // throttled, because it is the same layout with more of it measured.
    const layoutChanged =
      microgapMoved ||
      !sameLayout(lineMap?.fingerprint ?? null, {
        ...buildLayoutFingerprint({ ...base, layoutGeneration }),
      });
    if (!layoutChanged && lineMap && now - lastMapBuildAtMs < MAP_REBUILD_THROTTLE_MS) return;
    lastMapBuildAtMs = now;
    if (layoutChanged) layoutGeneration += 1;

    // The band the presenter is looking at, not a second one computed from the
    // flat fields — see the note on `readingBand`.
    const band = readingBand;
    const measurement = measureStageLayout({
      plane: planeEl,
      blocks: performanceBlocks,
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
            // Line ENTRY, half a cap height below the mark — which puts the
            // middle of a capital ON the mark as a line is entered. See
            // `lineEntryOffsetPx`. The top padding carries the same offset, so
            // the knots are unchanged.
            readingLineStartY: band.centerPx + lineEntryPx,
            // The corridor half-height as measured on the glass — the computed
            // band, including its clamps, not the raw setting.
            //
            // Deliberately NOT offset by `lineEntryPx`, though `R` now is. The
            // engine reads this for two things that want opposite corrections:
            // the catch-up boost decays as the line rises INTO the corridor
            // (which wants the distance down to the lower edge, half - offset)
            // and the §30.3 ceiling bounds how far past the target the plant may
            // be carried (the distance up to the upper edge, half + offset).
            // Folding the offset into one number would fix one and break the
            // other by the same amount; leaving it is conservative for both —
            // the boost finishes a little early and the ceiling sits a little
            // tighter, and ordinary following covers the difference.
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

    /*
     * What was actually measured, kept for the motion bounds and the report.
     *
     * `measureStageLayout` falls back to the typographic line box when it found
     * no token rows to take a median from, so "there were tokens" is the only
     * honest test for a measured pitch — and everything that consumes it
     * (the §16.4 provisional cap, the smooth-jump threshold, the calibration
     * readout) has a defined behaviour for not knowing.
     */
    measuredLinePitchPx = measurement.tokens.length > 0 ? measurement.lineHeightPx : null;
    measuredCharactersPerLine = medianCharactersPerLine(next);
    mappedMicrogapPx = microgapPx;
    onlayoutmeasured?.(layoutMeasurement());

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
    autoScrollScale = measureAutoScrollScale(
      next.lines,
      autoScrollBlockBoxes(measurement.blocks, performanceBlocks),
    );
    /*
     * VALID, not merely built. The reveal gate reads this as "the stage now
     * knows where the script is", and an unusable measurement knows nothing —
     * §62 rebuilds it once, 300 ms later, and that rebuild very often succeeds
     * because layout had simply not settled. Counting the failed attempt would
     * open the gate at scroll zero for those 300 ms and then place the opening
     * underneath the presenter: the exact hop this gate exists to prevent,
     * arriving through the one path most likely to hit it. The retry is bounded
     * and the deadline covers it; when the retries are spent, the tail of this
     * function reveals deliberately rather than by omission.
     */
    if (next.valid) mapEverBuilt = true;
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

    placeOpeningPosition(
      next,
      now,
      firstSpokenRowCentre(measurement.tokens, openingTokenIndex),
    );

    // §62: an unusable measurement is recoverable — layout may simply not have
    // settled yet. Rebuild ONCE, then stop retrying and report it. The stage
    // holds throughout (the engine suspends both the semantic planner and the
    // guessed snapshot fallback while the map is unresolved), so a retry loop
    // would only burn frames on the presenter's glass.
    let retryScheduled = false;
    if (!next.valid) {
      if (mapRetries < MAX_MAP_RETRIES) {
        mapRetries++;
        retryScheduled = true;
        mapRetryPending = true;
        window.setTimeout(() => {
          mapRetryPending = false;
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

    /*
     * A build has happened and armed no reveal — the map is unusable (§62), or
     * the opening has already been handed over. The position is then as known
     * as it is ever going to be, so the script is shown NOW rather than left
     * behind the reveal's deadline: the dark window is bounded by the work, and
     * the timer exists only for a build that never finishes at all.
     *
     * Except while a retry is in flight, which is why this sits BELOW the block
     * above rather than beside the placement. A first map that failed to
     * measure is the case most likely to be fixed 300 ms later, and revealing
     * in between would show the script at scroll zero and then move it — the
     * exact hop this gate exists to prevent, in the one path most likely to hit
     * it.
     */
    if (!next.valid && !retryScheduled) revealScript();
  }

  /* ---------------------------------------------------------------------
   * Where the take opens
   *
   * The document's top padding puts the FIRST LINE on the reading mark at
   * scroll 0, and until the first snapshot lands that is where the stage sits.
   * When the script opens on a heading — which is how nearly every script is
   * written, and headings are not spoken unless the presenter asked for them —
   * the mark therefore points at a line nobody is going to read, and the first
   * thing the presenter hears themselves do is make the document jump down to
   * the sentence they had already started.
   *
   * So the opening position is built from the one the aligner would choose for
   * the first spoken word: `sampleMotionPath` at unit 0, which is the first
   * knot of the path and by construction the first line that HAS spoken tokens
   * on it. A script that opens straight into prose barely moves; one that opens
   * on a heading starts under it, on the words. Turning on "read headings"
   * makes the heading unit 0 and the mark stays where it was — the rule is the
   * same one either way, which is why it is expressed as the path and not as a
   * skip.
   *
   * ---------------------------------------------------------------------------
   * ...FROM MEASURED INK, NOT FROM THE PATH
   * ---------------------------------------------------------------------------
   * The path is how the first spoken LINE is chosen. It is not how the position
   * is computed: `placeOpeningPosition` puts the measured centre of that line's
   * ink on the mark directly (`firstSpokenRowCentre`), because every term in a
   * path-derived answer is a different approximation of where the letters are.
   * The long note on that function has the derivation.
   *
   * The two rules agree, and only because `lineEntryOffsetPx` carries no pitch
   * term. `R` sits half a cap height below the mark, which is exactly the
   * baseline-to-cap-centre correction, so following places a line's capitals on
   * the mark at the instant it is entered — the same place the opening put them.
   * A pitch term here would mean the text stepped down by that much the moment
   * the aligner took over from the opening, which is a jump the presenter causes
   * by saying their first word and cannot possibly read as anything but the
   * tracking being wrong. That is why the two are kept in agreement rather than
   * tuned separately.
   *
   * ---------------------------------------------------------------------------
   * WHY IT IS RE-ASSERTED, NOT PLACED ONCE
   * ---------------------------------------------------------------------------
   * A scroll position is a PIXEL, and pixels do not survive a relayout. Before
   * the first spoken word there is no anchor to carry one across either: §33's
   * `layoutRecovery` re-anchors on the unit the aligner was on, and with no
   * snapshot yet — and no gesture — there is no unit, so it preserves nothing
   * and the plant keeps a number the new layout has made meaningless.
   *
   * Relayouts before the first word are not exotic, they are the norm: the
   * bundled font landing after the bounded wait re-wraps every line, a
   * virtualized height estimate is replaced by a measurement, the operator
   * nudges the type size while the presenter settles. Placing once and walking
   * away leaves the mark wherever the old geometry happened to put it — about a
   * line out, which is exactly far enough to point at the wrong line and no
   * further, so it reads as the tracking being broken rather than as a stale
   * number.
   *
   * So the opening is a STANDING position: every valid map re-states it, until
   * something with more authority takes the document — and then never again,
   * because `handOverOpening` latches.
   *
   * The handover is latched AT THE EVENTS, not sampled here when a map happens
   * to rebuild, and the difference is a real bug rather than tidiness. Nothing
   * about starting or stopping the fixed-pace transport rebuilds the line map,
   * and starting it calls `releaseAlignment`, which nulls `lastDisplayToken`.
   * So a roll that began and ended between two rebuilds would leave every
   * sampled guard reading false, and the next relayout — a font nudge, a
   * resize — would answer it by re-stating the opening and throwing the
   * presenter back to the top of the script mid-take.
   * ------------------------------------------------------------------- */

  /** Something with more authority than an opening guess has the document. */
  let openingHandedOver = false;
  /** An opening target has been written and nothing has consumed it yet. */
  let openingTargetOutstanding = false;

  /* ---------------------------------------------------------------------
   * Showing the script only once it is where it belongs
   *
   * The opening position cannot be known before the document has been laid out
   * and measured, and the map that measures it is built a frame or more after
   * the first paint — behind a font wait that has no bound at all
   * (`awaitLayoutStable` waits on `document.fonts.ready` and every image). So
   * the honest sequence is: the script appears at scroll 0, and then moves.
   *
   * The presenter sees that as the take starting slightly low and hopping. It
   * is one frame and it is correct, and it still looks like a bug — a
   * teleprompter that twitches as it opens is a teleprompter you do not trust
   * at the moment you most need to.
   *
   * So the reading composition is not PAINTED until the position is real.
   * Nothing fades and nothing eases: the script is simply not shown in a place
   * it is not going to stay.
   *
   * Three decisions inside that, none of them arbitrary:
   *
   * `visibility`, not opacity. Opacity on the moving plane is the motion
   * engine's channel for the §20.4 re-anchor obscuration, and two owners on one
   * property is how a guarantee about the ordering of two writes gets quietly
   * broken. Visibility also keeps the boxes — layout, `Range.getClientRects`
   * and therefore the line map all proceed underneath — so this hides the paint
   * without delaying the work that ends it.
   *
   * On the LAYER, not the plane. The mark, the fades and the script are one
   * composition; a mark hanging over an empty stage waiting for its script to
   * arrive is its own small "is this thing working?". The take opens as one
   * thing. Deliberately not wider than that: the dock, the voice pill and the
   * status chrome belong to the stage, not to the reading, and a presenter
   * pressing Present should see the session come up immediately.
   *
   * And it is a GATE, not a delay: every path that could end the wait opens it,
   * including a map that never validates.
   *
   * It authors `hidden` and NOTHING ELSE — never `visible`. Blanking the stage
   * hides an ANCESTOR (`.script-holder.blanked`), and visibility is the one
   * inherited property a descendant can countermand: an explicit `visible` here
   * would punch the script, the mark and the fades straight back through a
   * blanked stage while control reported it as blanked.
   * ------------------------------------------------------------------- */

  let scriptRevealed = $state(false);
  /** A VALID map has existed this session. Before that, no position is knowable. */
  let mapEverBuilt = $state(false);
  /** The plant has arrived at whatever the frame loop is aiming it at. */
  let plantAtTarget = $state(false);

  /**
   * The stage does not know where the script belongs yet, so it is not shown.
   *
   * Two conditions, and they are the two halves of the same question — does a
   * position exist, and is the document at it:
   *
   *   - no VALID map has been built, so nothing has been measured to aim at;
   *   - the plant has not reached the target it is being aimed at.
   *
   * The second is deliberately about the TARGET rather than about the opening.
   * The opening is only one of the things that can own the document during
   * those first frames — a presenter who speaks before the map lands hands it
   * to the aligner instead, and a rule written in terms of the opening would
   * reveal at scroll zero and then let the aligner glide the script into place
   * under them. Asking whether the plant is where it is being sent covers every
   * authority, including the ones that arrive while the glass is still dark.
   *
   * The viewport terms keep it honest rather than merely cautious. A stage with
   * no measurable glass — a hidden window, a harness where every rect is zero —
   * has no map coming and nothing to wait for, and a gate that waited anyway
   * would be a blank teleprompter with a timer as its only way out.
   */
  const awaitingOpeningPlacement = $derived(
    !scriptRevealed && vh > 0 && vw > 0 && (!mapEverBuilt || !plantAtTarget),
  );

  /**
   * How close the plant must be to its target to call the document placed.
   *
   * Two pixels: an instant placement lands exactly, and a jerk-limited
   * approach to a live alignment target settles inside this within a frame or
   * two — which is the case this tolerance is for. Zero would wait on a plant
   * that is legitimately still converging by fractions.
   */
  const REVEAL_SETTLE_PX = 2;

  /**
   * Show the script, whatever the opening did or did not manage.
   *
   * Every path that ends the wait calls this, and so does a timer, because the
   * one outcome worse than a hop is a presenter looking at a blank stage. §62
   * is explicit that an unusable measurement is reported and lived with, not
   * hidden behind — a map that never validates must still show its script.
   */
  function revealScript(): void {
    if (scriptRevealed) return;
    scriptRevealed = true;
    onplacedchange?.(true);
  }

  /**
   * How long the stage waits before showing a script it has NOT placed.
   *
   * Above the frame or two a warm start takes. It is the whole answer only when
   * nothing is still working on a position — see `openingPlacementStillComing`.
   */
  const OPENING_REVEAL_TIMEOUT_MS = 700;

  /**
   * The absolute end of the wait, whatever is still in flight.
   *
   * Measured on the rig this exists for: with the bundled face already warm the
   * opening places at ~260 ms, and with it cold the map lands at ~1.6 s — so
   * three seconds clears both by a wide margin and still fires long before a
   * presenter would conclude Present had not worked. §62's rule holds at the
   * end of it: an unusable measurement is reported and lived with, not hidden
   * behind, so this reveals unconditionally.
   *
   * Deliberately under every timeout in the browser suite (7 s default
   * `expect`, the 10 s opening polls) so a stage that hits the ceiling fails a
   * test rather than quietly extending one.
   */
  const OPENING_REVEAL_CEILING_MS = 3000;

  /**
   * Something is still working on a position, so waiting is not the same as
   * being stuck.
   *
   * This is the whole correction. The old deadline asked only "has 700 ms
   * passed", and a rig whose fonts landed at 1.6 s — an ordinary cold start —
   * answered yes with the line map still being measured. The script was then
   * painted at scroll zero, where the top of the glass is empty and the first
   * spoken line sits a fifth of a viewport BELOW the mark, and hopped into
   * place a second later. Measured at 1440x900: revealed at 823 ms, jumped
   * 207 px at 1646 ms.
   *
   * Three things count as work in flight, and nothing else does:
   *
   *   - a map build is running. `awaitLayoutStable` inside it waits on
   *     `document.fonts.ready` and on every image, which is exactly the wait
   *     that outlasts 700 ms on a cold start.
   *   - a §62 rebuild is scheduled. That retry very often succeeds, and
   *     revealing during it shows scroll zero for 300 ms and then places the
   *     opening underneath the presenter.
   *   - an opening target is armed and the frame loop is stopped, so nothing
   *     is being painted and nothing is being waited for. (Pre-existing; it
   *     kept its own behaviour.)
   *
   * A plant travelling toward a LIVE alignment target is deliberately not on
   * the list. A presenter who speaks before the map lands hands the document to
   * the aligner, whose target keeps moving, so `plantAtTarget` may not come
   * true for as long as they keep talking — and waiting on that would hold the
   * glass dark through the opening of the take. The frame loop still reveals
   * the instant it does land.
   */
  function openingPlacementStillComing(): boolean {
    if (lineMapPending) return true;
    if (mapRetryPending) return true;
    return openingTargetOutstanding && !loopRunning;
  }

  /**
   * Give up the opening, permanently, and take its target with it.
   *
   * The target is retired rather than left to expire because it cannot expire:
   * it was written `instant`, and an `instant` target is only downgraded on the
   * frame it is actually SELECTED (`engine.ts`, the fallback branch). One
   * written while an accepted snapshot outranks it is never selected and never
   * downgraded — it stays armed, and the fifteen-second staleness window is
   * long enough for the presenter to have read half a page by the time it
   * fires. Whoever is taking over writes their own target on their next frame;
   * a null one in the meantime means the engine holds, which is correct.
   */
  function handOverOpening(): void {
    if (openingHandedOver) return;
    openingHandedOver = true;
    if (openingTargetOutstanding) {
      openingTargetOutstanding = false;
      engine.setFallbackTarget(null);
    }
    /*
     * Stop WAITING for an opening — but do not, by itself, show the script.
     *
     * The two are different questions and running them together is a way to
     * reproduce the original bug. A snapshot accepted before the first map is a
     * real handover, and the engine explicitly cannot act on it yet: there is
     * no planner to ask. Revealing there would paint the script at scroll zero
     * and then move it the moment the map lands, which is the hop this gate
     * exists to prevent, arriving by a different road.
     *
     * So the reveal stays with the condition that describes it — a map exists,
     * or the deadline passed. `manualScrollBy` is the exception and says so
     * itself: it writes the position synchronously, so there is something
     * correct to show the instant it is asked for.
     */
  }

  /**
   * The middle of the first spoken ROW, in document pixels, from the same rects
   * the map was built from.
   *
   * Deliberately NOT `map.lines[0]`. A map "line" groups token rects whose tops
   * agree within `0.35 x lineHeightPx`, and `lineHeightPx` is a MEDIAN over the
   * script — so on a layout where most paragraphs fit on one row, the median
   * becomes the paragraph-to-paragraph distance and the tolerance grows past a
   * real row. Two rows then merge into one "line", whose ink centre is the gap
   * between them. Measured: a 1920x520 stage put the mark exactly half a row
   * low, and only on that shape, which is the kind of bug that ships.
   *
   * A row is tokens that share a top to within a quarter of their own height —
   * a test made of the thing being grouped, so it cannot be widened by a
   * statistic about the rest of the document.
   */
  function firstSpokenRowCentre(
    tokens: readonly MeasuredTokenRect[],
    fromToken = 0,
  ): number | null {
    /*
     * The first measured token AT OR AFTER the opening token, rather than the
     * first in the document.
     *
     * "At or after" and not "nearest": the opening token has already been
     * snapped to the start of a readable unit by `take-start-point.ts`, so
     * anything before it belongs to the previous sentence and putting that on
     * the mark would start the presenter half a line early.
     */
    let first: MeasuredTokenRect | null = null;
    for (const token of tokens) {
      if (!Number.isFinite(token.topY) || !Number.isFinite(token.bottomY)) continue;
      if (token.tokenIndex < fromToken) continue;
      if (first === null || token.tokenIndex < first.tokenIndex) first = token;
    }
    if (first === null) return null;
    /*
     * Membership is vertical OVERLAP, not a distance between tops.
     *
     * A tolerance measured off the first token asks every other token to look
     * like that one, which is wrong in both directions the moment a row is not
     * homogeneous: a small first run (inline code in another face) would
     * exclude its own normal-sized neighbours and centre the mark on the small
     * run, and an oversized first token would swallow the row below. Overlap
     * asks the question that actually defines a row — do these two boxes sit
     * across the same band of the glass — and it scales itself.
     */
    let top = first.topY;
    let bottom = first.bottomY;
    for (const token of tokens) {
      const overlap =
        Math.min(token.bottomY, first.bottomY) - Math.max(token.topY, first.topY);
      const shorter = Math.min(token.bottomY - token.topY, first.bottomY - first.topY);
      if (!(overlap > shorter * 0.5)) continue;
      top = Math.min(top, token.topY);
      bottom = Math.max(bottom, token.bottomY);
    }
    return (top + bottom) / 2;
  }

  function placeOpeningPosition(
    map: StageRenderedLineMap,
    now: number,
    inkCentreDoc: number | null,
  ): void {
    if (openingHandedOver) return;

    /*
     * The same doors, re-checked here as well as latched at their events: an
     * accepted snapshot means the aligner knows where the reader is, which an
     * opening only ever guessed, and a gesture is the presenter saying where
     * they want to be. (`followPaused` is deliberately NOT one of them —
     * following being off says nothing about where the script should be sitting
     * when it opens.)
     *
     * The transport's door is `autoTargetPx` — the goal it is actually rolling
     * toward — rather than `autoScroll.running`, so a transport that is
     * nominally on but has never seeded does not read as having taken the
     * document.
     *
     * The seed waits for a valid map for the same reason (see `driveAutoScroll`),
     * so a transport key pressed during the opening's dark window no longer
     * takes the document out from under an opening that has not happened yet:
     * the map lands, the opening places, and the roll seeds from there.
     */
    if (
      engine.lastDisplayToken !== null ||
      autoTargetPx !== null ||
      now < manualUntilMs ||
      engine.awaitingManualEvidence
    ) {
      handOverOpening();
      return;
    }

    // No geometry, nothing to place against: hold, and take the next valid map.
    if (!map.valid) return;
    /*
     * ...and a map that does not COVER the opening cannot answer for it either.
     * Windowed rendering measures only the part of a long script that is near
     * the viewport, and `sampleMotionPath` clamps below its first knot rather
     * than refusing — so a map built while the document sits far down a
     * three-hundred-block script would answer "unit 0" with a position near
     * wherever it happens to be measuring. That is a guess wearing a
     * measurement's clothes, and §62's rule is the whole reason this file does
     * not act on those.
     */
    if (!map.covers(openingTokenIndex)) return;

    /*
     * MEASURED INK ON THE MEASURED MARK — not a number derived from the phase.
     *
     * The first attempt expressed the opening as the path's position for unit 0
     * plus half a line pitch: the entry phase, advanced to the middle of its
     * sweep. Correct arithmetic about the MODEL, and it landed the mark visibly
     * low on the glass, because every term in it is a different approximation
     * of where the letters actually are — `R` carries a cap height from the
     * font metrics, the knot carries a baseline the map ESTIMATES at 80% of the
     * line box (`lineMap.ts`, `baselineFraction`), and the pitch is a median
     * over the whole script. None of those errors is large; none of them
     * cancels.
     *
     * So the target is measured, on both sides. `inkCentreDoc` is the middle of
     * the first spoken ROW as the rects put it, and `bandCenterPx` is the
     * number the mark is drawn on (`ReadingCue` centres its tick on it with a
     * transform). Both describe what is on the glass, in the same coordinate
     * space, so putting one on the other has nothing left to approximate:
     *
     *     the middle of the first line I am going to read
     *     sits exactly on the mark I am going to read it at.
     *
     * A document point `D` is painted at viewport `D - scroll`, which is the
     * whole derivation.
     */
    if (inkCentreDoc === null || !Number.isFinite(inkCentreDoc)) return;
    const at = clamp(inkCentreDoc - bandCenterPx, 0, maxScroll);

    /*
     * `instant`, and it has to be: this is the position the take OPENS at, not
     * a correction made during one. Travelling to it would show the presenter a
     * scroll they did not cause before they had said a word.
     *
     * Written unconditionally — including when `at` is 0, and including when it
     * is where the plant already is. A re-statement that skipped the cases it
     * judged uninteresting would be trusting the plant to have kept a pixel
     * across the relayout that just invalidated it.
     */
    engine.setFallbackTarget({ scrollPx: at, disposition: 'instant', atMs: now });
    openingTargetOutstanding = true;
    /*
     * The plant is not there yet, and the gate must know it BEFORE the next
     * paint. The frame loop and the map build are two separate rAF callbacks in
     * the same frame and the loop can run first, so `plantAtTarget` may be
     * carrying a `true` earned against the old target — scroll zero against
     * scroll zero. Left standing, that value opens the gate for the one frame
     * between arming this target and the engine spending it, which is the whole
     * hop in miniature.
     */
    if (!scriptRevealed) plantAtTarget = false;
  }

  /* ---- session gate (companion §26.1) ---- */
  $effect(() => {
    engine.configureSession(sessionGeneration, performance.now());
    // A new take opens where a take opens, on its own geometry.
    openingHandedOver = false;
    /*
     * The two pieces of manual state this component owns go with it.
     *
     * `configureSession` clears the engine's copy, and these were left behind:
     * a new take beginning within 2.5 s of the last gesture of the old one
     * inherited a live grace window — which suppresses the §62 degraded
     * fallback — and `lastAlignmentTargetPx` still held the PREVIOUS session's
     * target, so the first wheel gesture of the new take measured its gap
     * against a number from a script that is no longer on screen and could
     * call a glance a relocation, re-seeding the aligner from it.
     */
    manualUntilMs = 0;
    lastAlignmentTargetPx = null;
  });

  /*
   * The reveal's deadline, and the only thing in this file that is allowed to
   * show the script without knowing where it is.
   *
   * Keyed on the session so a second take on a stage window that outlived the
   * first gets its own opening rather than inheriting a reveal from a script
   * that is no longer on the glass.
   */
  $effect(() => {
    void sessionGeneration;
    scriptRevealed = false;
    plantAtTarget = false;
    mapEverBuilt = false;
    // The engine's own copy goes with `configureSession`; this is ours.
    openingTargetOutstanding = false;
    /*
     * The §62 recovery budget belongs to a take, not to a component.
     *
     * Left standing, a session that begins during the 300 ms retry window
     * inherits a spent budget and a pending flag from the take before it: its
     * own first unusable map gets no retry and is revealed immediately, and the
     * old timer then rebuilds and places the opening after the plate has
     * already lifted — which is the correction this whole change exists to
     * stop, arriving from the one direction nothing else covers.
     */
    mapRetries = 0;
    mapRetryPending = false;
    onplacedchange?.(false);
    /*
     * A new session over a document this component is already showing.
     *
     * The three flags above have just declared the position unknown, and
     * nothing else would ever contradict them: the build effect keys on the
     * document, the layout inputs and the render window, none of which a
     * session bump changes. So a second take on a stage window that outlived
     * the first would sit behind the plate for the whole ceiling and then
     * reveal wherever the LAST take had left the script — the new take never
     * opening at the top being the older half of that bug.
     *
     * Forcing the build answers both: `placeOpeningPosition` runs off the
     * rebuilt map, so the take opens where a take opens.
     *
     * With one hole left, on long scripts only. The render window is measured
     * around the retained `scrollY`, which a session bump does not reset, so a
     * previous take that ended more than the overscan below the top produces a
     * map that is valid but does not `covers(0)` — and `placeOpeningPosition`
     * declines a map that cannot answer for the opening rather than guessing
     * (§62). The second take then reveals where the first one stopped. Fixing
     * it means resetting the logical position before the rebuild, or forcing
     * the window to cover token 0; neither is done here.
     *
     * `untrack` because this effect's whole contract is "keyed on the session".
     * `scheduleLineMapBuild` reads `planeEl`, and a tracked read of it would
     * subscribe the opening to the element binding — re-running the reset, and
     * with it the plate, on a signal that has nothing to do with a new take.
     * The build itself declines a stage it cannot measure.
     */
    untrack(() => {
      lastMapBuildAtMs = 0;
      scheduleLineMapBuild();
    });

    let timer = 0;
    const startedAtMs = performance.now();
    const deadline = () => {
      /*
       * Waiting is not being stuck — but only until the ceiling, which is what
       * makes this a bounded promise rather than an open-ended one. Every
       * branch of `openingPlacementStillComing` is something that can fail to
       * finish: `awaitLayoutStable` has no bound of its own, a hung image or a
       * `document.fonts.ready` that never settles holds it forever, and the
       * `lineMapPending` latch means no later build can take over from it.
       */
      const elapsedMs = performance.now() - startedAtMs;
      if (openingPlacementStillComing() && elapsedMs < OPENING_REVEAL_CEILING_MS) {
        /*
         * The remaining time, not another full poll. Re-arming the poll blindly
         * would make the ceiling the next MULTIPLE of 700 ms above it — 3.5 s
         * for a 3 s ceiling — which is a number nothing in the code says and
         * the presenter would be the one to find.
         */
        timer = window.setTimeout(
          deadline,
          Math.min(OPENING_REVEAL_TIMEOUT_MS, OPENING_REVEAL_CEILING_MS - elapsedMs),
        );
        return;
      }
      revealScript();
    };
    timer = window.setTimeout(deadline, OPENING_REVEAL_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
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

  /* ---- the fixed-pace transport (renderer/autoscroll.ts) ---- */

  /**
   * Where the auto-scroll goal has crept to, or null while it is stood down.
   *
   * Null is also what a resume reads: the goal is re-seeded from wherever the
   * document actually is at that moment, so a transport that was paused while
   * the operator scrolled somewhere else picks up from there rather than
   * snapping back to a position it remembered from before.
   */
  let autoTargetPx: number | null = null;
  let autoLastFrameMs: number | null = null;
  /** The end has been announced once; it must not be announced every frame. */
  let autoEndReported = false;
  /**
   * The layout the target's coordinate belongs to.
   *
   * `autoTargetPx` is a raw document pixel, and document pixels do not survive a
   * relayout: change the type size mid-roll and the same line is at a different
   * offset, while the engine has re-anchored the plant to where that line
   * actually is now. A target left in the old coordinate system would then be
   * behind or ahead of the document by however much the layout moved — the
   * plant would stall until it caught up, or sweep forward, or clamp early and
   * report an end that had not happened.
   */
  let autoTargetLayout = 0;

  function driveAutoScroll(now: number) {
    if (!autoScroll?.running) {
      /*
       * The latch is let go before the early return, not after it.
       *
       * A run with nowhere to go reports its end without ever seeding a target,
       * so `autoTargetPx` is still null when control stands it down — and
       * resetting the latch only on the path below left it set. The next press
       * of the key then ran a transport that could never announce its end:
       * following stayed paused for a take that had nothing to roll.
       */
      autoEndReported = false;
      if (autoTargetPx === null) return;
      /*
       * Stood down. Letting go of the fallback target entirely is what makes
       * stopping smooth: with nothing to aim at the engine holds, and holding
       * means aiming at where the plant already is — so it decelerates to rest
       * under its own jerk limits instead of parking on a stale goal that a
       * later relayout could make wrong.
       */
      autoTargetPx = null;
      autoLastFrameMs = null;
      engine.setFallbackTarget(null);
      return;
    }
    if (vh === 0) return;

    /*
     * A script with nowhere to go is already at its end.
     *
     * Reported rather than silently ignored: the transport is nominally running,
     * control has paused voice following to make room for it, and without this
     * both of those would stay true for the rest of a take that can never move.
     * `autoScrollAtEnd` treats a zero range as the end for exactly this reason;
     * returning before asking it was what made the state unreachable.
     *
     * "Nowhere to go" is NOT the same question as "is the range zero", and the
     * difference is the whole of `autoScrollNowhereToGo`: an empty script's
     * padding alone makes it taller than the glass, so it has a positive range
     * and no words on it. Asked about geometry alone, this branch let every
     * empty document fall through to the map guard below and stay there.
     */
    if (
      autoScrollNowhereToGo({
        documentTokenCount: doc.tokenToNode.length,
        maxScrollPx: maxScroll,
      })
    ) {
      if (!autoEndReported) {
        autoEndReported = true;
        onautoscrollend?.('nowhere_to_go');
      }
      return;
    }

    /*
     * Geometry first, even for the transport.
     *
     * The roll's pace comes out of the line map, so before one exists the
     * transport is running and cannot move — and seeding here would still take
     * the document, permanently, on the frame a presenter pressed the key
     * during the opening's dark window. The opening would never run and the
     * roll would start on the heading instead of the first spoken line.
     *
     * Placed BELOW the stand-down and end-of-script branches on purpose: those
     * two report states the operator is waiting on, and a return above them is
     * what once made "a script with nowhere to go" unreachable.
     *
     * The invariant that makes this return safe is narrow, and it is the branch
     * above that supplies it: everything that reaches here HAS words, so its map
     * is one a rebuild can produce, and waiting costs a frame or two. It is not
     * "an empty document was caught by the geometry check" — an empty document's
     * range is positive, and while this branch relied on that it held every one
     * of them here for the rest of the take. Nothing else is lost by waiting:
     * with no valid map the engine refuses the target anyway (§62), so this
     * changes when the transport takes over, not whether.
     */
    if (lineMap === null || !lineMap.valid) return;

    const layoutChanged = autoTargetPx !== null && autoTargetLayout !== layoutGeneration;
    if (autoTargetPx === null || layoutChanged) {
      /*
       * Seed from where the document actually IS, on this layout.
       *
       * The same line of reasoning covers both callers: a fresh start has no
       * previous position to honour, and a relayout has invalidated the one it
       * had. `scrollY` is the engine's own current position in the coordinates
       * that exist now, which is the only number either case can trust.
       */
      autoTargetPx = clamp(scrollY, 0, maxScroll);
      autoLastFrameMs = now;
      autoTargetLayout = layoutGeneration;
      autoEndReported = false;
      // Seeding IS the transport taking the document, and it is the moment to
      // say so: nothing about a roll is guaranteed to rebuild the line map, so
      // a run that started and stopped between two rebuilds would leave every
      // guard a rebuild could sample reading false, and the next relayout would
      // answer it by re-stating the opening in the middle of a take.
      handOverOpening();
      /*
       * Take the wheel, once, on the frame the transport starts.
       *
       * An accepted alignment frame outranks any fallback for fifteen seconds,
       * which is right for a presenter drawing breath and wrong for somebody who
       * has just pressed a key. Without this the script holds for up to fifteen
       * seconds after the press and then jumps the distance the target accrued
       * meanwhile — a key that looks broken, followed by a lurch. Not repeated on
       * a relayout: the lock is already gone by then.
       */
      if (!layoutChanged) engine.releaseAlignment();
    }

    /*
     * Read off the map's own rebuild rather than pinned at the start of the
     * roll, because the answer changes under the operator's hand: the size
     * control is live during a take, and a pace that stayed pinned to the
     * density of the type that WAS on the glass would silently become a
     * different reading speed the moment they used it. Every relayout rebuilds
     * the map, and `autoScrollScale` is measured with it.
     */
    const pxPerSecond = autoScrollPxPerSecond(autoScroll.wordsPerMinute, autoScrollScale);
    const dtMs = autoLastFrameMs === null ? 0 : now - autoLastFrameMs;
    autoLastFrameMs = now;

    /*
     * A manual step suspends automatic motion for a grace interval, and the
     * goal has to wait it out with the document.
     *
     * The engine zeroes forward velocity and feed-forward for the whole of
     * `MANUAL_GRACE_MS`. A goal that went on creeping through it would build up
     * two and a half seconds of travel behind the operator's back, and the
     * script would then sit still and afterwards chase — the exact opposite of
     * "move, and carry on from here", and worse the faster the pace is set.
     */
    const inManualGrace = now < manualUntilMs;

    /*
     * No measured density — a map mid-rebuild, or one that never resolved — so
     * the goal stays where it is and the document settles on it. Deliberately
     * NOT a stand-down: a rebuild lasts a frame or two, and releasing the
     * target for each one would turn every relayout into a visible stutter.
     */
    if (pxPerSecond > 0 && !inManualGrace) {
      autoTargetPx = advanceAutoScrollTarget({
        targetPx: autoTargetPx,
        pxPerSecond,
        dtMs,
        maxScrollPx: maxScroll,
      });
    }

    /*
     * The rate travels WITH the target, and it has to.
     *
     * A goal creeping a third of a pixel per frame sits inside §29.3's rest
     * deadband on every frame, and a caller that says nothing about its speed is
     * taken at its word: the plant is snapped to the goal with its velocity
     * reported as zero, the limits stop being applied because nothing is being
     * integrated, and `restingSnap` below quantises the painted offset to the
     * device pixel grid — turning smooth travel into a visible step twenty times
     * a second. Naming the rate is what keeps this ordinary, integrated motion.
     */
    /*
     * The feed-forward describes what the TARGET is doing, so it goes to zero
     * whenever the target is not moving — through a manual grace, and once it
     * has clamped at the bottom of the document. Left positive it would be
     * telling the controller to keep accelerating toward a goal that has
     * stopped, which is how a roll ends in an overshoot against the end stop.
     */
    const targetMoving = pxPerSecond > 0 && !inManualGrace && !autoScrollAtEnd(autoTargetPx, maxScroll);

    engine.setFallbackTarget({
      scrollPx: autoTargetPx,
      disposition: 'follow',
      atMs: now,
      feedForwardVelocityPxS: targetMoving ? pxPerSecond : 0,
      /*
       * The operator pressed a key. Starting the transport pauses voice
       * following (that is control's rule, and the right one), and the engine's
       * pause zeroes the forward velocity budget for everything automatic — so
       * without this the transport was suppressed by its own precondition, and
       * what looked like a roll at a conversational pace was §29.3's rest
       * deadband snapping the plant onto a goal it never let get a whole pixel
       * ahead. See `FallbackTarget.mandate`.
       */
      mandate: 'operator',
    });

    /*
     * The END is where the DOCUMENT stops, not where the goal does.
     *
     * Control releases the target the moment this fires, and releasing it makes
     * the engine hold — aim at where the plant already is. Firing on the goal
     * would therefore stop the script wherever it had got to while the goal ran
     * ahead to the bottom, leaving the closing lines above the reading band and
     * the take ending short of its last sentence.
     */
    if (!autoEndReported && autoScrollAtEnd(scrollY, maxScroll)) {
      autoEndReported = true;
      onautoscrollend?.('document_end');
    }
  }

  function applyTrackingFallback(snap: AlignmentSnapshot) {
    /*
     * Every reason nothing automatic may move, checked in the one place the
     * frame loop's own limits cannot reach.
     *
     * This path can RE-ANCHOR — `disposition: 'instant'` and `'reanchor'` write
     * the plant directly (§62, §32.4) — so the zeroed velocities that enforce
     * manual authority inside `limitsForState` do not bind here. Anything that
     * holds the document has to be repeated at this door or it is not a hold.
     *
     * §30.6, both halves: the grace interval, and the engine's own "they have
     * not spoken since". §48: following switched off. This is the path that
     * runs at exactly the moments the line map is unresolved, which is when a
     * correction the presenter did not ask for is least defensible of all.
     *
     * And the transport, which owns this target outright while it runs: both it
     * and this compute the same one field, so letting both write would leave
     * the engine picking up whichever of two disagreeing goals happened to land
     * last when recognition lapsed. The operator turning the transport on is
     * the more explicit instruction.
     */
    if (followPaused || autoScroll?.running) return;
    if (performance.now() < manualUntilMs || engine.awaitingManualEvidence) return;
    const pos = tokenRect(Math.round(snap.confirmedToken));
    if (!pos) return;
    // §62: the off-window branch of `tokenRect` estimates a position from block
    // offsets and ESTIMATED heights. That is guessed geometry, and it is exactly
    // what must not drive motion while the rendered map is unresolved. A
    // genuinely measured rect is fine — it is the same DOM the map reads.
    if (!pos.measured && (lineMap === null || !lineMap.valid)) return;
    // The same band the map was built against and the cue is drawn on. A
    // fallback that corrects toward a different line than the one marked would
    // pull the reader off the mark precisely while the aligner is unsure.
    const band = readingBand;
    const current = scrollY;
    // Inside the dead zone there is no correction to make: hold position.
    let target = bandCorrection(pos.topDoc, pos.height, current, band) ?? current;
    target = clamp(target, 0, maxScroll);

    let disposition: FallbackTarget['disposition'] = 'follow';
    if (snap.state !== 'following') {
      /*
       * Weak or contested evidence never triggers large movement (§16.4). The
       * engine has already stopped advancing the position; this bounds what
       * the fallback may do with the position it is holding.
       *
       * The bound is two RENDERED LINES wherever a pitch has been measured,
       * because "a correction the presenter can absorb without losing their
       * place" is a claim about lines. The 180px constant it falls back to was
       * that claim at one body size, and silently became three and a half lines
       * on a 9-inch panel and less than one on a 15.6-inch one.
       *
       * The viewport goes in as the other half of the same sentence: two lines
       * on a panel showing five of them is most of the glass, and weak evidence
       * may never move the document that far however few lines it is.
       */
      target = clampProvisionalTarget(
        current,
        target,
        provisionalMaxCorrectionPx(measuredLinePitchPx, vh),
      );
    } else {
      const cls = classifyTransition({
        decision: snap.decision,
        distancePx: Math.abs(target - current),
        viewportHeightPx: vh,
        reducedMotion,
        // Same argument one threshold up: how big a jump is worth travelling
        // smoothly is decided by how much READING it carries the presenter
        // across, and the viewport-relative answer changed by nearly half
        // between the two panels CandidCue actually runs on.
        linePitchPx: measuredLinePitchPx,
      });
      disposition =
        cls === 'smooth_rewind'
          ? 'rewind'
          : cls === 'smooth_jump'
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
      // The row the token STARTS on, as the line map anchors it: a word too
      // wide for the column breaks inside its span (#281), and its union box
      // would put the band on the middle of a three-row word.
      const r = tokenFragmentRects(el)[0] ?? el.getBoundingClientRect();
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
    const block = performanceBlocks[idx];
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
    // Seeded so the first frame after a deliberate start is not ALSO read as a
    // gap: `startLoop` has just re-anchored, and doing it twice would reset the
    // fade a second time on the frame after it was already cleared.
    lastFrameSeenAtMs = performance.now();
    rafId = requestAnimationFrame(frame);
  }

  function stopLoop() {
    loopRunning = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  /**
   * A gap between frames long enough to mean the loop was not running.
   *
   * ---------------------------------------------------------------------------
   * WHY `visibilitychange` IS NOT THE WHOLE STORY
   * ---------------------------------------------------------------------------
   * §32.4's handling is right and is not enough. A window can stop receiving
   * `requestAnimationFrame` callbacks without `document.hidden` ever becoming
   * true: fully occluded by another application's window is the ordinary case,
   * and the browser stops rendering a surface nobody can see.
   *
   * A borderless always-on-top prompter filling a monitor is never in that state,
   * which is why this has never mattered. A reading window is in it constantly —
   * that is the whole point of a window you can work beside.
   *
   * What happens without this: frames stop, the plant stops integrating,
   * alignment snapshots keep arriving over IPC because they do not depend on
   * rendering, and on return `visibilityRestored` is never called. `dtMs` is
   * capped by the controller (§32.2) so there is no runaway step, but the plant
   * resumes from a position minutes out of date and catches up by scrolling the
   * whole distance. The reader sees the script race.
   *
   * One second. Well past any hitch a real frame loop produces — the controller's
   * own frame-interval sampler discards anything over 1000 ms as not a frame time
   * at all — and well under the shortest occlusion anybody would notice.
   */
  const FRAME_GAP_RESTORE_MS = 1000;
  let lastFrameSeenAtMs = Number.NEGATIVE_INFINITY;

  function frame(now: number) {
    if (!loopRunning) return;
    /*
     * The same re-anchor `visibilitychange` would have asked for, from the other
     * direction: the evidence here is the gap itself rather than an event.
     *
     * Deliberately `engine.visibilityRestored` and not a new entry point. It is
     * already exactly the right behaviour — re-anchor to what is on screen, never
     * replay missed motion, and reset the fade because no frames ran to unwind it
     * — and the note on the visibility handler above asks for one decision with
     * one owner. This is the second way of noticing the same thing, not a second
     * thing to do about it.
     */
    const gap = now - lastFrameSeenAtMs;
    lastFrameSeenAtMs = now;
    if (gap > FRAME_GAP_RESTORE_MS && Number.isFinite(gap)) {
      engine.visibilityRestored(scrollY, now);
    }
    driveAutoScroll(now);
    const result = engine.frame(now);
    setScroll(restingSnap(result.scrollPx, result.velocityPxS));
    /*
     * A re-anchor moved the document out from under the transport, so the
     * transport moves with it — the same carry `manualScrollBy` gives a wheel
     * gesture. Starting a roll switches following off, and a sentence step or
     * section jump is spent while following is off (#275); without this the
     * goal is still back where the document was, and the roll drags the script
     * straight back to it. Move, and carry on rolling from here.
     */
    if (result.reanchored && autoTargetPx !== null) {
      autoTargetPx = result.scrollPx;
      autoEndReported = false;
    }
    /*
     * The script becomes visible on the frame it is in the RIGHT PLACE, never
     * before — and "the right place" is read off the engine rather than from
     * anything this file remembers, so it is true of the opening, of an aligner
     * that took over before the opening could run, and of a transport.
     */
    if (!scriptRevealed) {
      plantAtTarget = Math.abs(result.scrollPx - result.targetPx) <= REVEAL_SETTLE_PX;
      if (mapEverBuilt && plantAtTarget) revealScript();
    }
    // Where the alignment feed last wanted the document, kept for
    // `alignmentGapPx`. Only from frames the feed actually drove: a hold or a
    // fallback target says nothing about where the tracker believes the
    // presenter is, and answering with one would make a settled wheel gesture
    // compare itself against the stage's own last guess.
    if (result.source === 'alignment') lastAlignmentTargetPx = result.targetPx;
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
      // The mount site reports on degradation too, so the flag has to leave
      // the engine rather than stop at the styling cadence.
      ondegraded?.(degraded);
    }

    if (result.ack) onmotionack?.(result.ack);
    reportViewport(now);
    rafId = requestAnimationFrame(frame);
  }

  /**
   * Below this the plant is standing still, in device pixels per second.
   *
   * Half a device pixel a second: at 60 Hz that is a hundredth of a pixel per
   * frame, which is not motion by any definition a presenter would recognise.
   * The threshold is in DEVICE pixels because the thing being protected is the
   * device pixel grid.
   */
  const AT_REST_DEVICE_PX_PER_S = 0.5;

  /**
   * Snap the offset to the device pixel grid while the document is at rest.
   *
   * A fractional `translate3d` puts every glyph edge between two device pixels,
   * so the rasteriser redistributes the ink of every stem across two columns.
   * While the document is MOVING that is exactly what should happen — it is
   * what makes slow motion smooth instead of stepped — but a stationary
   * document rendered off-grid is a page of permanently soft text, and one that
   * shimmers whenever a rebuild moves the offset by a hundredth of a pixel. The
   * target panel is 1024x600 at a device pixel ratio of 1, where there is no
   * spare resolution to hide it in.
   *
   * Only at rest, and only in the renderer: the engine's own position stays
   * fractional (§29.4), so nothing is quantised into the control loop and the
   * document resumes from exactly where the plant thinks it is.
   */
  function restingSnap(y: number, velocityPxS: number): number {
    const dpr = displayScale > 0 ? displayScale : 1;
    if (Math.abs(velocityPxS) * dpr > AT_REST_DEVICE_PX_PER_S) return y;
    return Math.round(y * dpr) / dpr;
  }

  function setScroll(y: number) {
    scrollY = y;
    const bucket = Math.floor(y / 400);
    if (bucket !== scrollBucket) scrollBucket = bucket;
  }

  /**
   * The current-phrase underlay, one box PER RENDERED LINE.
   *
   * It used to union the start token's rect, the end token's rect and the
   * cursor's into a single bounding box. For a sentence on one line that is
   * correct and for any sentence that wraps it is nonsense: the union of a rect
   * on line one and a rect on line three is a rectangle covering all three
   * lines edge to edge, including the whitespace either side of the shorter
   * ones and every word of the sentences that share those lines. The louder the
   * underlay was made, the more obviously wrong it looked — which is part of
   * why it shipped at an opacity nobody could see.
   *
   * `Range.getClientRects()` already answers this properly: a range spanning
   * the sentence reports one rect per line box it crosses. The rects are then
   * grouped by row, because the range reports a rect per inline element rather
   * than per line, and the boxes drawn are the rows.
   */
  function lineRectsForRange(startEl: HTMLElement, endEl: HTMLElement): DOMRect[] {
    if (!planeEl) return [];
    const range = planeEl.ownerDocument.createRange();
    range.setStartBefore(startEl);
    range.setEndAfter(endEl);
    const raw = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    range.detach?.();
    if (raw.length === 0) return [];

    const rows: DOMRect[] = [];
    for (const rect of [...raw].sort((a, b) => a.top - b.top)) {
      const row = rows[rows.length - 1];
      // Same row when the two boxes overlap vertically by most of their height.
      // A superscript, an inline cue chip or a different font size inside the
      // sentence shifts a rect a few pixels without starting a new line.
      const sameRow = row !== undefined && rect.top < row.top + Math.max(1, row.height * 0.6);
      if (!sameRow) {
        rows.push(new DOMRect(rect.left, rect.top, rect.width, rect.height));
        continue;
      }
      const left = Math.min(row.left, rect.left);
      const right = Math.max(row.right, rect.right);
      const top = Math.min(row.top, rect.top);
      const bottom = Math.max(row.bottom, rect.bottom);
      rows[rows.length - 1] = new DOMRect(left, top, right - left, bottom - top);
    }
    return rows;
  }

  function updateUnderlay() {
    if (!planeEl || !underlayEnabled) {
      if (underlay.length > 0) underlay = [];
      return;
    }
    const token = cursorTokenIndex;
    if (token === null) {
      if (underlay.length > 0) underlay = [];
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
    const spanned = startEl && endEl ? lineRectsForRange(startEl, endEl) : [];
    // No sentence span, a sentence whose ends are outside the rendered window,
    // or a range that measured nothing: mark the word instead of guessing at
    // the phrase around it — row by row, because a word wider than the column
    // breaks across rows (#281) and its union box would cover the column.
    let rects: DOMRect[] = spanned;
    if (rects.length === 0 && curEl) {
      rects = tokenFragmentRects(curEl);
      if (rects.length === 0) rects = [curEl.getBoundingClientRect()];
    }
    if (rects.length === 0) {
      if (underlay.length > 0) underlay = [];
      return;
    }

    const padX = effective.fontSizePx * 0.35;
    const padY = effective.fontSizePx * 0.12;
    // Same mirror compensation as the measurement pass: the underlay is
    // positioned in the plane's untransformed coordinate space.
    underlay = rects.map((r) => {
      const docTop = settings.mirrorY ? planeRect.bottom - r.bottom : r.top - planeRect.top;
      const docLeft = settings.mirrorX ? planeRect.right - r.right : r.left - planeRect.left;
      return {
        top: docTop - padY,
        left: docLeft - padX,
        width: r.width + padX * 2,
        height: r.height + padY * 2,
      };
    });
  }

  /* ---- public surface ---- */

  /** Feed one accepted-or-rejected semantic frame to the receiver (§26.1). */
  export function pushAlignmentSnapshot(snapshot: AlignmentSnapshot): boolean {
    const accepted = engine.receiveSnapshot(snapshot, performance.now());
    /*
     * ACCEPTED, not "produced a display token". The two come apart exactly when
     * it matters: a snapshot accepted while the map is unresolved has no
     * planner to ask, so it leaves `lastDisplayToken` null while being, in
     * every sense that counts, the aligner taking over. A REJECTED one changes
     * nothing at all and must not hand anything over.
     */
    if (accepted) handOverOpening();
    /*
     * While the transport runs it owns the document, and a snapshot does not
     * take it back. An accepted one outranks the transport's target for
     * fifteen seconds — which is why starting the roll releases the lock — and
     * a sentence step or section jump is answered with one while following is
     * off (#275), so every step stopped the roll dead.
     *
     * Only the lock is let go. Whatever the snapshot asked for has already been
     * submitted as a directive, so a manual move is still spent on the next
     * frame; and the receiver remembers how far the feed got, so a copy of this
     * snapshot arriving again is still refused.
     */
    if (accepted && autoTargetPx !== null) engine.receiver.release();
    return accepted;
  }

  /**
   * What the receiver has made of the alignment feed so far (§64).
   *
   * Separate from `motionDiagnostics()` because it answers a different question
   * and has to be cheap enough to read on every snapshot: that one assembles a
   * whole picture of the motion system, this one is the two counters and the
   * reason. It is the only place the difference between "no snapshots are
   * arriving" and "snapshots are arriving and being thrown away" is visible —
   * and those two have identical symptoms on the glass (a document that does
   * not move) with completely different causes.
   */
  export function alignmentFeedStats(): AlignmentReceiverStats {
    return engine.receiver.stats;
  }

  /**
   * Manual navigation (spec §16.5, companion §30.6): immediate authority,
   * automatic correction suspended for a short grace interval.
   */
  export function manualScrollBy(deltaPx: number) {
    const y = clamp(scrollY + deltaPx, 0, maxScroll);
    const now = performance.now();
    setScroll(y);
    /*
     * The anchor is read AFTER the scroll lands, because it is a fact about
     * where the presenter now is. It is handed to the engine so a relayout
     * arriving during the hold preserves their position rather than the
     * aligner's — see `manualOverride`.
     */
    engine.manualOverride(y, now, readingAnchorToken());
    manualUntilMs = now + MANUAL_GRACE_MS;
    // Their hand is on the script; the opening has nothing left to say about
    // where it should be, now or after any later relayout. And unlike the other
    // two handovers this one has a position ALREADY — `setScroll(y)` above —
    // so if the script is still behind the opening gate, show it: they asked
    // for the document to be somewhere and it is there.
    handOverOpening();
    revealScript();
    /*
     * Carry the transport to where the presenter just put the document.
     *
     * Without this the goal is still creeping forward from where it was before
     * the gesture, so a nudge backward is undone over the next second and a
     * nudge forward is followed by the script sitting still until the goal
     * catches up. Either way the gesture appears not to have worked. Re-seeding
     * makes a manual move during auto-scroll mean what it looks like it means:
     * move, and carry on from here.
     */
    if (autoTargetPx !== null) {
      autoTargetPx = y;
      autoEndReported = false;
    }
  }

  /**
   * The token sitting on the reading line right now, or null when the geometry
   * cannot answer.
   *
   * This is how a manual gesture — the wheel, the arrow keys, Page Up and Page
   * Down — answers WHERE the presenter just put themselves. A scroll moves the
   * document and nothing else, so without this the tracker keeps its old
   * cursor and the next thing the presenter says is matched against a place
   * they have left.
   *
   * The reading line rather than the top of the viewport, because the reading
   * line is where the script is read from — it is the position the whole of §8
   * is built around, and answering with the first visible token would hand the
   * tracker a cursor most of a screen above where the presenter is looking.
   *
   * Null rather than a guess whenever the map is missing or invalid: a wrong
   * anchor is worse than none at all, because it re-seeds the tracker's cursor
   * with confidence and the aligner then needs real evidence to climb back out
   * of it.
   */
  export function readingAnchorToken(): number | null {
    const map = lineMap;
    if (!map || !map.valid || map.lines.length === 0) return null;
    const readingY = scrollY + map.readingLineStartY;
    /*
     * The line the reading mark is ON, or the next one down.
     *
     * A linear scan rather than a binary search: `lines` is only the MEASURED
     * window on a virtualized script, this runs once per settled wheel gesture
     * rather than per frame, and a search needs the array to be sorted by a key
     * it is only incidentally sorted by. Simple beats clever at this cadence.
     */
    let line: RenderedLine | null = null;
    for (const candidate of map.lines) {
      if (candidate.bottomY < readingY) continue;
      line = candidate;
      break;
    }
    /*
     * Off the end of what was MEASURED is not the same as off the end of the
     * script, and on a virtualized document (§51.3) it usually is not.
     *
     * `map.lines` covers the rendered window plus overscan, and the map is
     * rebuilt on a 250 ms throttle while a wheel gesture settles in 200 ms — so
     * a fast scroll routinely asks this question against a map built for where
     * the document USED to be. Answering with the nearest measured line would
     * hand the aligner a cursor from the edge of last frame's window, stated
     * with confidence, and it would then need real evidence to climb back out
     * of it. Refusing is the whole reason this returns null at all.
     */
    if (!line) return null;
    const first = map.lines[0];
    if (first && readingY < first.topY) return null;
    if (!Number.isFinite(line.firstTokenIndex)) return null;
    return Math.max(0, Math.round(line.firstTokenIndex));
  }

  /**
   * How far the document now sits from where the alignment feed would put it,
   * in logical pixels, or null while there is no alignment target to measure
   * against.
   *
   * The measure the stage uses to tell a LOOK from a MOVE. Not the raw scroll
   * delta: a presenter who scrolls two screens ahead to check something and
   * then scrolls back has travelled four screens and gone nowhere, and a rule
   * written on distance travelled would re-anchor the tracker to a place they
   * have already left again. What matters is where they have ended up relative
   * to where the aligner thinks they are.
   */
  export function alignmentGapPx(): number | null {
    if (lastAlignmentTargetPx === null) return null;
    return Math.abs(scrollY - lastAlignmentTargetPx);
  }

  /** One text line in logical pixels, for arrow-key steps. */
  export function lineHeightPx(): number {
    return linePx;
  }

  /** Where the document currently sits, for measuring a gesture's real travel. */
  export function scrollPositionPx(): number {
    return scrollY;
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
   * that starts mid-script fast instead of ambiguous. It is also the engine's
   * LEASH: a far jump, retake or cold lock to something off-screen is refused
   * rather than taken, which is why it must keep being said (see
   * `VIEWPORT_HINT_REFRESH_MS`).
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
    // Unchanged is not "never again". A hint Rust dropped — the alignment
    // session was not installed yet — must be repeated, or the engine spends
    // the take without a viewport and its off-glass leash is slack.
    if (
      lastHintRange &&
      lastHintRange[0] === first &&
      lastHintRange[1] === last &&
      nowMs - lastHintAtMs < VIEWPORT_HINT_REFRESH_MS
    ) {
      return;
    }

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
    performanceBlocks.slice(renderWindow.startIndex, renderWindow.endIndex),
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
  style:visibility={awaitingOpeningPlacement ? 'hidden' : null}
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
    {#if underlayEnabled}
      <!-- One box per rendered line, keyed by index so a sentence that grows or
           shrinks a line reuses the boxes it already had rather than tearing
           them all down and rebuilding them under the reader's eye. -->
      {#each underlay as box, i (i)}
        <div
          class="phrase-underlay"
          style:top="{box.top}px"
          style:left="{box.left}px"
          style:width="{box.width}px"
          style:height="{box.height}px"
          style:opacity={settings.currentUnderlayOpacity}
        ></div>
      {/each}
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
          {dimRollback}
          {performanceMode}
          zone={zoneFor(renderWindow.startIndex + i)}
          cursor={renderWindow.startIndex + i === currentBlockIndex ? cursorTokenIndex : null}
          assets={doc.assets}
          showCues={settings.showCues}
          {gapPx}
          breakAfterTokens={wrapPlan.breakAfterTokens}
        />
      {/each}
      {#if renderWindow.trailingSpacePx > 0}
        <div class="spacer" style:height="{renderWindow.trailingSpacePx}px"></div>
      {/if}
    </div>
  </div>

  <!--
    The reading cue: what marks the line the presenter should be on.

    A sibling of the scroll plane rather than a child of it, because it is the
    one mark on the glass that does NOT move. It marks the band — a property of
    the rig — so it can never be wrong about the script, which is exactly what
    the phrase underlay it replaces could not promise.

    Sized in cap heights off the measured face, positioned from the same
    resolved column and band every other layer here reads, and told when the
    hold ladder wants it hollow. It draws nothing at all on `none`.

    `linePitchPx` is the TYPOGRAPHIC pitch, `linePx` — and specifically NOT the
    measured median the line map runs on. The `wash` plateau has to equal the
    distance a line's baseline sits from the next one's, and inside a paragraph
    that IS the CSS line box, exactly: `fontSizePx * lineHeight`. The measured
    median is an estimate of the same quantity taken from token rects, and it is
    the one that can be dragged off by paragraph gaps. It is also the number the
    padding and the fades are already solved against, so the cue cannot end up
    describing a pitch the rest of the vertical layout does not use.
  -->
  <ReadingCue
    style={settings.readingCue ?? 'ticks'}
    bandCenterPx={bandCenterPx}
    columnLeftPx={columnOffsetPx}
    {columnWidthPx}
    hollow={cueHollow}
    sizePx={capHeightPx}
    linePitchPx={linePx}
  />

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

  /*
   * Nothing drawn on the glass may run past the column (#281).
   *
   * The layer clips, so a run wider than the column — a URL, a compound word, a
   * code identifier — used to lose its end silently, on the left under a mirror.
   * `anywhere` breaks such a run only when the line has no ordinary break left,
   * so prose wraps exactly where it did, and the break is drawn inside the one
   * word span: the token, its index and the line map's anchor are unchanged.
   * Inherited, so every block kind in the column gets it from here.
   */
  .column {
    margin: 0 auto;
    font-weight: 500;
    display: flex;
    flex-direction: column;
    overflow-wrap: anywhere;
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
