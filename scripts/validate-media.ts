/**
 * Media validator CLI (spec §18.4, §20.2). Loads a character's manifest, checks
 * it against the files on disk and the library quality rules, and prints a
 * report. Exits non-zero when any error is found so CI / `npm run media:validate`
 * fails the build. Run: `npm run media:validate -- [characterId]` (default: mira).
 */
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAppError } from '@shared/errors/app-error';
import type { MediaValidationIssue } from '@shared/domain';
import { loadManifest, validateManifest } from '../src/main/media/manifest-loader';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VIDEOS_ROOT = join(ROOT, 'videos');

function printIssues(label: string, issues: MediaValidationIssue[]): void {
  if (issues.length === 0) {
    return;
  }
  console.log(`\n${label} (${issues.length}):`);
  for (const issue of issues) {
    const where = issue.clipId ? ` [${issue.clipId}]` : '';
    console.log(`  - ${issue.code}${where}: ${issue.message}`);
  }
}

function main(): void {
  const characterId = process.argv[2] ?? 'mira';
  const charRoot = join(VIDEOS_ROOT, characterId);

  if (!existsSync(charRoot)) {
    console.error(`Character folder not found: ${relative(ROOT, charRoot)}`);
    process.exit(1);
  }

  let result;
  try {
    const manifest = loadManifest(charRoot);
    result = validateManifest(manifest, charRoot);
  } catch (error) {
    // A structural failure (missing/invalid manifest) is a hard error.
    const message = isAppError(error) ? error.message : String(error);
    console.error(`Failed to load manifest for "${characterId}": ${message}`);
    process.exit(1);
  }

  console.log(
    `Validated "${characterId}": ${result.listeningCount} listening, ` +
      `${result.speakingCount} speaking clips.`,
  );

  printIssues('Errors', result.errors);
  printIssues('Warnings', result.warnings);

  if (!result.ok) {
    console.error(`\nFAIL: ${result.errors.length} error(s) found.`);
    process.exit(1);
  }

  console.log(
    result.warnings.length > 0
      ? `\nOK (with ${result.warnings.length} warning(s)).`
      : '\nOK.',
  );
}

main();
