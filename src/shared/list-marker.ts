/**
 * What a list item's marker is, and how much of the line it takes.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ONE FILE
 * ---------------------------------------------------------------------------
 * The compiler already knows everything a list marker needs — whether the list
 * is ordered, the item's number, how deeply it is nested and whether it is a
 * task — and carries it on every `list_item` block as layout hints. Nothing
 * drew any of it: the stage put one dot in front of every item and the editor
 * preview drew no marker at all, so a numbered procedure, an outline and a
 * checklist all read as the same undifferentiated run of bullets.
 *
 * Three places have to agree about a marker, and only two of them draw it. The
 * stage and the editor preview draw it; the stage's line planner
 * (`wrap-plan.ts`) has to know how much of the column it takes, because a
 * planner that thinks the column is wider than it is packs a line the browser
 * then wraps again, and the presenter reads both breaks. Three copies of "a
 * number takes this much and a nested item starts here" is three copies that
 * would drift, so the decision and the geometry both live here and every one
 * of them reads it.
 *
 * ---------------------------------------------------------------------------
 * A MARKER IS DRAWN, NEVER SPOKEN
 * ---------------------------------------------------------------------------
 * Nothing here produces a spoken token. The compiler leaves list markers and
 * task checkboxes out of speech (`compile.test.ts` pins it), and a renderer that
 * draws `3.` must not give that text a `data-t` anchor: the motion path measures
 * only anchored spans, so an anchored marker would be a word on the glass the
 * aligner was never given. The renderers mark it `aria-hidden` as well — the
 * structure is visual, and the words are what a reader is following.
 *
 * ---------------------------------------------------------------------------
 * THE GEOMETRY IS DECIDED, NEVER MEASURED
 * ---------------------------------------------------------------------------
 * Every width below is in `em` of the item's own type and is computed from the
 * hints alone, which is what lets the planner know the inset exactly without
 * measuring anything drawn. The number column is the same width for every label
 * up to two digits, so the text of item 10 starts where the text of item 9 does
 * — a column that grew with every label would put them a digit apart. Past two
 * digits it grows by one digit's width per digit, because the alternative is a
 * label wider than its column: right-aligned, that hangs into the margin, and a
 * long one (`2024.` opening a sentence parses as a list item) runs off the edge
 * of a window and is clipped. A list long enough to reach 100 shifts its text by
 * a digit there, which is the honest cost; nothing is ever cut off.
 */

/** The three markers a list item can carry. */
export type ListMarkerKind = 'bullet' | 'number' | 'task';

export interface ListMarker {
  kind: ListMarkerKind;
  /** The text a numbered marker draws (`3.`); empty for the other two. */
  label: string;
  /** Present only on a task item. */
  checked?: boolean;
  /** Nesting depth, 0 for a top-level item, already capped for drawing. */
  depth: number;
}

/** How much of the line a marker takes, in `em` of the item's own type. */
export interface ListMarkerGeometry {
  /** Indentation before the marker: the item's nesting. */
  indentEm: number;
  /** The marker's own column. */
  markerEm: number;
  /** Space between the marker column and the item's text. */
  gapEm: number;
  /** Everything to the left of the text: `indentEm + markerEm + gapEm`. */
  insetEm: number;
}

/**
 * How far one level of nesting moves an item in.
 *
 * Wide enough that a nested item's text sits visibly to the right of its
 * parent's whichever two kinds of marker are involved: under a numbered parent,
 * whose text starts 1.9em in, a nested bullet's text starts at 2.33em.
 */
export const LIST_DEPTH_INDENT_EM = 1.5;

/**
 * The deepest nesting that is drawn as further indentation.
 *
 * Deeper items keep their marker and sit at this level. Past it each level
 * costs the text another 1.5em of a column that, on a nine-inch prompter, is
 * about twenty-five characters wide — and an outline five levels deep is not a
 * script anyone reads aloud.
 */
export const MAX_LIST_DEPTH = 4;

/**
 * The marker columns, by kind.
 *
 * The bullet is exactly the geometry the stage has always drawn (a 0.28em dot,
 * 0.55em from the text), so an unordered list looks as it did. The number
 * column is sized for `99.` in Atkinson Hyperlegible Next, whose widest two
 * digits and a full stop come to just under 1.5em; the gap is narrower than the
 * bullet's because a full stop already ends in white space. The checkbox is a
 * box about the height of a capital, with a little more room after it than a
 * number gets, because a box has no white space of its own.
 */
const GEOMETRY: Readonly<Record<ListMarkerKind, { markerEm: number; gapEm: number }>> = {
  bullet: { markerEm: 0.28, gapEm: 0.55 },
  number: { markerEm: 1.5, gapEm: 0.4 },
  task: { markerEm: 0.72, gapEm: 0.5 },
};

/**
 * What each digit past the second adds to the number column: the widest digit
 * in the stage face (Atkinson's `0` is 0.648em), so a longer label always fits.
 */
export const LIST_NUMBER_DIGIT_EM = 0.65;

/** Digits the base number column already holds. */
const NUMBER_COLUMN_DIGITS = 2;

type Hints = Readonly<Record<string, string | number | boolean>> | undefined;

/**
 * The marker for a list item, from the hints the compiler put on its block.
 *
 * A task beats a number: `1. [x] Ship it` carries both, and whether the step is
 * done is the more useful of the two facts to see. Hints that are missing or of
 * the wrong type fall back to a top-level bullet, which is what the stage drew
 * for every item before this existed.
 */
export function listMarker(hints: Hints): ListMarker {
  const depth = clampDepth(hints?.['depth']);
  const checked = hints?.['checked'];
  if (typeof checked === 'boolean') return { kind: 'task', label: '', checked, depth };
  const index = hints?.['index'];
  if (
    hints?.['ordered'] === true &&
    typeof index === 'number' &&
    Number.isSafeInteger(index) &&
    index >= 0
  ) {
    return { kind: 'number', label: `${index}.`, depth };
  }
  return { kind: 'bullet', label: '', depth };
}

/** How much of the line `marker` takes. */
export function listMarkerGeometry(marker: ListMarker): ListMarkerGeometry {
  const base = GEOMETRY[marker.kind];
  const gapEm = base.gapEm;
  let markerEm = base.markerEm;
  if (marker.kind === 'number') {
    const digits = marker.label.replace(/\D/g, '').length;
    markerEm += Math.max(0, digits - NUMBER_COLUMN_DIGITS) * LIST_NUMBER_DIGIT_EM;
  }
  const indentEm = marker.depth * LIST_DEPTH_INDENT_EM;
  return { indentEm, markerEm, gapEm, insetEm: indentEm + markerEm + gapEm };
}

/** Everything to the left of a list item's text, in `em` of its own type. */
export function listInsetEm(hints: Hints): number {
  return listMarkerGeometry(listMarker(hints)).insetEm;
}

function clampDepth(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(MAX_LIST_DEPTH, Math.floor(raw));
}
