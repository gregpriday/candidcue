/**
 * Advisory lint over the authored script source.
 *
 * The rule that keeps tracking honest lives in `crates/cc-align/src/script.rs`:
 * prediction may be carried to the end of the SENTENCE the reader was last
 * *heard* in, and stops dead there. The paragraph is the outer bound around
 * that ceiling — `sentence_end` can never reach past `para_end` — so what stops
 * the stage guessing its way into unspoken words is now the next full stop
 * rather than the next blank line.
 *
 * This file used to argue that a sentence-level ceiling was a week of Rust plus
 * a benchmark campaign away, and that asking the author to press Enter twice
 * bought most of the same protection for four seconds of work. The Rust got
 * written. What it did not change is RECOVERY: the approximate-bridge gate is
 * still bounded by the paragraph on purpose (`can_bridge_local_approx` in
 * `tracker.rs`), because failing that gate does not merely dim less — it drops
 * the engine into `Holding`. Inside a three-hundred-word block that bound sits
 * three hundred words away, so a skipped line or a restarted sentence still has
 * a very long runway before the script's own structure catches it. That is what
 * the long-paragraph finding is about now, and it is why this still lives in
 * the editor and not in the engine.
 *
 * Everything here is advisory and stays advisory. Nothing it reports blocks a
 * compile, a save, or a take: these are scripts that read badly, not scripts
 * that are wrong, and a presenter about to record must never be stopped by
 * prose advice.
 *
 * Pure: (source) -> findings. No DOM, no settings, no compiler.
 */
import {
  BYTE_ORDER_MARK,
  INLINE_SAY_PATTERN,
  classifyBracketDirective,
} from '../../shared/markdown/directives';
import { segmentSentences } from '../../shared/markdown/segment';
import { tokenizeText } from '../../shared/markdown/tokenize';

export type ScriptLintCode =
  | 'long-paragraph'
  | 'all-caps-run'
  | 'no-terminal-punctuation'
  | 'very-long-sentence';

export interface ScriptLintFinding {
  code: ScriptLintCode;
  severity: 'info' | 'warn';
  /** 1-based line in the ORIGINAL source (CRLF counted as one line ending). */
  line: number;
  /** 1-based UTF-16 column within that line. */
  column?: number;
  /**
   * UTF-16 length of the flagged run, counted from (line, column) forward
   * through the original source.
   *
   * A run may cross line endings — a caps run or a long sentence usually does —
   * so a consumer resolves it as `lineStartOffset + column - 1 + length` rather
   * than assuming it ends on the reported line. Reporting the true extent is
   * worth more to an editor decoration than a length that quietly stops at the
   * first newline and underlines the wrong thing.
   */
  length?: number;
  message: string;
  hint?: string;
}

/** Spoken words after which a paragraph starts costing recovery time. */
export const LONG_PARAGRAPH_WORDS = 80;
/** Spoken words after which the same finding is worth raising its voice for. */
export const VERY_LONG_PARAGRAPH_WORDS = 140;
/** Spoken words after which a single sentence has nowhere to break. */
export const LONG_SENTENCE_WORDS = 45;
/** Consecutive capitalised words that read as a sustained caps run. */
export const CAPS_RUN_WORDS = 4;

/* ---------------------------------------------------------------------------
 * Source structure
 * ------------------------------------------------------------------------- */

interface SourceLine {
  text: string;
  /** UTF-16 offset of the first character. */
  start: number;
  /** UTF-16 offset just past the last character, excluding CR and LF. */
  end: number;
  /** 1-based. */
  number: number;
}

function splitLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  // As in the compiler's scanner: a leading byte-order mark is not part of
  // line one, and offsets stay absolute (#247).
  let start = source.charCodeAt(0) === BYTE_ORDER_MARK ? 1 : 0;
  let number = 1;
  for (let i = start; i <= source.length; i++) {
    if (i === source.length || source.charAt(i) === '\n') {
      let end = i;
      if (end > start && source.charAt(end - 1) === '\r') end--;
      lines.push({ text: source.slice(start, end), start, end, number });
      start = i + 1;
      number++;
    }
  }
  return lines;
}

function positionAt(lines: SourceLine[], offset: number): { line: number; column: number } {
  let lo = 0;
  let hi = lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lines[mid]!.start <= offset) lo = mid;
    else hi = mid - 1;
  }
  const line = lines[lo]!;
  // The editor's line one still begins at offset 0, BOM and all, and a column
  // is resolved against the editor's line start — so count from there.
  const lineStart = lo === 0 ? 0 : line.start;
  return { line: line.number, column: offset - lineStart + 1 };
}

/* ---------------------------------------------------------------------------
 * What counts as spoken
 * ------------------------------------------------------------------------- */

/*
 * Block classification mirrors the aligner's Markdown reader
 * (`crates/cc-align/src/script.rs`), not the app compiler's `scanContainers`,
 * and the divergence is deliberate. The compiler keeps an *unknown* `:::name`
 * container visible as readable source (§22.7), so a `:::cue` block would
 * arrive here as ordinary prose and get scolded for the stage notes inside it.
 * Every finding in this file is a claim about the paragraph the *aligner* will
 * put its ceiling on, so the two have to agree about where paragraphs are.
 * Skipping every `:::` container regardless of name also fails in the right
 * direction for a lint: at worst it stays quiet about a block the author
 * explicitly marked as a directive.
 *
 * Front matter is treated more broadly than `scanFrontMatter`, which only
 * recognises a leading `---` block when it carries a top-level `coach:` key
 * (that narrowness protects the compiler from re-interpreting an existing
 * document; it buys this file nothing). Any leading `---` … `---` block whose
 * body reads like YAML is skipped here. A lint that stays quiet about a
 * horizontal rule costs one missed advisory; a lint that complains about the
 * capitalisation of your YAML costs trust in everything else it says.
 */

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const CONTAINER_OPEN = /^:::\s*[A-Za-z][A-Za-z-]*\s*$/;
const CONTAINER_CLOSE = /^:::\s*$/;
const ATX_HEADING = /^#{1,6}(\s|$)/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
const BLOCKQUOTE_PREFIX = /^\s*>+[ \t]?/;
const LIST_PREFIX = /^(\s*)([-*+]|\d{1,9}[.)])([ \t]+)/;

/**
 * A body line a YAML front-matter block could plausibly contain: indented,
 * a comment, a sequence item, or a `key:` mapping.
 *
 * Without this test, opening a document with a horizontal rule was enough to
 * silence the lint all the way to the next one — `---`, prose, `---` looks
 * exactly like front matter from the first line alone. Missing an advisory is
 * cheap; going quiet over an arbitrary span of real prose is the one failure a
 * lint cannot be noticed recovering from, because silence is also what success
 * looks like.
 */
const YAML_BODY_LINE = /^(\s|#|-\s|-$)|^[A-Za-z_][\w.-]*\s*:(\s|$)/;

/** A `---`/`___`/`***` rule: never spoken, and never a paragraph's content. */
function isDivider(text: string): boolean {
  const bare = text.replace(/\s/g, '');
  return bare.length >= 3 && /^-+$|^_+$|^\*+$/.test(bare);
}

interface LineScan {
  line: SourceLine;
  /** Contributes words to the paragraph it sits in. */
  spoken: boolean;
  /** A blank line: the only thing that ends a paragraph, as in the aligner. */
  breaks: boolean;
  /** Authored as a list item, which changes what punctuation we expect. */
  listItem: boolean;
}

/**
 * Blank every non-spoken character to a space, in place.
 *
 * Masking rather than extracting is the whole trick: every surviving character
 * keeps its original offset, so a token found in the masked text reports a line
 * and column that land on the author's own text without any remapping. It is
 * the same technique `directives.ts` uses for container fences, for the same
 * reason.
 */
function blank(chars: string[], start: number, end: number): void {
  for (let i = start; i < end; i++) {
    const ch = chars[i];
    if (ch !== '\n' && ch !== '\r') chars[i] = ' ';
  }
}

/**
 * Blank inline markup that is not read aloud: image references, link
 * destinations, inline code, emphasis markers, bracket directives and
 * `{say="…"}` aliases.
 *
 * Link *labels* survive because the presenter reads them; the destination does
 * not, and leaving it in was worth fixing on its own — `https://example.com/a`
 * tokenises into five words and quietly pushed short paragraphs over the long
 * paragraph threshold.
 */
function maskInline(chars: string[], text: string, base: number, from: number): void {
  const hide = (start: number, end: number) => blank(chars, base + start, base + end);
  let i = from;
  while (i < text.length) {
    const ch = text.charAt(i);

    if (ch === '`') {
      let runEnd = i;
      while (runEnd < text.length && text.charAt(runEnd) === '`') runEnd++;
      const marker = text.slice(i, runEnd);
      const close = text.indexOf(marker, runEnd);
      const end = close < 0 ? runEnd : close + marker.length;
      hide(i, end);
      i = end;
      continue;
    }

    if (ch === '!' && text.charAt(i + 1) === '[') {
      const close = text.indexOf(']', i + 2);
      if (close >= 0) {
        let end = close + 1;
        if (text.charAt(end) === '(') {
          const paren = text.indexOf(')', end + 1);
          if (paren >= 0) end = paren + 1;
        }
        hide(i, end);
        i = end;
        continue;
      }
    }

    if (ch === '[') {
      const close = text.indexOf(']', i + 1);
      if (close >= 0) {
        if (text.charAt(close + 1) === '(') {
          const paren = text.indexOf(')', close + 2);
          if (paren >= 0) {
            hide(i, i + 1);
            hide(close, paren + 1);
            i += 1;
            continue;
          }
        }
        // The compiler's own classifier decides directive-or-not, so an
        // authored `[Cue: LOOK AT THE LENS]` is exempt from the caps rule for
        // the same reason it is exempt from being spoken.
        if (classifyBracketDirective(text.slice(i + 1, close)).kind !== 'none') {
          hide(i, close + 1);
          i = close + 1;
          continue;
        }
        hide(i, i + 1);
        hide(close, close + 1);
        i += 1;
        continue;
      }
    }

    if (ch === '{') {
      const say = INLINE_SAY_PATTERN.exec(text.slice(i));
      if (say && say.index === 0) {
        hide(i, i + say[0].length);
        i += say[0].length;
        continue;
      }
    }

    if (ch === '*' || ch === '_' || ch === '~') {
      hide(i, i + 1);
      i += 1;
      continue;
    }

    i += 1;
  }
}

/** Line-by-line scan producing the mask and the spoken/blank classification. */
function scanSource(source: string): { masked: string; scans: LineScan[]; lines: SourceLine[] } {
  const lines = splitLines(source);
  // split('') keeps UTF-16 indexing; spreading would split by code point and
  // shift every offset after an astral character.
  const chars = source.split('');
  const scans: LineScan[] = [];

  let frontMatterEnd = -1;
  if (lines[0] && lines[0].text.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      const text = lines[i]!.text;
      const trimmed = text.trim();
      if (trimmed === '---' || trimmed === '...') {
        frontMatterEnd = i;
        break;
      }
      if (trimmed !== '' && !YAML_BODY_LINE.test(text)) break;
    }
  }

  let fence: { marker: string; length: number } | null = null;
  let inComment = false;
  let containerDepth = 0;
  /**
   * Indices in `scans` of the plain prose lines of the paragraph still open,
   * kept only so a setext underline can reach back and unmake them. Anything
   * that is not a bare prose line empties it, because an underline only ever
   * retitles the paragraph immediately above it.
   */
  const paragraphRun: number[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const trimmed = line.text.trim();
    const skip = (): LineScan => {
      blank(chars, line.start, line.end);
      paragraphRun.length = 0;
      return { line, spoken: false, breaks: false, listItem: false };
    };

    if (index <= frontMatterEnd) {
      scans.push(skip());
      continue;
    }

    if (inComment) {
      if (trimmed.includes('-->')) inComment = false;
      scans.push(skip());
      continue;
    }
    if (trimmed.startsWith('<!--')) {
      if (!trimmed.includes('-->')) inComment = true;
      scans.push(skip());
      continue;
    }

    if (fence) {
      const close = FENCE_CLOSE.exec(line.text);
      if (close && close[1]!.charAt(0) === fence.marker && close[1]!.length >= fence.length) {
        fence = null;
      }
      scans.push(skip());
      continue;
    }
    const open = FENCE_OPEN.exec(line.text);
    if (open && !(open[1]!.charAt(0) === '`' && open[2]!.includes('`'))) {
      fence = { marker: open[1]!.charAt(0), length: open[1]!.length };
      scans.push(skip());
      continue;
    }

    if (CONTAINER_OPEN.test(line.text)) {
      containerDepth += 1;
      scans.push(skip());
      continue;
    }
    if (CONTAINER_CLOSE.test(line.text)) {
      if (containerDepth > 0) containerDepth -= 1;
      scans.push(skip());
      continue;
    }
    if (containerDepth > 0) {
      scans.push(skip());
      continue;
    }

    if (trimmed === '') {
      paragraphRun.length = 0;
      scans.push({ line, spoken: false, breaks: true, listItem: false });
      continue;
    }

    /*
     * A `Title` / `=====` pair is a heading to remark, so the title is not
     * spoken and must not be read as prose — an all-caps setext title used to
     * collect both a caps-run and a missing-full-stop finding, which is the
     * "scolding you about a title" failure the ATX case is explicitly written
     * to avoid. The underline arrives *after* the lines it retitles, hence the
     * reach back into `scans` rather than a lookahead.
     *
     * This has to be tested before `isDivider`: under an open paragraph a row
     * of dashes is a level-two underline, not a rule.
     */
    if (paragraphRun.length > 0 && SETEXT_UNDERLINE.test(line.text)) {
      for (const idx of paragraphRun) {
        const titled = scans[idx]!;
        blank(chars, titled.line.start, titled.line.end);
        scans[idx] = { line: titled.line, spoken: false, breaks: false, listItem: false };
      }
      scans.push(skip());
      continue;
    }

    // Headings are skipped because `readHeadings` is off by default and a
    // heading is a title, not a spoken paragraph. Tables and rules carry no
    // sentences either.
    if (ATX_HEADING.test(trimmed) || trimmed.startsWith('|') || isDivider(trimmed)) {
      scans.push(skip());
      continue;
    }

    // A whole-line bracket span is a stage annotation, exactly as the aligner
    // reads it — including `[some note to self]`, which is not a known
    // directive but is plainly not something the presenter says out loud.
    if (trimmed.startsWith('[') && trimmed.endsWith(']') && !trimmed.includes('](')) {
      scans.push(skip());
      continue;
    }

    let from = 0;
    const quote = BLOCKQUOTE_PREFIX.exec(line.text);
    if (quote) {
      blank(chars, line.start, line.start + quote[0].length);
      from = quote[0].length;
    }
    const list = LIST_PREFIX.exec(line.text.slice(from));
    if (list) {
      const markerStart = from + list[1]!.length;
      blank(chars, line.start + markerStart, line.start + markerStart + list[2]!.length);
      from += list[0].length;
    }
    maskInline(chars, line.text, line.start, from);
    // Only bare prose can be retitled by an underline: a `=====` under a list
    // item or a quote is the parser's problem, and guessing at it here could
    // silence a paragraph the author can still see on the stage.
    if (quote || list) paragraphRun.length = 0;
    else paragraphRun.push(scans.length);
    scans.push({ line, spoken: true, breaks: false, listItem: Boolean(list) });
  }

  return { masked: chars.join(''), scans, lines };
}

/* ---------------------------------------------------------------------------
 * Paragraphs
 * ------------------------------------------------------------------------- */

interface Paragraph {
  /** Offset of the first spoken line's start, in the original source. */
  start: number;
  /** Offset just past the last spoken line's end. */
  end: number;
  /** Every spoken line was authored as a list item. */
  allListItems: boolean;
}

/**
 * Group spoken lines into paragraphs.
 *
 * Only a blank line ends a paragraph, which is precisely the aligner's rule:
 * a fence, a heading or a directive block between two prose lines does not
 * start a new paragraph ordinal there, so it must not start a new paragraph
 * here either. Being wrong about this would make every finding a claim about a
 * paragraph the engine does not have.
 */
function collectParagraphs(scans: LineScan[]): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  let current: Paragraph | null = null;
  for (const scan of scans) {
    if (scan.breaks) {
      current = null;
      continue;
    }
    if (!scan.spoken) continue;
    if (!current) {
      current = { start: scan.line.start, end: scan.line.end, allListItems: scan.listItem };
      paragraphs.push(current);
    } else {
      current.end = scan.line.end;
      current.allListItems = current.allListItems && scan.listItem;
    }
  }
  return paragraphs;
}

/* ---------------------------------------------------------------------------
 * Rules
 * ------------------------------------------------------------------------- */

type CaseClass = 'caps' | 'neutral' | 'break';

/**
 * How a word reads in a run of capitals.
 *
 * `neutral` is the interesting one. "I", "A" and "2026" are capitalised (or
 * caseless) whatever the author intended, so they are no evidence either way:
 * counting them as lowercase would let a single "I" hide "I WILL NOT BE
 * SHOUTING", and counting them as capitals would flag ordinary prose full of
 * numbers. They neither extend a run nor end one.
 *
 * The run is counted over UPPERCASE letters rather than over letters, which is
 * the only thing keeping this rule silent on writing systems that have no case
 * at all. Japanese, Arabic, Hebrew and Thai all satisfy `\p{L}` and can never
 * satisfy `\p{Ll}`, so a letter count read every word of a Japanese script as
 * shouted and fired on every fourth one — a finding whose hint ("use sentence
 * case here") the author has no way to act on.
 */
function caseClass(surface: string): CaseClass {
  if (/\p{Ll}/u.test(surface)) return 'break';
  return surface.replace(/[^\p{Lu}]/gu, '').length >= 2 ? 'caps' : 'neutral';
}

/** Closers that may sit after the sentence terminator and still be an ending. */
const TRAILING_CLOSERS = /["'”’)\]]+$/;
const TERMINAL_PUNCTUATION = /[.?!:…]$/;

function longParagraphFinding(
  lines: SourceLine[],
  words: number,
  start: number,
  end: number,
): ScriptLintFinding {
  const severe = words > VERY_LONG_PARAGRAPH_WORDS;
  const { line, column } = positionAt(lines, start);
  return {
    code: 'long-paragraph',
    severity: severe ? 'warn' : 'info',
    line,
    column,
    length: end - start,
    message:
      `This paragraph runs to ${words} spoken words. Tracking stops the display at the end ` +
      'of the sentence it last heard you in, but when it has to recover it is still bounded ' +
      'by the paragraph — skip a line or read one twice inside a long one and it has that ' +
      'much further to travel before the stage settles back onto you.',
    hint: severe
      ? 'Split this into three or four paragraphs at the natural pauses.'
      : 'A blank line at the next natural pause splits it in two.',
  };
}

/* ---------------------------------------------------------------------------
 * Entry point
 * ------------------------------------------------------------------------- */

/**
 * Lint an authored script. Findings are returned in document order.
 *
 * Line and column are 1-based against the ORIGINAL source — not the masked
 * copy, not a normalized copy — because the editor renders them beside the
 * author's own text.
 */
export function lintScriptSource(source: string): ScriptLintFinding[] {
  const findings: ScriptLintFinding[] = [];
  if (source === '') return findings;

  const { masked, scans, lines } = scanSource(source);

  for (const paragraph of collectParagraphs(scans)) {
    const text = masked.slice(paragraph.start, paragraph.end);
    const tokens = tokenizeText(text);
    if (tokens.length === 0) continue;

    const first = tokens[0]!;
    const last = tokens[tokens.length - 1]!;

    if (tokens.length > LONG_PARAGRAPH_WORDS) {
      findings.push(
        longParagraphFinding(
          lines,
          tokens.length,
          paragraph.start + first.start,
          paragraph.start + last.end,
        ),
      );
    }

    /*
     * A caps run is measured over the paragraph rather than the line: authors
     * wrap prose wherever the window happens to be narrow, and a run that
     * straddles a soft wrap is exactly as hard to read as one that does not.
     */
    let runStart = -1;
    let runEnd = -1;
    let runWords = 0;
    const flushRun = () => {
      if (runWords >= CAPS_RUN_WORDS) {
        const start = paragraph.start + runStart;
        const { line, column } = positionAt(lines, start);
        findings.push({
          code: 'all-caps-run',
          severity: 'info',
          line,
          column,
          length: paragraph.start + runEnd - start,
          message:
            `${runWords} words in a row are set in capitals. Capitals are slower to read ` +
            'continuously — every word is the same flat rectangle, so the eye has to spell ' +
            'them out instead of recognising their shape at a glance.',
          hint: 'Use sentence case here, and carry the emphasis with bold or a cue.',
        });
      }
      runStart = -1;
      runEnd = -1;
      runWords = 0;
    };
    for (const token of tokens) {
      const kind = caseClass(token.surface);
      if (kind === 'break') {
        flushRun();
        continue;
      }
      if (kind === 'neutral') continue;
      if (runStart < 0) runStart = token.start;
      runEnd = token.end;
      runWords += 1;
    }
    flushRun();

    /*
     * Bullets are exempt from the terminal-punctuation rule. A list authored
     * without full stops is a normal, deliberate way to write one, and flagging
     * every bullet in a script would teach the author to ignore this lint
     * wholesale — which would cost them the long-paragraph finding too.
     */
    if (!paragraph.allListItems) {
      const tail = text.trimEnd().replace(TRAILING_CLOSERS, '');
      if (!TERMINAL_PUNCTUATION.test(tail)) {
        const start = paragraph.start + last.start;
        const { line, column } = positionAt(lines, start);
        findings.push({
          code: 'no-terminal-punctuation',
          severity: 'info',
          line,
          column,
          length: last.end - last.start,
          message:
            'This paragraph ends without a full stop, question mark, exclamation mark or ' +
            'colon. That mark is the end-of-thought signal both the display and the tracker ' +
            'read, so without it the stage has nowhere to breathe here and the tracker loses ' +
            'the clearest evidence it gets that you finished the paragraph.',
          hint: 'End it with a full stop, even if you would not pause there.',
        });
      }
    }

    for (const sentence of segmentSentences(text)) {
      const sentenceTokens = tokenizeText(sentence.text);
      if (sentenceTokens.length <= LONG_SENTENCE_WORDS) continue;
      const start = paragraph.start + sentence.start;
      const { line, column } = positionAt(lines, start);
      findings.push({
        code: 'very-long-sentence',
        severity: 'info',
        line,
        column,
        length: sentence.end - sentence.start,
        message:
          `This sentence runs to ${sentenceTokens.length} spoken words. There is no boundary ` +
          'inside it for the display to breathe at or for the tracker to settle on, so it ' +
          'arrives as one unbroken wall and stays that way until you reach the end of it.',
        hint: 'Split it at the breath you would actually take.',
      });
    }
  }

  return findings.sort((a, b) => a.line - b.line || (a.column ?? 0) - (b.column ?? 0));
}
