/**
 * What the syntax reference page does with its entries that is not data:
 * finding them, and setting their examples and prose (#305).
 *
 * Nothing here decides what a construct MEANS. Which characters are syntax is
 * a reading aid, drawn from the same shapes the compiler accepts, and every
 * fact the page states still comes from `syntax-reference.ts`. A run here only
 * ever changes how a character looks, never which characters are shown: the
 * runs of an example concatenate back to it exactly.
 */
import type {
  SyntaxEntry,
  SyntaxGroup,
  SyntaxOutcome,
} from '../../shared/markdown/syntax-reference';

/** One way to write an entry's construct: its example, or a case it names as a variant. */
export interface ExampleForm {
  /** The name the page offers it under; the example's is the entry's `form`. */
  label: string;
  source: string;
  /** The words following listens for, as asserted. */
  spoken: readonly string[] | undefined;
  options: SyntaxOutcome['options'];
}

/** The example first, then each variant case, in the table's order. */
export function exampleForms(entry: SyntaxEntry): ExampleForm[] {
  return [
    {
      label: entry.form ?? 'Example',
      source: entry.example,
      spoken: entry.expect.spoken,
      options: entry.expect.options,
    },
    ...(entry.cases ?? []).flatMap((c) =>
      c.variant === undefined
        ? []
        : [{ label: c.variant, source: c.source, spoken: c.spoken, options: c.options }],
    ),
  ];
}

/** A stretch of an example: the characters that make the construct, or the writer's own words. */
export interface ExampleRun {
  text: string;
  syntax: boolean;
}

/** One line of an example, as runs. A blank line has none. */
export type ExampleLine = ExampleRun[];

/*
 * Inline shapes, tried left to right at each position. Each alternative's
 * groups alternate syntax / words, starting with syntax.
 *
 *   \[Pause]            escape: the backslash is syntax, the brackets are words
 *   [Cue: label]        named directive
 *   [Beat]              shorthand cue
 *   word{say="…"}       spoken form
 *   ![alt](path)        image, and [text](address) link
 *   **bold** *italic*   emphasis markers
 *   `code`              inline code markers
 */
const INLINE =
  /(\\)(\[[^\]\n]*\])|(\[(?:cue|take)\s*:)([^\]\n]*)(\])|(\[(?:pause|beat|breathe)\])|(\{say=")([^"\n]*)("\})|(!?\[)([^\]\n]*)(\]\()([^)\n]*)(\))|(\*\*?)|(`)/giu;

function inlineRuns(text: string): ExampleRun[] {
  const runs: ExampleRun[] = [];
  const push = (part: string, syntax: boolean): void => {
    if (part === '') return;
    const last = runs.at(-1);
    if (last && last.syntax === syntax) last.text += part;
    else runs.push({ text: part, syntax });
  };
  let at = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? at;
    push(text.slice(at, start), false);
    // The groups that took part, in order, alternate syntax and words.
    const parts = match.slice(1).filter((part): part is string => part !== undefined);
    parts.forEach((part, i) => push(part, i % 2 === 0));
    at = start + match[0].length;
  }
  push(text.slice(at), false);
  return runs;
}

/**
 * An example as lines of runs, for display. Fence lines (`:::name`, a code
 * fence) are syntax whole; inside a code fence nothing else is marked, because
 * what is there is the writer's code.
 */
export function exampleLines(example: string): ExampleLine[] {
  let inCode = false;
  return example.split('\n').map((line): ExampleLine => {
    if (line === '') return [];
    if (/^```/.test(line)) {
      inCode = !inCode;
      return [{ text: line, syntax: true }];
    }
    if (inCode) return [{ text: line, syntax: false }];
    if (/^:::[\w-]*\s*$/.test(line)) return [{ text: line, syntax: true }];
    // A table row: the pipes are syntax, and a delimiter row is syntax whole.
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (/^[\s|:-]+$/.test(line)) return [{ text: line, syntax: true }];
      return line.split(/(\|)/).flatMap((part) => (part === '' ? [] : [{ text: part, syntax: part === '|' }]));
    }
    const lead = /^(#{1,6} |\s*[-*+] |> |(?:visual|say):)/i.exec(line);
    if (lead) return [{ text: lead[0], syntax: true }, ...inlineRuns(line.slice(lead[0].length))];
    return inlineRuns(line);
  });
}

/** Prose with its syntax in backticks, as plain runs and code runs. */
export function proseRuns(text: string): Array<{ text: string; code: boolean }> {
  return text
    .split('`')
    .map((part, i) => ({ text: part, code: i % 2 === 1 }))
    .filter((run) => run.text !== '');
}

/** Typographic quotes typed or pasted into the field mean the straight ones in a script. */
function normalizeQuery(text: string): string {
  return text.toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
}

/** Everything a search can match for one entry: its words, its syntax, and what it is for. */
function searchableText(group: SyntaxGroup, entry: SyntaxEntry): string {
  return normalizeQuery(
    [
      group.title,
      group.note ?? '',
      entry.title,
      entry.example,
      entry.glass,
      entry.following,
      ...(entry.notes ?? []),
      ...(entry.keywords ?? []),
      // A case's source too, so `:::silent` also finds the rule about closing it.
      ...(entry.cases ?? []).flatMap((c) => [c.source, c.variant ?? '', c.problem ?? '']),
    ].join('\n'),
  );
}

/**
 * Which of an entry's forms a search is asking for: the first variant whose
 * name and source hold every word of it, else the example. "italic" finds the
 * entry by its keywords and should then show the italic form, not the list.
 */
export function formForQuery(entry: SyntaxEntry, query: string): number {
  const terms = normalizeQuery(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 0;
  const forms = exampleForms(entry);
  for (let i = 1; i < forms.length; i += 1) {
    const text = normalizeQuery(`${forms[i]!.label}\n${forms[i]!.source}`);
    if (terms.every((term) => text.includes(term))) return i;
  }
  return 0;
}

/**
 * The groups with only the entries that match every word of the query, empty
 * groups left out. Punctuation is kept, so `:::` and `{say` find what they
 * spell. An empty query matches everything.
 */
export function filterReference(groups: readonly SyntaxGroup[], query: string): SyntaxGroup[] {
  const terms = normalizeQuery(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return groups.slice();
  return groups.flatMap((group) => {
    const entries = group.entries.filter((entry) => {
      const text = searchableText(group, entry);
      return terms.every((term) => text.includes(term));
    });
    return entries.length === 0 ? [] : [{ ...group, entries }];
  });
}
