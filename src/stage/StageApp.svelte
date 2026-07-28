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
                       hold status, voice pill, escape confirmation, calibration
                       cards. Presenter-facing overlays sit one level further in,
                       inside the safe rectangle, because a hood crops the panel
                       and a chip against the raw viewport lands under the bezel.

    the OPERATOR plane is unmirrored, and holds ONLY diagnostics — read by
                       somebody standing at the rig looking directly at the
                       panel, never through the glass.

  Layers, back to front: solid background → Listener video + treatment → script
  text + focus fades → reading cue → presenter overlays → calibration →
  operator diagnostics.

  All data arrives via Tauri events (the stage holds only event:listen);
  outbound traffic is intents/acks that control is free to ignore.
-->
<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import {
    ESCAPE_DOUBLE_PRESS_MS,
    STAGE_EVENT,
    STAGE_HEARTBEAT_GRACE_MS,
    type StageEscapePayload,
    type StageHeartbeatAckPayload,
    type StageHeartbeatPayload,
    type StageTranscriptTapPayload,
    type StageHydratedPayload,
    type StageIntent,
    type StageIntentPayload,
    type StageLayoutErrorPayload,
    type StageListeningPayload,
    type StageListenerHealthPayload,
    STAGE_VOICE_PILL_TRACE_SAMPLES,
    type StageVoicePillPayload,
    type StageVoicePillReading,
    type StageMotionAck,
    type StageMotionAckPayload,
    type StageReadyPayload,
    type StageSnapshotPayload,
    type StageStatePayload,
    type StageAlignmentPayload,
  } from '../shared/contracts';
  import { subscribeStageEvent, emitStageEvent, isTauri, type Unsubscribe } from './events';
  import {
    initialStageState,
    stageReducer,
    displayPhase,
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
  import AckChip from './renderer/AckChip.svelte';
  import HoldStatus from './renderer/HoldStatus.svelte';
  import CalibrationCard from './renderer/CalibrationCard.svelte';
  import VoicePill from './VoicePill.svelte';
  import ListenerLayer from './listener/ListenerLayer.svelte';
  import {
    resolveHoldStatus,
    type HoldRung,
    type HoldStatus as HoldStatusReading,
    type HoldTone,
  } from './renderer/hold-status';
  import { startFixtureReplay, startPreviewDriver, type PreviewDriver } from './preview';

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
  let previewDriver: PreviewDriver | null = null;

  const phase = $derived(displayPhase(app));
  const settings = $derived(app.settings);
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
      ...(optics ? { linePitchPx, deadZoneLines: optics.deadZoneLines, safeRect } : {}),
    });
    return lineBudget({
      safeRect,
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

  const reducedMotion = $derived(
    (settings?.reducedMotion ?? false) ||
      (typeof window !== 'undefined' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches),
  );
  const motionFrozen = $derived(app.frozen);
  const scriptHidden = $derived(app.blanked);
  const listenerHidden = $derived(app.blanked && !app.keepListenerWhenBlanked);
  let mediaHealthy = $state(true);
  let lastInboundAt = 0;
  /**
   * The last words the recogniser returned, shown along the bottom.
   *
   * Three faults look identical from the stage — a script that has stopped
   * moving: the microphone was never captured, the recogniser heard nothing,
   * or the aligner failed to match good text. This bar tells them apart at a
   * glance. One of them turned out to be another application holding the
   * microphone, which CandidCue cannot prevent and could not report.
   */
  let transcriptTap = $state('');
  /**
   * The voice pill, or null until control has said anything about the input.
   *
   * Held as the whole payload rather than unpacked into fields because it is a
   * resolved view: control decided every part of it together, and splitting it
   * would let the mark and the waveform be from different frames.
   */
  let voicePill = $state<StageVoicePillPayload | null>(null);

  /* ---------------------------------------------------------------------
   * The hold ladder (renderer/hold-status.ts)
   *
   * The engine holds constantly and correctly — through a breath, a swallowed
   * word, the 1.2-1.7 s gap between transcript finals — so a stage that
   * announced every hold would put a status message on the glass several times
   * a minute during a take that is going perfectly. The ladder waits, then says
   * something wordless, then says a sentence.
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

  let holdStatus = $state<HoldStatusReading>({ rung: 'none', message: null, tone: 'neutral' });
  /** When the alignment state last left `following`; null while it is following. */
  let holdSinceMs: number | null = null;
  /* The resolved ladder, mirrored in plain locals. `resolveHoldStatus` needs the
   * previous rung to make its thresholds hysteretic, and reading it back off
   * `holdStatus` inside the effect that writes it would make the effect depend
   * on its own output. */
  let ladderRung: HoldRung | null = null;
  let ladderMessage: string | null = null;
  let ladderTone: HoldTone = 'neutral';

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
        hasFault: voiceFaultLabel !== null,
        faultLabel: voiceFaultLabel,
      },
      ladderRung,
    );
    if (next.rung === ladderRung && next.message === ladderMessage && next.tone === ladderTone) {
      return;
    }
    ladderRung = next.rung;
    ladderMessage = next.message;
    ladderTone = next.tone;
    holdStatus = next;
  }

  $effect(() => {
    // Resolve on every change of the two inputs, and keep a slow clock running
    // while the display is held — a rung is earned by DURATION, and no new
    // snapshot arrives to prompt the crossing.
    const holding = alignmentState !== null && alignmentState !== 'following';
    void voiceFaultLabel;
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
   * own styling cadence and motion limits off; this is the flag the LAYERS need
   * — nonessential effects in the script layer (which owns its own) and the
   * Listener's crossfade, which is the one §61 names explicitly (step 3).
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

  /* ---- inbound events ---- */
  onMount(() => {
    const unsubs: Unsubscribe[] = [];
    let disposed = false;

    const onDirective = (payload: StageStatePayload) => {
      lastInboundAt = performance.now();
      dispatch({
        type: 'directive',
        stageGeneration: payload.stageGeneration,
        directive: payload.directive,
      });
    };

    void (async () => {
      const subs = await Promise.all([
        subscribeStageEvent<StageSnapshotPayload>(STAGE_EVENT.loadSession, (envelope) => {
          lastInboundAt = performance.now();
          dispatch({ type: 'snapshot', envelope });
          // Handshake step 1 (§43.3): confirm hydration to Rust.
          emitStageEvent<StageHydratedPayload>(STAGE_EVENT.hydrated, {
            stageGeneration: envelope.stageGeneration,
            sessionId: envelope.sessionId,
          });
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
          (snapshot) => {
            lastInboundAt = performance.now();
            /*
             * The push's answer is RECORDED, not discarded.
             *
             * A stage that is receiving snapshots and rejecting every one of
             * them looks, on the glass, exactly like a stage that is receiving
             * none: the document sits still. The two have nothing in common
             * underneath — one is a delivery failure, the other a generation or
             * contract mismatch — and the only place the difference exists is
             * the receiver's own counters. Reading them here costs one property
             * access a second and is the difference between diagnosing this from
             * a take and guessing at it from a description.
             *
             * `arrived` counts what the window was handed, which is the other
             * half: with no ScriptLayer mounted yet there is no receiver to
             * reject anything, and "nothing arrived" and "nothing was mounted to
             * receive it" are again the same picture and different faults.
             */
            alignmentArrived += 1;
            const accepted = scriptLayer?.pushAlignmentSnapshot(snapshot) ?? false;
            /*
             * Copied, not aliased. `alignmentFeedStats()` hands back the
             * receiver's own live object, so assigning it would store the same
             * reference every time — the counters would climb inside a value
             * `$state` has no reason to believe ever changed, and the readout
             * would sit on its first reading for the whole take.
             */
            const stats = scriptLayer?.alignmentFeedStats();
            alignmentFeed = stats
              ? {
                  accepted: stats.accepted,
                  rejected: stats.rejected,
                  reason: dominantRejectReason(stats),
                  field: stats.lastMalformedField,
                }
              : null;
            /*
             * Only an ACCEPTED snapshot reaches the reducer.
             *
             * The comment above this subscription says the receiver "is the
             * gate that validates and rejects them" — and it was, for the
             * motion engine, and only for it. The reducer copy went in
             * unconditionally, `app.alignment` is handed back to `ScriptLayer`
             * as a prop, and the §62 fallback path turns that prop into a
             * scroll target whenever the rendered line map is unresolved. So a
             * snapshot the receiver had just refused — a stale sequence, or one
             * belonging to a session this window is not running — could still
             * move the document, by the one path that runs precisely when the
             * stage is least sure of its own geometry.
             *
             * There is exactly one gate now, and this is downstream of it. A
             * rejected snapshot leaves the readout showing the last position
             * the stage actually believes in, which is also the honest answer.
             */
            if (accepted) dispatch({ type: 'alignment', snapshot });
          },
        ),
        /*
         * The transcript bar. Raw recogniser text, read straight off the wire
         * — it deliberately does not pass through the reducer, because its
         * whole value is being true when the things that do are wrong.
         */
        subscribeStageEvent<StageTranscriptTapPayload>(STAGE_EVENT.transcriptTap, (payload) => {
          lastInboundAt = performance.now();
          transcriptTap = payload.text;
        }),
        /*
         * The voice pill. Like the transcript bar it bypasses the reducer: it
         * is an instrument pointed at the session rather than part of the
         * session's render model, and its whole value is being true when the
         * things that do go through the reducer are wrong.
         */
        subscribeStageEvent<StageVoicePillPayload>(STAGE_EVENT.voicePill, (payload) => {
          lastInboundAt = performance.now();
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
        subscribeStageEvent<StageStatePayload>(STAGE_EVENT.listenerState, onDirective),
        subscribeStageEvent<StageHeartbeatPayload>(STAGE_EVENT.heartbeat, (payload) => {
          lastInboundAt = performance.now();
          heartbeatSeen = true;
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
    // locally and wait. Only armed once a heartbeat has actually been seen,
    // and only under Tauri — the preview bus has no liveness contract.
    const watchdog = window.setInterval(() => {
      if (!isTauri || !heartbeatSeen || app.phase === 'handshake') return;
      if (performance.now() - lastInboundAt > STAGE_HEARTBEAT_GRACE_MS) {
        dispatch({ type: 'control_lost' });
      }
    }, 1000);

    /*
     * `?preview=1&replay=<url>` replays a frozen Tier-B run — real recorded
     * speech, through the real renderer — instead of the synthetic driver. It
     * is the only configuration in which "does the product follow" can be
     * asserted end to end: the benchmark proves the ENGINE follows and scores
     * Rust's own model of the display, never the code that moves the glass.
     */
    if (preview && previewReplayUrl) void startFixtureReplay(previewReplayUrl);
    else if (preview) previewDriver = startPreviewDriver({ calibrated: previewCalibrated });

    return () => {
      disposed = true;
      unsubs.forEach((u) => u());
      clearTimeout(fontTimeout);
      clearTimeout(pointerTimer);
      clearTimeout(exitTimer);
      clearTimeout(escapeHintTimer);
      clearInterval(watchdog);
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
    emitStageEvent<StageLayoutErrorPayload>(STAGE_EVENT.layoutError, {
      stageGeneration: app.envelope?.stageGeneration ?? 0,
      issues,
      layoutGeneration,
      atMs: Date.now(),
    });
  }

  /* ---- outbound intents (§16.9: control/Rust decides) ---- */
  function sendIntent(intent: StageIntent) {
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
    // Escape travels on its own event so the Rust bridge can relay it (§46.9),
    // under a name control does NOT listen for — see S1 on motionReport above.
    emitStageEvent<StageEscapePayload>(STAGE_EVENT.escapePressed, {
      stageGeneration: app.envelope?.stageGeneration ?? 0,
      presses,
      atMs: Date.now(),
    });
  }

  /* ---- pointer behavior (§16.9) ---- */
  let pointerTimer = 0;
  const POINTER_HIDE_DELAY_MS = 1500;

  /**
   * How long the exit affordance stays up after the pointer last moved.
   *
   * Longer than the cursor's own hide delay, deliberately. 1.5 s is right for
   * getting a cursor out of the presenter's way and far too short for finding a
   * target and travelling to it — a button that disappears while somebody is
   * reaching for it is worse than no button, because they now know it exists
   * and cannot use it.
   */
  const EXIT_HINT_VISIBLE_MS = 4000;
  let exitTimer = 0;
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
   * So: move the mouse over the stage and the way out appears. It cannot
   * intrude on a take, because a take is exactly when nobody is touching the
   * mouse.
   */
  let exitHintVisible = $state(false);
  /**
   * Held open while the button has the keyboard.
   *
   * Unmounting a focused element drops focus to the body, so somebody who
   * tabbed to the way out would find it gone and their place in the tab order
   * with it — on a window whose entire problem is being hard to leave. The
   * timeout may take it away when nobody is holding it, and not before.
   */
  let exitHintFocused = $state(false);
  const exitVisible = $derived(exitHintVisible || exitHintFocused);

  function onPointerMove() {
    pointerHidden = false;
    clearTimeout(pointerTimer);
    pointerTimer = window.setTimeout(() => {
      pointerHidden = true;
    }, POINTER_HIDE_DELAY_MS);

    exitHintVisible = true;
    clearTimeout(exitTimer);
    exitTimer = window.setTimeout(() => {
      exitHintVisible = false;
    }, EXIT_HINT_VISIBLE_MS);
  }

  /**
   * Leave, from the stage, in one click.
   *
   * The same message a second Escape sends, not a new path: ending a take is
   * control's decision to make and it already owns the whole teardown — the
   * transport, the microphone, the take record, the window. A stage that closed
   * its own window would leave every one of those running behind a screen that
   * had gone black.
   */
  function requestExit(event: MouseEvent) {
    // The root's own handler reports focus on every click; this one is not a
    // request to focus the stage, it is a request to be rid of it.
    event.stopPropagation();
    escapeHintVisible = false;
    clearTimeout(escapeHintTimer);
    exitHintVisible = false;
    exitHintFocused = false;
    clearTimeout(exitTimer);
    sendEscape(2);
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
  let wheelAccum = 0;
  let wheelFlush = 0;

  function onKeyDown(event: KeyboardEvent) {
    if (preview && handlePreviewKey(event.key)) return;
    switch (event.key) {
      case 'Escape': {
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
        scriptLayer?.manualScrollBy(dir * (scriptLayer?.lineHeightPx() ?? 64));
        sendIntent({
          kind: 'manual_step',
          direction: dir > 0 ? 'forward' : 'back',
          unit: 'line',
        });
        break;
      }
      case 'PageDown':
      case 'PageUp': {
        event.preventDefault();
        const dir = event.key === 'PageDown' ? 1 : -1;
        scriptLayer?.manualScrollBy(dir * vh * 0.8);
        sendIntent({
          kind: 'manual_step',
          direction: dir > 0 ? 'forward' : 'back',
          unit: 'paragraph',
        });
        break;
      }
      case ' ': {
        event.preventDefault();
        sendIntent({ kind: 'toggle_pause' });
        break;
      }
    }
  }

  function handlePreviewKey(key: string): boolean {
    if (!previewDriver) return false;
    switch (key) {
      case 'l':
        previewDriver.toggleListener();
        return true;
      case 'b':
        previewDriver.toggleBlank();
        return true;
      case 'f':
        previewDriver.toggleFreeze();
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

  /** Cycle the pill through its three readings, then off. */
  function previewVoicePill(current: StageVoicePillPayload | null): StageVoicePillPayload | null {
    const next: StageVoicePillReading | null =
      current === null
        ? 'listening'
        : current.reading === 'listening'
          ? 'confirmed'
          : current.reading === 'confirmed'
            ? 'fault'
            : null;
    if (next === null) return null;
    const label = next === 'confirmed' ? 'Hearing you' : next === 'fault' ? 'No audio' : 'Listening';
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
    scriptLayer?.manualScrollBy(event.deltaY);
    wheelAccum += event.deltaY;
    if (!wheelFlush) {
      wheelFlush = window.setTimeout(() => {
        sendIntent({ kind: 'manual_scroll', deltaPx: wheelAccum });
        wheelAccum = 0;
        wheelFlush = 0;
      }, 250);
    }
  }

  /**
   * The pill, as the current mode is willing to draw it.
   *
   * The MARK is presenter-facing in both modes: a cross in the corner is an
   * actionable fault, and a tick is the one piece of evidence that the whole
   * chain from device to model works — which is the entire reason the blocking
   * microphone check was replaced by a corner readout.
   *
   * The TRACE is left to CONTROL, which is where the decision belongs and where
   * it started.
   *
   * The optical work (501ca62) added a rule here that Clean Take collapses the
   * pill to its mark, on the reasoning that a waveform is continuous peripheral
   * motion competing with the words somebody is reading. The reasoning is sound
   * and the rule was still wrong, because of a fact one grep answers: NOTHING in
   * control ever sets `prominence`. The field is optional and the component
   * reads an absent one as expanded — so "Clean Take collapses it" was not a
   * refinement of control's choice, it was the only behaviour there had ever
   * been, replaced. Every presenter lost the readout that says the microphone is
   * being heard, in every take, and the first thing they noticed was its absence
   * during a take that was not working.
   *
   * So the decision goes back to control. If the peripheral motion turns out to
   * be a real problem on the glass, the fix is control sending `collapsed` when
   * it has nothing new to show — a decision made where the audio actually is,
   * not one the stage imposes on every session.
   */
  const presenterVoicePill = $derived(voicePill);

  function onListenerHealth(
    status: 'ok' | 'poster_fallback' | 'failed',
    code?: 'decode_failure' | 'unsupported_codec' | 'source_unavailable',
    clipId?: string,
  ) {
    mediaHealthy = status === 'ok';
    // Only degradations cross the boundary; recovery shows up in the next
    // heartbeat ack's mediaHealthy flag (§40.5).
    if (status === 'ok') return;
    emitStageEvent<StageListenerHealthPayload>(STAGE_EVENT.mediaError, {
      stageGeneration: app.envelope?.stageGeneration ?? 0,
      status,
      code,
      clipId,
    });
  }
</script>

<svelte:window onkeydown={onKeyDown} bind:innerWidth={windowVw} bind:innerHeight={windowVh} />

<!-- The stage is a non-interactive display surface: keyboard input is handled
     at the window level (§16.9), and the click handler only reports focus. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
  class="stage-root"
  data-phase={phase}
  data-pointer-hidden={pointerHidden}
  data-text-intensity={settings?.textIntensity ?? 'standard'}
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
      <!-- Layer 2+3: optional Listener; default stage is pure black, no listener. -->
      {#if app.listener && app.listener.placement !== 'off'}
        <ListenerLayer
          selection={app.listener}
          frozen={motionFrozen}
          hidden={listenerHidden}
          {reducedMotion}
          degraded={motionDegraded}
          onhealth={onListenerHealth}
        />
      {/if}

      <!-- Layers 4–6: compiled document, band treatment, reading cue, fades. -->
      {#if doc && settings && fontsSettled}
        <div class="script-holder" class:blanked={scriptHidden}>
          <ScriptLayer
            bind:this={scriptLayer}
            {doc}
            {settings}
            alignment={app.alignment}
            frozen={motionFrozen}
            {reducedMotion}
            sessionId={app.envelope?.sessionId ?? ''}
            sessionGeneration={app.envelope?.sessionGeneration ?? 0}
            stageGeneration={app.envelope?.stageGeneration ?? 0}
            scriptCompileHash={app.envelope?.sourceHash ?? ''}
            {followProfile}
            bottomInsetPx={0}
            cueHollow={holdStatus.rung !== 'none'}
            onlayoutready={handleLayoutReady}
            onlayoutmeasured={handleLayoutMeasured}
            onmotionack={handleMotionAck}
            onlayoutgeneration={(generation) => (layoutGeneration = generation)}
            onlayouterror={handleLayoutError}
            ondegraded={(degraded) => (motionDegraded = degraded)}
          />
        </div>
      {/if}

      {#if app.phase === 'handshake' && !app.envelope}
        <div class="waiting" aria-hidden="true">CandidCue</div>
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
      >
        <!-- Layer 7: transient command acknowledgement (§33.10). -->
        {#if (settings?.stageAcknowledgements ?? true) && !app.blanked}
          <AckChip ack={app.ack} />
        {/if}

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
            secondaryMinPx={settings?.optics?.secondaryMinPx ?? 0}
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
          <div class="escape-hint" role="status">Press Escape again to end</div>
        {/if}

        <!--
          The way out, for whoever has the mouse.

          Inside the talent plane with everything else that can be read, and the
          mirror costs it nothing: the glyph is `×`, which is symmetric, so the
          only thing a flip touches is the word beside it. A CSS transform
          carries hit-testing with it, so the button is clickable exactly where
          it appears on whichever surface is being looked at.

          Not shown during a blank. A blank is a deliberate "show nothing", and
          the answer to a blank is Escape — which the hint above is already there
          to explain.
        -->
        {#if exitVisible && !app.blanked}
          <button
            type="button"
            class="stage-exit"
            onclick={requestExit}
            onfocus={() => (exitHintFocused = true)}
            onblur={() => (exitHintFocused = false)}
          >
            <span class="stage-exit-glyph" aria-hidden="true">×</span>
            End session
          </button>
        {/if}

        <!--
          The voice pill.

          Mirrored, for the reason above: it is a mark and a word aimed at the
          presenter, and an unmirrored one reads backwards in the glass. Mounted
          for the whole take and faded by its own `visible` flag rather than added
          and removed — see the component. Hidden with the rest of the stage
          during a blank (§16.6), which is a deliberate "show nothing", not a
          moment to report on the microphone.

          Gated on the ENVELOPE ALONE, not on `phase === 'live'`, and not on the
          handshake having finished either. That is the whole point of the pill:
          `live` is only reached when an alignment snapshot arrives, alignment
          snapshots are made from transcript frames, and a take that transcribes
          nothing therefore never leaves `ready`. Gating it on the take being
          under way hid the indicator during precisely the failure it exists to
          explain, and a stage stuck measuring is a stage whose presenter still
          deserves to know whether the microphone is being heard.
        -->
        {#if app.envelope !== null && !app.blanked && presenterVoicePill !== null}
          <VoicePill pill={presenterVoicePill} />
        {/if}
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
            <div class="sample-label">{app.calibration.sampleLabel}</div>
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
      NOT diagnostic-only, and not gated on the take being under way.
      -----------------------------------------------------------------------
      Both gates were added by the optical work (501ca62) and both were wrong,
      for the same reason: this strip is the only thing on the glass that says
      whether the recogniser is hearing anything at all, and it was hidden in
      precisely the two situations where that is the question.

      `showDiagnostics` hid it from everybody running a Clean Take, which is
      everybody. A presenter whose script had stopped moving had no way to tell
      "the microphone was never captured" from "the recogniser heard nothing"
      from "the aligner would not match" — three unrelated faults with one
      symptom, and this bar is what separates the first two from the third.

      `phase === 'live'` was worse. `live` is only reached when an alignment
      snapshot is ACCEPTED, and a take that transcribes nothing never produces
      one — so the bar was hidden by the very failure it exists to explain,
      exactly as the voice pill's own note above describes. It stays up from the
      moment there is an envelope.

      The peripheral-motion concern that motivated the gate is real and is
      answered by `silent`: the strip is dim and still until words arrive.
    -->
    {#if app.envelope !== null && !app.blanked}
      <div class="transcript-tap" class:silent={transcriptTap.length === 0}>
        <span class="transcript-tap-words">
          {transcriptTap.length > 0 ? transcriptTap : 'listening — no words yet'}
        </span>
      </div>
    {/if}

    {#if preview}
      <div class="preview-hud">
        preview · l listener · b blank · f freeze · m mirror · c calibrate · s clean/diagnostic · r
        cue · a ack · j jump · v voice pill
      </div>
    {/if}
  </div>
</div>

<style>
  .stage-root {
    position: absolute;
    inset: 0;
    background: var(--stage-bg);
    overflow: hidden;
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
     session state, measurements, and Listener position survive. */
  .script-holder.blanked {
    visibility: hidden;
  }

  .waiting {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: var(--stage-text-past);
    font-size: var(--text-lg);
    letter-spacing: var(--ls-caps);
    text-transform: uppercase;
    pointer-events: none;
  }

  /*
   * Escape confirmation. Top centre, clear of the reading band and of the
   * reserved strip at the bottom of the glass — a prompt about stopping must
   * not sit on top of the words the presenter is still speaking.
   */
  .escape-hint {
    position: absolute;
    top: 4vh;
    left: 50%;
    transform: translateX(-50%);
    padding: 0.5em 1.1em;
    border-radius: 999px;
    background: var(--stage-overlay);
    color: var(--stage-text);
    font-size: clamp(15px, 1.6vw, 22px);
    font-weight: 550;
    white-space: nowrap;
    pointer-events: none;
  }

  /*
   * The exit affordance.
   *
   * Bottom-right of the SAFE rectangle, which is the one corner nothing else
   * claims: the hold chip and the acknowledgement sit high, the voice pill sits
   * low-left, and the reading band runs across the middle. It is the only
   * element on the stage that takes pointer events — everything else here is
   * `pointer-events: none` so a stray click lands on the root and reports focus
   * rather than being swallowed by decoration.
   *
   * Deliberately quiet until it is under the cursor. It is on the presenter's
   * glass, so it may not read as a lit control sitting in the corner of a take;
   * it only has to be findable by somebody who has already gone looking with a
   * mouse.
   */
  .stage-exit {
    position: absolute;
    right: 0;
    bottom: 0;
    display: inline-flex;
    align-items: center;
    gap: 0.45em;
    padding: 0.5em 1em;
    border: 1px solid color-mix(in srgb, var(--stage-text) 30%, transparent);
    border-radius: 999px;
    background: var(--stage-overlay);
    color: var(--stage-text);
    font: inherit;
    font-size: clamp(14px, 1.4vw, 20px);
    font-weight: 550;
    white-space: nowrap;
    cursor: pointer;
    /*
     * The one element on this plane that must take a click.
     *
     * `.stage-safe-plane` is `pointer-events: none` so a stray click anywhere
     * over the overlays lands on the root and reports focus rather than being
     * swallowed by a chip. That is right for every other child and fatal for
     * this one: without re-enabling it here the button paints, invites the
     * click, and does nothing — the exact dead control this affordance exists
     * to replace.
     */
    pointer-events: auto;
    opacity: 0.55;
    transition:
      opacity 120ms ease-out,
      border-color 120ms ease-out;
  }

  .stage-exit:hover,
  .stage-exit:focus-visible {
    opacity: 1;
    border-color: color-mix(in srgb, var(--stage-text) 55%, transparent);
  }

  .stage-exit-glyph {
    font-size: 1.15em;
    line-height: 1;
  }

  /*
   * The name of the type sample being judged.
   *
   * Sized at the secondary floor like every other presenter-readable label, and
   * placed at the top of the card where the sample's own passage is not.
   */
  .sample-label {
    position: absolute;
    top: 4%;
    left: 50%;
    transform: translateX(-50%);
    padding: 0.3em 0.9em;
    border-radius: var(--radius-pill, 999px);
    background: var(--stage-overlay);
    color: var(--stage-text);
    font-size: var(--stage-secondary-min, 0.67em);
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
    color: #ffb4a2;
    font-weight: 600;
  }

  .diagnostics {
    position: absolute;
    top: 12px;
    right: 12px;
    padding: 10px 12px;
    border-radius: 10px;
    background: var(--stage-overlay);
    color: var(--stage-text);
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 12px;
    line-height: 1.6;
    pointer-events: none;
  }

  /*
   * One line, along the bottom, newest word at the right.
   *
   * Right-aligned with `overflow: hidden` is what makes older words fall off
   * the left edge as new ones arrive — no animation, no measurement, and
   * nothing that can drift out of step with the words themselves. Small and
   * dim so it reads as an instrument rather than competing with the script,
   * but a monospace face so a word appearing is unmistakable in peripheral
   * vision.
   */
  .transcript-tap {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    padding: 6px 18px;
    display: flex;
    justify-content: flex-end;
    overflow: hidden;
    white-space: nowrap;
    pointer-events: none;
    background: linear-gradient(to top, rgb(0 0 0 / 55%), transparent);
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

  .preview-hud {
    position: absolute;
    left: 14px;
    bottom: 10px;
    color: var(--stage-text-past);
    font-size: 12px;
    letter-spacing: 0.04em;
    pointer-events: none;
  }
</style>
