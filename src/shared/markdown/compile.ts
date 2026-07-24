/**
 * CandidCue Markdown compiler (spec §22, §23, §24, §25).
 *
 * Pure and deterministic: (source, options) -> CompiledScript. Runs in the
 * compiler worker but has no worker dependencies. Never calls the network.
 *
 * Sanitization model (spec §22.6): the compiler emits SafeRenderNode
 * structures, never HTML strings. Raw HTML in the source is rejected at the
 * AST level (comments dropped, everything else rendered as readable source
 * text with a warning), so no user content can reach innerHTML.
 */
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { toString as mdastToString } from 'mdast-util-to-string';
import type {
  CompileDiagnostic,
  CompileOptions,
  CompiledAsset,
  CompiledBlock,
  CompiledScript,
  CueEvent,
  NavigationTarget,
  OutlineNode,
  SafeRenderNode,
  SentenceUnit,
  SpokenToken,
} from '../contracts';
import { TOKEN_FLAGS } from '../contracts';
import { hashString, shortHash } from './hash';
import {
  classifyBracketDirective,
  containerAt,
  scanContainers,
  type ContainerRegion,
} from './directives';
import { aliasesForToken, normalizePhrase, normalizeToken } from './normalize';
import { tokenizeText } from './tokenize';
import { segmentSentences } from './segment';
import { computeTokenWeight } from './weights';
import { buildSearchIndexes } from './indexes';
import { isStopword } from './stopwords';

export const COMPILER_VERSION = '1.0.0';
export const SCHEMA_VERSION = 1;
export const DEFAULT_WORDS_PER_MINUTE = 130;
const DEFAULT_WAKE_PHRASES = ['CandidCue', 'Candid Cue'];

/* ------------------------------------------------------------------ */
/* Minimal structural mdast typing (kept local so the compiler does not */
/* depend on @types/mdast resolution through pnpm's strict layout).     */
/* ------------------------------------------------------------------ */

interface MdPoint {
  line: number;
  column: number;
  offset?: number;
}

interface MdNode {
  type: string;
  children?: MdNode[];
  position?: { start: MdPoint; end: MdPoint };
  value?: string;
  depth?: number;
  ordered?: boolean;
  start?: number | null;
  checked?: boolean | null;
  lang?: string | null;
  url?: string;
  alt?: string | null;
  title?: string | null;
  label?: string | null;
  identifier?: string;
  align?: (string | null)[];
}

function nodeStart(node: MdNode): number {
  return node.position?.start.offset ?? 0;
}

function nodeEnd(node: MdNode): number {
  return node.position?.end.offset ?? 0;
}

/* ------------------------------------------------------------------ */
/* Draft structures                                                     */
/* ------------------------------------------------------------------ */

interface TokenDraft {
  surface: string;
  srcStart: number;
  srcEnd: number;
  /** Offsets within the block's spoken text. */
  textStart: number;
  textEnd: number;
  extraAliases?: string[];
  flagsSeed: number;
  isOverrideAnchor: boolean;
  /** Render text node to receive this token's global index. */
  renderRef?: { tokenIndexes?: number[] };
}

interface CueDraft {
  cueType: string;
  label: string;
  srcStart: number;
  srcEnd: number;
  localTokenCount: number;
}

interface TakeDraft {
  name: string;
  srcStart: number;
  srcEnd: number;
  localTokenCount: number;
}

interface BlockDraft {
  kind: CompiledBlock['kind'];
  renderNodes: SafeRenderNode[];
  srcStart: number;
  srcEnd: number;
  spoken: boolean;
  spokenText: string;
  tokens: TokenDraft[];
  cues: CueDraft[];
  takes: TakeDraft[];
  assetIds?: string[];
  layoutHints?: Record<string, string | number | boolean>;
  headingLevel?: number;
  headingTitle?: string;
  /** List items are one navigation unit even without punctuation (§25.5). */
  singleSentence?: boolean;
  literalCommand?: boolean;
  idText: string;
}

type MarkName = 'strong' | 'em' | 'strike' | 'code';

interface WalkContext {
  draft: BlockDraft;
  marks: MarkName[];
  collectTokens: boolean;
  source: string;
  options: Required<Pick<CompileOptions, 'readInlineCode' | 'readImageAltText'>>;
  diagnostics: CompileDiagnostic[];
  assets: Map<string, CompiledAsset>;
  pendingBlockId: () => string;
}

/* ------------------------------------------------------------------ */
/* Inline walking                                                       */
/* ------------------------------------------------------------------ */

const INLINE_SAY_GLOBAL = /(\S+)\{say="([^"\n]*)"\}/g;

function pushRenderText(
  draft: BlockDraft,
  container: SafeRenderNode[],
  text: string,
  marks: MarkName[],
): { tokenIndexes?: number[] } | undefined {
  if (!text) return undefined;
  const node: SafeRenderNode & { type: 'text' } = { type: 'text', text };
  if (marks.length > 0) node.marks = [...marks];
  container.push(node);
  return node as { tokenIndexes?: number[] };
}

/** Append spoken words from `text` located at absolute `srcBase`. */
function appendSpoken(
  ctx: WalkContext,
  container: SafeRenderNode[],
  text: string,
  srcBase: number,
  exactOffsets: boolean,
  srcEndCap: number,
): void {
  const { draft } = ctx;
  if (!text) return;
  const renderRef = pushRenderText(draft, container, text, ctx.marks);
  if (!ctx.collectTokens) {
    if (draft.spokenText) draft.spokenText += ' ';
    return;
  }
  if (draft.spokenText && !/\s$/.test(draft.spokenText)) draft.spokenText += ' ';
  const textBase = draft.spokenText.length;
  draft.spokenText += text;
  for (const raw of tokenizeText(text)) {
    const srcStart = exactOffsets
      ? srcBase + raw.start
      : Math.min(srcBase + raw.start, srcEndCap);
    const srcEnd = exactOffsets
      ? srcBase + raw.end
      : Math.min(srcBase + raw.end, srcEndCap);
    draft.tokens.push({
      surface: raw.surface,
      srcStart,
      srcEnd,
      textStart: textBase + raw.start,
      textEnd: textBase + raw.end,
      flagsSeed: 0,
      isOverrideAnchor: false,
      ...(renderRef ? { renderRef } : {}),
    });
  }
}

/**
 * Text node handling. Bracket directives ([Cue: …], [Take: …], [Pause],
 * [Beat], [Breathe]) reach the compiler as plain text because undefined
 * shortcut references collapse to text in mdast, so they are lexed here,
 * together with the inline Word{say="…"} alias (§23.2-§23.4).
 */
const INLINE_DIRECTIVE_GLOBAL = /(\S+)\{say="([^"\n]*)"\}|\[([^\[\]\n]*)\]/g;

function walkTextValue(ctx: WalkContext, container: SafeRenderNode[], node: MdNode): void {
  const value = node.value ?? '';
  const base = nodeStart(node);
  const end = nodeEnd(node);
  const exact = ctx.source.slice(base, end) === value;

  INLINE_DIRECTIVE_GLOBAL.lastIndex = 0;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE_DIRECTIVE_GLOBAL.exec(value)) !== null) {
    if (match[3] !== undefined) {
      // Bracketed span: only known directives are special (§23.2, §23.3).
      const directive = classifyBracketDirective(match[3]);
      if (directive.kind === 'none') continue; // ordinary text, handled below
      const before = value.slice(cursor, match.index);
      appendSpoken(ctx, container, before, base + cursor, exact, end);
      const srcStart = exact ? base + match.index : Math.min(base + match.index, end);
      const srcEnd = exact ? srcStart + match[0]!.length : Math.min(srcStart + match[0]!.length, end);
      if (directive.kind === 'cue') {
        container.push({ type: 'cue', cueType: directive.cueType, label: directive.label });
        ctx.draft.cues.push({
          cueType: directive.cueType,
          label: directive.label,
          srcStart,
          srcEnd,
          localTokenCount: ctx.draft.tokens.length,
        });
      } else if (directive.kind === 'take') {
        container.push({ type: 'cue', cueType: 'take', label: directive.name });
        ctx.draft.takes.push({
          name: directive.name,
          srcStart,
          srcEnd,
          localTokenCount: ctx.draft.tokens.length,
        });
      } else {
        ctx.diagnostics.push({
          code: directive.code,
          severity: directive.blocking ? 'error' : 'warning',
          message: directive.message,
          blocking: directive.blocking,
          source: { utf16Start: srcStart, utf16End: srcEnd },
          suggestedAction: 'fix_directive',
        });
        // Remains visible as source (§23.8); not spoken.
        pushRenderText(ctx.draft, container, match[0]!, ctx.marks);
      }
      cursor = match.index + match[0]!.length;
      continue;
    }

    const visual = match[1]!;
    const say = match[2]!;
    const before = value.slice(cursor, match.index);
    appendSpoken(ctx, container, before, base + cursor, exact, end);

    // The visual word renders; the say text becomes aliases on one token
    // whose source range is the visual word's range (§23.4).
    const visualStart = base + match.index;
    const textRef = pushRenderText(ctx.draft, container, visual, ctx.marks);
    if (ctx.collectTokens) {
      if (ctx.draft.spokenText && !/\s$/.test(ctx.draft.spokenText)) ctx.draft.spokenText += ' ';
      const textBase = ctx.draft.spokenText.length;
      ctx.draft.spokenText += visual;
      const sayNormalized = normalizePhrase(say);
      const aliases = new Set<string>();
      if (sayNormalized) {
        aliases.add(sayNormalized);
        for (const word of sayNormalized.split(' ')) aliases.add(word);
      }
      if (!say.trim()) {
        ctx.diagnostics.push({
          code: 'directive_say_empty',
          severity: 'warning',
          message: `The {say="…"} alias on "${visual}" is empty and was ignored.`,
          blocking: false,
          source: { utf16Start: visualStart, utf16End: visualStart + match[0]!.length },
          suggestedAction: 'fix_directive',
        });
      }
      ctx.draft.tokens.push({
        surface: visual,
        srcStart: exact ? visualStart : Math.min(visualStart, end),
        srcEnd: exact ? visualStart + visual.length : Math.min(visualStart + visual.length, end),
        textStart: textBase,
        textEnd: textBase + visual.length,
        extraAliases: [...aliases],
        flagsSeed: say.trim() ? TOKEN_FLAGS.DIRECTIVE_ALIAS : 0,
        isOverrideAnchor: Boolean(say.trim()),
        ...(textRef ? { renderRef: textRef } : {}),
      });
    }
    cursor = match.index + match[0]!.length;
  }
  appendSpoken(ctx, container, value.slice(cursor), base + cursor, exact, end);
}

function isExternalHref(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('asset:');
}

function registerImage(
  ctx: WalkContext,
  container: SafeRenderNode[],
  node: MdNode,
): void {
  const url = node.url ?? '';
  const alt = node.alt ?? '';
  const remote = /^[a-z][a-z0-9+.-]*:\/\//i.test(url);
  const assetId = `img-${shortHash(url || alt)}`;
  if (!ctx.assets.has(assetId)) {
    ctx.assets.set(assetId, {
      id: assetId,
      kind: 'image',
      blockId: '',
      href: url,
      alt,
      remote,
    });
  }
  if (remote) {
    ctx.diagnostics.push({
      code: 'remote_image_blocked',
      severity: 'warning',
      message: `Remote image "${url}" is not loaded automatically (import a local copy).`,
      blocking: false,
      source: { utf16Start: nodeStart(node), utf16End: nodeEnd(node) },
      suggestedAction: 'import_asset',
    });
  }
  container.push({ type: 'image', assetId, alt });
  (ctx.draft.assetIds ??= []).push(assetId);
  if (ctx.options.readImageAltText && alt && ctx.collectTokens) {
    // Spoken representation is the alt text when explicitly enabled (§22.2).
    // The render text goes to a discarded container: the image node itself
    // is the visual representation; only the tokens matter here.
    appendSpoken(ctx, [], alt, nodeStart(node), false, nodeEnd(node));
  }
}

function walkPhrasing(ctx: WalkContext, container: SafeRenderNode[], node: MdNode): void {
  switch (node.type) {
    case 'text':
      walkTextValue(ctx, container, node);
      return;
    case 'strong':
    case 'emphasis':
    case 'delete': {
      const mark: MarkName = node.type === 'strong' ? 'strong' : node.type === 'emphasis' ? 'em' : 'strike';
      const inner = { ...ctx, marks: [...ctx.marks, mark] };
      for (const child of node.children ?? []) walkPhrasing(inner, container, child);
      return;
    }
    case 'inlineCode': {
      const value = node.value ?? '';
      const renderRef = pushRenderText(ctx.draft, container, value, [...ctx.marks, 'code']);
      if (ctx.options.readInlineCode && ctx.collectTokens) {
        // Literal code tokenization (§22.2), reusing the render node ref.
        if (ctx.draft.spokenText && !/\s$/.test(ctx.draft.spokenText)) ctx.draft.spokenText += ' ';
        const textBase = ctx.draft.spokenText.length;
        ctx.draft.spokenText += value;
        for (const raw of tokenizeText(value)) {
          ctx.draft.tokens.push({
            surface: raw.surface,
            srcStart: Math.min(nodeStart(node) + 1 + raw.start, nodeEnd(node)),
            srcEnd: Math.min(nodeStart(node) + 1 + raw.end, nodeEnd(node)),
            textStart: textBase + raw.start,
            textEnd: textBase + raw.end,
            flagsSeed: 0,
            isOverrideAnchor: false,
            ...(renderRef ? { renderRef } : {}),
          });
        }
      }
      return;
    }
    case 'break':
      container.push({ type: 'line_break' });
      if (ctx.collectTokens) ctx.draft.spokenText += ' ';
      return;
    case 'link': {
      const label: SafeRenderNode[] = [];
      const inner = { ...ctx };
      for (const child of node.children ?? []) walkPhrasing(inner, label, child);
      const url = node.url ?? '';
      container.push({
        type: 'link',
        label,
        ...(url ? { href: url } : {}),
        external: isExternalHref(url),
      });
      return;
    }
    case 'image':
      registerImage(ctx, container, node);
      return;
    case 'imageReference':
      // No resolvable definition support in v1; render the alt text.
      pushRenderText(ctx.draft, container, node.alt ?? '', ctx.marks);
      return;
    case 'linkReference': {
      const label = node.label ?? mdastToString(node as never);
      const directive = classifyBracketDirective(label);
      const srcStart = nodeStart(node);
      const srcEnd = nodeEnd(node);
      if (directive.kind === 'cue') {
        container.push({ type: 'cue', cueType: directive.cueType, label: directive.label });
        ctx.draft.cues.push({
          cueType: directive.cueType,
          label: directive.label,
          srcStart,
          srcEnd,
          localTokenCount: ctx.draft.tokens.length,
        });
        return;
      }
      if (directive.kind === 'take') {
        container.push({ type: 'cue', cueType: 'take', label: directive.name });
        ctx.draft.takes.push({
          name: directive.name,
          srcStart,
          srcEnd,
          localTokenCount: ctx.draft.tokens.length,
        });
        return;
      }
      if (directive.kind === 'malformed') {
        ctx.diagnostics.push({
          code: directive.code,
          severity: directive.blocking ? 'error' : 'warning',
          message: directive.message,
          blocking: directive.blocking,
          source: { utf16Start: srcStart, utf16End: srcEnd },
          suggestedAction: 'fix_directive',
        });
        // Remains visible as source (§23.8); not spoken.
        pushRenderText(ctx.draft, container, ctx.source.slice(srcStart, srcEnd), ctx.marks);
        return;
      }
      // Plain unresolved reference: CommonMark renders it literally.
      pushRenderText(ctx.draft, container, '[', ctx.marks);
      for (const child of node.children ?? []) walkPhrasing(ctx, container, child);
      pushRenderText(ctx.draft, container, ']', ctx.marks);
      return;
    }
    case 'html': {
      const value = (node.value ?? '').trim();
      if (value.startsWith('<!--')) return; // comments vanish (§22.2)
      ctx.diagnostics.push({
        code: 'raw_html_blocked',
        severity: 'warning',
        message: 'Raw HTML is not supported; it renders as plain text.',
        blocking: false,
        source: { utf16Start: nodeStart(node), utf16End: nodeEnd(node) },
        suggestedAction: 'open_source',
      });
      pushRenderText(ctx.draft, container, node.value ?? '', ctx.marks);
      return;
    }
    case 'footnoteReference':
      return; // outside the supported baseline; ignore inline marker
    default: {
      for (const child of node.children ?? []) walkPhrasing(ctx, container, child);
      if (!node.children && node.value) {
        pushRenderText(ctx.draft, container, node.value, ctx.marks);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Block building                                                       */
/* ------------------------------------------------------------------ */

interface CompilerState {
  source: string;
  options: CompileOptions;
  readHeadings: boolean;
  readImageAltText: boolean;
  readInlineCode: boolean;
  diagnostics: CompileDiagnostic[];
  drafts: BlockDraft[];
  assets: Map<string, CompiledAsset>;
}

function newDraft(kind: CompiledBlock['kind'], srcStart: number, srcEnd: number): BlockDraft {
  return {
    kind,
    renderNodes: [],
    srcStart,
    srcEnd,
    spoken: false,
    spokenText: '',
    tokens: [],
    cues: [],
    takes: [],
    idText: '',
  };
}

function makeWalkContext(state: CompilerState, draft: BlockDraft, collectTokens: boolean): WalkContext {
  return {
    draft,
    marks: [],
    collectTokens,
    source: state.source,
    options: {
      readInlineCode: state.readInlineCode,
      readImageAltText: state.readImageAltText,
    },
    diagnostics: state.diagnostics,
    assets: state.assets,
    pendingBlockId: () => '',
  };
}

function paragraphIsDirectiveOnly(draft: BlockDraft): boolean {
  if (draft.tokens.length > 0) return false;
  if (draft.cues.length === 0 && draft.takes.length === 0) return false;
  return draft.renderNodes.every(
    (node) =>
      node.type === 'cue' ||
      (node.type === 'text' && node.text.trim() === '') ||
      node.type === 'line_break',
  );
}

function paragraphIsImageOnly(draft: BlockDraft): boolean {
  if (!draft.assetIds || draft.assetIds.length === 0) return false;
  return draft.renderNodes.every(
    (node) => node.type === 'image' || (node.type === 'text' && node.text.trim() === ''),
  );
}

function buildParagraph(state: CompilerState, node: MdNode, spoken: boolean): BlockDraft {
  const draft = newDraft('paragraph', nodeStart(node), nodeEnd(node));
  const ctx = makeWalkContext(state, draft, spoken);
  for (const child of node.children ?? []) walkPhrasing(ctx, draft.renderNodes, child);
  if (paragraphIsDirectiveOnly(draft)) {
    draft.kind = 'cue';
    draft.spoken = false;
  } else if (paragraphIsImageOnly(draft)) {
    draft.kind = 'image';
    draft.spoken = false;
  } else {
    draft.spoken = spoken && draft.tokens.length > 0;
  }
  draft.idText = draft.spokenText || mdastToString(node as never);
  return draft;
}

function buildHeading(state: CompilerState, node: MdNode): BlockDraft {
  const draft = newDraft('heading', nodeStart(node), nodeEnd(node));
  const ctx = makeWalkContext(state, draft, state.readHeadings);
  for (const child of node.children ?? []) walkPhrasing(ctx, draft.renderNodes, child);
  draft.headingLevel = node.depth ?? 1;
  draft.headingTitle = mdastToString(node as never).trim();
  draft.spoken = state.readHeadings && draft.tokens.length > 0;
  draft.layoutHints = { level: draft.headingLevel };
  draft.idText = draft.headingTitle;
  draft.singleSentence = true;
  return draft;
}

function buildBlockquote(state: CompilerState, node: MdNode, spoken: boolean): BlockDraft {
  const draft = newDraft('blockquote', nodeStart(node), nodeEnd(node));
  const ctx = makeWalkContext(state, draft, spoken);
  let first = true;
  for (const child of node.children ?? []) {
    if (!first) draft.renderNodes.push({ type: 'line_break' });
    first = false;
    if (child.type === 'paragraph') {
      for (const grand of child.children ?? []) walkPhrasing(ctx, draft.renderNodes, grand);
    } else {
      // Nested structures inside quotes flatten to plain text in v1.
      const text = mdastToString(child as never);
      appendSpoken(ctx, draft.renderNodes, text, nodeStart(child), false, nodeEnd(child));
    }
  }
  draft.spoken = spoken && draft.tokens.length > 0;
  draft.idText = draft.spokenText || mdastToString(node as never);
  return draft;
}

function buildListItem(
  state: CompilerState,
  node: MdNode,
  spoken: boolean,
  ordered: boolean,
  index: number,
  depth: number,
): BlockDraft[] {
  const draft = newDraft('list_item', nodeStart(node), nodeEnd(node));
  draft.layoutHints = { ordered, index, depth };
  if (node.checked === true || node.checked === false) {
    draft.layoutHints['checked'] = node.checked; // checkbox omitted from speech (§22.2)
  }
  const ctx = makeWalkContext(state, draft, spoken);
  const out: BlockDraft[] = [];
  let first = true;
  for (const child of node.children ?? []) {
    if (child.type === 'list') continue; // handled below, as separate blocks
    if (child.type === 'paragraph') {
      if (!first) draft.renderNodes.push({ type: 'line_break' });
      for (const grand of child.children ?? []) walkPhrasing(ctx, draft.renderNodes, grand);
      first = false;
    } else if (child.type === 'code') {
      // rare: fenced code inside a list item — flattens to code text
      pushRenderText(draft, draft.renderNodes, child.value ?? '', ['code']);
    } else {
      const text = mdastToString(child as never);
      appendSpoken(ctx, draft.renderNodes, text, nodeStart(child), false, nodeEnd(child));
    }
  }
  draft.spoken = spoken && draft.tokens.length > 0;
  draft.singleSentence = true; // a list item is one navigation unit (§25.5)
  draft.idText = draft.spokenText || mdastToString(node as never);
  out.push(draft);
  // Nested lists become sibling blocks with deeper indent hints.
  for (const child of node.children ?? []) {
    if (child.type === 'list') {
      out.push(...buildList(state, child, spoken, depth + 1));
    }
  }
  return out;
}

function buildList(state: CompilerState, node: MdNode, spoken: boolean, depth: number): BlockDraft[] {
  const out: BlockDraft[] = [];
  const ordered = node.ordered === true;
  let index = typeof node.start === 'number' ? node.start : 1;
  for (const child of node.children ?? []) {
    if (child.type !== 'listItem') continue;
    out.push(...buildListItem(state, child, spoken, ordered, index, depth));
    index++;
  }
  return out;
}

function buildCode(state: CompilerState, node: MdNode): BlockDraft {
  const lang = (node.lang ?? '').toLowerCase();
  const value = node.value ?? '';
  const isMermaid = lang === 'mermaid';
  const draft = newDraft(isMermaid ? 'diagram' : 'code', nodeStart(node), nodeEnd(node));
  pushRenderText(draft, draft.renderNodes, value, ['code']);
  draft.spoken = false;
  draft.layoutHints = { language: lang };
  if (isMermaid) {
    const contentHash = hashString(value);
    const assetId = `diagram-${contentHash.slice(0, 8)}`;
    draft.layoutHints['contentHash'] = contentHash;
    // Rendering to inert SVG is deferred (spec §24.5); the IR carries the
    // raw source and a cache key so preparation can render later.
    draft.layoutHints['renderDeferred'] = true;
    (draft.assetIds ??= []).push(assetId);
    if (!state.assets.has(assetId)) {
      state.assets.set(assetId, {
        id: assetId,
        kind: 'diagram',
        blockId: '',
        href: '',
        alt: '',
        remote: false,
        contentHash,
      });
    }
  }
  draft.idText = value.slice(0, 200);
  return draft;
}

function buildTable(state: CompilerState, node: MdNode): BlockDraft {
  const draft = newDraft('table', nodeStart(node), nodeEnd(node));
  const ctx = makeWalkContext(state, draft, false);
  const rows: SafeRenderNode[][][] = [];
  for (const row of node.children ?? []) {
    if (row.type !== 'tableRow') continue;
    const cells: SafeRenderNode[][] = [];
    for (const cell of row.children ?? []) {
      const cellNodes: SafeRenderNode[] = [];
      for (const child of cell.children ?? []) walkPhrasing(ctx, cellNodes, child);
      cells.push(cellNodes);
    }
    rows.push(cells);
  }
  const align = (node.align ?? []).map((a) =>
    a === 'left' || a === 'center' || a === 'right' ? a : null,
  );
  draft.renderNodes = [{ type: 'table', align, headerRow: rows.length > 0, rows }];
  draft.spoken = false; // non-spoken by default (§22.2, §24.6)
  draft.idText = mdastToString(node as never).slice(0, 200);
  return draft;
}

function buildHtmlBlock(state: CompilerState, node: MdNode): BlockDraft | null {
  const value = (node.value ?? '').trim();
  if (value.startsWith('<!--')) return null; // HTML comment: not rendered, not spoken
  const draft = newDraft('paragraph', nodeStart(node), nodeEnd(node));
  state.diagnostics.push({
    code: 'raw_html_blocked',
    severity: 'warning',
    message: 'Raw HTML is not supported; the block renders as plain text.',
    blocking: false,
    source: { utf16Start: draft.srcStart, utf16End: draft.srcEnd },
    suggestedAction: 'open_source',
  });
  pushRenderText(draft, draft.renderNodes, node.value ?? '', []);
  draft.spoken = false;
  draft.layoutHints = { rawSource: true };
  draft.idText = value.slice(0, 200);
  return draft;
}

function buildSpokenOverride(state: CompilerState, region: ContainerRegion): BlockDraft {
  const draft = newDraft('paragraph', region.start, region.end);
  const spoken = region.spoken!;
  pushRenderText(draft, draft.renderNodes, spoken.visual, []);
  draft.layoutHints = { spokenOverride: true };
  draft.spokenText = spoken.say;
  const visualNormalized = normalizePhrase(spoken.visual);
  const sayTokens = tokenizeText(spoken.say);
  const renderRef = draft.renderNodes[0] as { tokenIndexes?: number[] };
  for (const raw of sayTokens) {
    const aliases = new Set<string>();
    if (visualNormalized) {
      aliases.add(visualNormalized);
      for (const word of visualNormalized.split(' ')) aliases.add(word);
    }
    draft.tokens.push({
      surface: raw.surface,
      srcStart: spoken.sayRange[0] + raw.start,
      srcEnd: spoken.sayRange[0] + raw.end,
      textStart: raw.start,
      textEnd: raw.end,
      extraAliases: [...aliases],
      flagsSeed: TOKEN_FLAGS.DIRECTIVE_ALIAS,
      isOverrideAnchor: true,
      renderRef,
    });
  }
  draft.spoken = draft.tokens.length > 0;
  draft.singleSentence = true;
  draft.idText = `${spoken.visual}|${spoken.say}`;
  return draft;
}

/** Apply container semantics to a compiled draft (§23.5, §23.6, §23.7). */
function applyContainer(draft: BlockDraft, region: ContainerRegion | undefined): BlockDraft {
  if (!region) return draft;
  if (region.kind === 'silent') {
    draft.layoutHints = { ...draft.layoutHints, innerKind: draft.kind };
    draft.kind = 'silent';
    draft.spoken = false;
    draft.tokens = [];
    return draft;
  }
  if (region.kind === 'stage') {
    draft.layoutHints = { ...draft.layoutHints, innerKind: draft.kind };
    draft.kind = 'stage_only';
    draft.spoken = false;
    draft.tokens = [];
    return draft;
  }
  if (region.kind === 'literal-command') {
    draft.layoutHints = { ...draft.layoutHints, literalCommand: true };
    draft.literalCommand = true;
    return draft;
  }
  return draft;
}

/* ------------------------------------------------------------------ */
/* Main entry                                                           */
/* ------------------------------------------------------------------ */

const parser = unified().use(remarkParse).use(remarkGfm);

export function compile(source: string, options: CompileOptions): CompiledScript {
  const wordsPerMinute = clampWpm(options.wordsPerMinute ?? DEFAULT_WORDS_PER_MINUTE);
  const state: CompilerState = {
    source,
    options,
    readHeadings: options.readHeadings ?? false,
    readImageAltText: options.readImageAltText ?? false,
    readInlineCode: options.readInlineCode ?? false,
    diagnostics: [],
    drafts: [],
    assets: new Map(),
  };

  // 1. Container scan (spec §23) then Markdown parse of the masked source.
  const scan = scanContainers(source);
  state.diagnostics.push(...scan.diagnostics);
  const tree = parser.parse(scan.maskedSource) as unknown as MdNode;

  // 2. Build block drafts in document order, merging :::spoken regions in.
  const spokenRegions = scan.regions
    .filter((r) => r.kind === 'spoken' && r.spoken)
    .sort((a, b) => a.start - b.start);
  let spokenCursor = 0;

  const emitSpokenRegionsBefore = (offset: number) => {
    while (spokenCursor < spokenRegions.length && spokenRegions[spokenCursor]!.start < offset) {
      state.drafts.push(buildSpokenOverride(state, spokenRegions[spokenCursor]!));
      spokenCursor++;
    }
  };

  for (const node of tree.children ?? []) {
    emitSpokenRegionsBefore(nodeStart(node));
    const region = containerAt(scan.regions, nodeStart(node));
    const spokenDefault = region?.kind !== 'silent' && region?.kind !== 'stage';
    switch (node.type) {
      case 'paragraph':
        state.drafts.push(applyContainer(buildParagraph(state, node, spokenDefault), region));
        break;
      case 'heading':
        state.drafts.push(applyContainer(buildHeading(state, node), region));
        break;
      case 'blockquote':
        state.drafts.push(applyContainer(buildBlockquote(state, node, spokenDefault), region));
        break;
      case 'list':
        for (const draft of buildList(state, node, spokenDefault, 0)) {
          state.drafts.push(applyContainer(draft, region));
        }
        break;
      case 'code':
        state.drafts.push(applyContainer(buildCode(state, node), region));
        break;
      case 'table':
        state.drafts.push(applyContainer(buildTable(state, node), region));
        break;
      case 'thematicBreak': {
        const draft = newDraft('divider', nodeStart(node), nodeEnd(node));
        draft.idText = 'divider';
        state.drafts.push(applyContainer(draft, region));
        break;
      }
      case 'html': {
        const draft = buildHtmlBlock(state, node);
        if (draft) state.drafts.push(applyContainer(draft, region));
        break;
      }
      case 'definition':
      case 'footnoteDefinition':
        break; // metadata, never rendered
      default: {
        // Unsupported extension node: readable source text + warning (§22.7).
        const raw = source.slice(nodeStart(node), nodeEnd(node));
        if (raw.trim()) {
          const draft = newDraft('paragraph', nodeStart(node), nodeEnd(node));
          pushRenderText(draft, draft.renderNodes, raw, []);
          draft.idText = raw.slice(0, 200);
          state.diagnostics.push({
            code: 'unsupported_syntax',
            severity: 'warning',
            message: `Unsupported Markdown node "${node.type}" renders as plain text.`,
            blocking: false,
            source: { utf16Start: nodeStart(node), utf16End: nodeEnd(node) },
            suggestedAction: 'open_source',
          });
          state.drafts.push(draft);
        }
      }
    }
  }
  emitSpokenRegionsBefore(Number.POSITIVE_INFINITY);

  // 3. Assign stable block IDs (§25.2).
  const blockIds = assignBlockIds(state.drafts, options.scriptId);

  // 4. Finalize tokens, sentences, cues, navigation, outline.
  return finalize(state, blockIds, wordsPerMinute, source);
}

function clampWpm(wpm: number): number {
  if (!Number.isFinite(wpm)) return DEFAULT_WORDS_PER_MINUTE;
  return Math.min(220, Math.max(70, wpm));
}

/** Stable content-hash block IDs with structural context (§25.2). */
function assignBlockIds(drafts: BlockDraft[], scriptId: string): string[] {
  const ids: string[] = [];
  const seen = new Map<string, number>();
  let headingContext = '';
  for (const draft of drafts) {
    if (draft.kind === 'heading' && draft.headingTitle) {
      headingContext = normalizePhrase(draft.headingTitle);
    }
    const normText = normalizePhrase(draft.idText).slice(0, 500);
    const base = hashString(`${scriptId}|${draft.kind}|${normText}|${headingContext}`);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    ids.push(count === 1 ? `b${base}` : `b${base}-${count}`);
  }
  return ids;
}

function finalize(
  state: CompilerState,
  blockIds: string[],
  wordsPerMinute: number,
  source: string,
): CompiledScript {
  const { drafts, diagnostics } = state;
  const options = state.options;

  const spokenTokens: SpokenToken[] = [];
  const sentences: SentenceUnit[] = [];
  const blocks: CompiledBlock[] = [];
  const cues: CueEvent[] = [];
  const navigationTargets: NavigationTarget[] = [];
  const takeLabelCounts = new Map<string, number>();
  const sentenceIdCounts = new Map<string, number>();
  const cueAnchors: { cue: CueEvent; anchor: number }[] = [];
  const takeAnchors: { target: NavigationTarget; anchor: number }[] = [];
  const headingStarts: { draftIndex: number; tokenStart: number }[] = [];

  // Pass A: mid-sentence capitalized forms, for proper-noun detection.
  const midSentenceCapitalized = collectMidSentenceCapitalized(drafts);

  for (let d = 0; d < drafts.length; d++) {
    const draft = drafts[d]!;
    const blockId = blockIds[d]!;
    const blockTokenStart = spokenTokens.length;

    if (draft.kind === 'heading') {
      headingStarts.push({ draftIndex: d, tokenStart: blockTokenStart });
    }

    // Sentence ranges over the block's spoken text.
    const sentenceRanges =
      draft.tokens.length === 0
        ? []
        : draft.singleSentence
          ? [{ start: 0, end: draft.spokenText.length, text: draft.spokenText }]
          : segmentSentences(draft.spokenText);

    // Bucket tokens into sentences by text offset.
    let rangeIndex = 0;
    const sentenceBuckets: TokenDraft[][] = sentenceRanges.map(() => []);
    for (const token of draft.tokens) {
      while (
        rangeIndex < sentenceRanges.length - 1 &&
        token.textStart >= sentenceRanges[rangeIndex]!.end
      ) {
        rangeIndex++;
      }
      if (sentenceBuckets.length > 0) sentenceBuckets[rangeIndex]!.push(token);
    }

    for (let s = 0; s < sentenceBuckets.length; s++) {
      const bucket = sentenceBuckets[s]!;
      if (bucket.length === 0) continue;
      const range = sentenceRanges[s]!;
      const normalizedText = normalizePhrase(range.text);
      const sentenceBase = hashString(`${blockId}|${normalizedText}`);
      const count = (sentenceIdCounts.get(sentenceBase) ?? 0) + 1;
      sentenceIdCounts.set(sentenceBase, count);
      const sentenceId = count === 1 ? `s${sentenceBase}` : `s${sentenceBase}-${count}`;
      const startIndex = spokenTokens.length;

      for (let t = 0; t < bucket.length; t++) {
        const tokenDraft = bucket[t]!;
        const normalized = normalizeToken(tokenDraft.surface);
        if (!normalized) continue;
        let flags = tokenDraft.flagsSeed;
        if (/^\$?[\d.,]+%?$/.test(normalized) || /\d/.test(normalized)) {
          flags |= TOKEN_FLAGS.NUMBER;
        }
        if (isStopword(normalized)) flags |= TOKEN_FLAGS.STOPWORD;
        const firstChar = tokenDraft.surface.charAt(0);
        const isCapitalized = /\p{Lu}/u.test(firstChar);
        const isAcronym = /^\p{Lu}{2,6}s?$/u.test(tokenDraft.surface.replace(/\./g, ''));
        const sentenceInitial = t === 0;
        if (
          isAcronym ||
          (isCapitalized &&
            !isStopword(normalized) &&
            (!sentenceInitial || midSentenceCapitalized.has(normalized)))
        ) {
          if (!/^\d/.test(normalized)) flags |= TOKEN_FLAGS.PROPER_NOUN;
        }
        const aliases = new Set<string>(aliasesForToken(tokenDraft.surface, normalized));
        for (const alias of tokenDraft.extraAliases ?? []) aliases.add(alias);
        aliases.delete(normalized);
        spokenTokens.push({
          index: spokenTokens.length,
          blockId,
          sentenceId,
          surface: tokenDraft.surface,
          normalized,
          aliases: [...aliases],
          weight: 0, // assigned after frequency pass
          source: { utf16Start: tokenDraft.srcStart, utf16End: tokenDraft.srcEnd },
          flags,
        });
        if (tokenDraft.renderRef) {
          (tokenDraft.renderRef.tokenIndexes ??= []).push(spokenTokens.length - 1);
        }
      }

      if (spokenTokens.length > startIndex) {
        const first = spokenTokens[startIndex]!;
        const last = spokenTokens[spokenTokens.length - 1]!;
        sentences.push({
          id: sentenceId,
          blockId,
          startTokenIndex: startIndex,
          endTokenIndex: spokenTokens.length - 1,
          normalizedText,
          source: { utf16Start: first.source.utf16Start, utf16End: last.source.utf16End },
        });
        // Command-collision warning (§25.1), suppressed in literal blocks.
        checkWakeCollision(
          state,
          normalizedText,
          draft,
          first.source.utf16Start,
          last.source.utf16End,
        );
      }
    }

    // Cue events and take markers anchored to the next spoken token.
    for (const cue of draft.cues) {
      const event: CueEvent = {
        id: `cue-${hashString(`${blockId}|${cue.cueType}|${cue.label}|${cue.srcStart}`).slice(0, 12)}`,
        blockId,
        cueType: cue.cueType,
        label: cue.label,
        anchorTokenIndex: 0,
        source: { utf16Start: cue.srcStart, utf16End: cue.srcEnd },
      };
      cues.push(event);
      cueAnchors.push({ cue: event, anchor: blockTokenStart + cue.localTokenCount });
    }
    for (const take of draft.takes) {
      const normalizedLabel = normalizePhrase(take.name);
      const ordinal = (takeLabelCounts.get(normalizedLabel) ?? 0) + 1;
      takeLabelCounts.set(normalizedLabel, ordinal);
      const target: NavigationTarget = {
        id: `take-${hashString(`${blockId}|${normalizedLabel}|${ordinal}`).slice(0, 12)}`,
        type: 'take',
        label: take.name,
        normalizedLabel,
        tokenIndex: 0,
        blockId,
        ordinalWithinLabel: ordinal,
      };
      navigationTargets.push(target);
      takeAnchors.push({ target, anchor: blockTokenStart + take.localTokenCount });
      const event: CueEvent = {
        id: `cue-${hashString(`${blockId}|take|${take.name}|${take.srcStart}`).slice(0, 12)}`,
        blockId,
        cueType: 'take',
        label: take.name,
        anchorTokenIndex: 0,
        source: { utf16Start: take.srcStart, utf16End: take.srcEnd },
      };
      cues.push(event);
      cueAnchors.push({ cue: event, anchor: blockTokenStart + take.localTokenCount });
    }

    const block: CompiledBlock = {
      id: blockId,
      kind: draft.kind,
      renderNodes: draft.renderNodes,
      source: { utf16Start: draft.srcStart, utf16End: draft.srcEnd },
      spoken: draft.spoken,
    };
    if (spokenTokens.length > blockTokenStart) {
      block.startTokenIndex = blockTokenStart;
      block.endTokenIndex = spokenTokens.length - 1;
    }
    if (draft.assetIds && draft.assetIds.length > 0) {
      block.assetIds = draft.assetIds;
      for (const assetId of draft.assetIds) {
        const asset = state.assets.get(assetId);
        if (asset && !asset.blockId) asset.blockId = blockId;
      }
    }
    if (draft.layoutHints && Object.keys(draft.layoutHints).length > 0) {
      block.layoutHints = draft.layoutHints;
    }
    blocks.push(block);
  }

  const totalTokens = spokenTokens.length;

  // Duplicate take names produce a readiness warning (§23.3).
  for (const [label, count] of takeLabelCounts) {
    if (count > 1) {
      diagnostics.push({
        code: 'take_duplicate_name',
        severity: 'warning',
        message: `Take name "${label}" is used ${count} times; voice navigation will need an ordinal.`,
        blocking: false,
      });
    }
  }

  // Resolve anchors now that the total token count is known.
  for (const { cue, anchor } of cueAnchors) {
    cue.anchorTokenIndex = anchor < totalTokens ? anchor : -1;
  }
  for (const { target, anchor } of takeAnchors) {
    target.tokenIndex = Math.min(anchor, Math.max(0, totalTokens - 1));
  }

  // Token weights need the frequency map (§25.7).
  const frequency = new Map<string, number>();
  for (const token of spokenTokens) {
    frequency.set(token.normalized, (frequency.get(token.normalized) ?? 0) + 1);
  }
  for (const token of spokenTokens) {
    token.weight = computeTokenWeight(
      token.normalized,
      token.flags,
      frequency.get(token.normalized) ?? 1,
      totalTokens,
    );
  }

  // Outline and heading navigation targets (§22.4).
  const outline = buildOutline(drafts, blockIds, headingStarts, totalTokens, options.scriptId, blocks);
  const headingLabelCounts = new Map<string, number>();
  const walkOutline = (nodes: OutlineNode[]) => {
    for (const node of nodes) {
      if (node.blockId) {
        const ordinal = (headingLabelCounts.get(node.normalizedTitle) ?? 0) + 1;
        headingLabelCounts.set(node.normalizedTitle, ordinal);
        navigationTargets.push({
          id: `nav-${node.id}`,
          type: 'heading',
          label: node.title,
          normalizedLabel: node.normalizedTitle,
          tokenIndex: Math.min(node.startTokenIndex, Math.max(0, totalTokens - 1)),
          blockId: node.blockId,
          ordinalWithinLabel: ordinal,
        });
      }
      walkOutline(node.children);
    }
  };
  walkOutline(outline);

  const firstBlockId = blocks[0]?.id ?? '';
  const lastBlockId = blocks[blocks.length - 1]?.id ?? '';
  navigationTargets.unshift({
    id: 'nav-beginning',
    type: 'beginning',
    label: 'Beginning',
    normalizedLabel: 'beginning',
    tokenIndex: 0,
    blockId: firstBlockId,
  });
  navigationTargets.push({
    id: 'nav-end',
    type: 'end',
    label: 'End',
    normalizedLabel: 'end',
    tokenIndex: Math.max(0, totalTokens - 1),
    blockId: lastBlockId,
  });

  // Statistics (§21.8).
  const assets = [...state.assets.values()];
  const nonSpokenKinds = new Set(['silent', 'stage_only', 'code', 'table', 'diagram']);
  const statistics = {
    spokenWordCount: totalTokens,
    wordsPerMinute,
    estimatedDurationSeconds: totalTokens > 0 ? Math.round((totalTokens / wordsPerMinute) * 60) : 0,
    nonSpokenBlockCount: blocks.filter((b) => nonSpokenKinds.has(b.kind)).length,
    imageCount: assets.filter((a) => a.kind === 'image').length,
    diagramCount: assets.filter((a) => a.kind === 'diagram').length,
    tableCount: blocks.filter(
      (b) => b.kind === 'table' || b.layoutHints?.['innerKind'] === 'table',
    ).length,
    cueCount: cues.filter((c) => c.cueType !== 'take').length,
    takeCount: cues.filter((c) => c.cueType === 'take').length,
    sentenceCount: sentences.length,
    blockCount: blocks.length,
  };

  const title = deriveTitle(drafts);

  return {
    schemaVersion: SCHEMA_VERSION,
    compilerVersion: COMPILER_VERSION,
    scriptId: options.scriptId,
    sourceHash: hashString(source),
    settingsHash: hashString(
      JSON.stringify({
        readHeadings: state.readHeadings,
        readImageAltText: state.readImageAltText,
        readInlineCode: state.readInlineCode,
        wordsPerMinute,
        wakePhrases: options.wakePhrases ?? DEFAULT_WAKE_PHRASES,
        compilerVersion: COMPILER_VERSION,
      }),
    ),
    title,
    outline,
    blocks,
    spokenTokens,
    sentences,
    navigationTargets,
    cues,
    assets,
    diagnostics,
    statistics,
    indexes: buildSearchIndexes(spokenTokens, sentences, blocks, navigationTargets),
  };
}

function checkWakeCollision(
  state: CompilerState,
  normalizedSentence: string,
  draft: BlockDraft,
  utf16Start: number,
  utf16End: number,
): void {
  if (draft.literalCommand) return; // §23.7: suppression inside literal blocks
  const wakePhrases = state.options.wakePhrases ?? DEFAULT_WAKE_PHRASES;
  for (const phrase of wakePhrases) {
    const normalizedPhrase = normalizePhrase(phrase);
    if (!normalizedPhrase) continue;
    if (normalizedSentence.includes(normalizedPhrase)) {
      state.diagnostics.push({
        code: 'command_collision',
        severity: 'warning',
        message: `A sentence contains the wake phrase "${phrase}". Mark it :::literal-command if it should be read aloud.`,
        blocking: false,
        source: { utf16Start, utf16End },
        suggestedAction: 'mark_literal_command',
      });
      return;
    }
  }
}

function collectMidSentenceCapitalized(drafts: BlockDraft[]): Set<string> {
  const result = new Set<string>();
  for (const draft of drafts) {
    if (!draft.spoken && draft.tokens.length === 0) continue;
    const ranges = draft.singleSentence
      ? [{ start: 0, end: draft.spokenText.length }]
      : segmentSentences(draft.spokenText);
    let rangeIndex = 0;
    let firstInRange = true;
    let lastRange = -1;
    for (const token of draft.tokens) {
      while (rangeIndex < ranges.length - 1 && token.textStart >= ranges[rangeIndex]!.end) {
        rangeIndex++;
      }
      if (rangeIndex !== lastRange) {
        firstInRange = true;
        lastRange = rangeIndex;
      }
      if (!firstInRange && /^\p{Lu}/u.test(token.surface)) {
        const normalized = normalizeToken(token.surface);
        if (normalized && !isStopword(normalized)) result.add(normalized);
      }
      firstInRange = false;
    }
  }
  return result;
}

function deriveTitle(drafts: BlockDraft[]): string {
  let firstHeading = '';
  for (const draft of drafts) {
    if (draft.kind !== 'heading' || !draft.headingTitle) continue;
    if (draft.headingLevel === 1) return draft.headingTitle;
    if (!firstHeading) firstHeading = draft.headingTitle;
  }
  return firstHeading || 'Script';
}

/** Build the outline with synthetic sections (§22.4). */
function buildOutline(
  drafts: BlockDraft[],
  blockIds: string[],
  headingStarts: { draftIndex: number; tokenStart: number }[],
  totalTokens: number,
  scriptId: string,
  blocks: CompiledBlock[],
): OutlineNode[] {
  interface FlatEntry {
    node: OutlineNode;
    level: number;
  }
  const flat: FlatEntry[] = [];
  const idCounts = new Map<string, number>();

  const makeNode = (
    level: number,
    title: string,
    blockId: string,
    startTokenIndex: number,
  ): OutlineNode => {
    const normalizedTitle = normalizePhrase(title);
    const base = hashString(`${scriptId}|outline|${level}|${normalizedTitle}`);
    const count = (idCounts.get(base) ?? 0) + 1;
    idCounts.set(base, count);
    return {
      id: count === 1 ? `h${base}` : `h${base}-${count}`,
      level,
      title,
      normalizedTitle,
      blockId,
      startTokenIndex,
      endTokenIndex: totalTokens - 1,
      children: [],
    };
  };

  if (headingStarts.length === 0) {
    // No headings: one synthetic "Script" section spanning everything.
    const synthetic = makeNode(1, 'Script', '', 0);
    synthetic.endTokenIndex = Math.max(0, totalTokens - 1);
    return [synthetic];
  }

  const firstHeadingDraft = headingStarts[0]!.draftIndex;
  const hasOpeningContent = drafts
    .slice(0, firstHeadingDraft)
    .some((d) => d.tokens.length > 0 || d.renderNodes.length > 0);
  if (hasOpeningContent) {
    const opening = makeNode(1, 'Opening', '', 0);
    opening.endTokenIndex = Math.max(0, headingStarts[0]!.tokenStart - 1);
    flat.push({ node: opening, level: 1 });
  }

  for (let h = 0; h < headingStarts.length; h++) {
    const { draftIndex, tokenStart } = headingStarts[h]!;
    const draft = drafts[draftIndex]!;
    const node = makeNode(
      draft.headingLevel ?? 1,
      draft.headingTitle ?? '',
      blockIds[draftIndex]!,
      tokenStart,
    );
    const nextStart = h + 1 < headingStarts.length ? headingStarts[h + 1]!.tokenStart : totalTokens;
    node.endTokenIndex = Math.max(tokenStart, nextStart - 1);
    flat.push({ node, level: node.level });
  }
  void blocks;

  // Nest by level with a stack; section end indexes widen to cover children.
  const roots: OutlineNode[] = [];
  const stack: OutlineNode[] = [];
  for (const entry of flat) {
    while (stack.length > 0 && stack[stack.length - 1]!.level >= entry.level) stack.pop();
    if (stack.length === 0) {
      roots.push(entry.node);
    } else {
      stack[stack.length - 1]!.children.push(entry.node);
    }
    stack.push(entry.node);
  }
  const widen = (node: OutlineNode): number => {
    let end = node.endTokenIndex;
    for (const child of node.children) end = Math.max(end, widen(child));
    node.endTokenIndex = end;
    return end;
  };
  for (const root of roots) widen(root);
  return roots;
}
