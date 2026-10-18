/**
 * Where a take begins (CCUX-014, CCUX-015, CCUX-016, CCUX-008).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT JUST A NUMBER
 * ---------------------------------------------------------------------------
 * `startTake` recorded `startTokenIndex: 0` on every session, and the session
 * record has carried the field since it was written. A creator who fumbled a
 * line six minutes into a script had two options: read the first six minutes
 * again, or launch and then navigate while the stage was already live and the
 * camera was already rolling. For a course creator working section by section
 * that is the difference between a usable tool and an unusable one.
 *
 * The number itself is easy. What is not easy — and what this module owns — is
 * that an arbitrary token is a BAD place to start:
 *
 *  - a caret sitting in the middle of a sentence would open the stage
 *    mid-clause, and the presenter would have to guess where to start reading;
 *  - the aligner is given the start as an anchor, and an anchor inside a phrase
 *    gives it half a sentence of context to match against;
 *  - a token inside a cue, an image or any other non-spoken block is not a
 *    place a presenter can read from at all.
 *
 * So every start point is SNAPPED to a unit somebody can be handed: the
 * beginning of a sentence, a heading, or an authored take marker. Pure, so the
 * snapping is testable without a stage, a compile or a window.
 */
import type { CompiledBlock, OutlineNode, SafeRenderNode, SentenceUnit } from '../../shared/contracts';

/** Where a start point came from, which is what the UI has to explain. */
export type StartPointKind = 'beginning' | 'section' | 'sentence' | 'marker' | 'last_ending';

export interface StartPoint {
  /** The snapped token index. Always the first token of a readable unit. */
  tokenIndex: number;
  kind: StartPointKind;
  /** Human label — a heading, a marker name, or a truncated first phrase. */
  label: string;
  /**
   * For a sentence start, its opening words, quoted and as written — without
   * the section `label` appends. The Present menu sets these beside the part
   * the sentence is in, and the section name would be a second, competing
   * answer to "where is this?".
   */
  excerpt?: string;
}

/** The beginning, which is what every take used to get whether it wanted it or not. */
export function beginning(): StartPoint {
  return { tokenIndex: 0, kind: 'beginning', label: 'the beginning' };
}

export interface SnapInput {
  /** Sentences in document order. */
  sentences: SentenceUnit[];
  /** The outline, which may be nested. */
  outline: OutlineNode[];
  /** Total spoken tokens, so a start past the end can be refused. */
  totalTokens: number;
  /**
   * The compiled blocks, for quoting a sentence as it was written. Optional:
   * without them a sentence is quoted from its normalised text, which is
   * lower-cased and unpunctuated — readable, but not the words on the page.
   */
  blocks?: readonly CompiledBlock[];
}

/**
 * Flatten a nested outline into document order.
 *
 * Exported because the Present menu needs the same flattening to offer sections,
 * and two different walks of the same tree would eventually disagree about
 * which heading a token belongs to.
 */
export function flattenOutline(nodes: OutlineNode[]): OutlineNode[] {
  const out: OutlineNode[] = [];
  const walk = (list: OutlineNode[]): void => {
    for (const node of list) {
      out.push(node);
      if (node.children.length > 0) walk(node.children);
    }
  };
  walk(nodes);
  return out.sort((a, b) => a.startTokenIndex - b.startTokenIndex);
}

/**
 * Snap an arbitrary token to the start of the unit that contains it.
 *
 * Backwards, never forwards. A presenter who asked to start at a place has
 * asked to start AT it or just before it; snapping forward would silently skip
 * the very line they were pointing at, which is the one thing they were most
 * likely trying to include.
 *
 * Returns the beginning when nothing better can be found — a script with no
 * sentences at all, or a request past the end. Refusing would leave a caller
 * with nothing to launch, and the beginning is always a legal start.
 */
export function snapToStart(token: number, input: SnapInput): StartPoint {
  const { sentences, totalTokens } = input;
  if (!Number.isFinite(token) || token <= 0) return beginning();
  if (sentences.length === 0) return beginning();

  const target = Math.min(Math.floor(token), Math.max(0, totalTokens - 1));

  /*
   * WHICHEVER UNIT STARTS LATER IS THE ONE THE TARGET IS INSIDE.
   *
   * This is not the obvious rule, and the obvious one is wrong. An
   * `OutlineNode` does NOT span a heading's own words: `compile.ts` gives every
   * node the whole section beneath it, up to the next heading, and widens a
   * parent across its children. A script with no headings at all gets ONE
   * synthetic "Script" node spanning the entire document.
   *
   * So "is the target inside this heading's range" is true almost everywhere,
   * and using it collapsed every start point to the top of its section — or,
   * on a script without headings, to token zero, which silently turned the
   * whole feature off. Comparing STARTS instead asks the question that actually
   * distinguishes them: if the heading begins after the last sentence did, the
   * target is in the gap between the heading and its first body sentence, which
   * is exactly when the section is the right unit to open on.
   */
  const headings = flattenOutline(input.outline);
  const heading = lastAtOrBefore(headings, target, (n) => n.startTokenIndex);
  const sentence = lastAtOrBefore(sentences, target, (s) => s.startTokenIndex);

  if (
    heading !== null &&
    heading.title.trim() !== '' &&
    (sentence === null || heading.startTokenIndex > sentence.startTokenIndex)
  ) {
    return { tokenIndex: heading.startTokenIndex, kind: 'section', label: heading.title };
  }

  if (sentence === null) return beginning();

  // Starting at the first sentence of the document IS starting at the
  // beginning, and saying so is less confusing than quoting its first words
  // back at somebody who did not ask for a section.
  if (sentence.startTokenIndex === 0) return beginning();

  const excerpt = quoteSentence(sentence, input.blocks);
  return {
    tokenIndex: sentence.startTokenIndex,
    kind: 'sentence',
    label: describeSentence(sentence, headings, excerpt),
    excerpt,
  };
}

/**
 * The last element whose key is at or before `target`.
 *
 * Linear rather than binary: outlines are tens of entries and sentences are
 * hundreds, both traversed once per launch, and a binary search over a list
 * that must be sorted first would be a second correctness problem for no
 * measurable gain.
 */
function lastAtOrBefore<T>(items: T[], target: number, key: (item: T) => number): T | null {
  let best: T | null = null;
  for (const item of items) {
    if (key(item) <= target) best = item;
    else break;
  }
  return best;
}

/** A sentence named by its section when it has one, so the label locates it. */
function describeSentence(sentence: SentenceUnit, headings: OutlineNode[], phrase: string): string {
  const heading = lastAtOrBefore(headings, sentence.startTokenIndex, (n) => n.startTokenIndex);
  return heading === null ? phrase : `${phrase} in ${heading.title}`;
}

/** How many words of a sentence a quotation carries. */
const QUOTE_WORDS = 6;

/**
 * A sentence's opening words, quoted.
 *
 * From the compiled block when there is one, because that is the text the
 * presenter wrote and is about to read: `normalizedText` is the aligner's form
 * — lower-cased, unpunctuated, numbers spelled out — and quoting it back put
 * “this is section five which covers…” beside a line that reads "This is
 * section 5, which covers". The ellipsis is only for a sentence that was
 * actually cut; a short one is quoted whole.
 */
function quoteSentence(sentence: SentenceUnit, blocks: readonly CompiledBlock[] | undefined): string {
  const words = writtenWords(sentence, blocks) ?? sentence.normalizedText.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'this sentence';
  if (words.length <= QUOTE_WORDS) return `“${words.join(' ')}”`;
  const cut = words.slice(0, QUOTE_WORDS).join(' ').replace(/[\s,;:.!?—–-]+$/u, '');
  return `“${cut}…”`;
}

/**
 * The sentence's words as written, or null when the block cannot say.
 *
 * A text node's `wordTokens` anchors each whitespace-separated word to its
 * first spoken token, so a word belongs to the sentence when its anchor falls
 * inside the sentence's range. An unspoken word between two that are (an em
 * dash) is kept, so the quotation reads the way the line does.
 *
 * A link, a bold run or a code span ends one text node and starts another, and
 * the full stop after `[Ready](…)` is a node of its own: taken node by node it
 * became a separate "word", quoted as “Ready now .” and counted against the
 * six. So a piece with no whitespace before it joins the word before it — but
 * only when both belong to this sentence, or `[First.](…)Second` would weld
 * two sentences into one word.
 *
 * Unspoken words (inline code that is not read, a dash) are held until the
 * next spoken word shows whether they sit inside the sentence or after its
 * end; a run left over when the sentence ends is dropped.
 *
 * Null when the words cannot represent the sentence faithfully: when some of
 * its spoken tokens are carried by no text node. Spoken image alt text is the
 * case that exists today — an image is not a text node, so its words would
 * vanish from the quotation, at the front, the middle or the end.
 */
function writtenWords(sentence: SentenceUnit, blocks: readonly CompiledBlock[] | undefined): string[] | null {
  const block = blocks?.find((b) => b.id === sentence.blockId);
  if (block === undefined) return null;

  const words: string[] = [];
  let held: string[] = [];
  let inside = false;
  // A property, not a `let`: it is only ever set inside `place`, and a `let`
  // would still read as its initial null to the type checker afterwards.
  const seen = { first: null as number | null };
  const covered = new Set<number>();
  // No whitespace and no other node since the previous piece.
  let attached = false;
  // Where the previous piece went: into `words`, into `held`, or nowhere.
  let last: 'word' | 'held' | null = null;

  const append = (list: string[], piece: string): void => {
    list[list.length - 1] = `${list[list.length - 1] ?? ''}${piece}`;
  };

  const place = (piece: string, token: number | null): void => {
    if (token !== null) {
      inside = token >= sentence.startTokenIndex && token <= sentence.endTokenIndex;
      if (!inside) {
        held = [];
        last = null;
        return;
      }
      seen.first ??= token;
      if (attached && last === 'word') {
        append(words, piece);
      } else if (attached && last === 'held') {
        append(held, piece);
        words.push(...held);
      } else {
        words.push(...held, piece);
      }
      held = [];
      last = 'word';
      return;
    }
    if (!inside) {
      last = null;
      return;
    }
    // Unspoken, inside so far: stuck to a word, it goes where that word went;
    // free-standing, it waits for the next spoken word to vouch for it.
    if (attached && last === 'word') {
      append(words, piece);
    } else if (attached && last === 'held') {
      append(held, piece);
    } else {
      held.push(piece);
      last = 'held';
    }
  };

  const visit = (nodes: readonly SafeRenderNode[]): void => {
    for (const node of nodes) {
      if (node.type === 'link') {
        visit(node.label);
        continue;
      }
      if (node.type !== 'text') {
        attached = false;
        continue;
      }
      for (const token of node.tokenIndexes ?? []) {
        if (token >= sentence.startTokenIndex && token <= sentence.endTokenIndex) covered.add(token);
      }
      let word = 0;
      for (const piece of node.text.split(/(\s+)/)) {
        if (piece === '') continue;
        if (/^\s+$/.test(piece)) {
          attached = false;
          continue;
        }
        place(piece, node.wordTokens?.[word] ?? null);
        word += 1;
        attached = true;
      }
    }
  };
  visit(block.renderNodes);

  if (covered.size !== sentence.endTokenIndex - sentence.startTokenIndex + 1) return null;
  if (seen.first !== sentence.startTokenIndex) return null;
  return words;
}

/**
 * The start point for "continue from where I stopped".
 *
 * `endTokenIndex` is where the LAST take finished, and resuming exactly there
 * is right: the presenter stopped after saying that token, so the next word
 * they say is the next one. It is still snapped, because a take can end
 * anywhere at all — mid-sentence is the normal case for a take that was ended
 * deliberately.
 *
 * Returns null rather than the beginning when there is nothing to continue
 * from, so the UI can hide the action instead of offering one that silently
 * does the same thing as Present.
 */
export function continueFrom(endTokenIndex: number | undefined, input: SnapInput): StartPoint | null {
  if (endTokenIndex === undefined || !Number.isFinite(endTokenIndex)) return null;
  if (endTokenIndex <= 0) return null;
  const snapped = snapToStart(endTokenIndex, input);
  if (snapped.tokenIndex === 0) return null;
  return { ...snapped, kind: 'last_ending' };
}

/**
 * How the start point reads next to the Present button.
 *
 * "From beginning" is stated rather than left blank: the destination line beside
 * it always says something, and a start point that appeared only when it was
 * unusual would make the usual case look like a missing readout.
 */
export function describeStartPoint(point: StartPoint): string {
  switch (point.kind) {
    case 'beginning':
      return 'From beginning';
    case 'section':
      return `From “${point.label}”`;
    case 'marker':
      return `From marker “${point.label}”`;
    case 'last_ending':
      return 'From last ending';
    case 'sentence':
    default:
      return 'From here';
  }
}
