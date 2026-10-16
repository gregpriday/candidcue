/**
 * §21.8 — the Library's word counts are the compiler's word counts.
 *
 * The Library's preview, word count and speaking time are derived in Rust
 * (`src-tauri/src/scripts/words.rs`), because they are needed on paths with no
 * renderer in the loop: import, duplicate, an edit made outside the app, and
 * startup reconciliation. The editor's numbers come from this compiler. The two
 * used to disagree on any script with a cue, a comment, an alias, a list or a
 * `:::spoken` block, because the Rust side was a Markdown-to-text approximation.
 *
 * `tests/fixtures/markdown/spoken-counts.json` is the contract between them.
 * This half proves every expectation in it is what `compile()` really produces;
 * `words.rs::tests::matches_the_compiler_on_the_shared_fixture` proves the Rust
 * extraction produces the same words, in the same order. If either side changes
 * its mind about what is spoken, one of the two fails.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compile } from '../../../src/shared/markdown';

interface SpokenCountCase {
  name: string;
  source?: string;
  file?: string;
  options?: {
    readHeadings?: boolean;
    readImageAltText?: boolean;
    readInlineCode?: boolean;
    wordsPerMinute?: number;
  };
  words: number;
  durationSeconds: number;
  tokens: string[];
  plain?: string;
}

const fixtureDir = new URL('../../fixtures/markdown/', import.meta.url);
const cases = JSON.parse(
  readFileSync(fileURLToPath(new URL('spoken-counts.json', fixtureDir)), 'utf8'),
) as SpokenCountCase[];

function sourceOf(c: SpokenCountCase): string {
  return c.file ? readFileSync(fileURLToPath(new URL(c.file, fixtureDir)), 'utf8') : c.source!;
}

describe('spoken-counts fixture: the compiler side of the Library contract', () => {
  it('has cases to hold the Rust extraction to', () => {
    expect(cases.length).toBeGreaterThan(50);
  });

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const compiled = compile(sourceOf(c), { scriptId: 'spoken-counts', ...(c.options ?? {}) });
    expect(compiled.spokenTokens.map((t) => t.surface)).toEqual(c.tokens);
    expect(compiled.statistics.spokenWordCount).toBe(c.words);
    expect(compiled.statistics.estimatedDurationSeconds).toBe(c.durationSeconds);
  });

  it('pins the counts from issue #249', () => {
    const byName = new Map(cases.map((c) => [c.name, c.words]));
    expect(byName.get('issue: cue and pause labels are not words')).toBe(10);
    expect(byName.get('issue: take marker is not a word')).toBe(3);
    expect(byName.get('issue: say alias speaks its spoken form')).toBe(6);
    expect(byName.get('issue: an author note in a comment is not speech')).toBe(3);
    expect(byName.get('issue: a :::spoken block speaks its say line')).toBe(4);
    expect(byName.get('issue: ordered-list numbers are not words')).toBe(6);
    expect(byName.get('issue: a setext underline is not a word')).toBe(3);
  });
});
