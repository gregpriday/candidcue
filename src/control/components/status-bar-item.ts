/**
 * The status bar's row shape.
 *
 * A plain module rather than `StatusBar.svelte`'s script block, for the reason
 * `icon-names.ts` records: a type exported from a `.svelte` file is resolved by
 * `svelte-check` and not by `tsc`, so the editor's type-check and the terminal's
 * disagree. Anything shared between a component and plain TypeScript gets
 * declared in the plain TypeScript.
 */
import type { IconName } from './icon-names';

/**
 * `normal` is the overwhelming majority and is deliberately low-contrast.
 * §24.3: danger-red is for genuine faults, never for "not configured yet".
 */
export type StatusBarTone = 'normal' | 'warning' | 'danger' | 'accent';

/** One run of an item that says two things in two tones. */
export interface StatusBarPart {
  key: string;
  label: string;
  icon?: IconName;
  tone?: StatusBarTone;
}

export interface StatusBarItem {
  /** Stable across state changes so Svelte does not re-create the node. */
  key: string;
  label: string;
  icon?: IconName;
  tone?: StatusBarTone;
  title?: string;
  /**
   * Drawn in place of `icon` and `label` when present: one item, and so one
   * button, whose runs keep their own tones.
   *
   * The diagnostic summary is the case. "1 error" and "2 notes" go to the same
   * place, so two buttons would be two tab stops for one destination — and one
   * label in one tone either hides the notes or paints them red.
   */
  parts?: StatusBarPart[];
  /**
   * Present only when clicking does something meaningful (§11.7).
   *
   * Its absence is what makes the item plain text rather than a button, and
   * therefore not a tab stop — a focusable thing that does nothing is worse for
   * a keyboard user than no focusable thing at all.
   */
  onclick?: () => void;
}
