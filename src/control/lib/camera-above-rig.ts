/**
 * "Camera above this screen": a laptop's built-in camera, or a webcam clipped
 * to the top of a monitor, set up in one choice (#238).
 *
 * ---------------------------------------------------------------------------
 * AN ORDINARY RIG, STORED AGAINST THE PANEL
 * ---------------------------------------------------------------------------
 * The geometry has existed for a long time — the `desk-webcam` preset puts the
 * lens above the panel, pins the reading line just under it, sizes type for a
 * desk at 600 mm and mirrors nothing — but it was reachable only through the
 * calibration wizard. This builds the same rig with nothing to measure: the
 * panel's own scale from discovery, the preset's distance, lens and flips.
 *
 * It is STORED as the panel's chosen rig rather than derived per take, and that
 * is what makes the way back work without touching a setting. Everything about
 * a take is already per panel: the rig (`prompterOpticalProfile`) and the
 * mirror (`panelMirrorFor`, #206). So with the Elgato pinned, Present lands on
 * the Elgato with its own rig and its own mirror; with it unplugged, Present
 * falls back to the laptop the window is on, which now has this rig chosen and
 * is unmirrored. A launch-only derivation would be forgotten by the next
 * unplugged take, and a third presentation mode would tie camera placement to
 * the window's shape and follow the presenter onto the glass.
 *
 * Pure: settings in, settings out.
 */
import type { OpticalProfile } from '../../shared/contracts';
import {
  discoverProfile,
  type AutomaticProfileSeed,
  type DisplayShape,
} from '../../shared/optical-discovery';
import { RIG_PRESETS, opticalProfileFieldsForPreset } from '../../shared/optical-rig-presets';
import {
  activeOpticalProfile,
  normalizeOpticalProfile,
  opticalRigKey,
  panelMirrorFor,
  withOpticalProfile,
  withPanelMirror,
  type OpticalSettings,
} from '../services/settings-types';

/** What a rig made here is called, before any suffix a collision needs. */
export const CAMERA_ABOVE_RIG_NAME = 'Camera above screen';

/**
 * True for a rig whose camera sits outside the picture — above or below the
 * panel — rather than behind glass in front of it.
 *
 * The test is the lens placement, not the name, so a desk-webcam rig somebody
 * measured in the wizard counts exactly as one made here does: neither has a
 * beamsplitter, and neither is evidence that a take on some OTHER panel is
 * missing its calibration.
 */
export function isCameraOffPanelProfile(profile: OpticalProfile | null | undefined): boolean {
  return profile?.lensPlacement === 'above' || profile?.lensPlacement === 'below';
}

/**
 * True when the panel is a recognised beamsplitter prompter.
 *
 * A camera cannot sit above a screen it is filming through, so choosing
 * "Camera above this screen" with the window on one of these is a mistake about
 * which screen the window is on, not a request — and acting on it would take
 * the glass's mirror away.
 */
export function isPrompterGlass(display: DisplayShape | null | undefined): boolean {
  const kind = discoverProfile(display, null).identification.kind;
  return kind === 'elgato-prompter' || kind === 'elgato-prompter-xl';
}

/**
 * True when the panel's chosen rig puts the camera BEHIND the picture and the
 * panel is mirrored — glass that discovery does not recognise by its grid,
 * somebody's own beamsplitter on an ordinary monitor.
 *
 * Both, not either: a mirrored panel with no rig chosen is the laptop a global
 * mirror switch once flipped by mistake (#206), which is exactly what this
 * choice should put right; and an unmirrored panel with a glass rig has no
 * mirror to lose.
 */
export function isMirroredGlassRig(optical: OpticalSettings, fingerprint: string): boolean {
  const mirror = panelMirrorFor(optical, fingerprint);
  return (
    activeOpticalProfile(optical, fingerprint)?.lensPlacement === 'in-panel' &&
    (mirror.horizontal || mirror.vertical)
  );
}

/**
 * The camera-above-the-screen rig for a panel, measured from nothing.
 *
 * Discovery supplies the scale (a recognised panel, or its own EDID
 * millimetres); the `desk-webcam` preset supplies the rest. A panel discovery
 * cannot size still gets the rig: the lens placement pins the reading line
 * under the camera whatever the type size, and the resolver falls back to its
 * flat size without a scale, labelled as the guess it is.
 *
 * `completedSteps` stays empty: nobody confirmed anything, and the list exists
 * to say what a person did.
 */
export function cameraAboveProfile(
  display: DisplayShape | null | undefined,
  seed?: Partial<AutomaticProfileSeed>,
  rigName: string = CAMERA_ABOVE_RIG_NAME,
): OpticalProfile {
  const preset = RIG_PRESETS.find((candidate) => candidate.id === 'desk-webcam');
  const discovered = discoverProfile(display, null).profile;
  const profile: OpticalProfile = {
    ...discovered,
    ...(preset ? opticalProfileFieldsForPreset(preset) : {}),
    rigName,
    overrides: {},
    completedSteps: [],
  };
  if (seed?.intensity !== undefined) profile.intensity = seed.intensity;
  if (seed?.readingCue !== undefined) profile.readingCue = seed.readingCue;
  if (typeof seed?.bias === 'number' && Number.isFinite(seed.bias)) {
    profile.bias = Math.min(1, Math.max(0, seed.bias));
  }
  return profile;
}

/**
 * Choose the camera-above rig for this panel and unmirror it.
 *
 * Choosing it again must not pile up rigs or throw away an adjustment, so:
 *
 *  1. a camera-above rig already in force on the panel stays — including one
 *     somebody measured in the wizard, which beats anything this could build;
 *  2. otherwise a stored camera-above rig by this name is chosen again as it
 *     was saved, adjustments included: a reading-line position somebody
 *     pinned under This rig › Advanced is a stated preference, and the
 *     resolver lets a stated position win;
 *  3. otherwise a fresh one is stored, under a name no other rig on this panel
 *     is using, because the store keys on (panel, name) and a same-named rig
 *     of another shape is somebody's measurements.
 *
 * Mirroring is the panel's (#206), so it is written here too: a camera above a
 * screen means there is no glass in front of it.
 */
export function withCameraAboveRig(
  optical: OpticalSettings,
  display: DisplayShape & { fingerprint: string },
  seed?: Partial<AutomaticProfileSeed>,
): OpticalSettings {
  const fingerprint = display.fingerprint;
  const unmirrored = { horizontal: false, vertical: false };
  // Above only: a rig with its camera BELOW the panel puts the reading line at
  // the bottom edge, away from the camera this choice names.
  if (activeOpticalProfile(optical, fingerprint)?.lensPlacement === 'above') {
    return withPanelMirror(optical, fingerprint, unmirrored);
  }
  const storedAt = (name: string): OpticalProfile | null =>
    normalizeOpticalProfile(optical.profiles[opticalRigKey(fingerprint, name)]);
  /*
   * A diagonal typed in Settings describes the panel itself, not the glass in
   * front of it, so it is as true of a camera above the screen as of a hood —
   * and on a panel discovery cannot size it is the only size there is. A
   * ruler reading is not carried: it measured the optical path through glass
   * this arrangement does not have.
   */
  const typedScale = activeOpticalProfile(optical, fingerprint)?.scale;
  let name = CAMERA_ABOVE_RIG_NAME;
  for (let suffix = 2; ; suffix += 1) {
    const stored = storedAt(name);
    if (stored === null) {
      const fresh = cameraAboveProfile(display, seed, name);
      if (typedScale?.source === 'diagonal') fresh.scale = { ...typedScale };
      return withPanelMirror(withOpticalProfile(optical, fingerprint, fresh), fingerprint, unmirrored);
    }
    if (stored.lensPlacement === 'above') {
      return withPanelMirror(withOpticalProfile(optical, fingerprint, stored), fingerprint, unmirrored);
    }
    name = `${CAMERA_ABOVE_RIG_NAME} ${suffix}`;
  }
}
