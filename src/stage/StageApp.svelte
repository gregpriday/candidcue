<!--
  Stage window shell (spec §16.1 layer model, §43.5 heartbeat, §45.6).

  Layers, back to front: solid background → Listener video + treatment →
  script text + focus fades → transient acknowledgement → calibration /
  diagnostics overlays. Everything the presenter sees through the glass sits
  inside the mirror plane; diagnostics stay operator-facing and unmirrored.

  All data arrives via Tauri events (the stage holds only event:listen);
  outbound traffic is intents/acks that control is free to ignore.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import {
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
  import { isCompactViewport } from './renderer/geometry';
  import { stageFollowProfile } from './motion';
  import ScriptLayer from './renderer/ScriptLayer.svelte';
  import AckChip from './renderer/AckChip.svelte';
  import ListenerLayer from './listener/ListenerLayer.svelte';
  import { startPreviewDriver, type PreviewDriver } from './preview';

  const preview =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('preview') === '1';

  let app = $state.raw(initialStageState());
  let fontsReady = $state(false);
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
  const compact = $derived(isCompactViewport(vw, vh));
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
  let transcriptTapAtMs = $state(0);
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
            scriptLayer?.pushAlignmentSnapshot(snapshot);
            dispatch({ type: 'alignment', snapshot });
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
          transcriptTapAtMs = Date.now();
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

    // §7.1 wants the map built once fonts are final — but `document.fonts.ready`
    // is not guaranteed to settle: one font that never resolves would otherwise
    // hold the entire script off the glass for the whole take. Mount with
    // whatever is available after a bounded wait; the map rebuild triggered by
    // the fingerprint's `fontHash`/metrics change picks the real font up when it
    // lands.
    const fontTimeout = window.setTimeout(() => {
      fontsReady = true;
    }, FONT_READY_TIMEOUT_MS);
    void document.fonts.ready.then(
      () => {
        clearTimeout(fontTimeout);
        fontsReady = true;
      },
      () => {
        clearTimeout(fontTimeout);
        fontsReady = true;
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

    if (preview) previewDriver = startPreviewDriver();

    return () => {
      disposed = true;
      unsubs.forEach((u) => u());
      clearTimeout(fontTimeout);
      clearInterval(watchdog);
      previewDriver?.stop();
    };
  });

  /* ---- readiness ACK ---- */
  function handleLayoutReady() {
    dispatch({ type: 'layout_ready' });
    if (!app.envelope) return;
    emitStageEvent<StageReadyPayload>(STAGE_EVENT.layoutReady, {
      stageGeneration: app.envelope.stageGeneration,
      sessionId: app.envelope.sessionId,
      hydrated: true,
      layoutReady: true,
      fontsReady,
      viewportWidth: vw,
      viewportHeight: vh,
      devicePixelRatio: window.devicePixelRatio,
    });
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
    }, ESCAPE_DOUBLE_MS);
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

  function onPointerMove() {
    pointerHidden = false;
    clearTimeout(pointerTimer);
    pointerTimer = window.setTimeout(() => {
      pointerHidden = true;
    }, POINTER_HIDE_DELAY_MS);
  }

  function onClick() {
    // A single click focuses the stage but never moves the script.
    sendIntent({ kind: 'stage_focused' });
  }

  /* ---- keyboard behavior (§16.9) ---- */
  let lastEscapeAt = 0;
  const ESCAPE_DOUBLE_MS = 1500;
  let wheelAccum = 0;
  let wheelFlush = 0;

  function onKeyDown(event: KeyboardEvent) {
    if (preview && handlePreviewKey(event.key)) return;
    switch (event.key) {
      case 'Escape': {
        const now = performance.now();
        const double = now - lastEscapeAt <= ESCAPE_DOUBLE_MS;
        lastEscapeAt = double ? 0 : now;
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
      case 'c':
        previewDriver.toggleCalibration();
        return true;
      case 'a':
        previewDriver.ack('Chapter 1');
        return true;
      case 'j':
        previewDriver.jump();
        return true;
      default:
        return false;
    }
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
  bind:clientWidth={measuredVw}
  bind:clientHeight={measuredVh}
  onpointermove={onPointerMove}
  onclick={onClick}
  onwheel={onWheel}
>
  <div class="stage-position-plane">
    <div
      class="stage-mirror-plane"
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

      <!-- Layers 4–6: compiled document, band treatment, focus fades. -->
      {#if doc && settings && fontsReady}
        <div class="script-holder" class:blanked={scriptHidden}>
          <ScriptLayer
            bind:this={scriptLayer}
            {doc}
            {settings}
            alignment={app.alignment}
            frozen={motionFrozen}
            {reducedMotion}
            {compact}
            sessionId={app.envelope?.sessionId ?? ''}
            sessionGeneration={app.envelope?.sessionGeneration ?? 0}
            stageGeneration={app.envelope?.stageGeneration ?? 0}
            scriptCompileHash={app.envelope?.sourceHash ?? ''}
            {followProfile}
            bottomInsetPx={0}
            onlayoutready={handleLayoutReady}
            onmotionack={handleMotionAck}
            onlayoutgeneration={(generation) => (layoutGeneration = generation)}
            onlayouterror={handleLayoutError}
            ondegraded={(degraded) => (motionDegraded = degraded)}
          />
        </div>
      {/if}

      <!-- Layer 7: transient command acknowledgement (§33.10). -->
      {#if (settings?.stageAcknowledgements ?? true) && !app.blanked}
        <AckChip ack={app.ack} />
      {/if}

      <!-- Calibration crosshair (§17.2) — mirrored with the content the
           presenter aligns against. -->
      {#if app.calibration.active && !app.blanked}
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
      {/if}
    </div>
  </div>

  {#if app.phase === 'handshake' && !app.envelope}
    <div class="waiting" aria-hidden="true">CandidCue</div>
  {/if}

  <!-- Escape confirmation (§16.9). Outside the mirror plane on purpose: it is
       an instruction to the presenter, not part of the script, so it must stay
       readable through a horizontal mirror. Shown during a blank too — a blank
       is exactly when someone reaches for Escape. -->
  {#if escapeHintVisible}
    <div class="escape-hint" role="status">Press Escape again to end</div>
  {/if}

  <!-- Layer 8: hidden diagnostics, operator-facing, never mirrored. -->
  {#if app.diagnostics}
    <div class="diagnostics">
      <div>phase: {phase}</div>
      <div>gen: {app.envelope?.stageGeneration ?? '—'}</div>
      <div>tracking rev: {app.lastTrackingRevision ?? '—'}</div>
      <div>
        token: {app.alignment ? app.alignment.confirmedToken.toFixed(1) : '—'}
        ({app.alignment?.state ?? 'n/a'})
      </div>
      <div>viewport: {vw}×{vh}{compact ? ' compact' : ''}</div>
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
    Layer 9: the transcript bar. Outside the mirror plane on purpose — it is
    an instrument, not part of the read, and a mirrored diagnostic is useless
    to the person who needs it.
  -->
  {#if phase === 'live' && !app.blanked}
    <div class="transcript-tap" class:silent={transcriptTap.length === 0}>
      <span class="transcript-tap-words">
        {transcriptTap.length > 0 ? transcriptTap : 'listening — no words yet'}
      </span>
    </div>
  {/if}

  {#if preview}
    <div class="preview-hud">
      preview · l listener · b blank · f freeze · m mirror · c calibrate · a ack · j jump
    </div>
  {/if}
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
  .stage-mirror-plane {
    position: absolute;
    inset: 0;
  }

  /* Mirror transforms live alone on the mirror plane (§16.7). */
  .stage-mirror-plane[data-mirror-x='true'] {
    transform: scaleX(-1);
  }
  .stage-mirror-plane[data-mirror-y='true'] {
    transform: scaleY(-1);
  }
  .stage-mirror-plane[data-mirror-x='true'][data-mirror-y='true'] {
    transform: scale(-1, -1);
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
   * coaching rail's reserved strip at the bottom — a prompt about stopping must
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
