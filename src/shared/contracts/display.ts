/**
 * Display and stage contracts (spec Appendix C.2) — everything the stage
 * window needs arrives as a validated snapshot; the stage never fetches.
 */
import type { Uuid, IsoDateTime } from './core';
import type { CompiledBlock } from './compiler';
import type { ListenerGeometry, ListenerStageSelection } from './listener';
import type { SmoothFollowProfile } from './smooth-follow';
import type {
  OpticalProfile,
  ReadingCueStyle,
  ResolvedOptics,
  StageMode,
  TextIntensity,
} from './optical';

export interface StageSettings {
  schemaVersion: 1;
  themeId: string;
  background: string;
  foreground: string;
  fontFamilyId: string;
  fontSizePx: number;
  lineHeight: number;
  letterSpacingEm: number;
  columnWidthPercent: number;
  readingBandCenterPercent: number;
  readingBandHalfHeightPercent: number;
  pastOpacity: number;
  futureOpacity: number;
  currentUnderlayOpacity: number;
  mirrorX: boolean;
  mirrorY: boolean;
  showCues: boolean;
  stageAcknowledgements: boolean;
  reducedMotion: boolean;
  /** Vertical rhythm between blocks in em of the stage font (A.3, default 0.7). */
  paragraphSpacingEm?: number;
  /** Body weight. 500 by default; never thin, and 700 only for short emphasis. */
  fontWeight?: number;

  /* ---------------------------------------------------------------------
   * The optical layer.
   *
   * All optional, and all additive: a settings document written before
   * calibration existed still validates, still renders, and simply takes the
   * uncalibrated path. Rust persists this whole object as opaque JSON checked
   * only for `schemaVersion === 1`, so none of this needs a migration.
   *
   * `optics` is the RESOLVED geometry the stage renders from; `opticalProfile`
   * is the calibration that produced it, carried along so re-opening the wizard
   * does not start from nothing. When `optics` is absent the stage falls back to
   * the percentage/vh fields above, which is what an uncalibrated rig gets.
   * ------------------------------------------------------------------- */
  optics?: ResolvedOptics;
  opticalProfile?: OpticalProfile;
  /** Clean Take hides instrumentation; Diagnostic Take shows it. */
  stageMode?: StageMode;
  /** What marks the reading position. Fixed side ticks by default. */
  readingCue?: ReadingCueStyle;
  /** Text luminance over the unchanging black field. */
  textIntensity?: TextIntensity;
}

export interface DisplayProfile {
  id: Uuid;
  name: string;
  displayFingerprint?: string;
  stage: StageSettings;
  listener?: ListenerGeometry;
  updatedAt: IsoDateTime;
}

export interface StageSessionEnvelope {
  schemaVersion: 1;
  sessionId: Uuid;
  sessionGeneration: number;
  stageGeneration: number;
  scriptId: Uuid;
  sourceHash: string;
  compileRevision: number;
  stageSettings: StageSettings;
  renderDocument: StageRenderDocument;
  listener?: ListenerStageSelection;
  initialTokenIndex: number;
  /**
   * Companion §47.1/§55. The resolved, versioned motion profile this session
   * runs on — the user's Follow feel, already applied to the chosen profile
   * family by `resolveFollowProfile` on the control side.
   *
   * It travels in the envelope, not on a channel of its own, because it is
   * MOTION configuration: it must arrive on the same validated document path
   * the script does, under the same session/generation checks, and it must be
   * in force before the first frame is followed. A late or out-of-band profile
   * would mean the take's first seconds ran on different dynamics from the
   * rest — the coaching rail can afford that (§5.2 makes it advisory), the
   * controller cannot.
   *
   * Optional, and a stage that cannot interpret the version it receives falls
   * back to `DEFAULT_SMOOTH_FOLLOW_PROFILE` (see
   * `isInterpretableSmoothFollowProfile`), so an older stage and a newer
   * control still produce motion — just not the chosen feel.
   */
  followProfile?: SmoothFollowProfile;
}

export interface StageRenderDocument {
  schemaVersion: 1;
  title: string;
  blocks: CompiledBlock[];
  tokenToNode: Array<{ tokenIndex: number; blockId: string; nodeKey: string }>;
  assets: Record<string, { url: string; mime: string; width?: number; height?: number }>;
  /**
   * Optional sentence spans (compiler SentenceUnits, reduced) so the stage can
   * draw the current-phrase underlay without re-parsing (spec §16.2).
   */
  sentences?: Array<{
    id: string;
    blockId: string;
    startTokenIndex: number;
    endTokenIndex: number;
  }>;
}

export interface StageStatus {
  exists: boolean;
  visible: boolean;
  fullscreen: boolean;
  displayFingerprint?: string;
  stageGeneration: number;
  sessionId?: Uuid;
  /**
   * Handshake step 0: the stage webview's bundle has run and its subscriptions
   * are live. Separates a window that never finished loading from one that
   * loaded and never received its document — and gives the start sequence a
   * point at which to stop charging boot time against the layout budget.
   */
  listening: boolean;
  hydrated: boolean;
  layoutReady: boolean;
  lastTrackingRevision?: number;
  mediaHealthy: boolean;
}
