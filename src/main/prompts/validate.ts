/**
 * Prompt validation (spec §22). Verifies that every prompt the runtime depends
 * on exists on disk, carries the required frontmatter metadata, and contains the
 * exact `{{placeholders}}` each prompt template is expected to fill at call time.
 *
 * This is a static check used by `npm run prompts:validate` and by tests, so a
 * missing field or a renamed placeholder fails the build instead of surfacing at
 * runtime as an unfilled template.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parsePrompt } from './prompt-loader';

/** Result of validating a prompts directory. */
export interface PromptValidationResult {
  /** True when every required prompt passed all checks. */
  ok: boolean;
  /** Human-readable description of each problem found (empty when ok). */
  problems: string[];
}

/**
 * Required prompt files (without the `.md` suffix) and the placeholder tokens
 * each must contain. `mira.system` is a pure system prompt with no templated
 * inputs, so its placeholder list is empty.
 */
const REQUIRED_PROMPTS: Record<string, readonly string[]> = {
  'mira.system': [],
  'project-preparation.system': [
    'targetQuestionCount',
    'toneOrDefault',
    'exclusionsOrNone',
    'compiledSource',
  ],
  'transcript-cleanup.system': ['glossaryJson', 'rawTranscript'],
  'endpoint-classifier.system': [
    'question',
    'transcript',
    'speechDurationMs',
    'silenceDurationMs',
    'mode',
  ],
  'question-repair.system': ['spokenText', 'maxWords', 'reason'],
};

/** Frontmatter fields every prompt must declare with a non-empty value. */
const REQUIRED_META_FIELDS = ['id', 'version', 'model_family', 'updated_at'] as const;

/**
 * Detect whether a `{{placeholder}}` token is present in the prompt body. The
 * loader fills tokens via `/\{\{(\w+)\}\}/g`, so the check mirrors that exact
 * shape (double braces, optional surrounding whitespace inside the braces is not
 * permitted by the loader and therefore not accepted here).
 */
function hasPlaceholder(body: string, token: string): boolean {
  return body.includes(`{{${token}}}`);
}

/**
 * The parsed frontmatter is normalised by `parsePrompt`, but a missing field is
 * represented by a sentinel ("unknown"/"0.0.0"/""). To validate the *raw*
 * frontmatter we re-extract the keys directly so a prompt that simply omits
 * `version` is reported, rather than silently passing on the default.
 */
function rawFrontmatterKeys(raw: string): Set<string> {
  const keys = new Set<string>();
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return keys;
  for (const line of (match[1] ?? '').split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key && value) keys.add(key);
  }
  return keys;
}

/**
 * Validate every required prompt under `promptsRoot`.
 *
 * For each prompt this checks, in order:
 *   1. the file exists,
 *   2. it has a parseable `---` frontmatter block,
 *   3. it declares non-empty `id`, `version`, `model_family`, `updated_at`,
 *   4. it contains every required `{{placeholder}}`.
 *
 * Problems are accumulated rather than thrown so a single run reports all
 * issues at once.
 */
export function validatePrompts(promptsRoot: string): PromptValidationResult {
  const problems: string[] = [];

  for (const name of Object.keys(REQUIRED_PROMPTS)) {
    const placeholders = REQUIRED_PROMPTS[name] ?? [];
    const file = join(promptsRoot, `${name}.md`);

    if (!existsSync(file)) {
      problems.push(`${name}: missing prompt file (expected ${name}.md)`);
      continue;
    }

    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      problems.push(`${name}: could not read prompt file (${reason})`);
      continue;
    }

    // Frontmatter must be a real `---` block, not the loader's fallback.
    if (!/^---\n[\s\S]*?\n---/.test(raw)) {
      problems.push(`${name}: missing or malformed frontmatter block`);
      continue;
    }

    const declared = rawFrontmatterKeys(raw);
    for (const field of REQUIRED_META_FIELDS) {
      if (!declared.has(field)) {
        problems.push(`${name}: frontmatter is missing required field "${field}"`);
      }
    }

    const { body } = parsePrompt(raw);
    for (const token of placeholders) {
      if (!hasPlaceholder(body, token)) {
        problems.push(`${name}: missing required placeholder {{${token}}}`);
      }
    }
  }

  return { ok: problems.length === 0, problems };
}
