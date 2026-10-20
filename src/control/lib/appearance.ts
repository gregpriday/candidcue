/**
 * Light or dark: the desk follows the system's appearance.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SYSTEM, AND ONLY THE SYSTEM
 * ---------------------------------------------------------------------------
 * People choose light or dark once, for the whole computer, and Apple's
 * guidance is that an app follows that choice rather than offering its own
 * switch — a second setting is one more place to change the same thing. Both
 * webviews report the system's choice through `prefers-color-scheme` and
 * update it live, so following it needs no store and no setting.
 *
 * ---------------------------------------------------------------------------
 * WHY AN ATTRIBUTE, NOT A MEDIA QUERY IN THE STYLESHEET
 * ---------------------------------------------------------------------------
 * The dark desk is the workspace palette retuned (`tokens.css`), and it has to
 * win over the light block without being a second copy of its selector. One
 * attribute on the root, `data-appearance`, does that, and gives every window
 * the same single place where the answer lives: the control window and the
 * Settings window both apply it before their first paint.
 *
 * It only ever retunes the desk. A running take is `data-theme='studio'` and
 * a frozen presentation surface is `data-theme='paper'`; neither reads it.
 */

export type Appearance = 'light' | 'dark';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** The system's appearance now. Light where the question cannot be asked. */
export function systemAppearance(): Appearance {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light';
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

/**
 * Put the system's appearance on `root` and keep it there as the system
 * changes. Returns the function that stops following it.
 */
export function followSystemAppearance(root: HTMLElement): () => void {
  root.dataset['appearance'] = systemAppearance();
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia(DARK_QUERY);
  const update = (event: MediaQueryListEvent) => {
    root.dataset['appearance'] = event.matches ? 'dark' : 'light';
  };
  query.addEventListener('change', update);
  return () => query.removeEventListener('change', update);
}
