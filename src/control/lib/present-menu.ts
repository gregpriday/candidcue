/**
 * The two shapes a take can open in, as a menu.
 *
 * The copy lives here rather than in the component that renders it because it
 * is the only place in the app that has to EXPLAIN the difference between the
 * modes at the moment somebody is choosing between them. Settings names them
 * ("Teleprompter" / "Reading window") next to a picture; this has one line to
 * say what will happen to the window.
 */
import type { ScriptPart } from '../../shared/contracts';
import type { PresentationMode } from '../services/settings-types';

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
  /** Label for the caret position, e.g. a heading or a quoted phrase. */
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
 * `present` gets a token, a part, or both. A part with no token is the whole
 * part — `startTake` opens it at its re-measured start — and a token with a part
 * is a take of that part begun at the token, which is what "From here" means.
 */
export function startMenuItems(
  input: StartMenuInput,
  present: (tokenIndex: number | undefined, part?: ScriptPart) => void,
): PresentMenuItem[] {
  const items: PresentMenuItem[] = [
    {
      label: 'From beginning',
      description:
        input.parts.length > 0
          ? 'Reads the whole script, straight through every part.'
          : 'The default. Reads the script from the top.',
      onselect: () => present(0),
    },
  ];

  if (input.hereTokenIndex !== null && input.hereTokenIndex > 0) {
    items.push({
      label: 'From here',
      description:
        input.herePart === null
          ? (input.hereLabel ?? 'Starts at the cursor, snapped to a whole sentence.')
          : `${input.hereLabel ?? 'Starts at the cursor'}. Records part ${input.herePart.ordinal}.`,
      onselect: () => present(input.hereTokenIndex as number, input.herePart ?? undefined),
    });
  }

  if (input.lastEndingTokenIndex !== null) {
    items.push({
      label: 'From last ending',
      description: input.lastEndingLabel ?? 'Picks up where the last take stopped.',
      onselect: () => present(input.lastEndingTokenIndex as number),
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
  for (const part of input.parts.slice(0, MAX_PART_ROWS)) {
    items.push({
      label: `Part ${part.ordinal} · ${part.label}`,
      description: describePartRange(input.parts, part),
      // No token: the row's start was measured against the compile the menu
      // was drawn from, and only the part is re-measured at launch.
      onselect: () => present(undefined, part),
    });
  }

  const hidden = input.parts.length - MAX_PART_ROWS;
  if (hidden > 0) {
    items.push({
      label: `${hidden} more ${hidden === 1 ? 'part' : 'parts'} below`,
      description:
        'To record a whole part, put the cursor on its first spoken words and choose “From here”.',
      disabled: true,
      onselect: () => {},
    });
  }

  return items;
}

/** What a part row promises about where the take stops. */
/**
 * What a part row promises — and, as carefully, what it does not.
 *
 * "Ends where X begins" was the first wording and it was a lie by implication:
 * nothing stops there. The bound is advisory (see `ScriptPart`), the engine
 * still holds the whole script, and reading straight on past the boundary is a
 * legitimate thing to do. What the app does at that point is mark the part
 * covered and offer the next one, so that is what the row says.
 */
function describePartRange(parts: readonly ScriptPart[], part: ScriptPart): string {
  const next = parts.find((p) => p.ordinal === part.ordinal + 1);
  return next === undefined
    ? `Part ${part.ordinal} of ${parts.length}. Done at the end of the script.`
    : `Part ${part.ordinal} of ${parts.length}. Done where “${next.label}” begins; carries on if you do.`;
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
  return [
    {
      label: 'Present full screen',
      description: 'Fills the display, above the menu bar. For reading off glass at a distance.',
      selected: current === 'prompter',
      onselect: () => choose('prompter'),
    },
    {
      label: 'Present in a window',
      description: 'An ordinary window you can size and sit beside a call.',
      selected: current === 'reader',
      onselect: () => choose('reader'),
    },
  ];
}
