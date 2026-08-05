import { describe, it, expect } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// The release gate itself is scripts/legal-gate.mjs, and it is meant to FAIL
// until the placeholders are resolved, so it cannot live in this suite. What
// can live here is the part that must be true every day: the register in
// legal/PLACEHOLDERS.md and the tokens actually used in the documents must
// describe the same set, and the documents must still be there to describe.
//
// The raw `rg` procedure this replaces succeeds by finding nothing, which is
// also what it does when a document has been deleted or emptied. These
// assertions fail in that case instead.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const LEGAL_DOCS = [
  'LICENSE',
  'legal/EULA.md',
  'legal/PRIVACY_POLICY.md',
  'legal/REFUND_POLICY.md',
];

// Files a placeholder token is allowed to appear in before release. The
// register is excluded: naming the tokens is its job.
const TOKEN_SOURCES = [
  ...LEGAL_DOCS,
  'README.md',
  'package.json',
  'src-tauri/tauri.conf.json',
];

const REGISTER = 'legal/PLACEHOLDERS.md';

// A published document is never this short. This is a floor against a file
// being emptied or truncated, not a quality bar.
const MIN_DOC_BYTES = 500;

const read = (relPath: string) => readFileSync(join(repoRoot, relPath), 'utf8');

const usedTokens = (): Map<string, string[]> => {
  const found = new Map<string, string[]>();
  for (const relPath of TOKEN_SOURCES) {
    for (const match of read(relPath).matchAll(/@@(LEGAL_[A-Z0-9_]+)@@/g)) {
      const token = match[1];
      if (!token) continue;
      const where = found.get(token) ?? [];
      if (!where.includes(relPath)) where.push(relPath);
      found.set(token, where);
    }
  }
  return found;
};

// Declarations are the backticked identifiers in the register's tables, e.g.
// `LEGAL_SUPPORT_EMAIL`. The register also contains the literal example
// `@@LEGAL_SOMETHING@@`, which this pattern deliberately does not match.
const declaredTokens = (): Set<string> => {
  const declared = new Set<string>();
  for (const match of read(REGISTER).matchAll(/`(LEGAL_[A-Z0-9_]+)`/g)) {
    const token = match[1];
    if (token) declared.add(token);
  }
  return declared;
};

describe('legal documents', () => {
  it.each(LEGAL_DOCS)('%s exists and is a real document', (relPath) => {
    let bytes: number;
    try {
      bytes = statSync(join(repoRoot, relPath)).size;
    } catch {
      throw new Error(
        `${relPath} is missing. Deleting it would make the placeholder gate ` +
          `(scripts/legal-gate.mjs) pass MORE quietly, not less — restore the ` +
          `document, or remove it from LEGAL_DOCS here and in the gate together.`
      );
    }
    expect(
      bytes,
      `${relPath} is only ${bytes} bytes. A published legal document is never ` +
        `this short; something has truncated or emptied it.`
    ).toBeGreaterThan(MIN_DOC_BYTES);
  });

  it('the placeholder register declares tokens', () => {
    const declared = declaredTokens();
    expect(
      declared.size,
      `${REGISTER} declares no LEGAL_* identifiers. Either the register was ` +
        `emptied or its table format changed and the match pattern in this ` +
        `test has rotted. Until this is non-empty, the drift check below ` +
        `would pass vacuously.`
    ).toBeGreaterThan(0);
  });

  it('every placeholder used in the documents is declared in the register', () => {
    const used = usedTokens();
    const declared = declaredTokens();

    const undeclared = [...used.keys()]
      .filter((token) => !declared.has(token))
      .sort();

    expect(
      undeclared,
      `These placeholders appear in the documents but are not declared in ` +
        `${REGISTER}:\n` +
        undeclared
          .map((token) => `  @@${token}@@ — used in ${used.get(token)!.join(', ')}`)
          .join('\n') +
        `\nAdd a row for each to the register, saying what it is and where to ` +
        `get its value. Nobody can clear the gate for a token nothing explains.`
    ).toEqual([]);
  });

  it('every placeholder declared in the register is used somewhere', () => {
    const used = usedTokens();
    const declared = declaredTokens();

    const unused = [...declared].filter((token) => !used.has(token)).sort();

    expect(
      unused,
      `These placeholders are declared in ${REGISTER} but appear in none of ` +
        `${TOKEN_SOURCES.join(', ')}:\n` +
        unused.map((token) => `  ${token}`).join('\n') +
        `\nEither a document dropped the token (and now states something as ` +
        `fact that was meant to be filled in), or the register kept a row for ` +
        `a placeholder that no longer exists. Fix whichever it is; do not ` +
        `delete the assertion.`
    ).toEqual([]);
  });
});
