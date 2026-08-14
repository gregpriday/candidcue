/**
 * Inline text segmentation: splits a SafeRenderNode text run into word and
 * whitespace segments, attaching token indexes to words so tracking can
 * anchor to individual tokens. Pure logic.
 */

/*
 * The face travels with the stack that names it.
 *
 * `stageFontStack` is the only thing in the app that asks for Atkinson
 * Hyperlegible Next, and `fonts.css` is the only thing that provides it. Every
 * surface that renders the stage font reaches it through this module, so
 * importing the declarations here makes the two impossible to separate: there
 * is no entry point that can pick up the stack and miss the @font-face, and no
 * new stage surface that has to remember to add a stylesheet import. Under
 * Vite this also makes the woff2 files a build input, so a missing or renamed
 * font file fails the build instead of degrading to the fallback on a rig.
 */
import '../../styles/fonts.css';
import { resolveWordTokens } from './word-tokens';

export interface TextSegment {
  text: string;
  /** Token index for word segments when the compiler mapping aligns. */
  tokenIndex: number | null;
  space: boolean;
}

export function segmentText(
  text: string,
  tokenIndexes?: readonly number[],
  wordTokens?: readonly (number | null)[],
): TextSegment[] {
  const parts = text.split(/(\s+)/);
  const words = parts.filter((p, i) => i % 2 === 0 && p.length > 0);
  const byWord = resolveWordTokens(words.length, tokenIndexes, wordTokens);
  const segments: TextSegment[] = [];
  let wordIdx = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === undefined || part.length === 0) continue;
    const isSpace = i % 2 === 1;
    if (isSpace) {
      segments.push({ text: part, tokenIndex: null, space: true });
    } else {
      segments.push({ text: part, tokenIndex: byWord[wordIdx] ?? null, space: false });
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
 * The first name is bundled — `fonts.css`, imported above, declares
 * 'Atkinson Hyperlegible Next' over four local woff2 subsets — so on a healthy
 * install this stack stops at its first entry and the presenter gets the face
 * they chose. The rest of it is what happens when that fails: the original
 * Atkinson for anyone who has it installed system-wide, then the humanist
 * stack.
 *
 * The tail still matters, because when the bundled face is absent the fallback
 * decides the column measure the optical resolver already committed to — so it
 * has to be the closest thing available. Atkinson is humanist-proportioned;
 * Seravek and Segoe UI are much nearer to it than whatever `system-ui`
 * resolves to on a given machine, so the geometry moves least in the case
 * where the bundle did not load.
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
