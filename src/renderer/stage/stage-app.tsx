import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CaptureConfig,
  SpeechPlaybackPlan,
  StageBootstrap,
  StageStateProjection,
  StageCommand,
} from '@shared/contracts';
import { VideoDeck } from './playback/VideoDeck';
import { StatusOverlay } from './components/StatusOverlay';
import type { CommandFeedback } from './components/StatusOverlay';
import { EndConfirmOverlay } from './components/EndConfirmOverlay';
import { SpeechPlayer } from './playback/SpeechPlayer';
import { BackchannelPlayer } from './playback/BackchannelPlayer';
import { CaptureController } from './audio/CaptureController';
import { commandForKey, isCommandUsefulInState } from './stage-commands';
import styles from './stage-app.module.css';

/** Initial projection before the first state event arrives. */
const INITIAL_STATE: StageStateProjection = {
  version: 0,
  visualState: 'standby',
  micState: 'closed',
  statusText: null,
  captions: null,
  mirror: false,
  zoom: 1,
  verticalOffsetPercent: 0,
  canBegin: false,
};

/** Seconds the founder's start countdown runs for before BEGIN fires — long
 *  enough to settle into frame, short enough not to feel sluggish. */
const START_COUNTDOWN_SECONDS = 3;

function sendCommand(command: StageCommand): void {
  window.candidcueStage.commands.send(command);
}

/**
 * A soft two-note rising chime that signals "your turn" the moment the mic arms,
 * so a founder watching the camera doesn't have to read the screen to notice.
 * Pure Web Audio — no asset — and deliberately quiet so it never competes with
 * the interviewer's voice.
 */
function playArmChime(ctx: AudioContext): void {
  const now = ctx.currentTime;
  const gain = ctx.createGain();
  gain.connect(ctx.destination);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.linearRampToValueAtTime(0.14, now + 0.03);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.34);
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(880, now); // A5
  osc.frequency.setValueAtTime(1174.66, now + 0.12); // D6
  osc.connect(gain);
  osc.start(now);
  osc.stop(now + 0.34);
}

export function StageApp(): JSX.Element {
  const [bootstrap, setBootstrap] = useState<StageBootstrap | null>(null);
  const [state, setState] = useState<StageStateProjection>(INITIAL_STATE);
  const [plan, setPlan] = useState<SpeechPlaybackPlan | null>(null);
  const [speechEndedTurnId, setSpeechEndedTurnId] = useState<string | null>(null);
  // Shift+E opens this confirm; only an explicit "End interview" press dispatches
  // END_AFTER_TURN, so the destructive action never fires from one keystroke.
  // The orchestrator gates END_AFTER_TURN to states where the user holds the
  // floor (or is finalizing) — confirming in any other state is a harmless no-op,
  // matching how commandForKey's commands are silently dropped when illegal.
  const [endConfirmOpen, setEndConfirmOpen] = useState(false);
  // On-screen keyboard legend, toggled with '?'. Renderer-local, not a command.
  // Defaults open to orient the founder on standby; auto-hidden once the
  // interview starts (see prevMicState/standby handling below).
  const [legendVisible, setLegendVisible] = useState(true);
  // Brief confirm/reject cue for the last keypress so a wrong-moment key is never
  // silent. `token` increments per press so a repeated identical key re-pulses.
  const [commandFeedback, setCommandFeedback] = useState<CommandFeedback | null>(null);

  // Founder-start countdown (FOUNDER-START): renderer-local, like the end-confirm
  // above — only the final BEGIN crosses IPC. null = idle; otherwise the seconds
  // remaining. The ref mirrors it so the once-bound keydown handler reads the
  // live value without re-subscribing.
  const [countdown, setCountdown] = useState<number | null>(null);
  const countdownRef = useRef<number | null>(null);
  useEffect(() => {
    countdownRef.current = countdown;
  }, [countdown]);
  // Latches once BEGIN has been sent so Space can't arm a second countdown in
  // the gap before the orchestrator's new (non-standby) projection arrives. It
  // is cleared when the session actually leaves the begin-able standby.
  const beginSentRef = useRef(false);

  // Engines live for the lifetime of the window; refs avoid re-creating them.
  const speechPlayerRef = useRef<SpeechPlayer | null>(null);
  const backchannelPlayerRef = useRef<BackchannelPlayer | null>(null);
  const captureRef = useRef<CaptureController | null>(null);
  // Soft "your turn" chime at mic-arm: a lazily-created context plus the previous
  // mic gate, so the chime fires once on each closed/active -> armed transition.
  const chimeCtxRef = useRef<AudioContext | null>(null);
  const prevMicStateRef = useRef<StageStateProjection['micState']>(INITIAL_STATE.micState);
  // Auto-hide the legend exactly once, when the interview leaves standby, so it
  // never sits in the recording (the founder can re-show it with '?').
  const hasLeftStandbyRef = useRef(false);
  // Latest state, read by event handlers without re-subscribing.
  const stateRef = useRef<StageStateProjection>(INITIAL_STATE);
  const currentTurnIdRef = useRef<string | null>(null);
  // Identity of the capture graph currently being built/run, so duplicate
  // capture-config sends (one from startOrchestrator, one from stageBootstrap)
  // don't trigger a second getUserMedia.
  const appliedCaptureKeyRef = useRef<string | null>(null);
  // Monotonic token so an older async capture continuation can't clobber a newer
  // config's controller/refs.
  const captureGenRef = useRef(0);

  // Readiness coordination (MEDIA-02): the single IPC 'ready' is withheld until
  // BOTH the decoded audio and the speaking video are ready for the same turn,
  // so the orchestrator never starts audio before the video can play.
  const audioReadyTurnRef = useRef<string | null>(null);
  const deckReadyTurnRef = useRef<string | null>(null);
  const reportedReadyTurnRef = useRef<string | null>(null);

  const maybeReportReady = useCallback((turnId: string) => {
    if (
      audioReadyTurnRef.current === turnId &&
      deckReadyTurnRef.current === turnId &&
      reportedReadyTurnRef.current !== turnId
    ) {
      reportedReadyTurnRef.current = turnId;
      window.candidcueStage.playback.reportReady({ turnId });
    }
  }, []);

  const handleAudioReady = useCallback(
    (turnId: string) => {
      // Ignore readiness from a superseded turn (e.g. a late decode/canplay).
      if (turnId !== currentTurnIdRef.current) {
        return;
      }
      audioReadyTurnRef.current = turnId;
      maybeReportReady(turnId);
    },
    [maybeReportReady],
  );

  const handleSpeakingReady = useCallback(
    (turnId: string) => {
      if (turnId !== currentTurnIdRef.current) {
        return;
      }
      deckReadyTurnRef.current = turnId;
      maybeReportReady(turnId);
    },
    [maybeReportReady],
  );

  const startCapture = useCallback(async (config: CaptureConfig): Promise<void> => {
    const key = `${config.sessionId}::${config.inputDeviceId ?? ''}`;
    // Dedup duplicate/concurrent sends for the same session + device.
    if (appliedCaptureKeyRef.current === key) {
      return;
    }
    const gen = ++captureGenRef.current;
    appliedCaptureKeyRef.current = key;

    const previous = captureRef.current;
    captureRef.current = null;
    if (previous !== null) {
      await previous.dispose();
    }
    if (gen !== captureGenRef.current) {
      return; // a newer config superseded us during teardown
    }

    const controller = new CaptureController({
      sessionId: config.sessionId,
      deviceId: config.inputDeviceId,
      config,
      reportMeter: (reading) => window.candidcueStage.audio.reportMeter(reading),
      openPort: (input) => window.candidcueStage.audio.openCapturePort(input),
    });
    try {
      await controller.start();
      if (gen !== captureGenRef.current) {
        await controller.dispose();
        return; // superseded while acquiring the device
      }
      captureRef.current = controller;
      controller.setGate(stateRef.current.micState, currentTurnIdRef.current);
    } catch {
      // Capture failed to start; tear it down. Allow a later config to retry,
      // but only if we are still the most recent attempt.
      await controller.dispose();
      if (gen === captureGenRef.current) {
        appliedCaptureKeyRef.current = null;
      }
    }
  }, []);

  // --- Bootstrap ----------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    void window.candidcueStage.bootstrap().then((boot) => {
      if (!cancelled) {
        setBootstrap(boot);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // --- Speech engine ------------------------------------------------------
  useEffect(() => {
    const player = new SpeechPlayer({
      // Audio decode readiness is local; the combined IPC 'ready' is sent by
      // maybeReportReady once the deck is ready too.
      reportReady: (input) => handleAudioReady(input.turnId),
      reportStarted: (input) => window.candidcueStage.playback.reportStarted(input),
      reportEnded: (input) => window.candidcueStage.playback.reportEnded(input),
      reportError: (input) => window.candidcueStage.playback.reportError(input),
      onEnded: (turnId) => setSpeechEndedTurnId(turnId),
    });
    speechPlayerRef.current = player;
    return () => {
      speechPlayerRef.current = null;
      void player.dispose();
    };
  }, [handleAudioReady]);

  // --- Backchannel engine -------------------------------------------------
  // Built once bootstrap arrives so it can pre-decode the character's clips.
  useEffect(() => {
    if (bootstrap === null) {
      return;
    }
    const player = new BackchannelPlayer();
    backchannelPlayerRef.current = player;
    void player.init(bootstrap.backchannelClips);
    return () => {
      backchannelPlayerRef.current = null;
      void player.dispose();
    };
  }, [bootstrap]);

  // --- State / plan / capture-config subscriptions ------------------------
  useEffect(() => {
    const offState = window.candidcueStage.events.onState((next) => {
      stateRef.current = next;
      setState(next);
      // Sound a soft chime the instant the mic arms (and only on the transition,
      // not on every armed projection) so a founder watching the camera knows
      // it's their turn without reading the screen.
      if (next.micState === 'armed' && prevMicStateRef.current !== 'armed') {
        const AudioCtor = window.AudioContext;
        if (typeof AudioCtor === 'function') {
          try {
            chimeCtxRef.current ??= new AudioCtor();
            playArmChime(chimeCtxRef.current);
          } catch {
            // Audio is a nicety; never let it break the stage.
          }
        }
      }
      prevMicStateRef.current = next.micState;
      // Once the interview starts, retire the orientation legend so it isn't part
      // of the framing; it stays a '?' away if the founder wants it back.
      if (next.visualState !== 'standby' && !hasLeftStandbyRef.current) {
        hasLeftStandbyRef.current = true;
        setLegendVisible(false);
      }
      // Drive the mic gate from the authoritative projection.
      captureRef.current?.setGate(next.micState, currentTurnIdRef.current);
      // Once the visual state reaches 'speaking', start the decoded audio.
      // On any non-speaking visual state, stop playback promptly so Pause / End
      // Now actually silence Mira (the state otherwise only stops at teardown).
      // stop() is a no-op when nothing is playing, so a normal speaking->listening
      // handoff after a natural audio end is harmless.
      if (next.visualState === 'speaking') {
        speechPlayerRef.current?.start();
      } else {
        speechPlayerRef.current?.stop();
      }
    });

    const offPlan = window.candidcueStage.events.onPlaybackPlan((next) => {
      currentTurnIdRef.current = next.turnId;
      // Reset readiness tracking for the new turn.
      audioReadyTurnRef.current = null;
      deckReadyTurnRef.current = null;
      reportedReadyTurnRef.current = null;
      setSpeechEndedTurnId(null);
      setPlan(next);
      void speechPlayerRef.current?.load(next);
    });

    const offBackchannel = window.candidcueStage.events.onPlayBackchannel(() => {
      // Immediate acknowledgment at commit (#53). The player guards a suspended
      // context and refuses to play over Mira's speech, so the current visual
      // state is all it needs.
      backchannelPlayerRef.current?.play(stateRef.current.visualState);
    });

    const offCapture = window.candidcueStage.events.onCaptureConfig((config) => {
      // (Re)create the capture controller against the latest config.
      void startCapture(config);
    });

    return () => {
      offState();
      offPlan();
      offBackchannel();
      offCapture();
    };
  }, [startCapture]);

  useEffect(() => {
    return () => {
      void captureRef.current?.dispose();
      captureRef.current = null;
      void chimeCtxRef.current?.close().catch(() => {});
      chimeCtxRef.current = null;
    };
  }, []);

  // Clear the keypress cue after a beat so it stays brief. A timer (not a pure
  // CSS fill) keeps it visible under prefers-reduced-motion, where the fade-in
  // animation collapses to nothing.
  useEffect(() => {
    if (commandFeedback === null) {
      return undefined;
    }
    const timer = window.setTimeout(() => setCommandFeedback(null), 1200);
    return () => window.clearTimeout(timer);
  }, [commandFeedback]);

  // --- Founder-start countdown -------------------------------------------
  // Tick down once per second; the final second hands off to BEGIN rather than
  // ever rendering "Starting in 0…". setTimeout is rescheduled on each tick, so
  // a cancel (Escape/blur/state change) clears the pending timer via cleanup.
  useEffect(() => {
    if (countdown === null) {
      return undefined;
    }
    if (countdown <= 1) {
      const timer = window.setTimeout(() => {
        beginSentRef.current = true;
        sendCommand({ type: 'BEGIN' });
        setCountdown(null);
      }, 1000);
      return () => window.clearTimeout(timer);
    }
    const timer = window.setTimeout(() => {
      setCountdown((c) => (c === null ? null : c - 1));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [countdown]);

  // Cancel an in-flight countdown the moment the stage is no longer begin-able —
  // the session left standby (begin landed, or a fault), or READY was lost.
  useEffect(() => {
    if (state.visualState !== 'standby' || !state.canBegin) {
      setCountdown(null);
      beginSentRef.current = false;
    }
  }, [state.visualState, state.canBegin]);

  // A countdown should never fire BEGIN into a window that has lost focus.
  useEffect(() => {
    const onBlur = (): void => setCountdown(null);
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, []);

  // --- Global keyboard ----------------------------------------------------
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.repeat) {
        return;
      }
      // While the end-confirm (or any modal) is open, let it own the keyboard —
      // don't fire Space/P/R/S underneath it, and leave Escape to the dialog.
      if (document.querySelector('[aria-modal="true"]') !== null) {
        return;
      }
      // Shift+E opens the end-interview confirm. This is renderer-local state,
      // not a StageCommand: only the confirmed action crosses IPC.
      if (
        event.shiftKey &&
        event.code === 'KeyE' &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        event.preventDefault();
        // Opening the end-confirm hands the keyboard to the modal, so any live
        // start countdown must be cancelled here or its timer would fire BEGIN
        // out from under the dialog.
        setCountdown(null);
        setEndConfirmOpen(true);
        return;
      }
      // '?' (Slash) toggles the on-screen controls legend. Renderer-local state,
      // not a StageCommand — nothing crosses IPC.
      if (event.code === 'Slash' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        setLegendVisible((visible) => !visible);
        return;
      }
      // Founder-start: when the session is READY (canBegin) and waiting on the
      // standby screen, Space arms a short visible countdown so the founder can
      // settle before recording begins. A bare Escape cancels it. Both read the
      // live state/countdown via refs (the handler binds once). Gating on
      // canBegin keeps the prior Space→COMMIT behaviour in non-ready standby.
      if (
        stateRef.current.visualState === 'standby' &&
        stateRef.current.canBegin &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey
      ) {
        if (event.code === 'Space') {
          event.preventDefault();
          if (countdownRef.current === null && !beginSentRef.current) {
            setCountdown(START_COUNTDOWN_SECONDS);
          }
          return;
        }
        if (event.code === 'Escape' && countdownRef.current !== null) {
          event.preventDefault();
          setCountdown(null);
          return;
        }
      }
      // stateRef is always current, so the pause/resume toggle reads the latest
      // visual state without re-subscribing the listener.
      const command = commandForKey(event, stateRef.current.visualState);
      if (command === null) {
        // Leave unrecognized keys untouched — no feedback flash for keys that
        // were never stage controls.
        return;
      }
      event.preventDefault();
      // Flash a confirm/reject cue from the same gating the orchestrator applies,
      // so a wrong-moment press isn't silently swallowed. Bump the token so a
      // repeated identical key still re-pulses.
      const useful = isCommandUsefulInState(
        command,
        stateRef.current.visualState,
        stateRef.current.micState,
      );
      setCommandFeedback((prev) => ({
        kind: useful ? 'ok' : 'rejected',
        token: (prev?.token ?? 0) + 1,
      }));
      // Send regardless: the orchestrator is the source of truth and tolerates a
      // command that a briefly-lagging projection made look illegal.
      sendCommand(command);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  if (bootstrap === null) {
    return <div className={styles.stage} aria-busy="true" />;
  }

  const captionsEnabled = plan?.captionsEnabled ?? false;
  const characterName =
    bootstrap.characterId !== ''
      ? bootstrap.characterId.charAt(0).toUpperCase() + bootstrap.characterId.slice(1)
      : null;

  return (
    <div className={styles.stage}>
      <VideoDeck
        bootstrap={bootstrap}
        state={state}
        plan={plan}
        speechEndedTurnId={speechEndedTurnId}
        onSpeakingReady={handleSpeakingReady}
      />
      <StatusOverlay
        state={state}
        captionsEnabled={captionsEnabled}
        characterName={characterName}
        legendVisible={legendVisible}
        commandFeedback={commandFeedback}
        countdown={countdown}
      />
      <EndConfirmOverlay
        open={endConfirmOpen}
        onClose={() => setEndConfirmOpen(false)}
        onConfirm={() => {
          setEndConfirmOpen(false);
          sendCommand({ type: 'END_AFTER_TURN' });
        }}
      />
    </div>
  );
}
