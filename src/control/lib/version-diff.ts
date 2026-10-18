/**
 * Where two versions of a script differ, for the external-change sheet.
 *
 * The sheet used to ask the author to choose between two versions it never
 * showed. This finds the paragraphs that differ and marks, inside each, the
 * words only that version has — enough to recognise which text is which
 * without leaving the sheet. It is not a merge tool: it reports differences,
 * it never combines them.
 *
 * Three passes, each over less than the last:
 *
 *   1. paragraphs, exactly: the runs where the two versions stop agreeing;
 *   2. paragraphs inside each run, by likeness: which rewritten paragraph is
 *      which, so a reworded one sits beside its original and an added one
 *      stands alone instead of being read as part of its neighbour;
 *   3. words inside each pair: what to mark.
 *
 * Each pass gives up gracefully past a size budget — a run is then shown as
 * changed throughout, which is still true, just less precise.
 */

export interface PassageSegment {
  text: string;
  /** Words this version has and the other does not. */
  changed: boolean;
}

export interface Passage {
  segments: PassageSegment[];
  /** Words were trimmed before the first segment. */
  clippedStart: boolean;
  /** Words were trimmed after the last segment. */
  clippedEnd: boolean;
}

export interface VersionDifference {
  /**
   * The heading each version's paragraph sits under, nearest above it. They
   * differ when a heading was renamed: each side is under its own.
   */
  diskSection: string | null;
  editorSection: string | null;
  /** `null`: this version has nothing at this place. */
  disk: Passage | null;
  editor: Passage | null;
  /** The same words in the same order; only spacing or line breaks differ. */
  spacingOnly: boolean;
}

export interface VersionComparison {
  /** The same title and byte-for-byte the same text. */
  identical: boolean;
  /** The first `limit` differences, in document order. */
  differences: VersionDifference[];
  /** Every place that differs, including those past `limit`. */
  total: number;
  /** Some shown passage was trimmed to the sentences around its changes. */
  trimmed: boolean;
}

export interface ScriptVersion {
  title: string;
  source: string;
}

/** A passage with no marks of its own shows at least this many words of its opening. */
const CONTEXT_WORDS = 6;
/** Past this many words a preview stops at the next sentence end. */
const MAX_PASSAGE_WORDS = 72;
/** Cell budgets for the comparisons (rows × columns of each table). */
const BLOCK_BUDGET = 1_000_000;
const PAIRING_BUDGET = 4_000;
const WORD_BUDGET = 250_000;
/** How alike two paragraphs must be to count as one paragraph, reworded. */
const LIKENESS = 0.3;

function blocks(source: string): string[] {
  return source
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((b) => b.trim())
    .filter((b) => b !== '');
}

function isHeading(block: string): boolean {
  return /^#{1,6}\s/.test(block);
}

/** A heading's words, without its `#` marks. */
function headingText(block: string): string | null {
  const match = /^#{1,6}\s+(.+)$/m.exec(block);
  return match && isHeading(block) ? match[1]!.trim() : null;
}

/** The heading a block sits under: the nearest one above it, or itself. */
function sectionAt(all: string[], index: number): string | null {
  for (let k = index; k >= 0; k -= 1) {
    const heading = headingText(all[k]!);
    if (heading) return heading;
  }
  return null;
}

/**
 * The longest common subsequence of `a` and `b`, as matched index pairs.
 * `null` when the table would exceed `budget` cells.
 */
function lcs<T>(a: T[], b: T[], budget: number): Array<[number, number]> | null {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];
  if (n * m > budget) return null;
  const table = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[at(i, j)] =
        a[i] === b[j]
          ? table[at(i + 1, j + 1)]! + 1
          : Math.max(table[at(i + 1, j)]!, table[at(i, j + 1)]!);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[at(i + 1, j)]! >= table[at(i, j + 1)]!) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

/** A changed run: block index ranges in each version. */
interface Run {
  diskFrom: number;
  diskTo: number;
  editorFrom: number;
  editorTo: number;
}

function runs(disk: string[], editor: string[]): Run[] {
  // Common prefix and suffix first: most conflicts touch a paragraph or two of
  // a long script, and trimming them keeps the table small.
  let head = 0;
  while (head < disk.length && head < editor.length && disk[head] === editor[head]) head += 1;
  let tail = 0;
  while (
    tail < disk.length - head &&
    tail < editor.length - head &&
    disk[disk.length - 1 - tail] === editor[editor.length - 1 - tail]
  ) {
    tail += 1;
  }
  const a = disk.slice(head, disk.length - tail);
  const b = editor.slice(head, editor.length - tail);
  if (a.length === 0 && b.length === 0) return [];

  const pairs = lcs(a, b, BLOCK_BUDGET) ?? [];
  const out: Run[] = [];
  let i = 0;
  let j = 0;
  for (const [pi, pj] of [...pairs, [a.length, b.length] as [number, number]]) {
    if (pi > i || pj > j) {
      out.push({ diskFrom: head + i, diskTo: head + pi, editorFrom: head + j, editorTo: head + pj });
    }
    i = pi + 1;
    j = pj + 1;
  }
  return out;
}

function wordSet(block: string): Set<string> {
  return new Set(
    block
      .toLowerCase()
      .split(/[^\p{L}\p{N}']+/u)
      .filter((w) => w !== ''),
  );
}

/** Dice's coefficient over the two paragraphs' words. */
function likeness(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

/**
 * Pair the paragraphs of one changed run, in order, by likeness.
 *
 * A heading pairs only with a heading. What is left unpaired is a paragraph
 * one version has and the other does not.
 */
function pairUp(a: string[], b: string[]): Array<[number | null, number | null]> {
  const n = a.length;
  const m = b.length;
  if (n * m > PAIRING_BUDGET) {
    return Array.from({ length: Math.max(n, m) }, (_, k) => [k < n ? k : null, k < m ? k : null]);
  }
  const wa = a.map(wordSet);
  const wb = b.map(wordSet);
  const score = (i: number, j: number): number => {
    if (isHeading(a[i]!) !== isHeading(b[j]!)) return 0;
    const s = likeness(wa[i]!, wb[j]!);
    return s >= LIKENESS ? s : 0;
  };
  const best = new Float64Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const s = score(i, j);
      best[at(i, j)] = Math.max(
        best[at(i + 1, j)]!,
        best[at(i, j + 1)]!,
        s > 0 ? s + best[at(i + 1, j + 1)]! : 0,
      );
    }
  }
  const out: Array<[number | null, number | null]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const s = score(i, j);
    if (s > 0 && best[at(i, j)] === s + best[at(i + 1, j + 1)]!) {
      out.push([i, j]);
      i += 1;
      j += 1;
    } else if (best[at(i + 1, j)]! >= best[at(i, j + 1)]!) {
      out.push([i, null]);
      i += 1;
    } else {
      out.push([null, j]);
      j += 1;
    }
  }
  for (; i < n; i += 1) out.push([i, null]);
  for (; j < m; j += 1) out.push([null, j]);
  return out;
}

/** A line break inside a paragraph: kept as a token, because it is part of the text. */
const BREAK = '\n';

/**
 * A paragraph's words, with each line break as a token of its own.
 *
 * Splitting on all whitespace made a paragraph broken across two lines and the
 * same words on one line compare equal word for word: a difference the sheet
 * reported and then could not show.
 */
function words(text: string): string[] {
  const out: string[] = [];
  text.split('\n').forEach((line, index) => {
    if (index > 0) out.push(BREAK);
    for (const word of line.split(/[ \t]+/)) if (word !== '') out.push(word);
  });
  return out;
}

/**
 * Which of `own`'s words the other side lacks.
 *
 * Exactly those, and no tidying: absorbing a shared word between two marks
 * ("all [for] coming") read more smoothly, but it marked "for" on one side and
 * not the other, which says the word differs when it does not.
 */
function changedFlags(own: string[], other: string[]): boolean[] {
  const pairs = lcs(own, other, WORD_BUDGET);
  const flags = new Array<boolean>(own.length).fill(true);
  if (pairs === null) return flags;
  for (const [i] of pairs) flags[i] = false;
  return flags;
}

const ENDS_SENTENCE = /[.!?…]["”’)\]]*$/;

function endsSentence(token: string): boolean {
  return token === BREAK || ENDS_SENTENCE.test(token);
}

/** Widen [start, end) to the whole sentences it touches. */
function toSentences(own: string[], start: number, end: number): [number, number] {
  let s = start;
  while (s > 0 && !endsSentence(own[s - 1]!)) s -= 1;
  let e = Math.max(end, s + 1);
  while (e < own.length && !endsSentence(own[e - 1]!)) e += 1;
  return [s, e];
}

/**
 * The sentences that changed, whole.
 *
 * A preview is cut only where a sentence ends: the scope line promises the
 * changed sentences, and a cut through one would show half of what changed.
 * An unusually long run is still cut — at the first sentence end past the
 * budget — and the rows scroll to hold whatever that leaves.
 */
function passage(own: string[], flags: boolean[], full: boolean): Passage {
  if (full) return { segments: segmentsOf(own, flags, 0, own.length), clippedStart: false, clippedEnd: false };
  const first = flags.indexOf(true);
  const last = flags.lastIndexOf(true);
  /*
   * A change that opens with a break belongs to the line the break ends. A
   * line added under "Hello and welcome." starts with the break after it, and
   * starting the preview at that break hid the sentence the new line follows,
   * leaving "… ↵ colliding edit" with nothing to say where it went.
   */
  const from = first > 0 && own[first] === BREAK ? first - 1 : first;
  // Nothing of its own (the other side added to it): its opening sentences.
  let [start, end] = first === -1 ? toSentences(own, 0, 1) : toSentences(own, from, last + 1);
  if (first === -1) {
    while (end < own.length && end - start < CONTEXT_WORDS * 2) [, end] = toSentences(own, end, end + 1);
  }
  // A break only this version has ends a line, not the change: show what it breaks before.
  while (end < own.length && own[end - 1] === BREAK && flags[end - 1]) {
    [, end] = toSentences(own, end, end + 1);
  }
  if (end - start > MAX_PASSAGE_WORDS) {
    let cut = start + MAX_PASSAGE_WORDS;
    while (cut < end && !endsSentence(own[cut - 1]!)) cut += 1;
    end = cut;
  }
  // A break at either edge is the edge of a line, not text.
  while (end > start && own[end - 1] === BREAK && !flags[end - 1]) end -= 1;
  return { segments: segmentsOf(own, flags, start, end), clippedStart: start > 0, clippedEnd: end < own.length };
}

function segmentsOf(own: string[], flags: boolean[], start: number, end: number): PassageSegment[] {
  const segments: PassageSegment[] = [];
  for (let k = start; k < end; k += 1) {
    const token = own[k]!;
    const changed = flags[k]!;
    const isBreak = token === BREAK;
    // A break only this version has is drawn, or the mark would be empty.
    const text = isBreak ? (changed ? '↵\n' : '\n') : token;
    const gap = k === start || isBreak || own[k - 1] === BREAK ? '' : ' ';
    const previous = segments[segments.length - 1];
    if (previous && previous.changed === changed) previous.text += gap + text;
    else if (previous) {
      // The space between two runs belongs to the plain text, never to a mark.
      if (changed) previous.text += gap;
      segments.push({ text: changed ? text : gap + text, changed });
    } else segments.push({ text, changed });
  }
  return segments;
}

interface Described {
  disk: Passage | null;
  editor: Passage | null;
  /** The same words in the same order: only spacing tells them apart. */
  spacingOnly: boolean;
}

function describe(a: string | null, b: string | null, full: boolean): Described {
  const wa = a === null ? [] : words(a);
  const wb = b === null ? [] : words(b);
  return {
    disk: wa.length === 0 ? null : passage(wa, changedFlags(wa, wb), full),
    editor: wb.length === 0 ? null : passage(wb, changedFlags(wb, wa), full),
    spacingOnly: wa.length > 0 && wa.length === wb.length && wa.every((w, k) => w === wb[k]),
  };
}

export interface CompareOptions {
  /** How many differences to describe. */
  limit?: number;
  /** Whole paragraphs, untrimmed. */
  full?: boolean;
}

/**
 * Compare the file's version (`disk`) with the editor's (`editor`).
 *
 * The title counts: a rename that lost the race to the external change is
 * unsaved work as well, and the disk arm files a copy for it.
 *
 * `limit` caps how many differences are described; `total` still counts them
 * all, so the sheet can say how many more there are. `full` keeps every
 * paragraph whole rather than trimming it to the sentences that changed.
 */
export function compareVersions(
  disk: ScriptVersion,
  editor: ScriptVersion,
  { limit = 4, full = false }: CompareOptions = {},
): VersionComparison {
  if (disk.source === editor.source && disk.title === editor.title) {
    return { identical: true, differences: [], total: 0, trimmed: false };
  }
  const all: Array<() => VersionDifference> = [];
  if (disk.title !== editor.title) {
    all.push(() => ({
      diskSection: 'Title',
      editorSection: 'Title',
      ...describe(disk.title, editor.title, full),
    }));
  }
  const diskBlocks = blocks(disk.source);
  const editorBlocks = blocks(editor.source);
  for (const run of runs(diskBlocks, editorBlocks)) {
    const a = diskBlocks.slice(run.diskFrom, run.diskTo);
    const b = editorBlocks.slice(run.editorFrom, run.editorTo);
    // Where each side has got to, so a paragraph one version lacks is still
    // placed under that version's heading at the same point.
    let diskAt = run.diskFrom - 1;
    let editorAt = run.editorFrom - 1;
    for (const [i, j] of pairUp(a, b)) {
      if (i !== null) diskAt = run.diskFrom + i;
      if (j !== null) editorAt = run.editorFrom + j;
      const diskSection = sectionAt(diskBlocks, diskAt);
      const editorSection = sectionAt(editorBlocks, editorAt);
      all.push(() => ({
        diskSection,
        editorSection,
        ...describe(i === null ? null : a[i]!, j === null ? null : b[j]!, full),
      }));
    }
  }
  // Described lazily: only the rows that are shown pay for a word comparison.
  const differences = all.slice(0, limit).map((row) => row());
  const clipped = (p: Passage | null) => p !== null && (p.clippedStart || p.clippedEnd);
  return {
    identical: false,
    differences,
    total: all.length,
    trimmed: differences.some((d) => clipped(d.disk) || clipped(d.editor)),
  };
}
