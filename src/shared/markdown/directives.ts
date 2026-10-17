/**
 * CandidCue directive syntax (spec §23).
 *
 * Inline directives: [Cue: label], [Pause], [Beat], [Breathe], [Take: Name].
 * Container directives: :::spoken, :::silent, :::stage, :::literal-command.
 * Inline spoken alias: Word{say="spoken form"}.
 *
 * Containers are recognized with a line scan before Markdown parsing. Fence
 * lines (and the entire body of :::spoken, which is not Markdown) are
 * blanked with spaces of identical length so remark sees blank lines there
 * and every other source offset survives unchanged.
 */
import type { CoachDirectiveStyle, CoachFrontMatter, CompileDiagnostic } from '../contracts';

export type ContainerKind = 'spoken' | 'silent' | 'stage' | 'literal-command';

export interface ContainerRegion {
  kind: ContainerKind;
  /** UTF-16 offset of the opening ':::' line start. */
  start: number;
  /** UTF-16 offset just past the closing ':::' line (or EOF when unclosed). */
  end: number;
  /** Offset range of the inner content (between fence lines). */
  contentStart: number;
  contentEnd: number;
  closed: boolean;
  /** Enclosing region, when this container is nested inside another (§23.6). */
  parent?: ContainerRegion;
  /** Parsed fields for kind === 'spoken'. */
  spoken?: { visual: string; say: string; visualRange: [number, number]; sayRange: [number, number] };
  /**
   * A closed :::spoken block whose visual:/say: lines could not be parsed.
   * The body is still masked out of the Markdown stream (it is not Markdown),
   * so the compiler emits a warning card carrying the raw source instead of
   * letting the content vanish (§23.8).
   */
  spokenMalformed?: boolean;
}

/**
 * Composed semantics of a region and everything enclosing it (§23.5-§23.7).
 * Suppression from ANY ancestor wins, so `:::silent` around a
 * `:::literal-command` still silences it; an explicit `:::spoken` block is
 * the one marker that stays spoken inside a `:::stage` or `:::silent`
 * ancestor, because §23.6 defines stage content as non-spoken *unless nested
 * text is explicitly marked as spoken*.
 */
export interface ContainerSemantics {
  silent: boolean;
  stage: boolean;
  literalCommand: boolean;
}

export function resolveContainerSemantics(
  region: ContainerRegion | undefined,
): ContainerSemantics {
  const semantics: ContainerSemantics = { silent: false, stage: false, literalCommand: false };
  for (let node = region; node; node = node.parent) {
    if (node.kind === 'silent') semantics.silent = true;
    else if (node.kind === 'stage') semantics.stage = true;
    else if (node.kind === 'literal-command') semantics.literalCommand = true;
  }
  return semantics;
}

export interface ContainerScanResult {
  /** Source with container fences (and :::spoken bodies) space-blanked. */
  maskedSource: string;
  regions: ContainerRegion[];
  diagnostics: CompileDiagnostic[];
}

const KNOWN_CONTAINERS: ReadonlySet<string> = new Set([
  'spoken',
  'silent',
  'stage',
  'literal-command',
]);

function blankRange(chars: string[], start: number, end: number): void {
  for (let i = start; i < end; i++) {
    const ch = chars[i];
    if (ch !== '\n' && ch !== '\r') chars[i] = ' ';
  }
}

interface SourceLine {
  text: string;
  start: number;
  end: number; // exclusive, without newline
  lineNumber: number; // 1-based
}

/** U+FEFF. Only at offset 0 is it a byte-order mark; anywhere else it is text. */
export const BYTE_ORDER_MARK = 0xfeff;

function splitLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  // A leading byte-order mark is not part of line one: left in, `\uFEFF:::stage`
  // fails every fence test (#247). Offsets stay absolute, so line one starts at 1.
  let start = source.charCodeAt(0) === BYTE_ORDER_MARK ? 1 : 0;
  let lineNumber = 1;
  for (let i = start; i <= source.length; i++) {
    if (i === source.length || source.charAt(i) === '\n') {
      let end = i;
      if (end > start && source.charAt(end - 1) === '\r') end--;
      lines.push({ text: source.slice(start, end), start, end, lineNumber });
      start = i + 1;
      lineNumber++;
    }
  }
  return lines;
}

interface OpenFrame {
  /** undefined for an unknown directive name, which is kept as source. */
  kind: ContainerKind | undefined;
  name: string;
  line: SourceLine;
}

/**
 * Scan for ::: containers; returns masked source + regions + diagnostics.
 *
 * Containers nest (§23.6 explicitly nests `:::spoken` inside `:::stage`), so
 * this keeps a stack: a bare `:::` closes the innermost open container, and a
 * new opening fence never terminates its parent. Anything still open at EOF
 * is reported unclosed and its content compiles as ordinary Markdown.
 */
export function scanContainers(source: string): ContainerScanResult {
  const lines = splitLines(source);
  const regions: ContainerRegion[] = [];
  const diagnostics: CompileDiagnostic[] = [];
  // split('') keeps UTF-16 code-unit indexing (spread would split by code
  // point and shift every offset after an astral character).
  const chars = source.split('');
  const stack: OpenFrame[] = [];
  /** Open fenced code block, if any: nothing inside it is a directive. */
  let fence: { marker: string; length: number } | null = null;

  const unclosed = (frame: OpenFrame) => {
    const blocking = frame.kind === 'spoken' || frame.kind === 'silent';
    diagnostics.push({
      code: 'directive_unclosed',
      severity: blocking ? 'error' : 'warning',
      message: `":::${frame.name}" is never closed; its content compiles as normal text.`,
      blocking,
      source: {
        utf16Start: frame.line.start,
        utf16End: frame.line.end,
        line: frame.line.lineNumber,
      },
      suggestedAction: 'fix_directive',
    });
    // Known directives lose their fence line so the marker is not read aloud;
    // unknown ones stay visible as readable source (§22.7).
    if (frame.kind) blankRange(chars, frame.line.start, frame.line.end);
  };

  for (const line of lines) {
    // Fenced code is literal: a ::: line inside ``` or ~~~ is example text,
    // not a directive. Without this the scanner blanked the fence body (so a
    // fenced example of the directive syntax vanished from the code card) and
    // emitted a phantom :::spoken block into the alignment stream.
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line.text);
      if (close && close[1]!.charAt(0) === fence.marker && close[1]!.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    const fenceOpen = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.text);
    if (fenceOpen && !(fenceOpen[1]!.charAt(0) === '`' && fenceOpen[2]!.includes('`'))) {
      fence = { marker: fenceOpen[1]!.charAt(0), length: fenceOpen[1]!.length };
      continue;
    }

    const open = /^:::\s*([A-Za-z][A-Za-z-]*)\s*$/.exec(line.text);
    if (open) {
      const name = open[1]!.toLowerCase();
      const known = KNOWN_CONTAINERS.has(name);
      if (!known) {
        // Unknown directive: keep the whole container (including its fences)
        // visible as readable source (spec §22.7).
        diagnostics.push({
          code: 'directive_unknown',
          severity: 'warning',
          message: `Unknown directive ":::${name}" renders as plain text.`,
          blocking: false,
          source: { utf16Start: line.start, utf16End: line.end, line: line.lineNumber },
          suggestedAction: 'fix_directive',
        });
      }
      stack.push({ kind: known ? (name as ContainerKind) : undefined, name, line });
      continue;
    }

    if (!/^:::\s*$/.test(line.text)) continue;

    const frame = stack.pop();
    if (!frame) {
      diagnostics.push({
        code: 'directive_stray_fence',
        severity: 'warning',
        message: 'Closing ::: fence without a matching opening directive.',
        blocking: false,
        source: { utf16Start: line.start, utf16End: line.end, line: line.lineNumber },
        suggestedAction: 'fix_directive',
      });
      blankRange(chars, line.start, line.end);
      continue;
    }

    if (!frame.kind) continue; // unknown container: both fences stay visible

    const contentStart = frame.line.end + 1 <= source.length ? frame.line.end + 1 : frame.line.end;
    const region: ContainerRegion = {
      kind: frame.kind,
      start: frame.line.start,
      end: Math.min(line.end + 1, source.length),
      contentStart,
      contentEnd: line.start,
      closed: true,
    };

    blankRange(chars, frame.line.start, frame.line.end);
    blankRange(chars, line.start, line.end);
    if (frame.kind === 'spoken') {
      parseSpokenBody(source, chars, region, diagnostics, frame.line.lineNumber);
    }
    regions.push(region);
  }

  // Report unclosed containers in document order, not stack-pop order.
  for (const frame of stack) unclosed(frame);
  stack.length = 0;

  // Document order, outermost first when two regions share a start offset.
  regions.sort((a, b) => a.start - b.start || b.end - a.end);
  return { maskedSource: chars.join(''), regions, diagnostics };
}

function parseSpokenBody(
  source: string,
  chars: string[],
  region: ContainerRegion,
  diagnostics: CompileDiagnostic[],
  line: number,
): void {
  // Body is visual:/say: plain text, not Markdown — blank it entirely.
  blankRange(chars, region.contentStart, region.contentEnd);
  const body = source.slice(region.contentStart, region.contentEnd);
  const visualMatch = /(^|\n)[ \t]*visual:[ \t]*(.*)/i.exec(body);
  const sayMatch = /(^|\n)[ \t]*say:[ \t]*(.*)/i.exec(body);
  const malformed = (message: string) => {
    diagnostics.push({
      code: 'directive_spoken_malformed',
      severity: 'error',
      message,
      blocking: true,
      source: { utf16Start: region.start, utf16End: region.end, line },
      suggestedAction: 'fix_directive',
    });
    region.spoken = undefined;
    region.spokenMalformed = true;
  };

  if (!visualMatch || !sayMatch || !sayMatch[2]!.trim()) {
    malformed('A :::spoken block needs both "visual:" and "say:" lines with text.');
    return;
  }
  const visualText = visualMatch[2]!.trim();
  const sayText = sayMatch[2]!.trim();
  const visualOffset =
    region.contentStart + visualMatch.index + visualMatch[0]!.indexOf(visualMatch[2]!);
  const sayOffset = region.contentStart + sayMatch.index + sayMatch[0]!.indexOf(sayMatch[2]!);
  region.spoken = {
    visual: visualText,
    say: sayText,
    visualRange: [visualOffset, visualOffset + visualMatch[2]!.length],
    sayRange: [sayOffset, sayOffset + sayMatch[2]!.length],
  };
  if (!visualText) malformed('The "visual:" line of a :::spoken block is empty.');
}

/**
 * Sorted-region cursor for document-order block lookup. Blocks arrive in
 * ascending source order, so a monotonic cursor plus a short containment walk
 * replaces the previous linear scan per block (O(blocks + containers) instead
 * of O(blocks x containers), spec §25.8).
 */
export class ContainerIndex {
  private cursor = 0;
  private open: ContainerRegion[] = [];

  constructor(private readonly regions: readonly ContainerRegion[]) {
    // Regions arrive sorted by start (outermost first on ties); stitch parent
    // links by containment so nested semantics compose (§23.6).
    const stack: ContainerRegion[] = [];
    for (const region of regions) {
      while (stack.length > 0 && stack[stack.length - 1]!.end <= region.start) stack.pop();
      if (stack.length > 0) region.parent = stack[stack.length - 1]!;
      stack.push(region);
    }
  }

  /** Innermost region containing `offset`, advancing the document cursor. */
  at(offset: number): ContainerRegion | undefined {
    while (this.cursor < this.regions.length && this.regions[this.cursor]!.start <= offset) {
      const region = this.regions[this.cursor]!;
      this.cursor++;
      // Retire siblings that closed before this one opened, so `open` stays a
      // true nesting stack and the lookup below is O(1).
      while (this.open.length > 0 && this.open[this.open.length - 1]!.end <= region.start) {
        this.open.pop();
      }
      this.open.push(region);
    }
    while (this.open.length > 0 && this.open[this.open.length - 1]!.end <= offset) this.open.pop();
    return this.open[this.open.length - 1];
  }
}

/** Locate the container region (if any) that contains offset (innermost). */
export function containerAt(
  regions: readonly ContainerRegion[],
  offset: number,
): ContainerRegion | undefined {
  let found: ContainerRegion | undefined;
  for (const region of regions) {
    if (offset >= region.start && offset < region.end) {
      if (!found || region.start >= found.start) found = region;
    }
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* Inline bracket directives                                           */
/* ------------------------------------------------------------------ */

export type InlineDirective =
  | { kind: 'cue'; cueType: 'cue' | 'pause' | 'beat' | 'breathe'; label: string }
  | { kind: 'take'; name: string }
  | { kind: 'malformed'; code: string; message: string; blocking: boolean }
  | { kind: 'none' };

const SHORTHAND_CUES: Readonly<Record<string, 'pause' | 'beat' | 'breathe'>> = {
  pause: 'pause',
  beat: 'beat',
  breathe: 'breathe',
};

/**
 * Classify the label text of a bracketed span ("Cue: smile", "Pause",
 * "Take: Opening"). Directive names are case-insensitive; user text is
 * preserved (spec §23.1).
 */
export function classifyBracketDirective(label: string): InlineDirective {
  const trimmed = label.trim();
  const shorthand = SHORTHAND_CUES[trimmed.toLowerCase()];
  if (shorthand) return { kind: 'cue', cueType: shorthand, label: trimmed };

  const named = /^([A-Za-z][A-Za-z-]*)\s*:\s*([\s\S]*)$/.exec(trimmed);
  if (!named) return { kind: 'none' };
  const name = named[1]!.toLowerCase();
  const value = named[2]!.trim();

  if (name === 'cue') {
    if (!value) {
      return {
        kind: 'malformed',
        code: 'directive_cue_empty',
        message: 'A [Cue: …] directive needs a label.',
        blocking: false,
      };
    }
    return { kind: 'cue', cueType: 'cue', label: value };
  }
  if (name === 'take') {
    if (!value) {
      return {
        kind: 'malformed',
        code: 'directive_take_empty',
        message: 'A part break ([Take: …]) needs a name to be a navigation target.',
        blocking: true,
      };
    }
    return { kind: 'take', name: value };
  }
  return { kind: 'none' };
}

/** Inline spoken alias: Word{say="Spoken Form"} (spec §23.4). */
export const INLINE_SAY_PATTERN = /\{say="([^"\n]*)"\}/;

/* ------------------------------------------------------------------ */
/* §19.4 coaching directives                                           */
/* ------------------------------------------------------------------ */

/**
 * §19.4 writes coaching directives as HTML comments (`<!-- cc:coach off -->`).
 *
 * That syntax is free of the one hazard every directive has to clear: the
 * compiler already discards HTML comments at the AST level (§22.2), in both
 * `buildHtmlBlock` and `walkPhrasing`, so a `cc:` comment cannot contribute a
 * spoken token or shift a token index no matter what it says. This module only
 * classifies the comment text; the compiler decides what it scopes over.
 *
 * The directive *keyword* is deliberately not a mdast extension and not a new
 * fence: a second scanning mechanism would be a second way to get the masking
 * wrong.
 */

const COACH_DIRECTIVE_STYLES: ReadonlySet<string> = new Set<CoachDirectiveStyle>([
  'calm',
  'natural',
  'conversational',
  'expressive',
  'broadcast',
]);

export type CoachDirective =
  /** `cc:coach off` opens a no-coaching scope; `cc:coach on` closes one. */
  | { kind: 'coach'; enabled: boolean }
  | { kind: 'style'; style: CoachDirectiveStyle }
  | { kind: 'pace'; lowWpm: number; highWpm: number }
  | { kind: 'filler' }
  /** Explicit end of every scope opened since the previous `cc:end`. */
  | { kind: 'end' }
  /** Recognized as a `cc:` comment but not usable; carries its own report. */
  | { kind: 'diagnostic'; code: string; message: string }
  /** Not a `cc:` comment at all. */
  | { kind: 'none' };

/**
 * §19.4 directives with no consumer in this build.
 *
 * These are reported rather than silently accepted. A directive that parses
 * and does nothing is worse than one that is missing, because the author
 * believes it worked:
 *
 * - `cc:pause` would have to reach the cadence lane's pause *location* input,
 *   which is an alignment fact nothing currently supplies;
 * - `cc:emphasis` would have to reach the variety lane's emphasis-contrast
 *   term, which the orchestrator hard-codes to `null` (§17.5 redistributes it);
 * - `cc:duration` is a per-section budget, and the only duration projection
 *   that exists (§14.10) is whole-script — that one is settable from §19.5
 *   front matter instead.
 */
const UNSUPPORTED_COACH_DIRECTIVES: ReadonlySet<string> = new Set([
  'pause',
  'emphasis',
  'duration',
]);

/** Matches the whole comment; the `cc:` prefix is what makes it ours. */
const COACH_COMMENT_PATTERN = /^<!--\s*cc:\s*([\s\S]*?)\s*-->$/i;

/**
 * Classify the raw text of an HTML comment as a §19.4 directive.
 *
 * `raw` is the comment exactly as it appears in the source, including the
 * `<!--` and `-->` delimiters. Anything that is not a `cc:` comment returns
 * `none` and is left to the compiler's ordinary comment handling.
 */
export function classifyCoachComment(raw: string): CoachDirective {
  const match = COACH_COMMENT_PATTERN.exec(raw.trim());
  if (!match) return { kind: 'none' };
  const body = match[1]!.trim();
  if (!body) {
    return {
      kind: 'diagnostic',
      code: 'coach_directive_unknown',
      message: 'An empty "cc:" directive has no effect.',
    };
  }
  const split = /^([A-Za-z][A-Za-z-]*)\s*([\s\S]*)$/.exec(body);
  if (!split) {
    return {
      kind: 'diagnostic',
      code: 'coach_directive_unknown',
      message: `Unrecognized coaching directive "cc:${body}"; it has no effect.`,
    };
  }
  const name = split[1]!.toLowerCase();
  const value = split[2]!.trim();

  switch (name) {
    case 'coach': {
      const state = value.toLowerCase();
      if (state === 'off') return { kind: 'coach', enabled: false };
      if (state === 'on') return { kind: 'coach', enabled: true };
      return badValue('coach', value, 'Use "cc:coach off" or "cc:coach on".');
    }
    case 'style': {
      const style = value.toLowerCase();
      if (COACH_DIRECTIVE_STYLES.has(style)) {
        return { kind: 'style', style: style as CoachDirectiveStyle };
      }
      return badValue(
        'style',
        value,
        'Use one of: calm, natural, conversational, expressive, broadcast.',
      );
    }
    case 'pace': {
      // An en dash or em dash is what a word processor produces from "125-145",
      // and rejecting it would fail a script the author cannot see anything
      // wrong with.
      const range = /^(\d{2,3})\s*[-–—]\s*(\d{2,3})$/.exec(value);
      if (!range) {
        return badValue('pace', value, 'Use a words-per-minute range, e.g. "cc:pace 125-145".');
      }
      const lowWpm = Number.parseInt(range[1]!, 10);
      const highWpm = Number.parseInt(range[2]!, 10);
      if (lowWpm < 60 || highWpm > 300 || lowWpm >= highWpm) {
        return badValue(
          'pace',
          value,
          'A pace range must read low-to-high and sit between 60 and 300 wpm.',
        );
      }
      return { kind: 'pace', lowWpm, highWpm };
    }
    case 'filler': {
      if (value.toLowerCase() === 'intentional') return { kind: 'filler' };
      return badValue('filler', value, 'The only supported form is "cc:filler intentional".');
    }
    case 'end': {
      if (value) {
        return badValue('end', value, '"cc:end" takes no value.');
      }
      return { kind: 'end' };
    }
    default: {
      if (UNSUPPORTED_COACH_DIRECTIVES.has(name)) {
        return {
          kind: 'diagnostic',
          code: 'coach_directive_unsupported',
          message: `"cc:${name}" is recognized but has no effect in this version, so it is ignored rather than silently accepted.`,
        };
      }
      return {
        kind: 'diagnostic',
        code: 'coach_directive_unknown',
        message: `Unknown coaching directive "cc:${name}"; it has no effect.`,
      };
    }
  }
}

function badValue(name: string, value: string, hint: string): CoachDirective {
  const shown = value ? `"${value}"` : 'an empty value';
  return {
    kind: 'diagnostic',
    code: 'coach_directive_bad_value',
    message: `"cc:${name}" does not accept ${shown}. ${hint}`,
  };
}

/* ------------------------------------------------------------------ */
/* §19.5 front matter                                                  */
/* ------------------------------------------------------------------ */

export interface FrontMatterScanResult {
  /** Source with the front-matter block space-blanked; every offset survives. */
  maskedSource: string;
  frontMatter: CoachFrontMatter | null;
  diagnostics: CompileDiagnostic[];
}

const COACH_RAIL_MODES: ReadonlySet<string> = new Set([
  'off',
  'minimal',
  'coach',
  'studio',
  'review_only',
  'custom',
]);

/**
 * Recognize a §19.5 front-matter block.
 *
 * ---------------------------------------------------------------------------
 * THE `---` AMBIGUITY
 * ---------------------------------------------------------------------------
 * A leading `---` is already valid CandidCue Markdown: it is a horizontal
 * rule, and `Title\n---` is a setext heading. Front matter cannot be allowed
 * to eat either. Three conditions must all hold, and the third is the one that
 * makes this safe:
 *
 *  1. the very first line of the document is exactly `---`;
 *  2. a later line is exactly `---` (or `...`), closing the block;
 *  3. the block contains a **top-level `coach:` key**.
 *
 * (3) is deliberately narrower than YAML. It means the *only* documents whose
 * meaning changes are documents that contain the literal word this feature is
 * about — `---` / `# Heading` / `---` is still a rule, a heading and a rule,
 * and `---` / `Note: something` / `---` is still a rule, a paragraph and a
 * rule, exactly as before. A script that opens with front matter carrying no
 * `coach:` key keeps whatever behaviour it has today rather than silently
 * changing; that is a smaller promise than "we parse YAML front matter", and
 * it is the promise §19.5 actually needs.
 *
 * A setext heading cannot reach here at all: it requires text on line 1.
 */
export function scanFrontMatter(source: string): FrontMatterScanResult {
  const unchanged: FrontMatterScanResult = {
    maskedSource: source,
    frontMatter: null,
    diagnostics: [],
  };
  const lines = splitLines(source);
  const first = lines[0];
  if (!first || first.text.trim() !== '---') return unchanged;

  let closeIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    const text = lines[i]!.text.trim();
    if (text === '---' || text === '...') {
      closeIndex = i;
      break;
    }
  }
  if (closeIndex < 0) return unchanged;

  const body = lines.slice(1, closeIndex);
  if (!body.some((line) => /^coach\s*:/.test(line.text))) return unchanged;

  const diagnostics: CompileDiagnostic[] = [];
  const frontMatter = parseCoachBlock(body, diagnostics);

  const chars = source.split('');
  const end = lines[closeIndex]!.end;
  blankRange(chars, 0, end);
  return { maskedSource: chars.join(''), frontMatter, diagnostics };
}

/**
 * Parse the `coach:` mapping out of a front-matter body.
 *
 * A deliberately small YAML subset — one nested mapping of scalars and inline
 * two-element sequences — because that is all §19.5 defines and because a
 * general YAML parser is a dependency, an attack surface, and a source of
 * behaviour nobody wrote down. Anything outside the subset is reported and
 * skipped; nothing here can fail the compile.
 */
function parseCoachBlock(
  body: readonly SourceLine[],
  diagnostics: CompileDiagnostic[],
): CoachFrontMatter {
  const frontMatter: CoachFrontMatter = { unknownFields: {} };
  let inCoach = false;

  const report = (line: SourceLine, message: string) => {
    diagnostics.push({
      code: 'coach_front_matter_bad_value',
      severity: 'warning',
      message,
      blocking: false,
      source: { utf16Start: line.start, utf16End: line.end, line: line.lineNumber },
      suggestedAction: 'fix_directive',
    });
  };

  for (const line of body) {
    const text = line.text;
    if (!text.trim() || text.trim().startsWith('#')) continue;
    const indented = /^\s/.test(text);
    if (!indented) {
      inCoach = /^coach\s*:/.test(text);
      continue;
    }
    if (!inCoach) continue;

    const pair = /^\s+([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(text);
    if (!pair) continue;
    const key = pair[1]!.toLowerCase();
    const raw = stripQuotes(pair[2]!.trim());

    switch (key) {
      case 'mode': {
        if (COACH_RAIL_MODES.has(raw)) frontMatter.mode = raw as CoachFrontMatter['mode'];
        else report(line, `Unknown coaching mode "${raw}" in front matter; ignored.`);
        break;
      }
      case 'style': {
        if (COACH_DIRECTIVE_STYLES.has(raw)) frontMatter.style = raw as CoachDirectiveStyle;
        else report(line, `Unknown delivery style "${raw}" in front matter; ignored.`);
        break;
      }
      case 'target_wpm': {
        const pairValue = parseNumberPair(raw, 60, 300);
        if (pairValue) frontMatter.targetWpm = pairValue;
        else report(line, `"target_wpm" needs a low-to-high pair such as [130, 165]; ignored.`);
        break;
      }
      case 'target_variety': {
        const pairValue = parseNumberPair(raw, 0, 100);
        if (pairValue) frontMatter.targetVariety = pairValue;
        else report(line, `"target_variety" needs a low-to-high pair such as [45, 75]; ignored.`);
        break;
      }
      case 'target_duration': {
        const seconds = parseDurationSeconds(raw);
        if (seconds !== null) frontMatter.targetDurationSeconds = seconds;
        else report(line, `"target_duration" needs a "MM:SS" or "HH:MM:SS" value; ignored.`);
        break;
      }
      case 'filler_detection': {
        if (raw === 'strict' || raw === 'broad') frontMatter.fillerDetection = raw;
        else {
          report(
            line,
            `"filler_detection" accepts "strict" or "broad"; "${raw}" is not a lexicon width and is ignored. Transcription cost modes are chosen in Settings, never by a script.`,
          );
        }
        break;
      }
      case 'live_tips': {
        if (raw === 'low' || raw === 'normal' || raw === 'high') frontMatter.liveTips = raw;
        else report(line, `"live_tips" accepts "low", "normal" or "high"; ignored.`);
        break;
      }
      case 'positive_feedback': {
        if (raw === 'true' || raw === 'false') frontMatter.positiveFeedback = raw === 'true';
        else report(line, `"positive_feedback" accepts true or false; ignored.`);
        break;
      }
      default:
        // §19.5: preserved but ignored.
        frontMatter.unknownFields[key] = raw;
    }
  }
  return frontMatter;
}

function stripQuotes(value: string): string {
  const match = /^"([\s\S]*)"$|^'([\s\S]*)'$/.exec(value);
  return match ? (match[1] ?? match[2] ?? '') : value;
}

function parseNumberPair(raw: string, min: number, max: number): [number, number] | null {
  const match = /^\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]$/.exec(raw);
  if (!match) return null;
  const low = Number.parseFloat(match[1]!);
  const high = Number.parseFloat(match[2]!);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  if (low < min || high > max || low >= high) return null;
  return [low, high];
}

function parseDurationSeconds(raw: string): number | null {
  const match = /^(?:(\d{1,2}):)?(\d{1,3}):(\d{2})$/.exec(raw);
  if (!match) return null;
  const hours = match[1] ? Number.parseInt(match[1], 10) : 0;
  const minutes = Number.parseInt(match[2]!, 10);
  const seconds = Number.parseInt(match[3]!, 10);
  if (seconds > 59) return null;
  const total = hours * 3600 + minutes * 60 + seconds;
  return total > 0 ? total : null;
}
