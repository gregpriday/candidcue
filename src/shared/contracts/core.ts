/**
 * Core scalar aliases and script-level contracts shared across the control
 * window, stage window, workers, and the Rust boundary (spec Appendix C).
 */
import type { StageSettings } from './display';
import type { ListenerSelection } from './listener';

export type Uuid = string;
export type IsoDateTime = string;

export interface Revisioned<T> {
  revision: number;
  value: T;
}

export interface ScriptSummary {
  id: Uuid;
  title: string;
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
  scriptRevision: number;
  settings: ScriptSettings;
  selectedDisplayProfileId?: Uuid;
  selectedTrackingProfileId?: Uuid;
  selectedListener?: ListenerSelection;
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
