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

const SYSTEM_SANS_STACK =
  "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
const HUMANIST_STACK = "Seravek, 'Segoe UI', Verdana, system-ui, sans-serif";
const SERIF_STACK = "'Iowan Old Style', 'Palatino Linotype', Georgia, serif";
const MONO_STACK = 'ui-monospace, SFMono-Regular, Consolas, monospace';

/**
 * Atkinson Hyperlegible, degrading into the humanist stack rather than the
 * system one.
 *
 * The face may not be bundled yet, and when it is absent the fallback decides
 * the column measure the optical resolver already committed to — so it has to
 * be the closest thing available. Atkinson is humanist-proportioned; Seravek
 * and Segoe UI are much nearer to it than whatever `system-ui` resolves to on
 * a given machine, so the geometry moves least when the bundle is missing.
 */
const HIGH_LEGIBILITY_STACK = `'Atkinson Hyperlegible Next', 'Atkinson Hyperlegible', ${HUMANIST_STACK}`;

/**
 * Stage font stacks by settings.fontFamilyId (spec §11.4: bundled/system only).
 *
 * Two spellings for two of the families, deliberately. Settings has always
 * written `humanist-sans` and `monospace`, while this switch only ever matched
 * `humanist` and `mono`, so both choices fell through to the default and the
 * stage silently drew system sans for anyone who picked either — including the
 * presenter who chose monospace precisely because they wanted a fixed advance.
 * The persisted settings documents on real machines contain the ids Settings
 * wrote, so matching only the short spellings would reset those users' choice a
 * second time. Both are accepted; neither is canonical enough to be worth a
 * migration.
 */
export function stageFontStack(fontFamilyId: string): string {
  switch (fontFamilyId) {
    case 'humanist':
    case 'humanist-sans':
      return HUMANIST_STACK;
    case 'serif':
      return SERIF_STACK;
    case 'mono':
    case 'monospace':
      return MONO_STACK;
    case 'high-legibility':
      return HIGH_LEGIBILITY_STACK;
    case 'system-sans':
    default:
      return SYSTEM_SANS_STACK;
  }
}
