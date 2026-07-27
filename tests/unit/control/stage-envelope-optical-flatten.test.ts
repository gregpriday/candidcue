/**
 * The flat twins of the resolved optics.
 *
 * `StageSettings` says the same layout twice: once in `optics`, in line pitches
 * and `ch`, and once in the flat fields a stage build that predates the optical
 * layer lays out from. `fontSizePx` and `columnWidthPercent` were flattened
 * from the start; `lineHeight`, `letterSpacingEm`, `fontWeight`,
 * `paragraphSpacingEm` and the two opacities were not — so a rig the resolver
 * had sized at 1.38 with a past opacity of 0.48 reached an older stage as
 * 1.32/0.42, and reached `readingBandHalfHeightPercent` as 1.32 even on a stage
 * that does read `optics`, putting the reading corridor four percent short on
 * every calibrated take.
 *
 * The existing envelope suite asserts the corridor against
 * `settings.lineHeight`, which is the same expression the implementation uses —
 * so it agrees with whichever value is flattened and cannot see the difference.
 * These name the resolved numbers directly, and separately pin the uncalibrated
 * path to the literals it shipped with, because "keep the old path old" is the
 * rule the whole optical layer was landed under and it is one nothing else
 * checks.
 */
import { describe, expect, it } from 'vitest';
import { buildStageSettings } from '../../../src/control/services/stage-envelope';
import { DEFAULT_STAGE_APPEARANCE } from '../../../src/control/services/settings-types';
import { defaultOpticalProfile, type OpticalProfile } from '../../../src/shared/contracts';
import { DEFAULT_DEAD_ZONE_LINES } from '../../../src/shared/optical-resolve';

const VIEWPORT = { widthPx: 1024, heightPx: 600 };
const MM_PER_CSS_PX = (9 * 25.4) / Math.hypot(1024, 600);

function rig(overrides: Partial<OpticalProfile> = {}): OpticalProfile {
  return {
    ...defaultOpticalProfile(),
    rigName: 'Desk hood',
    hardwareKind: 'elgato-prompter',
    scale: { mmPerCssPx: MM_PER_CSS_PX, source: 'model', diagonalMm: 9 * 25.4 },
    viewingDistanceMm: 1200,
    ...overrides,
  };
}

/** What the Settings screen would pass, so a flat field that ignores the rig shows it. */
const SETTINGS_OVERRIDES = {
  fontSizePx: 64,
  lineHeight: 1.32,
  columnWidthPercent: 78,
  readingBandCenterPercent: 38,
};

function calibrated(profile: OpticalProfile = rig()) {
  return buildStageSettings({ ...SETTINGS_OVERRIDES, optical: { profile, viewport: VIEWPORT } });
}

describe('a calibrated rig says the same layout in both representations', () => {
  it('flattens every resolved value that has a flat twin', () => {
    const settings = calibrated();
    const optics = settings.optics;
    expect(optics).toBeDefined();

    expect(settings.lineHeight).toBe(optics!.lineHeight);
    expect(settings.letterSpacingEm).toBe(optics!.letterSpacingEm);
    expect(settings.fontWeight).toBe(optics!.fontWeight);
    expect(settings.paragraphSpacingEm).toBe(optics!.paragraphSpacingEm);
    expect(settings.pastOpacity).toBe(optics!.pastOpacity);
    expect(settings.futureOpacity).toBe(optics!.futureOpacity);
  });

  /**
   * The line pitch is the one whose absence was measurable rather than merely
   * untidy: an older stage laid out at 1.32 while `optics` said 1.38, and the
   * corridor below was computed from the shorter of the two.
   */
  it('takes the resolved line height over the one the Settings screen passed', () => {
    const settings = calibrated();
    expect(settings.lineHeight).not.toBe(SETTINGS_OVERRIDES.lineHeight);
    expect(settings.lineHeight).toBeGreaterThan(SETTINGS_OVERRIDES.lineHeight);
  });

  it('measures the reading corridor against the pitch the glass will show', () => {
    const settings = calibrated();
    const optics = settings.optics!;
    // Named from `optics`, not from `settings.lineHeight`: reading the flat
    // field back is what let the short corridor pass unnoticed.
    const halfPx = (optics.bodyFontSizePx * optics.lineHeight * optics.deadZoneLines) / 2;
    expect(settings.readingBandHalfHeightPercent).toBeCloseTo(
      (halfPx / VIEWPORT.heightPx) * 100,
      1,
    );
  });

  /**
   * A pinned value is the whole reason the advanced overrides exist. If it does
   * not survive the trip into the flat fields, the control is one more setting
   * that persists and changes nothing.
   */
  it('carries a hand-pinned typography override into the flat field too', () => {
    const settings = calibrated(
      rig({ overrides: { lineHeight: 1.7, fontWeight: 700, paragraphSpacingEm: 1.4 } }),
    );
    expect(settings.lineHeight).toBeCloseTo(1.7, 5);
    expect(settings.fontWeight).toBe(700);
    expect(settings.paragraphSpacingEm).toBeCloseTo(1.4, 5);
    expect(settings.optics!.overriddenFields).toEqual(
      expect.arrayContaining(['lineHeight', 'fontWeight', 'paragraphSpacingEm']),
    );
  });

  /**
   * `applyProfileToStageOverrides` decodes the dimming toggle as
   * `pastOpacity < 0.9`, so "off" has to land above that threshold whatever the
   * rig resolved to — the operator did not ask for a subtler dim, they asked
   * for none.
   */
  it('keeps "past dimming off" encodable when a rig is applied', () => {
    const settings = buildStageSettings({
      ...SETTINGS_OVERRIDES,
      pastDimming: false,
      optical: { profile: rig(), viewport: VIEWPORT },
    });
    expect(settings.pastOpacity).toBeGreaterThanOrEqual(0.9);
    expect(settings.optics!.pastOpacity).toBeLessThan(0.9);
  });
});

describe('an uncalibrated take still renders exactly as it did before the optical layer', () => {
  it('keeps the historical treatment rather than the resolver’s raised default', () => {
    const settings = buildStageSettings();
    // 0.42, deliberately not DEFAULT_PAST_OPACITY (0.48): the raise ships to
    // rigs that opted in, not to somebody who has never opened the wizard.
    expect(settings.pastOpacity).toBe(0.42);
    expect(settings.futureOpacity).toBe(0.92);
    expect(settings.pastOpacity).toBeLessThan(0.48);
  });

  /**
   * Literals, on purpose, and not the resolver's `DEFAULT_*`.
   *
   * The two are equal today. Asserting against the constant would make this
   * test agree with whatever the resolver's defaults become, which is precisely
   * the coupling the uncalibrated path is preserved to avoid — a correction
   * aimed at calibrated rigs would move the old stage and nothing would say so.
   */
  it('keeps the historical type, and attaches no optical claim', () => {
    const settings = buildStageSettings();
    expect(settings.optics).toBeUndefined();
    expect(settings.lineHeight).toBe(DEFAULT_STAGE_APPEARANCE.lineHeight);
    expect(settings.letterSpacingEm).toBe(0);
    expect(settings.paragraphSpacingEm).toBe(0.7);
    // What the renderers already fell back to for a settings document that
    // carried no weight at all, so writing it down moves nothing.
    expect(settings.fontWeight).toBe(500);
    expect(settings.readingBandHalfHeightPercent).toBeCloseTo(
      (((settings.fontSizePx * settings.lineHeight * DEFAULT_DEAD_ZONE_LINES) / 2) / 1080) * 100,
      2,
    );
  });

  /**
   * A panel the window server has not sized yet resolves to arithmetic rather
   * than to a smaller layout, so it takes the uncalibrated path — including
   * these flat fields, which must not quietly become the resolved ones.
   */
  it('takes the uncalibrated treatment when the panel reports no size', () => {
    const settings = buildStageSettings({
      ...SETTINGS_OVERRIDES,
      optical: { profile: rig(), viewport: { widthPx: 0, heightPx: 0 } },
    });
    expect(settings.optics).toBeUndefined();
    expect(settings.lineHeight).toBe(SETTINGS_OVERRIDES.lineHeight);
    expect(settings.pastOpacity).toBe(0.42);
  });
});
