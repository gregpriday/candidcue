#!/usr/bin/env node
// `sx test [paths...] [vitest flags...]`: runs the named test files under the
// vitest project that owns them. tests/dom/** belongs to the jsdom project
// (vitest.dom.config.ts); every other path to the node project. Arguments that
// are not existing paths (`-t name`, `--reporter=dot`) go to every project that
// runs. With no paths, both projects run in full, as `pnpm test:all` does.
//
// Both projects run even when the first fails, and the exit status is the
// first non-zero one.
import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const PROJECTS = {
  node: [],
  dom: ['--config', 'vitest.dom.config.ts'],
};

const paths = { node: [], dom: [] };
const flags = [];
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('-') || !existsSync(arg)) {
    flags.push(arg);
    continue;
  }
  const rel = relative(process.cwd(), resolve(arg)).split('\\').join('/');
  (rel === 'tests/dom' || rel.startsWith('tests/dom/') ? paths.dom : paths.node).push(arg);
}

const named = paths.node.length + paths.dom.length > 0;
const runs = Object.keys(PROJECTS).filter((p) => !named || paths[p].length > 0);

let status = 0;
for (const project of runs) {
  const args = ['run', ...PROJECTS[project], ...paths[project], ...flags];
  console.log(`[test] vitest ${args.join(' ')}`);
  const result = spawnSync('./node_modules/.bin/vitest', args, { stdio: 'inherit' });
  const code = result.status ?? 1;
  if (code !== 0 && status === 0) status = code;
}
process.exit(status);
