/**
 * Stage envelope construction (spec §29.2 step 3, §43.3): projects an
 * immutable CompiledScript into the StageSessionEnvelope the stage window
 * hydrates from, resolving asset and Listener media URLs through Rust.
 */
import type {
  CompiledScript,
  ListenerStageSelection,
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
} from '../../shared/optics';
import { resolveFollowProfile, type FollowingSettings } from '../lib/follow-profiles';
import { invokeOrMock } from './ipc';
import { DEFAULT_STAGE_APPEARANCE } from './settings-types';

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
  /** Luminance of the text over the black field. Ignored when a rig is given. */
  textIntensity?: TextIntensity;
  /** Clean Take hides instrumentation; Diagnostic Take shows it. */
  stageMode?: StageMode;
  optical?: OpticalOverride;
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
 * The appearance a take runs with.
 *
 * Two paths, and the point of the function is that they agree. Without an
 * `optical` override this is the historical percentage/pixel layout, unchanged.
 * With one, `resolveStageGeometry` decides the geometry from a measured
 * distance and the result is written BOTH into `optics` (the detail, in line
 * pitches and `ch`) and back into the legacy fields (the summary, in pixels and
 * percentages) — because a stage build that predates the optical layer ignores
 * `optics` entirely and lays out from `fontSizePx`/`columnWidthPercent`. If
 * those kept carrying the Settings-screen numbers, a rig somebody had just
 * measured would prompt at the uncalibrated size on the exact panel they
 * measured it on, silently, inside an envelope carrying a full and plausible
 * optical block.
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
      }).optics
    : null;

  const lineHeight = overrides.lineHeight ?? DEFAULT_STAGE_APPEARANCE.lineHeight;
  const fontSizePx = optics
    ? Math.round(optics.bodyFontSizePx)
    : overrides.fontSizePx ?? DEFAULT_STAGE_APPEARANCE.fontSizePx;

  return {
    schemaVersion: 1,
    themeId: 'stage-dark',
    background: STAGE_FIELD_BACKGROUND,
    foreground: '#f5f3ef',
    fontFamilyId: overrides.fontFamilyId ?? DEFAULT_STAGE_APPEARANCE.fontFamilyId,
    fontSizePx,
    lineHeight,
    letterSpacingEm: 0,
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
    pastOpacity: overrides.pastDimming === false ? 0.92 : 0.42,
    futureOpacity: 0.92,
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
    stageAcknowledgements: true,
    reducedMotion: false,
    paragraphSpacingEm: 0.7,
    stageMode: overrides.stageMode ?? 'clean',
    /*
     * A calibrated rig's own brightness and cue choice outrank the global
     * default, because they were made by somebody standing at that glass
     * looking at that reflection. The Settings control is what an uncalibrated
     * rig gets, not a second opinion about a calibrated one.
     */
    textIntensity: optical ? optical.profile.intensity : overrides.textIntensity ?? 'standard',
    readingCue: optical ? optical.profile.readingCue : 'ticks',
    ...(optics && optical ? { optics, opticalProfile: optical.profile } : {}),
  };
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
  sessionGeneration: number;
  stageGeneration: number;
  stageSettings: StageSettings;
  listener?: ListenerStageSelection;
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
    sessionGeneration: input.sessionGeneration,
    stageGeneration: input.stageGeneration,
    scriptId: input.script.scriptId,
    sourceHash: input.script.sourceHash,
    compileRevision: 1,
    stageSettings: input.stageSettings,
    renderDocument: buildStageRenderDocument(input.script, input.assets ?? {}),
    ...(input.listener ? { listener: input.listener } : {}),
    initialTokenIndex: input.initialTokenIndex ?? 0,
    ...(input.following ? { followProfile: resolveFollowProfile(input.following) } : {}),
  };
}
