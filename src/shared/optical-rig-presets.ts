/**
 * Named rig presets: a few one-click starting points for the calibration
 * wizard's optional first step.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE FOUR FIELDS AND NO OTHERS
 * ---------------------------------------------------------------------------
 * A preset writes `hardwareKind`, `viewingDistanceMm`, `flips` and
 * `lensPlacement` — the facts a named rig actually implies. `flips` is worth
 * calling out specifically:
 * `optical-discovery.ts` always leaves it `outstanding`, on the grounds that
 * only a person looking through the glass can supply it, so a preset is the
 * first place in this codebase it gets a starting value at all. Nothing here
 * invents a second home for a fact the profile already has one for: `rigName`,
 * `scale`, `safeArea`, `framing`, `overrides`, `intensity` and `readingCue` are
 * left alone, same as discovery leaves them alone.
 *
 * Known hardware distances are pulled from `defaultDistanceMm()` rather than
 * repeated here as literals, so a preset pick and CandidCue's own auto-discovery
 * can never quietly disagree about the same named hardware. Only the two
 * `generic` presets — desk and studio — need genuinely new numbers, because
 * `generic` has no discoverable default at all.
 *
 * ---------------------------------------------------------------------------
 * PLACEMENT IS IMPLIED BY A RIG'S NAME; THE CROSSHAIR IS NOT
 * ---------------------------------------------------------------------------
 * `lensPlacement` IS in the patch and `lens` is NOT, which is worth spelling
 * out because both have the word "lens" in them. Placement is a fact about the
 * rig's SHAPE: a beamsplitter hood puts the camera behind the glass, and a desk
 * webcam or an iPad puts it at the top edge of the device, outside the picture
 * altogether. Naming the rig settles that — nobody has to look through anything
 * to find out which of the two arrangements they own. The crosshair is the
 * opposite kind of thing: `lens.x` and `lens.y` are where one particular camera
 * ended up in one particular hood, a MEASUREMENT that `discoverProfile()` lists
 * as something "only a person looking through the glass can supply". So the
 * patch carries the shape and leaves the measurement alone.
 *
 * Writing `'in-panel'` on the three beamsplitter presets is not a no-op just
 * because it equals `defaultOpticalProfile()`'s value: it is what lets clicking
 * "Elgato Prompter" CORRECT a profile someone had left on `'above'` from a
 * webcam rig, instead of leaving the reading band pinned to the top edge of
 * glass the camera actually sits behind. It is also what keeps every preset
 * comparable — `profileMatchesPreset` cannot decide which card is selected on a
 * field some presets decline to state.
 *
 * `lens` and `bias` are NOT in a preset's patch at all — not even as the
 * neutral defaults. Presets are the wizard's first step, so a returning
 * presenter clicking their own rig's card would otherwise overwrite the lens
 * crosshair they physically sighted through the glass and the text size they
 * settled on, without being asked. A preset writing ANY crosshair, neutral
 * included, is exactly the kind of unearned confidence this codebase's angular
 * model goes out of its way to avoid elsewhere. Bias is a presenter's taste for
 * size versus measure, not a hardware fact — nothing about standing further from
 * a panel changes what size someone finds comfortable, so it is left to the
 * text-size step. An uncalibrated profile already arrives at both neutral values
 * from `defaultOpticalProfile()`, so leaving them out costs a first-run rig
 * nothing.
 *
 * Pure data, no I/O — lives in `shared/` so both the wizard and its tests can
 * import the same catalog.
 */
import {
  type LensPlacement,
  type OpticalFlips,
  type OpticalHardwareKind,
} from './contracts/optical';
import { defaultDistanceMm } from './optical-discovery';

export interface OpticalRigPreset {
  /** Stable, not persisted — used only to key the UI and derive a selection. */
  id: string;
  label: string;
  /** One sentence describing the physical arrangement this preset assumes. */
  description: string;
  patch: {
    hardwareKind: OpticalHardwareKind;
    viewingDistanceMm: number;
    flips: OpticalFlips;
    lensPlacement: LensPlacement;
  };
}

/**
 * A monitor on the desk with a webcam mounted separately — no glass in the
 * optical path, so the panel reads normally and mirroring must stay off. Getting
 * this wrong is the classic first-run confusion: backwards text on a bare
 * monitor reads as a bug, not as a rig that expected a beamsplitter.
 */
const DESK_AND_WEBCAM_DISTANCE_MM = 600;

/**
 * A larger monitor behind a custom beamsplitter hood, set back further than
 * either Elgato unit. `generic` because CandidCue has no way to know the panel
 * behind an arbitrary hood, only that this arrangement reflects like one.
 */
const STUDIO_GLASS_DISTANCE_MM = 3000;

/**
 * Sitting at your own screen, reading — not being filmed.
 *
 * Closer than `desk-webcam`'s 600 mm even though both are "at a desk", because
 * that preset describes somebody sitting BACK far enough to be in frame, and
 * this one describes somebody reading. 550 mm is the middle of the range the
 * ergonomics literature gives for a display you are reading continuously.
 */
const DESK_READING_DISTANCE_MM = 550;

export const RIG_PRESETS: readonly OpticalRigPreset[] = [
  {
    /*
     * The only preset with no camera in it, which is what makes it the only one
     * whose `lensPlacement` is `'none'`.
     *
     * Everything else in this catalog describes a rig somebody is being FILMED
     * on, and every one of them therefore has an opinion about where the lens is
     * — behind the glass, or above the panel. This one is a person reading a
     * script off a window on their own screen. There is no lens, so the reading
     * band is a preference rather than a derivation, `lensOffsetDegrees` has
     * nothing to measure from, and mirroring must stay off for the same reason
     * `desk-webcam` says so: backwards text on a bare monitor reads as a bug.
     */
    id: 'desk-reading',
    label: 'Reading at a desk',
    description:
      'A window on your own screen, read directly. No camera and no glass, so nothing is mirrored.',
    patch: {
      hardwareKind: 'generic',
      viewingDistanceMm: DESK_READING_DISTANCE_MM,
      flips: { horizontal: false, vertical: false },
      lensPlacement: 'none',
    },
  },
  {
    id: 'desk-webcam',
    label: 'Desk and webcam',
    description: 'A monitor on your desk with a separate webcam. No glass, so the picture reads normally.',
    patch: {
      hardwareKind: 'generic',
      viewingDistanceMm: DESK_AND_WEBCAM_DISTANCE_MM,
      flips: { horizontal: false, vertical: false },
      // The camera is clipped to the top of the monitor or built into the lid;
      // either way it is outside the picture, so the band pins to the top edge
      // rather than being derived from a crosshair inside it.
      lensPlacement: 'above',
    },
  },
  {
    id: 'elgato-prompter',
    label: 'Elgato Prompter',
    description: 'The 9-inch beamsplitter unit. The panel sits close, and the glass reflects the image.',
    patch: {
      hardwareKind: 'elgato-prompter',
      viewingDistanceMm: defaultDistanceMm('elgato-prompter')!,
      flips: { horizontal: true, vertical: false },
      lensPlacement: 'in-panel',
    },
  },
  {
    id: 'elgato-prompter-xl',
    label: 'Elgato Prompter XL',
    description: 'The 15.6-inch beamsplitter unit, usually mounted further from the presenter.',
    patch: {
      hardwareKind: 'elgato-prompter-xl',
      viewingDistanceMm: defaultDistanceMm('elgato-prompter-xl')!,
      flips: { horizontal: true, vertical: false },
      lensPlacement: 'in-panel',
    },
  },
  {
    id: 'studio-glass',
    label: 'Studio glass rig',
    description: 'A larger monitor behind a beamsplitter hood, set further back than a desk unit.',
    patch: {
      hardwareKind: 'generic',
      viewingDistanceMm: STUDIO_GLASS_DISTANCE_MM,
      flips: { horizontal: true, vertical: false },
      lensPlacement: 'in-panel',
    },
  },
  {
    id: 'ipad-rig',
    label: 'iPad rig',
    description: 'An iPad used as a second display over Sidecar, viewed directly rather than through glass.',
    patch: {
      hardwareKind: 'ipad-sidecar',
      viewingDistanceMm: defaultDistanceMm('ipad-sidecar')!,
      flips: { horizontal: false, vertical: false },
      // An iPad's front camera sits on an edge of the housing, never inside the
      // display, so `lens.y` has nothing to describe. `'above'` is the closest
      // truthful answer for a tablet stood the way a prompter is stood — the
      // long-edge camera of a recent iPad in landscape, or any iPad in portrait.
      lensPlacement: 'above',
    },
  },
] as const;

/** The profile fields a preset owns, together — what `matchesPreset` compares. */
export type OpticalRigPresetFields = OpticalRigPreset['patch'];

/**
 * The profile patch a preset applies, as fresh objects.
 *
 * `flips` is the one field here that is an object rather than a value, and each
 * preset's pair is its own inline literal in the catalog above, shared with
 * nothing. The defensive copy is still what stops a caller who mutates the
 * profile's `flips` in place from reaching back into the catalog and changing
 * what every future application of that preset hands out.
 */
export function opticalProfileFieldsForPreset(preset: OpticalRigPreset): OpticalRigPresetFields {
  return {
    hardwareKind: preset.patch.hardwareKind,
    viewingDistanceMm: preset.patch.viewingDistanceMm,
    flips: { ...preset.patch.flips },
    lensPlacement: preset.patch.lensPlacement,
  };
}

/*
 * There is deliberately no `teleprompterMirrorForPreset` here any more.
 *
 * A preset used to write `teleprompter.mirrorX/mirrorY` the instant it was
 * clicked, and this module built that pair. Calibrate no longer does: a preset
 * patches the working profile only, and `finish()` is the one place a flip
 * becomes permanent — reading `profile.flips` directly, because by then the
 * orientation step may have corrected whatever the preset proposed. A helper
 * that turned a PRESET into a settings write would only invite that eager write
 * back, so it went with the code path it existed for.
 */

/**
 * Whether a profile's preset-owned fields already match this preset exactly.
 *
 * Deliberately value-based rather than an identity check against a persisted
 * preset id: a profile a person built by hand, or one auto-discovered for a
 * recognised panel, that happens to land on the same five values IS that
 * preset's configuration, not a coincidence pretending to be one.
 *
 * Takes the wider `OpticalProfile['viewingDistanceMm']` type (`number | null`)
 * rather than `OpticalRigPresetFields` itself, so a full `OpticalProfile` —
 * whose distance is null until asked — can be passed directly without a cast;
 * `null === number` is simply never a match, which is the correct answer for
 * an uncalibrated rig.
 */
export function profileMatchesPreset(
  fields: Omit<OpticalRigPresetFields, 'viewingDistanceMm'> & { viewingDistanceMm: number | null },
  preset: OpticalRigPreset,
): boolean {
  return (
    fields.hardwareKind === preset.patch.hardwareKind &&
    fields.viewingDistanceMm === preset.patch.viewingDistanceMm &&
    fields.flips.horizontal === preset.patch.flips.horizontal &&
    fields.flips.vertical === preset.patch.flips.vertical &&
    fields.lensPlacement === preset.patch.lensPlacement
  );
}
