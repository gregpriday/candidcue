import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readdirSync,
  existsSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validatePrompts } from '../../src/main/prompts/validate';
import { loadPrompt } from '../../src/main/prompts/prompt-loader';
import { CURRENT_PROMPT_VERSION } from '../../src/main/app-controller';
import { cleanTempDir, getTempRoot } from '../../scripts/clean-temp';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REAL_PROMPTS = join(REPO_ROOT, 'prompts');

/** Minimal frontmatter helper for synthetic prompt fixtures. */
function frontmatter(id: string): string {
  return [
    '---',
    `id: ${id}`,
    'version: 1.0.0',
    'model_family: gpt-test',
    'updated_at: 2026-06-23',
    '---',
    '',
  ].join('\n');
}

/**
 * Build a complete, valid prompt set under `dir` so individual tests can corrupt
 * one file at a time and assert the specific failure.
 */
function writeValidPromptSet(dir: string): void {
  writeFileSync(join(dir, 'mira.system.md'), `${frontmatter('mira-runtime')}You are Mira.\n`);
  writeFileSync(
    join(dir, 'project-preparation.system.md'),
    `${frontmatter('project-preparation')}` +
      'Framing: {{titleOrInferred}} {{audienceOrInferred}} {{intendedOutcomeOrInferred}}\n' +
      'Target: {{targetQuestionCount}} {{toneOrDefault}} {{exclusionsOrNone}}\n{{compiledSource}}\n',
  );
  writeFileSync(
    join(dir, 'transcript-cleanup.system.md'),
    `${frontmatter('transcript-cleanup')}{{glossaryJson}}\n{{rawTranscript}}\n`,
  );
  writeFileSync(
    join(dir, 'endpoint-classifier.system.md'),
    `${frontmatter('endpoint-classifier')}` +
      '{{question}} {{transcript}} {{speechDurationMs}} {{silenceDurationMs}} {{mode}}\n',
  );
  writeFileSync(
    join(dir, 'question-repair.system.md'),
    `${frontmatter('question-repair')}{{spokenText}} {{maxWords}} {{reason}}\n`,
  );
}

describe('validatePrompts (real prompts)', () => {
  it('passes against the real prompts directory', () => {
    const result = validatePrompts(REAL_PROMPTS);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe('project-preparation prompt (issue #64)', () => {
  it('still seeds the launch-video coverage beats', () => {
    // validatePrompts only checks frontmatter + placeholder tokens, so without
    // this guard the launch-video section could be deleted silently. The beats
    // are the whole point of issue #64, so assert they remain in the body.
    const { body } = loadPrompt('project-preparation.system', REAL_PROMPTS);
    expect(body).toContain('LAUNCH VIDEO COVERAGE BEATS');
    for (const beat of [
      'origin story',
      'founding insight',
      'wedge versus competitors',
      'customer or traction story',
      'demo aha-moment',
      'viewer takeaway',
    ]) {
      expect(body).toContain(beat);
    }
  });

  it('keeps the prompt frontmatter version in sync with CURRENT_PROMPT_VERSION', () => {
    // The controller stamps plans with CURRENT_PROMPT_VERSION and the preflight
    // gate compares against it, but the version is hardcoded (the loader strips
    // frontmatter). If the constant and the file drift, plans get stamped with a
    // version that never matches the prompt they were prepared under.
    const { meta } = loadPrompt('project-preparation.system', REAL_PROMPTS);
    expect(meta.version).toBe(CURRENT_PROMPT_VERSION);
  });
});

describe('validatePrompts (synthetic fixtures)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'candidcue-prompts-test-'));
    writeValidPromptSet(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('passes when every required prompt is well-formed', () => {
    const result = validatePrompts(dir);
    expect(result).toEqual({ ok: true, problems: [] });
  });

  it('fails with a helpful message when a required placeholder is missing', () => {
    // Drop {{rawTranscript}} from transcript-cleanup.
    writeFileSync(
      join(dir, 'transcript-cleanup.system.md'),
      `${frontmatter('transcript-cleanup')}{{glossaryJson}}\nno transcript token here\n`,
    );

    const result = validatePrompts(dir);
    expect(result.ok).toBe(false);
    expect(result.problems).toContain(
      'transcript-cleanup.system: missing required placeholder {{rawTranscript}}',
    );
    // Other prompts are still fine, so only the one problem is reported.
    expect(result.problems).toHaveLength(1);
  });

  it('reports every missing placeholder across prompts', () => {
    writeFileSync(
      join(dir, 'project-preparation.system.md'),
      `${frontmatter('project-preparation')}only {{targetQuestionCount}} here\n`,
    );

    const result = validatePrompts(dir);
    expect(result.ok).toBe(false);
    expect(result.problems).toContain(
      'project-preparation.system: missing required placeholder {{titleOrInferred}}',
    );
    expect(result.problems).toContain(
      'project-preparation.system: missing required placeholder {{audienceOrInferred}}',
    );
    expect(result.problems).toContain(
      'project-preparation.system: missing required placeholder {{intendedOutcomeOrInferred}}',
    );
    expect(result.problems).toContain(
      'project-preparation.system: missing required placeholder {{toneOrDefault}}',
    );
    expect(result.problems).toContain(
      'project-preparation.system: missing required placeholder {{exclusionsOrNone}}',
    );
    expect(result.problems).toContain(
      'project-preparation.system: missing required placeholder {{compiledSource}}',
    );
  });

  it('does not require placeholders for mira.system', () => {
    // mira.system intentionally has no template tokens; the valid set already
    // reflects this, so the set passes.
    expect(validatePrompts(dir).ok).toBe(true);
  });

  it('fails when a required prompt file is missing', () => {
    rmSync(join(dir, 'question-repair.system.md'));

    const result = validatePrompts(dir);
    expect(result.ok).toBe(false);
    expect(result.problems).toContain(
      'question-repair.system: missing prompt file (expected question-repair.system.md)',
    );
  });

  it('fails when frontmatter is missing a required field', () => {
    // Write a frontmatter block that omits `version`.
    writeFileSync(
      join(dir, 'mira.system.md'),
      ['---', 'id: mira-runtime', 'model_family: gpt-test', 'updated_at: 2026-06-23', '---', '', 'Body'].join('\n'),
    );

    const result = validatePrompts(dir);
    expect(result.ok).toBe(false);
    expect(result.problems).toContain(
      'mira.system: frontmatter is missing required field "version"',
    );
  });

  it('fails when a frontmatter field is present but empty', () => {
    writeFileSync(
      join(dir, 'mira.system.md'),
      ['---', 'id: mira-runtime', 'version:', 'model_family: gpt-test', 'updated_at: 2026-06-23', '---', '', 'Body'].join('\n'),
    );

    const result = validatePrompts(dir);
    expect(result.ok).toBe(false);
    expect(result.problems).toContain(
      'mira.system: frontmatter is missing required field "version"',
    );
  });

  it('fails when the frontmatter block is absent entirely', () => {
    writeFileSync(join(dir, 'mira.system.md'), 'No frontmatter, just a body.\n');

    const result = validatePrompts(dir);
    expect(result.ok).toBe(false);
    expect(result.problems).toContain('mira.system: missing or malformed frontmatter block');
  });
});

describe('getTempRoot', () => {
  it('resolves under the OS temp dir and is named candidcue-temp', () => {
    const root = getTempRoot();
    expect(root.startsWith(tmpdir())).toBe(true);
    expect(root.endsWith('candidcue-temp')).toBe(true);
  });
});

describe('cleanTempDir', () => {
  let root: string;

  beforeEach(() => {
    // Use a real candidcue-temp directory inside a unique sandbox so the safety
    // guard (which requires the path to be named candidcue-temp) is satisfied
    // without touching the shared system temp root.
    const sandbox = mkdtempSync(join(tmpdir(), 'candidcue-clean-test-'));
    root = join(sandbox, 'candidcue-temp');
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reports rootMissing when the directory does not exist', () => {
    rmSync(root, { recursive: true, force: true });
    const result = cleanTempDir(root);
    expect(result).toEqual({ removed: 0, rootMissing: true });
  });

  it('removes all entries but leaves the root in place', () => {
    writeFileSync(join(root, 'a.tmp'), 'one');
    writeFileSync(join(root, 'b.tmp'), 'two');
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'nested', 'c.tmp'), 'three');

    const result = cleanTempDir(root);

    expect(result.rootMissing).toBe(false);
    expect(result.removed).toBe(3); // a.tmp, b.tmp, nested/
    expect(existsSync(root)).toBe(true);
    expect(readdirSync(root)).toEqual([]);
  });

  it('only removes entries older than olderThanMs', () => {
    const oldFile = join(root, 'old.tmp');
    const newFile = join(root, 'new.tmp');
    writeFileSync(oldFile, 'old');
    writeFileSync(newFile, 'new');

    // Backdate the old file well into the past. utimesSync takes seconds.
    const past = Date.now() - 60_000;
    utimesSync(oldFile, past / 1000, past / 1000);

    const cutoff = Date.now() - 30_000;
    const result = cleanTempDir(root, { olderThanMs: cutoff });

    expect(result.removed).toBe(1);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(newFile)).toBe(true);
  });

  it('refuses to clean a directory that is not named candidcue-temp', () => {
    const bogus = mkdtempSync(join(tmpdir(), 'candidcue-not-temp-'));
    try {
      expect(() => cleanTempDir(bogus)).toThrow(/Refusing to clean/);
    } finally {
      rmSync(bogus, { recursive: true, force: true });
    }
  });
});
