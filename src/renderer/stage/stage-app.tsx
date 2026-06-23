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
import { SpeechPlayer } from './playback/SpeechPlayer';
import { CaptureController } from './audio/CaptureController';
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

/**
 * Map a held key to a stage command. Returns null for keys we don't handle so
 * the caller can leave the event untouched.
 */
function commandForKey(event: KeyboardEvent): StageCommand | null {
  if (event.shiftKey && event.key === 'Escape') {
    return { type: 'EXIT_STAGE' };
  }
  switch (event.code) {
    case 'Space':
      return { type: 'COMMIT', reason: 'manual' };
    case 'KeyP':
      return { type: 'PAUSE' };
    case 'KeyR':
      return { type: 'REPEAT' };
    case 'KeyS':
      return { type: 'SKIP' };
    default:
      return null;
  }
}

export function StageApp(): JSX.Element {
  const [bootstrap, setBootstrap] = useState<StageBootstrap | null>(null);
  const [state, setState] = useState<StageStateProjection>(INITIAL_STATE);
  const [plan, setPlan] = useState<SpeechPlaybackPlan | null>(null);
  const [speechEndedTurnId, setSpeechEndedTurnId] = useState<string | null>(null);

  // Engines live for the lifetime of the window; refs avoid re-creating them.
  const speechPlayerRef = useRef<SpeechPlayer | null>(null);
  const captureRef = useRef<CaptureController | null>(null);
  const captureConfigRef = useRef<CaptureConfig | null>(null);
  // Latest state, read by event handlers without re-subscribing.
  const stateRef = useRef<StageStateProjection>(INITIAL_STATE);
  const currentTurnIdRef = useRef<string | null>(null);

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
      reportReady: (input) => window.candidcueStage.playback.reportReady(input),
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
  }, []);

  // --- State / plan / capture-config subscriptions ------------------------
  useEffect(() => {
    const offState = window.candidcueStage.events.onState((next) => {
      stateRef.current = next;
      setState(next);
      // Drive the mic gate from the authoritative projection.
      captureRef.current?.setGate(next.micState, currentTurnIdRef.current);
      // Once the visual state reaches 'speaking', start the decoded audio.
      if (next.visualState === 'speaking') {
        speechPlayerRef.current?.start();
      }
    });

    const offPlan = window.candidcueStage.events.onPlaybackPlan((next) => {
      currentTurnIdRef.current = next.turnId;
      setSpeechEndedTurnId(null);
      setPlan(next);
      void speechPlayerRef.current?.load(next);
    });

    const offCapture = window.candidcueStage.events.onCaptureConfig((config) => {
      captureConfigRef.current = config;
      // (Re)create the capture controller against the latest config.
      void startCapture(config);
    });

    return () => {
      offState();
      offPlan();
      offCapture();
    };
    // startCapture is stable via useCallback below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startCapture = useCallback(async (config: CaptureConfig): Promise<void> => {
    // Tear down any previous controller first.
    const previous = captureRef.current;
    captureRef.current = null;
    if (previous !== null) {
      await previous.dispose();
    }

    const controller = new CaptureController({
      sessionId: '',
      deviceId: null,
      config,
      reportMeter: (reading) => window.candidcueStage.audio.reportMeter(reading),
      openPort: (input) => window.candidcueStage.audio.openCapturePort(input),
    });
    captureRef.current = controller;
    try {
      await controller.start();
      controller.setGate(stateRef.current.micState, currentTurnIdRef.current);
    } catch {
      // Capture failed to start; leave the engine torn down. The operator UI
      // surfaces device problems — stage stays silent.
      captureRef.current = null;
      await controller.dispose();
    }
  }, []);

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
      const command = commandForKey(event);
      if (command === null) {
        return;
      }
      event.preventDefault();
      sendCommand(command);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const handleSpeakingReady = useCallback((turnId: string) => {
    // The deck is preloaded; the SpeechPlayer reports its own readiness too, but
    // we surface the deck's readiness only locally (no extra IPC needed).
    void turnId;
  }, []);

  if (bootstrap === null) {
    return <div className={styles.stage} aria-busy="true" />;
  }

  const captionsEnabled = plan?.captionsEnabled ?? false;

  return (
    <div className={styles.stage}>
      <VideoDeck
        bootstrap={bootstrap}
        state={state}
        plan={plan}
        speechEndedTurnId={speechEndedTurnId}
        onSpeakingReady={handleSpeakingReady}
      />
      <StatusOverlay state={state} captionsEnabled={captionsEnabled} />
    </div>
  );
}
