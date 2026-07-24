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
  /** Parsed fields for kind === 'spoken'. */
  spoken?: { visual: string; say: string; visualRange: [number, number]; sayRange: [number, number] };
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

function splitLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  let lineNumber = 1;
  for (let i = 0; i <= source.length; i++) {
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

/** Scan for ::: containers; returns masked source + regions + diagnostics. */
export function scanContainers(source: string): ContainerScanResult {
  const lines = splitLines(source);
  const regions: ContainerRegion[] = [];
  const diagnostics: CompileDiagnostic[] = [];
  // split('') keeps UTF-16 code-unit indexing (spread would split by code
  // point and shift every offset after an astral character).
  const chars = source.split('');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const open = /^:::\s*([A-Za-z][A-Za-z-]*)\s*$/.exec(line.text);
    if (!open) {
      // A stray closing fence outside any container.
      if (/^:::\s*$/.test(line.text)) {
        diagnostics.push({
          code: 'directive_stray_fence',
          severity: 'warning',
          message: 'Closing ::: fence without a matching opening directive.',
          blocking: false,
          source: { utf16Start: line.start, utf16End: line.end, line: line.lineNumber },
          suggestedAction: 'fix_directive',
        });
        blankRange(chars, line.start, line.end);
      }
      i++;
      continue;
    }

    const name = open[1]!.toLowerCase();
    if (!KNOWN_CONTAINERS.has(name)) {
      // Unknown directive: keep the whole container (including its closing
      // fence) visible as readable source (spec §22.7).
      diagnostics.push({
        code: 'directive_unknown',
        severity: 'warning',
        message: `Unknown directive ":::${name}" renders as plain text.`,
        blocking: false,
        source: { utf16Start: line.start, utf16End: line.end, line: line.lineNumber },
        suggestedAction: 'fix_directive',
      });
      let skipTo = i + 1;
      for (let j = i + 1; j < lines.length; j++) {
        if (/^:::\s*$/.test(lines[j]!.text)) {
          skipTo = j + 1;
          break;
        }
        if (/^:::\s*[A-Za-z]/.test(lines[j]!.text)) break;
      }
      i = skipTo;
      continue;
    }

    // Find the closing fence.
    let closeIndex = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^:::\s*$/.test(lines[j]!.text)) {
        closeIndex = j;
        break;
      }
      // A new opening fence before a close means the previous is unclosed.
      if (/^:::\s*[A-Za-z]/.test(lines[j]!.text)) break;
    }

    const kind = name as ContainerKind;
    if (closeIndex === -1) {
      // Unclosed containers alter the spoken stream ambiguously -> blocking
      // for spoken/silent, warning otherwise (spec §23.8). Content compiles
      // as ordinary Markdown so nothing disappears silently.
      diagnostics.push({
        code: 'directive_unclosed',
        severity: kind === 'spoken' || kind === 'silent' ? 'error' : 'warning',
        message: `":::${name}" is never closed; its content compiles as normal text.`,
        blocking: kind === 'spoken' || kind === 'silent',
        source: { utf16Start: line.start, utf16End: line.end, line: line.lineNumber },
        suggestedAction: 'fix_directive',
      });
      blankRange(chars, line.start, line.end);
      i++;
      continue;
    }

    const closeLine = lines[closeIndex]!;
    const contentStart = line.end + 1 <= source.length ? line.end + 1 : line.end;
    const contentEnd = closeLine.start;
    const region: ContainerRegion = {
      kind,
      start: line.start,
      end: Math.min(closeLine.end + 1, source.length),
      contentStart,
      contentEnd,
      closed: true,
    };

    blankRange(chars, line.start, line.end);
    blankRange(chars, closeLine.start, closeLine.end);

    if (kind === 'spoken') {
      // Body is visual:/say: plain text, not Markdown — blank it entirely.
      blankRange(chars, contentStart, contentEnd);
      const body = source.slice(contentStart, contentEnd);
      const visualMatch = /(^|\n)[ \t]*visual:[ \t]*(.*)/i.exec(body);
      const sayMatch = /(^|\n)[ \t]*say:[ \t]*(.*)/i.exec(body);
      if (!visualMatch || !sayMatch || !sayMatch[2]!.trim()) {
        diagnostics.push({
          code: 'directive_spoken_malformed',
          severity: 'error',
          message:
            'A :::spoken block needs both "visual:" and "say:" lines with text.',
          blocking: true,
          source: { utf16Start: line.start, utf16End: region.end, line: line.lineNumber },
          suggestedAction: 'fix_directive',
        });
      } else {
        const visualText = visualMatch[2]!.trim();
        const sayText = sayMatch[2]!.trim();
        const visualOffset =
          contentStart + visualMatch.index + visualMatch[0]!.indexOf(visualMatch[2]!);
        const sayOffset = contentStart + sayMatch.index + sayMatch[0]!.indexOf(sayMatch[2]!);
        region.spoken = {
          visual: visualText,
          say: sayText,
          visualRange: [visualOffset, visualOffset + visualMatch[2]!.length],
          sayRange: [sayOffset, sayOffset + sayMatch[2]!.length],
        };
        if (!visualText) {
          diagnostics.push({
            code: 'directive_spoken_malformed',
            severity: 'error',
            message: 'The "visual:" line of a :::spoken block is empty.',
            blocking: true,
            source: { utf16Start: line.start, utf16End: region.end, line: line.lineNumber },
            suggestedAction: 'fix_directive',
          });
          region.spoken = undefined;
        }
      }
    }

    regions.push(region);
    i = closeIndex + 1;
  }

  return { maskedSource: chars.join(''), regions, diagnostics };
}

/** Locate the container region (if any) that contains offset. */
export function containerAt(regions: ContainerRegion[], offset: number): ContainerRegion | undefined {
  for (const region of regions) {
    if (offset >= region.start && offset < region.end) return region;
  }
  return undefined;
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
        message: 'A [Take: …] marker needs a name to be a navigation target.',
        blocking: true,
      };
    }
    return { kind: 'take', name: value };
  }
  return { kind: 'none' };
}

/** Inline spoken alias: Word{say="Spoken Form"} (spec §23.4). */
export const INLINE_SAY_PATTERN = /\{say="([^"\n]*)"\}/;
