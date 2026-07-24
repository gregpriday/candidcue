/**
 * The compiler runs inside a Web Worker, where there is no `document`.
 *
 * `decode-named-character-reference` (reached via remark-parse → micromark)
 * ships two builds and picks between them with export conditions: `browser`
 * resolves to `index.dom.js`, which evaluates `document.createElement('i')` at
 * module top level, while `worker`/`default` resolve to `index.js`, a pure
 * lookup table.
 *
 * Vite's dev server pre-bundles dependencies once for the client under the
 * `browser` condition, and the compiler worker imports that same optimized
 * bundle — so it threw `ReferenceError: document is not defined` on import and
 * *no script could be opened at all* under `pnpm tauri dev`. The production
 * build resolved `index.js` correctly, so the packaged bundle looked clean
 * while the everyday development path was completely broken. That asymmetry is
 * why this is guarded here rather than trusted to a build inspection.
 *
 * `vite.config.ts` pins the DOM-free build with a `resolve.alias`. These tests
 * assert the two things that must hold for the worker to survive: the alias
 * exists, and whatever it points at never touches the DOM.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGE = 'decode-named-character-reference';

function viteConfigSource(): string {
  return readFileSync(fileURLToPath(new URL('../../vite.config.ts', import.meta.url)), 'utf8');
}

async function resolvedAliasTarget(): Promise<string> {
  const config = (await import('../../vite.config')) as {
    default: { resolve?: { alias?: Array<{ find: RegExp | string; replacement: string }> } };
  };
  const aliases = config.default.resolve?.alias ?? [];
  const match = aliases.find((entry) =>
    entry.find instanceof RegExp ? entry.find.test(PACKAGE) : entry.find === PACKAGE,
  );
  expect(
    match,
    `vite.config.ts must alias ${PACKAGE} to its DOM-free build, or the compiler ` +
      'worker throws "document is not defined" in dev and no script can be opened',
  ).toBeDefined();
  return match!.replacement;
}

describe('compiler worker DOM safety', () => {
  it('aliases decode-named-character-reference to a build that exists', async () => {
    const target = await resolvedAliasTarget();
    // The resolver throws on a miss rather than silently skipping the alias,
    // so reaching here means it found a real file — assert that explicitly.
    expect(() => readFileSync(target, 'utf8')).not.toThrow();
  });

  it('resolves to the lookup-table build, never the DOM build', async () => {
    const target = await resolvedAliasTarget();
    const source = readFileSync(target, 'utf8');

    // The precise construct that broke the worker: a top-level DOM call.
    expect(source).not.toContain('document.createElement');
    // Nothing in this module may reach for the DOM at all.
    expect(source).not.toMatch(/\bdocument\b/);
    expect(target.endsWith('index.dom.js')).toBe(false);

    // Guard on the guard: if the package is ever restructured so the target is
    // an empty or stub file, the assertions above would pass vacuously.
    expect(source.length).toBeGreaterThan(100);
    expect(source).toMatch(/export/);
  });

  it('documents why the alias exists, so it is not removed as dead config', () => {
    const config = viteConfigSource();
    expect(config).toContain(PACKAGE);
    expect(config).toContain('document is not defined');
  });
});
