/**
 * Temp cleanup CLI (spec §21). Removes the CandidCue session temp directory's
 * contents — scratch audio/video, partial transcripts, and other per-session
 * working files. Invoke: `npm run clean:temp`.
 *
 * Safety: every deletion is constrained to entries directly under the resolved
 * temp root (`<os.tmpdir()>/candidcue-temp`). The helper refuses to operate on
 * any path that resolves outside that root so a misconfigured root can never
 * recurse into the real system temp directory or beyond.
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/** Subdirectory under the OS temp dir used for all CandidCue session scratch. */
const TEMP_DIR_NAME = 'candidcue-temp';

/** Resolve the absolute path of the CandidCue temp root. */
export function getTempRoot(): string {
  return join(tmpdir(), TEMP_DIR_NAME);
}

/** Options controlling what `cleanTempDir` removes. */
export interface CleanTempOptions {
  /**
   * When set, only entries last modified strictly before this epoch-ms value
   * are removed. When omitted, every entry under the root is removed.
   */
  olderThanMs?: number;
}

/** Outcome of a cleanup pass. */
export interface CleanTempResult {
  /** Number of top-level entries (files or directories) removed. */
  removed: number;
  /** True when the temp root did not exist and there was nothing to do. */
  rootMissing: boolean;
}

/**
 * True when `child` resolves to a path strictly inside `root`. Used to guard
 * every deletion against escaping the temp root via `..`, symlinks, or an
 * unexpected root value.
 */
function isInside(root: string, child: string): boolean {
  const r = resolve(root);
  const c = resolve(child);
  return c !== r && c.startsWith(r + sep);
}

/**
 * Remove the contents of the temp `root`. The root directory itself is left in
 * place so a subsequent session can reuse it. Returns how many top-level
 * entries were removed.
 *
 * @throws if `root` does not resolve to a path named after the temp dir; this
 *   prevents accidentally pointing the cleaner at an arbitrary directory.
 */
export function cleanTempDir(root: string, opts: CleanTempOptions = {}): CleanTempResult {
  const resolvedRoot = resolve(root);

  // Hard guard: refuse to clean anything that is not the CandidCue temp root.
  // We never want a typo or bad env to trigger a wide deletion.
  if (!resolvedRoot.endsWith(sep + TEMP_DIR_NAME) && !resolvedRoot.endsWith(TEMP_DIR_NAME)) {
    throw new Error(
      `Refusing to clean "${resolvedRoot}": not a ${TEMP_DIR_NAME} directory`,
    );
  }

  if (!existsSync(resolvedRoot)) {
    return { removed: 0, rootMissing: true };
  }

  let removed = 0;
  for (const name of readdirSync(resolvedRoot)) {
    const entry = join(resolvedRoot, name);

    // Second guard: every entry must resolve inside the root before removal.
    if (!isInside(resolvedRoot, entry)) continue;

    if (opts.olderThanMs !== undefined) {
      let mtimeMs: number;
      try {
        mtimeMs = statSync(entry).mtimeMs;
      } catch {
        // Entry vanished between readdir and stat — nothing to remove.
        continue;
      }
      if (mtimeMs >= opts.olderThanMs) continue;
    }

    rmSync(entry, { recursive: true, force: true });
    removed += 1;
  }

  return { removed, rootMissing: false };
}

function main(): void {
  const root = getTempRoot();

  // Optional `--older-than-ms <n>` flag removes only entries older than `n`
  // epoch-ms; without it, all session scratch is cleared.
  let olderThanMs: number | undefined;
  const flagIdx = process.argv.indexOf('--older-than-ms');
  if (flagIdx !== -1) {
    const raw = process.argv[flagIdx + 1];
    const parsed = Number(raw);
    if (raw === undefined || !Number.isFinite(parsed)) {
      console.error('Invalid --older-than-ms value; expected a number.');
      process.exit(1);
    }
    olderThanMs = parsed;
  }

  const { removed, rootMissing } = cleanTempDir(root, olderThanMs !== undefined ? { olderThanMs } : {});

  if (rootMissing) {
    console.log(`Temp root ${root} does not exist; nothing to clean.`);
    return;
  }
  console.log(`Removed ${removed} entr${removed === 1 ? 'y' : 'ies'} from ${root}.`);
}

// Run the CLI only when executed directly (tsx / node), not when imported by
// tests that exercise the exported helpers.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
