/**
 * Real VoiceFacade implementation — binds the audio package (permissions,
 * device enumeration, level meter) and the Inworld speech-to-text session to
 * the seam the Preflight/Live screens consume (spec §14.2 C, §28, §29).
 *
 * Bound once at control startup via `bindVoiceFacade` when the WebView exposes
 * mediaDevices. The transcription test needs the Tauri runtime — the socket
 * and the API key live in Rust — so in a plain browser it degrades to the same
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
  vadConfigForSensitivity,
  type MediaDevicesLike,
  type MediaStreamLike,
  type PermissionsLike,
} from './audio';
import { PcmCapture } from './audio/capture';
import {
  encodePcm16,
  pushTranscriptionAudio,
  startTranscription,
  stopTranscription,
  sttSessionOptions,
  STT_EVENT,
  type SttFrame,
} from './stt/inworld';
import { getSettingsSnapshot } from '../stores/settings';
import { isTauriRuntime } from './ipc';
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

    observeLevels(deviceId, cb, vadSensitivity): Unsubscribe {
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
        monitor = new MicrophoneMonitor({
          createGraph: createAnalyserGraph,
          ...(vadSensitivity === undefined
            ? {}
            : { vadConfig: vadConfigForSensitivity(vadSensitivity) }),
        });
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

    /**
     * §14.2 C — "say something and watch the words appear".
     *
     * The cheapest end-to-end proof that the key works, the microphone works,
     * and the two are connected. It is deliberately the same path a take uses:
     * one `getUserMedia`, a PCM tap at the pinned rate, and the Rust session.
     * A test that exercised a different path would be able to pass while a take
     * heard nothing, which is exactly the situation this screen exists to rule
     * out.
     */
    async startTranscriptionTest(
      deviceId: string | undefined,
      events: TranscriptTestEvents,
    ): Promise<Unsubscribe> {
      if (!isTauriRuntime()) return scriptedTranscriptionTest(events, setRealtimeState);

      let monitor: MicrophoneMonitor | null = null;
      let activeStream: MediaStreamLike | null = null;
      let capture: PcmCapture | null = null;
      let generation: number | null = null;
      let unlisten: (() => void) | null = null;
      let sendChain: Promise<void> = Promise.resolve();
      let stopped = false;

      const stop: Unsubscribe = () => {
        if (stopped) return;
        stopped = true;
        unlisten?.();
        unlisten = null;
        const closing = generation;
        generation = null;
        if (closing !== null) void stopTranscription(closing).catch(() => {});
        void capture?.stop();
        capture = null;
        if (monitor) void monitor.stop();
        monitor = null;
        releaseStream(activeStream);
        activeStream = null;
        setRealtimeState('idle');
      };

      try {
        setRealtimeState('minting_credential');
        const devices = mediaDevices();
        if (!devices) throw new Error('MIC_DEVICE_MISSING');
        const result = await requestMicAccess(devices, deviceId ? { deviceId } : {});
        if (!result.ok) throw new Error(result.code);
        activeStream = result.stream;

        monitor = new MicrophoneMonitor({ createGraph: createAnalyserGraph });
        await monitor.start(result.stream);

        const { listen } = await import('@tauri-apps/api/event');
        unlisten = await listen<SttFrame>(STT_EVENT, (event) => {
          const frame = event.payload;
          if (generation !== null && frame.generation !== generation) return;
          if (frame.kind === 'partial') {
            events.onPartial(frame.text);
          } else if (frame.kind === 'final') {
            setRealtimeState('ready');
            events.onFinal(frame.text);
          } else if (frame.kind === 'failed') {
            setRealtimeState('recoverable_error');
            events.onError(describeError(frame.code));
            if (!frame.recoverable) stop();
          }
        });

        /*
         * The SAME options a take would use, from the same settings, through
         * the same builder.
         *
         * This call used to pass nothing, so Rust applied its own defaults and
         * the test passed unconditionally — including on an installation whose
         * saved settings named the previous provider's model, where every real
         * take failed. A microphone test that exercises a configuration the
         * take will not use cannot answer the only question it is asked.
         */
        generation = await startTranscription(sttSessionOptions(getSettingsSnapshot().inworld));
        capture = new PcmCapture({
          onFrame: (samples) => {
            const current = generation;
            if (current === null || stopped) return;
            const chunk = encodePcm16(samples);
            sendChain = sendChain
              .then(() => pushTranscriptionAudio(current, chunk))
              .catch(() => {});
          },
        });
        await capture.start(result.stream);
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
