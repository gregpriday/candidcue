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

export interface StatusBarItem {
  /** Stable across state changes so Svelte does not re-create the node. */
  key: string;
  label: string;
  icon?: IconName;
  /**
   * `normal` is the overwhelming majority and is deliberately low-contrast.
   * §24.3: danger-red is for genuine faults, never for "not configured yet".
   */
  tone?: 'normal' | 'warning' | 'danger' | 'accent';
  title?: string;
  /**
   * Present only when clicking opens something meaningful (§11.7).
   *
   * Its absence is what makes the item plain text rather than a button, and
   * therefore not a tab stop — a focusable thing that does nothing is worse for
   * a keyboard user than no focusable thing at all.
   */
  onclick?: () => void;
}
