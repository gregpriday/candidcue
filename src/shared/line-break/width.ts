/**
 * How wide a token is.
 *
 * Two answers live here: the character-cell estimate this module falls back to,
 * and the accessors that let a caller override it with a real measurement. The
 * solver only ever calls the accessors, so it has no idea which of the two it
 * is working in — which is exactly what lets one dynamic program serve both a
 * node test counting cells and a stage counting pixels.
 */

import type { LineBreakToken } from './types';

/**
 * Whether a code point occupies two character cells.
 *
 * The measure is in characters, and a character is not a fixed width once the
 * text stops being Latin: a line of 30 Han glyphs is twice as wide as a line of
 * 30 letters, and counting them the same would hand CJK a column twice the one
 * that was calibrated. These are the East Asian Wide and Fullwidth blocks; the
 * approximation is coarse and it is still enormously better than 1.
 */
function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/**
 * Width of one token in character cells.
 *
 * Iterated by code point rather than by `length`, so an emoji or an astral
 * glyph counts once instead of twice — `String.length` counts UTF-16 units, and
 * a measure built on it silently shrinks the column for anyone whose script
 * lives outside the BMP.
 */
export function visualWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    const cp = character.codePointAt(0);
    if (cp === undefined) continue;
    width += isWideCodePoint(cp) ? 2 : 1;
  }
  return width;
}

/** A supplied width is only usable if it is a real, non-negative number. */
function usable(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * The advance of one token: what the caller measured, or the cell estimate.
 *
 * Falling back per FIELD rather than per token matters — a caller that measures
 * most of a block and misses one span gets a plan that is wrong about one word,
 * not a plan that silently reverts the whole block to character cells while the
 * measure stays in pixels.
 */
export function tokenWidth(token: LineBreakToken): number {
  if (usable(token.width)) return token.width;
  return visualWidth(typeof token.text === 'string' ? token.text : '');
}

/** The advance of the gap to the next token. */
export function tokenSeparator(token: LineBreakToken): number {
  if (usable(token.separatorWidth)) return token.separatorWidth;
  return token.spaceAfter === false ? 0 : 1;
}
