/**
 * The syntax reference, held to the compiler it describes (#305).
 *
 * Two kinds of check. The first compiles every example and every case with the
 * real `compile()`, as the app does, and compares what came out with what the
 * entry says comes out. The second is coverage: the compiler's own inventories
 * — its containers, its shorthand cues, its take-time labels, the diagnostics it
 * can raise — must each be accounted for here, so the dialect cannot grow a
 * construct that the reference silently leaves out.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CompiledScript, SafeRenderNode } from '../contracts';
import { compile } from './compile';
import { KNOWN_CONTAINERS, SHORTHAND_CUES } from './directives';
import { PERFORMANCE_CUE_LABELS, performanceCueKind, projectForPerformance } from '../performance-view';
import {
  READ_HEADINGS_SETTING,
  SYNTAX_REFERENCE,
  syntaxEntries,
  type SyntaxCase,
  type SyntaxEntry,
  type SyntaxOutcome,
} from './syntax-reference';

const readRepoFile = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8');

function visibleText(nodes: readonly SafeRenderNode[]): string {
  let out = '';
  for (const node of nodes) {
    if (node.type === 'text') out += node.text;
    else if (node.type === 'line_break') out += ' ';
    else if (node.type === 'link') out += visibleText(node.label);
    else if (node.type === 'table') {
      for (const row of node.rows) for (const cell of row) out += ` ${visibleText(cell)} `;
    }
  }
  return out;
}

/** The fields of `outcome` that were given, read off the compiled script. */
function observe(script: CompiledScript, outcome: SyntaxOutcome): SyntaxOutcome {
  const seen: SyntaxOutcome = {};
  if (outcome.spoken) seen.spoken = script.spokenTokens.map((token) => token.normalized);
  if (outcome.shown !== undefined) {
    seen.shown = script.blocks
      .map((block) => visibleText(block.renderNodes))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  if (outcome.cues) {
    seen.cues = script.cues.map((cue) => ({ cueType: cue.cueType, label: cue.label }));
  }
  if (outcome.diagnostics) seen.diagnostics = script.diagnostics.map((d) => d.code);
  if (outcome.blocking !== undefined) seen.blocking = script.diagnostics.some((d) => d.blocking);
  if (outcome.blockKinds) seen.blockKinds = script.blocks.map((block) => block.kind);
  if (outcome.parts) seen.parts = (script.parts ?? []).map((part) => part.label);
  if (outcome.takeCues) {
    seen.takeCues = projectForPerformance(script.blocks, 'take').flatMap((block) => {
      const kind = performanceCueKind(block);
      return kind === null ? [] : [PERFORMANCE_CUE_LABELS[kind]];
    });
  }
  return seen;
}

const OUTCOME_FIELDS = [
  'spoken',
  'shown',
  'cues',
  'diagnostics',
  'blocking',
  'blockKinds',
  'parts',
  'takeCues',
] as const satisfies readonly (keyof SyntaxOutcome)[];

/** The asserted fields alone — not the options, and not a case's name or source. */
function expected(outcome: SyntaxOutcome): SyntaxOutcome {
  const fields: Record<string, unknown> = {};
  for (const key of OUTCOME_FIELDS) if (outcome[key] !== undefined) fields[key] = outcome[key];
  return fields as SyntaxOutcome;
}

function compileAsTheAppDoes(source: string, outcome: SyntaxOutcome): CompiledScript {
  // No wake phrases: the app passes none, so the defaults are what users get.
  return compile(source, { scriptId: 'syntax-reference', ...outcome.options });
}

describe('every example compiles to what the reference says', () => {
  const examples = syntaxEntries().map((entry): [string, SyntaxEntry] => [entry.id, entry]);
  it.each(examples)('%s', (_id, entry) => {
    const script = compileAsTheAppDoes(entry.example, entry.expect);
    expect(observe(script, entry.expect)).toEqual(expected(entry.expect));
  });

  const cases = syntaxEntries().flatMap((entry) =>
    (entry.cases ?? []).map((c): [string, SyntaxCase] => [`${entry.id}: ${c.what}`, c]),
  );
  it.each(cases)('%s', (_name, c) => {
    const script = compileAsTheAppDoes(c.source, c);
    expect(observe(script, c)).toEqual(expected(c));
  });
});

describe('the reference is complete', () => {
  const entries = syntaxEntries();
  const outcomes = entries.flatMap((entry) => [entry.expect, ...(entry.cases ?? [])]);

  it('documents every container the scanner recognises', () => {
    for (const name of KNOWN_CONTAINERS) {
      const fence = new RegExp(`^:::${name}$`, 'm');
      expect(
        entries.some((entry) => fence.test(entry.example)),
        `:::${name} has no example`,
      ).toBe(true);
    }
  });

  it('documents every shorthand cue', () => {
    const shown = new Set(outcomes.flatMap((o) => o.cues ?? []).map((cue) => cue.cueType));
    for (const cueType of Object.values(SHORTHAND_CUES)) {
      expect(shown.has(cueType), `[${cueType}] has no example`).toBe(true);
    }
  });

  it('documents every one-line cue a take draws in place of media', () => {
    const shown = new Set(entries.flatMap((entry) => entry.expect.takeCues ?? []));
    for (const label of Object.values(PERFORMANCE_CUE_LABELS)) {
      expect(shown.has(label), `${label} has no example`).toBe(true);
    }
  });

  /**
   * Every diagnostic the compiler can raise is either proved by a case here —
   * so the reference has told the reader what causes it — or named below with
   * the reason it is not script syntax. Read from the compiler's source, so a
   * new code fails this until somebody decides which it is.
   */
  const NOT_SYNTAX: Record<string, string> = {
    block_id_ambiguous: 'an internal identity collision, not something an author writes',
    raw_html_blocked: 'HTML is not part of the script dialect; it is shown as plain text',
    unsafe_url_blocked: 'a link-safety rule rather than a construct',
    unsupported_syntax: 'the fallback for Markdown the compiler does not render',
  };

  it('accounts for every diagnostic the compiler can raise', () => {
    const raised = new Set<string>();
    for (const file of ['compile.ts', 'directives.ts', 'parts.ts']) {
      const source = readRepoFile(`src/shared/markdown/${file}`);
      for (const match of source.matchAll(/\bcode: '([a-z_]+)'/g)) raised.add(match[1]!);
    }
    expect(raised.size).toBeGreaterThan(0);

    const documented = new Set(outcomes.flatMap((o) => o.diagnostics ?? []));
    for (const code of Object.keys(NOT_SYNTAX)) {
      expect(raised.has(code), `${code} is excluded but no longer raised`).toBe(true);
      expect(documented.has(code), `${code} is both documented and excluded`).toBe(false);
    }
    for (const code of raised) {
      if (code in NOT_SYNTAX) continue;
      expect(documented.has(code), `${code} is raised but not documented`).toBe(true);
    }
    for (const code of documented) {
      expect(raised.has(code), `${code} is documented but never raised`).toBe(true);
    }
  });

  it('names the heading setting as the Settings window does', () => {
    const settings = readRepoFile('src/control/routes/Settings.svelte');
    expect(settings).toContain(`label: '${READ_HEADINGS_SETTING.section}'`);
    const general = settings.slice(
      settings.indexOf("{#if section === 'general'}"),
      settings.indexOf('{:else if section', settings.indexOf("{#if section === 'general'}")),
    );
    expect(general).toContain(`label="${READ_HEADINGS_SETTING.label}"`);
  });

  it('has unique ids and says something about every entry', () => {
    const ids = [...SYNTAX_REFERENCE.map((group) => group.id), ...entries.map((entry) => entry.id)];
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of entries) {
      expect(entry.example.trim(), entry.id).not.toBe('');
      expect(entry.glass.trim(), entry.id).not.toBe('');
      expect(entry.following.trim(), entry.id).not.toBe('');
      expect(Object.keys(expected(entry.expect)).length, entry.id).toBeGreaterThan(0);
    }
  });

  it('does not document the retired coaching syntax', () => {
    const text = JSON.stringify(SYNTAX_REFERENCE);
    expect(text).not.toMatch(/coach/i);
    expect(text).not.toMatch(/<!--/);
    expect(text).not.toMatch(/\bcc:/i);
  });
});
