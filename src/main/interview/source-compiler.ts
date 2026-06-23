import { AppError } from '@shared/errors/app-error';

/** A single document fed into the project source envelope. */
export interface SourceCompilerDocument {
  id: string;
  kind: 'primary' | 'reference';
  title: string;
  content: string;
}

const ENVELOPE_VERSION = '1';

/**
 * Neutralize XML-like sequences in free text so imported content cannot forge
 * envelope tags (e.g. a literal `</DOCUMENT>`) or otherwise inject structure.
 * Angle brackets are mapped to the visually similar single-angle-quote glyphs
 * `‹` / `›`, which carry no XML meaning.
 */
function neutralizeContent(text: string): string {
  return text.replace(/</g, '‹').replace(/>/g, '›');
}

/**
 * Sanitize an attribute value: neutralize angle brackets (consistent with
 * content) and escape double-quotes so the value cannot terminate the
 * attribute or smuggle extra attributes/markup.
 */
function neutralizeAttribute(value: string): string {
  return neutralizeContent(value).replace(/"/g, '&quot;');
}

/** Normalize CRLF and lone CR line endings to LF. */
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/**
 * Render document content as 1-based, sequentially numbered lines in the
 * form `N| <line>`. A trailing newline does not produce a spurious empty
 * final line.
 */
function numberLines(content: string): string {
  const normalized = normalizeLineEndings(content);
  // Drop a single trailing newline so "a\nb\n" yields two lines, not three.
  const body = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  const lines = body.length === 0 ? [''] : body.split('\n');
  return lines.map((line, i) => `${i + 1}| ${neutralizeContent(line)}`).join('\n');
}

/**
 * Compile project documents into the CandidCue project source envelope
 * (spec §16.3). Each document is wrapped in a `<DOCUMENT>` element with
 * neutralized attributes and line-numbered, neutralized content so that
 * imported text can never forge envelope structure or inject instructions.
 *
 * @throws AppError(VALIDATION_FAILED) when `docs` is empty.
 */
export function compileProjectSource(docs: SourceCompilerDocument[]): string {
  if (docs.length === 0) {
    throw new AppError('VALIDATION_FAILED', {
      message: 'compileProjectSource requires at least one document',
      publicMessage: 'No documents were provided to compile.',
    });
  }

  const blocks = docs.map((doc) => {
    const id = neutralizeAttribute(doc.id);
    const kind = neutralizeAttribute(doc.kind);
    const title = neutralizeAttribute(doc.title);
    const body = numberLines(doc.content);
    return [`  <DOCUMENT id="${id}" kind="${kind}" title="${title}">`, body, `  </DOCUMENT>`].join(
      '\n',
    );
  });

  return [
    `<CANDIDCUE_PROJECT_SOURCE version="${ENVELOPE_VERSION}">`,
    ...blocks,
    `</CANDIDCUE_PROJECT_SOURCE>`,
  ].join('\n');
}
