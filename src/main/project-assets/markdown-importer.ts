import { basename, extname } from 'node:path';
import { PROJECT_SOURCE_LIMITS, isAllowedMarkdownExtension } from '@shared/constants/project-source-limits';
import type {
  ImportedMarkdownDocument,
  ImportMarkdownDocumentsResult,
  MarkdownImportFailure,
} from '@shared/domain';

/**
 * Pure, Electron-free Markdown import core (spec §14.3, §16.2). Decodes already-
 * read file bytes into normalized source documents and structured per-file
 * failures, so the import rules are unit-testable without the native dialog or
 * the filesystem. The caller (AppController) owns path handling and only ever
 * passes/returns basenames — absolute paths never reach this layer.
 */

/**
 * Generous byte ceiling used as a pre-read guard against pathologically large
 * files. The authoritative limit is the decoded character count; a UTF-8
 * character is 1–4 bytes, so this never false-rejects a within-limit document.
 */
export const MAX_IMPORT_BYTES = PROJECT_SOURCE_LIMITS.maxCharactersPerDocument * 4;

/** The NUL control character; its presence marks binary (non-text) content. */
const NUL_CHARACTER = String.fromCharCode(0);
const BOM_CHARACTER = String.fromCharCode(0xfeff);

function failure(
  filename: string,
  code: MarkdownImportFailure['code'],
  message: string,
): MarkdownImportFailure {
  return { filename, code, message };
}

/** Discriminate the union returned by {@link decodeMarkdownFile}. */
export function isImportFailure(
  value: ImportedMarkdownDocument | MarkdownImportFailure,
): value is MarkdownImportFailure {
  return 'code' in value;
}

/**
 * Decode one file's bytes into a normalized Markdown document, or a structured
 * failure. Re-checks the extension (native dialog filters are not a security
 * boundary), decodes UTF-8 strictly, strips a leading BOM, rejects NUL bytes,
 * normalizes CRLF/CR to LF, and enforces the per-document character cap.
 */
export function decodeMarkdownFile(
  filename: string,
  buffer: Uint8Array,
): ImportedMarkdownDocument | MarkdownImportFailure {
  const name = basename(filename);

  if (!isAllowedMarkdownExtension(name)) {
    return failure(name, 'unsupported_extension', 'Only .md and .markdown files can be imported.');
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return failure(name, 'invalid_utf8', 'The file is not valid UTF-8 text.');
  }

  // Strip a leading UTF-8 BOM, then guard against binary content.
  if (text.startsWith(BOM_CHARACTER)) text = text.slice(1);
  if (text.includes(NUL_CHARACTER)) {
    return failure(name, 'contains_nul', 'The file contains binary (NUL) data.');
  }

  // Normalize CRLF and lone CR to LF.
  text = text.replace(/\r\n?/g, '\n');

  if (text.length > PROJECT_SOURCE_LIMITS.maxCharactersPerDocument) {
    return failure(name, 'too_large', 'The file exceeds the maximum source size.');
  }

  const ext = extname(name).toLowerCase();
  return {
    title: basename(name, ext),
    originalFilename: name,
    mimeType: 'text/markdown',
    content: text,
    sizeBytes: buffer.byteLength,
    characterCount: text.length,
  };
}

/**
 * Decode a batch of already-read files in selection order, collecting
 * successes and per-file failures separately. One bad file never aborts the
 * batch (spec §10.4, §19).
 */
export function importMarkdownBuffers(
  files: ReadonlyArray<{ filename: string; buffer: Uint8Array }>,
): ImportMarkdownDocumentsResult {
  const documents: ImportedMarkdownDocument[] = [];
  const failures: MarkdownImportFailure[] = [];

  for (const file of files) {
    const result = decodeMarkdownFile(file.filename, file.buffer);
    if (isImportFailure(result)) failures.push(result);
    else documents.push(result);
  }

  return { documents, failures };
}
