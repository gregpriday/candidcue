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
    type StageHydratedPayload,
    type StageIntent,
    type StageIntentPayload,
    type StageListenerHealthPayload,
    type StageMotionAck,
    type StageMotionAckPayload,
    type StageReadyPayload,
    type StageSemanticFramePayload,
    type StageSnapshotPayload,
    type StageStatePayload,
    type StageTrackingPayload,
  } from '../shared/contracts';
  import { subscribeStageEvent, emitStageEvent, isTauri, type Unsubscribe } from './events';
  import {
    initialStageState,
    stageReducer,
    displayPhase,
    type StageAction,
  } from './renderer/stageState';
  import { isCompactViewport } from './renderer/geometry';
  import ScriptLayer from './renderer/ScriptLayer.svelte';
  import AckChip from './renderer/AckChip.svelte';
  import CoachStrip from './renderer/CoachStrip.svelte';
  import ListenerLayer from './listener/ListenerLayer.svelte';
  import { startPreviewDriver, type PreviewDriver } from './preview';

  const preview =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('preview') === '1';

  let app = $state.raw(initialStageState());
  let fontsReady = $state(false);
  let pointerHidden = $state(false);
  let vw = $state(0);
  let vh = $state(0);
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
  let heartbeatSeen = false;
  /** Layout generation the stage is currently measured at (companion §7.2). */
  let layoutGeneration = $state(0);

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
        subscribeStageEvent<StageTrackingPayload>(STAGE_EVENT.trackingSnapshot, (snapshot) => {
          lastInboundAt = performance.now();
          dispatch({ type: 'tracking', snapshot });
        }),
        // Companion §26.1: high-rate motion frames. They never touch the stage
        // reducer — the frame receiver inside the motion engine is the gate,
        // and an unaccepted frame is silently discarded.
        subscribeStageEvent<StageSemanticFramePayload>(STAGE_EVENT.semanticFrame, (frame) => {
          lastInboundAt = performance.now();
          scriptLayer?.pushSemanticFrame(frame);
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
      if (disposed) subs.forEach((u) => u());
      else unsubs.push(...subs);
    })();

    void document.fonts.ready.then(() => {
      fontsReady = true;
    });

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
    emitStageEvent<StageMotionAckPayload>(STAGE_EVENT.motionAck, {
      ...ack,
      stageGeneration: app.envelope?.stageGeneration ?? 0,
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

  function sendEscape(presses: 1 | 2) {
    // Escape travels on its own event so the Rust bridge can relay it (§46.9).
    emitStageEvent<StageEscapePayload>(STAGE_EVENT.escapeRequested, {
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

<svelte:window onkeydown={onKeyDown} />

<!-- The stage is a non-interactive display surface: keyboard input is handled
     at the window level (§16.9), and the click handler only reports focus. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
  class="stage-root"
  data-phase={phase}
  data-pointer-hidden={pointerHidden}
  bind:clientWidth={vw}
  bind:clientHeight={vh}
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
            tracking={app.tracking}
            frozen={motionFrozen}
            {reducedMotion}
            {compact}
            sessionId={app.envelope?.sessionId ?? ''}
            sessionGeneration={app.envelope?.sessionGeneration ?? 0}
            stageGeneration={app.envelope?.stageGeneration ?? 0}
            scriptCompileHash={app.envelope?.sourceHash ?? ''}
            onlayoutready={handleLayoutReady}
            onmotionack={handleMotionAck}
            onlayoutgeneration={(generation) => (layoutGeneration = generation)}
          />
        </div>
      {/if}

      <!-- Optional coach strip (companion Part VIII): one concise tip in a
           reserved safe area, never during a blank. -->
      {#if !app.blanked}
        <CoachStrip tip={app.coachTip} {reducedMotion} />
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

  <!-- Layer 8: hidden diagnostics, operator-facing, never mirrored. -->
  {#if app.diagnostics}
    <div class="diagnostics">
      <div>phase: {phase}</div>
      <div>gen: {app.envelope?.stageGeneration ?? '—'}</div>
      <div>tracking rev: {app.lastTrackingRevision ?? '—'}</div>
      <div>token: {app.tracking?.tokenIndex ?? '—'} ({app.tracking?.state ?? 'n/a'})</div>
      <div>viewport: {vw}×{vh}{compact ? ' compact' : ''}</div>
      <div>layout gen: {layoutGeneration}</div>
      <div>media: {mediaHealthy ? 'healthy' : 'degraded'}</div>
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
