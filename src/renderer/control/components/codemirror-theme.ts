import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';

/**
 * A CodeMirror theme built from the application design tokens (DESIGN-04), so the
 * editing surface matches the rest of the UI instead of the bundled One Dark
 * palette. Values reference CSS custom properties, so the editor tracks any
 * future token changes automatically.
 */
const baseTheme = EditorView.theme(
  {
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
  },
  { dark: true },
);

const highlight = HighlightStyle.define([
  { tag: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4], color: 'var(--text-primary)', fontWeight: '650' },
  { tag: t.strong, color: 'var(--text-primary)', fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: [t.link, t.url], color: 'var(--accent)', textDecoration: 'underline' },
  { tag: t.monospace, color: 'var(--success)' },
  { tag: t.list, color: 'var(--text-secondary)' },
  { tag: t.quote, color: 'var(--text-secondary)', fontStyle: 'italic' },
  { tag: t.comment, color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--text-muted)' },
  { tag: [t.keyword, t.operator], color: 'var(--accent)' },
]);

/** The composed editor theme to pass as the CodeMirror `theme` extension. */
export const candidCueEditorTheme: Extension = [baseTheme, syntaxHighlighting(highlight)];
