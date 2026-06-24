import { useMemo } from 'react';
import type { ReactNode } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { candidCueEditorTheme } from './codemirror-theme';
import styles from './MarkdownEditor.module.css';

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  minHeight?: string;
  placeholder?: string;
  readOnly?: boolean;
  /**
   * Optional chrome rendered as a header strip inside the editor surface, above
   * the content — e.g. an integrated title bar — so the title and the editor
   * read as one composed code-editor panel that shares a single focus ring.
   */
  header?: ReactNode;
  /**
   * Full-bleed mode: drops the surface's own border, radius, and focus ring so
   * the editor fills its container edge-to-edge (the host panel supplies the
   * frame). Avoids a "border inside a border" when embedded in a bordered pane.
   */
  flush?: boolean;
}

/**
 * A real CodeMirror markdown editor used for every prose surface (project
 * source, reference docs, notes to the interviewer, transcript editing). Wraps
 * @uiw/react-codemirror with the markdown language and a theme built from the
 * application design tokens so the editing surface matches the rest of the UI.
 */
export function MarkdownEditor({
  value,
  onChange,
  ariaLabel,
  minHeight = '160px',
  placeholder,
  readOnly = false,
  header,
  flush = false,
}: MarkdownEditorProps): JSX.Element {
  const extensions = useMemo<Extension[]>(
    () => [markdown(), EditorView.lineWrapping, EditorView.contentAttributes.of({ 'aria-label': ariaLabel })],
    [ariaLabel],
  );

  return (
    <div className={[styles.editor, flush ? styles.editorFlush : null].filter(Boolean).join(' ')}>
      {header != null && <div className={styles.header}>{header}</div>}
      <CodeMirror
        className={styles.cmRoot}
        value={value}
        theme={candidCueEditorTheme}
        extensions={extensions}
        minHeight={minHeight}
        readOnly={readOnly}
        placeholder={placeholder}
        basicSetup={{
          lineNumbers: false,
          foldGutter: false,
          highlightActiveLine: false,
          highlightActiveLineGutter: false,
        }}
        onChange={onChange}
      />
    </div>
  );
}
