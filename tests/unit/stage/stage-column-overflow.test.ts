/**
 * #281 — nothing on the glass may run past the stage column.
 *
 * The script layer clips (`overflow: hidden`), so a run wider than the column
 * — a cue chip held to one line, a URL, a long compound word — lost its end
 * without a trace, on the left under a mirror. Two declarations carry the fix:
 * the column breaks a run that has no ordinary break left, and the cue chip
 * wraps like the line it sits in, with its decoration repeated on every row.
 *
 * Asserted against the stylesheets because that is where the rule lives and
 * jsdom has no layout to show it. The rendered proof is
 * `tests/e2e/browser/stage-column-overflow.spec.ts`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function styles(relative: string): string {
  const text = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
  return text.slice(text.indexOf('<style>')).replace(/\/\*[\s\S]*?\*\//g, '');
}

function ruleBody(sheet: string, selector: string): string {
  const at = sheet.indexOf(`${selector} {`);
  expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
  return sheet.slice(sheet.indexOf('{', at) + 1, sheet.indexOf('}', at));
}

const ScriptLayer = styles('../../../src/stage/renderer/ScriptLayer.svelte');
const InlineNodes = styles('../../../src/stage/renderer/InlineNodes.svelte');

describe('the stage column contains what it draws', () => {
  it('breaks a run wider than the column rather than clipping it', () => {
    // `anywhere`, not `break-word`: it also lowers the run's min-content width,
    // so a shrink-to-fit box inside the column (a take marker, a table cell)
    // stops sizing itself to the unbroken word. Not `word-break: break-all`,
    // which would break ordinary prose mid-word before using a space.
    expect(ruleBody(ScriptLayer, '.column')).toMatch(/overflow-wrap:\s*anywhere;/);
  });

  it('lets a cue chip wrap, with every row drawn as a chip', () => {
    const cue = ruleBody(InlineNodes, '.cue');
    expect(cue).not.toMatch(/white-space:\s*nowrap/);
    // WebKit — the engine that ships — still needs the prefix.
    expect(cue).toMatch(/-webkit-box-decoration-break:\s*clone;/);
    expect(cue).toMatch(/(^|[^-])box-decoration-break:\s*clone;/);
  });
});
