/**
 * Display and stage contracts (spec Appendix C.2) — everything the stage
 * window needs arrives as a validated snapshot; the stage never fetches.
 */
import type { Uuid } from './core';
import type { CompiledBlock } from './compiler';
import type { SmoothFollowProfile } from './smooth-follow';
import type {
  OpticalProfile,
  ReadingContext,
  ReadingCueStyle,
  ResolvedOptics,
  StageMode,
  TextIntensity,
} from './optical';

/**
 * The shape a take presents in. Twin of Rust's `windows::PresentMode`.
 *
 * `prompter` takes the display: borderless, monitor-sized, above the menu bar,
 * read off glass at a distance. `reader` presents in place, in an ordinary
 * window somebody can size and work beside.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT `ReadingContext`, WHICH HAS THE SAME TWO MEMBERS
 * ---------------------------------------------------------------------------
 * They describe different things and are equal only because one decides the
 * other. This is a fact about the WINDOW — chrome, layering, geometry, the
 * minimum size — and it is what `set_control_presenting` acts on.
 * `ReadingContext` is an input to the optical model, and it is what selects the
 * character band the width solver aims at.
 *
 * The mapping between them happens once, in `stageSettingsFromSettings`. Making
 * them one type would save a line there and would mean any future asymmetry —
 * a third window shape that reads like a prompter, say — could not be expressed
 * without unpicking every use of both.
 */
export type PresentationMode = 'prompter' | 'reader';

/**
 * A reading window's bounds in LOGICAL (CSS) pixels, as Rust measures them and
 * as the settings document keeps them.
 *
 * Only reader mode has any: a prompter fills whichever monitor it was already
 * on, so there is no rectangle to remember. See `ReaderFrame` in
 * `src-tauri/src/windows/present.rs` for why the units are logical — the frame
 * outlives the process, and physical pixels do not survive a change of display
 * scale.
 *
 * Nothing here is validated against the current display arrangement. Rust
 * applies the same off-screen clamp every restore gets, so a frame saved on a
 * panel that has since been unplugged comes back somewhere visible rather than
 * somewhere the operator cannot reach.
 */
export interface ReaderFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

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
  /**
   * The stage chooses its own line breaks (`stage/renderer/wrap-plan.ts`).
   *
   * Optional, and absent means ON. Every stage settings document written before
   * this existed lacks the field, and the presenter who opens one of those is
   * asking for the current product rather than for a frozen copy of the old
   * one — so the default has to live in the reader, not in a migration.
   */
  semanticLineBreaks?: boolean;
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
   * uncalibrated path. Where Rust stores any of it (a script's
   * `stageOverrides`) it is opaque JSON, so none of this needs a migration.
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
  /**
   * Whether this is a prompter or a reading window. Absent means prompter.
   *
   * On the wire because the STAGE re-resolves the geometry against its own
   * viewport, and the resolve needs to know which character band to aim at — the
   * prompter's 32–38, sized for what a camera can see, or the reader's 55–75,
   * sized for reading. Without it a reading window would open at control's
   * resolution and then re-resolve itself into a narrow prompter column on its
   * first measurement pass, which is the worst of both.
   *
   * It rides beside `optics` rather than inside it because it is an INPUT to the
   * resolve rather than a result of it, and `ResolvedOptics` is the results.
   */
  readingContext?: ReadingContext;
}

export interface StageSessionEnvelope {
  schemaVersion: 1;
  sessionId: Uuid;
  /**
   * The coordinator's session generation — present on every TAKE envelope.
   *
   * Optional because the wire contract is optional, not because a take may omit
   * it. Rust validates it as "when carried, must also be current"
   * (`validate_stage_payload_header`), and the number exists only because
   * `start_session` minted it. A payload that belongs to no session therefore
   * has no honest value to put here: the Settings screen's live preview opens a
   * real stage window without ever starting a session, and any literal it chose
   * would match the coordinator only by coincidence and be silently DROPPED the
   * rest of the time.
   *
   * A take must still carry it, and that is pinned at the source rather than by
   * this type: `ipc-command-reachability.test.ts` asserts the start sequence
   * takes it from the record Rust returns, and that no control source ever
   * writes a literal one. That test is the real guard — it is what caught C1,
   * and it catches the mistake this optionality would otherwise permit.
   */
  sessionGeneration?: number;
  stageGeneration: number;
  scriptId: Uuid;
  sourceHash: string;
  compileRevision: number;
  stageSettings: StageSettings;
  renderDocument: StageRenderDocument;
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
