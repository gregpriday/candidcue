/**
 * Compiler contracts (spec Appendix C.1) — output of the Markdown compile
 * pipeline that runs in the compiler Web Worker.
 */

export type DiagnosticSeverity = 'info' | 'warning' | 'error';

export interface CompileDiagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  blocking: boolean;
  source?: { utf16Start: number; utf16End: number; line?: number; column?: number };
  suggestedAction?:
    | 'open_source'
    | 'fix_directive'
    | 'import_asset'
    | 'mark_literal_command'
    | 'change_wake_phrase';
}

export interface OutlineNode {
  id: string;
  level: number;
  title: string;
  normalizedTitle: string;
  blockId: string;
  startTokenIndex: number;
  endTokenIndex: number;
  children: OutlineNode[];
}

export interface SentenceUnit {
  id: string;
  blockId: string;
  startTokenIndex: number;
  endTokenIndex: number;
  normalizedText: string;
  source: { utf16Start: number; utf16End: number };
}

export interface NavigationTarget {
  id: string;
  type: 'beginning' | 'end' | 'heading' | 'take' | 'sentence' | 'paragraph' | 'phrase';
  label: string;
  normalizedLabel: string;
  tokenIndex: number;
  blockId: string;
  ordinalWithinLabel?: number;
}

export interface CompiledBlock {
  id: string;
  kind:
    | 'paragraph'
    | 'heading'
    | 'list_item'
    | 'blockquote'
    | 'image'
    | 'table'
    | 'diagram'
    | 'cue'
    | 'silent'
    | 'stage_only'
    | 'code'
    | 'divider';
  renderNodes: SafeRenderNode[];
  startTokenIndex?: number;
  endTokenIndex?: number;
  source: { utf16Start: number; utf16End: number };
  spoken: boolean;
  assetIds?: string[];
  layoutHints?: Record<string, string | number | boolean>;
}

/**
 * Do not use `SafeRenderNode` as a disguised arbitrary HTML field.
 */
export type SafeRenderNode =
  | { type: 'text'; text: string; marks?: ('strong' | 'em' | 'strike' | 'code')[]; tokenIndexes?: number[] }
  | { type: 'line_break' }
  | { type: 'link'; label: SafeRenderNode[]; href?: string; external: boolean }
  | { type: 'image'; assetId: string; alt: string }
  | { type: 'cue'; cueType: string; label: string }
  /**
   * Addition beyond Appendix C.1 (documented): structured table content so
   * tables render as reference cards (spec §24.6) without any HTML field.
   * rows[r][c] is one cell's inline content; row 0 is the header row when
   * `headerRow` is true.
   */
  | {
      type: 'table';
      align: ('left' | 'center' | 'right' | null)[];
      headerRow: boolean;
      rows: SafeRenderNode[][][];
    };

/* -------------------------------------------------------------------------
 * Additions beyond Appendix C.1 — the IR types referenced by §25.3
 * (CompiledScript, SpokenToken) plus the supporting shapes they require
 * (CueEvent, CompiledAsset, ScriptStatistics, SerializedSearchIndexes,
 * CompileOptions, token flags). Appendix C.1 names these in CompiledScript
 * but does not define them; definitions follow §25 exactly.
 * ---------------------------------------------------------------------- */

/** Bit flags for SpokenToken.flags (spec §25.2). */
export const TOKEN_FLAGS = {
  PUNCTUATION: 1 << 0,
  STOPWORD: 1 << 1,
  NUMBER: 1 << 2,
  PROPER_NOUN: 1 << 3,
  DIRECTIVE_ALIAS: 1 << 4,
  NON_NAVIGATION: 1 << 5,
} as const;

export interface SpokenToken {
  index: number;
  blockId: string;
  sentenceId: string;
  surface: string;
  normalized: string;
  aliases: string[];
  weight: number;
  source: { utf16Start: number; utf16End: number };
  flags: number;
}

export interface CueEvent {
  id: string;
  blockId: string;
  /** 'cue' for [Cue: …]; 'pause' | 'beat' | 'breathe' for shorthands; 'take' for take markers. */
  cueType: string;
  label: string;
  /** Spoken-token index the cue anchors to (next spoken token), or -1 when none follows. */
  anchorTokenIndex: number;
  source: { utf16Start: number; utf16End: number };
}

export interface CompiledAsset {
  id: string;
  kind: 'image' | 'diagram';
  blockId: string;
  /** Original authored reference (relative path or URL) before asset resolution. */
  href: string;
  alt: string;
  /** Remote URLs are never loaded automatically (spec §24.2). */
  remote: boolean;
  /** Content hash for diagram sources (mermaid render cache key, spec §24.5). */
  contentHash?: string;
}

export interface ScriptStatistics {
  spokenWordCount: number;
  wordsPerMinute: number;
  estimatedDurationSeconds: number;
  nonSpokenBlockCount: number;
  imageCount: number;
  diagramCount: number;
  tableCount: number;
  cueCount: number;
  takeCount: number;
  sentenceCount: number;
  blockCount: number;
}

/** JSON-serializable candidate-generation indexes (spec §25.6). */
export interface SerializedSearchIndexes {
  /** exact normalized token -> spoken token indexes */
  exactToken: Record<string, number[]>;
  /** rare (low-frequency, non-stopword) normalized token -> spoken token indexes */
  rareToken: Record<string, number[]>;
  /** space-joined normalized 2/3/4-grams -> start token indexes */
  ngram2: Record<string, number[]>;
  ngram3: Record<string, number[]>;
  ngram4: Record<string, number[]>;
  /** phonetic key -> candidate spoken token indexes */
  phonetic: Record<string, number[]>;
  /** normalized heading/take label -> navigation target ids */
  headingAndTake: Record<string, string[]>;
  /** normalized sentence text -> sentence ids */
  sentenceText: Record<string, string[]>;
  /** normalized opening phrase (first tokens of a paragraph) -> start token indexes */
  paragraphOpening: Record<string, number[]>;
}

/** Compile settings honoured by the pure compiler (spec §22.2, §21.8, §33). */
export interface CompileOptions {
  scriptId: string;
  readHeadings?: boolean;
  readImageAltText?: boolean;
  readInlineCode?: boolean;
  wordsPerMinute?: number;
  /** Wake phrases used for command-collision warnings (spec §25.1). */
  wakePhrases?: string[];
}

export interface CompiledScript {
  schemaVersion: number;
  compilerVersion: string;
  scriptId: string;
  sourceHash: string;
  settingsHash: string;
  title: string;
  outline: OutlineNode[];
  blocks: CompiledBlock[];
  spokenTokens: SpokenToken[];
  sentences: SentenceUnit[];
  navigationTargets: NavigationTarget[];
  cues: CueEvent[];
  assets: CompiledAsset[];
  diagnostics: CompileDiagnostic[];
  statistics: ScriptStatistics;
  indexes: SerializedSearchIndexes;
}
