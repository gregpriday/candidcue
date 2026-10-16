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
  CoachDirectiveSpan,
  CompileDiagnostic,
  CompileOptions,
  CompiledAsset,
  CompiledBlock,
  CompiledCoachingDirectives,
  CompiledScript,
  CueEvent,
  NavigationTarget,
  OutlineNode,
  SafeRenderNode,
  SentenceUnit,
  SpokenToken,
  SpokenTokenRange,
} from '../contracts';
import { hashString, shortHash } from './hash';
import { DEFAULT_WORDS_PER_MINUTE } from '../speaking-rate';
import {
  BYTE_ORDER_MARK,
  ContainerIndex,
  classifyBracketDirective,
  classifyCoachComment,
  resolveContainerSemantics,
  scanContainers,
  scanFrontMatter,
  type CoachDirective,
  type ContainerRegion,
} from './directives';
import { normalizePhrase, normalizeToken } from './normalize';
import { tokenizeText } from './tokenize';
import { segmentSentences } from './segment';
import { deriveParts } from './parts';

/*
 * Bumped for `wordTokens`, and before that for the grammatical-sentence-end
 * field.
 *
 * This is the compiled-document cache key, and both bumps are for the same
 * reason: the new field is ADDITIVE, so a document compiled by an older version
 * is still valid and still renders — it just renders the old way. A 1.1.0
 * document has no per-word mapping, so every paragraph containing a word that
 * is written and not spoken goes back to being unanchored past its first word.
 * A cache that answered with one would reinstate the bug quietly, which is
 * exactly what a version key is for.
 *
 * 1.2.1 is a correction, not a field: a source opening with a byte-order mark
 * used to compile with every position one character early and its line-one
 * directive ignored (#247). Only those documents change.
 *
 * 1.2.2 is another: words on the second and later lines of a quote or a
 * wrapped list item mapped early by the width of the line prefix, and a
 * directive there was ignored (#251).
 */
export const COMPILER_VERSION = '1.2.2';
export const SCHEMA_VERSION = 1;
export { DEFAULT_WORDS_PER_MINUTE };
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

/**
 * micromark skips a leading byte-order mark and counts every position from the
 * character after it, while the scanners and every `source.slice` here index
 * the real document, mark included. Left alone, every token mapped one
 * character early (`Hello` read as `\uFEFFHell`, #247). Points are replaced,
 * never mutated, so a point object two nodes happen to share moves once.
 */
function shiftPastByteOrderMark(node: MdNode): void {
  if (node.position) {
    node.position = {
      start: shiftPoint(node.position.start),
      end: shiftPoint(node.position.end),
    };
  }
  for (const child of node.children ?? []) shiftPastByteOrderMark(child);
}

const LEADING_BYTE_ORDER_MARKS = /^\uFEFF+/;

function shiftPoint(point: MdPoint): MdPoint {
  const shifted: MdPoint = {
    line: point.line,
    column: point.line === 1 ? point.column + 1 : point.column,
  };
  if (point.offset !== undefined) shifted.offset = point.offset + 1;
  return shifted;
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
  isOverrideAnchor: boolean;
  /** Authored visual text for spoken-override tokens (§23.4). */
  overrideVisual?: string;
  /**
   * Render text nodes to receive this token's global index. A token can span
   * several nodes: `**Candid**Cue` is one spoken word drawn from two nodes.
   */
  renderRefs: RenderSlot[];
}

type RenderRef = { text: string; tokenIndexes?: number[]; wordTokens?: (number | null)[] };

/**
 * A node to receive a token's index, and WHICH of that node's words it is.
 *
 * The word slot is recorded here, at the only point in the compile where it is
 * known: the tokenizer is a regex over the whole run rather than a walk of
 * whitespace-separated words, so once a token is a `TokenDraft` there is
 * nothing left that says which word it came out of. Recovering it downstream
 * means running a second tokenizer beside this one and hoping the two agree —
 * see the note on `SafeRenderNode.wordTokens` for what that cost.
 */
type RenderSlot = { ref: RenderRef; wordSlot: number };

/**
 * Word-start offsets in a rendered text run, in order.
 *
 * The same split the renderers do (`segmentText`, `flattenWords`): whitespace
 * separates words and nothing else does. It has to be the same split, because
 * the whole point of `wordTokens` is that its indexes line up with theirs.
 */
function wordStarts(text: string): number[] {
  const starts: number[] = [];
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const space = /\s/.test(text.charAt(i));
    if (!space && !inWord) starts.push(i);
    inWord = !space;
  }
  return starts;
}

/**
 * Record `index` as the token the word at `slot` anchors.
 *
 * The array is created dense and null-filled, so a node that has one word
 * spoken and five not still answers for all six — a sparse array would leave
 * the renderer's length check false and put it straight back on the fallback
 * this exists to retire. First writer wins: a word said as several tokens
 * anchors at the first, which is where the word starts.
 */
function anchorWordToken(ref: RenderRef, slot: number, index: number): void {
  const words = ref.wordTokens ?? (ref.wordTokens = wordStarts(ref.text).map(() => null));
  if (slot < 0 || slot >= words.length) return;
  if (words[slot] === null) words[slot] = index;
}

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
  /** §19.4 directives seen so far, in source order. */
  coachDirectives: CoachDirectiveDraft[];
  pendingBlockId: () => string;
}

/** One `<!-- cc:… -->` occurrence, before its scope is worked out (§19.4). */
interface CoachDirectiveDraft {
  directive: CoachDirective;
  srcStart: number;
  srcEnd: number;
}

/**
 * Classify an HTML comment as a §19.4 directive and record it.
 *
 * Called from every place the compiler discards a comment, so the directive
 * scanner sees exactly the set of comments the document contains — no separate
 * source scan, and therefore no second chance to disagree with the parser about
 * what is inside a fenced code block or an inline code span.
 *
 * Returns nothing and consumes nothing: the comment still vanishes, so no
 * directive can contribute a spoken token or move a token index.
 */
function noteCoachComment(
  into: CoachDirectiveDraft[],
  diagnostics: CompileDiagnostic[],
  raw: string,
  srcStart: number,
  srcEnd: number,
): void {
  const directive = classifyCoachComment(raw);
  if (directive.kind === 'none') return;
  if (directive.kind === 'diagnostic') {
    diagnostics.push({
      code: directive.code,
      severity: 'warning',
      message: directive.message,
      blocking: false,
      source: { utf16Start: srcStart, utf16End: srcEnd },
      suggestedAction: 'fix_directive',
    });
    return;
  }
  into.push({ directive, srcStart, srcEnd });
}

/** A comment, and any text the author wrote after it, inside one HTML block. */
interface HtmlBlockSplit {
  comments: { raw: string; start: number; end: number }[];
  /** Source range of the text following the comments, or `null` if there is none. */
  rest: { start: number; end: number } | null;
}

/**
 * Split an HTML block into its leading comments and the text after them.
 *
 * CommonMark closes an HTML comment block at the *line* containing `-->`, so
 * `- <!-- note --> and then the line` is a single `html` node whose value holds
 * the presenter's words. Discarding the node — which is the right thing to do
 * with a comment — therefore used to delete a line of the script silently: the
 * author saw it in the editor and never on the glass, with no diagnostic. That
 * is worse than a compile error, because nothing tells them to look.
 *
 * Returns `null` when the block is not a run of complete comments followed by
 * text, in which case the caller keeps its existing behaviour: an unterminated
 * `<!--` is not something to guess about, and a node whose value the parser has
 * rewritten cannot be sliced back out of the source safely.
 */
function splitHtmlBlock(
  source: string,
  start: number,
  end: number,
  value: string,
): HtmlBlockSplit | null {
  if (start >= end || end > source.length) return null;
  if (source.slice(start, end).trim() !== value.trim()) return null;

  const comments: HtmlBlockSplit['comments'] = [];
  let cursor = start;
  for (;;) {
    while (cursor < end && /\s/u.test(source[cursor]!)) cursor += 1;
    if (!source.startsWith('<!--', cursor)) break;
    const close = source.indexOf('-->', cursor + 4);
    if (close < 0 || close + 3 > end) break;
    comments.push({ raw: source.slice(cursor, close + 3), start: cursor, end: close + 3 });
    cursor = close + 3;
  }
  if (comments.length === 0) return null;

  let restStart = cursor;
  while (restStart < end && /\s/u.test(source[restStart]!)) restStart += 1;
  let restEnd = end;
  while (restEnd > restStart && /\s/u.test(source[restEnd - 1]!)) restEnd -= 1;
  return { comments, rest: restEnd > restStart ? { start: restStart, end: restEnd } : null };
}

/**
 * Whether the text after a comment is itself markup rather than script.
 *
 * `<!-- note --> <span>x</span>` is raw HTML, which §22.2 renders as plain text
 * and never speaks; `<!-- note --> And then the line` is the presenter's words.
 * The distinction is a tag-open, which is the only thing that made the parser
 * treat the line as HTML in the first place.
 */
function looksLikeMarkup(text: string): boolean {
  return /<[a-zA-Z/!?]/u.test(text);
}

/** A `text` node standing in for a source range the parser handed us raw. */
function syntheticTextNode(source: string, start: number, end: number): MdNode {
  return {
    type: 'text',
    value: source.slice(start, end),
    position: {
      start: { line: 1, column: 1, offset: start },
      end: { line: 1, column: 1, offset: end },
    },
  };
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
  /*
   * Which word each token starts in. The raws are in ascending offset order, so
   * one shared pointer walks the word list once for the whole run rather than
   * re-scanning the text per token.
   */
  const starts = wordStarts(text);
  let slot = -1;
  const slotFor = (offset: number): number => {
    while (slot + 1 < starts.length && starts[slot + 1]! <= offset) slot++;
    return slot;
  };
  for (let i = 0; i < raws.length; i++) {
    const raw = raws[i]!;
    const srcStart = span.at(raw.start);
    const srcEnd = span.at(raw.end);
    const wordSlot = slotFor(raw.start);
    if (i === 0 && mergeTarget && raw.start === 0) {
      // Continuation of the word that ended at the formatting boundary.
      mergeTarget.surface += raw.surface;
      mergeTarget.srcEnd = srcEnd;
      mergeTarget.textEnd = textBase + raw.end;
      if (renderRef) mergeTarget.renderRefs.push({ ref: renderRef, wordSlot });
      continue;
    }
    draft.tokens.push({
      surface: raw.surface,
      srcStart,
      srcEnd,
      textStart: textBase + raw.start,
      textEnd: textBase + raw.end,
      isOverrideAnchor: false,
      renderRefs: renderRef ? [{ ref: renderRef, wordSlot }] : [],
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

/**
 * What a container can leave in front of a continuation line: `> ` markers,
 * list-item indentation, tabs, and any mix of them (`  > `, `>   `).
 */
const LINE_PREFIX = /[ \t>]*/y;

/** What a backslash escapes (CommonMark §2.4): ASCII punctuation, nothing else. */
const ESCAPABLE = /^[!-/:-@[-`{-~]$/;

function mapValueToSource(
  source: string,
  start: number,
  end: number,
  value: string,
): number[] | null {
  const map = new Array<number>(value.length + 1);
  let at = alignLine(source, start, end, value, 0, map);
  while (at !== null && at.v < value.length) {
    /*
     * A continuation line. remark drops the line's container prefix and
     * indentation from the value (#251), so the words resume somewhere inside
     * that run of `>`, spaces and tabs. Not necessarily at its end: an indented
     * line can keep a literal `>` (`>     >quoted` reads ">quoted"), and an
     * entity can stand for a leading space. Try the longest skip first and
     * keep the first one the whole line agrees with.
     *
     * Decoding never lengthens text, so the line cannot resume later than its
     * own length before the source line ends. Starting there keeps a long run
     * of kept `>` from being retried one position at a time.
     */
    LINE_PREFIX.lastIndex = at.s;
    LINE_PREFIX.exec(source);
    const lineLength = lineBreakAt(value, at.v, value.length) - at.v;
    const latest = lineBreakAt(source, at.s, end) - lineLength;
    const from = at;
    at = null;
    for (let s = Math.min(LINE_PREFIX.lastIndex, latest); s >= from.s && at === null; s--) {
      at = alignLine(source, s, end, value, from.v, map);
    }
  }
  if (at === null) return null;
  map[value.length] = at.s;
  return map;
}

/**
 * Align one physical line of `value`, from `v` through its line ending or the
 * end of the value, and say where both sides stopped. Null when they disagree.
 */
function alignLine(
  source: string,
  start: number,
  end: number,
  value: string,
  v: number,
  map: number[],
): { s: number; v: number } | null {
  let s = start;
  while (v < value.length) {
    if (s >= end) return null;
    if (source[s] === '&') {
      // Entity check must precede the literal comparison: `&amp;` decodes to
      // "&", so a plain equality test would consume only the ampersand and
      // then desynchronize on "amp;". A decoded `&#10;` is not a line ending.
      const entity = ENTITY_AT.exec(source.slice(s, Math.min(end, s + 34)));
      if (entity) {
        map[v] = s; // points at '&': not a literal '[' for directive purposes
        s += entity[0].length;
        v++;
        continue;
      }
    }
    if (
      source[s] === '\\' &&
      s + 1 < end &&
      source[s + 1] === value[v] &&
      ESCAPABLE.test(value[v]!)
    ) {
      // Before the literal comparison too: in `\\[Pause]` the first backslash
      // escapes the second, and the bracket after them is literal syntax.
      map[v] = s; // points at the backslash: not a literal '[' either
      s += 2;
      v++;
      continue;
    }
    if (source[s] === value[v]) {
      map[v] = s;
      s++;
      v++;
      if (endsLine(source, s, value[v - 1]!)) return { s, v };
      continue;
    }
    if ((value[v] === '\n' || value[v] === '\r') && (source[s] === ' ' || source[s] === '\t')) {
      // Spaces and tabs in front of a soft line ending are not in the value.
      // The line ending claims them, so a word before it ends where it does.
      let blank = s;
      while (blank < end && (source[blank] === ' ' || source[blank] === '\t')) blank++;
      if (blank < end && source[blank] === value[v]) {
        map[v] = s;
        s = blank + 1;
        v++;
        if (endsLine(source, s, value[v - 1]!)) return { s, v };
        continue;
      }
    }
    return null;
  }
  return { s, v };
}

/**
 * Whether `ch`, a source character matched just before `s`, ended a physical
 * line. The source decides: a lone `\r` stays a line ending when the value's
 * next character is a `\n` decoded from `&#10;`.
 */
function endsLine(source: string, s: number, ch: string): boolean {
  return ch === '\n' || (ch === '\r' && source[s] !== '\n');
}

/** The first `\r` or `\n` in `text` at or after `from`, or `limit`. */
function lineBreakAt(text: string, from: number, limit: number): number {
  let i = from;
  while (i < limit && text[i] !== '\n' && text[i] !== '\r') i++;
  return i;
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
  /*
   * The render node here is the VISUAL text, so a say-token's own offsets say
   * nothing about which word on the glass it belongs to. Word slots are taken
   * positionally when the two agree on how many words there are — the same rule
   * the visual-form aliases above use — and otherwise everything anchors to the
   * first word, which is where the override starts.
   */
  const visualWords = spec.renderRef ? wordStarts(spec.renderRef.text).length : 0;
  const positional = visualWords > 0 && visualWords === sayTokens.length;
  const slotsFor = (i: number): RenderSlot[] =>
    spec.renderRef ? [{ ref: spec.renderRef, wordSlot: positional ? i : 0 }] : [];

  if (sayTokens.length === 0) {
    // Empty or unspeakable say value: fall back to the visual word verbatim.
    if (draft.spokenText && !/\s$/.test(draft.spokenText)) draft.spokenText += ' ';
    const textBase = draft.spokenText.length;
    draft.spokenText += spec.visual;
    // These tokens ARE the visual text, so their offsets index the node.
    const starts = spec.renderRef ? wordStarts(spec.renderRef.text) : [];
    let slot = -1;
    for (const raw of tokenizeText(spec.visual)) {
      while (slot + 1 < starts.length && starts[slot + 1]! <= raw.start) slot++;
      draft.tokens.push({
        surface: raw.surface,
        srcStart: spec.srcStart,
        srcEnd: spec.srcEnd,
        textStart: textBase + raw.start,
        textEnd: textBase + raw.end,
        isOverrideAnchor: false,
        renderRefs: spec.renderRef ? [{ ref: spec.renderRef, wordSlot: slot }] : [],
      });
    }
    return;
  }

  if (draft.spokenText && !/\s$/.test(draft.spokenText)) draft.spokenText += ' ';
  const textBase = draft.spokenText.length;
  draft.spokenText += spec.say;
  for (let i = 0; i < sayTokens.length; i++) {
    const raw = sayTokens[i]!;
    draft.tokens.push({
      surface: raw.surface,
      ...(spec.visual ? { overrideVisual: spec.visual } : {}),
      srcStart: spec.sayStart === undefined ? spec.srcStart : spec.sayStart + raw.start,
      srcEnd: spec.sayStart === undefined ? spec.srcEnd : spec.sayStart + raw.end,
      textStart: textBase + raw.start,
      textEnd: textBase + raw.end,
      isOverrideAnchor: true,
      renderRefs: slotsFor(i),
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
      if (value.startsWith('<!--')) {
        // Comments vanish (§22.2); a `cc:` comment is recorded on the way out
        // (§19.4) and still contributes nothing to the spoken stream.
        noteCoachComment(
          ctx.coachDirectives,
          ctx.diagnostics,
          value,
          nodeStart(node),
          nodeEnd(node),
        );
        return;
      }
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
  /** §19.4 `cc:` comments, in source order. */
  coachDirectives: CoachDirectiveDraft[];
  /** §19.5 `coach:` front matter, or `null`. */
  frontMatter: CompiledCoachingDirectives['frontMatter'];
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
    coachDirectives: state.coachDirectives,
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
    case 'html': {
      // A comment nested in a list item or blockquote still carries directives —
      // and, because CommonMark swallows the rest of the line into the same
      // node, may be carrying the presenter's words with it.
      const split = splitHtmlBlock(state.source, nodeStart(child), nodeEnd(child), child.value ?? '');
      if (split === null) {
        const value = (child.value ?? '').trim();
        if (value.startsWith('<!--')) {
          noteCoachComment(
            state.coachDirectives,
            state.diagnostics,
            value,
            nodeStart(child),
            nodeEnd(child),
          );
        }
        return;
      }
      for (const comment of split.comments) {
        // The *comment's* own range, not the node's: §19.4 scopes a directive
        // from where it ends, and a range that reached past the words after it
        // would leave the directive governing nothing.
        noteCoachComment(
          state.coachDirectives,
          state.diagnostics,
          comment.raw,
          comment.start,
          comment.end,
        );
      }
      const rest = split.rest;
      if (rest === null) return;
      const text = state.source.slice(rest.start, rest.end);
      if (looksLikeMarkup(text)) {
        // §22.2: raw HTML is visible and silent, the same as at the top level.
        state.diagnostics.push({
          code: 'raw_html_blocked',
          severity: 'warning',
          message: 'Raw HTML is not supported; it renders as plain text.',
          blocking: false,
          source: { utf16Start: rest.start, utf16End: rest.end },
          suggestedAction: 'open_source',
        });
        pushRenderText(draft, draft.renderNodes, text, []);
        draft.lastSpokenSrcEnd = -1;
        return;
      }
      // Ordinary script. Walked as text so it tokenizes, renders and carries
      // inline cues exactly as it would have without the comment in front of it.
      walkTextValue(ctx, draft.renderNodes, syntheticTextNode(state.source, rest.start, rest.end));
      return;
    }
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

function buildHtmlBlock(state: CompilerState, node: MdNode, spoken: boolean): BlockDraft | null {
  const value = (node.value ?? '').trim();
  const split = splitHtmlBlock(state.source, nodeStart(node), nodeEnd(node), node.value ?? '');
  if (split !== null) {
    for (const comment of split.comments) {
      // HTML comment: not rendered, not spoken. §19.4 directives are read here,
      // and scoped from the end of the comment itself.
      noteCoachComment(
        state.coachDirectives,
        state.diagnostics,
        comment.raw,
        comment.start,
        comment.end,
      );
    }
    const rest = split.rest;
    // `<!-- note --> and then the line` is one HTML block: the comment goes,
    // the line stays and is spoken, exactly as if the comment were not there.
    if (rest === null) return null;
    const text = state.source.slice(rest.start, rest.end);
    if (!looksLikeMarkup(text)) {
      const draft = newDraft('paragraph', rest.start, rest.end);
      const ctx = makeWalkContext(state, draft, spoken);
      walkTextValue(ctx, draft.renderNodes, syntheticTextNode(state.source, rest.start, rest.end));
      draft.spoken = spoken && draft.tokens.length > 0;
      draft.idText = draft.spokenText || text;
      return draft;
    }
    // Raw markup after the comment: visible, silent, and reported — the same
    // treatment a raw HTML block gets, applied to the part that is actually raw.
    return rawHtmlDraft(state, rest.start, rest.end, text);
  } else if (value.startsWith('<!--')) {
    noteCoachComment(
      state.coachDirectives,
      state.diagnostics,
      value,
      nodeStart(node),
      nodeEnd(node),
    );
    return null;
  }
  return rawHtmlDraft(state, nodeStart(node), nodeEnd(node), node.value ?? '');
}

/** §22.2. Raw HTML: rendered as plain text, never spoken, always reported. */
function rawHtmlDraft(
  state: CompilerState,
  srcStart: number,
  srcEnd: number,
  text: string,
): BlockDraft {
  const draft = newDraft('paragraph', srcStart, srcEnd);
  state.diagnostics.push({
    code: 'raw_html_blocked',
    severity: 'warning',
    message: 'Raw HTML is not supported; the block renders as plain text.',
    blocking: false,
    source: { utf16Start: draft.srcStart, utf16End: draft.srcEnd },
    suggestedAction: 'open_source',
  });
  pushRenderText(draft, draft.renderNodes, text, []);
  draft.spoken = false;
  draft.layoutHints = { rawSource: true };
  draft.idText = text.trim().slice(0, 200);
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
    coachDirectives: [],
    frontMatter: null,
  };

  // 1. Front matter (§19.5), then the container scan (§23), then the Markdown
  // parse. Both scans blank their own region with spaces of identical length,
  // so every source offset the parser reports still indexes the real document.
  const front = scanFrontMatter(source);
  state.diagnostics.push(...front.diagnostics);
  state.frontMatter = front.frontMatter;
  const scan = scanContainers(front.maskedSource);
  state.diagnostics.push(...scan.diagnostics);
  const tree = parser.parse(scan.maskedSource) as unknown as MdNode;
  // Front matter blanks a mark it covers, so test what the parser was given.
  if (scan.maskedSource.charCodeAt(0) === BYTE_ORDER_MARK) shiftPastByteOrderMark(tree);
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
        const draft = buildHtmlBlock(state, node, spokenDefault);
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

  for (let d = 0; d < drafts.length; d++) {
    const draft = drafts[d]!;
    const blockId = blockIds[d]!;
    const blockTokenStart = spokenTokens.length;

    if (draft.kind === 'heading') {
      headingStarts.push({ draftIndex: d, tokenStart: blockTokenStart });
    }

    /*
     * NAVIGATION ranges over the block's spoken text.
     *
     * A list item and a heading are ONE navigation unit however many sentences
     * they contain (§25.5) — jumping by sentence should move by bullet, not
     * mid-bullet.
     */
    const sentenceRanges =
      draft.tokens.length === 0
        ? []
        : draft.singleSentence
          ? [{ start: 0, end: draft.spokenText.length, text: draft.spokenText }]
          : segmentSentences(draft.spokenText);

    /*
     * GRAMMATICAL ranges, published separately.
     *
     * The two used to be the same list, and that conflation was a real
     * following defect: alignment reuses navigation units as sentence ends, so
     * a bullet holding two sentences reported one boundary and the display
     * could be carried straight over the full stop inside it. Prose got the
     * braking; a bulleted script did not.
     *
     * Always the real segmentation, never collapsed. Identical to
     * `sentenceRanges` for an ordinary paragraph, which is why nothing changes
     * for prose.
     */
    const grammaticalRanges =
      draft.tokens.length === 0 ? [] : segmentSentences(draft.spokenText);

    /*
     * The LAST token of each grammatical range, by text offset.
     *
     * Recorded as a set of `textStart` values rather than token indexes,
     * because the indexes are not assigned until the emit loop below has
     * normalised and possibly dropped tokens. Matching on the offset the
     * segmentation actually used is what keeps the two in step.
     */
    const grammaticalEndOffsets = new Set<number>();
    for (const range of grammaticalRanges) {
      let last: TokenDraft | undefined;
      for (const token of draft.tokens) {
        if (token.textStart < range.start || token.textStart >= range.end) continue;
        /*
         * The last token that will actually BE EMITTED, not the last draft.
         *
         * The emit loop below drops any token whose `normalizeToken` comes back
         * empty — a few Unicode letters normalise to a combining mark and are
         * then stripped — so marking the last draft could put the boundary on a
         * token that never reaches the engine, and the sentence end would
         * vanish. Inside a list item that is unrecoverable: the navigation-unit
         * fallback covers only the end of the whole item, which is the boundary
         * this field exists to improve on.
         */
        if (!normalizeToken(token.surface)) continue;
        last = token;
      }
      if (last) grammaticalEndOffsets.add(last.textStart);
    }

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
        spokenTokens.push({
          index: spokenTokens.length,
          blockId,
          sentenceId,
          surface: tokenDraft.surface,
          normalized,
          source: { utf16Start: tokenDraft.srcStart, utf16End: tokenDraft.srcEnd },
          ...(tokenDraft.overrideVisual ? { overrideVisual: tokenDraft.overrideVisual } : {}),
          /*
           * Ends a GRAMMATICAL sentence — a different question from ending a
           * navigation unit, and the one alignment should brake on.
           *
           * Omitted rather than set false, so a compiled document is unchanged
           * for the tokens this does not apply to and an older consumer reads
           * `undefined` exactly as it read a missing field before.
           */
          ...(grammaticalEndOffsets.has(tokenDraft.textStart)
            ? { grammaticalSentenceEnd: true }
            : {}),
        });
        for (const slot of tokenDraft.renderRefs) {
          (slot.ref.tokenIndexes ??= []).push(spokenTokens.length - 1);
          anchorWordToken(slot.ref, slot.wordSlot, spokenTokens.length - 1);
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

  /*
   * Derived here rather than by every consumer, because the division is a
   * property of the DOCUMENT and two panels that computed it separately would
   * eventually disagree about how many parts a script has.
   */
  const parts = deriveParts({ cues, outline, sentences, totalTokens });

  return {
    schemaVersion: SCHEMA_VERSION,
    compilerVersion: COMPILER_VERSION,
    scriptId: options.scriptId,
    // The identity of the TEXT, which a leading byte-order mark is not part of.
    // The editor can hold a pasted one that the saved file, and so the take's
    // compile, does not; the stale-editor gate compares these two hashes and
    // must not call that a changed script (#247).
    sourceHash: hashString(source.replace(LEADING_BYTE_ORDER_MARKS, '')),
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
    parts,
    literalCommandRanges,
    coaching: resolveCoachDirectives(state, blocks, sentences),
  };
}

/* ------------------------------------------------------------------ */
/* §19.4 directive scoping                                             */
/* ------------------------------------------------------------------ */

/**
 * Resolve every `cc:` directive to the authored spans it governs.
 *
 * ---------------------------------------------------------------------------
 * SCOPE, STATED ONCE
 * ---------------------------------------------------------------------------
 * §19.4: "Directives apply to the following block or explicitly bounded
 * range." Two rules, and which one applies is decided by the document, not by
 * a guess:
 *
 *  - **Explicitly bounded.** `<!-- cc:end -->` closes the *group* of
 *    directives written immediately above the range — the run of `cc:`
 *    comments with no spoken text between them. `<!-- cc:coach on -->` is the
 *    same barrier for `cc:coach off` alone, because that pairing reads
 *    naturally. Closing the group rather than one directive means a range is
 *    never half-open; restricting it to the *immediately preceding* group is
 *    what stops a `cc:end` written for one passage from silently swallowing an
 *    unrelated directive three paragraphs above it.
 *  - **Otherwise, one block.** A directive standing on its own between blocks
 *    governs the next block that contains spoken words — a block with no
 *    spoken words is not a delivery unit and cannot be coached either way. A
 *    directive written *inside* a block governs the rest of that block, which
 *    is the only reading that does not silently reach past the paragraph the
 *    author was looking at.
 *
 * A directive that ends up governing no spoken text is reported. That is the
 * failure mode this whole feature exists to avoid: the author believes they
 * turned coaching off, and nothing did.
 */
function resolveCoachDirectives(
  state: CompilerState,
  blocks: readonly CompiledBlock[],
  sentences: readonly SentenceUnit[],
): CompiledCoachingDirectives {
  const drafts = state.coachDirectives;
  const empty: CompiledCoachingDirectives = { frontMatter: state.frontMatter, spans: [] };
  if (drafts.length === 0) return empty;

  const isBarrier = (d: CoachDirectiveDraft) =>
    d.directive.kind === 'end' || (d.directive.kind === 'coach' && d.directive.enabled);
  const genericBarriers = drafts.filter((d) => d.directive.kind === 'end');
  const coachBarriers = drafts.filter((d) => d.directive.kind === 'coach' && d.directive.enabled);
  const openers = drafts.filter((d) => !isBarrier(d));

  // Group openers: a run of `cc:` comments with no spoken sentence between
  // them is one group, and one group shares one closer.
  const sentenceStartsBetween = (from: number, to: number): boolean =>
    sentences.some((s) => s.source.utf16Start >= from && s.source.utf16Start < to);
  const groupOf = new Map<CoachDirectiveDraft, number>();
  const groupEnd: number[] = [];
  let group = -1;
  for (let i = 0; i < openers.length; i++) {
    const opener = openers[i]!;
    const previous = openers[i - 1];
    if (!previous || sentenceStartsBetween(previous.srcEnd, opener.srcStart)) {
      group++;
      groupEnd[group] = opener.srcEnd;
    } else {
      groupEnd[group] = Math.max(groupEnd[group]!, opener.srcEnd);
    }
    groupOf.set(opener, group);
  }

  const usedBarriers = new Set<CoachDirectiveDraft>();
  const byId = new Map<string, CoachDirectiveSpan>();
  const order: string[] = [];

  const spanFor = (spanId: string): CoachDirectiveSpan => {
    let span = byId.get(spanId);
    if (!span) {
      span = { spanId };
      byId.set(spanId, span);
      order.push(spanId);
    }
    return span;
  };

  const noScope = (draft: CoachDirectiveDraft) => {
    state.diagnostics.push({
      code: 'coach_directive_no_scope',
      severity: 'warning',
      message:
        'This coaching directive covers no spoken text, so it has no effect. Put it before the block it applies to, or close it with "<!-- cc:end -->".',
      blocking: false,
      source: { utf16Start: draft.srcStart, utf16End: draft.srcEnd },
      suggestedAction: 'fix_directive',
    });
  };

  for (const draft of openers) {
    const directive = draft.directive;
    const openerGroup = groupOf.get(draft)!;
    const groupCloseFrom = groupEnd[openerGroup]!;

    // Explicit barrier first: the document said where this ends.
    let scopeEnd: number | null = null;
    let barrier = genericBarriers.find((b) => b.srcStart >= groupCloseFrom);
    if (directive.kind === 'coach') {
      const coachOn = coachBarriers.find((b) => b.srcStart >= groupCloseFrom);
      if (coachOn && (!barrier || coachOn.srcStart < barrier.srcStart)) barrier = coachOn;
    }
    // A barrier belongs to the group written immediately above it. If another
    // group opened in between, that group owns the barrier and this one falls
    // back to block scope.
    if (barrier) {
      const intervening = openers.find(
        (o) => groupOf.get(o) !== openerGroup && o.srcStart > groupCloseFrom && o.srcStart < barrier!.srcStart,
      );
      if (intervening) barrier = undefined;
    }
    if (barrier) {
      scopeEnd = barrier.srcStart;
      usedBarriers.add(barrier);
    } else {
      const containing = blocks.find(
        (b) => b.source.utf16Start <= draft.srcStart && draft.srcStart < b.source.utf16End,
      );
      const target =
        containing ??
        blocks.find(
          (b) => b.source.utf16Start >= draft.srcEnd && b.startTokenIndex !== undefined,
        );
      scopeEnd = target ? target.source.utf16End : null;
    }
    if (scopeEnd === null) {
      noScope(draft);
      continue;
    }

    const scopeStart = draft.srcEnd;
    let covered = 0;
    for (const sentence of sentences) {
      if (sentence.source.utf16Start < scopeStart) continue;
      if (sentence.source.utf16Start >= scopeEnd) continue;
      covered++;
      const span = spanFor(sentence.id);
      switch (directive.kind) {
        case 'coach':
          span.coachingOff = true;
          break;
        case 'filler':
          span.fillerIntentional = true;
          break;
        case 'style':
          span.style = directive.style;
          break;
        case 'pace':
          span.paceLowWpm = directive.lowWpm;
          span.paceHighWpm = directive.highWpm;
          break;
      }
    }
    if (covered === 0) noScope(draft);
  }

  for (const barrier of [...genericBarriers, ...coachBarriers]) {
    if (usedBarriers.has(barrier)) continue;
    state.diagnostics.push({
      code: 'coach_directive_stray_end',
      severity: 'warning',
      message: 'This closing coaching directive has no open directive to close; it is ignored.',
      blocking: false,
      source: { utf16Start: barrier.srcStart, utf16End: barrier.srcEnd },
      suggestedAction: 'fix_directive',
    });
  }

  return { frontMatter: state.frontMatter, spans: order.map((id) => byId.get(id)!) };
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
