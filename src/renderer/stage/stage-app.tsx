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
import { EndConfirmOverlay } from './components/EndConfirmOverlay';
import { SpeechPlayer } from './playback/SpeechPlayer';
import { CaptureController } from './audio/CaptureController';
import { commandForKey } from './stage-commands';
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
};

function sendCommand(command: StageCommand): void {
  window.candidcueStage.commands.send(command);
}

export function StageApp(): JSX.Element {
  const [bootstrap, setBootstrap] = useState<StageBootstrap | null>(null);
  const [state, setState] = useState<StageStateProjection>(INITIAL_STATE);
  const [plan, setPlan] = useState<SpeechPlaybackPlan | null>(null);
  const [speechEndedTurnId, setSpeechEndedTurnId] = useState<string | null>(null);
  // Shift+E opens this confirm; only an explicit "End interview" press dispatches
  // END_AFTER_TURN, so the destructive action never fires from one keystroke.
  const [endConfirmOpen, setEndConfirmOpen] = useState(false);

  // Engines live for the lifetime of the window; refs avoid re-creating them.
  const speechPlayerRef = useRef<SpeechPlayer | null>(null);
  const captureRef = useRef<CaptureController | null>(null);
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

  // --- State / plan / capture-config subscriptions ------------------------
  useEffect(() => {
    const offState = window.candidcueStage.events.onState((next) => {
      stateRef.current = next;
      setState(next);
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

    const offCapture = window.candidcueStage.events.onCaptureConfig((config) => {
      // (Re)create the capture controller against the latest config.
      void startCapture(config);
    });

    return () => {
      offState();
      offPlan();
      offCapture();
    };
  }, [startCapture]);

  useEffect(() => {
    return () => {
      void captureRef.current?.dispose();
      captureRef.current = null;
    };
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
        setEndConfirmOpen(true);
        return;
      }
      // stateRef is always current, so the pause/resume toggle reads the latest
      // visual state without re-subscribing the listener.
      const command = commandForKey(event, stateRef.current.visualState);
      if (command === null) {
        return;
      }
      event.preventDefault();
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
      <StatusOverlay state={state} captionsEnabled={captionsEnabled} characterName={characterName} />
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
