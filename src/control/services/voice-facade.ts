/**
 * Voice facade — the typed seam between the control UI and the audio/realtime
 * services that another agent owns (src/control/services/audio/**,
 * src/control/services/realtime/**). This file defines the interface the UI
 * consumes; integration binds the real implementation with
 * `bindVoiceFacade(...)`. Until then a clearly-marked mock keeps every screen
 * fully drivable.
 */
import type {
  AudioDeviceInfo,
  AudioLevelSnapshot,
  RealtimeState,
} from '../../shared/contracts';

export type Unsubscribe = () => void;

/** Passive permission state; `unsupported` = the platform cannot tell us. */
export type MicPermissionState = 'granted' | 'denied' | 'prompt' | 'unsupported';

export interface TranscriptTestEvents {
  onPartial(text: string): void;
  onFinal(text: string): void;
  onError(message: string): void;
}

/** Contract the audio/realtime agent implements and binds at integration. */
export interface VoiceFacade {
  /** Enumerate input devices. May prompt for permission only when asked to. */
  listMicrophones(): Promise<AudioDeviceInfo[]>;
  /** Explicit permission request (spec §9.1 — never at app launch). */
  requestMicrophoneAccess(): Promise<'granted' | 'denied'>;
  /**
   * Passively observe the microphone permission (spec §28.1). Reports the
   * current state immediately and again whenever it changes, so a grant made
   * in System Settings mid-flow is noticed. MUST never call getUserMedia and
   * therefore never triggers the OS prompt.
   */
  watchMicrophonePermission(cb: (state: MicPermissionState) => void): Unsubscribe;
  /** Local level meter; responds before any OpenAI call (spec §14.2 C). */
  /**
   * §28.4. `vadSensitivity` is the user's 0–1 slider; omitted means the A.6
   * defaults. It is on this seam so the Preflight meter shows the same
   * speech/silence decision the take will make — a sensitivity control the user
   * cannot see the effect of is a control they cannot set.
   */
  observeLevels(
    deviceId: string | undefined,
    cb: (s: AudioLevelSnapshot) => void,
    vadSensitivity?: number,
  ): Unsubscribe;
  /** Temporary realtime transcription test session (spec §14.2 C). */
  startTranscriptionTest(deviceId: string | undefined, events: TranscriptTestEvents): Promise<Unsubscribe>;
  /** Realtime transport state for Live/Preflight status pills. */
  getRealtimeState(): RealtimeState;
  subscribeRealtimeState(cb: (state: RealtimeState) => void): Unsubscribe;
}

let bound: VoiceFacade | null = null;

/** Called once by the audio/realtime integration at startup. */
export function bindVoiceFacade(impl: VoiceFacade): void {
  bound = impl;
}

export function getVoiceFacade(): VoiceFacade {
  return bound ?? mockVoiceFacade;
}

/* ============================================================================
 * MOCK IMPLEMENTATION — awaiting audio/realtime integration.
 * Synthesizes plausible devices, levels, and a transcription test so the
 * Preflight and Live screens are complete and reviewable.
 * ========================================================================== */

const MOCK_DEVICES: AudioDeviceInfo[] = [
  { deviceId: 'default', label: 'MacBook Pro Microphone', isDefault: true, available: true },
  { deviceId: 'usb-1', label: 'Shure MV7 (USB)', isDefault: false, available: true },
];

let mockRealtimeState: RealtimeState = 'idle';
const realtimeSubscribers = new Set<(state: RealtimeState) => void>();

function setMockRealtimeState(state: RealtimeState): void {
  mockRealtimeState = state;
  for (const cb of realtimeSubscribers) cb(state);
}

const mockVoiceFacade: VoiceFacade = {
  async listMicrophones() {
    return MOCK_DEVICES.map((d) => ({ ...d }));
  },

  async requestMicrophoneAccess() {
    await wait(300);
    return 'granted';
  },

  watchMicrophonePermission(cb) {
    // The mock has no real permission to report; behave like a first run so
    // the explicit "Allow and choose microphone" action stays visible.
    const timer = setTimeout(() => cb('prompt'), 0);
    return () => clearTimeout(timer);
  },

  observeLevels(_deviceId, cb) {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const t = (Date.now() - startedAt) / 1000;
      // A gentle speech-like envelope: talk bursts with quiet gaps.
      const burst = Math.max(0, Math.sin(t * 1.4)) * (0.55 + 0.3 * Math.sin(t * 7.3));
      const rms = 0.04 + burst * 0.5;
      cb({
        rms,
        peak: Math.min(1, rms * 1.6),
        noiseFloor: 0.03,
        speaking: rms > 0.18,
        clipped: false,
        signalPresent: true,
        generatedAtMs: Date.now(),
      });
    }, 90);
    return () => clearInterval(timer);
  },

  async startTranscriptionTest(_deviceId, events) {
    setMockRealtimeState('minting_credential');
    await wait(350);
    setMockRealtimeState('listening');
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
        setMockRealtimeState('ready');
      }
    }, 320);
    return () => {
      clearInterval(timer);
      setMockRealtimeState('idle');
    };
  },

  getRealtimeState() {
    return mockRealtimeState;
  },

  subscribeRealtimeState(cb) {
    realtimeSubscribers.add(cb);
    return () => realtimeSubscribers.delete(cb);
  },
};

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
