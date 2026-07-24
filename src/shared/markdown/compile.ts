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
  SpokenTokenRange,
} from '../contracts';
import { TOKEN_FLAGS } from '../contracts';
import { hashString, shortHash } from './hash';
import {
  ContainerIndex,
  classifyBracketDirective,
  resolveContainerSemantics,
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
  /** Authored visual text for spoken-override tokens (§23.4). */
  overrideVisual?: string;
  /**
   * Render text nodes to receive this token's global index. A token can span
   * several nodes: `**Candid**Cue` is one spoken word drawn from two nodes.
   */
  renderRefs: RenderRef[];
}

type RenderRef = { tokenIndexes?: number[] };

/**
 * Maps a local index inside an appended text run back to an absolute source
 * offset. `exact` is false when the mapping is a clamped approximation (the
 * run does not appear verbatim in the source), which also disables
 * source-adjacency merging.
 */
interface SpanMapper {
  at(localIndex: number): number;
  exact: boolean;
}

function clampedMapper(start: number, end: number): SpanMapper {
  return { at: (i) => Math.min(start + i, end), exact: false };
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
  /**
   * Absolute source offset just past the last spoken run appended to this
   * block, or -1 when unknown. Used to detect source adjacency so that
   * formatting boundaries inside a word do not split a spoken token.
   */
  lastSpokenSrcEnd: number;
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
  definitions: Map<string, string>;
  pendingBlockId: () => string;
}

/* ------------------------------------------------------------------ */
/* Inline walking                                                       */
/* ------------------------------------------------------------------ */

function pushRenderText(
  draft: BlockDraft,
  container: SafeRenderNode[],
  text: string,
  marks: MarkName[],
): RenderRef | undefined {
  if (!text) return undefined;
  const node: SafeRenderNode & { type: 'text' } = { type: 'text', text };
  if (marks.length > 0) node.marks = [...marks];
  container.push(node);
  return node as RenderRef;
}

/**
 * Characters that may sit between two source-adjacent inline runs without
 * introducing a spoken word boundary: emphasis, strong, strikethrough and
 * code-span delimiters. `**Candid**Cue` is said as one word "CandidCue", so
 * the gap "**" must not become a space (§22.3 — visual formatting never
 * changes token identity).
 */
const INLINE_DELIMITERS = /^[*_~`]*$/;
const MAX_DELIMITER_GAP = 8;

function isSourceAdjacent(source: string, from: number, to: number): boolean {
  if (to === from) return true;
  if (to < from || to - from > MAX_DELIMITER_GAP) return false;
  return INLINE_DELIMITERS.test(source.slice(from, to));
}

/** The token that ends exactly at `textPos`, eligible to absorb more text. */
function tokenEndingAt(draft: BlockDraft, textPos: number): TokenDraft | undefined {
  const last = draft.tokens[draft.tokens.length - 1];
  if (!last || last.isOverrideAnchor || last.textEnd !== textPos) return undefined;
  return last;
}

/** Append spoken words from `text`, mapped back to the source by `span`. */
function appendSpoken(
  ctx: WalkContext,
  container: SafeRenderNode[],
  text: string,
  span: SpanMapper,
): void {
  const { draft } = ctx;
  if (!text) return;
  const renderRef = pushRenderText(draft, container, text, ctx.marks);
  if (!ctx.collectTokens) {
    if (draft.spokenText) draft.spokenText += ' ';
    draft.lastSpokenSrcEnd = -1;
    return;
  }

  const srcBase = span.at(0);
  const adjacent =
    span.exact &&
    draft.lastSpokenSrcEnd >= 0 &&
    isSourceAdjacent(ctx.source, draft.lastSpokenSrcEnd, srcBase);
  if (draft.spokenText && !/\s$/.test(draft.spokenText) && !adjacent) draft.spokenText += ' ';

  const textBase = draft.spokenText.length;
  const mergeTarget = adjacent && !/^\s/.test(text) ? tokenEndingAt(draft, textBase) : undefined;
  draft.spokenText += text;

  const raws = tokenizeText(text);
  for (let i = 0; i < raws.length; i++) {
    const raw = raws[i]!;
    const srcStart = span.at(raw.start);
    const srcEnd = span.at(raw.end);
    if (i === 0 && mergeTarget && raw.start === 0) {
      // Continuation of the word that ended at the formatting boundary.
      mergeTarget.surface += raw.surface;
      mergeTarget.srcEnd = srcEnd;
      mergeTarget.textEnd = textBase + raw.end;
      if (renderRef) mergeTarget.renderRefs.push(renderRef);
      continue;
    }
    draft.tokens.push({
      surface: raw.surface,
      srcStart,
      srcEnd,
      textStart: textBase + raw.start,
      textEnd: textBase + raw.end,
      flagsSeed: 0,
      isOverrideAnchor: false,
      renderRefs: renderRef ? [renderRef] : [],
    });
  }
  draft.lastSpokenSrcEnd = span.exact ? span.at(text.length) : -1;
}

/* ------------------------------------------------------------------ */
/* URL safety (spec §22.6)                                             */
/* ------------------------------------------------------------------ */

/**
 * Schemes that may survive into the IR. The compiler's output is meant to be
 * trustworthy for *every* consumer — editor preview, reading preview, stage,
 * export, and any future clickable surface — so the allowlist lives here
 * rather than in each renderer. `asset:` is the application-controlled asset
 * scheme (§22.6); everything else (javascript:, data:, file:, blob:, vbscript:,
 * about:, protocol-relative //host) is dropped with a diagnostic.
 */
const ALLOWED_URL_SCHEMES: ReadonlySet<string> = new Set([
  'http',
  'https',
  'mailto',
  'tel',
  'asset',
]);

interface UrlVerdict {
  /** Safe URL to publish, or '' when the reference was dropped. */
  href: string;
  /** Loaded over the network (http/https) rather than from local storage. */
  remote: boolean;
  blockedScheme?: string;
}

/**
 * Parse and classify an authored URL. Control characters and whitespace are
 * stripped first: `java\nscript:alert(1)` and `\tjavascript:…` are the classic
 * ways to smuggle a scheme past a naive prefix test, and remark has already
 * decoded numeric/named entities by the time the URL reaches us.
 */
export function classifyUrl(raw: string): UrlVerdict {
  const url = raw.replace(/[\u0000-\u0020\u007f]/g, '');
  if (!url) return { href: '', remote: false };
  // Protocol-relative references inherit the app origin's scheme; treat them
  // as an unnamed remote scheme and drop them.
  if (url.startsWith('//')) return { href: '', remote: false, blockedScheme: '//' };
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  if (!schemeMatch) return { href: url, remote: false }; // relative local path
  const scheme = schemeMatch[1]!.toLowerCase();
  if (!ALLOWED_URL_SCHEMES.has(scheme)) return { href: '', remote: false, blockedScheme: scheme };
  return { href: url, remote: scheme === 'http' || scheme === 'https' };
}

function reportBlockedUrl(
  ctx: WalkContext,
  raw: string,
  scheme: string,
  srcStart: number,
  srcEnd: number,
): void {
  ctx.diagnostics.push({
    code: 'unsafe_url_blocked',
    severity: 'warning',
    message: `The "${scheme}" URL "${raw.slice(0, 80)}" is not an allowed reference and was removed.`,
    blocking: false,
    source: { utf16Start: srcStart, utf16End: srcEnd },
    suggestedAction: 'open_source',
  });
}

/* ------------------------------------------------------------------ */
/* Escape- and entity-aware source mapping                             */
/* ------------------------------------------------------------------ */

/**
 * Map every index of a decoded mdast text value back to its source offset.
 *
 * remark hands us decoded text: `\[Pause]` and `&#91;Pause&#93;` both arrive
 * as the literal string "[Pause]". Without this mapping the compiler cannot
 * tell an authored directive from an explicitly escaped one, and it would
 * turn `\[Pause]` into a cue. Returns null when the value cannot be aligned,
 * in which case callers fall back to clamped approximate offsets.
 */
const ENTITY_AT = /^&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/;

function mapValueToSource(
  source: string,
  start: number,
  end: number,
  value: string,
): number[] | null {
  const map = new Array<number>(value.length + 1);
  let s = start;
  let v = 0;
  while (v < value.length && s < end) {
    if (source[s] === '&') {
      // Entity check must precede the literal comparison: `&amp;` decodes to
      // "&", so a plain equality test would consume only the ampersand and
      // then desynchronize on "amp;".
      const entity = ENTITY_AT.exec(source.slice(s, Math.min(end, s + 34)));
      if (entity) {
        map[v] = s; // points at '&': not a literal '[' for directive purposes
        s += entity[0].length;
        v++;
        continue;
      }
    }
    if (source[s] === value[v]) {
      map[v] = s;
      s++;
      v++;
      continue;
    }
    if (source[s] === '\\' && s + 1 < end && source[s + 1] === value[v]) {
      map[v] = s; // points at the backslash: not a literal '[' either
      s += 2;
      v++;
      continue;
    }
    return null;
  }
  if (v !== value.length) return null;
  map[value.length] = s;
  return map;
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
  const verbatim = ctx.source.slice(base, end) === value;
  const map = verbatim ? null : mapValueToSource(ctx.source, base, end, value);
  const exact = verbatim || map !== null;
  const srcAt = (i: number): number => (map ? map[i]! : Math.min(base + i, end));
  const spanFrom = (offset: number): SpanMapper => ({ at: (i) => srcAt(offset + i), exact });
  /** A syntax character is only syntax when it is literal in the source. */
  const isLiteral = (valueIndex: number, ch: string): boolean =>
    exact && ctx.source[srcAt(valueIndex)] === ch;

  INLINE_DIRECTIVE_GLOBAL.lastIndex = 0;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE_DIRECTIVE_GLOBAL.exec(value)) !== null) {
    if (match[3] !== undefined) {
      // Bracketed span: only known directives are special (§23.2, §23.3),
      // and only when both brackets are literal source characters. `\[Pause]`
      // and `&#91;Pause&#93;` stay ordinary text.
      const directive = classifyBracketDirective(match[3]);
      if (directive.kind === 'none') continue; // ordinary text, handled below
      const closeIndex = match.index + match[0]!.length - 1;
      if (!isLiteral(match.index, '[') || !isLiteral(closeIndex, ']')) continue;
      const before = value.slice(cursor, match.index);
      appendSpoken(ctx, container, before, spanFrom(cursor));
      const srcStart = srcAt(match.index);
      const srcEnd = srcAt(match.index + match[0]!.length);
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
    if (!isLiteral(match.index + visual.length, '{')) continue; // escaped brace
    const before = value.slice(cursor, match.index);
    appendSpoken(ctx, container, before, spanFrom(cursor));

    // The visual word renders; the say text enters the alignment stream
    // (§23.4). Every spoken word becomes its own token so the one-transcript-
    // word-per-script-token matcher can consume them all, but all of them map
    // to the visual word's source range and its single render node.
    const visualStart = srcAt(match.index);
    const visualEnd = srcAt(match.index + visual.length);
    const textRef = pushRenderText(ctx.draft, container, visual, ctx.marks);
    if (ctx.collectTokens) {
      if (!say.trim()) {
        ctx.diagnostics.push({
          code: 'directive_say_empty',
          severity: 'warning',
          message: `The {say="…"} alias on "${visual}" is empty and was ignored.`,
          blocking: false,
          source: { utf16Start: visualStart, utf16End: srcAt(match.index + match[0]!.length) },
          suggestedAction: 'fix_directive',
        });
      }
      appendOverrideTokens(ctx.draft, {
        visual,
        say,
        srcStart: visualStart,
        srcEnd: visualEnd,
        renderRef: textRef,
      });
    }
    cursor = match.index + match[0]!.length;
    ctx.draft.lastSpokenSrcEnd = -1;
  }
  appendSpoken(ctx, container, value.slice(cursor), spanFrom(cursor));
}

/**
 * Expand a spoken override into real spoken tokens (§23.4).
 *
 * The tracker pairs exactly one transcript word with one script token, so a
 * multi-word `say` value must become multiple tokens; a single token carrying
 * "a p i" as an alias could only ever absorb one of the three words spoken
 * and the other two would be charged as insertions. Every produced token
 * keeps the *visual* source range, which is what §23.4 requires.
 *
 * Visual-form aliases (for a presenter who reads the page instead of the
 * override) are attached positionally when the word counts line up, and
 * otherwise only to the first token — never as a cross product, which would
 * let one spoken word match any token in the override.
 */
function appendOverrideTokens(
  draft: BlockDraft,
  spec: {
    visual: string;
    say: string;
    srcStart: number;
    srcEnd: number;
    renderRef?: RenderRef;
    /** Absolute offset of the say text, when it has its own source range. */
    sayStart?: number;
  },
): void {
  const sayTokens = tokenizeText(spec.say);
  const visualWords = tokenizeText(spec.visual)
    .map((t) => normalizeToken(t.surface))
    .filter((w) => w.length > 0);
  const refs = spec.renderRef ? [spec.renderRef] : [];

  if (sayTokens.length === 0) {
    // Empty or unspeakable say value: fall back to the visual word verbatim.
    if (draft.spokenText && !/\s$/.test(draft.spokenText)) draft.spokenText += ' ';
    const textBase = draft.spokenText.length;
    draft.spokenText += spec.visual;
    for (const raw of tokenizeText(spec.visual)) {
      draft.tokens.push({
        surface: raw.surface,
        srcStart: spec.srcStart,
        srcEnd: spec.srcEnd,
        textStart: textBase + raw.start,
        textEnd: textBase + raw.end,
        flagsSeed: 0,
        isOverrideAnchor: false,
        renderRefs: [...refs],
      });
    }
    return;
  }

  if (draft.spokenText && !/\s$/.test(draft.spokenText)) draft.spokenText += ' ';
  const textBase = draft.spokenText.length;
  draft.spokenText += spec.say;
  const positional = visualWords.length === sayTokens.length;
  const sayPhrase = normalizePhrase(spec.say);
  for (let i = 0; i < sayTokens.length; i++) {
    const raw = sayTokens[i]!;
    const aliases = positional
      ? [visualWords[i]!]
      : i === 0
        ? [...visualWords]
        : [];
    // The full say phrase never matches a single transcript word, but it is
    // the pronunciation payload vocabulary preparation reads (§26.4).
    if (i === 0 && sayTokens.length > 1 && sayPhrase) aliases.push(sayPhrase);
    draft.tokens.push({
      surface: raw.surface,
      ...(spec.visual ? { overrideVisual: spec.visual } : {}),
      srcStart: spec.sayStart === undefined ? spec.srcStart : spec.sayStart + raw.start,
      srcEnd: spec.sayStart === undefined ? spec.srcEnd : spec.sayStart + raw.end,
      textStart: textBase + raw.start,
      textEnd: textBase + raw.end,
      extraAliases: aliases,
      flagsSeed: TOKEN_FLAGS.DIRECTIVE_ALIAS,
      isOverrideAnchor: true,
      renderRefs: [...refs],
    });
  }
}

function registerImage(
  ctx: WalkContext,
  container: SafeRenderNode[],
  node: MdNode,
  urlOverride?: string,
): void {
  const raw = urlOverride ?? node.url ?? '';
  const alt = node.alt ?? '';
  const start = nodeStart(node);
  const end = nodeEnd(node);
  const verdict = classifyUrl(raw);
  if (verdict.blockedScheme) {
    // Never disappears silently (§22.7): the alt text stays readable.
    reportBlockedUrl(ctx, raw, verdict.blockedScheme, start, end);
    pushRenderText(ctx.draft, container, alt, ctx.marks);
    return;
  }

  const assetId = `img-${shortHash(verdict.href || alt)}`;
  if (!ctx.assets.has(assetId)) {
    ctx.assets.set(assetId, {
      id: assetId,
      kind: 'image',
      blockId: '',
      href: verdict.href,
      alt,
      remote: verdict.remote,
    });
  }
  if (verdict.remote) {
    ctx.diagnostics.push({
      code: 'remote_image_blocked',
      severity: 'warning',
      message: `Remote image "${verdict.href}" is not loaded automatically (import a local copy).`,
      blocking: false,
      source: { utf16Start: start, utf16End: end },
      suggestedAction: 'import_asset',
    });
  }
  container.push({ type: 'image', assetId, alt });
  (ctx.draft.assetIds ??= []).push(assetId);
  if (ctx.options.readImageAltText && alt && ctx.collectTokens) {
    // Spoken representation is the alt text when explicitly enabled (§22.2).
    // The render text goes to a discarded container: the image node itself
    // is the visual representation; only the tokens matter here.
    // `![` opens the node, so the alt text starts two characters in — using
    // the node start would map every alt token onto the wrong source text.
    const altStart = ctx.source.startsWith('![', start) ? start + 2 : start;
    const altExact = ctx.source.startsWith(alt, altStart);
    appendSpoken(
      ctx,
      [],
      alt,
      altExact ? { at: (i) => altStart + i, exact: true } : clampedMapper(altStart, end),
    );
    ctx.draft.lastSpokenSrcEnd = -1;
  }
}

/**
 * Emit a link node. The label is walked normally (link labels are spoken,
 * URLs never are — §22.2); the href goes through the scheme allowlist so no
 * consumer of the IR has to re-sanitize it.
 */
function pushLink(
  ctx: WalkContext,
  container: SafeRenderNode[],
  node: MdNode,
  rawUrl: string,
): void {
  const label: SafeRenderNode[] = [];
  for (const child of node.children ?? []) walkPhrasing(ctx, label, child);
  const verdict = classifyUrl(rawUrl);
  if (verdict.blockedScheme) {
    reportBlockedUrl(ctx, rawUrl, verdict.blockedScheme, nodeStart(node), nodeEnd(node));
  }
  container.push({
    type: 'link',
    label,
    ...(verdict.href ? { href: verdict.href } : {}),
    external: verdict.remote,
  });
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
      if (!ctx.options.readInlineCode || !ctx.collectTokens) {
        pushRenderText(ctx.draft, container, value, [...ctx.marks, 'code']);
        // Skipped code interrupts a word run: `re`+`ing` around an unspoken
        // span are separate spoken words, not one.
        ctx.draft.lastSpokenSrcEnd = -1;
        return;
      }
      // Literal code tokenization (§22.2). The value sits just inside the
      // opening backtick(s); locate it exactly so offsets round-trip.
      const start = nodeStart(node);
      const end = nodeEnd(node);
      const valueStart = ctx.source.indexOf(value, start);
      const exact = value.length > 0 && valueStart >= 0 && valueStart + value.length <= end;
      const marks = [...ctx.marks, 'code'] as MarkName[];
      appendSpoken(
        { ...ctx, marks },
        container,
        value,
        exact ? { at: (i) => valueStart + i, exact: true } : clampedMapper(start + 1, end),
      );
      return;
    }
    case 'break':
      container.push({ type: 'line_break' });
      if (ctx.collectTokens) ctx.draft.spokenText += ' ';
      ctx.draft.lastSpokenSrcEnd = -1;
      return;
    case 'link': {
      pushLink(ctx, container, node, node.url ?? '');
      return;
    }
    case 'image':
      registerImage(ctx, container, node);
      return;
    case 'imageReference': {
      const definition = ctx.definitions.get(node.identifier ?? '');
      if (definition !== undefined) {
        registerImage(ctx, container, node, definition);
        return;
      }
      // Unresolved reference: render the alt text (CommonMark shows the raw
      // bracket text, but alt is the readable intent and never spoken).
      pushRenderText(ctx.draft, container, node.alt ?? '', ctx.marks);
      return;
    }
    case 'linkReference': {
      const definition = ctx.definitions.get(node.identifier ?? '');
      if (definition !== undefined) {
        pushLink(ctx, container, node, definition);
        return;
      }
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
      ctx.draft.lastSpokenSrcEnd = -1;
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
  /** Link/image reference definitions, keyed by normalized identifier. */
  definitions: Map<string, string>;
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
    lastSpokenSrcEnd: -1,
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
    definitions: state.definitions,
    pendingBlockId: () => '',
  };
}

/**
 * Compile a non-paragraph child of a blockquote or list item with the same
 * typed handlers the top level uses.
 *
 * Flattening these through `mdastToString` used to push fenced code, table
 * cells and image alt text into the alignment stream, which §22.2 says are
 * never spoken. Reading order inside a table or code block is ambiguous and
 * alignment-hostile, so the nested content renders but stays silent.
 */
function appendNestedBlock(
  state: CompilerState,
  ctx: WalkContext,
  draft: BlockDraft,
  child: MdNode,
): void {
  switch (child.type) {
    case 'paragraph':
      for (const grand of child.children ?? []) walkPhrasing(ctx, draft.renderNodes, grand);
      return;
    case 'heading': {
      const headingCtx = { ...ctx, collectTokens: ctx.collectTokens && state.readHeadings };
      for (const grand of child.children ?? []) walkPhrasing(headingCtx, draft.renderNodes, grand);
      draft.lastSpokenSrcEnd = -1;
      return;
    }
    case 'code': {
      // Fenced code: visual only (§22.2).
      pushRenderText(draft, draft.renderNodes, child.value ?? '', ['code']);
      draft.lastSpokenSrcEnd = -1;
      return;
    }
    case 'table': {
      const silent = { ...ctx, collectTokens: false };
      draft.renderNodes.push(buildTableNode(silent, child));
      draft.lastSpokenSrcEnd = -1;
      return;
    }
    case 'blockquote':
    case 'listItem':
      for (const grand of child.children ?? []) appendNestedBlock(state, ctx, draft, grand);
      return;
    case 'list':
      for (const item of child.children ?? []) {
        if (item.type !== 'listItem') continue;
        draft.renderNodes.push({ type: 'line_break' });
        draft.lastSpokenSrcEnd = -1;
        for (const grand of item.children ?? []) appendNestedBlock(state, ctx, draft, grand);
      }
      return;
    case 'thematicBreak':
      draft.renderNodes.push({ type: 'line_break' });
      draft.lastSpokenSrcEnd = -1;
      return;
    case 'html':
    case 'definition':
    case 'footnoteDefinition':
      return;
    default: {
      // Unknown nested structure: readable, never spoken (§22.7).
      pushRenderText(draft, draft.renderNodes, mdastToString(child as never), []);
      draft.lastSpokenSrcEnd = -1;
    }
  }
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
    if (!first) {
      draft.renderNodes.push({ type: 'line_break' });
      draft.lastSpokenSrcEnd = -1;
    }
    first = false;
    appendNestedBlock(state, ctx, draft, child);
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
    if (!first) {
      draft.renderNodes.push({ type: 'line_break' });
      draft.lastSpokenSrcEnd = -1;
    }
    first = false;
    appendNestedBlock(state, ctx, draft, child);
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

/** Structured table render node; cells are walked but never spoken (§22.2). */
function buildTableNode(ctx: WalkContext, node: MdNode): SafeRenderNode {
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
  return { type: 'table', align, headerRow: rows.length > 0, rows };
}

function buildTable(state: CompilerState, node: MdNode): BlockDraft {
  const draft = newDraft('table', nodeStart(node), nodeEnd(node));
  const ctx = makeWalkContext(state, draft, false);
  draft.renderNodes = [buildTableNode(ctx, node)];
  draft.spoken = false; // non-spoken by default (§22.2, §24.6)
  draft.idText = mdastToString(node as never);
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

function buildSpokenOverride(region: ContainerRegion): BlockDraft {
  const draft = newDraft('paragraph', region.start, region.end);
  const spoken = region.spoken!;
  const renderRef = pushRenderText(draft, draft.renderNodes, spoken.visual, []);
  draft.layoutHints = { spokenOverride: true };
  appendOverrideTokens(draft, {
    visual: spoken.visual,
    say: spoken.say,
    srcStart: spoken.sayRange[0],
    srcEnd: spoken.sayRange[1],
    sayStart: spoken.sayRange[0],
    ...(renderRef ? { renderRef } : {}),
  });
  draft.spoken = draft.tokens.length > 0;
  draft.singleSentence = true;
  draft.idText = `${spoken.visual}|${spoken.say}`;
  return draft;
}

/**
 * A closed but malformed :::spoken block. Its body is masked out of the
 * Markdown stream, so without this the content would vanish from preview
 * entirely; §23.8 requires malformed directives to stay visible as source.
 */
function buildSpokenErrorCard(source: string, region: ContainerRegion): BlockDraft {
  const draft = newDraft('paragraph', region.start, region.end);
  pushRenderText(draft, draft.renderNodes, source.slice(region.start, region.end).trimEnd(), []);
  draft.layoutHints = { directiveError: 'directive_spoken_malformed', rawSource: true };
  draft.spoken = false;
  draft.idText = source.slice(region.start, region.end);
  return draft;
}

/** Apply container semantics to a compiled draft (§23.5, §23.6, §23.7). */
function applyContainer(draft: BlockDraft, region: ContainerRegion | undefined): BlockDraft {
  if (!region) return draft;
  const semantics = resolveContainerSemantics(region);
  if (semantics.literalCommand) {
    draft.layoutHints = { ...draft.layoutHints, literalCommand: true };
    draft.literalCommand = true;
  }
  // Suppression from any enclosing container wins; `silent` outranks `stage`.
  if (semantics.silent || semantics.stage) {
    draft.layoutHints = { ...draft.layoutHints, innerKind: draft.kind };
    draft.kind = semantics.silent ? 'silent' : 'stage_only';
    draft.spoken = false;
    draft.tokens = [];
    draft.literalCommand = false;
  }
  return draft;
}

/* ------------------------------------------------------------------ */
/* Main entry                                                           */
/* ------------------------------------------------------------------ */

const parser = unified().use(remarkParse).use(remarkGfm);

/**
 * Collect link/image reference definitions. They are metadata and never
 * render, but discarding them turns valid CommonMark reference links into
 * literal bracket text and drops reference images entirely (§22.1).
 */
function collectDefinitions(node: MdNode, into: Map<string, string>): void {
  if (node.type === 'definition') {
    const identifier = node.identifier ?? node.label ?? '';
    if (identifier && !into.has(identifier)) into.set(identifier, node.url ?? '');
    return;
  }
  for (const child of node.children ?? []) collectDefinitions(child, into);
}

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
    definitions: new Map(),
  };

  // 1. Container scan (spec §23) then Markdown parse of the masked source.
  const scan = scanContainers(source);
  state.diagnostics.push(...scan.diagnostics);
  const tree = parser.parse(scan.maskedSource) as unknown as MdNode;
  collectDefinitions(tree, state.definitions);
  const containers = new ContainerIndex(scan.regions);

  // 2. Build block drafts in document order, merging :::spoken regions in.
  // Malformed-but-closed :::spoken blocks emit a warning card so their text
  // does not disappear from preview (§23.8).
  const spokenRegions = scan.regions.filter(
    (r) => r.kind === 'spoken' && (r.spoken || r.spokenMalformed),
  );
  let spokenCursor = 0;

  const emitSpokenRegionsBefore = (offset: number) => {
    while (spokenCursor < spokenRegions.length && spokenRegions[spokenCursor]!.start < offset) {
      const region = spokenRegions[spokenCursor]!;
      const draft = region.spoken
        ? buildSpokenOverride(region)
        : buildSpokenErrorCard(source, region);
      // §23.6: an explicit :::spoken block stays spoken inside :::stage, but a
      // literal-command ancestor still applies.
      const parentSemantics = resolveContainerSemantics(region.parent);
      if (parentSemantics.literalCommand) {
        draft.layoutHints = { ...draft.layoutHints, literalCommand: true };
        draft.literalCommand = true;
      }
      state.drafts.push(draft);
      spokenCursor++;
    }
  };

  for (const node of tree.children ?? []) {
    emitSpokenRegionsBefore(nodeStart(node));
    const region = containers.at(nodeStart(node));
    const semantics = resolveContainerSemantics(region);
    const spokenDefault = !semantics.silent && !semantics.stage;
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
  const blockIds = assignBlockIds(state.drafts, options.scriptId, state.diagnostics);

  // 4. Finalize tokens, sentences, cues, navigation, outline.
  return finalize(state, blockIds, wordsPerMinute, source);
}

function clampWpm(wpm: number): number {
  if (!Number.isFinite(wpm)) return DEFAULT_WORDS_PER_MINUTE;
  return Math.min(220, Math.max(70, wpm));
}

/**
 * Stable content-hash block IDs with structural context (§25.2).
 *
 * Two blocks with identical text and identical heading context hash the same.
 * Resolving that with a document-order ordinal (base, base-2, …) is unsafe:
 * deleting the *first* of two identical paragraphs hands its ID to the
 * second, so any stage state keyed by block ID silently migrates onto a
 * different paragraph mid-session. Instead, every member of a colliding group
 * is disambiguated by a fingerprint of its neighbours — so no block ever
 * inherits an ID that belonged to a different block. When even the
 * neighbourhood is identical, content hashing cannot distinguish the blocks
 * at all; that residue falls back to an ordinal and reports itself.
 */
function assignBlockIds(
  drafts: BlockDraft[],
  scriptId: string,
  diagnostics: CompileDiagnostic[],
): string[] {
  const bases: string[] = [];
  const groups = new Map<string, number[]>();
  let headingContext = '';
  for (let i = 0; i < drafts.length; i++) {
    const draft = drafts[i]!;
    if (draft.kind === 'heading' && draft.headingTitle) {
      headingContext = normalizePhrase(draft.headingTitle);
    }
    // No truncation: capping the text at 500 characters made two different
    // long paragraphs sharing a prefix hash to the same ID.
    const normText = normalizePhrase(draft.idText);
    const base = hashString(`${scriptId}|${draft.kind}|${normText}|${headingContext}`);
    bases.push(base);
    const group = groups.get(base);
    if (group) group.push(i);
    else groups.set(base, [i]);
  }

  const neighbourFingerprint = (index: number): string => {
    const before = index > 0 ? normalizePhrase(drafts[index - 1]!.idText) : ' start';
    const after =
      index + 1 < drafts.length ? normalizePhrase(drafts[index + 1]!.idText) : ' end';
    return shortHash(`${before} ${after}`);
  };

  const ids: string[] = new Array<string>(drafts.length);
  for (const [base, indexes] of groups) {
    if (indexes.length === 1) {
      ids[indexes[0]!] = `b${base}`;
      continue;
    }
    const used = new Map<string, number>();
    for (const index of indexes) {
      const fingerprint = neighbourFingerprint(index);
      const repeat = (used.get(fingerprint) ?? 0) + 1;
      used.set(fingerprint, repeat);
      if (repeat === 1) {
        ids[index] = `b${base}-${fingerprint}`;
        continue;
      }
      ids[index] = `b${base}-${fingerprint}-${repeat}`;
      diagnostics.push({
        code: 'block_id_ambiguous',
        severity: 'warning',
        message:
          'Two blocks are identical and have identical surrounding text, so their ' +
          'internal IDs depend on document order and may swap when one is deleted.',
        blocking: false,
        source: {
          utf16Start: drafts[index]!.srcStart,
          utf16End: drafts[index]!.srcEnd,
        },
        suggestedAction: 'open_source',
      });
    }
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
  const literalCommandRanges: SpokenTokenRange[] = [];
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
          ...(tokenDraft.overrideVisual ? { overrideVisual: tokenDraft.overrideVisual } : {}),
        });
        for (const ref of tokenDraft.renderRefs) {
          (ref.tokenIndexes ??= []).push(spokenTokens.length - 1);
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

    // §23.7: typed token ranges the command router uses to suppress detection.
    if (draft.literalCommand && spokenTokens.length > blockTokenStart) {
      const previous = literalCommandRanges[literalCommandRanges.length - 1];
      if (previous && previous.endTokenIndex + 1 === blockTokenStart) {
        previous.endTokenIndex = spokenTokens.length - 1;
      } else {
        literalCommandRanges.push({
          startTokenIndex: blockTokenStart,
          endTokenIndex: spokenTokens.length - 1,
        });
      }
    }
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
    literalCommandRanges,
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

  const makeNode = (
    level: number,
    title: string,
    blockId: string,
    startTokenIndex: number,
  ): OutlineNode => {
    const normalizedTitle = normalizePhrase(title);
    // Derived from the heading's block ID, which assignBlockIds has already
    // made unique without a document-order ordinal. Two identical headings
    // therefore get distinct, non-migrating outline IDs for free.
    const base = hashString(`${scriptId}|outline|${level}|${blockId}|${normalizedTitle}`);
    return {
      id: `h${base}`,
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
