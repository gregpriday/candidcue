/**
 * Named rig presets: a few one-click starting points for the calibration
 * wizard's optional first step.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE FIVE FIELDS AND NO OTHERS
 * ---------------------------------------------------------------------------
 * A preset writes `hardwareKind`, `viewingDistanceMm`, `flips` and `lens` — the
 * facts a named rig actually implies — plus `bias`, because `OpticalProfile
 * .bias`'s own doc comment is explicit that presets write a value there
 * "rather than living beside it". `flips` and `lens` are worth calling out
 * specifically: `optical-discovery.ts` always leaves both `outstanding`, on the
 * grounds that only a person looking through the glass can supply them, so a
 * preset is the first place in this codebase either gets a starting value at
 * all. Nothing here invents a second home for a fact the profile already has
 * one for: `rigName`, `scale`, `safeArea`, `framing`, `overrides`, `intensity`
 * and `readingCue` are left alone, same as discovery leaves them alone.
 *
 * Known hardware distances are pulled from `defaultDistanceMm()` rather than
 * repeated here as literals, so a preset pick and CandidCue's own auto-discovery
 * can never quietly disagree about the same named hardware. Only the two
 * `generic` presets — desk and studio — need genuinely new numbers, because
 * `generic` has no discoverable default at all.
 *
 * `lens` and `bias` are left at `defaultOpticalProfile()`'s own neutral values
 * for every preset. Lens placement is a fact about where a specific camera
 * sits in a specific hood — `discoverProfile()` already treats it as something
 * "only a person looking through the glass can supply", and a preset guessing
 * a hardware-typical position would be exactly the kind of unearned confidence
 * this codebase's angular model goes out of its way to avoid elsewhere. Bias is
 * a presenter's taste for size versus measure, not a hardware fact — nothing
 * about standing further from a panel changes what size someone finds
 * comfortable, so every preset leaves it at the evidence-backed neutral point
 * and lets the text-size step personalise it.
 *
 * Pure data, no I/O — lives in `shared/` so both the wizard and its tests can
 * import the same catalog.
 */
import {
  defaultOpticalProfile,
  type OpticalFlips,
  type OpticalHardwareKind,
  type LensPosition,
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
    lens: LensPosition;
    bias: number;
  };
}

const NEUTRAL_LENS: LensPosition = { ...defaultOpticalProfile().lens };
const NEUTRAL_BIAS = defaultOpticalProfile().bias;

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

export const RIG_PRESETS: readonly OpticalRigPreset[] = [
  {
    id: 'desk-webcam',
    label: 'Desk and webcam',
    description: 'A monitor on your desk with a separate webcam. No glass, so the picture reads normally.',
    patch: {
      hardwareKind: 'generic',
      viewingDistanceMm: DESK_AND_WEBCAM_DISTANCE_MM,
      flips: { horizontal: false, vertical: false },
      lens: NEUTRAL_LENS,
      bias: NEUTRAL_BIAS,
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
      lens: NEUTRAL_LENS,
      bias: NEUTRAL_BIAS,
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
      lens: NEUTRAL_LENS,
      bias: NEUTRAL_BIAS,
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
      lens: NEUTRAL_LENS,
      bias: NEUTRAL_BIAS,
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
      lens: NEUTRAL_LENS,
      bias: NEUTRAL_BIAS,
    },
  },
] as const;

/** The profile fields a preset owns, together — what `matchesPreset` compares. */
export type OpticalRigPresetFields = OpticalRigPreset['patch'];

/**
 * The profile patch a preset applies, as fresh objects.
 *
 * Every preset's `flips` and `lens` share one literal (`NEUTRAL_LENS`, and the
 * two hard-coded flip pairs above are themselves reused nowhere, but the
 * defensive copy here is what stops a caller who mutates the profile's `lens`
 * or `flips` in place from reaching back into the catalog and changing what
 * every OTHER preset — and every future application of this one — hands out.
 */
export function opticalProfileFieldsForPreset(preset: OpticalRigPreset): OpticalRigPresetFields {
  return {
    hardwareKind: preset.patch.hardwareKind,
    viewingDistanceMm: preset.patch.viewingDistanceMm,
    flips: { ...preset.patch.flips },
    lens: { ...preset.patch.lens },
    bias: preset.patch.bias,
  };
}

/**
 * The `teleprompter` settings write a preset's flips imply.
 *
 * A flip is recorded in two places — the profile, and the settings a real
 * take actually renders mirroring from (`stage-envelope.ts`) — and this is the
 * SECOND of the two, always both axes in one object. Never split this into two
 * separate settings writes: two `patchSettings` calls fired back to back would
 * both capture the same starting revision and race for it, and the backend
 * rejects whichever loses, silently dropping one axis.
 */
export function teleprompterMirrorForPreset(preset: OpticalRigPreset): {
  mirrorX: boolean;
  mirrorY: boolean;
} {
  return { mirrorX: preset.patch.flips.horizontal, mirrorY: preset.patch.flips.vertical };
}

/**
 * Whether a profile's preset-owned fields already match this preset exactly.
 *
 * Deliberately value-based rather than an identity check against a persisted
 * preset id: a profile a person built by hand, or one auto-discovered for a
 * recognised panel, that happens to land on the same seven values IS that
 * preset's configuration, not a coincidence pretending to be one.
 */
export function profileMatchesPreset(
  fields: OpticalRigPresetFields,
  preset: OpticalRigPreset,
): boolean {
  return (
    fields.hardwareKind === preset.patch.hardwareKind &&
    fields.viewingDistanceMm === preset.patch.viewingDistanceMm &&
    fields.flips.horizontal === preset.patch.flips.horizontal &&
    fields.flips.vertical === preset.patch.flips.vertical &&
    fields.lens.x === preset.patch.lens.x &&
    fields.lens.y === preset.patch.lens.y &&
    fields.bias === preset.patch.bias
  );
}
