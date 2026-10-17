import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/shared/markdown';
import {
  buildStageEnvelope,
  buildStageRenderDocument,
  buildStageSettings,
  stageSettingsFromSettings,
} from '../../../src/control/services/stage-envelope';
import {
  DEFAULT_STAGE_APPEARANCE,
  defaultAppSettings,
  withPanelMirror,
} from '../../../src/control/services/settings-types';
import type { DisplayDescriptor } from '../../../src/control/services/stage-types';
import {
  defaultFollowingSettings,
  resolveFollowProfile,
} from '../../../src/control/lib/follow-profiles';
import {
  DEFAULT_SMOOTH_FOLLOW_PROFILE,
  defaultOpticalProfile,
  type OpticalProfile,
} from '../../../src/shared/contracts';
import { DEFAULT_DEAD_ZONE_LINES } from '../../../src/shared/optical-resolve';
import {
  ANGULAR_PRESET_ARCMIN,
  arcminutesForFontSizePx,
  fallbackFontMetrics,
} from '../../../src/shared/optics';
import { stageFollowProfile } from '../../../src/stage/motion';

const SOURCE = `# Welcome back

This is the opening paragraph with enough words to make several tokens.

[Take: Second take]

## Chapter two

Another paragraph follows here, and it also carries a full sentence.
`;

function compiled() {
  return compile(SOURCE, { scriptId: 'script-1' });
}

describe('stage envelope construction (spec §29.2 / §43.3)', () => {
  it('projects a compiled script into a hydration-ready render document', () => {
    const script = compiled();
    const doc = buildStageRenderDocument(script);

    expect(doc.schemaVersion).toBe(1);
    expect(doc.blocks.length).toBe(script.blocks.length);

    // Sentences are carried so the stage draws the phrase underlay (§16.2).
    expect(doc.sentences).toBeDefined();
    expect(doc.sentences!.length).toBe(script.sentences.length);
    expect(doc.sentences!.length).toBeGreaterThan(0);
    for (const sentence of doc.sentences!) {
      expect(sentence.endTokenIndex).toBeGreaterThanOrEqual(sentence.startTokenIndex);
      expect(sentence.blockId).toBeTruthy();
    }

    // tokenToNode covers every spoken token in order.
    expect(doc.tokenToNode.length).toBe(script.spokenTokens.length);
    doc.tokenToNode.forEach((entry, i) => {
      expect(entry.tokenIndex).toBe(script.spokenTokens[i]!.index);
      expect(entry.blockId).toBe(script.spokenTokens[i]!.blockId);
    });

    // Heading blocks keep their level hints for the stage renderer.
    const headings = doc.blocks.filter((b) => b.kind === 'heading');
    expect(headings.length).toBeGreaterThanOrEqual(2);
    for (const heading of headings) {
      expect(typeof heading.layoutHints?.level).toBe('number');
    }

    // Take markers surface as take/takeLabel layout hints on their block.
    const takeBlocks = doc.blocks.filter((b) => b.layoutHints?.take === true);
    expect(takeBlocks.length).toBeGreaterThanOrEqual(1);
    expect(takeBlocks[0]!.layoutHints?.takeLabel).toBe('Second take');
  });

  it('builds a schema-valid session envelope the Rust validator accepts', () => {
    const script = compiled();
    const envelope = buildStageEnvelope({
      script,
      sessionId: 'session-1',
      sessionGeneration: 1,
      stageGeneration: 7,
      stageSettings: buildStageSettings({ fontSizePx: 72, mirrorX: true }),
    });

    // The exact fields publish_stage_document validates (windows/mod.rs).
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.sessionId).toBe('session-1');
    expect(envelope.stageGeneration).toBe(7);
    expect(envelope.scriptId).toBe('script-1');
    expect(envelope.sourceHash).toBe(script.sourceHash);
    expect(envelope.initialTokenIndex).toBe(0);
    expect(envelope.stageSettings.fontSizePx).toBe(72);
    expect(envelope.stageSettings.mirrorX).toBe(true);
    expect(envelope.renderDocument.sentences!.length).toBeGreaterThan(0);

    // Envelope must stay within the Rust 8 MB cap for realistic scripts.
    expect(JSON.stringify(envelope).length).toBeLessThan(8 * 1024 * 1024);
  });
});

/*
 * The optical seam.
 *
 * `resolveStageGeometry` is where a measured rig becomes geometry, and
 * `buildStageSettings` is the only place control calls it. Two things have to
 * hold or a calibration is decorative:
 *
 *   1. The resolved block reaches the envelope at all.
 *   2. The LEGACY fields carry the resolved numbers too. A stage build that
 *      predates `optics` lays out from `fontSizePx`/`columnWidthPercent`, so if
 *      those kept carrying the Settings-screen values a rig somebody had just
 *      measured would prompt at the uncalibrated size on the exact panel they
 *      measured it on — inside an envelope containing a full, plausible,
 *      entirely ignored optical block.
 */
describe('a calibrated rig reaches the stage as geometry (shared/optical-resolve)', () => {
  /** A 9-inch prompter, 1024x600, standing 1.2 m away. */
  const VIEWPORT = { widthPx: 1024, heightPx: 600 };
  const MM_PER_CSS_PX = (9 * 25.4) / Math.hypot(1024, 600);

  function rig(overrides: Partial<OpticalProfile> = {}): OpticalProfile {
    return {
      ...defaultOpticalProfile(),
      rigName: 'Desk hood',
      hardwareKind: 'elgato-prompter',
      scale: { mmPerCssPx: MM_PER_CSS_PX, source: 'model', diagonalMm: 9 * 25.4 },
      viewingDistanceMm: 1200,
      completedSteps: ['hardware', 'distance'],
      ...overrides,
    };
  }

  /** Everything a Settings screen would pass, so the resolver has to beat it. */
  const SETTINGS_OVERRIDES = {
    fontSizePx: 64,
    lineHeight: 1.32,
    columnWidthPercent: 78,
    readingBandCenterPercent: 38,
    textIntensity: 'soft' as const,
  };

  it('attaches the resolved block and the calibration that produced it', () => {
    const profile = rig();
    const settings = buildStageSettings({
      ...SETTINGS_OVERRIDES,
      optical: { profile, viewport: VIEWPORT },
    });

    expect(settings.optics).toBeDefined();
    expect(settings.optics!.calibrated).toBe(true);
    expect(settings.optics!.viewingDistanceMm).toBe(1200);
    // The profile rides along so re-opening the wizard does not start from
    // nothing, and so a §52 row can hand a measured rig back later.
    expect(settings.opticalProfile).toEqual(profile);
    // Control cannot measure a font it does not render; the result says so
    // rather than presenting DIN ratios as a measurement.
    expect(settings.optics!.metricsMeasured).toBe(false);
  });

  it('sizes the LEGACY font field by visual angle, overruling the settings value', () => {
    const settings = buildStageSettings({
      ...SETTINGS_OVERRIDES,
      // Pinned rather than defaulted, so the assertion below can name a rung of
      // the ladder instead of recomputing whatever the shipped default bias
      // happens to be — which would leave the test agreeing with the code by
      // construction and asserting nothing.
      optical: { profile: rig({ bias: 0.5 }), viewport: VIEWPORT },
    });

    expect(settings.fontSizePx).not.toBe(SETTINGS_OVERRIDES.fontSizePx);
    // The whole claim, checked in the units the optical model is stated in:
    // what an old stage renders at `fontSizePx` subtends the angle the bias
    // asked for. Bias 0.5 is the middle of the ladder — 24 arcminutes of cap.
    const subtended = arcminutesForFontSizePx(settings.fontSizePx, {
      distanceMm: 1200,
      mmPerCssPx: MM_PER_CSS_PX,
      metrics: fallbackFontMetrics(),
    });
    expect(subtended).toBeCloseTo(ANGULAR_PRESET_ARCMIN.standard, 0);
  });

  it('grows the type when the presenter stands further back', () => {
    const near = buildStageSettings({
      optical: { profile: rig({ viewingDistanceMm: 1200 }), viewport: VIEWPORT },
    });
    const far = buildStageSettings({
      optical: { profile: rig({ viewingDistanceMm: 2400 }), viewport: VIEWPORT },
    });
    // Double the distance, double the physical size, same visual angle. This is
    // the behaviour a percentage-of-viewport default cannot express at all.
    expect(far.fontSizePx / near.fontSizePx).toBeCloseTo(2, 1);
    expect(far.optics!.bodyArcminutes).toBeCloseTo(near.optics!.bodyArcminutes!, 0);
  });

  it('sets the legacy column from the resolved measure, not from the slider', () => {
    const settings = buildStageSettings({
      ...SETTINGS_OVERRIDES,
      optical: { profile: rig(), viewport: VIEWPORT },
    });

    expect(settings.columnWidthPercent).not.toBe(SETTINGS_OVERRIDES.columnWidthPercent);
    // The two mechanisms must describe the same column: `columnCh` × the `ch`
    // advance at the resolved size, as a fraction of the panel.
    const expectedPx =
      settings.optics!.columnCh * fallbackFontMetrics().zeroAdvanceRatio * settings.fontSizePx;
    expect(settings.columnWidthPercent).toBe(
      Math.round((expectedPx / VIEWPORT.widthPx) * 100),
    );
  });

  it('folds the safe area back into the reading band position', () => {
    // `readingBandY` is a fraction of the SAFE rectangle — a hood hiding the top
    // of the panel moves the band down the glass without moving it within what
    // the presenter can see. A renderer that has never heard of a safe area
    // needs the viewport-relative number.
    const hooded = rig({
      safeArea: { top: 0.2, right: 0, bottom: 0, left: 0 },
      lens: { x: 0.5, y: 0.4 },
    });
    const bare = rig({ lens: { x: 0.5, y: 0.4 } });

    expect(buildStageSettings({ optical: { profile: bare, viewport: VIEWPORT } })
      .readingBandCenterPercent).toBe(40);
    // 0.2 + 0.4 × 0.8 = 0.52 of the whole panel.
    expect(buildStageSettings({ optical: { profile: hooded, viewport: VIEWPORT } })
      .readingBandCenterPercent).toBe(52);
  });

  it('carries an off-panel lens placement through to the resolved optics', () => {
    const desk = rig({ lensPlacement: 'above' });
    const settings = buildStageSettings({ optical: { profile: desk, viewport: VIEWPORT } });

    expect(settings.optics!.lensPlacement).toBe('above');
    // The legacy flattened center already clamps to 5–95%, so an off-panel
    // rig's pin near the true edge survives it rather than landing on 10%.
    expect(settings.readingBandCenterPercent).toBe(5);
  });

  it('lets the rig decide its own brightness and reading cue', () => {
    // Both were chosen by somebody standing at that glass looking at that
    // reflection; the global Settings control is what an UNcalibrated rig gets,
    // not a second opinion about a calibrated one.
    const settings = buildStageSettings({
      ...SETTINGS_OVERRIDES,
      optical: {
        profile: rig({ intensity: 'strong', readingCue: 'wash' }),
        viewport: VIEWPORT,
      },
    });
    expect(settings.textIntensity).toBe('strong');
    expect(settings.readingCue).toBe('wash');
  });

  it('takes mirroring as an argument, never from the rig it is drawing', () => {
    /*
     * Deliberate, and worth pinning because it looks like an omission.
     * `profile.flips` and the panel's saved mirroring describe the same
     * physical fact, so honouring both double-flips a rig — and a freshly
     * created profile flips nothing, so preferring it would quietly un-mirror
     * an operator the first time they calibrated. `flips` rides along inside
     * `opticalProfile` for the calibration screen to read.
     */
    const settings = buildStageSettings({
      mirrorX: true,
      optical: {
        profile: rig({ flips: { horizontal: false, vertical: true } }),
        viewport: VIEWPORT,
      },
    });
    expect(settings.mirrorX).toBe(true);
    expect(settings.mirrorY).toBe(false);
    expect(settings.opticalProfile!.flips).toEqual({ horizontal: false, vertical: true });
  });

  /**
   * A panel that reports no size cannot size anything.
   *
   * `logicalSize` comes from the window server, and a display enumerated while
   * it is waking or hot-plugging can answer 0 — or, through a failed query,
   * NaN. Neither produces a smaller layout: the resolver's safe width carries
   * the NaN into the column measure, and a zero width drives the fit check to
   * its hard character floor where the body size rounds away to nothing. The
   * take would be blank inside an envelope claiming to be fully calibrated,
   * which is the version of this the stage has no way to detect.
   */
  it.each([
    ['a panel with no size', { widthPx: 0, heightPx: 0 }],
    ['a panel that answered with nonsense', { widthPx: Number.NaN, heightPx: 1080 }],
  ])('takes the uncalibrated layout on %s rather than resolving against it', (_label, viewport) => {
    const settings = buildStageSettings({
      ...SETTINGS_OVERRIDES,
      optical: { profile: rig(), viewport },
    });

    expect(settings.fontSizePx).toBe(SETTINGS_OVERRIDES.fontSizePx);
    expect(settings.columnWidthPercent).toBe(SETTINGS_OVERRIDES.columnWidthPercent);
    // And no optical claim at all: an unmeasurable panel is exactly as
    // uncalibrated as one nobody has measured, and must read that way.
    expect(settings.optics).toBeUndefined();
    expect(settings.opticalProfile).toBeUndefined();
    // The global brightness stands, because no rig was applied to overrule it.
    expect(settings.textIntensity).toBe(SETTINGS_OVERRIDES.textIntensity);
  });

  it('carries the whole optical block through the envelope', () => {
    const envelope = buildStageEnvelope({
      script: compiled(),
      sessionId: 'session-1',
      sessionGeneration: 1,
      stageGeneration: 7,
      stageSettings: buildStageSettings({ optical: { profile: rig(), viewport: VIEWPORT } }),
    });
    expect(envelope.stageSettings.optics?.calibrated).toBe(true);
    expect(envelope.stageSettings.opticalProfile?.rigName).toBe('Desk hood');
  });
});

describe('an uncalibrated rig still prompts, and says nothing it cannot support', () => {
  it('takes the percentage layout, with no optical claim attached', () => {
    const settings = buildStageSettings();
    expect(settings.optics).toBeUndefined();
    expect(settings.opticalProfile).toBeUndefined();
    expect(settings.fontSizePx).toBe(DEFAULT_STAGE_APPEARANCE.fontSizePx);
    expect(settings.columnWidthPercent).toBe(DEFAULT_STAGE_APPEARANCE.columnWidthPercent);
    expect(settings.lineHeight).toBe(DEFAULT_STAGE_APPEARANCE.lineHeight);
    expect(settings.readingBandCenterPercent).toBe(
      DEFAULT_STAGE_APPEARANCE.readingBandCenterPercent,
    );
  });

  /**
   * The defaults used to exist twice and disagree — 78%/1.32 on the Settings
   * screen, 68%/1.28 in the envelope fallback — so the app demonstrated itself
   * with a layout no user could actually get. Nothing compared them, which is
   * why it survived.
   */
  it('falls back to the same numbers the Settings screen shows', () => {
    const t = defaultAppSettings().teleprompter;
    const settings = buildStageSettings();
    expect(settings.fontSizePx).toBe(t.fontSizePx);
    expect(settings.lineHeight).toBe(t.lineHeight);
    expect(settings.columnWidthPercent).toBe(t.columnWidthPercent);
    expect(settings.readingBandCenterPercent).toBe(t.readingBandCenterPercent);
  });

  /**
   * `readingBandHalfHeightPercent` was the literal 4 and was exposed by no
   * control at all — 4% of viewport height is barely half a line on a 600px
   * panel and a full line on a 1080px one, so one number meant two different
   * things on the two displays this app runs on. It is derived from the
   * dead-zone corridor now, which is what makes these assertions possible.
   */
  it('derives the reading band half-height from the dead-zone corridor', () => {
    const settings = buildStageSettings();
    const expected = (settings.fontSizePx * settings.lineHeight * DEFAULT_DEAD_ZONE_LINES) / 2;
    expect(settings.readingBandHalfHeightPercent).toBeCloseTo((expected / 1080) * 100, 2);
  });

  it('moves the band with the type, which a literal could not', () => {
    const small = buildStageSettings({ fontSizePx: 40 });
    const large = buildStageSettings({ fontSizePx: 96 });
    expect(large.readingBandHalfHeightPercent).toBeGreaterThan(
      small.readingBandHalfHeightPercent,
    );
    // Same corridor in line pitches, so the ratio is the ratio of the pitches.
    expect(large.readingBandHalfHeightPercent / small.readingBandHalfHeightPercent).toBeCloseTo(
      96 / 40,
      1,
    );
  });

  it('measures the corridor against the real panel once there is one', () => {
    // 600px tall instead of the 1080 reference: the same corridor is a bigger
    // slice of a shorter panel, and pretending otherwise is the bug the literal
    // 4 encoded.
    const settings = buildStageSettings({
      optical: {
        profile: {
          ...defaultOpticalProfile(),
          rigName: 'Desk hood',
          scale: { mmPerCssPx: (9 * 25.4) / Math.hypot(1024, 600), source: 'model' },
          viewingDistanceMm: 1200,
        },
        viewport: { widthPx: 1024, heightPx: 600 },
      },
    });
    const expected =
      (settings.fontSizePx * settings.lineHeight * settings.optics!.deadZoneLines) / 2;
    expect(settings.readingBandHalfHeightPercent).toBeCloseTo((expected / 600) * 100, 2);
  });

  /**
   * The stage hard-codes `--stage-bg`, so `background` never described anything
   * a presenter could see — both options of the menu that wrote it rendered
   * identically. It stays on the wire because `StageSettings` is a persisted
   * document, but it is a constant now rather than something a dead control can
   * appear to change.
   */
  it('writes one field colour, whatever the caller wanted', () => {
    expect(buildStageSettings().background).toBe('#000000');
    expect(buildStageSettings({ textIntensity: 'strong' }).background).toBe('#000000');
  });

  it('takes the global text intensity when there is no rig to overrule it', () => {
    expect(buildStageSettings().textIntensity).toBe('standard');
    expect(buildStageSettings({ textIntensity: 'soft' }).textIntensity).toBe('soft');
  });
});

/*
 * B4 — the Follow feel (§47.1) was fully resolved on the control side and never
 * left it: `resolveFollowProfile` produced a real profile that no field of any
 * stage payload carried, so every feel produced identical motion.
 *
 * These assert the FIRST seam of that wire: the envelope — the validated
 * document path, the same one the script travels — carries the resolved
 * profile. They are written so that deleting the `followProfile` line from
 * `buildStageEnvelope` fails them, not merely so that `resolveFollowProfile`
 * returns something.
 */
describe('follow feel reaches the stage envelope (§47.1 → §55)', () => {
  function envelopeFor(feel: 'calm' | 'balanced' | 'responsive') {
    return buildStageEnvelope({
      script: compiled(),
      sessionId: 'session-1',
      sessionGeneration: 1,
      stageGeneration: 7,
      stageSettings: buildStageSettings(),
      following: { ...defaultFollowingSettings(), feel },
    });
  }

  it('carries the resolved profile for a non-default feel', () => {
    const responsive = envelopeFor('responsive');
    expect(responsive.followProfile).toBeDefined();
    expect(responsive.followProfile).toEqual(
      resolveFollowProfile({ ...defaultFollowingSettings(), feel: 'responsive' }),
    );
  });

  it('makes each feel a genuinely different profile on the wire', () => {
    const calm = envelopeFor('calm').followProfile!;
    const balanced = envelopeFor('balanced').followProfile!;
    const responsive = envelopeFor('responsive').followProfile!;

    // §47.1: calmer = lower natural frequency and catch-up; responsive = higher.
    expect(calm.motion.naturalFrequency).toBeLessThan(balanced.motion.naturalFrequency);
    expect(responsive.motion.naturalFrequency).toBeGreaterThan(
      balanced.motion.naturalFrequency,
    );
    expect(calm.motion.catchUpMultiplier).toBeLessThan(responsive.motion.catchUpMultiplier);
    // Balanced is the identity on the family profile.
    expect(balanced).toEqual(DEFAULT_SMOOTH_FOLLOW_PROFILE);

    // §47.1 safety: a feel may never weaken section safety or retake evidence.
    for (const profile of [calm, responsive]) {
    }
  });

  it('sends a profile the stage will actually accept', () => {
    // The two halves of the wire have to agree about the version, or the stage
    // silently drops back to its default and the feel is inert again — one
    // layer further along, and invisible.
    const sent = envelopeFor('responsive').followProfile!;
    expect(stageFollowProfile(sent)).toBe(sent);
  });

  it('omits the profile when no follow settings were supplied', () => {
    const envelope = buildStageEnvelope({
      script: compiled(),
      sessionId: 'session-1',
      sessionGeneration: 1,
      stageGeneration: 7,
      stageSettings: buildStageSettings(),
    });
    expect(envelope.followProfile).toBeUndefined();
    // …and the stage answers that with its own default rather than nothing.
    expect(stageFollowProfile(envelope.followProfile)).toBe(DEFAULT_SMOOTH_FOLLOW_PROFILE);
  });
});

/*
 * #206: mirroring is a fact about the glass in front of ONE panel. The take
 * composes it from the panel it landed on, and from nothing global.
 */
describe('the mirror a take is composed with', () => {
  const panel = (fingerprint: string): DisplayDescriptor => ({
    id: fingerprint,
    name: 'Monitor',
    primary: false,
    physicalPosition: { x: 0, y: 0 },
    physicalSize: { width: 1920, height: 1080 },
    logicalSize: { width: 1920, height: 1080 },
    scaleFactor: 1,
    fingerprint,
    topologyHash: 'topology-1',
  });
  const GLASS = panel('panel-glass');
  const LAPTOP = panel('panel-laptop');

  function withGlassMirrored() {
    const s = defaultAppSettings();
    return {
      ...s,
      optical: withPanelMirror(s.optical, GLASS.fingerprint, { horizontal: true, vertical: false }),
    };
  }

  it("mirrors a take on the glass, and not one that landed on another panel", () => {
    const s = withGlassMirrored();
    expect(stageSettingsFromSettings(s, GLASS).mirrorX).toBe(true);
    // The fallback case: the glass is unplugged and the take is on the laptop.
    expect(stageSettingsFromSettings(s, LAPTOP).mirrorX).toBe(false);
    expect(stageSettingsFromSettings(s, LAPTOP).mirrorY).toBe(false);
  });

  it('mirrors nothing when the panel cannot be named', () => {
    expect(stageSettingsFromSettings(withGlassMirrored()).mirrorX).toBe(false);
    expect(stageSettingsFromSettings(withGlassMirrored(), null).mirrorX).toBe(false);
  });

  it("uses a take's own flip over the panel's saved answer", () => {
    const s = withGlassMirrored();
    const flipped = stageSettingsFromSettings(s, GLASS, { horizontal: false, vertical: true });
    expect(flipped.mirrorX).toBe(false);
    expect(flipped.mirrorY).toBe(true);
  });
});

/*
 * #300 — a take opens in Clean Take unless somebody chose Diagnostic.
 *
 * Diagnostic used to be the saved default, so every take drew the engine's
 * readout and the raw transcript on the glass. `diagnosticTake` is the saved
 * choice now, and this is the one seam it crosses on the way to the stage.
 */
describe('the take mode a saved profile composes', () => {
  function withDiagnosticTake(value: unknown) {
    const s = defaultAppSettings();
    return { ...s, teleprompter: { ...s.teleprompter, diagnosticTake: value as boolean } };
  }

  it('is Clean Take on a fresh profile', () => {
    expect(defaultAppSettings().teleprompter.diagnosticTake).toBe(false);
    expect(stageSettingsFromSettings(defaultAppSettings()).stageMode).toBe('clean');
  });

  it('is Diagnostic Take once it has been switched on, and Clean again once it is off', () => {
    expect(stageSettingsFromSettings(withDiagnosticTake(true)).stageMode).toBe('diagnostic');
    expect(stageSettingsFromSettings(withDiagnosticTake(false)).stageMode).toBe('clean');
  });

  it('treats anything but a stored true as Clean Take', () => {
    // The overlay's fields are not validated on the way in.
    for (const value of ['diagnostic', 'true', 1, null, undefined]) {
      expect(stageSettingsFromSettings(withDiagnosticTake(value)).stageMode, String(value)).toBe(
        'clean',
      );
    }
  });
});
