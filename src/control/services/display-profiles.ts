/**
 * Display profiles (spec §52, §46.6) — `save_display_profile` /
 * `list_display_profiles`.
 *
 * Both commands and the `display_profiles` table have existed since the
 * windows module landed, with no TypeScript caller: every stage appearance
 * choice a user makes in Preflight is re-chosen from defaults the next time,
 * on every display.
 *
 * This module is the service half. The UI half belongs in Preflight, which is
 * owned elsewhere; `applyProfileToStageOverrides` is the exact seam it needs —
 * see the note at the bottom of this file.
 */
import type { ListenerGeometry, StageSettings } from '../../shared/contracts';
import { invokeOrMock } from './ipc';

/**
 * Twin of Rust `DisplayProfile` on the way IN. `id` is optional: omitting it
 * creates a profile, supplying one updates it (the Rust upsert is keyed on
 * `id`). `updatedAt` is assigned by Rust and never sent.
 */
export interface DisplayProfileInput {
  id?: string;
  name: string;
  displayFingerprint?: string;
  stage: StageSettings;
  listener?: ListenerGeometry;
}

/** Twin of Rust `DisplayProfile` on the way OUT — id and updatedAt are set. */
export interface DisplayProfileRecord extends DisplayProfileInput {
  id: string;
  updatedAt: string;
}

/**
 * Reasons Rust rejects a profile (windows::save_display_profile), checked here
 * so the UI can refuse before a round trip and so the rules are visible in one
 * place. Returns null when the profile is acceptable.
 */
export function describeProfileProblem(profile: DisplayProfileInput): string | null {
  if (profile.name.trim() === '') return 'A display profile needs a name.';
  if (typeof profile.stage !== 'object' || profile.stage === null) {
    return 'Stage settings must be an object.';
  }
  if (profile.stage.schemaVersion !== 1) {
    return 'Stage settings have an unsupported schema version.';
  }
  return null;
}

export async function saveDisplayProfile(
  profile: DisplayProfileInput,
): Promise<DisplayProfileRecord> {
  const problem = describeProfileProblem(profile);
  if (problem !== null) throw new Error(problem);
  // Rust trims the name itself; sending the trimmed value keeps what the UI
  // shows and what the row stores identical.
  const payload: DisplayProfileInput = { ...profile, name: profile.name.trim() };
  return invokeOrMock<DisplayProfileRecord>('save_display_profile', { profile: payload }, () => ({
    ...payload,
    id: payload.id ?? `mock-profile-${payload.displayFingerprint ?? 'default'}`,
    updatedAt: new Date().toISOString(),
  }));
}

/** Newest first — Rust orders by `updated_at DESC`. */
export async function listDisplayProfiles(): Promise<DisplayProfileRecord[]> {
  return invokeOrMock<DisplayProfileRecord[]>('list_display_profiles', undefined, () => []);
}

/**
 * The profile to apply for a display, or null.
 *
 * Matching is by FINGERPRINT, never by name or position: the fingerprint is
 * panel identity and deliberately survives rearranging or rescaling displays
 * (`DisplayDescriptor.fingerprint`), while `topologyHash` does not. A profile
 * with no fingerprint is a general preset and is never auto-applied — silently
 * adopting it on an unrelated monitor is exactly the surprise §52 is trying to
 * avoid.
 */
export function profileForDisplay(
  profiles: DisplayProfileRecord[],
  fingerprint: string | null,
): DisplayProfileRecord | null {
  if (fingerprint === null || fingerprint === '') return null;
  const matches = profiles.filter((p) => p.displayFingerprint === fingerprint);
  if (matches.length === 0) return null;
  // Most recently updated wins; the Rust ordering already does this, but the
  // caller may have merged lists.
  return [...matches].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]!;
}

/**
 * The appearance controls Preflight actually owns, projected out of a saved
 * `StageSettings`.
 *
 * `buildStageSettings` (services/stage-envelope.ts) turns these back into a
 * full `StageSettings`, so this is its inverse over exactly the fields a user
 * can change. Deriving the booleans from their numeric encodings — rather than
 * storing a second copy — keeps the profile a single source of truth.
 */
export interface StageAppearanceOverrides {
  fontFamilyId: string;
  fontSizePx: number;
  lineHeight: number;
  columnWidthPercent: number;
  readingBandCenterPercent: number;
  mirrorX: boolean;
  mirrorY: boolean;
  pastDimming: boolean;
  phraseHighlight: boolean;
  background: string;
}

export function applyProfileToStageOverrides(stage: StageSettings): StageAppearanceOverrides {
  return {
    fontFamilyId: stage.fontFamilyId,
    fontSizePx: stage.fontSizePx,
    lineHeight: stage.lineHeight,
    columnWidthPercent: stage.columnWidthPercent,
    readingBandCenterPercent: stage.readingBandCenterPercent,
    mirrorX: stage.mirrorX,
    mirrorY: stage.mirrorY,
    // buildStageSettings encodes `pastDimming: false` as pastOpacity 0.92 and
    // `phraseHighlight: false` as currentUnderlayOpacity 0.
    pastDimming: stage.pastOpacity < 0.9,
    phraseHighlight: stage.currentUnderlayOpacity > 0,
    background: stage.background,
  };
}

/**
 * A profile named for the display it belongs to. The name is what the user
 * sees in a picker, so it defaults to the monitor's own name.
 */
export function buildDisplayProfile(
  displayName: string,
  fingerprint: string,
  stage: StageSettings,
  listener?: ListenerGeometry,
  existingId?: string,
): DisplayProfileInput {
  return {
    ...(existingId ? { id: existingId } : {}),
    name: displayName.trim() === '' ? 'Stage display' : displayName.trim(),
    displayFingerprint: fingerprint,
    stage,
    ...(listener ? { listener } : {}),
  };
}

/* ---------------------------------------------------------------------------
 * Preflight seam (the UI change this service is waiting on)
 *
 * Preflight.svelte owns the appearance state (`fontSizePx`, `lineHeight`,
 * `columnWidthPercent`, `readingBandCenterPercent`, `mirrorX`, `mirrorY`,
 * `pastDimming`, `phraseHighlight`, `stageBackground`) and already calls
 * `buildStageSettings(...)` with it at start. Three changes wire §52:
 *
 *  1. On load, after `listDisplays()` resolves and `selectedFingerprint` is
 *     known, call `listDisplayProfiles()` and
 *     `profileForDisplay(profiles, selectedFingerprint)`. If it returns a
 *     profile, spread `applyProfileToStageOverrides(profile.stage)` over the
 *     appearance state and remember `profile.id`.
 *  2. In `selectDisplay(fingerprint)`, repeat step 1 for the newly chosen
 *     display, so switching monitors switches the remembered settings.
 *  3. In the start sequence, immediately after `const stageSettings =
 *     buildStageSettings({...})`, persist it:
 *       void saveDisplayProfile(
 *         buildDisplayProfile(display?.name ?? 'Stage display',
 *                             selectedFingerprint, stageSettings,
 *                             listener?.geometry, rememberedProfileId),
 *       ).then((saved) => (rememberedProfileId = saved.id));
 *     Fire-and-forget with a `.catch` — failing to remember a preference must
 *     never block starting a session.
 * ------------------------------------------------------------------------- */
