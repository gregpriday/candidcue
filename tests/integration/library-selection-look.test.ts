/**
 * How a selected script row is drawn, pinned at the source.
 *
 * ---------------------------------------------------------------------------
 * WHY A TEST AND NOT JUST A COMMENT
 * ---------------------------------------------------------------------------
 * Selection used to be a FILL, and the unfocused half of it was a flat warm
 * grey. Across a full-width row on a white list that reads as dirt rather than
 * as a state, and it is the failure this project's design rules name and
 * forbid — "never muddy grey washes". It is also the failure that comes back
 * first, because "make the selected row a bit darker" is the obvious thing to
 * reach for and it is wrong here.
 *
 * jsdom resolves no stylesheets, so a component test cannot read a computed
 * colour. What CAN be checked is the rule set itself, and the properties below
 * are the ones that carry the design decision rather than its details.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '../..');
const ROW = readFileSync(join(REPO_ROOT, 'src/control/components/ScriptRow.svelte'), 'utf8');
const TOKENS = readFileSync(join(REPO_ROOT, 'src/styles/tokens.css'), 'utf8');

/** The component's `<style>` block, so prose about the design is not matched. */
const ROW_CSS = ROW.slice(ROW.lastIndexOf('<style>'));

describe('a selected row is a marker, not a wash', () => {
  it('draws the selection with an inset accent bar', () => {
    // Inset ::before, never a one-sided border: the list has a radius and clips
    // its rows, so a border-left would cut a straight edge through the rounded
    // corner on the first and last row.
    expect(ROW_CSS).toMatch(/\.selected::before\s*\{/);
    expect(ROW_CSS).toMatch(/position:\s*absolute/);
    expect(ROW_CSS, 'the marker is the brand colour').toMatch(/background:\s*var\(--accent\)/);
  });

  it('uses no neutral fill for selection', () => {
    /*
     * The specific regression. `--bg-row-selected-inactive` is the retired
     * muddy grey; any of the neutral surface tokens would be the same mistake
     * wearing a different name.
     */
    const banned = [
      '--bg-row-selected-inactive',
      '--bg-hover-chrome',
      '--bg-secondary',
      '--bg-sunken',
    ];
    const selectionRules = ROW_CSS.split('\n').filter((line) => /background/.test(line));
    for (const token of banned) {
      expect(
        selectionRules.some((line) => line.includes(token)),
        `${token} is a neutral fill; selection is drawn from the accent family`,
      ).toBe(false);
    }
  });

  it('separates selected-and-focused from selected-and-not by strength', () => {
    /*
     * §23.3 needs the two told apart. They are now the same mark at two
     * intensities rather than two unrelated colours, which is both calmer and a
     * truer description of the difference: one is "selected", the other is
     * "selected, and the keyboard is here".
     */
    expect(ROW_CSS).toMatch(/\.selected\.list-focused::before\s*\{[^}]*opacity:\s*1/);
    expect(ROW_CSS).toMatch(/\.selected::before\s*\{[\s\S]*?opacity:\s*0\.45/);
    expect(ROW_CSS).toMatch(/\.selected\.list-focused[\s\S]*?background:\s*var\(--bg-row-selected\)/);
  });

  it('lets hover deepen a selected row instead of resetting it', () => {
    // The old rule repainted a hovered selected row with the resting selection
    // colour, so the selected row was the one place in the list where hover did
    // nothing at all.
    expect(ROW_CSS).toMatch(/\.selected:hover\s*\{[^}]*var\(--bg-row-selected-hover\)/);
  });

  it('defines the selection ramp in both themes', () => {
    // Three steps, all from the accent family: resting, hover, focused.
    for (const token of ['--accent-wash', '--bg-row-selected-hover', '--bg-row-selected']) {
      const occurrences = TOKENS.split(token).length - 1;
      expect(occurrences, `${token} must be defined in the studio and light themes`).toBeGreaterThanOrEqual(2);
    }
  });

  it('adds no color-mix dependency to a core interaction', () => {
    /*
     * `color-mix` landed in Safari 16.2 and this ships to macOS 12, whose
     * WKWebView is Safari 15.x — where an unsupported value falls back to
     * transparent. That is survivable for a decorative stage tint and is not
     * survivable for "which row am I about to act on".
     */
    expect(ROW_CSS).not.toMatch(/color-mix/);
  });
});
