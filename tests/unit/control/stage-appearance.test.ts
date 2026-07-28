/**
 * The appearance controls' shared arithmetic.
 *
 * These ranges are drawn by two screens now — Settings before a take, the
 * in-session sheet during one — and the failure they exist to prevent is not a
 * crash but a disagreement: a slider whose maximum sits BELOW its own value
 * silently rewrites that value the first time it is touched, and the operator
 * has no way to see that it did.
 */
import { describe, expect, it } from 'vitest';
import {
  ADVANCED_FONT_SIZE_CEILING_PX,
  APPEARANCE_LIMITS,
  clampStageAppearance,
  readStageAppearance,
  stageAppearanceEquals,
  typeCeilingPx,
  type StageAppearance,
} from '../../../src/control/lib/stage-appearance';
import { defaultAppSettings } from '../../../src/control/services/settings-types';

const BASE: StageAppearance = {
  textIntensity: 'standard',
  fontSizePx: 64,
  lineHeight: 1.32,
  columnWidthPercent: 78,
  readingBandCenterPercent: 38,
};

describe('the size ceiling', () => {
  it('is 320px for every ordinary rig', () => {
    expect(typeCeilingPx(24)).toBe(320);
    expect(typeCeilingPx(64)).toBe(320);
    expect(typeCeilingPx(320)).toBe(320);
  });

  /*
   * The case the ceiling exists for: a per-rig override put the size above what
   * the ordinary slider offers. Clamping it down would rewrite a hand-set value
   * the moment somebody opened the panel it is shown on.
   */
  it('follows a larger stored value rather than clamping it', () => {
    expect(typeCeilingPx(400)).toBe(400);
    expect(typeCeilingPx(512)).toBe(ADVANCED_FONT_SIZE_CEILING_PX);
  });

  it('treats anything past the advanced ceiling as damage to repair', () => {
    expect(typeCeilingPx(9000)).toBe(ADVANCED_FONT_SIZE_CEILING_PX);
  });
});

describe('clamping an appearance', () => {
  it('holds every value inside the range its control draws', () => {
    const clamped = clampStageAppearance({
      ...BASE,
      fontSizePx: 4,
      lineHeight: 9,
      columnWidthPercent: 500,
      readingBandCenterPercent: -20,
    });
    expect(clamped.fontSizePx).toBe(APPEARANCE_LIMITS.fontSizePx.min);
    expect(clamped.lineHeight).toBe(APPEARANCE_LIMITS.lineHeight.max);
    expect(clamped.columnWidthPercent).toBe(APPEARANCE_LIMITS.columnWidthPercent.max);
    expect(clamped.readingBandCenterPercent).toBe(APPEARANCE_LIMITS.readingBandCenterPercent.min);
  });

  it('leaves a rig-sized value alone', () => {
    expect(clampStageAppearance({ ...BASE, fontSizePx: 400 }).fontSizePx).toBe(400);
  });

  /*
   * The self-derived ceiling is a READING rule, and applying a change under it
   * is how `+` held down past the top of the slider landed on 512px: the
   * requested size was taken as evidence that a size that large was allowed.
   * A caller applying a change passes the ceiling it is changing FROM.
   */
  it('bounds a change by where it came from, not by what it asked for', () => {
    const stepped = clampStageAppearance({ ...BASE, fontSizePx: 1064 }, typeCeilingPx(BASE.fontSizePx));
    expect(stepped.fontSizePx).toBe(320);
    // ...and a rig that legitimately sits above the ordinary ceiling still can.
    const onARig = clampStageAppearance({ ...BASE, fontSizePx: 1064 }, typeCeilingPx(400));
    expect(onARig.fontSizePx).toBe(400);
  });

  /*
   * NaN reaches here from a range input that was handed a non-numeric value.
   * Passing it through would put NaN into `StageSettings.fontSizePx`, and the
   * take would render at no size at all.
   */
  it('answers a non-number with the floor rather than passing it on', () => {
    expect(clampStageAppearance({ ...BASE, fontSizePx: Number.NaN }).fontSizePx).toBe(
      APPEARANCE_LIMITS.fontSizePx.min,
    );
  });
});

describe('comparing two appearances', () => {
  it('reads a float that came off a range input as unchanged', () => {
    expect(stageAppearanceEquals(BASE, { ...BASE, lineHeight: 1.32 + 1e-12 })).toBe(true);
  });

  it('sees a real step', () => {
    expect(stageAppearanceEquals(BASE, { ...BASE, lineHeight: 1.33 })).toBe(false);
    expect(stageAppearanceEquals(BASE, { ...BASE, textIntensity: 'strong' })).toBe(false);
    expect(stageAppearanceEquals(BASE, { ...BASE, readingBandCenterPercent: 39 })).toBe(false);
  });
});

describe('reading a damaged appearance', () => {
  /*
   * The settings overlay does not validate the types of its scalars, so a
   * hand-edited store hands back a string where a number belongs. Read straight
   * through, that reaches a panel which calls `.toFixed()` on it — a render
   * error thrown over a running take, on the screen being read from.
   */
  it('repairs a value that is not a number', () => {
    const damaged = readStageAppearance({
      ...BASE,
      lineHeight: '1.4' as unknown as number,
      fontSizePx: Number.NaN,
    });
    expect(typeof damaged.lineHeight).toBe('number');
    expect(Number.isFinite(damaged.fontSizePx)).toBe(true);
  });

  it('repairs an intensity that is not one of the three', () => {
    const damaged = readStageAppearance({
      ...BASE,
      textIntensity: 'blazing' as unknown as StageAppearance['textIntensity'],
    });
    expect(damaged.textIntensity).toBe('standard');
  });

  /*
   * TYPE repair, not range repair. A rig legitimately resolves values outside
   * what the sliders offer, and this is the function that says what is on the
   * glass — clamping here is how a readout starts lying.
   */
  it('leaves a rig-resolved value outside the slider range alone', () => {
    const resolved = readStageAppearance({ ...BASE, lineHeight: 2, columnWidthPercent: 30 });
    expect(resolved.lineHeight).toBe(2);
    expect(resolved.columnWidthPercent).toBe(30);
  });
});

describe('reading an appearance off the saved settings', () => {
  /*
   * Field names are shared with `teleprompter` on purpose — the sheet patches
   * straight back into that section, and a rename on one side would be a silent
   * no-op rather than a type error. This is what notices.
   */
  it('takes the five fields the sheet owns, unaltered', () => {
    const t = defaultAppSettings().teleprompter;
    expect(readStageAppearance(t)).toEqual({
      textIntensity: t.textIntensity,
      fontSizePx: t.fontSizePx,
      lineHeight: t.lineHeight,
      columnWidthPercent: t.columnWidthPercent,
      readingBandCenterPercent: t.readingBandCenterPercent,
    });
  });
});
