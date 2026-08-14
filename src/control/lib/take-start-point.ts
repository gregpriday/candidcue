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
import type { OutlineNode, SentenceUnit } from '../../shared/contracts';

/** Where a start point came from, which is what the UI has to explain. */
export type StartPointKind = 'beginning' | 'section' | 'sentence' | 'marker' | 'last_ending';

export interface StartPoint {
  /** The snapped token index. Always the first token of a readable unit. */
  tokenIndex: number;
  kind: StartPointKind;
  /** Human label — a heading, a marker name, or a truncated first phrase. */
  label: string;
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
   * A heading wins over the sentence beneath it when the request lands inside
   * the heading's own tokens. "Present from this section" must open on the
   * section, not on its first body sentence, or the presenter loses the line
   * that tells them where they are.
   */
  const headings = flattenOutline(input.outline);
  const heading = lastAtOrBefore(headings, target, (n) => n.startTokenIndex);
  if (heading && target <= heading.endTokenIndex && heading.startTokenIndex <= target) {
    return { tokenIndex: heading.startTokenIndex, kind: 'section', label: heading.title };
  }

  const sentence = lastAtOrBefore(sentences, target, (s) => s.startTokenIndex);
  if (sentence === null) return beginning();

  // Starting at the first sentence of the document IS starting at the
  // beginning, and saying so is less confusing than quoting its first words
  // back at somebody who did not ask for a section.
  if (sentence.startTokenIndex === 0) return beginning();

  return {
    tokenIndex: sentence.startTokenIndex,
    kind: 'sentence',
    label: describeSentence(sentence, headings),
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
function describeSentence(sentence: SentenceUnit, headings: OutlineNode[]): string {
  const heading = lastAtOrBefore(headings, sentence.startTokenIndex, (n) => n.startTokenIndex);
  const words = sentence.normalizedText.trim().split(/\s+/).filter(Boolean).slice(0, 6).join(' ');
  const phrase = words === '' ? 'this sentence' : `“${words}…”`;
  return heading === null ? phrase : `${phrase} in ${heading.title}`;
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
