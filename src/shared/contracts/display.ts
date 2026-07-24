/**
 * Display and stage contracts (spec Appendix C.2) — everything the stage
 * window needs arrives as a validated snapshot; the stage never fetches.
 */
import type { Uuid, IsoDateTime } from './core';
import type { CompiledBlock } from './compiler';
import type { ListenerGeometry, ListenerStageSelection } from './listener';

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
  hydrated: boolean;
  layoutReady: boolean;
  lastTrackingRevision?: number;
  mediaHealthy: boolean;
}
