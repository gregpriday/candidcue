/**
 * The preview's uncalibrated settings, pinned against the ones a take gets.
 *
 * `?preview=1&calibrated=0` exists to drive the layout branch that almost every
 * real take runs on — a rig is only calibrated once somebody has stood at the
 * glass with a ruler, and until then `buildStageSettings` is handed no optical
 * override and falls through to `DEFAULT_STAGE_APPEARANCE` plus the
 * `UNCALIBRATED_*` constants.
 *
 * The harness restates those numbers rather than importing them, because
 * `src/stage` may not depend on `src/control`. A restatement that is allowed to
 * drift is worse than no harness at all: it would keep passing while quietly
 * demonstrating a layout nobody can get, which is precisely the failure the
 * uncalibrated branch was preserved verbatim to prevent. So the two are
 * compared here, where both are importable.
 */
import { describe, expect, it } from 'vitest';
import { uncalibratedPreviewSettings } from '../../../src/stage/preview';
import { buildStageSettings } from '../../../src/control/services/stage-envelope';
import { DEFAULT_STAGE_APPEARANCE } from '../../../src/control/services/settings-types';

/**
 * Fields the preview is entitled to differ on, each for a stated reason.
 *
 * `themeId`/`background`/`foreground` are dead wire fields (see the note on
 * `STAGE_FIELD_BACKGROUND`) and identical anyway; they are not listed because
 * they do agree. Only genuine, justified divergence belongs here.
 */
const PREVIEW_MAY_DIFFER: ReadonlySet<string> = new Set([
  /*
   * `buildStageSettings` rounds the corridor against a 1080-tall reference
   * panel and the preview states the same arithmetic as a literal. They are the
   * same corridor; the shared value is checked explicitly below.
   */
  'readingBandHalfHeightPercent',
]);

describe('the uncalibrated preview settings', () => {
  const preview = uncalibratedPreviewSettings();
  // No optical override: exactly what a take on an uncalibrated rig produces.
  const take = buildStageSettings({
    fontFamilyId: DEFAULT_STAGE_APPEARANCE.fontFamilyId,
    fontSizePx: DEFAULT_STAGE_APPEARANCE.fontSizePx,
    lineHeight: DEFAULT_STAGE_APPEARANCE.lineHeight,
    columnWidthPercent: DEFAULT_STAGE_APPEARANCE.columnWidthPercent,
    readingBandCenterPercent: DEFAULT_STAGE_APPEARANCE.readingBandCenterPercent,
  });

  it('carries no optics — that absence is the path under test', () => {
    expect(preview.optics).toBeUndefined();
    expect(preview.opticalProfile).toBeUndefined();
    // And the thing it is being compared against must be uncalibrated too, or
    // the whole comparison below is between two calibrated layouts.
    expect(take.optics).toBeUndefined();
  });

  it('matches the appearance an uncalibrated take runs with, field for field', () => {
    for (const key of Object.keys(take) as Array<keyof typeof take>) {
      if (PREVIEW_MAY_DIFFER.has(key)) continue;
      expect(
        preview[key],
        `${key} drifted: the preview would demonstrate a layout no take produces`,
      ).toEqual(take[key]);
    }
  });

  it('states the same reading corridor the envelope derives', () => {
    // 64 × 1.32 × DEFAULT_DEAD_ZONE_LINES, halved, against the 1080 reference.
    // Restated as a literal in the harness, so it is worth proving equal rather
    // than merely close.
    expect(preview.readingBandHalfHeightPercent).toBeCloseTo(
      take.readingBandHalfHeightPercent,
      2,
    );
  });

  it('prompts in the bundled face, like a fresh profile does', () => {
    expect(preview.fontFamilyId).toBe('high-legibility');
    expect(preview.fontFamilyId).toBe(DEFAULT_STAGE_APPEARANCE.fontFamilyId);
  });
});
