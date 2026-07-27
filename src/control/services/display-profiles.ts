/**
 * Display profiles (spec §52, §46.6) — `save_display_profile` /
 * `list_display_profiles`.
 *
 * What a row is FOR has changed, so it is worth stating plainly. It is not the
 * source of truth for stage appearance: Settings owns type, and
 * `AppSettings.optical` owns the calibrated rigs. A row is the durable RECORD
 * of what a panel last actually ran with — written by `lib/start-take.ts` at
 * the moment a take goes live, and carrying the whole `StageSettings`,
 * including the `optics` that were resolved and the `opticalProfile` they were
 * resolved from.
 *
 * That matters because the optical section lives in the localStorage overlay,
 * which "Clear cache", a fresh profile directory and a reinstalled webview all
 * wipe without warning. The row is what survives that, so
 * `applyProfileToStageOverrides` can hand a measured rig back to the
 * calibration screen instead of asking somebody to re-measure a distance they
 * already measured.
 *
 * One row per panel, though, not one per rig: `rememberDisplayProfile` resolves
 * the panel's existing row and upserts onto it, so what survives a wiped
 * overlay is the arrangement that panel last ran with. An operator who keeps
 * two rigs on one fingerprint gets the one they used last back and re-measures
 * the other. Keeping a row per rig is the change that would close that, and it
 * has to decide what a row is CALLED first — every row is named after the
 * display today, so three of them would arrive at a picker indistinguishable.
 *
 * Deliberately WRITE-ONLY on the take path. The version of §52 that shipped for
 * one afternoon restored a profile only for an explicitly PINNED display, so
 * the default "Automatic" path wrote a row per take and read none, and moving
 * from a pinned panel to Automatic carried the pinned panel's type across and
 * then saved it over the other panel's row. Reading a row to decide appearance
 * is what reintroduces that; reading one to recover a calibration the user asks
 * for is not.
 */
import type {
  ListenerGeometry,
  OpticalProfile,
  ReadingCueStyle,
  ResolvedOptics,
  StageSettings,
  TextIntensity,
} from '../../shared/contracts';
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
 * Every profile saved for a display, most recently updated first.
 *
 * Matching is by FINGERPRINT, never by name or position: the fingerprint is
 * panel identity and deliberately survives rearranging or rescaling displays
 * (`DisplayDescriptor.fingerprint`), while `topologyHash` does not. A profile
 * with no fingerprint is a general preset and is never returned — silently
 * adopting one on an unrelated monitor is exactly the surprise §52 is trying to
 * avoid.
 *
 * All of them rather than one because the caller may hold a list it merged or
 * sorted itself, and `profileForDisplay` — the head of this — is the only
 * consumer that wants a single answer. It is deliberately NOT evidence that a
 * panel has several rows: the take path rewrites one row per panel (see the
 * module header), so this list is one entry deep in practice. The several
 * arrangements a fingerprint can hold live in `AppSettings.optical`.
 */
export function profilesForDisplay(
  profiles: DisplayProfileRecord[],
  fingerprint: string | null,
): DisplayProfileRecord[] {
  if (fingerprint === null || fingerprint === '') return [];
  return profiles
    .filter((p) => p.displayFingerprint === fingerprint)
    // The Rust ordering already does this, but the caller may have merged lists.
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The single default for a display — most recent wins — or null. */
export function profileForDisplay(
  profiles: DisplayProfileRecord[],
  fingerprint: string | null,
): DisplayProfileRecord | null {
  return profilesForDisplay(profiles, fingerprint)[0] ?? null;
}

/**
 * The controls a user can actually change, projected out of a saved
 * `StageSettings`.
 *
 * `buildStageSettings` (services/stage-envelope.ts) turns these back into a
 * full `StageSettings`, so this is its inverse over the appearance controls.
 * Deriving the booleans from their numeric encodings — rather than storing a
 * second copy — keeps the profile a single source of truth.
 *
 * `readingCue` and the two optical fields are the exception, and are read-only
 * here: `buildStageSettings` takes no loose override for any of them because
 * all three are authored on the rig rather than in Settings. They return to a
 * take by way of `opticalProfile`, which carries the cue alongside the
 * measurements — so the projection is for a calibration screen to READ, not a
 * bag to hand straight back.
 *
 * `background` is gone: the stage hard-codes its field colour, so the saved
 * value never described anything, and a projection that kept handing it back
 * would keep a dead control looking answerable. `textIntensity` is what took
 * its place.
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
  textIntensity: TextIntensity;
  readingCue: ReadingCueStyle;
  /**
   * The calibration this row was rendered from, when it had one.
   *
   * This is the field that makes a row worth writing. It is the INPUT — a rig
   * name, a measured scale, a viewing distance, a lens position — so handing it
   * to the calibration screen restores an arrangement somebody measured rather
   * than a set of pixel sizes somebody would have to reverse-engineer.
   */
  opticalProfile?: OpticalProfile;
  /**
   * What that calibration resolved to on the panel the take ran on. Read-only
   * and never authored; carried so a picker can say "24' at 1.4 m, 34
   * characters" without re-resolving against a viewport it does not have.
   */
  optics?: ResolvedOptics;
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
    // Rows written before the optical layer carry neither; they get the same
    // defaults an uncalibrated rig gets rather than a missing field the caller
    // has to test for.
    textIntensity: stage.textIntensity ?? 'standard',
    readingCue: stage.readingCue ?? 'ticks',
    ...(stage.opticalProfile ? { opticalProfile: stage.opticalProfile } : {}),
    ...(stage.optics ? { optics: stage.optics } : {}),
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
