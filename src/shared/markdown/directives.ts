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
import type { CompileDiagnostic } from '../contracts';

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
/* Retired `coach:` front matter                                       */
/* ------------------------------------------------------------------ */

/**
 * Blank a leading `coach:` block, the front matter of the retired coaching
 * rail, so scripts written for it keep it off the glass.
 *
 * Nothing reads the block any more. It is hidden only because it always was:
 * unmasked, it parses as a rule followed by a setext heading of its keys, and
 * every old script that opens with one would grow a heading overnight.
 *
 * ---------------------------------------------------------------------------
 * THE `---` AMBIGUITY
 * ---------------------------------------------------------------------------
 * A leading `---` is already valid CandidCue Markdown: it is a horizontal
 * rule, and `Title\n---` is a setext heading. Three conditions must all hold,
 * and the third is the one that makes this safe:
 *
 *  1. the very first line of the document is exactly `---`;
 *  2. a later line is exactly `---` (or `...`), closing the block;
 *  3. the block contains a **top-level `coach:` key**.
 *
 * (3) is deliberately narrower than YAML. The only documents it touches are
 * the ones that carry the retired key; `---` / `# Heading` / `---` is still a
 * rule, a heading and a rule. Treating every leading block as front matter
 * would change existing documents, and is not this function's decision.
 *
 * The block is blanked with spaces of identical length, so every source offset
 * survives. A setext heading cannot reach here at all: it requires text on
 * line 1.
 */
export function maskLegacyCoachFrontMatter(source: string): string {
  const lines = splitLines(source);
  const first = lines[0];
  if (!first || first.text.trim() !== '---') return source;

  let closeIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    const text = lines[i]!.text.trim();
    if (text === '---' || text === '...') {
      closeIndex = i;
      break;
    }
  }
  if (closeIndex < 0) return source;

  const body = lines.slice(1, closeIndex);
  if (!body.some((line) => /^coach\s*:/.test(line.text))) return source;

  const chars = source.split('');
  blankRange(chars, 0, lines[closeIndex]!.end);
  return chars.join('');
}
