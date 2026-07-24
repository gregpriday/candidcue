/**
 * CodeMirror theme built from the design tokens so the editing surface tracks
 * the surrounding shell. Values reference CSS custom properties directly.
 * Editor focus is a quiet surface — no accent outline ever (owner rule).
 */
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';

const themeSpec = {
  '&': {
    color: 'var(--prose-text-warm, var(--text-primary))',
    backgroundColor: 'transparent',
    fontSize: '15px',
    height: '100%',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-content': {
    caretColor: 'var(--accent)',
    fontFamily: 'var(--font-prose)',
    lineHeight: '26px',
    letterSpacing: 'var(--ls-prose, 0.01em)',
    maxWidth: 'var(--prose-measure, 70ch)',
    padding: 'var(--space-6) 0',
  },
  '.cm-line': {
    padding: '0 var(--page-x)',
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
  '.cm-scroller': { fontFamily: 'var(--font-prose)', overflow: 'auto' },
} as const;

const workspaceBase = EditorView.theme({ ...themeSpec }, { dark: false });

const highlight = HighlightStyle.define([
  {
    tag: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4],
    color: 'var(--text-primary)',
    fontWeight: '650',
  },
  { tag: t.strong, color: 'var(--text-primary)', fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: [t.link, t.url], color: 'var(--accent-strong)', textDecoration: 'underline' },
  { tag: t.monospace, color: 'var(--success)' },
  { tag: t.list, color: 'var(--text-secondary)' },
  { tag: t.quote, color: 'var(--text-secondary)', fontStyle: 'italic' },
  { tag: t.comment, color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--text-muted)' },
  // Markdown punctuation stays visible but restrained (spec §13.2).
  { tag: [t.processingInstruction, t.meta], color: 'var(--text-faint)' },
  { tag: [t.squareBracket, t.bracket], color: 'var(--text-muted)' },
]);

/** Calm workspace editor theme (light shell). */
export const editorTheme: Extension = [workspaceBase, syntaxHighlighting(highlight)];
