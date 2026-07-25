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
 * Sensitivity is different in kind. `speech_ended` from the local VAD is the
 * Realtime commit cue (§29.3), so where the speech threshold sits decides how
 * often audio is committed and transcribed on the user's own key. That makes it
 * the same class of setting as `following` (§47) and `coaching` (§30): it
 * changes how a session behaves and what it costs, so it has to outlive the
 * frontend's local storage rather than quietly returning to neutral the first
 * time that store is cleared.
 *
 * TWO SCREENS, ONE VALUE. Settings → Audio is where the setting lives, because
 * it is a property of a room and a microphone rather than of a take. Preflight
 * shows the same control because that is where the mic meter is, and the meter
 * is how anyone discovers they have a problem worth fixing — it observes levels
 * at this same sensitivity, so a change is visible immediately instead of being
 * felt mid-session. Both screens read `settings.audio.vadSensitivity` and both
 * write it with `patchSettings('audio', …)`; the copy below is shared so they
 * cannot drift into describing one value two ways.
 */
/** Camel-cased twin of `settings::AudioSettings` in Rust. */
export interface RustAudioSettings {
  /** Inworld model id, e.g. `inworld/inworld-stt-1`. */
  transcriptionModel: string;
  /** BCP-47 tag, e.g. `en-US` — Inworld wants the region, not a bare `en`. */
  language: string;
  softPauseAutoDisconnectMinutes: number;
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
 * The one description of this control, shared by Settings and Preflight.
 *
 * WHAT THE COPY HAS TO SAY. The slider moves the speech THRESHOLD and nothing
 * else: the 420 ms end-of-turn silence, the 5 s forced commit and the 2 s
 * calibration window are fixed at every position (see VAD_SENSITIVITY_BOUNDS).
 * That bound is the reason the control is safe to offer, so it is stated rather
 * than implied — a user who believes the slider changes how long a pause has to
 * be will move it for the wrong reason and get a worse result.
 *
 * And it is stated as symptoms, not decibels. Nobody knows what their noise
 * floor is; everybody knows whether the app keeps cutting them off. Note which
 * way that particular symptom points: higher is MORE sensitive, so speech has
 * to clear a lower bar to keep a turn open — being cut off mid-sentence is
 * fixed by raising this, not lowering it.
 */
export const VAD_SENSITIVITY_COPY = {
  label: 'Voice-detection sensitivity',
  description:
    'How loud a sound has to be before CandidCue treats it as speech. Raise it if you are cut off mid-sentence or quiet speech is missed; lower it if a fan, a room, or people nearby keep it listening after you have stopped. Nothing else changes: the pause that ends a sentence, and how often audio is sent to OpenAI, are the same at every position.',
  /** 50% is the tuned default, and the readout says so rather than hiding it. */
  format(percent: number): string {
    return percent === VAD_SENSITIVITY_RANGE.neutral * 100 ? 'Default' : `${percent}%`;
  },
} as const;
