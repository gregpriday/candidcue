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
  /**
   * A per-script stage configuration, if one was ever chosen.
   *
   * Still carried by Rust and still a column in the 1.0 schema, but nothing in
   * the frontend sets it: single-window presentation configures the stage from
   * Settings rather than per script. Kept because `display_profiles` is where
   * durable per-display configuration lives and a per-script override is a
   * plausible thing to want; noted here so the absence of a caller reads as a
   * decision rather than an oversight.
   */
  selectedDisplayProfileId?: Uuid;
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
