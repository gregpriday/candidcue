/**
 * Dividing a script into presentable parts (§parts).
 *
 * ---------------------------------------------------------------------------
 * ONE RULE, TWO SOURCES, IN THAT ORDER
 * ---------------------------------------------------------------------------
 * A boundary is an authored `[Take: …]` marker. A script that authors none is
 * divided by its own shallowest heading level instead.
 *
 * Markers win because they are a statement about PERFORMANCE and headings are a
 * statement about the DOCUMENT. Somebody who writes "## Pricing" is telling the
 * reader where pricing starts; somebody who writes `[Take: Pricing]` is telling
 * the prompter where to stop. Deriving parts from headings alone would mean
 * that reorganising an outline silently reorganises the takes — and, worse,
 * that there is no way to say "these three sections are one sitting".
 *
 * Headings are the fallback rather than nothing at all because the great
 * majority of scripts have headings and no markers, and offering that author
 * nothing would make the feature invisible to almost everybody it is for.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT THEMATIC BREAKS (`---`)
 * ---------------------------------------------------------------------------
 * They were the obvious candidate and they are the wrong one. A `---` is
 * ordinary Markdown punctuation people already use for visual separation, and
 * it already DRAWS on the prompter glass (`BlockView.svelte`, `divider`). Giving
 * it a second, invisible meaning would mean an author could not draw a rule
 * without also cutting their take in half, with nothing on screen to say so.
 *
 * Pure: no I/O, no clocks. Operates on compiled output only, so the same
 * division is available to the compiler, the launch menu and the tests.
 */
import type { CueEvent, OutlineNode, ScriptPart, SentenceUnit } from '../contracts';

export interface DerivePartsInput {
  /**
   * The compiled cue events. Only `cueType: 'take'` entries are read; the whole
   * list is taken rather than a pre-filtered one so no caller can filter it
   * differently from the way the compiler built it.
   *
   * THE CUES RATHER THAN THE NAVIGATION TARGETS, and the difference matters for
   * exactly one script: `compile.ts` CLAMPS a take navigation target to the last
   * token (`Math.min(anchor, totalTokens - 1)`) so that voice navigation always
   * has somewhere to go, while it gives the same marker's cue an honest
   * `anchorTokenIndex` of -1 when nothing spoken follows it.
   *
   * A marker written at the very end of a document — a closing `[Take: End]`
   * with no words under it — therefore looks, through the navigation target,
   * like a boundary sitting on the last word of the script. Snapped back to
   * that word's sentence, it would manufacture a final part that stole the real
   * ending's last sentence. Read through the cue it is what it is: a marker
   * with nothing after it, and no part.
   */
  cues: readonly CueEvent[];
  /** The outline, which may be nested. */
  outline: readonly OutlineNode[];
  /**
   * Sentences in document order, used to snap every boundary to a whole one.
   *
   * A boundary is simultaneously the END of one part and the START of the next,
   * so a boundary inside a sentence would cut that sentence in half — the first
   * clause recorded in one take and the rest in another, with no reading of
   * either that sounds like the script. `[Take: …]` is an INLINE directive, so
   * an author can write one mid-paragraph and this is not a theoretical case.
   *
   * Snapped BACKWARDS, which gives the whole sentence to the later part. The
   * alternative loses it from both: a presenter who asked to start at a marker
   * and was handed the sentence after it would have skipped the very line they
   * were pointing at, which is the same rule `snapToStart` settled on.
   */
  sentences: readonly SentenceUnit[];
  /** Total spoken tokens in the script. */
  totalTokens: number;
}

/** One candidate boundary before spans are worked out. */
interface Boundary {
  id: string;
  label: string;
  tokenIndex: number;
  origin: 'marker' | 'heading';
}

/**
 * Flatten a nested outline into document order.
 *
 * `take-start-point.ts` exports the same walk for the same reason it is
 * duplicated nowhere else: two different walks of one tree would eventually
 * disagree about which heading a token belongs to. This module cannot import
 * that one — `shared/` must not depend on `control/` — so it is re-stated here
 * and the two are pinned together by a test that runs both over one outline.
 */
export function flattenOutlineNodes(nodes: readonly OutlineNode[]): OutlineNode[] {
  const out: OutlineNode[] = [];
  const walk = (list: readonly OutlineNode[]): void => {
    for (const node of list) {
      out.push(node);
      if (node.children.length > 0) walk(node.children);
    }
  };
  walk(nodes);
  return out.sort((a, b) => a.startTokenIndex - b.startTokenIndex);
}

/**
 * The outline section a token position is in: the last heading that starts at
 * or before it, nested headings included.
 *
 * "Last started", not "every node whose span contains it" — a parent's span is
 * widened to cover its children, so the parent contains every token its
 * children do, and the section somebody is reading is the innermost one. Ties
 * resolve to the later node in document order (the flatten is a stable sort),
 * which is the heading the words under that shared token belong to.
 *
 * The token is compared as given. A fractional position half a token short of
 * a heading has not reached it, and rounding here would name the next section
 * for a reader still finishing the last one. Null when the outline is empty or
 * the token is before its first node, which real compiler output never is:
 * `buildOutline` always opens at token zero.
 */
export function outlineSectionAt(
  outline: readonly OutlineNode[],
  token: number,
): OutlineNode | null {
  let best: OutlineNode | null = null;
  for (const node of flattenOutlineNodes(outline)) {
    if (node.startTokenIndex <= token) best = node;
    else break;
  }
  return best;
}

/**
 * Divide a compiled script into parts.
 *
 * Returns an empty list when the script has no division to offer — no spoken
 * words at all, or a single boundary covering everything. A lone part is not a
 * part: "start at the only part" and "start at the beginning" are the same
 * take, and a menu that offered both would be inventing a choice.
 */
export function deriveParts(input: DerivePartsInput): ScriptPart[] {
  const totalTokens = Math.max(0, Math.floor(input.totalTokens));
  if (totalTokens === 0) return [];

  const snap = sentenceSnapper(input.sentences);
  const boundaries = markerBoundaries(input.cues, totalTokens, snap);
  const chosen =
    boundaries.length > 0 ? boundaries : headingBoundaries(input.outline, totalTokens, snap);

  /*
   * A part must be openable, so the first one starts at token zero whatever the
   * author wrote. A script whose first marker sits six paragraphs in still has
   * those paragraphs, and they are somebody's opening — leaving them in no part
   * would make the only way to record them "start from the beginning and stop
   * by eye", which is the exact workflow parts exist to replace.
   *
   * The opening borrows its name from the outline, which already synthesises an
   * "Opening" section for content above the first heading. Inventing a second
   * name for the same span here would put two different words on one piece of
   * script depending on which panel you read.
   */
  if (chosen.length > 0 && chosen[0]!.tokenIndex > 0) {
    chosen.unshift(openingBoundary(input.outline, chosen[0]!.origin));
  }

  if (chosen.length < 2) return [];

  return chosen.map((boundary, index) => {
    const next = chosen[index + 1];
    const start = boundary.tokenIndex;
    // Inclusive, and never before its own start: two boundaries can legally
    // land on the same token (a marker written directly under a heading), and
    // an end of `start - 1` would be a backwards span rather than an empty one.
    const end = next === undefined ? totalTokens - 1 : Math.max(start, next.tokenIndex - 1);
    return {
      id: boundary.id,
      label: boundary.label,
      ordinal: index + 1,
      startTokenIndex: start,
      endTokenIndex: end,
      origin: boundary.origin,
    };
  });
}

/** Authored `[Take: …]` markers, in document order, deduplicated by token. */
function markerBoundaries(
  cues: readonly CueEvent[],
  totalTokens: number,
  snap: (token: number) => number,
): Boundary[] {
  const markers = cues
    .filter((c) => c.cueType === 'take')
    // -1 is the compiler's "nothing spoken follows this marker". It is not a
    // position and must not be treated as one.
    .filter(
      (c) =>
        Number.isFinite(c.anchorTokenIndex) &&
        c.anchorTokenIndex >= 0 &&
        c.anchorTokenIndex < totalTokens,
    )
    .map((c) => ({
      id: c.id,
      label: c.label.trim() === '' ? 'Untitled part' : c.label,
      tokenIndex: snap(Math.floor(c.anchorTokenIndex)),
      origin: 'marker' as const,
    }))
    // Sorted AFTER snapping, so the dedupe below sees a genuinely ordered list.
    // (Snapping is monotone over the compiler's ordered, non-overlapping
    // sentences, so this only has to undo the input's own ordering, but sorting
    // the values that are actually compared is the version that stays true if
    // either of those properties ever changes.)
    .sort((a, b) => a.tokenIndex - b.tokenIndex);

  return dedupeByToken(markers);
}

/**
 * The outline's shallowest level, which is the level an author divides at.
 *
 * Not "every heading": a script written as one H1 over six H2s over twenty H3s
 * would otherwise produce twenty-seven parts, most of them a sentence long. The
 * shallowest level is the one that means "a new piece of this talk" — and it is
 * the level the author chose, rather than a number this module picked.
 *
 * Synthetic nodes count. `buildOutline` emits an "Opening" node for content
 * above the first heading and a lone "Script" node for a document with no
 * headings at all; both are level 1, so the first becomes a real opening part
 * and the second collapses to a single boundary and therefore to no parts —
 * which is the correct answer for a script with no structure in it.
 */
function headingBoundaries(
  outline: readonly OutlineNode[],
  totalTokens: number,
  snap: (token: number) => number,
): Boundary[] {
  const nodes = flattenOutlineNodes(outline).filter(
    (n) =>
      // AUTHORED headings only. `buildOutline` synthesises two nodes with an
      // empty `blockId` — an "Opening" for content above the first heading, and
      // a lone "Script" for a document with no headings at all — and both are
      // level 1 whatever the author actually wrote.
      //
      // Counting them broke the rule this function states. A perfectly ordinary
      // document — a paragraph of introduction, then `## Setup`, then `## Demo`
      // — has a shallowest AUTHORED level of 2, but the synthetic Opening made
      // it 1, so the only boundary selected was the Opening and the script came
      // out with no parts at all. The preamble is still covered: it comes back
      // below as the implicit opening boundary, which is where it belongs.
      n.blockId !== '' &&
      n.title.trim() !== '' &&
      Number.isFinite(n.startTokenIndex) &&
      n.startTokenIndex >= 0 &&
      n.startTokenIndex < totalTokens,
  );
  if (nodes.length === 0) return [];

  const shallowest = nodes.reduce((min, n) => Math.min(min, n.level), Number.POSITIVE_INFINITY);

  return dedupeByToken(
    nodes
      .filter((n) => n.level === shallowest)
      .map((n) => ({
        id: n.id,
        label: n.title,
        tokenIndex: snap(Math.floor(n.startTokenIndex)),
        origin: 'heading' as const,
      }))
      // Snapping is monotone, so this list is still ordered — but it is sorted
      // on the compared value for the same reason the markers are.
      .sort((a, b) => a.tokenIndex - b.tokenIndex),
  );
}

/**
 * The part covering everything above the first authored boundary.
 *
 * Named from the outline node that already spans token zero, so it reads as
 * "Opening" or as the script's own first heading rather than as a word invented
 * here. Falls back to "Beginning" — the vocabulary `describeStartPoint` already
 * uses for the same place — when the outline has nothing to say.
 */
function openingBoundary(
  outline: readonly OutlineNode[],
  origin: 'marker' | 'heading',
): Boundary {
  const first = flattenOutlineNodes(outline).find(
    (n) => n.startTokenIndex === 0 && n.title.trim() !== '',
  );
  return {
    id: first?.id ?? 'part-opening',
    label: first?.title ?? 'Beginning',
    tokenIndex: 0,
    origin,
  };
}

/**
 * Snap a token back to the first token of the sentence containing it.
 *
 * A heading's own start is usually not inside any sentence — the outline gives
 * a node the whole section beneath it — and a token before the first sentence
 * has nothing to snap to. Both answer with the token unchanged, which is
 * already a boundary between units.
 */
function sentenceSnapper(sentences: readonly SentenceUnit[]): (token: number) => number {
  if (sentences.length === 0) return (token) => token;
  return (token) => {
    let best: SentenceUnit | null = null;
    for (const sentence of sentences) {
      if (sentence.startTokenIndex <= token) best = sentence;
      else break;
    }
    // Only when the token is genuinely INSIDE the sentence. A token after the
    // last sentence of a block (a heading start, say) belongs to whatever comes
    // next, and dragging it back into the previous sentence would move the
    // boundary across a block it has nothing to do with.
    if (best === null || token > best.endTokenIndex) return token;
    return best.startTokenIndex;
  };
}

/**
 * One boundary per token, keeping the LAST.
 *
 * Two boundaries on the same token would otherwise produce a zero-length part
 * between them, which is a row in the launch menu that starts a take with
 * nothing in it.
 *
 * The last one wins because it is the one the words belong to. Written out:
 *
 *     [Take: Old]
 *     [Take: Final]
 *     The words.
 *
 * both markers anchor to the same first spoken token, and everything after them
 * is unambiguously the part called "Final" — an author who renames a break by
 * writing a new one above it has said which name they meant. Keeping the first
 * labelled that content "Old" and made "Final" disappear from the menu
 * entirely, which is the opposite of what was asked for.
 */
function dedupeByToken(boundaries: Boundary[]): Boundary[] {
  const out: Boundary[] = [];
  for (const boundary of boundaries) {
    if (out.length > 0 && out[out.length - 1]!.tokenIndex === boundary.tokenIndex) out.pop();
    out.push(boundary);
  }
  return out;
}

/** The part containing a token, or null when the script has no parts. */
export function partAt(parts: readonly ScriptPart[], tokenIndex: number): ScriptPart | null {
  let best: ScriptPart | null = null;
  for (const part of parts) {
    if (part.startTokenIndex <= tokenIndex) best = part;
    else break;
  }
  return best;
}

/** The part after `part`, or null when it is the last one. */
export function nextPart(parts: readonly ScriptPart[], part: ScriptPart | null): ScriptPart | null {
  if (part === null) return null;
  return parts.find((p) => p.ordinal === part.ordinal + 1) ?? null;
}
