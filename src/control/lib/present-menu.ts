/**
 * The two shapes a take can open in, as a menu.
 *
 * The copy lives here rather than in the component that renders it because it
 * is the only place in the app that has to EXPLAIN the difference between the
 * modes at the moment somebody is choosing between them. It uses the names
 * Settings and the destination readout use ("Teleprompter" / "Reading
 * window"), and has one line to say what will happen to the window.
 */
import type { ScriptPart } from '../../shared/contracts';
import { NOUNS } from '../../shared/take-vocabulary';
import type { PresentationMode } from '../services/settings-types';
import type { TakePartRequest } from './start-take';

/**
 * Structurally the `SplitMenuItem` that `SplitButton.svelte` takes, declared
 * here rather than imported from it.
 *
 * `icon-names.ts` records why: a type exported from a `.svelte` file is
 * resolved by `svelte-check` and not by `tsc`, so importing one makes the
 * editor's type-check and the terminal's disagree. Anything that must be shared
 * between a component and plain TypeScript gets declared in the plain
 * TypeScript.
 */
export interface PresentMenuItem {
  label: string;
  description?: string;
  selected?: boolean;
  disabled?: boolean;
  /** Informs rather than acts: drawn readable, never chosen. */
  note?: boolean;
  /** Starts a new group in the menu: a rule above, and an optional heading. */
  group?: { heading?: string };
  onselect: () => void;
}

/**
 * Both modes, with the current default checked.
 *
 * The checked item is not disabled, and that is deliberate: choosing the mode
 * you are already defaulted to is a no-op for the setting but still a perfectly
 * ordinary way to say "present, in this shape". A menu that greyed it out would
 * be answering a question nobody asked — the operator is picking how to open a
 * take, not editing a preference.
 */
/**
 * Where a take can begin — and, since §parts, where it ends (CCUX-014,
 * CCUX-015, CCUX-016).
 *
 * The three questions somebody answers at launch are where to start, how to
 * display, and whether this is a take or a rehearsal. This covers the first;
 * `presentMenuItems` below covers the second; the third is the Practise row the
 * Editor appends beneath them (`file.practise`, §practice). Deliberately NOT a
 * place for microphone, font or calibration settings — those belong in
 * Settings, and a launch menu that grew them would become the Preflight page
 * this product removed on purpose.
 *
 * Rows appear only when they lead somewhere different. "From last ending" over
 * a script that has never been presented would be a third button that silently
 * does what the other two do.
 *
 * ---------------------------------------------------------------------------
 * PART ROWS REPLACED MARKER ROWS
 * ---------------------------------------------------------------------------
 * This used to offer one row per authored `[Take: …]` marker, and each of them
 * started a take that ran to the end of the script. A part row starts the same
 * take and also carries the part's end, so the take knows what it is recording
 * — which is the whole of what §parts added. A script with no markers now gets
 * rows too, divided on its own headings, so the feature is reachable without
 * having to learn a directive first.
 */
export interface StartMenuInput {
  /** Snapped caret/selection position, or null when the editor has no caret. */
  hereTokenIndex: number | null;
  /**
   * Where the caret position IS — a quoted opening phrase or a heading — never
   * the row's own name. It used to be `describeStartPoint`'s "From here",
   * which put "From here. Records part 1." under a row called From here.
   */
  hereLabel: string | null;
  /**
   * The part the caret sits in, or null on an undivided script.
   *
   * "From here" carries it, so starting part way into part three records part
   * three. Without it the overflow notice below was advertising a route that
   * silently produced an unbounded take.
   */
  herePart: ScriptPart | null;
  /** Where the last take stopped, snapped, or null when there is no history. */
  lastEndingTokenIndex: number | null;
  lastEndingLabel: string | null;
  /** The script's parts, in document order. Empty when it has no division. */
  parts: readonly ScriptPart[];
}

/**
 * `present` gets a token and, on a divided script, the part to record. A part
 * row asks for the `whole` part, so `startTake` opens it at its re-measured
 * start; "From here" does not, so the take of that part begins at the caret.
 */
export function startMenuItems(
  input: StartMenuInput,
  present: (tokenIndex: number, part?: TakePartRequest) => void,
): PresentMenuItem[] {
  /*
   * ONE LINE EACH, AND EACH ONE A FACT THE LABEL DOES NOT ALREADY STATE.
   *
   * This menu is read seconds before a take, often with someone waiting, and
   * its descriptions had grown into sentences: two or three wrapped lines a row,
   * so nine rows stood 750px tall and a long script pushed the shapes, Practise
   * and setup below the window. A description now answers the one question its
   * label leaves open — for a start row, WHERE — and stops.
   *
   * "From beginning" names its relation to the main button rather than
   * restating itself: it is what Present does, and saying so is the only place
   * the menu answers "what happens if I just click the button?".
   */
  const items: PresentMenuItem[] = [
    {
      label: 'From beginning',
      description: 'The whole script · same as clicking Present',
      onselect: () => present(0),
    },
  ];

  if (input.hereTokenIndex !== null && input.hereTokenIndex > 0) {
    items.push({
      label: 'From here',
      description: locate(input.hereLabel ?? 'The sentence at the cursor', input.herePart),
      onselect: () =>
        present(
          input.hereTokenIndex as number,
          input.herePart === null ? undefined : { id: input.herePart.id },
        ),
    });
  }

  if (input.lastEndingTokenIndex !== null) {
    const token = input.lastEndingTokenIndex;
    items.push({
      label: 'From last ending',
      description: locate(
        input.lastEndingLabel ?? 'Where the last take stopped',
        input.parts.find((p) => token >= p.startTokenIndex && token <= p.endTokenIndex) ?? null,
      ),
      onselect: () => present(token),
    });
  }

  /*
   * Parts are capped, because a launch menu that scrolled would be slower than
   * starting from the top and navigating — which is the behaviour this feature
   * exists to replace.
   *
   * What is NOT acceptable is capping quietly, which is what the marker rows
   * did: a lesson with twelve markers offered eight and said nothing about the
   * other four, so the parts a creator was most likely to be recording late in
   * a project were the ones that vanished. The overflow now says so, and names
   * the route that still reaches them.
   *
   * "From here" starts at the cursor, so the route has to say WHERE the cursor
   * goes for the whole part: its first spoken words. Not its heading — a
   * heading that is not read aloud has no sentence of its own, and a caret on
   * one resolves to the last sentence above it, in the previous part.
   */
  /*
   * A part row is its name and nothing else.
   *
   * It used to carry "Part 1 of 2. Done where “Second attempt” begins; carries
   * on if you do." — three lines a row, the same sentence on every one, and
   * "Part 1" said twice. The count is visible in the list itself, and the
   * boundary is advisory (see `ScriptPart`): nothing stops there, so the row
   * makes no promise about it at all rather than a careful one. What happens at
   * the boundary — the part is marked covered and the next one offered — is
   * shown at that moment, on the stage, which is where it means something.
   */
  for (const part of input.parts.slice(0, MAX_PART_ROWS)) {
    items.push({
      label: `Part ${part.ordinal} · ${part.label}`,
      // The token is only where to open if the part has gone by launch: it was
      // measured against the compile the menu was drawn from, and `whole` makes
      // `startTake` use the part's re-measured start instead.
      onselect: () => present(part.startTokenIndex, { id: part.id, whole: true }),
    });
  }

  const hidden = input.parts.length - MAX_PART_ROWS;
  if (hidden > 0) {
    items.push({
      label: `${hidden} more ${hidden === 1 ? 'part' : 'parts'} not listed`,
      description: 'Click a part’s first words, then From here',
      disabled: true,
      note: true,
      onselect: () => {},
    });
  }

  return items;
}

/**
 * A start row's place: what is there, and which part it is in.
 *
 * The part, not the heading above the sentence. The part is the unit this menu
 * lists two rows down, so "· Part 2" is an answer somebody can check against the
 * list; a sub-heading the list never mentions was a second, unrelated address.
 */
function locate(place: string, part: ScriptPart | null): string {
  return part === null ? place : `${place} · Part ${part.ordinal}`;
}

/**
 * Enough to cover a lesson's parts without turning the menu into a list.
 *
 * Twelve rather than the eight the marker rows allowed: parts are now the
 * primary way to launch a long script rather than an extra for authors who had
 * found the directive, so the common shape this has to hold — a course module
 * of eight to twelve segments — should fit whole.
 */
const MAX_PART_ROWS = 12;

export function presentMenuItems(
  current: PresentationMode,
  choose: (mode: PresentationMode) => void,
): PresentMenuItem[] {
  /*
   * The product's own nouns, under a "Present as" heading that reads as the
   * verb: "Present as — Teleprompter". They were "Present full screen" and
   * "Present in a window", so the readout beside the button said "Reading
   * window" and the ticked row in the menu said something else, and Settings
   * said a third thing. Each description is the shape in a few words, then the
   * fact a tick does not convey: choosing it starts a take now, from the top.
   */
  return [
    {
      label: NOUNS.prompter,
      description: 'Fills the display · from the beginning',
      selected: current === 'prompter',
      onselect: () => choose('prompter'),
    },
    {
      label: NOUNS.reader,
      description: 'A window beside a call · from the beginning',
      selected: current === 'reader',
      onselect: () => choose('reader'),
    },
  ];
}
