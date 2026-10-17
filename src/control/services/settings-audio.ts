/**
 * Audio-settings adapter (spec §28.3, §28.4) between the Rust settings document
 * and the UI view.
 *
 * Only ONE field in the UI's `audio` section is Rust-owned: `vadSensitivity`.
 * The rest of the section — the preferred device id, the three getUserMedia
 * processing toggles — is per-machine capture state and stays in the documented
 * localStorage overlay, where a device id that does not exist on another
 * machine belongs.
 *
 * Sensitivity is different in kind. It describes a room and a microphone
 * rather than a machine, and it is the number both meters judge speech by, so
 * it belongs with `following` (§47): it changes what the app reports about a
 * session, and it has to outlive the frontend's local storage rather than
 * quietly returning to neutral the first time that store is cleared.
 *
 * (It used to be Rust-owned for a stronger reason — `speech_ended` was the
 * commit cue for a hosted recogniser, so the threshold decided how much audio
 * was sent and billed. That recogniser is gone and nothing commits any more.
 * The setting stays server-side because a room's noise floor is still not
 * per-machine capture state, not because it costs anything.)
 *
 * ONE SLIDER, AND BOTH METERS READ IT. Settings → Audio is where the setting
 * lives, because it is a property of a room and a microphone rather than of a
 * take. It sits next to the mic meter, which is how anyone discovers they have
 * a problem worth fixing — the meter observes at this same sensitivity, so a
 * change is visible immediately instead of being felt mid-session. Preflight
 * used to carry a second copy of the control; it is gone, and the invariant
 * that outlived it is that the meter in Settings and the monitor during a take
 * both read this saved value, so the one you tune against is the one you get.
 *
 * It decides what the METER calls speech, and nothing else. Audio streams to
 * the recogniser unconditionally at every position — see the description below.
 */
/** Camel-cased twin of `settings::AudioSettings` in Rust. */
export interface RustAudioSettings {
  /** The bundled recogniser's name, e.g. `x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05`. */
  transcriptionModel: string;
  /** BCP-47 tag, e.g. `en-US`. Rust repairs a tag the selected recogniser
   * cannot transcribe; the bundled one is bilingual (`zh-en`). */
  language: string;
  /*
   * No `softPauseAutoDisconnectMinutes`: nothing ever disconnected on it, and
   * Rust dropped it (#219).
   */
  /** 0-1; 0.5 is the Appendix A.6 neutral (§28.4). */
  vadSensitivity: number;
}

export const VAD_SENSITIVITY_RANGE = {
  min: 0,
  max: 1,
  /** Exactly the A.6 defaults — see `vadConfigForSensitivity`. */
  neutral: 0.5,
} as const;

/**
 * Normalize an untrusted sensitivity.
 *
 * Out-of-range and non-finite values fall back to the NEUTRAL midpoint rather
 * than clamping to the nearest end, matching `vadConfigForSensitivity`: a
 * corrupt setting must not silently become the most aggressive configuration
 * available. A value that is merely outside the range is still clamped, because
 * that is a slider that moved, not a document that is wrong.
 */
export function clampVadSensitivity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return VAD_SENSITIVITY_RANGE.neutral;
  return Math.min(VAD_SENSITIVITY_RANGE.max, Math.max(VAD_SENSITIVITY_RANGE.min, value));
}

/**
 * Rust → UI. A document written before the field existed yields the neutral
 * midpoint, which is the value those users were already running.
 */
export function vadSensitivityFromRust(rust: Partial<RustAudioSettings> | undefined): number {
  return clampVadSensitivity(rust?.vadSensitivity);
}

/**
 * UI → Rust patch. Only the keys present in the patch are emitted, so a
 * concurrent write to another section is never clobbered, and only the fields
 * Rust owns are emitted at all — the overlay keeps the rest.
 */
export function audioToRustPatch(
  patch: { vadSensitivity?: number } | undefined,
): Record<string, unknown> {
  if (!patch || patch.vadSensitivity === undefined) return {};
  return { vadSensitivity: clampVadSensitivity(patch.vadSensitivity) };
}

/** The keys of the UI `audio` section that Rust owns; the rest overlay. */
export const RUST_OWNED_AUDIO_KEYS = ['vadSensitivity'] as const;

/**
 * The one description of this control, used by Settings → Audio.
 *
 * WHAT THE COPY HAS TO SAY. The slider moves the speech THRESHOLD and nothing
 * else: the 420 ms end-of-turn silence, the 5 s forced commit and the 2 s
 * calibration window are fixed at every position (see VAD_SENSITIVITY_BOUNDS).
 * That bound is the reason the control is safe to offer, so it is stated rather
 * than implied — a user who believes the slider changes how long a pause has to
 * be will move it for the wrong reason and get a worse result.
 *
 * And it is stated as symptoms, not decibels. Nobody knows what their noise
 * floor is; everybody knows whether the meter says it can hear them. Both
 * symptoms are meter symptoms, which is the honest scope: the recogniser gets
 * the audio either way, so what this rescues is a readout that disagrees with
 * the room, not a transcript.
 *
 * Note which way those symptoms point, because the shipped string had it
 * backwards once (#120) while this comment did not. Higher is MORE sensitive —
 * speech clears a lower bar — so quiet speech that never registers is fixed by
 * RAISING this, and a room that holds the meter open is fixed by LOWERING it.
 * The pairing is pinned in audio-settings-ipc-contract.test.ts against the
 * bounds themselves; keep them in step.
 */
export const VAD_SENSITIVITY_COPY = {
  label: 'Voice-detection sensitivity',
  description:
    'How easily the meter counts a sound as speech. Lower it if a fan or people nearby keep the indicator lit after you have stopped; raise it if quiet speech does not register. This does not gate what is transcribed — the recogniser hears everything the microphone does, at every position on this slider.',
  /** 50% is the tuned default, and the readout says so rather than hiding it. */
  format(percent: number): string {
    return percent === VAD_SENSITIVITY_RANGE.neutral * 100 ? 'Default' : `${percent}%`;
  },
} as const;
