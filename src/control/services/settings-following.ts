/**
 * Following-settings adapter (companion §47) between the Rust settings
 * document and the UI view.
 *
 * These settings genuinely belong in Rust: they change how a *session*
 * behaves, so they must survive a
 * reinstall of the frontend's local storage and be readable by the backend
 * that bills the key. They therefore live in `AppSettings.following`
 * (src-tauri/src/settings/mod.rs) rather than in the documented localStorage
 * overlay used for per-display presentation state.
 *
 * Both directions are pure functions so the round-trip is unit-testable
 * without a Tauri runtime.
 */
import {
  clampFollowing,
  defaultFollowingSettings,
  type FollowingSettings,
} from '../lib/follow-profiles';

/** Camel-cased twin of `settings::FollowingSettings` in Rust. */
export interface RustFollowingSettings {
  feel: string;
  /*
   * No `fidelityMode`. Nothing on either side read it: this adapter stopped
   * mapping it in and sending it back (#218), and Rust dropped the field
   * (#219). serde ignores it on documents that still carry one.
   */
  motionProfileId: string;
  /*
   * No `semanticRequestLimit`: Rust dropped it with the hosted sidecar it
   * capped, and serde ignores it on documents that still carry one.
   */
  developerDiagnostics: boolean;
}

/**
 * Rust → UI. A document written before this section existed simply yields the
 * defaults; unknown enum values clamp rather than throw.
 */
export function followingFromRust(
  rust: Partial<RustFollowingSettings> | undefined,
): FollowingSettings {
  if (!rust) return defaultFollowingSettings();
  return clampFollowing({
    feel: rust.feel,
    motionProfileId: rust.motionProfileId,
    developerDiagnostics: rust.developerDiagnostics,
  } as Partial<FollowingSettings>);
}

/**
 * UI → Rust patch. Only the keys present in the patch are emitted, so a
 * concurrent write to another section is never clobbered. Values are clamped
 * first — the backend re-validates, but a rejected patch is a worse experience
 * than a corrected one.
 */
export function followingToRustPatch(
  patch: Partial<FollowingSettings> | undefined,
): Record<string, unknown> {
  if (!patch) return {};
  const clamped = clampFollowing({ ...defaultFollowingSettings(), ...patch });
  const out: Record<string, unknown> = {};
  if (patch.feel !== undefined) out.feel = clamped.feel;
  if (patch.motionProfileId !== undefined) out.motionProfileId = clamped.motionProfileId;
  if (patch.developerDiagnostics !== undefined) {
    out.developerDiagnostics = clamped.developerDiagnostics;
  }
  return out;
}
