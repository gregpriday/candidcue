/**
 * Core scalar aliases and script-level contracts shared across the control
 * window, stage window, workers, and the Rust boundary (spec Appendix C).
 */
import type { StageSettings } from './display';

export type Uuid = string;
export type IsoDateTime = string;

export interface Revisioned<T> {
  revision: number;
  value: T;
}

export interface ScriptSummary {
  id: Uuid;
  title: string;
  /**
   * Optimistic-concurrency revision (spec §48.4). Present on every summary so
   * the library can rename/trash/restore with a compare-and-swap instead of
   * guessing; the Rust commands require it.
   */
  scriptRevision: number;
  status: 'draft' | 'ready' | 'archived' | 'trash';
  language: string;
  spokenWordCount: number;
  estimatedDurationSeconds: number;
  updatedAt: IsoDateTime;
  lastOpenedAt?: IsoDateTime;
  previewText: string;
  hasWarnings: boolean;
}

export interface ScriptDocument extends ScriptSummary {
  source: string;
  sourceHash: string;
  settings: ScriptSettings;
  /*
   * No `selectedDisplayProfileId`. It pointed into `display_profiles`, which
   * nothing wrote after single-window presentation; both went in migration
   * 0004 (#232). The stage is configured from Settings, not per script.
   */
  /*
   * No `selectedTrackingProfileId`. `tracking_profiles` was dropped in the 1.0
   * schema baseline — named tracking presets never shipped and nothing ever
   * wrote a row — so this described a foreign key into a table that no longer
   * exists.
   */
}

export interface ScriptSettings {
  schemaVersion: 1;
  readHeadings: boolean;
  readImageAltText: boolean;
  readInlineCode: boolean;
  cueVisibility: 'hidden' | 'subtle' | 'prominent';
  silentBlockVisibility: 'hidden' | 'dim';
  wordsPerMinuteEstimate: number;
  stageOverrides?: Partial<StageSettings>;
}
