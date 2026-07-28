/**
 * Sidecar recognition and the checklist it justifies.
 *
 * The recognition tests are mostly about what must NOT match. Offering a
 * Sidecar checklist to somebody calibrating their own laptop panel is not a
 * cosmetic miss — it is the app confidently describing a rig that is not there,
 * which is the failure the whole optical layer is written to avoid.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SIDECAR_STRIPS,
  SIDECAR_SIDEBAR_PX,
  SIDECAR_TOUCH_BAR_PX,
  isLikelySidecarDisplay,
  sidecarChecklist,
  sidecarSafeAreaHint,
  type SidecarCheck,
} from './sidecar';
import { identifyHardware, type DisplayShape } from './optical-discovery';

/** 12.9-inch iPad Pro over Sidecar: 1366 x 1024 logical at 2x. */
const ipadPro: DisplayShape = {
  name: "Greg's iPad Pro",
  physicalSize: { width: 2732, height: 2048 },
  scaleFactor: 2,
};

describe('recognising a Sidecar panel', () => {
  it('takes the iPad’s own name as the strong signal', () => {
    expect(isLikelySidecarDisplay(ipadPro)).toBe(true);
    // And agrees with the hardware identification the wizard already made, so
    // the checklist and the hardware step cannot disagree on the same panel.
    expect(identifyHardware(ipadPro).kind).toBe('ipad-sidecar');
  });

  it('recognises an unnamed Sidecar panel from its geometry', () => {
    // Some paths report no name at all; a 2x tablet-sized 4:3 panel is not
    // something else pretending.
    expect(
      isLikelySidecarDisplay({ physicalSize: { width: 2732, height: 2048 }, scaleFactor: 2 }),
    ).toBe(true);
  });

  it('recognises an iPad hung in portrait', () => {
    // A perfectly reasonable way to mount one in a hood, and the same panel.
    expect(
      isLikelySidecarDisplay({ physicalSize: { width: 2048, height: 2732 }, scaleFactor: 2 }),
    ).toBe(true);
  });

  it('never mistakes a MacBook’s built-in panel for an iPad', () => {
    /*
     * The near miss that matters. A 13-inch MacBook Air is 1280 x 832 logical at
     * 2x — an aspect of 1.538 and a long edge inside the tablet range — so a
     * band drawn even slightly wider would put a Sidecar checklist in front of
     * somebody calibrating their own laptop screen.
     */
    expect(
      isLikelySidecarDisplay({ physicalSize: { width: 2560, height: 1664 }, scaleFactor: 2 }),
    ).toBe(false);
    // 15-inch Air, and a 16-inch Pro.
    expect(
      isLikelySidecarDisplay({ physicalSize: { width: 2880, height: 1864 }, scaleFactor: 2 }),
    ).toBe(false);
    expect(
      isLikelySidecarDisplay({ physicalSize: { width: 3456, height: 2234 }, scaleFactor: 2 }),
    ).toBe(false);
  });

  it('never mistakes a 4:3 panel that is not tablet-sized', () => {
    /*
     * Aspect alone would take both of these. The long-edge bounds are the half
     * of the test that knows a tablet from a 4:3 monitor: 1600 x 1200 logical is
     * a desktop panel and 800 x 600 logical is a preview screen, and neither is
     * something the presenter reads a script off at arm's length.
     */
    expect(
      isLikelySidecarDisplay({ physicalSize: { width: 3200, height: 2400 }, scaleFactor: 2 }),
    ).toBe(false);
    expect(
      isLikelySidecarDisplay({ physicalSize: { width: 1600, height: 1200 }, scaleFactor: 2 }),
    ).toBe(false);
  });

  it('never mistakes a squarer panel for a tablet', () => {
    // 1280 x 1024 logical — a 5:4 monitor, inside the size range and below the
    // aspect floor. Without the floor, anything roughly square would match.
    expect(
      isLikelySidecarDisplay({ physicalSize: { width: 2560, height: 2048 }, scaleFactor: 2 }),
    ).toBe(false);
  });

  it('never mistakes a non-Retina panel for a tablet', () => {
    /*
     * The geometry an unnamed 1x XGA projector or an old 4:3 monitor reports —
     * 1024 x 768, 1400 x 1050 — sits squarely inside both the aspect band and
     * the size range. Sidecar is always a Retina link, and that is the only
     * thing separating those two panels from an iPad.
     */
    expect(
      isLikelySidecarDisplay({ physicalSize: { width: 1024, height: 768 }, scaleFactor: 1 }),
    ).toBe(false);
    expect(
      isLikelySidecarDisplay({ physicalSize: { width: 1400, height: 1050 }, scaleFactor: 1 }),
    ).toBe(false);
  });

  it('says no to the panels CandidCue is actually built around', () => {
    expect(
      isLikelySidecarDisplay({
        name: 'Elgato Prompter',
        physicalSize: { width: 1024, height: 600 },
        scaleFactor: 1,
      }),
    ).toBe(false);
    expect(
      isLikelySidecarDisplay({
        name: 'DELL U2720Q',
        physicalSize: { width: 3840, height: 2160 },
        scaleFactor: 2,
      }),
    ).toBe(false);
  });

  it('survives a missing or nonsense display', () => {
    expect(isLikelySidecarDisplay(null)).toBe(false);
    expect(isLikelySidecarDisplay(undefined)).toBe(false);
    expect(isLikelySidecarDisplay({ physicalSize: { width: 0, height: 0 }, scaleFactor: 0 })).toBe(
      false,
    );
  });
});

describe('the checklist', () => {
  const checks = sidecarChecklist();

  it('covers every way Sidecar ruins a take', () => {
    expect(checks.map((c) => c.id)).toEqual([
      'extend-not-mirror',
      'wired-link',
      'hide-strips',
      'stay-on-screen',
      'keep-awake',
      'silence-notifications',
      'steady-brightness',
    ]);
  });

  it('leads with the one that makes prompting impossible', () => {
    // Nothing else on the list matters while the iPad is showing a copy of the
    // Mac's own desktop.
    expect(checks[0]?.id).toBe('extend-not-mirror');
  });

  it('gives every item a reason, not a rule', () => {
    for (const check of checks) {
      expect(check.label.length, check.id).toBeGreaterThan(0);
      // A consequence is a sentence; a rule is a phrase. The floor is here to
      // stop an item degrading into a restatement of its own label.
      expect(check.why.length, check.id).toBeGreaterThan(80);
    }
  });

  it('claims verification for exactly the one thing it can see', () => {
    /*
     * The honesty flag is the load-bearing field. An item marked verifiable is
     * rendered as a statement CandidCue is making; everything else is rendered
     * as a reminder the presenter ticks. Marking a second one true would be the
     * app asserting a fact about a rig it cannot see.
     */
    const verifiable = checks.filter((c) => c.verifiable);
    expect(verifiable.map((c) => c.id)).toEqual(['extend-not-mirror']);
    expect(verifiable[0]?.symptom).not.toBeNull();
  });

  it('says how the unverifiable ones announce themselves, or admits nothing does', () => {
    for (const check of checks) {
      if (check.verifiable) continue;
      // Null is a legitimate answer — it is the honest one for a wireless link
      // and a Night Shift setting — but the field must exist so the UI never
      // has to invent a line.
      expect(check, check.id).toHaveProperty('symptom');
    }
    // The one that does surface — and only once it has cost a take — says so.
    expect(checks.find((c) => c.id === 'stay-on-screen')?.symptom).toContain('already');
  });

  it('hands back a list a caller cannot reorder underneath everyone else', () => {
    /*
     * `readonly` is a compile-time promise, and every caller shares this one
     * array. A JavaScript caller that sorted or spliced it would reorder the
     * checklist for the whole process — including pushing the only item with
     * evidence behind it off the top — so the runtime has to refuse.
     */
    const handed = sidecarChecklist() as SidecarCheck[];
    expect(() => handed.reverse()).toThrow();
    expect(() => handed.splice(0, 1)).toThrow();
    expect(() => {
      handed[0]!.label = 'Mirror away, it is fine';
    }).toThrow();
    expect(sidecarChecklist()[0]?.id).toBe('extend-not-mirror');
    expect(sidecarChecklist()[0]?.label).toBe(checks[0]?.label);
  });
});

describe('the safe-area starting point', () => {
  const viewport = { widthPx: 1366, heightPx: 1024 };

  it('costs the panel a left strip and a bottom strip by default', () => {
    const hint = sidecarSafeAreaHint(viewport);
    expect(hint.applies).toBe(true);
    expect(hint.insets.left).toBeGreaterThan(0);
    expect(hint.insets.bottom).toBeGreaterThan(0);
    expect(hint.insets.top).toBe(0);
    expect(hint.insets.right).toBe(0);
    expect(DEFAULT_SIDECAR_STRIPS).toEqual({ sidebar: 'left', touchBar: 'bottom' });
  });

  it('lands within a percent of the strips it is built from', () => {
    const hint = sidecarSafeAreaHint(viewport);
    expect(hint.insets.left * viewport.widthPx).toBeCloseTo(SIDECAR_SIDEBAR_PX, -1);
    expect(hint.insets.bottom * viewport.heightPx).toBeCloseTo(SIDECAR_TOUCH_BAR_PX, -1);
  });

  it('produces fractions the wizard’s whole-percent sliders hold exactly', () => {
    /*
     * The sliders read `Math.round(inset * 100)` and write `value / 100`. A
     * seeded fraction that is not already whole percent would be shown as one
     * number and stored as another for as long as nobody touched that edge.
     */
    const hint = sidecarSafeAreaHint({ widthPx: 1194, heightPx: 834 });
    for (const value of Object.values(hint.insets)) {
      expect(Math.round(value * 100) / 100).toBe(value);
    }
  });

  it('follows the strips to whichever edge they are on', () => {
    const hint = sidecarSafeAreaHint(viewport, { sidebar: 'right', touchBar: 'top' });
    expect(hint.insets.right).toBeGreaterThan(0);
    expect(hint.insets.top).toBeGreaterThan(0);
    expect(hint.insets.left).toBe(0);
    expect(hint.insets.bottom).toBe(0);
  });

  it('still costs the panel one strip when only the other is off', () => {
    // Hiding the sidebar and keeping the Touch Bar is a normal way to run one,
    // and the remaining strip still eats the bottom of the script.
    const hint = sidecarSafeAreaHint(viewport, { sidebar: 'off' });
    expect(hint.applies).toBe(true);
    expect(hint.insets.left).toBe(0);
    expect(hint.insets.bottom).toBeGreaterThan(0);

    const other = sidecarSafeAreaHint(viewport, { touchBar: 'off' });
    expect(other.applies).toBe(true);
    expect(other.insets.bottom).toBe(0);
    expect(other.insets.left).toBeGreaterThan(0);
  });

  it('suggests nothing when both strips are off', () => {
    const hint = sidecarSafeAreaHint(viewport, { sidebar: 'off', touchBar: 'off' });
    expect(hint.applies).toBe(false);
    expect(hint.insets).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  it('suggests nothing without a viewport to measure against', () => {
    expect(sidecarSafeAreaHint(null).applies).toBe(false);
    expect(sidecarSafeAreaHint(undefined).applies).toBe(false);
    expect(sidecarSafeAreaHint({ widthPx: 0, heightPx: 0 }).applies).toBe(false);
    expect(sidecarSafeAreaHint({ widthPx: Number.NaN, heightPx: 100 }).applies).toBe(false);
  });

  it('never suggests an inset the wizard cannot represent', () => {
    // A tiny viewport would otherwise ask for most of the panel back.
    const hint = sidecarSafeAreaHint({ widthPx: 80, heightPx: 60 });
    expect(hint.insets.left).toBeLessThanOrEqual(0.45);
    expect(hint.insets.bottom).toBeLessThanOrEqual(0.45);
  });

  it('still reports the pixel figures it would have used', () => {
    // The UI shows its working even when it has nothing to seed, because "the
    // sidebar is about 64 px" is useful on its own.
    const hint = sidecarSafeAreaHint(null);
    expect(hint.sidebarPx).toBe(SIDECAR_SIDEBAR_PX);
    expect(hint.touchBarPx).toBe(SIDECAR_TOUCH_BAR_PX);
  });
});
