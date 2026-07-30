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
