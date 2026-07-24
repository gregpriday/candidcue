/**
 * Inline text segmentation: splits a SafeRenderNode text run into word and
 * whitespace segments, attaching token indexes to words so tracking can
 * anchor to individual tokens. Pure logic.
 */

export interface TextSegment {
  text: string;
  /** Token index for word segments when the compiler mapping aligns. */
  tokenIndex: number | null;
  space: boolean;
}

export function segmentText(text: string, tokenIndexes?: readonly number[]): TextSegment[] {
  const parts = text.split(/(\s+)/);
  const words = parts.filter((p, i) => i % 2 === 0 && p.length > 0);
  const aligned = !!tokenIndexes && tokenIndexes.length === words.length;
  const segments: TextSegment[] = [];
  let wordIdx = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === undefined || part.length === 0) continue;
    const isSpace = i % 2 === 1;
    if (isSpace) {
      segments.push({ text: part, tokenIndex: null, space: true });
    } else {
      let tokenIndex: number | null = null;
      if (aligned && tokenIndexes) {
        tokenIndex = tokenIndexes[wordIdx] ?? null;
      } else if (tokenIndexes && tokenIndexes.length > 0 && wordIdx === 0) {
        // Misaligned mapping: anchor at least the run start.
        tokenIndex = tokenIndexes[0] ?? null;
      }
      segments.push({ text: part, tokenIndex, space: false });
      wordIdx++;
    }
  }
  return segments;
}

/** Stage font stacks by settings.fontFamilyId (spec §11.4: bundled/system only). */
export function stageFontStack(fontFamilyId: string): string {
  switch (fontFamilyId) {
    case 'humanist':
      return "Seravek, 'Segoe UI', Verdana, system-ui, sans-serif";
    case 'serif':
      return "'Iowan Old Style', 'Palatino Linotype', Georgia, serif";
    case 'mono':
      return 'ui-monospace, SFMono-Regular, Consolas, monospace';
    case 'system-sans':
    default:
      return "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
  }
}
