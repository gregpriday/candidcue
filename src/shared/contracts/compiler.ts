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
  /**
   * Authored visual text of the spoken override this token came from
   * (`API{say="A P I"}` or a `:::spoken` block, §23.4). A multi-word `say`
   * value expands into one token per spoken word, so this is the only place
   * the visual term survives — vocabulary preparation (§26.4) keys
   * pronunciation candidates on it, because the visual term is what the
   * transcriber mangles. Present only on DIRECTIVE_ALIAS tokens.
   */
  overrideVisual?: string;
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
  /**
   * normalized *alias* -> spoken token indexes (§14.4 "normalized token **and
   * alias** inverted index").
   *
   * Aliases were previously consulted only while scoring an already-open
   * window, so a presenter who produced only the alias form of a term — the
   * exact case §14.2 exists for — opened no window to score. Keys may be
   * multi-word ("forty seven" for `47`, "real time" for `real-time`) because
   * transcript normalization splits hyphens and number words; retrieval is
   * expected to probe both single words and short n-grams of the transcript
   * tail against this map.
   */
  aliasToken: Record<string, number[]>;
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
  /**
   * Spoken-token ranges inside `:::literal-command` blocks (spec §23.7).
   *
   * Command detection must be suppressed while the alignment cursor is inside
   * one of these ranges, otherwise reading "CandidCue, go to chapter one"
   * aloud from the script can fire real navigation — the exact thing the
   * directive exists to prevent. Consumers pass this straight into
   * `buildTrackingDocument(...)` and `CommandRouterDeps.literalCommandRanges`.
   * Ranges are inclusive, non-overlapping, and in ascending token order.
   */
  literalCommandRanges: SpokenTokenRange[];
  /**
   * §19.4 / §19.5 coaching directives derived from the script.
   *
   * Optional rather than required because a `CompiledScript` outlives the
   * process that produced it: a cached document compiled before this field
   * existed is still a valid document, and a type that claims otherwise would
   * be lying to every consumer that reads it back. The compiler always emits
   * it; readers must still treat its absence as "no directives".
   */
  coaching?: CompiledCoachingDirectives;
}

/** Inclusive range over `CompiledScript.spokenTokens` indexes. */
export interface SpokenTokenRange {
  startTokenIndex: number;
  endTokenIndex: number;
}

/* -------------------------------------------------------------------------
 * §19.4 script directives and §19.5 front matter
 * ---------------------------------------------------------------------- */

/**
 * The delivery styles a script may name (§19.4 `cc:style`, §19.5 `style:`).
 *
 * `custom` is absent on purpose: it means "the numbers the *user* chose in
 * Settings", which a script cannot know and must not claim.
 */
export type CoachDirectiveStyle =
  | 'calm'
  | 'natural'
  | 'conversational'
  | 'expressive'
  | 'broadcast';

/** §19.5 `coach:` front matter, after validation. */
export interface CoachFrontMatter {
  mode?: 'off' | 'minimal' | 'coach' | 'studio' | 'review_only' | 'custom';
  style?: CoachDirectiveStyle;
  targetWpm?: [number, number];
  targetVariety?: [number, number];
  targetDurationSeconds?: number;
  fillerDetection?: 'strict' | 'broad';
  liveTips?: 'low' | 'normal' | 'high';
  positiveFeedback?: boolean;
  /**
   * §19.5: "Unknown fields are preserved but ignored." Preserved verbatim, so
   * a key a later version will understand is never destroyed in transit.
   */
  unknownFields: Record<string, string>;
}

/**
 * The §19.4 directives in force over one authored span.
 *
 * `spanId` is a {@link SentenceUnit} id — the same identity the coaching
 * subsystem calls a *script span* and compares `activeScriptSpanId` against.
 * It is never a token index and never a block id.
 */
export interface CoachDirectiveSpan {
  spanId: string;
  /** `<!-- cc:coach off -->`: no coaching evidence may be raised here. */
  coachingOff?: boolean;
  /** `<!-- cc:filler intentional -->`: authored disfluency, not a mistake. */
  fillerIntentional?: boolean;
  /** `<!-- cc:style … -->`. */
  style?: CoachDirectiveStyle;
  /** `<!-- cc:pace low-high -->`, words per minute. */
  paceLowWpm?: number;
  paceHighWpm?: number;
}

/**
 * Everything §19 asks the compiler to derive from the script itself.
 *
 * Resolved to span ids here rather than left as source offsets, because the
 * consumer (the coaching orchestrator's host state) speaks in span ids and has
 * no access to the source text at all.
 */
export interface CompiledCoachingDirectives {
  frontMatter: CoachFrontMatter | null;
  /** Only spans that carry at least one directive. Ascending span order. */
  spans: CoachDirectiveSpan[];
}
