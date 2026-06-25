import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';

/**
 * CodeMirror themes built from the application design tokens (DESIGN-04), so the
 * editing surface matches the rest of the UI instead of the bundled One Dark
 * palette. Values reference CSS custom properties, so the editor tracks any
 * future token changes automatically.
 *
 * There are two base themes that differ ONLY in the `dark` flag CodeMirror reads
 * to drive its native editor behaviours (cursor/selection rendering, derived
 * defaults). The *palette* is identical — both pull from the shared token names —
 * so whichever theme is active, the editor re-skins with the surrounding shell.
 * Pick {@link candidCueEditorThemeWorkspace} inside the light workspace shell and
 * {@link candidCueEditorThemeStudio} inside the dark studio shell; mismatching the
 * `dark` flag against the actual shell makes the native cursor and selection
 * inherit the wrong light/dark assumptions.
 */
const themeSpec = {
  '&': {
    color: 'var(--prose-text-warm, var(--text-primary))',
    backgroundColor: 'transparent',
    fontSize: '15px',
  },
  '.cm-content': {
    caretColor: 'var(--accent)',
    fontFamily: 'var(--font-prose)',
    lineHeight: '24px',
    letterSpacing: 'var(--ls-prose, 0.01em)',
    maxWidth: 'var(--prose-measure, 68ch)',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
    { backgroundColor: 'var(--selection)' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--prose-muted-warm, var(--text-muted))',
    border: 'none',
  },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '.cm-placeholder': { color: 'var(--prose-muted-warm, var(--text-muted))' },
  '.cm-scroller': { fontFamily: 'var(--font-prose)' },
} as const;

/** Light base for the calm workspace shell — drives native light editor behaviour. */
const workspaceBaseTheme = EditorView.theme({ ...themeSpec }, { dark: false });
/** Dark base for the focused studio shell — drives native dark editor behaviour. */
const studioBaseTheme = EditorView.theme({ ...themeSpec }, { dark: true });

const highlight = HighlightStyle.define([
  { tag: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4], color: 'var(--text-primary)', fontWeight: '650' },
  { tag: t.strong, color: 'var(--text-primary)', fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: [t.link, t.url], color: 'var(--accent-strong)', textDecoration: 'underline' },
  { tag: t.monospace, color: 'var(--success)' },
  { tag: t.list, color: 'var(--text-secondary)' },
  { tag: t.quote, color: 'var(--text-secondary)', fontStyle: 'italic' },
  { tag: t.comment, color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--text-muted)' },
  { tag: [t.keyword, t.operator], color: 'var(--accent-strong)' },
]);

/** Composed light editor theme for the workspace shell (project/source editors). */
export const candidCueEditorThemeWorkspace: Extension = [workspaceBaseTheme, syntaxHighlighting(highlight)];
/** Composed dark editor theme for the studio shell. */
export const candidCueEditorThemeStudio: Extension = [studioBaseTheme, syntaxHighlighting(highlight)];
