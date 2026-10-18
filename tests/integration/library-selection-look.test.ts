/**
 * How a selected script row is drawn, pinned at the source.
 *
 * ---------------------------------------------------------------------------
 * WHY A TEST AND NOT JUST A COMMENT
 * ---------------------------------------------------------------------------
 * The row states have been redrawn three times, and each time the failure was
 * the same shape: hover and selection drawn as two unrelated colours (a warm
 * grey and a clay tint), with a decoration — an accent bar — doing the work
 * the fill could not. It is also the failure that comes back first, because
 * "give hover its own colour" and "add a marker so the selection pops" are
 * the obvious things to reach for.
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

/** The five row states, weakest first. */
const RAMP = [
  '--bg-row-hover',
  '--bg-row-selected-quiet',
  '--bg-row-selected-quiet-hover',
  '--bg-row-selected',
  '--bg-row-selected-hover',
];

/** The value a token is given inside one theme block. */
function valueIn(selector: string, token: string): string {
  const start = TOKENS.indexOf(`${selector} {`);
  const block = TOKENS.slice(start, TOKENS.indexOf('\n}', start));
  const match = block.match(new RegExp(`\\n\\s*${token}:\\s*([^;]+);`));
  if (!match?.[1]) throw new Error(`${token} is not defined under ${selector}`);
  return match[1].trim();
}

describe('a selected row is one highlight, not a marker', () => {
  it('draws no accent bar', () => {
    // The owner's ruling: the fill already says "selected", so a bar at the
    // row's leading edge is a second signal for the same state.
    expect(ROW_CSS).not.toMatch(/background:\s*var\(--accent\)/);
    expect(ROW_CSS).not.toMatch(/\.selected::before\s*\{[^}]*width:\s*3px/);
  });

  it('draws every state on the same inset highlight', () => {
    expect(ROW_CSS).toMatch(/\.row::before\s*\{[^}]*inset:/);
    expect(ROW_CSS).toMatch(/\.interactive:hover::before\s*\{[^}]*var\(--bg-row-hover\)/);
    expect(ROW_CSS).toMatch(/\.selected::before\s*\{[^}]*var\(--bg-row-selected-quiet\)/);
    expect(ROW_CSS).toMatch(/\.selected\.list-focused::before\s*\{[^}]*var\(--bg-row-selected\)/);
  });

  it('lets hover deepen a selected row, focused or not', () => {
    // A focused selection used to swallow hover entirely: its rule named
    // `:hover` itself and repainted the same fill.
    expect(ROW_CSS).toMatch(/\.selected:hover::before\s*\{[^}]*var\(--bg-row-selected-quiet-hover\)/);
    expect(ROW_CSS).toMatch(
      /\.selected\.list-focused:hover::before\s*\{[^}]*var\(--bg-row-selected-hover\)/,
    );
  });

  it('draws hover and selection from one family, in rising strength', () => {
    /*
     * The specific regression: a hover in one colour and a selection in
     * another. Every step must be the same ink at a higher alpha than the step
     * before it, so hover can never be mistaken for a selection and the
     * keyboard-focused selection is always the strongest.
     */
    for (const selector of ["[data-theme='workspace']", ":root,\n[data-theme='studio']"]) {
      const steps = RAMP.map((token) => {
        const match = valueIn(selector, token).match(
          /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/,
        );
        expect(match, `${token} under ${selector} is one rgba ink`).not.toBeNull();
        return { ink: match!.slice(1, 4).join(','), alpha: Number(match![4]) };
      });
      expect(new Set(steps.map((step) => step.ink)).size, `one ink under ${selector}`).toBe(1);
      for (let i = 1; i < steps.length; i += 1) {
        expect(steps[i]!.alpha, `${RAMP[i]} is stronger than ${RAMP[i - 1]}`).toBeGreaterThan(
          steps[i - 1]!.alpha,
        );
      }
    }
  });

  it('uses no retired or neutral surface fill for a row state', () => {
    const banned = ['--bg-row-selected-inactive', '--bg-hover-surface', '--bg-hover-chrome', '--accent-wash'];
    const fills = ROW_CSS.split('\n').filter((line) => /background/.test(line));
    for (const token of banned) {
      expect(
        fills.some((line) => line.includes(token)),
        `${token} is not part of the row ramp`,
      ).toBe(false);
    }
  });

  it('puts the keyboard edge on the highlight, not around the row', () => {
    expect(ROW_CSS).toMatch(/\.row:focus-visible\s*\{[^}]*outline:\s*none/);
    expect(ROW_CSS).toMatch(/\.row:focus-visible::before\s*\{[^}]*var\(--focus-quiet\)/);
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
