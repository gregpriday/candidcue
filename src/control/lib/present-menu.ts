/**
 * The two shapes a take can open in, as a menu.
 *
 * The copy lives here rather than in the component that renders it because it
 * is the only place in the app that has to EXPLAIN the difference between the
 * modes at the moment somebody is choosing between them. Settings names them
 * ("Teleprompter" / "Reading window") next to a picture; this has one line to
 * say what will happen to the window.
 */
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
 * Where a take can begin, as menu rows (CCUX-014, CCUX-015, CCUX-016).
 *
 * The three questions somebody answers at launch are where to start, how to
 * display, and whether this is a take or a rehearsal. This covers the first;
 * `presentMenuItems` below covers the second. Deliberately NOT a place for
 * microphone, font or calibration settings — those belong in Settings, and a
 * launch menu that grew them would become the Preflight page this product
 * removed on purpose.
 *
 * Rows appear only when they lead somewhere different. "From last ending" over
 * a script that has never been presented would be a third button that silently
 * does what the other two do.
 */
export interface StartMenuInput {
  /** Snapped caret/selection position, or null when the editor has no caret. */
  hereTokenIndex: number | null;
  /** Label for the caret position, e.g. a heading or a quoted phrase. */
  hereLabel: string | null;
  /** Where the last take stopped, snapped, or null when there is no history. */
  lastEndingTokenIndex: number | null;
  lastEndingLabel: string | null;
  /** Authored take markers, in document order. */
  markers: Array<{ id: string; label: string; tokenIndex: number }>;
}

export function startMenuItems(
  input: StartMenuInput,
  present: (tokenIndex: number) => void,
): PresentMenuItem[] {
  const items: PresentMenuItem[] = [
    {
      label: 'From beginning',
      description: 'The default. Reads the script from the top.',
      onselect: () => present(0),
    },
  ];

  if (input.hereTokenIndex !== null && input.hereTokenIndex > 0) {
    items.push({
      label: 'From here',
      description: input.hereLabel ?? 'Starts at the cursor, snapped to a whole sentence.',
      onselect: () => present(input.hereTokenIndex as number),
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
   * Markers are capped. A script may author dozens, and a launch menu that
   * scrolled would be slower than starting from the top and navigating — which
   * is the behaviour this feature exists to replace.
   */
  for (const marker of input.markers.slice(0, MAX_MARKER_ROWS)) {
    items.push({
      label: `From marker “${marker.label}”`,
      onselect: () => present(marker.tokenIndex),
    });
  }

  return items;
}

/** Enough to cover a lesson's segments without turning the menu into a list. */
const MAX_MARKER_ROWS = 8;

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
