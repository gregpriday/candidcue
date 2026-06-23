/**
 * Prompt validator CLI (spec §22). Runs `validatePrompts` against the repo's
 * `prompts/` directory, prints any problems, and exits non-zero on failure so it
 * can gate CI / `npm run verify`. Invoke: `npm run prompts:validate`.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validatePrompts } from '../src/main/prompts/validate';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PROMPTS_ROOT = join(ROOT, 'prompts');

function main(): void {
  const { ok, problems } = validatePrompts(PROMPTS_ROOT);

  if (ok) {
    console.log(`Prompt validation passed (${PROMPTS_ROOT}).`);
    return;
  }

  console.error(`Prompt validation FAILED (${PROMPTS_ROOT}):`);
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}

// Run only when executed directly so the module can be imported in tests
// without triggering process.exit.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
