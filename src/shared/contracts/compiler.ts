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
  | { type: 'cue'; cueType: string; label: string };
