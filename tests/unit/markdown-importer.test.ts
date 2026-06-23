import { describe, expect, it } from 'vitest';
import {
  decodeMarkdownFile,
  importMarkdownBuffers,
  isImportFailure,
} from '@main/project-assets/markdown-importer';
import { PROJECT_SOURCE_LIMITS } from '@shared/constants/project-source-limits';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const NUL = String.fromCharCode(0);

describe('decodeMarkdownFile', () => {
  it('decodes a .md file into a normalized document', () => {
    const result = decodeMarkdownFile('brief.md', enc('# Hello'));
    expect(isImportFailure(result)).toBe(false);
    if (isImportFailure(result)) return;
    expect(result.title).toBe('brief');
    expect(result.originalFilename).toBe('brief.md');
    expect(result.mimeType).toBe('text/markdown');
    expect(result.content).toBe('# Hello');
    expect(result.characterCount).toBe('# Hello'.length);
    expect(result.sizeBytes).toBe(enc('# Hello').byteLength);
  });

  it('accepts the .markdown extension and uppercase extensions', () => {
    expect(isImportFailure(decodeMarkdownFile('notes.markdown', enc('x')))).toBe(false);
    expect(isImportFailure(decodeMarkdownFile('NOTES.MD', enc('x')))).toBe(false);
    expect(isImportFailure(decodeMarkdownFile('NOTES.MARKDOWN', enc('x')))).toBe(false);
  });

  it('rejects unsupported extensions', () => {
    for (const name of ['notes.txt', 'doc.pdf', 'README']) {
      const result = decodeMarkdownFile(name, enc('x'));
      expect(isImportFailure(result)).toBe(true);
      if (isImportFailure(result)) expect(result.code).toBe('unsupported_extension');
    }
  });

  it('rejects invalid UTF-8', () => {
    const result = decodeMarkdownFile('x.md', new Uint8Array([0xff, 0xff, 0xff]));
    expect(isImportFailure(result)).toBe(true);
    if (isImportFailure(result)) expect(result.code).toBe('invalid_utf8');
  });

  it('strips a leading UTF-8 BOM', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc('hello')]);
    const result = decodeMarkdownFile('x.md', withBom);
    expect(isImportFailure(result)).toBe(false);
    if (!isImportFailure(result)) expect(result.content).toBe('hello');
  });

  it('normalizes CRLF and lone CR to LF', () => {
    const result = decodeMarkdownFile('x.md', enc('a\r\nb\rc\nd'));
    expect(isImportFailure(result)).toBe(false);
    if (!isImportFailure(result)) expect(result.content).toBe('a\nb\nc\nd');
  });

  it('rejects content containing NUL bytes', () => {
    const result = decodeMarkdownFile('x.md', enc(`before${NUL}after`));
    expect(isImportFailure(result)).toBe(true);
    if (isImportFailure(result)) expect(result.code).toBe('contains_nul');
  });

  it('rejects content over the per-document character limit', () => {
    const big = enc('x'.repeat(PROJECT_SOURCE_LIMITS.maxCharactersPerDocument + 1));
    const result = decodeMarkdownFile('x.md', big);
    expect(isImportFailure(result)).toBe(true);
    if (isImportFailure(result)) expect(result.code).toBe('too_large');
  });

  it('accepts content exactly at the per-document character limit', () => {
    const exact = enc('x'.repeat(PROJECT_SOURCE_LIMITS.maxCharactersPerDocument));
    expect(isImportFailure(decodeMarkdownFile('x.md', exact))).toBe(false);
  });

  it('accepts an empty file as an empty document', () => {
    const result = decodeMarkdownFile('empty.md', enc(''));
    expect(isImportFailure(result)).toBe(false);
    if (!isImportFailure(result)) {
      expect(result.content).toBe('');
      expect(result.characterCount).toBe(0);
    }
  });

  it('accepts a file that is only a BOM as empty content', () => {
    const result = decodeMarkdownFile('bom.md', new Uint8Array([0xef, 0xbb, 0xbf]));
    expect(isImportFailure(result)).toBe(false);
    if (!isImportFailure(result)) expect(result.content).toBe('');
  });

  it('returns only the basename, never an absolute path', () => {
    const result = decodeMarkdownFile('/Users/someone/private/notes.md', enc('x'));
    expect(isImportFailure(result)).toBe(false);
    if (!isImportFailure(result)) {
      expect(result.originalFilename).toBe('notes.md');
      expect(result.title).toBe('notes');
    }
  });
});

describe('importMarkdownBuffers', () => {
  it('collects successes and per-file failures without one bad file aborting the batch', () => {
    const result = importMarkdownBuffers([
      { filename: 'one.md', buffer: enc('first') },
      { filename: 'skip.txt', buffer: enc('nope') },
      { filename: 'big.md', buffer: enc('x'.repeat(PROJECT_SOURCE_LIMITS.maxCharactersPerDocument + 1)) },
      { filename: 'two.markdown', buffer: enc('second') },
    ]);

    expect(result.documents.map((d) => d.originalFilename)).toEqual(['one.md', 'two.markdown']);
    expect(result.failures.map((f) => f.code)).toEqual(['unsupported_extension', 'too_large']);
  });

  it('preserves selection order for successful documents', () => {
    const result = importMarkdownBuffers([
      { filename: 'c.md', buffer: enc('3') },
      { filename: 'a.md', buffer: enc('1') },
      { filename: 'b.md', buffer: enc('2') },
    ]);
    expect(result.documents.map((d) => d.originalFilename)).toEqual(['c.md', 'a.md', 'b.md']);
    expect(result.failures).toHaveLength(0);
  });
});
