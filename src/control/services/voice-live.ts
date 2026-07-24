/**
 * Real VoiceFacade implementation — binds the audio package (permissions,
 * device enumeration, level meter/VAD) and the realtime package (WebRTC
 * transcription transport) to the seam the Preflight/Live screens consume
 * (spec §14.2 C, §28, §29).
 *
 * Bound once at control startup via `bindVoiceFacade` when the WebView
 * exposes mediaDevices. The realtime transcription test needs the Tauri
 * runtime (credential minting); in a plain browser it degrades to the same
 * scripted walkthrough the mock uses.
 */
import type {
  AudioDeviceInfo,
  AudioLevelSnapshot,
  RealtimeState,
} from '../../shared/contracts';
import {
  createAnalyserGraph,
  MicrophoneDeviceManager,
  MicrophoneMonitor,
  queryMicrophonePermission,
  releaseStream,
  requestMicrophoneAccess as requestMicAccess,
  type MediaDevicesLike,
  type MediaStreamLike,
  type PermissionsLike,
} from './audio';
import { ManualCommitDriver, WebRtcTranscriptionTransport } from './realtime';
import { ipcInvoke, isTauriRuntime } from './ipc';
import { describeError } from './errors';
import type { TranscriptTestEvents, Unsubscribe, VoiceFacade } from './voice-facade';
import { bindVoiceFacade } from './voice-facade';

function mediaDevices(): MediaDevicesLike | null {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices) return null;
  return navigator.mediaDevices as unknown as MediaDevicesLike;
}

function permissionsApi(): PermissionsLike | undefined {
  if (typeof navigator === 'undefined') return undefined;
  return (navigator as unknown as { permissions?: PermissionsLike }).permissions;
}

export function createRealVoiceFacade(): VoiceFacade {
  let realtimeState: RealtimeState = 'idle';
  const stateSubscribers = new Set<(state: RealtimeState) => void>();
  let deviceManager: MicrophoneDeviceManager | null = null;

  function setRealtimeState(state: RealtimeState): void {
    realtimeState = state;
    for (const cb of stateSubscribers) cb(state);
  }

  function manager(): MicrophoneDeviceManager {
    const devices = mediaDevices();
    if (!devices) throw new Error('MIC_DEVICE_MISSING');
    deviceManager ??= new MicrophoneDeviceManager(devices);
    return deviceManager;
  }

  return {
    async listMicrophones(): Promise<AudioDeviceInfo[]> {
      return manager().listInputs();
    },

    async requestMicrophoneAccess(): Promise<'granted' | 'denied'> {
      const devices = mediaDevices();
      if (!devices) return 'denied';
      const result = await requestMicAccess(devices);
      if (!result.ok) return 'denied';
      // Permission was the goal; release the probe stream immediately (§28.7).
      releaseStream(result.stream);
      return 'granted';
    },

    /**
     * Passive only (spec §28.1): the Permissions API, never getUserMedia. The
     * `change` subscription is what makes a grant issued in System Settings
     * while Preflight is open take effect without a reload. Some platforms
     * cannot query 'microphone' at all — those report 'unsupported' and the
     * UI falls back to the explicit button.
     */
    watchMicrophonePermission(cb): Unsubscribe {
      const permissions = permissionsApi();
      let cancelled = false;
      let detach: (() => void) | null = null;

      void (async () => {
        const initial = await queryMicrophonePermission(permissions);
        if (cancelled) return;
        cb(initial);
        if (initial === 'unsupported' || !permissions) return;
        try {
          const status = await permissions.query({ name: 'microphone' });
          if (cancelled) return;
          const onChange = (): void => cb(status.state);
          status.addEventListener('change', onChange);
          detach = () => status.removeEventListener('change', onChange);
        } catch {
          // Live updates are a nicety; the initial state already shipped.
        }
      })();

      return () => {
        cancelled = true;
        detach?.();
      };
    },

    observeLevels(deviceId, cb): Unsubscribe {
      let cancelled = false;
      let monitor: MicrophoneMonitor | null = null;
      let stream: MediaStreamLike | null = null;
      let offLevel: Unsubscribe | null = null;

      void (async () => {
        const devices = mediaDevices();
        if (!devices) return;
        const result = await requestMicAccess(devices, deviceId ? { deviceId } : {});
        if (!result.ok || cancelled) {
          if (result.ok) releaseStream(result.stream);
          return;
        }
        stream = result.stream;
        monitor = new MicrophoneMonitor({ createGraph: createAnalyserGraph });
        offLevel = monitor.onLevel((snapshot: AudioLevelSnapshot) => cb(snapshot));
        await monitor.start(stream);
        if (cancelled) {
          await monitor.stop();
          releaseStream(stream);
        }
      })();

      return () => {
        cancelled = true;
        offLevel?.();
        if (monitor) void monitor.stop();
        releaseStream(stream);
      };
    },

    async startTranscriptionTest(
      deviceId: string | undefined,
      events: TranscriptTestEvents,
    ): Promise<Unsubscribe> {
      if (!isTauriRuntime()) return scriptedTranscriptionTest(events, setRealtimeState);

      let monitor: MicrophoneMonitor | null = null;
      let activeStream: MediaStreamLike | null = null;
      let commitDriver: ManualCommitDriver | null = null;

      const transport = new WebRtcTranscriptionTransport({
        invoke: ipcInvoke,
        acquireMicrophone: async (preferred) => {
          const devices = mediaDevices();
          if (!devices) throw new Error('MIC_DEVICE_MISSING');
          const wanted = preferred ?? deviceId;
          const result = await requestMicAccess(devices, wanted ? { deviceId: wanted } : {});
          if (!result.ok) throw new Error(result.code);
          activeStream = result.stream;
          // Local VAD drives the manual commit boundaries (§28.4/§29.3).
          monitor = new MicrophoneMonitor({ createGraph: createAnalyserGraph });
          monitor.onVadEvent((event) => commitDriver?.handleVadEvent(event));
          await monitor.start(result.stream);
          return result.stream;
        },
        onConnectProgress: (phase) => setRealtimeState(phase),
      });
      commitDriver = new ManualCommitDriver({
        sendCommit: (reason) => transport.commit(reason),
        clearBufferedAudio: () => transport.clearBufferedAudio(),
        ledger: transport.ledger,
      });

      const offEvents = transport.onEvent((event) => {
        if (event.type === 'delta') {
          events.onPartial(event.text);
        } else if (event.type === 'completed') {
          setRealtimeState('ready');
          events.onFinal(event.text);
        } else if (event.type === 'failed' && !event.recoverable) {
          setRealtimeState('recoverable_error');
          events.onError(describeError(event.code));
        }
      });

      const stop: Unsubscribe = () => {
        offEvents();
        void transport.disconnect('stop').catch(() => {});
        if (monitor) void monitor.stop();
        releaseStream(activeStream);
        activeStream = null;
        setRealtimeState('idle');
      };

      try {
        setRealtimeState('minting_credential');
        await transport.connect({
          model: 'gpt-realtime-whisper',
          language: 'en',
          delay: 'low',
          requestLogprobs: false,
        });
        setRealtimeState('listening');
      } catch (err) {
        stop();
        events.onError(describeError(err));
      }
      return stop;
    },

    getRealtimeState(): RealtimeState {
      return realtimeState;
    },

    subscribeRealtimeState(cb): Unsubscribe {
      stateSubscribers.add(cb);
      return () => stateSubscribers.delete(cb);
    },
  };
}

/** Browser-dev fallback for the transcription test (no credential minting). */
function scriptedTranscriptionTest(
  events: TranscriptTestEvents,
  setState: (state: RealtimeState) => void,
): Unsubscribe {
  setState('listening');
  const phrase = 'CandidCue is following my voice.';
  const words = phrase.split(' ');
  let index = 0;
  const timer = setInterval(() => {
    index += 1;
    if (index < words.length) {
      events.onPartial(words.slice(0, index).join(' '));
    } else {
      events.onFinal(phrase);
      clearInterval(timer);
      setState('ready');
    }
  }, 320);
  return () => {
    clearInterval(timer);
    setState('idle');
  };
}

/** Idempotent startup hook: bind the real facade when audio APIs exist. */
export function bindRealVoiceFacadeIfAvailable(): void {
  if (mediaDevices() === null) return;
  bindVoiceFacade(createRealVoiceFacade());
}
