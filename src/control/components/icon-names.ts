/**
 * The icon set's vocabulary, and the one stroke it is drawn at (spec §11.7).
 *
 * A plain module rather than `Icon.svelte`'s `<script module>` block, because
 * four other modules need these two things and one of them is a test. Named
 * exports from a component's module block are resolved by `svelte-check` and
 * NOT by `tsc`, which sees only the ambient `*.svelte` default export — so the
 * type-check that runs in the editor disagreed with the one that runs in the
 * terminal, and the terminal had two permanent errors nobody could act on.
 *
 * Glyph resolution stays in the component: that is where the Lucide imports
 * live, and inlining them here would pull the icon set into every module that
 * only wanted to name an icon.
 */

export type IconName =
  | 'plus'
  | 'search'
  | 'import'
  | 'export'
  | 'trash'
  | 'restore'
  | 'settings'
  | 'doc'
  | 'chevron-left'
  | 'chevron-right'
  | 'chevron-down'
  | 'chevron-up'
  | 'dots'
  | 'play'
  | 'pause'
  | 'stop'
  | 'mic'
  | 'monitor'
  | 'book-open'
  | 'check'
  | 'alert'
  | 'info'
  | 'x'
  | 'pencil'
  | 'link'
  | 'image'
  | 'flag'
  | 'gauge'
  | 'eye'
  | 'eye-off'
  | 'keyboard'
  | 'refresh'
  | 'external'
  | 'user'
  | 'clock'
  | 'diagram';

/**
 * Lucide draws on a 24px grid at stroke 2. Our controls render at 13-22px,
 * where 2 reads heavier than the surrounding UI text; 1.75 keeps the optical
 * weight the previous hand-drawn set had (1.7) while staying on the Lucide
 * grid. One value everywhere — the icons must not drift again.
 */
export const ICON_STROKE_WIDTH = 1.75;
