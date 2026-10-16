/**
 * How many spoken words each outline section holds, keyed by node id.
 *
 * Counted from where sections START, not from `endTokenIndex`. That end is
 * inclusive — the section's last token — and the compiler clamps it to never
 * fall before the start, so a heading with nothing spoken under it and a
 * heading with one word under it carry the same `start == end` pair. No
 * arithmetic on the two endpoints can tell them apart: `end - start` dropped a
 * word from every section, and `end - start + 1` would give every empty one a
 * word it does not have.
 *
 * The starts carry no such ambiguity. The compiler nests sections with a level
 * stack, so each subtree is contiguous in document order and ends exactly
 * where the next thing outside it begins: its next sibling, or else wherever
 * its parent ends. A parent's count therefore includes its children's, as
 * the widened `endTokenIndex` already says it does.
 */
import type { OutlineNode } from '../../shared/contracts';

export function sectionWordCounts(
  outline: readonly OutlineNode[],
  totalWords: number,
): Map<string, number> {
  const counts = new Map<string, number>();
  const walk = (siblings: readonly OutlineNode[], end: number): void => {
    siblings.forEach((node, index) => {
      const next = siblings[index + 1];
      const sectionEnd = next === undefined ? end : Math.min(end, next.startTokenIndex);
      counts.set(node.id, Math.max(0, sectionEnd - node.startTokenIndex));
      walk(node.children, sectionEnd);
    });
  };
  walk(outline, Math.max(0, totalWords));
  return counts;
}
