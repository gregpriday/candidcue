/**
 * Listener-settings adapter (spec §37, §46.7) between the Rust settings
 * document and the UI view.
 *
 * There used to be two settings structures for one feature: a Rust
 * `ListenerSettings` with `saturation` / `crossfadeMs` / `softPause` /
 * `hardPause` / `hideOnBlank`, typed on this side as an opaque
 * `Record<string, unknown>` and never mapped, and a UI-only `listeners` section
 * living in the localStorage overlay whose three fields (`defaultPackId`,
 * `autoplay`, `dimPercent`) were written by the Settings screen and read by
 * nothing. The stage meanwhile hard-coded the two values Rust declared.
 *
 * They are now one structure, Rust-owned in both directions like `coaching`
 * (§30) and `following` (§47) — no overlay merge, so a stale local copy cannot
 * contradict the persisted document. See the note on `ListenerSettings` in
 * src-tauri/src/settings/mod.rs for what was deleted and why.
 *
 * UNITS: identical on both sides on purpose. `dimPercent` is a percentage here
 * and a percentage in Rust; nothing is converted in flight. The one shipped bug
 * in this feature was an inverted conversion on a persisted value
 * (`listeners.ts`), and the cheapest way not to repeat it is to have no
 * conversion to invert.
 */
import type { ListenerSettings } from './settings-types';

/** Camel-cased twin of `settings::ListenerSettings` in Rust. */
export interface RustListenerSettings {
  /** `null` (Rust `None`) means "no remembered pack", not the empty string. */
  defaultPackId: string | null;
  autoplay: boolean;
  dimPercent: number;
  blurPx: number;
  saturation: number;
  /** §37.4 — the default for `keepListener` on the stage `blank` directive. */
  keepWhenBlanked: boolean;
}

export const LISTENER_SETTING_RANGES = {
  dimPercent: { min: 0, max: 80 },
  blurPx: { min: 0, max: 24 },
  /** Stored as the CSS `saturate()` factor; the UI shows it as a percent. */
  saturation: { min: 0, max: 1 },
} as const;

export function defaultListenerSettings(): ListenerSettings {
  return {
    defaultPackId: null,
    autoplay: true,
    dimPercent: 40,
    blurPx: 0,
    // The look the stage shipped as a hard-coded constant. Kept as the default
    // so reconciling the two structures changed nothing anyone could see.
    saturation: 0.85,
    // Also what shipped: `keepListener: false` was hard-coded on the directive,
    // so blanking took the Listener with it. That stays the default; what
    // changes is that it is now a decision rather than a constant.
    keepWhenBlanked: false,
  };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * Clamp a whole (possibly partial, possibly hostile) listener settings object
 * into the ranges Rust validates. Out-of-range values are pulled to the nearest
 * legal one rather than throwing: a document Rust would refuse to store must
 * still be renderable, and refusing to show the Settings screen because a
 * number drifted is a worse failure than showing the clamped number.
 */
export function clampListenerSettings(patch: Partial<ListenerSettings> | undefined): ListenerSettings {
  const defaults = defaultListenerSettings();
  if (!patch) return defaults;
  const packId = patch.defaultPackId;
  return {
    defaultPackId: typeof packId === 'string' && packId.trim() !== '' ? packId : null,
    autoplay: typeof patch.autoplay === 'boolean' ? patch.autoplay : defaults.autoplay,
    dimPercent: clampNumber(
      patch.dimPercent,
      LISTENER_SETTING_RANGES.dimPercent.min,
      LISTENER_SETTING_RANGES.dimPercent.max,
      defaults.dimPercent,
    ),
    blurPx: clampNumber(
      patch.blurPx,
      LISTENER_SETTING_RANGES.blurPx.min,
      LISTENER_SETTING_RANGES.blurPx.max,
      defaults.blurPx,
    ),
    saturation: clampNumber(
      patch.saturation,
      LISTENER_SETTING_RANGES.saturation.min,
      LISTENER_SETTING_RANGES.saturation.max,
      defaults.saturation,
    ),
    keepWhenBlanked:
      typeof patch.keepWhenBlanked === 'boolean' ? patch.keepWhenBlanked : defaults.keepWhenBlanked,
  };
}

/**
 * Rust → UI. A document written before this section had these fields yields the
 * defaults; an unusable value clamps rather than reaching a CSS filter.
 */
export function listenerFromRust(
  rust: Partial<RustListenerSettings> | undefined,
): ListenerSettings {
  if (!rust) return defaultListenerSettings();
  return clampListenerSettings({
    defaultPackId: rust.defaultPackId ?? null,
    autoplay: rust.autoplay,
    dimPercent: rust.dimPercent,
    blurPx: rust.blurPx,
    saturation: rust.saturation,
    keepWhenBlanked: rust.keepWhenBlanked,
  });
}

/**
 * UI → Rust patch. Only the keys present in the patch are emitted, so a
 * concurrent write to another section is never clobbered.
 *
 * `null` is emitted rather than dropped for `defaultPackId`: Rust's
 * `merge_json` removes a key whose patch value is null and the container's
 * `#[serde(default)]` refills it from `ListenerSettings::default()`, which is
 * `None` — so "forget the remembered pack" round-trips as a clear. Dropping the
 * key would leave the old pack id in the document and the next session would
 * silently reopen a Listener the user had just turned off.
 */
export function listenerToRustPatch(
  patch: Partial<ListenerSettings> | undefined,
): Record<string, unknown> {
  if (!patch) return {};
  const clamped = clampListenerSettings({ ...defaultListenerSettings(), ...patch });
  const out: Record<string, unknown> = {};
  if (patch.defaultPackId !== undefined) out.defaultPackId = clamped.defaultPackId;
  if (patch.autoplay !== undefined) out.autoplay = clamped.autoplay;
  if (patch.dimPercent !== undefined) out.dimPercent = clamped.dimPercent;
  if (patch.blurPx !== undefined) out.blurPx = clamped.blurPx;
  if (patch.saturation !== undefined) out.saturation = clamped.saturation;
  if (patch.keepWhenBlanked !== undefined) out.keepWhenBlanked = clamped.keepWhenBlanked;
  return out;
}
