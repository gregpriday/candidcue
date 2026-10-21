<!--
  Stage window shell (spec §16.1 layer model, §43.5 heartbeat, §45.6).

  ---------------------------------------------------------------------------
  TWO PLANES, AND WHICH ONE A THING BELONGS TO
  ---------------------------------------------------------------------------
  A beamsplitter reflects every pixel equally. It has no opinion about which
  elements are "the script" and which are "instruments", so anything drawn
  outside the corrective flip reaches the presenter's eye BACKWARDS — including,
  and especially, the short urgent strings somebody has to read at a glance
  mid-take.

  So the split is by AUDIENCE, not by importance:

    the TALENT plane   is mirrored, and holds everything the presenter reads
                       through the glass — script, reading cue, acknowledgement,
                       hold status, escape confirmation, calibration cards.
                       Presenter-facing overlays sit one level further in,
                       inside the safe rectangle, because a hood crops the panel
                       and a chip against the raw viewport lands under the bezel.

    the OPERATOR plane is unmirrored, and holds the instruments and the
                       controls — the diagnostics readout, the raw transcript,
                       and the session dock. All of it is read by somebody
                       standing at the rig looking directly at the panel, never
                       through the glass, and the dock is additionally OPERATED
                       by them. That last part is why it may not be mirrored: a
                       CSS transform carries hit-testing with it, so a mirrored
                       button is clickable where it appears — on the opposite
                       side of the screen from where it was a moment ago.

  Layers, back to front: solid background → script
  text + focus fades → reading cue → presenter overlays → calibration →
  operator instruments and dock.

  All data arrives via Tauri events (the stage holds only event:listen);
  outbound traffic is intents/acks that control is free to ignore.
-->
<script lang="ts">
  import { onMount, untrack, type Snippet } from 'svelte';
  import {
    ESCAPE_DOUBLE_PRESS_MS,
    STAGE_EVENT,
    STAGE_HEARTBEAT_GRACE_MS,
    type PresentationMode,
    type StageAutoScrollEndReason,
    type StageAutoScrollPayload,
    type StageEscapePayload,
    type StageHeartbeatAckPayload,
    type StageHeartbeatPayload,
    type StageTranscriptTapPayload,
    type StageHydratedPayload,
    type StageIntent,
    type StageIntentPayload,
    type StageLayoutErrorPayload,
    type StageLiveSyncPayload,
    type StageListeningPayload,
    STAGE_VOICE_PILL_TRACE_SAMPLES,
    type StageVoicePillPayload,
    type StageVoicePillReading,
    type StageMotionAck,
    type StageMotionAckPayload,
    type StageReadyPayload,
    type StageSnapshotPayload,
    type StageSessionEnvelope,
    type StageStatePayload,
    type StageSyncRequestPayload,
    type StageAlignmentPayload,
    ALIGNMENT_RELOCATIONS,
  } from '../shared/contracts';
  import { subscribeStageEvent, emitStageEvent, isTauri, type Unsubscribe } from './events';
  import {
    initialStageState,
    stageReducer,
    displayPhase,
    type StageAckState,
    type StageAction,
  } from './renderer/stageState';
  import { fallbackFontMetrics } from '../shared/optics';
  import { lineBudget, computeSafeRect, computeReadingBand } from './renderer/geometry';
  import {
    stageFollowProfile,
    type AlignmentReceiverStats,
    type SnapshotRejectReason,
  } from './motion';
  import ScriptLayer, { type StageLayoutMeasurement } from './renderer/ScriptLayer.svelte';
  import SuggestionChip, { distancePhrase } from './renderer/SuggestionChip.svelte';
  import AckChip from './renderer/AckChip.svelte';
  import HoldStatus from './renderer/HoldStatus.svelte';
  import CalibrationCard from './renderer/CalibrationCard.svelte';
  import StageDock from './StageDock.svelte';
  import {
    resolveHoldStatus,
    type HoldHint,
    type HoldRung,
    type HoldStatus as HoldStatusReading,
    type HoldTone,
  } from './renderer/hold-status';
  import { manualScrollRelocated } from './renderer/motion';
  import { transcriptTail } from './renderer/transcript-tail';
  import { startFixtureReplay, startPreviewDriver, type PreviewDriver } from './preview';

  interface EmbeddedStageBridge {
    envelope: StageSessionEnvelope;
    alignment: StageAlignmentPayload | null;
    transcript: string;
    voicePill: StageVoicePillPayload | null;
    /**
     * §33.10. The answer to the command the presenter just pressed — a section,
     * a pace, a mirror — for the acknowledgement chip.
     *
     * The `ack` directive is the separate window's road and stands down at
     * stage generation 0, so before this every single-window take answered its
     * keys with a control-window toast: unmirrored on a mirrored rig, sized for
     * a desk, stacking one per press. Passed through as the host's own object,
     * so the bridge being rebuilt for a snapshot is not a new answer.
     */
    ack?: StageAckState | null;
    /**
     * §48. Voice following is off — the host's own switch, read straight rather
     * than through a directive.
     *
     * Single-window presentation runs at stage generation 0 and the directive
     * bus is a no-op there, so a mode that only travelled by directive would be
     * dead in exactly the configuration most people use. The standalone window
     * gets the same fact through `{ kind: 'follow' }`.
     */
    followPaused?: boolean;
    /**
     * The take itself is paused (Space, or a hard pause) — not the same thing
     * as following being switched off, and deliberately not drawn as it.
     *
     * Pausing stops control forwarding snapshots, but the stage would otherwise
     * go on playing the last one's prediction out — up to a few words, under a
     * label that says "Paused". In a reading window the text holds instead: the
     * motion engine is told to stand still, exactly as it is for Follow off,
     * without the "Following off" chip or the dock's amber state. A prompter
     * keeps its practised behaviour.
     */
    takePaused?: boolean;
    /**
     * The script's title, for the reading window's accessible name. A reading
     * window is a document somebody reads, so it is named for what it shows.
     */
    scriptTitle?: string;
    /**
     * The fixed-pace transport. Null is "not running and never was", which is
     * the same instruction as a stopped one and is what an older host sends.
     */
    autoScroll?: StageAutoScrollPayload | null;
    /**
     * §practice. This reading is a rehearsal.
     *
     * Only ever true on the embedded path, and that is a property of the
     * feature rather than an omission: a practice happens IN the control
     * window, so there is no separate stage window for the flag to travel to.
     * It reaches the renderer and the dock and changes nothing else — the
     * alignment path, the motion path and the optics are the take's, because
     * following your own voice is the thing being practised.
     */
    practice?: boolean;
    /**
     * "Show nothing", the host's own switch, mirrored the same way
     * `followPaused` is — directly, not through a directive, for the same
     * generation-0 reason.
     *
     * Unlike `followPaused` this cannot become a second local `$derived`: the
     * reducer's `blanked` gates six separate surfaces (script visibility, the
     * motion/render loop, the ack chip, hold status, the transcript tap and
     * the dock), and a read site added here for only one of them would leave
     * the other five visibly wrong during a blank. The bridge effect below
     * instead dispatches the same `blank` directive the reducer already
     * understands, so every consumer stays on one value.
     */
    blanked?: boolean;
    /**
     * Whether the host is presenting on the whole display or in a window.
     *
     * Direct, like `followPaused` and `blanked`, and for the same generation-0
     * reason: single-window presentation is where this control exists at all, and
     * that is exactly the configuration the directive bus does not reach.
     */
    presentationMode?: PresentationMode;
    /**
     * The presentation-mode control was pressed. Omitted means "do not offer
     * it" — see the button in `StageDock`.
     *
     * A callback rather than a `StageIntent`, because switching mode is a WINDOW
     * operation the host performs against Rust, not a request about the script.
     * Every member of `StageIntent` is something the stage could in principle ask
     * a separate-window host for over the event bus; this one is meaningless
     * there, since the command acts on the control window.
     */
    onpresentationtoggle?: () => void;
    onexit: () => void;
    onintent?: (intent: StageIntent) => void;
    /**
     * The appearance panel, for the dock to raise over the settings button.
     *
     * A snippet the host renders into, rather than anything this window owns.
     * The stage receives a resolved envelope and holds no settings; the sheet's
     * transaction — live preview, Done saves, Cancel restores the snapshot —
     * runs against state that only the host has. Omitting it removes the
     * settings button entirely, which is the honest answer for a standalone
     * stage window: there is nothing there for it to adjust.
     */
    appearancePanel?: Snippet;
    appearanceOpen?: boolean;
    onappearanceopen?: () => void;
    onappearanceclose?: () => void;
    /**
     * What the stage measured off the face it is actually drawing.
     *
     * Control resolves geometry against DIN fallbacks because control does not
     * render the font, so `charactersPerLine` exists only here — and the width
     * control that most needs it is on the host's panel. In a separate-window
     * session the same numbers travel on `layout-ready`; this is the in-memory
     * equivalent for the single-window one.
     */
    onmeasurement?: (measurement: StageLayoutMeasurement) => void;
    /**
     * The host has opened operator chrome over the stage — the presentation
     * menu, or the appearance sheet — and owns the keyboard until it closes.
     *
     * Without this the stage answers keys it can see but no longer has any
     * business acting on: Escape would end the take instead of closing the
     * sheet that is open on top of it, Space would pause the script while
     * somebody is tabbing through the controls, and the arrows — the ones a
     * range input uses to move a slider — would step the script a line at a
     * time behind the panel. All three are the same mistake, so one flag
     * stands the whole keyboard down rather than three guards that will
     * eventually disagree.
     */
    chromeOpen?: boolean;
  }

  let { embedded = null }: { embedded?: EmbeddedStageBridge | null } = $props();

  const previewParams =
    typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const preview = previewParams?.get('preview') === '1';
  /**
   * `?calibrated=0` drives the preview through the UNCALIBRATED layout.
   *
   * Opt-out rather than opt-in so the default preview keeps showing what the
   * optical model resolves, which is what the harness was built to make visible.
   */
  const previewCalibrated = previewParams?.get('calibrated') !== '0';
  /** A frozen Tier-B run to replay, instead of the synthetic preview driver. */
  const previewReplayUrl = previewParams?.get('replay') ?? null;

  let app = $state.raw(initialStageState());
  /**
   * The script may be revealed: fonts are final, or the wait for them is over.
   *
   * Two flags, not one, because they answer different questions and the second
   * one used to lie. `fontsSettled` gates the reveal; `fontsResolved` records
   * whether `document.fonts.ready` actually resolved or whether the bounded wait
   * simply expired. They were the same variable, set true down both branches, so
   * the handshake reported `fontsReady: true` to control for a stage that had
   * given up waiting — the one case where the layout is measured against a
   * fallback face and every angular number derived from it is provisional.
   *
   * The reveal still happens on timeout: a font that never resolves must not
   * hold the script off the glass for a whole take. What changes is that the
   * stage says so, and the measurement it publishes says so too.
   */
  let fontsSettled = $state(false);
  let fontsResolved = $state(false);
  /**
   * The reading composition is on the glass, in the position it will stay in.
   *
   * Reported by `ScriptLayer` (`onplacedchange`) rather than inferred here,
   * because the layer is the only thing that knows: it owns the line map, the
   * opening placement and the wheel gesture that can settle the question early.
   * False until it says otherwise, including before the layer exists at all.
   */
  let scriptPlaced = $state(false);

  /**
   * How long the opening plate takes to clear once the script is in place.
   *
   * The script is revealed UNDER the plate and the plate then fades off it, so
   * the first thing the presenter sees is the composition already where it
   * belongs rather than a cut. Two frames of black would read as a glitch and
   * half a second would read as a wait; this is the same 200 ms the rest of the
   * stage chrome uses.
   */
  const OPENING_PLATE_FADE_MS = 200;
  /**
   * The plate outlives `scriptPlaced` by the length of its own fade.
   *
   * Unmounting on the flag would delete the element mid-transition and cut to
   * the script, which is the thing the fade exists to avoid.
   */
  let openingPlateMounted = $state(true);
  $effect(() => {
    if (!scriptPlaced) {
      openingPlateMounted = true;
      return;
    }
    if (reducedMotion) {
      openingPlateMounted = false;
      return;
    }
    const timer = window.setTimeout(() => (openingPlateMounted = false), OPENING_PLATE_FADE_MS);
    return () => window.clearTimeout(timer);
  });
  let pointerHidden = $state(false);
  /*
   * Viewport size, measured with a fallback rather than measured alone.
   *
   * `bind:clientWidth/clientHeight` is a ResizeObserver, and an observation is
   * delivered during the rendering update — which a window that has never been
   * shown may never run. The stage is created hidden and only goes full screen
   * AFTER the handshake completes (§29.2 step 3), so for the whole of that
   * handshake these were the numbers of an unrendered window: zero. Everything
   * downstream is guarded on a nonzero viewport, so the measurement pass bailed
   * and `layout-ready` was never sent.
   *
   * `window.innerWidth/innerHeight` is available synchronously whether or not
   * anything has been painted, and Svelte initialises these bindings from it at
   * mount instead of from an observer. The observed value wins the moment it
   * exists, so a visible window behaves exactly as before.
   */
  let measuredVw = $state(0);
  let measuredVh = $state(0);
  let windowVw = $state(0);
  let windowVh = $state(0);
  const vw = $derived(measuredVw || windowVw);
  const vh = $derived(measuredVh || windowVh);
  let scriptLayer: ScriptLayer | undefined = $state();
  let liveSyncRevision = 0;
  let previewDriver: PreviewDriver | null = null;

  const phase = $derived(displayPhase(app));
  const settings = $derived(app.settings);
  /**
   * The field this stage is drawn on: `reader-paper` for a reading window
   * composed on paper, `stage-dark` for everything else.
   *
   * The reader check is a second lock rather than tidiness. Control only ever
   * writes `reader-paper` with a reader `readingContext`
   * (`READER_PAPER_THEME_ID` in `stage-envelope.ts`), but this is the last
   * point before the glass, and a light field on a beamsplitter is the one
   * failure the black field exists to prevent — so a prompter stays black here
   * even if an envelope ever says otherwise. Any other id is dark too: there is
   * no third theme, and an unknown one must not reach for tokens that do not
   * exist.
   */
  const stageTheme = $derived(
    settings?.readingContext === 'reader' && settings.themeId === 'reader-paper'
      ? 'reader-paper'
      : 'stage-dark',
  );
  const doc = $derived(app.envelope?.renderDocument ?? null);
  /**
   * How much script this rig actually shows, as a diagnostic.
   *
   * This replaces a `compact` boolean that asked whether the viewport was under
   * 700px tall and then selected one of two hand-tuned layout tables. That was
   * always a proxy for the real question — how many rendered line pitches fit
   * between the top of the visible area and the reading band, and how many
   * below it — and the proxy broke as soon as type size or line height moved.
   *
   * Reported rather than enforced: nothing here changes what is drawn. The type
   * size comes from the viewing distance and the band from the lens, and
   * silently overriding either to hit a line count would trade a legible
   * display for a fuller one.
   */
  const budget = $derived.by(() => {
    const optics = settings?.optics ?? null;
    if (vh === 0 || !settings) return null;
    const linePitchPx = (optics?.bodyFontSizePx ?? settings.fontSizePx) * (optics?.lineHeight ?? settings.lineHeight);
    const safeRect = computeSafeRect(
      vw,
      vh,
      optics?.safeArea ?? { top: 0, right: 0, bottom: 0, left: 0 },
    );
    const band = computeReadingBand(vh, {
      centerPercent: optics ? optics.readingBandY * 100 : settings.readingBandCenterPercent,
      halfHeightPercent: settings.readingBandHalfHeightPercent,
      // Inside the safe rectangle, exactly as the script layer places it. The
      // budget is counted in lines above and below the band, so a band measured
      // against the raw window on a hooded rig reports a count for a line that
      // is not where the presenter's is.
      ...(optics
        ? {
            linePitchPx,
            deadZoneLines: optics.deadZoneLines,
            safeRect,
            lensPlacement: optics.lensPlacement,
          }
        : {}),
    });
    return lineBudget({
      safeRect,
      viewportHeightPx: vh,
      bandCenterPx: band.centerPx,
      linePitchPx,
      futureReserveLines: optics?.futureReserveLines,
    });
  });
  /**
   * Diagnostic Take, as opposed to Clean Take.
   *
   * Clean is the default and is what a take is recorded against: script, reading
   * cue, authored cues, acknowledgements, a hold message once a hold has earned
   * one, faults the presenter can act on, and the Escape confirmation. Nothing
   * that reports on the machinery.
   *
   * Diagnostic adds the instruments — the raw transcript, the alignment state
   * and token position, the frame and media health, and the voice pill's
   * waveform. They are for the person debugging a rig, and every one of them
   * costs the presenter attention during a take that is going fine.
   *
   * The `diagnostics` directive stays an independent override, because an
   * operator who asks for the readout mid-take is asking for it whatever mode
   * the rig is nominally in.
   */
  const diagnosticMode = $derived((settings?.stageMode ?? 'clean') === 'diagnostic');
  const showDiagnostics = $derived(diagnosticMode || app.diagnostics);

  /* ---- the alignment feed, as this window actually experienced it (§64) ---- */

  /**
   * Snapshots this window was HANDED, whatever became of them afterwards.
   *
   * Counted at the subscription rather than taken from the receiver, because
   * the receiver only exists once the ScriptLayer is mounted. A take where this
   * stays at zero and one where it climbs while `alignmentFeed.rejected` climbs
   * with it are two different faults with one symptom.
   */
  let alignmentArrived = $state(0);
  /** Transcript taps this window was handed. See the subscription. */
  let transcriptTapsArrived = $state(0);
  /**
   * The take these counters describe.
   *
   * A `$derived` rather than a read inside the effect, and that is load-bearing:
   * `app` is `$state.raw` and is REASSIGNED on every dispatch — including the
   * one this readout is counting, once a second. An effect that read
   * `app.envelope?.…` directly would therefore re-run on every snapshot and zero
   * the counters it exists to accumulate, leaving the readout permanently
   * showing "1 ok / 0 dropped". A derived value only notifies when the number
   * itself changes, which is the actual signal: a new take.
   *
   * Null when the envelope omits it, which a preview envelope does — see
   * `StageSessionEnvelope.sessionGeneration`. That is a stable value too, so it
   * does not schedule either.
   */
  const feedSessionGeneration = $derived(app.envelope?.sessionGeneration ?? null);

  /**
   * Both counters start again with each SESSION.
   *
   * The window can outlive one — Present again opens a new session into it —
   * and `alignmentArrived` is counted here rather than by the receiver, so
   * nothing else would ever clear it. The receiver zeroes its own counters on
   * the same signal (`setSession`), which is what keeps the two halves of this
   * readout describing the same stretch of time.
   *
   * A retake inside a session is deliberately NOT a reset: "restart paragraph"
   * opens a new take pass without minting a generation, and the feed it would
   * be describing did not restart either.
   */
  $effect(() => {
    void feedSessionGeneration;
    untrack(() => {
      alignmentArrived = 0;
      transcriptTapsArrived = 0;
      alignmentFeed = null;
    });
  });
  /** The receiver's verdict on those snapshots, or null before one is mounted. */
  let alignmentFeed = $state<{
    accepted: number;
    rejected: number;
    reason: SnapshotRejectReason | null;
    field: string | null;
  } | null>(null);

  /**
   * The reason the most rejections were filed under, or null if there are none.
   *
   * The dominant reason rather than the last one: a single stale duplicate in a
   * healthy take is noise, and a readout that showed the most recent rejection
   * would report that noise as the take's story. What matters is which of the
   * three is doing the throwing away.
   */
  function dominantRejectReason(stats: AlignmentReceiverStats): SnapshotRejectReason | null {
    let worst: SnapshotRejectReason | null = null;
    let count = 0;
    for (const [reason, n] of Object.entries(stats.byReason) as Array<
      [SnapshotRejectReason, number]
    >) {
      if (n > count) {
        count = n;
        worst = reason;
      }
    }
    return worst;
  }

  /**
   * The safe rectangle, as CSS insets for the presenter-facing overlay plane.
   *
   * A hood reveals less than the panel, and an overlay positioned against the
   * raw viewport lands under the bezel — which for the hold chip and the voice
   * pill means the one message worth reading is the one nobody can see. The
   * script layer solves its own geometry inside the same rectangle; this is that
   * rectangle expressed for everything that is merely placed in a corner.
   *
   * Solved by `computeSafeRect` against a 100-unit square — so the answer IS
   * the percentage — rather than read off the profile edge by edge. Two reasons,
   * and both are about the rectangle being one thing: the overlays and the
   * script column are then inset by the same solver, and the solver's clamp
   * comes with it. These numbers are written straight into a style attribute,
   * where a single non-finite edge writes `NaN%`, the declaration is dropped,
   * and the plane falls back to the corner it was supposed to be inset from.
   */
  const safeInsets = $derived(computeSafeRect(100, 100, settings?.optics?.safeArea));

  /**
   * How tall a popover rising from the dock is allowed to be, in px.
   *
   * A popover cannot be sized against the VIEWPORT, which is what it was doing:
   * `calc(100vh - 96px)` describes the panel, and the dock is positioned inside
   * the SAFE rectangle, which a hood can crop to a fraction of it. The optical
   * model accepts insets up to 45% per edge — so a 412px panel rising from a
   * dock 16px above a bottom inset of 25% starts about 26px above the top of
   * the window, where `.stage-root`'s `overflow: hidden` cuts its title and its
   * Done button off and there is no way to scroll them back.
   *
   * Published as a custom property rather than applied here because the thing
   * that has to obey it — the host's appearance panel — is a snippet rendered
   * by control, several components away. Custom properties inherit, so it
   * reaches whatever ends up inside the dock without either side importing the
   * other.
   *
   * The floor is deliberate: below about 180px a panel is not worth opening,
   * and a rig whose safe rectangle is that short has a bigger problem than this
   * popover. Better to overflow one clearly than to render a sliver.
   */
  /**
   * Where the acknowledgement chip starts, in px down the safe rectangle.
   *
   * The chip sits in the top-right corner, and in a single-window take that
   * corner of the WINDOW belongs to control's "Take controls" tab: 16px down,
   * 32px tall, flush right (`.tc-tab` in Live.svelte). The chip clears it by the
   * chrome inset's own breathing room. A separate stage window has no tab, and
   * a safe rectangle already inset past it needs no extra clearance.
   */
  const ackTopPx = $derived.by(() => {
    const inset = 20;
    if (!embedded) return inset;
    const tabBottom = 16 + 32;
    const safeTop = (vh * safeInsets.y) / 100;
    return Math.max(inset, Math.round(tabBottom + 12 - safeTop));
  });

  /** The chip's answer: the host's in a single-window take, the directive's otherwise. */
  const stageAck = $derived(embedded ? (embedded.ack ?? null) : app.ack);

  const dockPopoverMaxPx = $derived.by(() => {
    if (vh === 0) return null;
    // The dock's own geometry, matching StageDock's CSS: 16px bottom inset,
    // 40px of controls, 8px of gap, and a little air at the top.
    const consumed = 16 + 40 + 8 + 8;
    return Math.max(180, Math.round((vh * safeInsets.height) / 100) - consumed);
  });

  /**
   * The floor for presenter-readable text that is not body copy, in px.
   *
   * Published on the ROOT rather than only on the script layer, because the
   * overlays that clamp to it — the acknowledgement chip, the hold status, the
   * calibration cards — are siblings of the script layer, not children of it.
   * They were reading the em-relative default from `stage.css` and rendering at
   * decoration size on a rig whose optics said otherwise.
   */
  const secondaryMinCss = $derived(
    settings?.optics ? `${settings.optics.secondaryMinPx}px` : null,
  );

  /**
   * That same floor as a NUMBER, floored again, for the overlays that set their
   * own type size.
   *
   * The custom property above is only bound when `settings.optics` exists. When
   * it does not, everything reading `var(--stage-secondary-min, …)` falls
   * through to the `0.67em` declared on `.stage-root` — which is em-relative,
   * resolves at roughly 11px against the root font size, and is therefore
   * SMALLER than the fixed sizes the optical work replaced. An uncalibrated rig
   * is exactly the one where nobody has told us how far away the presenter is,
   * so it is the last place that should silently get the smallest type on the
   * glass.
   *
   * Identical rule to `HoldStatus`, deliberately: 14px hard floor for a value
   * that resolved absurdly small, 18px when there is no optical profile at all.
   */
  const secondaryMinPx = $derived(settings?.optics?.secondaryMinPx ?? 0);
  const overlayFontSizePx = $derived(
    Number.isFinite(secondaryMinPx) && secondaryMinPx > 0 ? Math.max(14, secondaryMinPx) : 18,
  );

  /**
   * How wide the acknowledgement chip may be, in px.
   *
   * It shares the top edge with the hold chip, which sits in the opposite
   * corner and may be up to 40vw wide (HoldStatus's cap, border-box). A cap in
   * percent of the SAFE rectangle cannot promise daylight between them: a hood
   * that crops the panel shrinks the rectangle but not the viewport the hold
   * chip measures against. So the budget is what is left of the safe width
   * once the hold chip's widest outer box, both insets and a gap are taken out
   * — and never more than half the rectangle, where a single answer would
   * start to read as a banner.
   */
  const ackMaxWidthPx = $derived.by(() => {
    if (vw === 0) return null;
    const inset = 20;
    const gap = 16;
    const safeWidth = (vw * safeInsets.width) / 100;
    const holdOuter = vw * 0.4 + inset;
    return Math.max(0, Math.min(safeWidth * 0.52, safeWidth - holdOuter - inset - gap));
  });

  /**
   * The safe rectangle is too narrow for both chips side by side: the budget
   * would not hold the chip's own minimum width. Then a hold that is up wins
   * the top edge — it names a fault the presenter can act on, and an
   * acknowledgement is only ever a confirmation of something they just did.
   */
  const ackCrowded = $derived(ackMaxWidthPx !== null && ackMaxWidthPx < 6 * overlayFontSizePx);

  /** This is a reading window, as the host presents it. */
  const readingWindow = $derived(embedded?.presentationMode === 'reader');

  /*
   * The system's reduced-motion preference — watched in a reading window,
   * read as before in a prompter take.
   *
   * `matchMedia(...).matches` inside a derived is read when something else
   * makes the derived re-run, which for a whole take can be never — so turning
   * Reduce motion on mid-read used to change nothing until the next take. A
   * reader at a desk who asks for less motion gets it now.
   *
   * A prompter keeps its practised policy, deliberately. Reduced motion puts
   * the follower in snap mode, and switching that on mid-take lands the glass
   * at once on wherever it was still easing to — a jump in front of somebody
   * reading aloud, who did not ask for one from a preference on another
   * screen.
   *
   * The listener is guarded because test doubles of `matchMedia` often return
   * a bare `{ matches }`.
   */
  function readSystemReducedMotion(): boolean {
    return (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      Boolean(window.matchMedia('(prefers-reduced-motion: reduce)')?.matches)
    );
  }
  let systemReducedMotion = $state(readSystemReducedMotion());
  $effect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => (systemReducedMotion = Boolean(query?.matches));
    query?.addEventListener?.('change', onChange);
    return () => query?.removeEventListener?.('change', onChange);
  });
  const reducedMotion = $derived(
    (settings?.reducedMotion ?? false) ||
      (readingWindow ? systemReducedMotion : readSystemReducedMotion()),
  );
  const motionFrozen = $derived(app.frozen);
  const scriptHidden = $derived(app.blanked);
  /**
   * §48. Whether voice following is off, from whichever of the two roads
   * carries it: the host's prop in single-window presentation, the `follow`
   * directive in a standalone stage window.
   *
   * The bridge wins where it exists rather than being merged with the reducer's
   * copy, because in the embedded case the host IS the owner of the switch —
   * the same state its own transport checkbox reads — and a stage that kept a
   * second opinion could only ever disagree with it.
   */
  const followPaused = $derived(embedded ? (embedded.followPaused ?? false) : app.followPaused);
  /**
   * A paused take holds a reading window's text still — see `takePaused` on the
   * bridge. Only the motion engine hears it: the hold chip and the dock read
   * `followPaused`, which is still the follow switch and nothing else.
   */
  const readerTakePaused = $derived(readingWindow && (embedded?.takePaused ?? false));

  /* ------------------------------------------------- the off-screen suggestion
   *
   * The engine reports a match it refused because it was off the glass
   * (`holdOffScreen`, `suggestionToken`). In a reading window that place is
   * offered — never taken — as the reader's own words, which way and how far
   * ("Possible match 2 paragraphs down · <section>"), and a "Read from there"
   * that asks control for one deliberate reposition.
   *
   * Latched, because the engine names the place only on the snapshots that
   * refused it: the next hold may carry no suggestion, and a card that blinked
   * out between partials would be unreadable. It is withdrawn when following
   * resumes, when the document is moved on purpose (a relocation, or the
   * reader's own hand — they are finding their place themselves), and when it
   * is ignored. When nothing has renewed it for a while it folds to a pill in
   * the dock's row instead, out of the way of the script but still one click
   * from the place. That is a timer, not a check on the next snapshot: a take
   * that goes quiet sends none.
   */
  interface PendingSuggestion {
    token: number;
    seq: number;
    sessionGeneration: number;
    /** Wall clock of the latest refusal that named it — what control judges a press by. */
    receivedAtMs: number;
  }
  const SUGGESTION_STALE_MS = 12_000;
  /**
   * How long the offer stays open once the pointer or the keyboard has left
   * it. While either is ON it, it does not fold at all: somebody reaching for
   * the button is not to have it taken away as they arrive.
   */
  const SUGGESTION_RELEASE_MS = 4_000;
  /** Two places this close are the same place said twice. */
  const SUGGESTION_SAME_PLACE_TOKENS = 3;
  let pendingSuggestion = $state<PendingSuggestion | null>(null);
  let ignoredSuggestionToken: number | null = null;
  let suggestionEngaged = $state(false);
  let suggestionReleasedAtMs = 0;
  /**
   * A different place, named while somebody was on the offer. It waits for
   * them to let go: the words they are reading, and the place their press
   * would go, are not swapped under them.
   */
  let deferredSuggestion: PendingSuggestion | null = null;
  /**
   * Nothing has renewed the offer for `SUGGESTION_STALE_MS`: it folds to a
   * pill in the dock's row rather than going, and stays one click away until
   * a withdrawal that means something — following, a move, Ignore, a blank.
   */
  let suggestionStale = $state(false);
  let suggestionOpenedAtMs = 0;
  /** The dock's row as drawn — the offer folds into the same row, beside it. */
  let dockRowWidthPx = $state(0);
  /** The hold message as drawn, 0 while it is not showing — the card sits below it. */
  let holdStatusHeightPx = $state(0);
  /*
   * The last snapshot this has judged. `app` is replaced whole on every
   * dispatch, so the effect below re-runs on a blank, a settings push, a
   * heartbeat — and re-reading the same refusal then would bring back an offer
   * that had expired or that the reader's own hand had withdrawn.
   */
  let lastJudgedSnapshot: { sessionGeneration: number; seq: number } | null = null;
  let stageRootEl = $state<HTMLDivElement | undefined>();

  /*
   * Withdraw the offer, keeping the keyboard somewhere sensible.
   *
   * A focused button that is removed drops focus to the body, which leaves a
   * keyboard or screen-reader user nowhere. The reading window itself takes it
   * instead — it is the surface their next key is for.
   */
  function dropSuggestion(): void {
    if (pendingSuggestion === null) return;
    handFocusFromSuggestion();
    pendingSuggestion = null;
    deferredSuggestion = null;
    suggestionEngaged = false;
    suggestionReleasedAtMs = 0;
    suggestionStale = false;
    suggestionOpenedAtMs = 0;
  }

  /** The reader opened the folded offer: it is shown again, on a fresh clock. */
  function openSuggestion(): void {
    if (!pendingSuggestion) return;
    suggestionStale = false;
    suggestionOpenedAtMs = Date.now();
  }

  function engageSuggestion(engaged: boolean): void {
    if (engaged === suggestionEngaged) return;
    if (!engaged && pendingSuggestion) {
      suggestionReleasedAtMs = Date.now();
      if (deferredSuggestion) {
        pendingSuggestion = deferredSuggestion;
        suggestionStale = false;
      }
    }
    deferredSuggestion = null;
    suggestionEngaged = engaged;
  }

  /**
   * Called BEFORE whatever is about to remove the chip — removal itself drops
   * focus without an event every engine reports, so afterwards is too late.
   */
  function handFocusFromSuggestion(): void {
    const focused = typeof document === 'undefined' ? null : document.activeElement;
    if (focused instanceof Element && focused.closest('[data-suggestion-chip]') !== null) {
      stageRootEl?.focus({ preventScroll: true });
    }
  }

  $effect(() => {
    const snapshot = app.alignment;
    const reading = readingWindow;
    untrack(() => {
      if (!reading || !snapshot) {
        dropSuggestion();
        lastJudgedSnapshot = null;
        return;
      }
      if (
        lastJudgedSnapshot !== null &&
        lastJudgedSnapshot.sessionGeneration === snapshot.sessionGeneration &&
        lastJudgedSnapshot.seq === snapshot.seq
      ) {
        return;
      }
      lastJudgedSnapshot = { sessionGeneration: snapshot.sessionGeneration, seq: snapshot.seq };
      if (snapshot.state === 'following') {
        dropSuggestion();
        ignoredSuggestionToken = null;
        return;
      }
      if (ALIGNMENT_RELOCATIONS.has(snapshot.decision)) {
        dropSuggestion();
        return;
      }
      const token = snapshot.suggestionToken;
      if (snapshot.decision === 'holdOffScreen' && token !== null && Number.isFinite(token)) {
        const ignored =
          ignoredSuggestionToken !== null &&
          Math.abs(token - ignoredSuggestionToken) <= SUGGESTION_SAME_PLACE_TOKENS;
        if (!ignored) {
          const next: PendingSuggestion = {
            token,
            seq: snapshot.seq,
            sessionGeneration: snapshot.sessionGeneration,
            receivedAtMs: Date.now(),
          };
          const current = pendingSuggestion;
          if (suggestionEngaged && current) {
            // Somebody is reading this offer or reaching for it. The same
            // place renews it without moving its words; another one waits.
            if (Math.abs(token - current.token) <= SUGGESTION_SAME_PLACE_TOKENS) {
              pendingSuggestion = { ...next, token: current.token };
            } else {
              deferredSuggestion = next;
            }
          } else {
            pendingSuggestion = next;
            suggestionStale = false;
          }
        }
      }
    });
  });

  // Renewed by every refusal that names the place again: each one replaces
  // the latch, which re-runs this and restarts the clock. Held while the offer
  // is engaged, given a moment's grace once it is let go, and a fresh clock
  // when the reader opens it again. Expiry folds it; it does not withdraw it.
  $effect(() => {
    const suggestion = pendingSuggestion;
    if (!suggestion || suggestionEngaged || suggestionStale) return;
    const expiresAtMs = Math.max(
      suggestion.receivedAtMs + SUGGESTION_STALE_MS,
      suggestionReleasedAtMs + SUGGESTION_RELEASE_MS,
      suggestionOpenedAtMs + SUGGESTION_STALE_MS,
    );
    const remaining = Math.max(0, expiresAtMs - Date.now());
    const timer = window.setTimeout(() => untrack(foldSuggestion), remaining);
    return () => clearTimeout(timer);
  });

  function foldSuggestion(): void {
    if (!pendingSuggestion) return;
    // The card's buttons go with it; the keyboard goes to the reading window,
    // as for any withdrawal, rather than to the page.
    handFocusFromSuggestion();
    suggestionStale = true;
  }

  const suggestionDescription = $derived(
    pendingSuggestion && scriptLayer ? scriptLayer.describeToken(pendingSuggestion.token) : null,
  );

  /*
   * What a screen reader hears, once per offer.
   *
   * The chip mounts already filled, and a live region that arrives with its
   * text is not reliably announced — so the announcement lives in a region
   * that is always there, and changes only when the offered PLACE does. The
   * distance is the one it had when it was offered: as the reader reads on,
   * "2 paragraphs down" becomes "1 paragraph down" on the card, and saying
   * the offer again for that would be saying it twice.
   */
  let announcedSuggestion = $state<{ token: number; text: string } | null>(null);
  $effect(() => {
    const description = suggestionDescription;
    untrack(() => {
      if (!description) {
        announcedSuggestion = null;
        return;
      }
      if (announcedSuggestion?.token === description.sentenceStartToken) return;
      const section = description.section ? `, in ${description.section}` : '';
      announcedSuggestion = {
        token: description.sentenceStartToken,
        text: `Possible match ${distancePhrase(description)}${section}: ${description.excerpt}`,
      };
    });
  });
  const suggestionAnnouncement = $derived(announcedSuggestion?.text ?? '');

  /*
   * The reading line, in the operator plane's pixels: the card is placed
   * there, and keeps clear of the line the reader is on.
   */
  const suggestionReadingLine = $derived.by(() => {
    if (!scriptLayer || !readingWindow) return null;
    const { centerPx, pitchPx } = scriptLayer.readingLineGeometry();
    if (!Number.isFinite(centerPx) || !(pitchPx > 0)) return null;
    return { centerPx: centerPx - (safeInsets.y / 100) * vh, pitchPx };
  });

  function acceptSuggestion(): void {
    const suggestion = pendingSuggestion;
    const description = suggestionDescription;
    if (!suggestion || !description) return;
    dropSuggestion();
    sendIntent({
      kind: 'read_from',
      token: description.sentenceStartToken,
      sessionGeneration: suggestion.sessionGeneration,
      seq: suggestion.seq,
      // When the offer was last made, not when it was pressed: a deliberate
      // reposition after it means the offer described a take that has moved on.
      atMs: suggestion.receivedAtMs,
    });
  }

  function ignoreSuggestion(): void {
    if (pendingSuggestion) ignoredSuggestionToken = pendingSuggestion.token;
    dropSuggestion();
  }
  /**
   * Reported on every heartbeat ack and read by the coordinator (§40.5).
   *
   * It has had no producer since the Listener was removed (§106): the layer
   * that decoded video was the only thing on the stage that could report a
   * media failure, so this is constant `true` today. The channel is kept
   * because the health field is part of the `StageStatus` contract rather than
   * anything Listener-shaped — but nothing sets it false, and a reader should
   * not mistake "healthy" here for a measurement.
   */
  let mediaHealthy = $state(true);
  /**
   * When control last proved it was alive, and NOTHING ELSE.
   *
   * -------------------------------------------------------------------------
   * THIS USED TO BE `lastInboundAt`, AND THAT MEASURED THE WRONG THING
   * -------------------------------------------------------------------------
   * Every inbound event refreshed it — directives, the transcript tap, the
   * voice pill, live sync, and alignment. Alignment is the one that breaks it:
   * Rust publishes snapshots DIRECTLY to this window, with control out of the
   * motion path entirely (that is the whole point of the design). So a control
   * window that had crashed or wedged went on being reported as alive for as
   * long as the aligner kept publishing — which, mid-take with the recogniser
   * running, is indefinitely. The watchdog could not fire in precisely the
   * situation it exists for, and the freeze that this file's whole control-loss
   * disclosure hangs off never happened.
   *
   * The heartbeat is the only inbound event that control alone can produce, so
   * it is the only one that can answer "is control alive". Generation-checked
   * on the same rule the reducer uses, so a heartbeat from a superseded start
   * attempt cannot hold the watchdog off a take it does not belong to.
   */
  let lastHeartbeatAt = 0;
  /**
   * The last words the recogniser returned, shown along the bottom.
   *
   * Three faults look identical from the stage — a script that has stopped
   * moving: the microphone was never captured, the recogniser heard nothing,
   * or the aligner failed to match good text. This bar tells them apart at a
   * glance. One of them turned out to be another application holding the
   * microphone, which Speaking Glass cannot prevent and could not report.
   */
  let transcriptTap = $state('');
  /**
   * What the bar actually draws: the last few words, whitespace normalised.
   *
   * The crop is here rather than in CSS because `overflow: hidden` only hides
   * the excess — the element still lays out at the full width of everything the
   * recogniser has said since its last finalisation. See `transcript-tail.ts`.
   */
  const transcriptWords = $derived(transcriptTail(transcriptTap));
  /**
   * The voice pill, or null until control has said anything about the input.
   *
   * Held as the whole payload rather than unpacked into fields because it is a
   * resolved view: control decided every part of it together, and splitting it
   * would let the mark and the waveform be from different frames.
   */
  let voicePill = $state<StageVoicePillPayload | null>(null);

  /**
   * The fixed-pace transport, or null while nothing has ever set it.
   *
   * Local state for the same reason the transcript bar is: it arrives on the
   * directive road, it has to survive the phases where the reducer refuses to
   * act, and the presenter's document must not start or stop rolling because a
   * generation changed underneath it.
   */
  let autoScroll = $state<StageAutoScrollPayload | null>(null);

  /*
   * Single-window presentation uses the exact stage renderer but hands its
   * session instruments across memory, not across a second webview. The
   * envelope is immutable for a take; transcript, pill and transport remain
   * live.
   */
  $effect(() => {
    const bridge = embedded;
    if (!bridge) return;
    if (app.envelope !== bridge.envelope) {
      dispatch({ type: 'snapshot', envelope: bridge.envelope });
    }
    transcriptTap = bridge.transcript;
    voicePill = bridge.voicePill;
    autoScroll = bridge.autoScroll ?? null;
    /*
     * Guarded on the reducer's own value, not a second local flag: this
     * effect reruns on every transcript/voice-pill tick, and re-dispatching
     * an unchanged blank would be pure churn rather than a real transition.
     */
    const wantsBlanked = bridge.blanked ?? false;
    if (wantsBlanked !== app.blanked) {
      // Blanking hides the suggestion by its template condition rather than
      // withdrawing it, so the keyboard is handed over here, while it is
      // still on the page.
      if (wantsBlanked) untrack(handFocusFromSuggestion);
      dispatch({
        type: 'directive',
        stageGeneration: bridge.envelope.stageGeneration,
        directive: { kind: 'blank', blanked: wantsBlanked },
      });
    }
  });

  /**
   * The transport ran out of script.
   *
   * Sent as an intent and otherwise ignored here. The stage does not stop
   * itself: control owns the running flag, and a renderer that quietly stood the
   * transport down would leave the operator looking at a Pause button for a
   * document with nowhere left to go.
   *
   * The reason is passed through untouched: whether the end is a place in the
   * script is the renderer's measurement and control's decision, not this
   * component's.
   */
  function handleAutoScrollEnd(reason: StageAutoScrollEndReason): void {
    sendIntent({ kind: 'auto_scroll_end', reason });
  }

  /* ---------------------------------------------------------------------
   * The hold ladder (renderer/hold-status.ts)
   *
   * The engine holds constantly and correctly — through a breath, a swallowed
   * word, the 1.2-1.7 s gap between transcript finals — so a stage that
   * announced every hold would put a status message on the glass several times
   * a minute during a take that is going perfectly. The ladder waits, then says
   * something wordless, then shows the top rung — a mark for an ordinary hold,
   * a sentence for anything that names a condition.
   *
   * The stopwatch lives HERE and nowhere else. The reading cue's hollow state
   * and the chip are two rungs of ONE disclosure, and a second timer beside the
   * cue would eventually disagree with this one about how long a hold has
   * lasted — which the presenter would read as the display arguing with itself.
   * ------------------------------------------------------------------- */

  /** How often the ladder is re-resolved while something is being withheld. */
  const HOLD_TICK_MS = 250;

  const alignmentState = $derived(app.alignment?.state ?? null);
  /**
   * Where the chip's top edge sits, when the shared inset would collide.
   *
   * In single-window presentation the host draws its "Take controls" tab in the
   * window's top-right corner, unmirrored — and a horizontally mirrored stage
   * puts the chip in exactly that corner, under the tab, with the condition's
   * first word behind it. So on that one path the chip starts below the tab,
   * measured in the host's own tokens (the tab is `top: var(--space-4)` and
   * `--button-h` tall) so the two cannot drift apart. A standalone stage window
   * has no tab, and an unmirrored chip is in the other corner.
   */
  const holdChipTop = $derived(
    embedded && settings?.mirrorX
      ? 'calc(var(--space-4, 16px) + var(--button-h, 32px) + 8px)'
      : undefined,
  );
  /**
   * The watchdog has frozen the stage because control stopped answering.
   *
   * Narrowed to the watchdog's own reason rather than reading `app.frozen`,
   * because a directive-ordered freeze is somebody deciding the glass should
   * hold — reporting that as a failure would announce an intention as a fault.
   */
  const controlLost = $derived(app.frozen && app.frozenReason === 'control_lost');
  /**
   * A named hardware condition, taken from the voice pill.
   *
   * The pill is the only thing on the stage that knows the input chain is
   * broken, and a fault outranks the ladder entirely: a hold usually clears
   * itself and a dead microphone never does, so every second spent being patient
   * about it is a second of a take recorded against a rig that is not listening.
   */
  const voiceFaultLabel = $derived(
    voicePill && voicePill.reading === 'fault' && voicePill.visible ? voicePill.label : null,
  );

  let holdStatus = $state<HoldStatusReading>({
    rung: 'none',
    message: null,
    tone: 'neutral',
    glyph: null,
    hint: null,
  });
  /** When the alignment state last left `following`; null while it is following. */
  let holdSinceMs: number | null = null;
  /* The resolved ladder, mirrored in plain locals. `resolveHoldStatus` needs the
   * previous rung to make its thresholds hysteretic, and reading it back off
   * `holdStatus` inside the effect that writes it would make the effect depend
   * on its own output. */
  let ladderRung: HoldRung | null = null;
  let ladderMessage: string | null = null;
  let ladderTone: HoldTone = 'neutral';
  let ladderHint: HoldHint | null = null;

  function refreshHoldStatus() {
    const state = alignmentState;
    const now = performance.now();
    if (state === null || state === 'following') holdSinceMs = null;
    else if (holdSinceMs === null) holdSinceMs = now;

    const next = resolveHoldStatus(
      {
        // No alignment at all is not a hold: nothing is being withheld before a
        // take has produced its first snapshot. A FAULT still reports, because
        // `resolveHoldStatus` puts a named fault ahead of the ladder — which is
        // exactly the take that never produces a snapshot at all.
        alignmentState: state ?? 'following',
        holdingForMs: holdSinceMs === null ? 0 : now - holdSinceMs,
        // Above the fault, and above the ladder. See `resolveHoldStatus`: once
        // control is gone every other input here is a stale measurement.
        controlLost,
        hasFault: voiceFaultLabel !== null,
        faultLabel: voiceFaultLabel,
        followPaused,
        autoScrollRunning: autoScroll?.running === true,
      },
      ladderRung,
    );
    if (
      next.rung === ladderRung &&
      next.message === ladderMessage &&
      next.tone === ladderTone &&
      next.hint === ladderHint
    ) {
      return;
    }
    ladderRung = next.rung;
    ladderMessage = next.message;
    ladderTone = next.tone;
    ladderHint = next.hint;
    holdStatus = next;
  }

  $effect(() => {
    // Resolve on every change of the two inputs, and keep a slow clock running
    // while the display is held — a rung is earned by DURATION, and no new
    // snapshot arrives to prompt the crossing.
    const holding = alignmentState !== null && alignmentState !== 'following';
    void voiceFaultLabel;
    // The third input. Following being switched off changes the chip with no
    // snapshot and no hold to prompt it, so the effect has to depend on it.
    void followPaused;
    // And the fourth: starting the transport withdraws the recovery hint while
    // the fault that earned it is still true.
    void autoScroll?.running;
    // The fifth. Control dying is a state change with no snapshot behind it and
    // no hold to time, so nothing else in this effect would prompt the
    // crossing — and the recovery heartbeat is equally silent on the way back.
    void controlLost;
    refreshHoldStatus();
    if (!holding) return;
    const timer = window.setInterval(refreshHoldStatus, HOLD_TICK_MS);
    return () => clearInterval(timer);
  });

  let heartbeatSeen = false;
  /** Layout generation the stage is currently measured at (companion §7.2). */
  let layoutGeneration = $state(0);
  /** §62: fatal line-map issues after the bounded rebuild retry. */
  let layoutIssues = $state<string[]>([]);
  /**
   * §61: the stage is missing its frame budget. The engine already backs its
   * own styling cadence and motion limits off; this is the flag the LAYERS
   * need for the nonessential effects each one owns.
   */
  let motionDegraded = $state(false);
  /**
   * §47.1/§55. The session's motion profile, as the stage is willing to run it:
   * the envelope's resolved profile when this build can interpret its version,
   * and the Appendix A default otherwise. Resolved HERE, at the mount site, so
   * the script layer is always constructed with a followable profile.
   */
  const followProfile = $derived(stageFollowProfile(app.envelope?.followProfile));
  /** Never block the script on a font that may never resolve. */
  const FONT_READY_TIMEOUT_MS = 1500;

  function dispatch(action: StageAction) {
    app = stageReducer(app, action);
  }

  function applyAlignment(snapshot: StageAlignmentPayload) {
    // Deliberately does NOT touch the control-liveness clock. These arrive from
    // Rust with control out of the path, so they say nothing about whether the
    // control window is still answering. See `lastHeartbeatAt`.
    alignmentArrived += 1;
    const accepted = scriptLayer?.pushAlignmentSnapshot(snapshot) ?? false;
    const stats = scriptLayer?.alignmentFeedStats();
    alignmentFeed = stats
      ? {
          accepted: stats.accepted,
          rejected: stats.rejected,
          reason: dominantRejectReason(stats),
          field: stats.lastMalformedField,
        }
      : null;
    if (accepted || embedded) dispatch({ type: 'alignment', snapshot });
  }

  let embeddedAlignmentSeq = Number.NEGATIVE_INFINITY;
  $effect(() => {
    const snapshot = embedded?.alignment;
    const layer = scriptLayer;
    if (!snapshot || !layer || snapshot.seq === embeddedAlignmentSeq) return;
    embeddedAlignmentSeq = snapshot.seq;
    applyAlignment(snapshot);
  });

  /* ---- inbound events ---- */
  onMount(() => {
    const unsubs: Unsubscribe[] = [];
    let disposed = false;

    const onDirective = (payload: StageStatePayload) => {
      // The generation this stage belongs to, when no envelope will ever say.
      // See `inboundGeneration`. Recording it cannot widen what the stage is
      // allowed to do: every stamp it produces is still checked by Rust.
      if (payload.stageGeneration > 0) inboundGeneration = payload.stageGeneration;
      if (payload.directive.kind === 'transcript') {
        /*
         * Generation-checked here rather than in the reducer, because the bar
         * is local state: it has to keep reading before the envelope has
         * arrived and after a blank, which is exactly when the reducer refuses
         * to act. An unknown generation is accepted for the same reason the
         * bar is not gated on `phase === 'live'` — this is the instrument that
         * says whether anything is being heard at all, and it may not be
         * switched off by the conditions it exists to explain.
         */
        const generation = app.envelope?.stageGeneration ?? 0;
        if (generation === 0 || payload.stageGeneration === generation) {
          transcriptTapsArrived += 1;
          transcriptTap = payload.directive.text;
        }
        return;
      }
      if (payload.directive.kind === 'voicePill') {
        const generation = app.envelope?.stageGeneration ?? 0;
        if (
          generation !== 0 &&
          payload.stageGeneration === generation &&
          payload.directive.pill.stageGeneration === generation
        ) {
          voicePill = payload.directive.pill;
        }
        return;
      }
      if (payload.directive.kind === 'autoScroll') {
        /*
         * Local state, beside the transcript bar and the pill, and generation
         * checked here for the same reason: the transport must keep running
         * across the phases where the reducer stands down. An unknown
         * generation is NOT accepted, though — unlike the bar, this one moves
         * the document, and a stale window rolling somebody's script because it
         * could not tell whose instruction it was is the failure the generation
         * check exists to prevent.
         */
        const generation = app.envelope?.stageGeneration ?? 0;
        if (generation !== 0 && payload.stageGeneration === generation) {
          autoScroll = payload.directive.autoScroll;
        }
        return;
      }
      dispatch({
        type: 'directive',
        stageGeneration: payload.stageGeneration,
        directive: payload.directive,
      });
    };

    const requestLiveSync = (stageGeneration: number) => {
      if (!isTauri || stageGeneration === 0) return;
      emitStageEvent<StageSyncRequestPayload>(STAGE_EVENT.syncRequest, {
        stageGeneration,
        lastRevision: liveSyncRevision,
      });
    };

    if (!embedded) {
      void (async () => {
        const subs = await Promise.all([
        subscribeStageEvent<StageSnapshotPayload>(STAGE_EVENT.loadSession, (envelope) => {
          dispatch({ type: 'snapshot', envelope });
          /*
           * A TAKE's envelope STARTS the liveness deadline, and it is the only
           * other thing allowed to touch it.
           *
           * Two holes close here, and both are the watchdog failing to fire at
           * all rather than firing wrongly:
           *
           *   • control begins its heartbeat on a ~1 s `setInterval`, so the
           *     first beat is a second away. Arming only on a beat meant that a
           *     control window which died inside that window could never set
           *     `heartbeatSeen`, and the stage would sit there forever with no
           *     deadline running — the exact silence this whole change exists
           *     to break, at the most likely moment for a start to go wrong;
           *   • a NEW generation inherited the previous one's timestamp. Once
           *     its handshake completed, a deadline measured from a take that
           *     had already ended could fire against a take that was perfectly
           *     healthy.
           *
           * Seeding here is honest about what it proves: control published this
           * envelope, so control was alive when it did. A real beat refreshes it
           * about a second later, and if none comes the deadline expires on
           * schedule.
           *
           * `sessionGeneration` is the discriminator, and it is not incidental:
           * `buildStageEnvelope` omits it exactly when the payload belongs to no
           * take, and the Settings appearance preview is the only caller that
           * does so. That preview opens a REAL stage window and publishes a REAL
           * envelope, but nothing ever heartbeats it. Arming on any envelope
           * therefore put "Control stopped responding" on the glass five seconds
           * into a preview that control was alive and actively driving, which is
           * the stage lying to the presenter: the one failure this disclosure
           * exists to prevent, committed by the disclosure itself.
           */
          if (envelope.sessionGeneration !== undefined) {
            lastHeartbeatAt = performance.now();
            heartbeatSeen = true;
          }
          // Handshake step 1 (§43.3): confirm hydration to Rust.
          emitStageEvent<StageHydratedPayload>(STAGE_EVENT.hydrated, {
            stageGeneration: envelope.stageGeneration,
            sessionId: envelope.sessionId,
          });
          requestLiveSync(envelope.stageGeneration);
        }),
        /*
         * Alignment snapshots, straight from Rust, about once a second.
         *
         * They reach the motion engine directly rather than through the
         * reducer: the engine's own receiver is the gate that validates and
         * rejects them, and routing motion through reactive state would put a
         * Svelte update between the presenter's voice and the glass. The
         * reducer gets a copy for the status readout only.
         */
        subscribeStageEvent<StageAlignmentPayload>(
          STAGE_EVENT.alignmentSnapshot,
          applyAlignment,
        ),
        subscribeStageEvent<StageLiveSyncPayload>(STAGE_EVENT.liveSync, (payload) => {
          const generation = app.envelope?.stageGeneration ?? 0;
          if (generation === 0 || payload.stageGeneration !== generation) return;
          if (payload.revision <= liveSyncRevision) return;
          liveSyncRevision = payload.revision;
          if (payload.transcript) onDirective(payload.transcript);
          if (payload.voicePill) onDirective(payload.voicePill);
          if (payload.alignment) applyAlignment(payload.alignment);
        }),
        /*
         * The transcript bar. Raw recogniser text, read straight off the wire
         * — it deliberately does not pass through the reducer, because its
         * whole value is being true when the things that do are wrong.
         */
        subscribeStageEvent<StageTranscriptTapPayload>(STAGE_EVENT.transcriptTap, (payload) => {
          /*
           * Counted, because "control sent 6 of 6" and an empty bar cannot both
           * be true and neither side could see the other. Control counts what
           * it EMITS — which is an attempt, not a delivery, since the promise
           * is fire-and-forget with a swallowed rejection. This counts what
           * arrived, so the next take says plainly which of the two it is.
           */
          transcriptTapsArrived += 1;
          transcriptTap = payload.text;
        }),
        /*
         * The voice pill. Like the transcript bar it bypasses the reducer: it
         * is an instrument pointed at the session rather than part of the
         * session's render model, and its whole value is being true when the
         * things that do go through the reducer are wrong.
         */
        subscribeStageEvent<StageVoicePillPayload>(STAGE_EVENT.voicePill, (payload) => {
          /*
           * Generation-checked, like every other directive: a payload from a
           * superseded start attempt must not be able to put a fault on the
           * corner of a take that is running perfectly well.
           *
           * "No envelope yet" is a REJECTION here, not a pass. Everywhere else
           * an unknown generation is treated as "we cannot tell, so accept";
           * that is wrong for this one, because the window between a stage
           * subscribing and its envelope arriving is exactly when the previous
           * generation's last payloads are still in flight. Accepting one there
           * left the outgoing take's reading — including a cross — sitting on
           * the new stage until control published again.
           */
          const generation = app.envelope?.stageGeneration ?? 0;
          if (generation === 0 || payload.stageGeneration !== generation) return;
          voicePill = payload;
        }),
        subscribeStageEvent<StageStatePayload>(STAGE_EVENT.applyCommand, onDirective),
        subscribeStageEvent<StageHeartbeatPayload>(STAGE_EVENT.heartbeat, (payload) => {
          /*
           * The liveness clock refreshed, and only for a beat this take owns.
           *
           * Stricter than the reducer's own rule, deliberately, and this is the
           * one place the two are allowed to differ. The reducer accepts a beat
           * that arrives before any envelope, because it has nothing to check it
           * against; for a DEADLINE that is the wrong call. This file already
           * documents that a previous generation's payloads are still in flight
           * during exactly that window, so an outgoing take's last beat could
           * seed the clock and then be inherited by whatever envelope arrived
           * next — a deadline measured from a take that had already ended.
           *
           * There is no gap left by refusing it: the envelope handler above
           * starts the deadline itself, so the clock is always running by the
           * time the phase leaves `handshake` and the watchdog is armed.
           */
          const generation = app.envelope?.stageGeneration ?? null;
          if (generation !== null && payload.stageGeneration === generation) {
            lastHeartbeatAt = performance.now();
            heartbeatSeen = true;
          }
          dispatch({ type: 'heartbeat', payload, receivedAtMs: Date.now() });
          emitStageEvent<StageHeartbeatAckPayload>(STAGE_EVENT.heartbeatAck, {
            stageGeneration: payload.stageGeneration,
            revision: payload.revision,
            trackingRevision: app.lastTrackingRevision,
            mediaHealthy,
            respondedAtMs: Date.now(),
          });
        }),
        ]);
        if (disposed) {
          subs.forEach((u) => u());
          return;
        }
        unsubs.push(...subs);
      /*
       * Handshake step 0 (§43.3): tell Rust the stage is reachable.
       *
       * This has to be the line after the subscriptions resolve, and it is the
       * whole point of the event. `open_stage` returns as soon as the window
       * is built — long before this bundle has run — and control publishes the
       * envelope a few milliseconds later. A Tauri event is delivered by
       * evaluating JS in the target webview and is never queued, so that
       * envelope landed on a page with no listeners and vanished: the stage
       * never hydrated, and the start sequence failed with "the stage did not
       * finish preparing in time" every time the stage lost the race, which
       * under `tauri dev` is every time.
       *
       * Rust holds the envelope and replays it when this arrives.
       */
        emitStageEvent<StageListeningPayload>(STAGE_EVENT.listening, { atMs: Date.now() });
      })();
    }

    /*
     * §7.1 wants the map built once fonts are final — but `document.fonts.ready`
     * is not guaranteed to settle: one font that never resolves would otherwise
     * hold the entire script off the glass for the whole take. So the wait is
     * bounded, and what happens at the end of it is the part that matters.
     *
     * On TIMEOUT the script is revealed in whatever face is available and the
     * layout is published as unmeasured — `fontsReady: false` on the handshake,
     * `metricsMeasured: false` on the measurement. If the real font lands later
     * it does not slide in unannounced: the script layer re-measures the face,
     * the fingerprint's `fontHash` moves with it, and the rebuild is classified
     * as a relayout with a §33 semantic re-anchor. A reflow the presenter can see
     * is survivable; one nothing in the system admits to is not.
     */
    const fontTimeout = window.setTimeout(() => {
      fontsSettled = true;
    }, FONT_READY_TIMEOUT_MS);
    void document.fonts.ready.then(
      () => {
        clearTimeout(fontTimeout);
        fontsResolved = true;
        fontsSettled = true;
      },
      () => {
        clearTimeout(fontTimeout);
        fontsSettled = true;
      },
    );

    // Watchdog (§43.5): if control's heartbeat stops while live, freeze
    // locally and wait. Only armed by a take — a take's envelope or a beat it
    // owns — and only under Tauri; neither the preview bus nor the Settings
    // appearance preview has a liveness contract to hold control to.
    const watchdog = window.setInterval(() => {
      if (!isTauri || !heartbeatSeen || app.phase === 'handshake') return;
      if (performance.now() - lastHeartbeatAt > STAGE_HEARTBEAT_GRACE_MS) {
        dispatch({ type: 'control_lost' });
      }
    }, 1000);
    const liveSync = window.setInterval(() => {
      requestLiveSync(app.envelope?.stageGeneration ?? 0);
    }, 500);

    /*
     * `?preview=1&replay=<url>` replays a frozen Tier-B run — real recorded
     * speech, through the real renderer — instead of the synthetic driver. It
     * is the only configuration in which "does the product follow" can be
     * asserted end to end: the benchmark proves the ENGINE follows and scores
     * Rust's own model of the display, never the code that moves the glass.
     */
    if (preview && previewReplayUrl) void startFixtureReplay(previewReplayUrl);
    else if (preview) previewDriver = startPreviewDriver({ calibrated: previewCalibrated });

    /*
     * The dock opens visible and then fades.
     *
     * Somebody has just had a full-screen window take over a display. Showing
     * them where the controls are once, for a few seconds, is the difference
     * between a stage that is quiet and a stage that looks like it has hung —
     * and it costs the take nothing, because it is over before anybody has
     * finished drawing breath to start reading.
     */
    revealDock();

    return () => {
      disposed = true;
      unsubs.forEach((u) => u());
      clearTimeout(fontTimeout);
      clearTimeout(pointerTimer);
      clearTimeout(dockTimer);
      clearTimeout(escapeHintTimer);
      clearInterval(watchdog);
      clearInterval(liveSync);
      previewDriver?.stop();
    };
  });

  /* ---- readiness ACK ---- */

  /**
   * What the stage measured, as it goes out on the wire.
   *
   * Widened locally rather than added to `StageReadyPayload` because the payload
   * is a shared contract and this window does not own it; the fields are plain
   * JSON on an event, so a control that knows nothing about them is unaffected.
   * The follow-up is the interface field plus a pass-through in the Rust relay
   * (`app.rs` builds `stage://ready` by hand), without which control sees the
   * numbers only in the raw stage event.
   */
  type StageReadyMeasurementPayload = StageReadyPayload & {
    measurement: StageLayoutMeasurement;
  };

  /** The last measurement the script layer reported; null before the first map. */
  let layoutMeasurement = $state<StageLayoutMeasurement | null>(null);
  /** What was last put on the wire, so a re-report only goes out when it moved. */
  let emittedMeasurementKey: string | null = null;
  let layoutReadyEmitted = false;

  function measurementKey(measurement: StageLayoutMeasurement | null): string {
    if (!measurement) return 'none';
    const m = measurement.fontMetrics;
    return [
      m.measured ? 'm' : 'e',
      m.capHeightRatio.toFixed(4),
      m.avgCharWidthRatio.toFixed(4),
      measurement.linePitchMeasured ? 'p' : 'e',
      measurement.linePitchPx.toFixed(2),
      measurement.charactersPerLine ?? '-',
    ].join(':');
  }

  /**
   * The measurement a rig is described by, or the honest stand-in for it.
   *
   * The handshake completes one frame before the first line map exists — the
   * pass that proves the blocks rendered runs on an earlier rAF than the one
   * that measures token rects — so this is the typographic pitch and no
   * character count at the moment `layout-ready` first goes out. The font
   * metrics ARE real by then: they come off a canvas, not off the layout.
   */
  function currentMeasurement(): StageLayoutMeasurement {
    return (
      layoutMeasurement ?? {
        fontMetrics: fallbackFontMetrics(),
        linePitchPx: settings ? settings.fontSizePx * settings.lineHeight : 0,
        linePitchMeasured: false,
        charactersPerLine: null,
      }
    );
  }

  function emitLayoutReady() {
    if (!app.envelope) return;
    const measurement = currentMeasurement();
    emittedMeasurementKey = measurementKey(measurement);
    layoutReadyEmitted = true;
    if (embedded) return;
    emitStageEvent<StageReadyMeasurementPayload>(STAGE_EVENT.layoutReady, {
      stageGeneration: app.envelope.stageGeneration,
      sessionId: app.envelope.sessionId,
      hydrated: true,
      layoutReady: true,
      // Whether the fonts RESOLVED, not whether the stage stopped waiting for
      // them. See the note on the two flags.
      fontsReady: fontsResolved,
      viewportWidth: vw,
      viewportHeight: vh,
      devicePixelRatio: window.devicePixelRatio,
      measurement,
    });
  }

  function handleLayoutReady(measurement: StageLayoutMeasurement) {
    layoutMeasurement = measurement;
    embedded?.onmeasurement?.(measurement);
    dispatch({ type: 'layout_ready' });
    emitLayoutReady();
  }

  /**
   * A rebuilt map produced different numbers.
   *
   * Re-published rather than kept local, because the numbers control needs during
   * calibration are the measured ones and the handshake necessarily went out
   * before anything had been measured. Emitting `layout-ready` again is safe by
   * construction: Rust sets two idempotent flags, and control's
   * `waitForStageReady` resolves once and ignores everything after. It is gated
   * on the measurement actually MOVING, so a take that is merely scrolling
   * through a virtualized document publishes nothing.
   */
  function handleLayoutMeasured(measurement: StageLayoutMeasurement) {
    layoutMeasurement = measurement;
    embedded?.onmeasurement?.(measurement);
    if (!layoutReadyEmitted) return;
    if (measurementKey(measurement) === emittedMeasurementKey) return;
    emitLayoutReady();
  }

  /* ---- motion diagnostics (companion §54) ---- */
  function handleMotionAck(ack: StageMotionAck) {
    // A periodic report for diagnostics and recovery — explicitly not a
    // high-frequency feedback loop into the aligner.
    // S1: emitted under the stage's OWN name. A webview emit is a broadcast
    // that reaches control directly as well as Rust, so reusing the name Rust
    // relays under (`motionAck`) delivered every ack to control twice — once
    // without the generation check.
    if (embedded) return;
    emitStageEvent<StageMotionAckPayload>(STAGE_EVENT.motionReport, {
      ...ack,
      stageGeneration: app.envelope?.stageGeneration ?? 0,
    });
  }

  /* ---- recoverable stage-layout failure (§62) ---- */
  function handleLayoutError(issues: string[]) {
    layoutIssues = issues;
    // The local diagnostics overlay only helps someone standing at the stage.
    // §62 wants the error where the operator is, so it travels the same
    // Rust-relayed, generation-checked path as the motion report — under the
    // stage's OWN name, never the one control listens for (see S1 above).
    if (embedded) return;
    emitStageEvent<StageLayoutErrorPayload>(STAGE_EVENT.layoutError, {
      stageGeneration: app.envelope?.stageGeneration ?? 0,
      issues,
      layoutGeneration,
      atMs: Date.now(),
    });
  }

  /* ---- outbound intents (§16.9: control/Rust decides) ---- */
  function sendIntent(intent: StageIntent) {
    if (embedded) {
      embedded.onintent?.(intent);
      return;
    }
    emitStageEvent<StageIntentPayload>(STAGE_EVENT.intent, {
      stageGeneration: app.envelope?.stageGeneration ?? 0,
      intent,
      atMs: Date.now(),
    });
  }

  /**
   * §16.9. Escape ends the take on the SECOND press, and the first press has
   * to say so — on the stage.
   *
   * Control answers a single press with a toast reading "Press Escape again on
   * the stage to end the session", and the presenter cannot see it: the stage
   * is frameless, sized to the monitor and always-on-top (§52.7), so the
   * control window is behind it. The first press therefore produced no visible
   * result at all, and Escape read as broken or laggy — press, nothing, press
   * again, gone.
   *
   * This is answered locally rather than by asking control to send an ack
   * back: the round trip is stage → Rust → control → Rust → stage, and the
   * whole complaint is about responsiveness. The stage already knows it sent a
   * single press, so it can say so in the same frame. Control's toast still
   * fires for the operator at the control window, who is a different person
   * looking at a different screen.
   *
   * It gets its own state rather than riding the acknowledgement chip, which
   * is gated on the `stageAcknowledgements` setting (§33.10) — turning command
   * acks off would otherwise silence the one prompt that tells a presenter how
   * to stop. This is a confirmation prompt, not an acknowledgement.
   */
  let escapeHintVisible = $state(false);
  let escapeHintTimer = 0;

  /**
   * The stage generation the host is addressing, learned from inbound payloads.
   *
   * A stage that carries a document knows its generation from the envelope. A
   * CALIBRATION stage deliberately carries none — `control/routes/Calibrate.svelte`
   * opens a bare stage and drives it with directives — so `app.envelope` stays
   * null for that window's whole life and every generation read in this file
   * falls back to 0, including the one that stamps Escape.
   *
   * That stamp is not cosmetic. Rust relays the press through
   * `coordinator.stage_event` (`app.rs`), which compares it against the live
   * stage generation and DROPS anything that does not match. So Escape from a
   * calibration stage was discarded in Rust before control could ever see it:
   * the window covered the display, the presenter pressed the one key that is
   * supposed to get them out, and nothing anywhere was listening. Quitting the
   * app was the only exit.
   *
   * Directives carry the real generation, so remembering the last one is enough
   * to make Escape work in a documentless stage without giving this window any
   * authority it did not have — a wrong stamp is still dropped, exactly as now.
   */
  let inboundGeneration = $state(0);

  function showEscapeHint() {
    escapeHintVisible = true;
    clearTimeout(escapeHintTimer);
    // Tied to the double-press window: the hint is true exactly while a second
    // press would still end the take, and stops claiming so the moment it
    // would not.
    escapeHintTimer = window.setTimeout(() => {
      escapeHintVisible = false;
    }, ESCAPE_DOUBLE_PRESS_MS);
  }

  function sendEscape(presses: 1 | 2) {
    if (presses === 1) showEscapeHint();
    else {
      escapeHintVisible = false;
      clearTimeout(escapeHintTimer);
    }
    /*
     * ONE ending rule, whichever window the stage is living in.
     *
     * Single-window presentation used to end the take on the FIRST Escape,
     * because the host was right there to hear it and the round trip the
     * two-press rule exists to cover did not apply. The result was a keyboard
     * that meant two different things depending on an architectural detail
     * nobody using it can see: the same key, on the same screen, ends the
     * session on one machine and shows a prompt on another. A presenter who
     * hits Escape by reflex — which is what happens when a full-screen window
     * takes over a display — deserves the same answer either way.
     *
     * So the confirmation is universal, and the second press is what ends it.
     * The embedded case never reaches the event bus: `onexit` is the host's own
     * teardown, and it is the same one the dock's confirmation calls.
     */
    if (embedded) {
      if (presses === 2) embedded.onexit();
      return;
    }
    // Escape travels on its own event so the Rust bridge can relay it (§46.9),
    // under a name control does NOT listen for — see S1 on motionReport above.
    emitStageEvent<StageEscapePayload>(STAGE_EVENT.escapePressed, {
      stageGeneration: app.envelope?.stageGeneration ?? inboundGeneration,
      presses,
      atMs: Date.now(),
    });
  }

  /* ---- pointer behavior (§16.9) ---- */
  let pointerTimer = 0;
  const POINTER_HIDE_DELAY_MS = 1500;

  /**
   * How long the dock's buttons stay up after the pointer last moved.
   *
   * Longer than the cursor's own hide delay, deliberately, and a separate
   * system from it. 1.5 s is right for getting a cursor out of the presenter's
   * way and far too short for finding a target and travelling to it — a button
   * that disappears while somebody is reaching for it is worse than no button,
   * because they now know it exists and cannot use it. The cursor is allowed to
   * vanish while the controls are still up.
   */
  const DOCK_VISIBLE_MS = 4000;
  let dockTimer = 0;
  /**
   * §16.9's missing half: a way out that is not a keystroke.
   *
   * Escape ends a take from whichever window holds the keyboard, and the stage
   * is frameless, monitor-sized and always-on-top (§52.7). Put those together
   * and there is a reachable state with no exit: the stage is covering a screen,
   * the operator is working in some other application, and Escape goes to that
   * application. The stage has to be clicked before it can be dismissed, and
   * nothing on it says so — a full-screen window with no visible way out reads
   * as a hang.
   *
   * So: move the mouse over the stage and the controls appear. They cannot
   * intrude on a take, because a take is exactly when nobody is touching the
   * mouse.
   */
  let dockRevealed = $state(true);
  /**
   * The dock is holding itself up: pointer over it, keyboard in it, a popup
   * open, or a fault it wants somebody to be able to reach.
   *
   * Reported by the dock rather than inferred here, because three of those four
   * are facts only it has — and taking a focused control away is the specific
   * failure this guards: unmounting or disabling a focused element drops focus
   * to the body, so somebody who tabbed to the way out would find it gone and
   * their place in the tab order with it, on a window whose entire problem is
   * being hard to leave.
   */
  let dockHeld = $state(false);
  const dockVisible = $derived(dockRevealed || dockHeld);
  /** A pane of glass is up over the dock; get the transcript out from behind it. */
  let dockPopoverOpen = $state(false);

  /**
   * The cursor hides on its own clock — EXCEPT while the dock is holding itself
   * up.
   *
   * The two timers are separate on purpose: 1.5 s is right for getting a
   * pointer out of the presenter's way and far too short for finding a control
   * and travelling to it. What they may not do is contradict each other. A
   * pointer resting on the dock, or a confirmation asking "end session?" with
   * no cursor left to answer it, is a screen that has swallowed the mouse.
   */
  const cursorHidden = $derived(pointerHidden && !dockHeld);

  /*
   * Trackpads emit `pointermove` for hand tremor. Waking the controls on every
   * one of those events means a stage that never settles: the buttons brighten,
   * the timer restarts, and the corner of the presenter's eye has something
   * flickering in it for the whole take with nobody touching anything.
   *
   * So the dock wakes on DISPLACEMENT, not on events. The cursor's own
   * un-hiding deliberately does not — a cursor is a thing you are looking for,
   * and making somebody swipe four pixels to find it is a worse trade.
   */
  const DOCK_WAKE_THRESHOLD_PX = 4;
  let lastPointerX = Number.NaN;
  let lastPointerY = Number.NaN;

  function revealDock(): void {
    dockRevealed = true;
    clearTimeout(dockTimer);
    dockTimer = window.setTimeout(() => {
      dockRevealed = false;
    }, DOCK_VISIBLE_MS);
  }

  function onPointerMove(event: PointerEvent) {
    pointerHidden = false;
    clearTimeout(pointerTimer);
    pointerTimer = window.setTimeout(() => {
      pointerHidden = true;
    }, POINTER_HIDE_DELAY_MS);

    const moved =
      !Number.isFinite(lastPointerX) ||
      Math.abs(event.clientX - lastPointerX) + Math.abs(event.clientY - lastPointerY) >=
        DOCK_WAKE_THRESHOLD_PX;
    if (!moved) return;
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;
    revealDock();
  }

  /**
   * Leave, from the stage, after the dock's confirmation.
   *
   * The same message a second Escape sends, not a new path: ending a take is
   * control's decision to make and it already owns the whole teardown — the
   * transport, the microphone, the take record, the window. A stage that closed
   * its own window would leave every one of those running behind a screen that
   * had gone black.
   */
  function requestExit() {
    escapeHintVisible = false;
    clearTimeout(escapeHintTimer);
    if (embedded) embedded.onexit();
    else sendEscape(2);
  }

  function onClick() {
    // A single click focuses the stage but never moves the script.
    sendIntent({ kind: 'stage_focused' });
  }

  /* ---- keyboard behavior (§16.9) ---- */
  /*
   * "Never" rather than zero.
   *
   * The double-press test is `now - lastEscapeAt <= ESCAPE_DOUBLE_PRESS_MS`, and
   * `performance.now()` counts from the moment the document started loading — so
   * with zero as the seed, an Escape pressed during the stage's first second and
   * a half compared against a press that never happened and read as the SECOND
   * one. That ends the take on one keystroke, in the window where somebody is
   * most likely to hit Escape by reflex because the stage has just taken over
   * their screen.
   *
   * A sentinel value rather than a `!== 0` guard beside the comparison, because
   * the guard has to be repeated everywhere the field is read OR written — and
   * the reset below is exactly the place it was missed.
   */
  let lastEscapeAt = Number.NEGATIVE_INFINITY;
  /* --------------------------------------------------------- manual gesture --
   * One report per gesture, not one per 250 ms.
   *
   * The intent used to be throttled: the first wheel event armed a timer, and
   * whatever had accumulated when it fired was sent. That is the right shape
   * for a stream of deltas and the wrong shape for a DECISION, and this now
   * carries one — where the presenter ended up, and whether they moved at all
   * or only looked. Half of a gesture answers that question wrong, and a long
   * scroll produced several halves.
   *
   * The arrow and Page keys are gestures too, and travel the same road (#282).
   * They used to report a DIRECTION instead — "a step forward" — which control
   * spent as exactly one sentence from wherever the aligner already was. So
   * Page Down moved the glass most of a screen, the engine's answer arrived a
   * moment later for a place one sentence on, and the document lurched back to
   * it. The stage is the only party that knows where the document went, so it
   * says that, the same way the wheel does.
   *
   * Sharing the gesture rather than reporting each press is deliberate. A held
   * Page Down repeats every few tens of milliseconds, and an answer to one
   * press that arrives after the next has landed names a line the hand has
   * already left — the engine spends it as an ordinary re-anchor, a page back.
   * One report when the keys go quiet has no such race, and it is also one
   * correction in the summary, which is what holding a key down was.
   */
  let gestureSettleTimer = 0;
  /** When the gesture in progress began, or 0 between gestures. */
  let gestureStartedAtMs = 0;
  /**
   * Where the document sat when the gesture began, or null between gestures.
   *
   * The gesture's travel is measured from the DOCUMENT, not by summing wheel
   * deltas, because the document clamps at both ends and the wheel does not.
   * Flick up at the top of the script and straight back down and the deltas sum
   * to zero while the page has genuinely moved a screen — and a summed-delta
   * rule read that as "nothing happened" and told the aligner nothing, which is
   * precisely the relocation this whole path exists to report.
   */
  let gestureStartPx: number | null = null;
  /**
   * When the presenter last moved the document in this gesture, wall clock —
   * the report's `atMs`.
   *
   * Not when the gesture settles. Control drops a report that a deliberate
   * reposition has overtaken, and an operator who restarts the paragraph or
   * steps a sentence inside the settle window has overtaken this one: their
   * move came after the last thing the hand did. Stamped at the flush, the
   * report would always look newer than that move and drag the aligner back
   * over it.
   */
  let gestureLastInputAtMs = 0;
  /**
   * Whether a key took part in the gesture in progress.
   *
   * A key is a decision to MOVE, so a gesture with one in it re-anchors the
   * tracker wherever the geometry can say where the presenter now is. The
   * wheel's look-or-move judgement exists because a wheel is also how somebody
   * glances ahead; nobody presses Page Down to glance, and one arrow press
   * never travels far enough to clear that bar, so the judgement would turn
   * every arrow press into a look and leave the tracker behind.
   */
  let gestureByKey = false;
  /** Home and End's own re-seed, for when the reading line lands on no spoken line. */
  let gestureFallbackAnchor: number | null = null;

  /**
   * Quiet time that ends a gesture.
   *
   * A trackpad fling delivers events a few milliseconds apart, a notched wheel
   * about every 50–120 ms and a held key every 30–80 ms, so 200 ms is
   * comfortably past the gap inside a continuous gesture and comfortably short
   * of the pause before somebody starts a new one.
   */
  const GESTURE_SETTLE_MS = 200;

  /**
   * How long a wheel gesture may run before it reports anyway.
   *
   * Somebody holding a trackpad scroll for ten seconds is not going to hit a
   * quiet window, and the tracker should not have to wait for them to stop
   * before it learns they have gone somewhere else.
   *
   * Not a gesture with a key in it. Somebody holding Page Down is paging, not
   * reading, and a report in the middle of the hold reopens the race that
   * sharing the gesture closed: the next repeat moves the hand before the
   * answer comes back, and the answer pulls the document back a page.
   */
  const GESTURE_MAX_MS = 1200;

  /* Whether a wheel gesture moved the presenter or only showed them something:
     `manualScrollRelocated`, which is where that judgement is written down. */

  /*
   * The settle timer must not outlive the component.
   *
   * A gesture interrupted by the take ending — the presenter scrolls, then hits
   * Escape twice — would otherwise fire its report into a session that is gone.
   * Both handlers on the far side guard on an active session, so nothing acts
   * on it, but a timer that survives the thing that armed it is a leak waiting
   * for a less careful reader on the other end.
   */
  $effect(() => () => {
    if (gestureSettleTimer) clearTimeout(gestureSettleTimer);
  });

  function onKeyDown(event: KeyboardEvent) {
    // Chrome is up over the stage; the host window owns the keyboard.
    if (embedded?.chromeOpen) return;
    /*
     * A key that landed inside the host's operator chrome was not addressed to
     * the script.
     *
     * The stage listens on the WINDOW, so it sees every keystroke in the
     * document — including the ones aimed at a control that has focus. Space on
     * the host's focused menu button is the case that showed it: the app
     * shortcut layer correctly stands down for a button, the menu had not
     * opened yet so `chromeOpen` was still false, and the stage toggled pause
     * AND called `preventDefault()`, which suppressed the button's own
     * activation. One key, the wrong action, and the right one cancelled.
     *
     * ESCAPE IS EXEMPT, and deliberately — the same exemption `resolveShortcut`
     * makes for the same reason. Somebody reaching for Escape has a full-screen
     * stage in front of them and no interest in which button happens to hold
     * focus; standing down for the menu trigger would mean that after closing
     * the menu, the key that ends a take quietly stopped working. An OPEN menu
     * is a different matter and is already handled: `chromeOpen` stands the
     * whole keyboard down, and the menu answers its own Escape.
     *
     * `defaultPrevented` is deliberately NOT consulted. The app shortcut layer
     * calls `preventDefault()` on every key it resolves, including the Space
     * and Escape that Live then delegates HERE on purpose — so reading it would
     * suppress exactly the keys this handler exists to answer.
     *
     * IT USED TO BE SCOPED TO THE EMBEDDED CASE, on the reasoning that only the
     * host had chrome of its own. The dock ends that: the standalone stage
     * window now carries real buttons — a settings trigger, an End control, and
     * a confirmation with two more — so Space on a focused Cancel button would
     * toggle pause AND call `preventDefault()`, suppressing the very activation
     * it was pressed for. That is the same defect this guard was written for,
     * in the one configuration it had been excused from.
     */
    if (event.key !== 'Escape') {
      const target = event.target;
      if (target instanceof Element && target.closest('[data-stage-chrome]') !== null) return;
      if (isAppChord(event)) return;
    }
    if (preview && handlePreviewKey(event.key)) return;
    switch (event.key) {
      case 'Escape': {
        event.preventDefault();
        /*
         * A HELD key is one press.
         *
         * Auto-repeat starts within about half a second, well inside the
         * double-press window, so counting repeats let a single sustained
         * Escape show the hint and then end the take — and a press that began
         * by dismissing a dock popup (which stops only its own first event)
         * went on to arm and fire the exit on the repeats behind it. The rule
         * is two deliberate presses; a key resting on the keyboard is neither.
         */
        if (event.repeat) break;
        const now = performance.now();
        const double = now - lastEscapeAt <= ESCAPE_DOUBLE_PRESS_MS;
        // Back to "never" on consumption, for the same reason the seed is:
        // zero is a real instant 1.5 s into the stage's life, so resetting to
        // zero left a THIRD press inside that window reading as another second
        // press and re-sending "end the take".
        lastEscapeAt = double ? Number.NEGATIVE_INFINITY : now;
        sendEscape(double ? 2 : 1);
        break;
      }
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault();
        const dir = event.key === 'ArrowDown' ? 1 : -1;
        moveByHand(dir * (scriptLayer?.lineHeightPx() ?? 64), true);
        break;
      }
      case 'PageDown':
      case 'PageUp': {
        event.preventDefault();
        const dir = event.key === 'PageDown' ? 1 : -1;
        moveByHand(dir * vh * 0.8, true);
        break;
      }
      /*
       * The two ends of the script. Keys, so they are always a MOVE: the
       * tracker is re-seeded at the reading line wherever the document lands,
       * exactly as for Page Down, rather than left behind at the old place.
       */
      case 'Home':
      case 'End': {
        event.preventDefault();
        // A blanked stage is not moved by the whole length of the script
        // behind the presenter's back, for the reason the wheel is not.
        if (app.blanked || !scriptLayer) break;
        const at = scriptLayer.scrollPositionPx();
        const home = event.key === 'Home';
        const target = home ? 0 : scriptLayer.endOfScriptScrollPx();
        /*
         * Already there is a key the document absorbed, as for Page Down at
         * the foot — and End never pulls the document back UP. Once End has
         * re-seeded the tracker, the follower lays the last line out at its
         * own aim, a little past where End put it; a second End that dragged it
         * back would only be undone by the follower a moment later.
         */
        const slack = scriptLayer.lineHeightPx() / 2;
        if (home ? at < slack : at > target - slack) break;
        const ends = scriptLayer.scriptEndTokens();
        moveByHand(target - at, true, home ? ends.first : ends.lastSentenceStart);
        break;
      }
      case ' ': {
        event.preventDefault();
        sendIntent({ kind: 'toggle_pause' });
        break;
      }
      /*
       * The transport, answered where the hold chip advertises it.
       *
       * On a separate-stage rig this window is the one holding the keyboard —
       * the presenter is standing at it — and the chip that names these keys is
       * drawn HERE. A key named on the glass and answered only by a window on a
       * desk behind them is advice that does not work where it is read.
       *
       * `repeat` is refused for the toggle and allowed for the pace keys, the
       * same split the control window's shortcut layer makes: a held toggle
       * flips the transport on and off many times a second, and a held pace key
       * is how somebody dials a speed in while watching the script.
       */
      case 'a':
      case 'A': {
        event.preventDefault();
        if (!event.repeat) sendIntent({ kind: 'auto_scroll_toggle' });
        break;
      }
      case ']': {
        event.preventDefault();
        sendIntent({ kind: 'auto_scroll_pace', direction: 'faster' });
        break;
      }
      case '[': {
        event.preventDefault();
        sendIntent({ kind: 'auto_scroll_pace', direction: 'slower' });
        break;
      }
    }
  }

  /**
   * Is this keystroke a chord — somebody else's command — rather than one of
   * the plain keys this listener answers?
   *
   * The switch above matches `event.key` alone, so before this guard ⌥↓ (next
   * section) stepped a line as if it were ↓, and ⌘⇧Space (hard pause) toggled
   * pause as if it were Space (#284). In this window the app shortcut layer
   * hears the same keystroke and owns the chord; a standalone stage has no
   * command for one, and should not read it as a plain key either.
   *
   * ⌘, and Ctrl on its own, are always a chord. Option is not on a key that
   * types something: Option is how a German Mac types `[`, and Ctrl+Alt is
   * AltGr, how a German PC does. On a named key — Space, an arrow, a page key —
   * no layout needs either, so there they are a chord too.
   */
  function isAppChord(event: KeyboardEvent): boolean {
    if (event.metaKey || (event.ctrlKey && !event.altKey)) return true;
    const typesCharacter = event.key.length === 1 && event.key !== ' ';
    return !typesCharacter && (event.ctrlKey || event.altKey);
  }

  function handlePreviewKey(key: string): boolean {
    if (!previewDriver) return false;
    switch (key) {
      case 'b':
        previewDriver.toggleBlank();
        return true;
      case 'f':
        previewDriver.toggleFreeze();
        return true;
      /* Voice following off and on. The off state is a lit control in the dock
         and a chip on the glass, and both are judged by looking at them beside
         a script rather than by reasoning about them. */
      case 'o':
        previewDriver.toggleFollow();
        return true;
      case 'm':
        previewDriver.toggleMirror();
        return true;
      /*
       * Calibration CYCLES rather than toggles: there are five overlays now and
       * one key that reaches all of them beats four keys nobody remembers. The
       * cycle ends at off, so a press always changes something and the preview
       * can never be stranded inside a full-screen card.
       */
      case 'c':
        previewDriver.cycleCalibration();
        return true;
      /* Clean Take ⇄ Diagnostic Take: what the presenter sees against what the
         person debugging the rig sees, judged by flipping between them. */
      case 's':
        previewDriver.toggleStageMode();
        return true;
      /* The reading cue, through ticks / wash / none. It is the one mark on the
         glass that never moves, which is exactly why it has to be looked at
         rather than reasoned about. */
      case 'r':
        previewDriver.cycleReadingCue();
        return true;
      case 'a':
        previewDriver.ack('Chapter 1');
        return true;
      case 'j':
        previewDriver.jump();
        return true;
      /*
       * The voice pill, in preview. Control drives it from a real capture, so
       * without this the only way to look at it is to start a billable take
       * with a microphone attached — which is not a loop anybody will use to
       * judge whether a 34-pixel pill reads correctly against a script.
       */
      case 'v':
        voicePill = previewVoicePill(voicePill);
        return true;
      default:
        return false;
    }
  }

  /** Cycle the pill through its four readings, then off. */
  function previewVoicePill(current: StageVoicePillPayload | null): StageVoicePillPayload | null {
    const next: StageVoicePillReading | null =
      current === null
        ? 'listening'
        : current.reading === 'listening'
          ? 'confirmed'
          : current.reading === 'confirmed'
            ? 'steady'
            : current.reading === 'steady'
              ? 'fault'
              : null;
    if (next === null) return null;
    const label = next === 'listening' ? 'Listening' : next === 'fault' ? 'No audio' : 'Hearing you';
    return {
      stageGeneration: app.envelope?.stageGeneration ?? 0,
      reading: next,
      // A plausible voice rather than a flat line: the shape is the thing being
      // judged, and every bar at the same height is not one.
      levels: Array.from({ length: STAGE_VOICE_PILL_TRACE_SAMPLES }, (_, i) =>
        Math.max(0.05, Math.abs(Math.sin(i * 0.7)) * (0.4 + 0.6 * Math.abs(Math.sin(i * 0.21)))),
      ),
      label,
      visible: true,
      sentAtMs: Date.now(),
    };
  }

  function onWheel(event: WheelEvent) {
    if (app.blanked || !doc) return;
    event.preventDefault();
    moveByHand(event.deltaY, false);
  }

  /**
   * Move the document by hand now, and report where it went once the gesture
   * settles. `byKey` marks the gesture as a decision to move (see
   * `gestureByKey`).
   */
  function moveByHand(deltaPx: number, byKey: boolean, fallbackAnchorToken: number | null = null) {
    // Read the position BEFORE the scroll lands, so the gesture's travel is
    // measured from where it actually started.
    const fromPx = scriptLayer?.scrollPositionPx() ?? 0;
    // Their hand is on the script: they are finding their place themselves,
    // and an offer made before they moved no longer describes what they see.
    if (deltaPx !== 0) dropSuggestion();
    scriptLayer?.manualScrollBy(deltaPx, fallbackAnchorToken);
    /*
     * A key the document absorbed entirely is not a gesture.
     *
     * Page Down at the foot of the script is the case: the document is already
     * as far down as it goes, so the reading line is not where the presenter
     * is — the last lines they are reading sit below it, with the aligner on
     * them. A key is a decision to move, and re-seeding the tracker on the
     * reading line for one that moved nothing would drag it back up to a place
     * nobody went.
     *
     * "Nothing" is under a pixel, not exactly zero. A resting plant is snapped
     * to the device-pixel grid, so at the foot it can sit a fraction of a pixel
     * either side of the end stop, and the clamp then "moves" it by that much.
     */
    if (byKey && Math.abs((scriptLayer?.scrollPositionPx() ?? fromPx) - fromPx) < 1) return;
    if (gestureStartPx === null) gestureStartPx = fromPx;
    if (byKey) gestureByKey = true;
    /*
     * Where a key that goes to an END of the script re-seeds the tracker when
     * the reading line cannot say: Home onto an opening heading or image, or
     * End into a run-out, leave the mark on no spoken line, and the move would
     * otherwise land the document with the aligner still where it was. The
     * latest key decides — an arrow after Home is a move from there.
     */
    gestureFallbackAnchor = fallbackAnchorToken;
    gestureLastInputAtMs = Date.now();

    const now = performance.now();
    if (gestureStartedAtMs === 0) gestureStartedAtMs = now;
    if (!gestureByKey && now - gestureStartedAtMs >= GESTURE_MAX_MS) {
      flushManualGesture();
      return;
    }
    if (gestureSettleTimer) clearTimeout(gestureSettleTimer);
    gestureSettleTimer = window.setTimeout(flushManualGesture, GESTURE_SETTLE_MS);
  }

  /** The gesture is over: report where it left the presenter. */
  function flushManualGesture() {
    if (gestureSettleTimer) {
      clearTimeout(gestureSettleTimer);
      gestureSettleTimer = 0;
    }
    const startPx = gestureStartPx;
    const byKey = gestureByKey;
    const atMs = gestureLastInputAtMs;
    gestureStartedAtMs = 0;
    gestureStartPx = null;
    gestureByKey = false;
    if (startPx === null) return;
    const deltaPx = (scriptLayer?.scrollPositionPx() ?? startPx) - startPx;
    const fallback = gestureFallbackAnchor;
    gestureFallbackAnchor = null;
    const anchorToken = byKey
      ? (scriptLayer?.readingAnchorToken() ?? fallback)
      : relocationAnchorToken();
    // Nothing moved and nowhere to send anybody: a wheel event the document
    // absorbed entirely is not news.
    if (deltaPx === 0 && anchorToken === null) return;
    sendIntent({ kind: 'manual_scroll', deltaPx, anchorToken, atMs });
  }

  /**
   * Where to re-seed the tracker, or null if this gesture was a look.
   *
   * Both halves have to be answerable before this claims anything. No measured
   * gap means no alignment target to be far from — the feed has not produced a
   * frame this session — and the honest answer then is that the stage does not
   * know whether the presenter has moved, not that they have.
   */
  function relocationAnchorToken(): number | null {
    if (!manualScrollRelocated(scriptLayer?.alignmentGapPx() ?? null, vh)) return null;
    return scriptLayer?.readingAnchorToken() ?? null;
  }

  /**
   * The audio readout, drawn the same way in both modes.
   *
   * The TRACE is the half that keeps being argued about. Twice now something
   * has tried to retire it once the chain is proven: the optical work made
   * Clean Take collapse it to the mark, and control's own view faded the whole
   * pill a couple of seconds after it confirmed. Both were reasoning about the
   * same real cost — a waveform is continuous peripheral motion beside the
   * words somebody is reading — and both got the same thing wrong.
   *
   * "The microphone is being heard" is not a fact that stays true. It is a
   * claim about the last second, and whoever needs it is twenty minutes into a
   * take whose script has stopped moving, unable to tell whether that is them,
   * the microphone, or the aligner. An instrument that retires itself once
   * things are going well is an instrument that is never there for the only
   * question anybody asks it.
   *
   * The MARK does settle, and that is a different decision: see
   * `StageVoicePillReading`. A tick held for the length of a take is reporting
   * an event nobody can still act on.
   *
   * Control resolves the reading, the dock draws it, and the trace runs for the
   * whole take. There is exactly ONE thing left for this window to decide, and
   * it is below.
   *
   * -------------------------------------------------------------------------
   * THE ONE EXCEPTION: THE STAGE OWNS THE FRESHNESS OF WHAT REACHES IT
   * -------------------------------------------------------------------------
   * This was a plain alias, on the principle that control resolves every part
   * of the reading together so the mark and the waveform can never be from
   * different frames. That principle is right and is preserved: nothing here
   * edits a field of a payload control sent.
   *
   * But it answers the wrong question when control is the thing that broke. A
   * payload is a claim about the moment it was published, and once the watchdog
   * has proved nobody is publishing any more, the last one is not a reading —
   * it is a photograph of one. Left alone it draws a settled solid dot, which
   * is the mark this instrument uses to say "and it is still fine": the single
   * most reassuring thing on the glass, asserting the opposite of the truth, at
   * the exact moment the presenter is trying to work out why the script stopped.
   *
   * So control loss REPLACES the view wholesale rather than editing it. The
   * stored payload is untouched, so recovery is a matter of this derived
   * falling back to it.
   */
  const presenterVoicePill = $derived.by(() => {
    if (!controlLost) return voicePill;
    return {
      stageGeneration: voicePill?.stageGeneration ?? app.envelope?.stageGeneration ?? 0,
      /*
       * Carried from the last real payload rather than stamped with `now`.
       * It means "when control sent this", and control sent nothing: writing a
       * fresh timestamp would date a stage-authored view as though it had come
       * down the wire, which is the one claim this whole projection exists to
       * stop the readout making.
       */
      sentAtMs: voicePill?.sentAtMs ?? 0,
      /*
       * Synthesised even when no payload ever arrived. A take where control
       * died before its first pill frame is precisely the one where the dock
       * would otherwise show its placeholder — an empty slot, indistinguishable
       * from a take that simply has not started reporting yet.
       */
      reading: 'fault' as const,
      label: 'Control lost',
      visible: true,
      /*
       * The bars are cleared rather than frozen mid-trace. A waveform is the
       * one element here that means "this is happening now", and holding the
       * last few levels on the glass would keep drawing evidence of a
       * microphone nobody is listening to. Flat is the honest shape.
       */
      levels: [],
    } satisfies StageVoicePillPayload;
  });
</script>

<svelte:window onkeydown={onKeyDown} bind:innerWidth={windowVw} bind:innerHeight={windowVh} />

<!-- The stage is a non-interactive display surface: keyboard input is handled
     at the window level (§16.9), and the click handler only reports focus.
     A reading window is focusable by script only (-1, never in the tab order),
     so focus has somewhere to go when the suggestion that held it is removed. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions, a11y_no_noninteractive_tabindex -->
<div
  class="stage-root"
  role={embedded ? 'region' : undefined}
  aria-label={embedded
    ? readingWindow
      ? `Reading: ${embedded.scriptTitle?.trim() || 'script'}`
      : 'Teleprompter'
    : undefined}
  data-phase={phase}
  data-pointer-hidden={cursorHidden}
  data-theme={stageTheme}
  data-text-intensity={settings?.textIntensity ?? 'standard'}
  tabindex={readingWindow ? -1 : undefined}
  bind:this={stageRootEl}
  bind:clientWidth={measuredVw}
  bind:clientHeight={measuredVh}
  style:--stage-secondary-min={secondaryMinCss}
  onpointermove={onPointerMove}
  onclick={onClick}
  onwheel={onWheel}
>
  <div class="stage-position-plane">
    <!--
      THE TALENT PLANE. Everything below here is read through the glass, so
      everything below here receives the corrective flip exactly once.
    -->
    <div
      class="stage-talent-plane"
      data-mirror-x={settings?.mirrorX ? 'true' : 'false'}
      data-mirror-y={settings?.mirrorY ? 'true' : 'false'}
    >
      <!-- Layers 4–6: compiled document, band treatment, reading cue, fades. -->
      {#if doc && settings && fontsSettled}
        <div class="script-holder" class:blanked={scriptHidden}>
          <ScriptLayer
            bind:this={scriptLayer}
            {doc}
            {settings}
            alignment={app.alignment}
            frozen={motionFrozen}
            followPaused={followPaused || readerTakePaused}
            {reducedMotion}
            sessionId={app.envelope?.sessionId ?? ''}
            sessionGeneration={app.envelope?.sessionGeneration ?? 0}
            stageGeneration={app.envelope?.stageGeneration ?? 0}
            scriptCompileHash={app.envelope?.sourceHash ?? ''}
            openingTokenIndex={app.envelope?.initialTokenIndex ?? 0}
            {followProfile}
            bottomInsetPx={0}
            cueHollow={holdStatus.rung !== 'none'}
            rehearsal={embedded?.practice ?? false}
            {autoScroll}
            onautoscrollend={handleAutoScrollEnd}
            onlayoutready={handleLayoutReady}
            onlayoutmeasured={handleLayoutMeasured}
            onmotionack={handleMotionAck}
            onlayoutgeneration={(generation) => (layoutGeneration = generation)}
            onlayouterror={handleLayoutError}
            ondegraded={(degraded) => (motionDegraded = degraded)}
            onplacedchange={(placed) => (scriptPlaced = placed)}
          />
        </div>
      {/if}

      <!--
        The plate the take opens behind.

        One uninterrupted surface from the moment the stage comes up until the
        reading composition is on the glass in the position it will stay in —
        handshake, the envelope arriving, the bounded font wait, the line map
        being measured, the plant reaching the opening. It used to cover only
        the first of those, and the rest of the interval was answered by
        painting the script at scroll zero and moving it a second later.

        A later sibling of `.script-holder` so it covers the script, and an
        earlier one than the safe plane, the calibration card and the operator
        plane so all of those still cover IT: a card you calibrate against and
        the only button that ends a take must not be behind a plate.
      -->
      {#if openingPlateMounted}
        <div
          class="waiting"
          class:lifted={scriptPlaced}
          class:blanked={scriptHidden}
          aria-hidden="true"
        >
          Speaking Glass
        </div>
      {/if}

      <!--
        Presenter-facing overlays, inside the SAFE RECTANGLE.

        Not against the raw viewport: a hood crops the panel, and a chip pinned
        24px from the window's corner on a hooded rig sits under the bezel. Every
        one of these is a short string somebody has to read at a glance, so the
        one that gets cropped is the one that mattered.
      -->
      <div
        class="stage-safe-plane"
        style:top="{safeInsets.y}%"
        style:left="{safeInsets.x}%"
        style:width="{safeInsets.width}%"
        style:height="{safeInsets.height}%"
        style:--stage-hold-top={holdChipTop}
      >
        <!--
          Layer 7: transient command acknowledgement (§33.10).

          Always mounted, so its status region outlives each message. It stands
          down for a blank, and for the Escape prompt: that one is about how to
          stop a take, shares the top of the glass with it, and wins. On a
          rectangle too narrow for it and the hold chip side by side, a hold that
          is up wins too.
        -->
        <AckChip
          ack={stageAck}
          enabled={(settings?.stageAcknowledgements ?? true) &&
            !app.blanked &&
            !escapeHintVisible &&
            !(ackCrowded && holdStatus.rung !== 'none')}
          secondaryMinPx={settings?.optics?.secondaryMinPx ?? 0}
          topPx={ackTopPx}
          maxWidthPx={ackMaxWidthPx}
        />

        <!--
          The top rung of the hold ladder.

          Mirrored with everything else the presenter reads. It is words in the
          corner of a beamsplitter, which is precisely the case a flip destroys —
          and unlike the script there is no second copy of it anywhere.

          Shown in Clean Take as well as Diagnostic: a hold that has lasted
          three and a half seconds, and a named fault, are both things the
          presenter can act on. Everything the ladder withholds below that rung
          is withheld for the same reason.
        -->
        {#if !app.blanked}
          <HoldStatus
            rung={holdStatus.rung}
            message={holdStatus.message}
            tone={holdStatus.tone}
            glyph={holdStatus.glyph}
            hint={holdStatus.hint}
            secondaryMinPx={settings?.optics?.secondaryMinPx ?? 0}
            {reducedMotion}
            bind:heightPx={holdStatusHeightPx}
          />
        {/if}

        <!--
          Escape confirmation (§16.9).

          Inside the mirror plane, like everything else the presenter reads. It
          used to sit outside it, with a comment claiming that kept it legible
          through a horizontal mirror — which has it exactly backwards. The glass
          reflects this element and the script identically; leaving it out of the
          corrective flip is what makes it read backwards. It is six words about
          how to stop a take that is going wrong, so it is the last thing that
          can afford to arrive mirrored.

          Shown during a blank too — a blank is exactly when someone reaches for
          Escape.
        -->
        {#if escapeHintVisible}
          <div class="escape-hint" role="status" style:font-size="{overlayFontSizePx}px">
            Press Escape again to end
          </div>
        {/if}

        <!--
          THE WAY OUT AND THE AUDIO READOUT ARE NOT HERE ANY MORE.

          Both moved into the session dock, in the unmirrored operator plane at
          the bottom of this file. The exit button had to move: a CSS transform
          carries hit-testing with it, so a mirrored button is clickable where it
          appears — but it appears on the opposite side of the screen the moment
          somebody turns mirroring on, which is not a property a mouse target
          may have. The audio readout followed it because the one part of it the
          presenter has to READ is the fault name, and that already reaches the
          glass, mirrored and in presenter-sized type, through the hold chip
          above.
        -->
      </div>

      <!--
        Calibration (§17.2), mirrored with the content it is aligned against.

        Full-bleed rather than inside the safe plane, deliberately: the safe-area
        card IS the control that sets those insets, and drawing it inside them
        would make the frame chase itself. The crosshair is likewise positioned
        in raw viewport fractions, because the lens is somewhere on the PANEL.
      -->
      {#if app.calibration.active && !app.blanked}
        {#if app.calibration.mode === 'crosshair'}
          <div
            class="crosshair"
            style:left="{app.calibration.crosshairX * 100}%"
            style:top="{app.calibration.crosshairY * 100}%"
            aria-hidden="true"
          >
            <span class="ch-h"></span>
            <span class="ch-v"></span>
            <span class="ch-ring"></span>
          </div>
        {:else}
          <CalibrationCard
            mode={app.calibration.mode}
            insets={app.calibration.safeArea}
            barLengthPx={app.calibration.rulerLengthPx}
            fontSizePx={app.calibration.sampleFontSizePx}
            columnCh={app.calibration.sampleColumnCh}
            fontWeight={settings?.optics?.fontWeight ?? settings?.fontWeight ?? 500}
            fontFamilyId={settings?.fontFamilyId ?? 'high-legibility'}
            labelSizePx={settings?.optics?.secondaryMinPx ?? 20}
          />
          {#if app.calibration.mode === 'type-sample' && app.calibration.sampleLabel.length > 0}
            <!-- What the size being judged is CALLED. The card draws the
                 passage; the name of the step belongs to whoever is stepping
                 through it, and without this the operator is comparing
                 unlabelled samples. -->
            <div class="sample-label" style:font-size="{overlayFontSizePx}px">
              {app.calibration.sampleLabel}
            </div>
          {/if}
        {/if}
      {/if}
    </div>
  </div>

  <!--
    THE OPERATOR PLANE. Unmirrored, and diagnostics only.

    This is the one plane a beamsplitter argument does NOT apply to, because
    nothing here is read through the glass: it is for somebody standing at the
    rig looking straight at the panel. Anything a presenter has to read has no
    business here — an unmirrored element is the one thing that is guaranteed to
    be unreadable in the reflection.
  -->
  <div class="stage-operator-plane">
    <!--
      Layer 9: the transcript bar, in Diagnostic Take only.

      It stays here rather than moving into the talent plane because it is not
      addressed to the presenter: it is the raw recogniser text, upstream of
      every judgement the app makes, and its value is being true when the things
      that ARE addressed to the presenter are wrong. A person debugging a rig
      reads it off the panel directly.

      And it is diagnostic-only for a reason a take makes obvious: a full-width
      strip of changing text along the bottom edge is continuous motion in the
      one place the presenter's peripheral vision is already busy holding the
      reading line.

      It rides `showDiagnostics` rather than the mode alone, like the readout
      above it. The bar is the one thing that tells "the microphone was never
      captured" apart from "the recogniser heard nothing" apart from "the
      aligner would not match", and an operator asking for the instruments
      mid-take is asking for the one that answers that question too.
    -->
    <!--
      The operator's own safe rectangle.

      The same inset the presenter's overlays use, for the same reason: a hood
      crops the panel, and a dock 20px from the window's corner on a hooded rig
      is a dock under the bezel. Unmirrored, because everything inside it is
      read by somebody standing at the rig looking straight at the glass — and,
      for the dock, operated by them with a mouse.
    -->
    <div
      class="stage-operator-safe"
      style:top="{safeInsets.y}%"
      style:left="{safeInsets.x}%"
      style:width="{safeInsets.width}%"
      style:height="{safeInsets.height}%"
      style:--stage-popover-max-height={dockPopoverMaxPx === null
        ? null
        : `${dockPopoverMaxPx}px`}
    >
      <!-- Layer 8: the diagnostics readout. Diagnostic Take, or an explicit
           request from the operator mid-take. -->
      {#if showDiagnostics}
        <div class="diagnostics">
          <div>phase: {phase}</div>
          <div>gen: {app.envelope?.stageGeneration ?? '—'}</div>
          <div>tracking rev: {app.lastTrackingRevision ?? '—'}</div>
          <div>
            token: {app.alignment ? app.alignment.confirmedToken.toFixed(1) : '—'}
            ({app.alignment?.state ?? 'n/a'})
          </div>
          <!--
            The alignment feed, which is the first question to ask of a stage that
            is not following and the one the instruments could not previously
            answer. Three distinguishable readings:

              feed: 0 arrived            — nothing is reaching this window
              feed: 12 arrived, no layer — arriving before there was a receiver
              feed: 12 ok / 9 dropped …  — arriving and being thrown away, with why

            The third is the one worth the line: `session_generation` means the
            take and the envelope disagree about which session this is, `malformed`
            names the offending field, and `stale` means seq is not advancing.
          -->
          <div class:diag-fault={alignmentArrived > 0 && (alignmentFeed?.accepted ?? 0) === 0}>
            feed:
            {#if alignmentArrived === 0}
              0 arrived
            {:else if alignmentFeed === null}
              <!--
                Phrased as history, not as a current state. This branch only means
                no snapshot has yet been sampled from a mounted ScriptLayer — the
                layer is gated on the fonts settling, so early snapshots can land
                before there is a receiver. Saying "no layer" would claim the
                layer is absent NOW, which this cannot know and which stops being
                true the moment the next snapshot arrives.
              -->
              {alignmentArrived} arrived, none reached the script layer
            {:else}
              {alignmentFeed.accepted} ok / {alignmentFeed.rejected} dropped
              {#if alignmentFeed.rejected > 0 && alignmentFeed.reason !== null}
                ({alignmentFeed.reason}{alignmentFeed.reason === 'malformed' && alignmentFeed.field
                  ? `: ${alignmentFeed.field}`
                  : ''})
              {/if}
            {/if}
          </div>
          <!-- Control emits these; Rust emits the snapshots. If this stays 0
               while the summary reports taps sent, the control -> stage channel
               is the fault and the snapshots are arriving by a different road. -->
          <div class:diag-fault={transcriptTapsArrived === 0 && alignmentArrived > 0}>
            taps: {transcriptTapsArrived} arrived
          </div>
          <div>viewport: {vw}×{vh}</div>
          {#if budget}
            <!-- The number that used to be a `compact` flag, said properly: what
                 the presenter can actually see. Short is worth knowing about
                 BEFORE a take, which is why it is stated rather than corrected. -->
            <div>
              lines: {budget.above}↑ / {budget.below}↓ ({budget.total}){budget.sufficient
                ? ''
                : ' SHORT'}
            </div>
          {/if}
          {#if settings?.optics}
            <!--
              What the optical model concluded about this rig, on the rig.

              The same sentence reaches the operator in Settings as a warning, but
              that is the control window on a different desk. When somebody is
              standing at the glass wondering why the type is the size it is, the
              answer belongs where they are — and a verdict of `width_limited` on
              a 9-inch panel is the expected answer, not a fault, so it is stated
              plainly rather than styled as one.
            -->
            <div>fit: {settings.optics.fitVerdict}</div>
            {#if settings.optics.fitAdvice}
              <div class="diag-advice">{settings.optics.fitAdvice}</div>
            {/if}
          {/if}
          {#if layoutMeasurement}
            <!-- What the stage measured off the face it is drawing, which is the
                 only place those numbers exist: control resolves geometry against
                 DIN fallbacks because control does not render the font. -->
            <div>
              pitch: {layoutMeasurement.linePitchPx.toFixed(1)}px{layoutMeasurement.linePitchMeasured
                ? ''
                : ' (est)'}
            </div>
            <div>
              cap/em: {layoutMeasurement.fontMetrics.capHeightRatio.toFixed(3)}{layoutMeasurement
                .fontMetrics.measured
                ? ''
                : ' (est)'}
            </div>
            <div>chars/line: {layoutMeasurement.charactersPerLine ?? '—'}</div>
          {/if}
          <div>fonts: {fontsResolved ? 'resolved' : 'timed out'}</div>
          <div>layout gen: {layoutGeneration}</div>
          {#if layoutIssues.length > 0}
            <div>layout: HELD ({layoutIssues.join(', ')})</div>
          {/if}
          <div>profile: {followProfile.id} (v{followProfile.version})</div>
          <div>frames: {motionDegraded ? 'degraded' : 'ok'}</div>
          <div>media: {mediaHealthy ? 'healthy' : 'degraded'}</div>
        </div>
      {/if}

      <!--
        The raw transcript, in Diagnostic Take only.

        -------------------------------------------------------------------
        IT USED TO RUN IN CLEAN TAKE TOO, AND THE ARGUMENT FOR THAT HAS BEEN
        ANSWERED RATHER THAN OVERRULED
        -------------------------------------------------------------------
        The case for showing it always was that three unrelated faults look
        identical from the stage — a script that has stopped moving — and only
        this bar separated "the microphone was never captured" and "the
        recogniser heard nothing" from "the aligner would not match".

        Every one of those now has a first-class reading somewhere the presenter
        is already looking. A dead input or a dead socket resolves to a named
        fault on the audio readout AND, through `resolveHoldStatus`, to that
        same sentence in the mirrored hold chip; several seconds of speech with
        nothing coming back is `not_heard`, which reads "Not hearing you"; and
        an aligner that will not match is the hold ladder's own "Holding here".
        The distinction survives without a strip of small changing text beside
        an animated waveform, which is what made the finished surface read as a
        development HUD.

        Aligned to the dock's left edge and sitting directly above it, so the
        two instruments read as one column instead of as two corners — which is
        exactly what they were before, in different planes, parting company
        whenever anybody turned mirroring on.
      -->
      {#if showDiagnostics && app.envelope !== null && !app.blanked && !dockPopoverOpen}
        <div class="transcript-tap" class:silent={transcriptWords.length === 0}>
          <span class="transcript-tap-words">
            {transcriptWords.length > 0 ? transcriptWords : 'listening — no words yet'}
          </span>
        </div>
      {/if}

      <!--
        The session dock: adjustments, audio, end.

        STILL THERE DURING A BLANK, WITH NOTHING ON SHOW.

        A blank is a deliberate "show nothing", so the audio readout is
        withheld (`readout`) and the buttons stay faded until somebody moves the
        pointer. What a blank may not do is take the way out with it: a black
        full-screen window that answers the mouse with nothing is the exact
        "looks like it has hung" state the dock exists to prevent, and in the
        standalone stage window there is no host drawer to fall back on. Escape
        still works, as ever.

        The audio readout inside it is gated on the ENVELOPE ALONE, not on
        `phase === 'live'` and not on the handshake having finished. That is the
        whole point of it: `live` is only reached when an alignment snapshot
        arrives, alignment snapshots are made from transcript frames, and a take
        that transcribes nothing therefore never leaves `ready`. Gating it on
        the take being under way hid the indicator during precisely the failure
        it exists to explain.
      -->
      {#if readingWindow}
        <p class="stage-announcer" aria-live="polite">{suggestionAnnouncement}</p>
      {/if}
      {#if !app.blanked && suggestionDescription}
        <SuggestionChip
          description={suggestionDescription}
          fontSizePx={overlayFontSizePx}
          readingLine={suggestionReadingLine}
          areaWidthPx={(safeInsets.width / 100) * vw}
          dockRowWidthPx={dockRowWidthPx}
          holdHeightPx={holdStatusHeightPx}
          areaHeightPx={(safeInsets.height / 100) * vh}
          stale={suggestionStale}
          {reducedMotion}
          onread={acceptSuggestion}
          onignore={ignoreSuggestion}
          onengage={engageSuggestion}
          onopen={openSuggestion}
        />
      {/if}

      <StageDock
        pill={app.envelope !== null ? presenterVoicePill : null}
        readout={!app.blanked}
        revealed={dockVisible}
        {followPaused}
        onfollowtoggle={() => sendIntent({ kind: 'toggle_follow' })}
        presentationMode={embedded?.presentationMode ?? 'prompter'}
        onpresentationtoggle={embedded?.onpresentationtoggle}
        practice={embedded?.practice ?? false}
        appearancePanel={embedded?.appearancePanel ?? null}
        appearanceOpen={embedded?.appearanceOpen ?? false}
        onappearanceopen={() => embedded?.onappearanceopen?.()}
        onappearanceclose={() => embedded?.onappearanceclose?.()}
        onend={requestExit}
        onhold={(held) => (dockHeld = held)}
        onpopover={(open) => (dockPopoverOpen = open)}
        bind:rowWidthPx={dockRowWidthPx}
      />
    </div>

    {#if preview}
      <div class="preview-hud">
        preview · b blank · f freeze · o follow · m mirror · c calibrate · s
        clean/diagnostic · r cue · a ack · j jump · v voice pill
      </div>
    {/if}
  </div>
</div>

<style>
  .stage-announcer {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
  .stage-root {
    position: absolute;
    inset: 0;
    /* Focus lands here only when a stage control that held it goes away; it
       is a surface, not a control, and draws no ring. */
    outline: none;
    --stage-bg: #000000;
    --stage-text: #f5f3ef;
    --stage-text-past: rgba(245, 243, 239, 0.42);
    --stage-text-future: rgba(245, 243, 239, 0.86);
    --stage-accent: rgba(210, 205, 255, 0.2);
    --stage-cue: #d8b46a;
    /* See stage.css: a transient pill is a card over the script, not a hole in it. */
    --stage-overlay: rgb(14 16 20);
    --stage-secondary-min: 0.67em;

    /*
     * ONE GEOMETRY SYSTEM FOR EVERYTHING THAT SITS OVER THE SCRIPT.
     *
     * The overlays used to be inset by 18px, 24px, a spacing token and a
     * viewport fraction depending on which one you were looking at, with three
     * different radii and two background colours between them. None of those
     * differences meant anything; they were four people's idea of "a bit in
     * from the corner", and the result is a screen whose furniture does not
     * line up with itself — which is precisely what makes a display read as
     * assembled rather than designed.
     *
     * Declared here as well as in `stage.css` on purpose. `stage.css` is loaded
     * by the stage WINDOW; single-window presentation mounts this same
     * component inside the control window, which never loads it. A token that
     * lived only there would resolve to nothing in the one configuration the
     * product actually ships.
     */
    --stage-chrome-inset: 20px;
    --stage-chrome-bottom-inset: 16px;
    --stage-chrome-radius: 12px;
    --stage-chrome-border: rgba(255, 255, 255, 0.13);
    --stage-chrome-bg: rgba(12, 14, 18, 0.74);
    --stage-chrome-text: rgba(245, 243, 239, 0.88);
    /*
     * Against a true-black field a backdrop blur contributes almost nothing, so
     * the separation is carried by the border and a one-pixel inner highlight.
     * The drop shadow earns its place on the calibration overlays, which are the
     * only thing that can still be drawn under the dock now the Listener is gone.
     */
    --stage-chrome-shadow:
      0 10px 30px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.05);
    --stage-dim-1: 0.78;
    --stage-dim-2: 0.64;
    --stage-dim-3: 0.52;
    --stage-dim-4: var(--stage-past-opacity, 0.42);
    background: var(--stage-bg);
    color: var(--stage-text);
    overflow: hidden;
    overscroll-behavior: none;
    user-select: none;
    -webkit-user-select: none;
  }
  .stage-root[data-text-intensity='soft'] {
    --stage-text: rgba(245, 243, 239, 0.82);
    --stage-text-past: rgba(245, 243, 239, 0.34);
    --stage-text-future: rgba(245, 243, 239, 0.7);
  }
  .stage-root[data-text-intensity='strong'] {
    --stage-text: #fffefb;
    --stage-text-past: rgba(255, 254, 251, 0.5);
    --stage-text-future: rgba(255, 254, 251, 0.94);
  }

  /*
   * PAPER — A READING WINDOW ONLY.
   *
   * Dark type on a warm light field, for a window read at a desk, where the
   * reason the prompter is black (stray light on a beamsplitter, `stage.css`)
   * does not exist. `stageTheme` above only ever says `reader-paper` for a
   * reading window, so none of this can reach glass.
   *
   * A complete set of roles, not black swapped for cream: the same alpha does
   * not give the same contrast with dark ink on a light field. Past text is
   * floored at 0.72 by `buildStageSettings` (`PAPER_PAST_OPACITY`), and the
   * four-word ramp gets its own steps between that floor and full ink, so the
   * dim still grades rather than collapsing onto the floor. Every composed
   * reading state — each intensity, at full, upcoming, each ramp step and the
   * far past, under the Wash band and the phrase underlay, stage directions,
   * and an authored cue on its own chip — is held at 4.5:1 or better by
   * `tests/unit/control/reader-theme.test.ts`, which reads these values from
   * this block. (A cue or heading inside a PAST block or a stage direction is
   * the one state that does not reach it: about 3.3:1, against the dark
   * field's 2.6–2.8:1 for the same states. The block's own opacity sits over
   * the chip, and clay dark enough to clear it there stops reading as a cue.)
   *
   * The chrome is warm paper with a quiet border: no grey slab, no peach wash,
   * and the clay of the control palette for anything that has to read as the
   * app talking. The `--stage-dock-*`, `--stage-flag-*`, `--stage-danger-*`,
   * `--stage-wash-*` and remaining `--stage-chrome-*` roles have no dark
   * declaration on purpose: each is used with today's dark literal as its
   * `var()` fallback, so a dark stage resolves to exactly the colour it always
   * drew.
   *
   * Mirrored in `stage.css` for the separate stage window, as the tokens above
   * are.
   */
  .stage-root[data-theme='reader-paper'] {
    color-scheme: light;
    --stage-bg: #f6f2ea;
    --stage-text: #242424;
    --stage-text-past: rgba(36, 36, 36, 0.68);
    --stage-text-future: rgba(36, 36, 36, 0.86);
    /* The phrase underlay, in a warm neutral rather than the dark field's
       lavender. Still an underlay: the element runs it at 0.1. */
    --stage-accent: rgba(96, 84, 70, 0.3);
    /* A dark clay, dark enough to hold 4.5:1 on its own 12-14% chip in an
       upcoming block. The dark field's gold is about 1.7:1 on paper. */
    --stage-cue: #7a412e;
    --stage-overlay: rgba(232, 227, 219, 0.96);
    --stage-chrome-border: rgba(36, 30, 20, 0.14);
    --stage-chrome-bg: rgba(252, 250, 246, 0.88);
    --stage-chrome-text: rgba(36, 36, 36, 0.88);
    --stage-chrome-shadow:
      0 10px 30px rgba(24, 25, 29, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.6);
    --stage-dim-1: 0.92;
    --stage-dim-2: 0.84;
    --stage-dim-3: 0.77;
    /* Silent and stage-only material — see the rule below this block. */
    --stage-unspoken-opacity: 0.72;

    /* Roles whose dark value is the fallback at the point of use. */
    --stage-wash-clear: rgb(96 84 70 / 0%);
    --stage-wash: rgb(96 84 70 / 8%);
    --stage-reading-mark-opacity: 0.62;
    --stage-mark-ink: #f6f2ea;
    --stage-diag-fault: #a6342b;
    --stage-chrome-bg-solid: rgb(252 250 246 / 96%);
    --stage-chrome-bg-hover: rgb(241 237 230 / 94%);
    --stage-chrome-border-hover: rgb(36 30 20 / 30%);
    --stage-chrome-text-hover: #18191d;
    --stage-chrome-text-strong: #18191d;
    --stage-chrome-text-muted: rgb(36 36 36 / 68%);
    --stage-chrome-text-faint: rgb(36 36 36 / 52%);
    --stage-chrome-popover-bg: rgb(252 250 246 / 94%);
    --stage-chrome-popover-bg-solid: rgb(252 250 246 / 98%);
    /* Fully opaque, for when the system asks for no transparency at all. */
    --stage-chrome-bg-opaque: rgb(252 250 246);
    --stage-chrome-highlight: rgb(96 89 79);
    --stage-chrome-highlight-text: #fcfaf6;
    --stage-chrome-control-border: rgb(36 30 20 / 18%);
    --stage-chrome-control-bg: rgb(36 30 20 / 4%);
    --stage-chrome-control-hover: rgb(36 30 20 / 6%);
    /* The workspace clay, for the one action a reading window ever offers. */
    --stage-action-bg: #b35a38;
    --stage-action-bg-hover: #9c4a2c;
    --stage-action-text: #ffffff;
    --stage-focus-ring: rgb(36 36 36 / 70%);
    --stage-dock-icon: rgb(36 36 36 / 72%);
    --stage-dock-end: rgb(36 36 36 / 70%);
    --stage-flag: #7a5310;
    --stage-flag-hover: #5f400b;
    --stage-flag-bg: rgb(154 103 22 / 10%);
    --stage-flag-bg-hover: rgb(154 103 22 / 16%);
    --stage-flag-border: rgb(154 103 22 / 38%);
    --stage-flag-border-hover: rgb(154 103 22 / 52%);
    --stage-flag-ring: rgb(252 250 246 / 92%);
    --stage-danger: #a6342b;
    --stage-danger-bg: rgb(185 65 56 / 10%);
    --stage-danger-border: rgb(166 52 43 / 38%);
    --stage-danger-strong-bg: rgb(185 65 56 / 12%);
    --stage-danger-strong-bg-hover: rgb(185 65 56 / 20%);
    --stage-danger-strong-border: rgb(166 52 43 / 55%);
    --stage-danger-text: #8e2922;
    --stage-danger-text-hover: #7a211b;
  }
  /* Intensity on paper moves the INK, opaque, rather than fading it: an alpha
     on dark ink would stack with every past/ramp opacity below it. */
  .stage-root[data-theme='reader-paper'][data-text-intensity='soft'] {
    --stage-text: #33312e;
    --stage-text-past: rgba(51, 49, 46, 0.7);
    --stage-text-future: rgba(51, 49, 46, 0.86);
  }
  .stage-root[data-theme='reader-paper'][data-text-intensity='strong'] {
    --stage-text: #141414;
    --stage-text-past: rgba(20, 20, 20, 0.66);
    --stage-text-future: rgba(20, 20, 20, 0.94);
  }
  /*
   * Stage directions on paper.
   *
   * The renderer draws silent and stage-only blocks at a flat 0.45 opacity —
   * about 4:1 for warm white on black, and about 2.7:1 for dark ink on paper,
   * which is a direction somebody has to act on gone too faint to read. It is
   * a literal in the block renderer rather than a role, so the paper field
   * overrides it here, by class, and only on paper: a dark stage never matches
   * this selector and keeps its 0.45 exactly.
   */
  .stage-root[data-theme='reader-paper'] :global(.unspoken) {
    opacity: var(--stage-unspoken-opacity, 0.72);
  }
  .stage-root[data-pointer-hidden='true'] {
    cursor: none;
  }

  .stage-position-plane,
  .stage-talent-plane,
  .stage-operator-plane {
    position: absolute;
    inset: 0;
  }

  /* The operator plane is a stack of readouts, never a target: it sits over the
     talent plane and must not intercept a click meant for the window. */
  .stage-operator-plane {
    pointer-events: none;
  }

  /* Mirror transforms live alone on the talent plane (§16.7). */
  .stage-talent-plane[data-mirror-x='true'] {
    transform: scaleX(-1);
  }
  .stage-talent-plane[data-mirror-y='true'] {
    transform: scaleY(-1);
  }
  .stage-talent-plane[data-mirror-x='true'][data-mirror-y='true'] {
    transform: scale(-1, -1);
  }

  /* The part of the panel the presenter can actually see through the hood.
     Overlays are positioned against THIS, not against the window. */
  .stage-safe-plane {
    position: absolute;
    pointer-events: none;
  }

  .script-holder {
    position: absolute;
    inset: 0;
  }
  /* Blank stage (§16.6): instant and local — visibility, not unmount, so
     session state and measurements survive. */
  .script-holder.blanked {
    visibility: hidden;
  }

  /*
   * The opening plate. Full-bleed and OPAQUE — unlike the transparent wordmark
   * this grew out of — because the reveal is a crossfade: the script layer
   * becomes visible underneath, then this clears off it. With nothing of its
   * own to fade there is nothing to cross and the script simply appears.
   *
   * The field is `--stage-bg`, the same black `.stage-root` paints, so the
   * plate is invisible as a surface and only its wordmark reads.
   *
   * `pointer-events: none` is load-bearing rather than tidy: this covers the
   * whole stage, and the dock's End button is one of only two ways out of a
   * take.
   */
  .waiting {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: var(--stage-bg);
    color: var(--stage-text-past);
    font-size: var(--text-lg);
    letter-spacing: var(--ls-caps);
    text-transform: uppercase;
    pointer-events: none;
    transition: opacity var(--dur-slow, 200ms) var(--ease-out, ease-out);
  }

  .waiting.lifted {
    opacity: 0;
  }

  /*
   * Blank stage (§16.6) reaches this too, and has to.
   *
   * The plate is a SIBLING of `.script-holder`, so it is outside the subtree
   * that rule hides. An opening blanked by the operator would otherwise show a
   * wordmark on glass that control is reporting as blank — which makes the
   * report a lie rather than merely looking odd.
   */
  .waiting.blanked {
    visibility: hidden;
  }

  @media (prefers-reduced-motion: reduce) {
    .waiting {
      transition: none;
    }
  }

  /*
   * Escape confirmation. Top centre, clear of the reading band and of the
   * reserved strip at the bottom of the glass — a prompt about stopping must
   * not sit on top of the words the presenter is still speaking.
   *
   * The type size arrives inline, from the optical profile (`overlayFontSizePx`).
   * It was `clamp(15px, 1.6vw, 22px)`, which is the exact rule `AckChip` records
   * having removed for being a control-window size: the window's width is not
   * how far away the presenter is standing, and 22px through glass at 1.5 m is
   * the upper bound on legible rather than a comfortable maximum. These are six
   * words about how to stop a take that is going wrong, which makes them the
   * last thing on the stage that can afford to be sized by a viewport fraction.
   */
  .escape-hint {
    position: absolute;
    top: 4vh;
    left: 50%;
    transform: translateX(-50%);
    padding: 0.5em 1.1em;
    border-radius: 999px;
    border: 1px solid var(--stage-chrome-border);
    background: var(--stage-overlay);
    color: var(--stage-text);
    font-weight: 550;
    white-space: nowrap;
    pointer-events: none;
  }

  /*
   * The operator's safe rectangle.
   *
   * `pointer-events: none` like the presenter's, and for the same reason: a
   * stray click over a diagnostic must land on the stage root and report focus
   * rather than being swallowed by decoration. The dock re-enables it for
   * itself, which is the only thing in either plane that takes a click.
   */
  .stage-operator-safe {
    position: absolute;
    pointer-events: none;
  }

  /*
   * The name of the type sample being judged.
   *
   * Sized at the secondary floor like every other presenter-readable label, and
   * placed at the top of the card where the sample's own passage is not.
   *
   * The floor arrives inline (`overlayFontSizePx`) rather than through
   * `var(--stage-secondary-min, 0.67em)`. That property is only bound when an
   * optical profile exists, and this label is drawn during CALIBRATION — which
   * is, by definition, the moment before there is one. It was resolving to the
   * em fallback, at roughly 11px, on the one surface whose entire job is to let
   * somebody judge type sizes from where they will be standing.
   */
  .sample-label {
    position: absolute;
    top: 4%;
    left: 50%;
    transform: translateX(-50%);
    padding: 0.3em 0.9em;
    border-radius: var(--radius-pill, 999px);
    border: 1px solid var(--stage-chrome-border);
    background: var(--stage-overlay);
    color: var(--stage-text);
    font-weight: 650;
    letter-spacing: 0.06em;
    white-space: nowrap;
    pointer-events: none;
  }

  /* High-contrast calibration crosshair (§17.2). */
  .crosshair {
    position: absolute;
    width: 0;
    height: 0;
    pointer-events: none;
  }
  .crosshair .ch-h,
  .crosshair .ch-v {
    position: absolute;
    background: #ffffff;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.9);
  }
  .crosshair .ch-h {
    left: -60px;
    right: -60px;
    top: -1px;
    height: 2px;
    width: 120px;
  }
  .crosshair .ch-v {
    top: -60px;
    left: -1px;
    width: 2px;
    height: 120px;
  }
  .crosshair .ch-ring {
    position: absolute;
    left: -14px;
    top: -14px;
    width: 28px;
    height: 28px;
    border: 2px solid #ffffff;
    border-radius: 50%;
    box-shadow:
      0 0 0 1px rgba(0, 0, 0, 0.9),
      inset 0 0 0 1px rgba(0, 0, 0, 0.9);
  }

  /* The one multi-line entry in a panel of single-line readouts. */
  .diag-advice {
    max-width: 34ch;
    white-space: normal;
    opacity: 0.8;
  }

  /*
   * The one diagnostic line that is allowed to shout. Snapshots arriving and
   * none of them being accepted is not a degraded reading, it is the take not
   * working — and the readout is scanned in a dark room at a glance.
   */
  .diag-fault {
    color: var(--stage-diag-fault, #ffb4a2);
    font-weight: 600;
  }

  .diagnostics {
    position: absolute;
    /*
     * The one thing left in the top-right corner, and only in Diagnostic Take.
     * Same inset and radius as everything else that floats over the script.
     *
     * The inset was always right; what was wrong was what it was measured FROM.
     * This block sat as a direct child of the full-bleed operator plane, so
     * these offsets ran from the raw window corner while the dock beside it —
     * the other thing in this plane — was inset from the operator's safe
     * rectangle. On a hooded rig that is the difference between a readout you
     * can see and one under the bezel, and a readout nobody can see is the
     * whole point of a diagnostic thrown away. It is now a child of
     * `.stage-operator-safe`, like the dock, so the two agree about where the
     * panel's usable corner is.
     */
    top: var(--stage-chrome-inset);
    right: var(--stage-chrome-inset);
    padding: 10px 12px;
    border: 1px solid var(--stage-chrome-border);
    border-radius: var(--stage-chrome-radius);
    background: var(--stage-chrome-bg);
    color: var(--stage-text);
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 12px;
    line-height: 1.6;
    pointer-events: none;
  }

  /*
   * One line directly above the dock, newest word at the right.
   *
   * ------------------------------------------------------------------------
   * IT USED TO RUN THE WHOLE WIDTH OF THE PANEL, AND THEN IT USED TO SIT IN A
   * DIFFERENT CORNER FROM THE INSTRUMENT IT BELONGS WITH
   * ------------------------------------------------------------------------
   * First it was `left: 0; right: 0` with a gradient behind it, holding
   * everything the recogniser had said since its last finalisation — the widest
   * element on the glass, a strip of moving text under a script somebody is
   * reading.
   *
   * Then it was a bounded box in the bottom RIGHT, lined up with a voice pill
   * that lived in the mirrored plane. The old comment here was careful to say
   * that the alignment was a convenience of the common rig rather than a
   * relationship the code maintained — under `mirrorX` the two were in opposite
   * physical corners, and under a hood their right margins were measured from
   * different edges. That was an honest description of a defect.
   *
   * Both instruments are now in the same plane, in the same safe rectangle, on
   * the same left edge, so the alignment IS a relationship the code maintains.
   *
   * The width cap and the ten-word crop in `transcript-tail.ts` still do
   * different halves of one job: ten long words are still wide, and a box with
   * no word limit fills with whatever fits rather than with what was just said.
   * Right-aligned with `overflow: hidden`, so on the rare tail that is wider
   * than the cap the oldest words fall off the left edge rather than pushing
   * the newest ones out of view. No animation, no measurement, nothing that can
   * drift out of step with the words themselves. Small and dim so it reads as
   * an instrument, but a monospace face so a word appearing is unmistakable in
   * peripheral vision.
   */
  .transcript-tap {
    position: absolute;
    /* The dock's own left edge and its height plus the popover gap, so the two
       read as one column rather than as two boxes that nearly line up. */
    left: var(--stage-chrome-inset);
    bottom: calc(var(--stage-chrome-bottom-inset) + 40px + 8px);
    /* Never more than a corner's worth of glass. The `ch` term is what the
       text actually needs at this size; the viewport term is what keeps a
       narrow panel from handing most of its width to a diagnostic. */
    max-width: min(40ch, 35vw);
    padding: 4px 10px;
    border: 1px solid var(--stage-chrome-border);
    border-radius: var(--stage-chrome-radius);
    display: flex;
    justify-content: flex-end;
    overflow: hidden;
    white-space: nowrap;
    pointer-events: none;
    background: var(--stage-chrome-bg);
    font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace;
    font-size: 13px;
    line-height: 1.4;
    letter-spacing: 0.01em;
    color: var(--stage-text-past);
    opacity: 0.75;
  }

  /* Nothing heard yet is a state worth showing, not an empty bar. */
  .transcript-tap.silent {
    opacity: 0.4;
    font-style: italic;
  }

  .transcript-tap-words {
    /* Never wrap to a second line: the bar must not change the stage layout. */
    white-space: nowrap;
    direction: ltr;
  }

  /*
   * The preview key legend, in the one corner nothing claims.
   *
   * Bottom-LEFT was the dock's corner, and a centred strip along the bottom put
   * two lines of grey text straight through the script. Centred at the TOP was
   * no better: the escape confirmation sits at 4vh and the diagnostics panel
   * owns the top-right, so a full-width legend crossed both. Bottom-right is
   * empty in every mode now that the audio readout has moved, and this is
   * preview-only chrome that no take ever sees.
   */
  .preview-hud {
    position: absolute;
    bottom: var(--stage-chrome-bottom-inset);
    right: var(--stage-chrome-inset);
    max-width: calc(100% - 2 * var(--stage-chrome-inset));
    padding: 3px 10px;
    border-radius: var(--stage-chrome-radius);
    background: var(--stage-chrome-bg);
    color: var(--stage-text-past);
    font-size: 11px;
    letter-spacing: 0.03em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    pointer-events: none;
  }
</style>
