import { useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import styles from './MarkdownEditor.module.css';

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  minHeight?: string;
  placeholder?: string;
  readOnly?: boolean;
}

/**
 * A real CodeMirror markdown editor used for every prose surface (project
 * source, reference docs, notes to the interviewer, transcript editing). Wraps
 * @uiw/react-codemirror with the markdown language and the oneDark theme so the
 * editing surface matches the dark production aesthetic.
 */
export function MarkdownEditor({
  value,
  onChange,
  ariaLabel,
  minHeight = '160px',
  placeholder,
  readOnly = false,
}: MarkdownEditorProps): JSX.Element {
  const extensions = useMemo<Extension[]>(
    () => [markdown(), EditorView.lineWrapping, EditorView.contentAttributes.of({ 'aria-label': ariaLabel })],
    [ariaLabel],
  );

  return (
    <div className={styles.editor}>
      <CodeMirror
        value={value}
        theme={oneDark}
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
