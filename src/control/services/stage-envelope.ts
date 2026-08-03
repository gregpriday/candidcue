/**
 * Stage envelope construction (spec §29.2 step 3, §43.3): projects an
 * immutable CompiledScript into the StageSessionEnvelope the stage window
 * hydrates from, resolving asset URLs through Rust.
 */
import type {
  ReadingCueStyle,
  CompiledScript,
  OpticalProfile,
  ResolvedOptics,
  StageMode,
  StageRenderDocument,
  StageSessionEnvelope,
  StageSettings,
  TextIntensity,
} from '../../shared/contracts';
import {
  DEFAULT_DEAD_ZONE_LINES,
  resolveStageGeometry,
  type ViewportInfo,
} from '../../shared/optical-resolve';
import {
  clamp,
  columnWidthPxForCh,
  normalizeFontMetrics,
  type FontMetrics,
  type ReadingContext,
} from '../../shared/optics';
import { resolveFollowProfile, type FollowingSettings } from '../lib/follow-profiles';
import { invokeOrMock } from './ipc';
import {
  activeOpticalProfile,
  DEFAULT_STAGE_APPEARANCE,
  readerOpticalProfile,
  type AppSettings,
} from './settings-types';
import type { DisplayDescriptor } from './stage-types';

/* ---------------------------------------------------------------------------
 * Stage settings
 * ------------------------------------------------------------------------- */

/**
 * The calibrated rig a take runs on, and the panel it will be read from.
 *
 * They travel together on purpose. `resolveStageGeometry` cannot answer without
 * a viewport — every angular result is a size on a specific piece of glass — so
 * a profile supplied on its own would resolve to nothing while looking, in the
 * envelope, exactly like a rig that had been applied. Making the pair
 * unsplittable in the type is cheaper than detecting that later.
 */
export interface OpticalOverride {
  profile: OpticalProfile;
  /** The stage panel in CSS pixels — `DisplayDescriptor.logicalSize`. */
  viewport: ViewportInfo;
  /**
   * Measured stage-font proportions, when the caller has any.
   *
   * Control usually does not: the font is measured by the window that renders
   * it. Omitting this resolves against the DIN fallbacks and marks the result
   * `metricsMeasured: false`, which the stage can improve on once it has
   * painted — an estimate that says it is an estimate, rather than a
   * measurement nobody took.
   */
  metrics?: Partial<FontMetrics> | null;
}

export interface StageSettingsOverrides {
  fontFamilyId?: string;
  fontSizePx?: number;
  lineHeight?: number;
  columnWidthPercent?: number;
  readingBandCenterPercent?: number;
  mirrorX?: boolean;
  mirrorY?: boolean;
  pastDimming?: boolean;
  phraseHighlight?: boolean;
  showCues?: boolean;
  /** The stage chooses its own line breaks. Absent means on. */
  semanticLineBreaks?: boolean;
  /** Luminance of the text over the black field. Ignored when a rig is given. */
  textIntensity?: TextIntensity;
  /** Clean Take hides instrumentation; Diagnostic Take shows it. */
  stageMode?: StageMode;
  /** What marks the reading position. Fixed side ticks by default. */
  readingCue?: ReadingCueStyle;
  optical?: OpticalOverride;
  /**
   * Prompter or reading window. Defaults to `prompter`.
   *
   * Passed on to `resolveStageGeometry` AND written into the built settings, so
   * the stage — which re-resolves against its own viewport — asks for the same
   * measure band control did rather than reverting to the prompter's.
   */
  readingContext?: ReadingContext;
}

/**
 * The stage field is black, and only black.
 *
 * `themeId`, `background` and `foreground` stay on the wire because
 * `StageSettings` is a persisted document — every §52 `display_profiles` row
 * carries one — and dropping a required field would invalidate the saved rows.
 * Nothing READS them: `src/styles/stage.css` hard-codes `--stage-bg`, which is
 * why the two-option "Stage background" menu rendered identically on both of
 * its options for as long as it existed. What replaces it is `textIntensity`,
 * which changes the thing a presenter is actually reaching for when they go
 * looking for that control: how hot the type burns, not what colour the dark is.
 */
const STAGE_FIELD_BACKGROUND = '#000000';

/**
 * The panel an uncalibrated take is measured against.
 *
 * `readingBandHalfHeightPercent` is a percentage of viewport height and there
 * is no viewport to divide by until a rig has been calibrated, so the
 * uncalibrated value is expressed against a nominally 1080-tall panel. That is
 * a guess — and precisely as much of a guess as the 64px body size it sits
 * beside, which is why they are both replaced the moment `optics` exists.
 */
const REFERENCE_VIEWPORT_HEIGHT_PX = 1080;

/**
 * The type and treatment an UNCALIBRATED take runs with.
 *
 * Every one of these is the historical literal, stated here rather than taken
 * from the resolver's `DEFAULT_*`. The two are equal today — which is exactly
 * why the distinction has to be written down rather than left to be noticed.
 * `DEFAULT_PAST_OPACITY` has already moved once (0.42 -> 0.48) as a correction
 * for rigs that opted into the optical model, and the resolver's other defaults
 * are free to move for the same reason; sharing a constant between the two
 * paths means the next such correction silently changes the stage of somebody
 * who has never opened the calibration screen.
 *
 * That is the one thing the preserved uncalibrated path exists to prevent, and
 * it is the same rule the stage's legacy padding table follows: the old path
 * keeps its own numbers, the correction ships to the rigs that asked for it.
 *
 * `UNCALIBRATED_FONT_WEIGHT` is the weight the renderers already fell back to
 * for a `StageSettings` that carried none (`optics?.fontWeight ??
 * settings.fontWeight ?? 500`), so writing it down changes nothing on the glass
 * and stops the field being absent — which the stage would otherwise have to
 * keep a default for in three places.
 */
const UNCALIBRATED_PAST_OPACITY = 0.42;
const UNCALIBRATED_FUTURE_OPACITY = 0.92;
const UNCALIBRATED_LETTER_SPACING_EM = 0;
const UNCALIBRATED_FONT_WEIGHT = 500;
const UNCALIBRATED_PARAGRAPH_SPACING_EM = 0.7;

/**
 * How "past-text dimming off" is written down.
 *
 * It is an encoding, not a level: `applyProfileToStageOverrides`
 * (services/display-profiles.ts) reads the boolean back out of a saved §52 row
 * as `pastOpacity < 0.9`, so the off state has to land above that threshold or
 * a restored profile silently comes back with dimming on. That is why the
 * resolved `pastOpacity` is not consulted in this branch: the operator did not
 * ask for a subtler dim, they asked for none.
 */
const PAST_DIMMING_OFF_OPACITY = 0.92;

/**
 * The appearance a take runs with.
 *
 * Two paths, and the point of the function is that they agree. Without an
 * `optical` override this is the historical percentage/pixel layout, unchanged.
 * With one, `resolveStageGeometry` decides the geometry from a measured
 * distance and the result is written BOTH into `optics` (the detail, in line
 * pitches and `ch`) and back into EVERY legacy field that has a flat twin (the
 * summary, in pixels, percentages and ems) — because a stage build that
 * predates the optical layer ignores `optics` entirely and lays out from
 * `fontSizePx`/`lineHeight`/`columnWidthPercent`. If those kept carrying the
 * Settings-screen numbers, a rig somebody had just measured would prompt at the
 * uncalibrated size on the exact panel they measured it on, silently, inside an
 * envelope carrying a full and plausible optical block.
 */
export function buildStageSettings(overrides: StageSettingsOverrides = {}): StageSettings {
  const optical = measurableOptical(overrides.optical);
  const optics = optical
    ? /*
       * The resolver's `warnings` are dropped on purpose. They are sentences
       * for an operator, and this function has nobody to say them to — it
       * builds a document. Everything they are derived from rides in `optics`
       * (`calibrated`, `metricsMeasured`, `bodyArcminutes`, `fitVerdict`,
       * `fitAdvice`), so the window that HAS a presenter in front of it can
       * say them at the moment they are actionable rather than at build time.
       */
      resolveStageGeometry({
        profile: optical.profile,
        metrics: optical.metrics ?? null,
        viewport: optical.viewport,
        ...(overrides.readingContext ? { readingContext: overrides.readingContext } : {}),
      }).optics
    : null;

  const fontSizePx = optics
    ? Math.round(optics.bodyFontSizePx)
    : overrides.fontSizePx ?? DEFAULT_STAGE_APPEARANCE.fontSizePx;
  /*
   * Every resolved value that has a flat twin is written into BOTH.
   *
   * `fontSizePx` and `columnWidthPercent` were flattened from the start and
   * `lineHeight`, `letterSpacingEm`, `paragraphSpacingEm`, `fontWeight` and the
   * two opacities were not — so a rig the resolver had sized at 1.38 with a
   * past opacity of 0.48 reached a stage that predates `optics` as 1.32/0.42,
   * and reached `bandHalfHeightPercentFor` below as 1.32 even on a stage that
   * does read `optics`. The corridor was then computed against a line pitch
   * four percent shorter than the one the glass would show.
   *
   * The rule is the one the stage's `effective` derivation states from the
   * other end: there is ONE description of the layout, and both representations
   * of it say the same thing.
   */
  const lineHeight = optics
    ? optics.lineHeight
    : overrides.lineHeight ?? DEFAULT_STAGE_APPEARANCE.lineHeight;

  return {
    schemaVersion: 1,
    themeId: 'stage-dark',
    background: STAGE_FIELD_BACKGROUND,
    foreground: '#f5f3ef',
    fontFamilyId: overrides.fontFamilyId ?? DEFAULT_STAGE_APPEARANCE.fontFamilyId,
    fontSizePx,
    lineHeight,
    letterSpacingEm: optics ? optics.letterSpacingEm : UNCALIBRATED_LETTER_SPACING_EM,
    fontWeight: optics ? optics.fontWeight : UNCALIBRATED_FONT_WEIGHT,
    columnWidthPercent:
      optics && optical
        ? columnPercentFor(optics, optical, fontSizePx)
        : overrides.columnWidthPercent ?? DEFAULT_STAGE_APPEARANCE.columnWidthPercent,
    readingBandCenterPercent: optics
      ? bandCenterPercentFor(optics)
      : overrides.readingBandCenterPercent ?? DEFAULT_STAGE_APPEARANCE.readingBandCenterPercent,
    readingBandHalfHeightPercent: bandHalfHeightPercentFor(
      fontSizePx,
      lineHeight,
      optics,
      optical?.viewport ?? null,
    ),
    pastOpacity:
      overrides.pastDimming === false
        ? PAST_DIMMING_OFF_OPACITY
        : optics
          ? optics.pastOpacity
          : UNCALIBRATED_PAST_OPACITY,
    futureOpacity: optics ? optics.futureOpacity : UNCALIBRATED_FUTURE_OPACITY,
    currentUnderlayOpacity: overrides.phraseHighlight === false ? 0 : 0.1,
    /*
     * Mirroring stays with the Settings toggles rather than being taken from
     * `profile.flips`. Both describe the same physical fact, so applying both
     * would double-flip a rig whose glass is already accounted for — and a
     * freshly created profile flips nothing, so preferring it would quietly
     * un-mirror an operator the first time they calibrated. `flips` rides along
     * inside `opticalProfile` for the calibration screen to read; wiring it to
     * the render is a change that has to retire the toggles in the same move.
     */
    mirrorX: overrides.mirrorX ?? false,
    mirrorY: overrides.mirrorY ?? false,
    showCues: overrides.showCues ?? true,
    // Absent means on: a settings document written before the breaker existed
    // is a presenter who has not chosen, not one who chose the old behaviour.
    semanticLineBreaks: overrides.semanticLineBreaks ?? true,
    stageAcknowledgements: true,
    reducedMotion: false,
    paragraphSpacingEm: optics ? optics.paragraphSpacingEm : UNCALIBRATED_PARAGRAPH_SPACING_EM,
    stageMode: overrides.stageMode ?? 'clean',
    /*
     * A calibrated rig's own brightness and cue choice outrank the global
     * default, because they were made by somebody standing at that glass
     * looking at that reflection. The Settings control is what an uncalibrated
     * rig gets, not a second opinion about a calibrated one.
     */
    textIntensity: optical ? optical.profile.intensity : overrides.textIntensity ?? 'standard',
    // The rig's own choice when there is one, the explicit override otherwise.
    // A calibrated profile carries the cue style it was calibrated with, so it
    // wins over a loose setting for the same reason its geometry does.
    readingCue: optical ? optical.profile.readingCue : (overrides.readingCue ?? 'ticks'),
    /*
     * Written even when there is no `optics` block to go with it.
     *
     * An uncalibrated reading window still needs the stage to know it is one:
     * that is what picks `UNCALIBRATED_READER_FONT_SIZE_PX` over the prompter's
     * 64 when the stage re-resolves, and 64 px in a reading window is about a
     * dozen characters a line. Tying this to `optics` would make the mode
     * invisible in exactly the case where its default matters most.
     */
    ...(overrides.readingContext ? { readingContext: overrides.readingContext } : {}),
    ...(optics && optical ? { optics, opticalProfile: optical.profile } : {}),
  };
}

/**
 * The stage appearance a take runs with, straight out of Settings.
 *
 * The display is an argument rather than a lookup because it is what turns a
 * saved calibration into geometry: the rig is chosen by the panel's
 * fingerprint, and `resolveStageGeometry` sizes type against that panel's own
 * CSS-pixel viewport. Called without a display — a preview, a test — it falls
 * back to the uncalibrated percentage layout, which is the same thing an
 * uncalibrated rig gets and is labelled as a guess wherever it is shown.
 *
 * Font metrics are deliberately not supplied. Control cannot measure a font it
 * does not render; the DIN fallbacks resolve a defensible size and mark
 * themselves `metricsMeasured: false`, which the stage improves on once it has
 * painted its own text.
 *
 * It lives beside `buildStageSettings` rather than in `lib/start-take`, where
 * it was written, because starting a take is no longer the only caller: the
 * in-session appearance sheet rebuilds the take's settings on every drag of a
 * slider, and it does that from the session store — which `start-take` imports,
 * so reaching back the other way would close an import cycle. The two callers
 * MUST compose settings identically; that is the whole reason a mid-take change
 * and the next take's opening frame agree.
 */
export function stageSettingsFromSettings(
  s: AppSettings,
  display?: DisplayDescriptor | null,
): StageSettings {
  const t = s.teleprompter;
  const reader = s.stage.presentationMode === 'reader';
  /*
   * A reading window runs its own rig, and always has one.
   *
   * `readerOpticalProfile` synthesises when nothing is stored — see the note
   * there for why that is safe for a reader and not for a prompter — so this
   * branch never falls through to the uncalibrated percentage layout for want of
   * a calibration wizard nobody should have to run to read a script.
   */
  const profile = reader
    ? readerOpticalProfile(s.optical, display?.fingerprint ?? null)
    : activeOpticalProfile(s.optical, display?.fingerprint ?? null);
  return buildStageSettings({
    fontFamilyId: t.fontFamilyId,
    fontSizePx: t.fontSizePx,
    lineHeight: t.lineHeight,
    columnWidthPercent: t.columnWidthPercent,
    readingBandCenterPercent: t.readingBandCenterPercent,
    /*
     * Never mirrored in a reading window, whatever Settings says.
     *
     * The mirror toggles describe a BEAMSPLITTER — the note below on
     * `buildStageSettings`'s own `mirrorX` explains why they live in Settings
     * rather than being read off `profile.flips` — and a reading window has no
     * glass in the optical path. Carrying a glass rig's mirror into it gives
     * somebody backwards text on a bare monitor, which the `desk-webcam` preset
     * already calls "the classic first-run confusion".
     *
     * Forced rather than defaulted: the operator's prompter rig legitimately
     * wants these on, and switching modes must not make them turn a setting off
     * and back on again around it.
     */
    mirrorX: reader ? false : t.mirrorX,
    mirrorY: reader ? false : t.mirrorY,
    pastDimming: t.pastDimming,
    phraseHighlight: t.phraseHighlight,
    semanticLineBreaks: t.semanticLineBreaks,
    textIntensity: t.textIntensity,
    stageMode: t.stageMode,
    readingCue: t.readingCue,
    ...(reader ? { readingContext: 'reader' as const } : {}),
    ...(profile && display
      ? {
          optical: {
            profile,
            /*
             * The PANEL, even in reader mode, and only as a starting estimate.
             *
             * Control cannot know how large the reading window is — it is the
             * window this code is running in, but the geometry is resolved before
             * the stage mounts and the operator can drag an edge at any moment
             * afterwards. So this resolves against the display and the stage
             * re-resolves against its own viewport once it has painted, which is
             * the same division of labour the note on font metrics below
             * describes. What arrives here is a defensible opening frame; what
             * the reader actually reads is the stage's own answer.
             */
            viewport: {
              widthPx: display.logicalSize.width,
              heightPx: display.logicalSize.height,
            },
          },
        }
      : {}),
  });
}

/**
 * True when a saved rig decided this take's appearance rather than the flat
 * Settings values.
 *
 * The distinction the in-session sheet has to make: wherever `buildStageSettings`
 * has an optics block, size, line height, column, reading band, brightness and
 * cue style all come from the profile and the loose overrides are not consulted
 * at all. A sheet that offered controls for them anyway would be offering
 * controls that change nothing on the glass, which is the precise defect the
 * Settings screen already carries a paragraph about.
 *
 * Named for what it TESTS. `ResolvedOptics.calibrated` is a different and
 * narrower question — whether the rig carries a real physical scale and
 * distance — and reading that one here would be wrong: an incompletely measured
 * profile still produces an optics block, and `buildStageSettings` still
 * ignores every flat value in its presence. The controls' authority follows the
 * composition, not the quality of the measurement.
 */
export function isRigResolvedStage(settings: StageSettings | null): boolean {
  return Boolean(settings?.optics);
}

/**
 * A rig is only applied against a panel that reports a size.
 *
 * Every optical answer is a size on a specific piece of glass, so a viewport
 * that is zero or non-finite does not produce a smaller layout — it produces
 * arithmetic. `resolveStageGeometry` takes `Math.max(1, widthPx * …)`, which
 * carries a NaN width straight through to the column measure, and a width of
 * zero drives the fit check down to its hard character floor, where the body
 * size rounds to 0 and the take is blank. Both arrive inside an envelope
 * carrying a full and plausible optical block, which is the worst version of
 * this: the stage has no way to tell that the geometry it was handed was
 * computed against a panel that never answered.
 *
 * The descriptor comes from `DisplayDescriptor.logicalSize`, i.e. from the
 * window server, and a panel that has just been woken or hot-plugged can be
 * enumerated before it has a size. An unmeasurable panel therefore takes the
 * uncalibrated layout — the same answer an uncalibrated rig gets, and one the
 * stage already knows how to label as a guess.
 */
function measurableOptical(optical: OpticalOverride | undefined): OpticalOverride | null {
  if (!optical) return null;
  const measured = (value: number): boolean => Number.isFinite(value) && value > 0;
  if (!measured(optical.viewport.widthPx) || !measured(optical.viewport.heightPx)) return null;
  return optical;
}

/** The resolved column, in the viewport percentage the legacy field speaks. */
function columnPercentFor(
  optics: ResolvedOptics,
  optical: OpticalOverride,
  fontSizePx: number,
): number {
  const metrics = normalizeFontMetrics(optical.metrics);
  const widthPx = columnWidthPxForCh(optics.columnCh, fontSizePx, metrics);
  const viewportWidthPx = optical.viewport.widthPx;
  if (!(widthPx > 0) || !(viewportWidthPx > 0)) {
    return DEFAULT_STAGE_APPEARANCE.columnWidthPercent;
  }
  return clamp(Math.round((widthPx / viewportWidthPx) * 100), 20, 100);
}

/**
 * The reading band, as a percentage of the WHOLE viewport.
 *
 * `readingBandY` is a fraction of the safe rectangle, so a hood that hides the
 * top of the panel moves the band down the glass without moving it within what
 * the presenter can see. The insets have to be folded back in before the number
 * means anything to a renderer that has never heard of a safe area.
 */
function bandCenterPercentFor(optics: ResolvedOptics): number {
  const usable = Math.max(0, 1 - optics.safeArea.top - optics.safeArea.bottom);
  return clamp(Math.round((optics.safeArea.top + optics.readingBandY * usable) * 100), 5, 95);
}

/**
 * The reading corridor's half-height, derived rather than declared.
 *
 * It was the literal `4` — 4% of viewport height, which is barely half a line
 * on a 600px panel and a full line on a 1080px one, so the same setting meant
 * two different things on the two displays this app is actually used on, and it
 * was reachable from no UI in either case. The corridor is stated once now, in
 * line pitches (`DEFAULT_DEAD_ZONE_LINES`), and this is that same corridor
 * expressed in the unit the legacy field speaks so an older stage still gets it.
 *
 * Only exactly that corridor when there is a panel to divide by, though: an
 * uncalibrated take is stated against the 1080 reference and then rescaled by
 * whatever height the stage actually has, so it lands near the corridor rather
 * than on it. That is as close as a percentage can get without a viewport, and
 * it is why a stage that has measured its own line pitch reads
 * `optics.deadZoneLines` instead of this field.
 */
function bandHalfHeightPercentFor(
  fontSizePx: number,
  lineHeight: number,
  optics: ResolvedOptics | null,
  viewport: ViewportInfo | null,
): number {
  const deadZoneLines = optics?.deadZoneLines ?? DEFAULT_DEAD_ZONE_LINES;
  const heightPx =
    viewport !== null && viewport.heightPx > 0 ? viewport.heightPx : REFERENCE_VIEWPORT_HEIGHT_PX;
  const halfPx = (fontSizePx * lineHeight * deadZoneLines) / 2;
  return Math.round(clamp((halfPx / heightPx) * 100, 1.5, 12) * 100) / 100;
}

/* ---------------------------------------------------------------------------
 * Render document
 * ------------------------------------------------------------------------- */

/**
 * Project a compiled script into the stage's render document. Sentences and
 * take layout hints are populated so the current-phrase underlay and take
 * headers render without re-parsing (spec §16.2).
 */
export function buildStageRenderDocument(
  script: CompiledScript,
  assets: StageRenderDocument['assets'] = {},
): StageRenderDocument {
  // Take markers → layout hints on their carrying block (§21.4).
  const takeByBlock = new Map<string, string>();
  for (const cue of script.cues) {
    if (cue.cueType === 'take') takeByBlock.set(cue.blockId, cue.label);
  }

  const blocks = script.blocks.map((block) => {
    const takeLabel = takeByBlock.get(block.id);
    if (takeLabel === undefined) return block;
    return {
      ...block,
      layoutHints: { ...block.layoutHints, take: true, takeLabel },
    };
  });

  return {
    schemaVersion: 1,
    title: script.title,
    blocks,
    tokenToNode: script.spokenTokens.map((token) => ({
      tokenIndex: token.index,
      blockId: token.blockId,
      nodeKey: '',
    })),
    assets,
    sentences: script.sentences.map((sentence) => ({
      id: sentence.id,
      blockId: sentence.blockId,
      startTokenIndex: sentence.startTokenIndex,
      endTokenIndex: sentence.endTokenIndex,
    })),
  };
}

/** Resolve local asset URLs through Rust (asset-protocol scope, §47.8). */
export async function resolveDocumentAssets(
  script: CompiledScript,
): Promise<StageRenderDocument['assets']> {
  // The compiler's `img-<hash>` ids are node keys derived from the authored
  // URL, never database ids, so the href must travel with them: Rust resolves
  // by canonical path and answers under the id we sent (§24.1).
  const local = script.assets
    .filter((a) => !a.remote && a.kind === 'image')
    .map((a) => ({ id: a.id, href: a.href }));
  if (local.length === 0) return {};
  try {
    const entries = await invokeOrMock<Record<string, { url: string; mime: string }>>(
      'resolve_asset_urls',
      { scriptId: script.scriptId, assetsToResolve: local },
      () => ({}),
    );
    const resolved: StageRenderDocument['assets'] = {};
    for (const [id, entry] of Object.entries(entries)) {
      resolved[id] = { url: entry.url, mime: entry.mime };
    }
    return resolved;
  } catch {
    // Unresolvable assets degrade to alt text on the stage (§24.2).
    return {};
  }
}

/* ---------------------------------------------------------------------------
 * Envelope
 * ------------------------------------------------------------------------- */

export interface EnvelopeInput {
  script: CompiledScript;
  sessionId: string;
  /**
   * The coordinator's session generation, when this envelope belongs to a take.
   *
   * Omitted for a payload that belongs to no session — the Settings screen's
   * live preview is the only one. Rust validates it as optional ("a session
   * generation, WHEN CARRIED, must also be current"), and the number is minted
   * by `start_session`, which a preview never calls. Supplying any literal
   * there would be the C1 defect in miniature: the payload would publish
   * successfully only when the coordinator happened to be on that number, and
   * be silently dropped otherwise.
   *
   * A take must always pass it. `start-take.ts` takes it from the session
   * record Rust returns, which is the invariant `ipc-command-reachability`
   * pins at the source level.
   */
  sessionGeneration?: number;
  stageGeneration: number;
  stageSettings: StageSettings;
  initialTokenIndex?: number;
  assets?: StageRenderDocument['assets'];
  /**
   * §47 follow settings. Resolved here into the §55 motion profile the stage's
   * engine runs on, so the Follow feel the user chose is in force from the
   * first frame. Omitted settings mean the stage keeps its own default profile.
   */
  following?: FollowingSettings;
}

export function buildStageEnvelope(input: EnvelopeInput): StageSessionEnvelope {
  return {
    schemaVersion: 1,
    sessionId: input.sessionId,
    // Absent rather than defaulted: see `EnvelopeInput.sessionGeneration`. A
    // fallback number here would put back exactly the silent drop the omission
    // exists to avoid.
    ...(input.sessionGeneration === undefined
      ? {}
      : { sessionGeneration: input.sessionGeneration }),
    stageGeneration: input.stageGeneration,
    scriptId: input.script.scriptId,
    sourceHash: input.script.sourceHash,
    compileRevision: 1,
    stageSettings: input.stageSettings,
    renderDocument: buildStageRenderDocument(input.script, input.assets ?? {}),
    initialTokenIndex: input.initialTokenIndex ?? 0,
    ...(input.following ? { followProfile: resolveFollowProfile(input.following) } : {}),
  };
}
