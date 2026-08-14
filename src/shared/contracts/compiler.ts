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
  | {
      type: 'text';
      text: string;
      marks?: ('strong' | 'em' | 'strike' | 'code')[];
      /**
       * Every spoken token this node carries, in order. NOT one per word — a
       * word can carry several (a spoken override: "API" said as "a p i") and a
       * word can carry none (an em dash between spaces is written, not spoken).
       */
      tokenIndexes?: number[];
      /**
       * One entry per whitespace-separated word of `text`: the token that word
       * anchors, or null where the word is not spoken.
       *
       * `tokenIndexes` cannot answer that question, and the two renderers that
       * need it — the word spans in `text.ts` and the wrap planner's word list
       * in `advance.ts` — used to guess by zipping it against the words and
       * giving up on the whole node when the lengths disagreed. Giving up cost
       * the node every per-word anchor it had: no `data-t`, so nothing to
       * position or dim, and no legal line break for the planner. One em dash in
       * a paragraph was enough (`Now try slowing right down … — like that.`),
       * which is ordinary prose rather than an edge case.
       *
       * A word carrying several tokens takes the FIRST as its anchor: one span
       * can only be in one place, and that is the position the word starts at.
       */
      wordTokens?: (number | null)[];
    }
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
 * (CueEvent, CompiledAsset, ScriptStatistics,
 * CompileOptions, token flags). Appendix C.1 names these in CompiledScript
 * but does not define them; definitions follow §25 exactly.
 * ---------------------------------------------------------------------- */

/**
 * One spoken word of the script, in reading order.
 *
 * ---------------------------------------------------------------------------
 * THIS TYPE CARRIES NO LEXICAL JUDGEMENT
 * ---------------------------------------------------------------------------
 * It used to: a `weight`, a `flags` bitfield of stopword/proper-noun/number
 * classifications, and a list of pronunciation `aliases`. All of that existed
 * for the TypeScript aligner, and all of it is now the alignment engine's
 * (`crates/cc-align`), which decides importance from its own normalization and
 * frequency analysis of the very same surfaces.
 *
 * Keeping a second opinion here would not be redundancy, it would be a
 * disagreement waiting to happen — which is exactly what it was the time the
 * two tokenizers diverged and the cursor sat at `0 of 26` for a whole take. So
 * what the compiler publishes is structural only: what the word is, where it
 * sits in the document, and where it came from in the source. `surface` is the
 * authored text, and it is what gets handed to the engine.
 */
export interface SpokenToken {
  index: number;
  blockId: string;
  sentenceId: string;
  /** Authored text (`$12`, `well-known`). Never pre-split — the engine splits. */
  surface: string;
  /** Casing/punctuation-folded form, used for navigation matching only. */
  normalized: string;
  source: { utf16Start: number; utf16End: number };
  /**
   * Authored visual text of the spoken override this token came from
   * (`API{say="A P I"}` or a `:::spoken` block, §23.4). A multi-word `say`
   * value expands into one token per spoken word, so this is the only place
   * the visual term survives.
   */
  overrideVisual?: string;
  /**
   * This token ends a GRAMMATICAL sentence.
   *
   * Deliberately separate from `SentenceUnit`, which is a NAVIGATION unit: a
   * list item or a heading is one navigation unit however many sentences it
   * contains (§25.5), because jumping by sentence should move by bullet.
   *
   * Alignment used to reuse the navigation units as sentence ends, and that
   * conflation was a real following defect — a bullet holding two sentences
   * reported one boundary, so the display could be carried straight over the
   * full stop inside it. Prose got the braking that stops a prediction running
   * past a pause; a bulleted script did not.
   *
   * Absent rather than `false` on the tokens it does not apply to, so a
   * compiled document is unchanged for them and an older consumer reads
   * `undefined` exactly as it read a missing field before.
   */
  grammaticalSentenceEnd?: boolean;
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
