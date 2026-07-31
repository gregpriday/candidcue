/**
 * The fetch script's safety properties, without the network.
 *
 * `scripts/fetch-stt-model.sh` is the one place a third party's bytes become
 * files this build ships. Before issue #154 it verified nothing: it hotlinked a
 * mutable release tag and trusted whatever came back, and it treated a file
 * merely EXISTING as proof the install was good. Both are the kind of failure
 * that never shows up in a green suite — the app builds, installs, and
 * mistranscribes, or does not transcribe at all.
 *
 * The real archives are 57–161 MB, so these tests build a tiny `.tar.bz2` and a
 * throwaway catalogue that points at it over `file://`, and run the actual
 * shipping script against them. That exercises the real download → verify →
 * unpack path rather than a re-implementation of it.
 *
 * What is deliberately NOT covered: the shipped app fetching a model at
 * runtime. Nothing does that yet — the model is still bundled as a Tauri
 * resource, and the in-app downloader is issue #152.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../..');
const SCRIPT = join(REPO_ROOT, 'scripts/fetch-stt-model.sh');
const HELPER = join(REPO_ROOT, 'scripts/model-catalogue.mjs');

const ARCHIVE_ROOT = 'test-model-1970-01-01';
const MODEL_FILES: Record<string, string> = {
  'encoder.onnx': 'not really an onnx graph, but it hashes like one\n',
  'decoder.onnx': 'decoder bytes\n',
  'joiner.onnx': 'joiner bytes\n',
  'tokens.txt': '<blk> 0\na 1\nb 2\n',
};

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

let work: string;
let archivePath: string;
let archiveSha: string;
let archiveBytes: number;

/** A throwaway catalogue naming the fixture archive. */
function catalogueFor(overrides: { upstreamUrl?: string; mirrorBaseUrl?: string | null } = {}) {
  return {
    schemaVersion: 1,
    mirrorBaseUrl: overrides.mirrorBaseUrl ?? null,
    defaultModelId: 'test-model',
    models: [
      {
        id: 'test-model',
        modelName: 'test-model-1970-01-01',
        installDir: 'test-model',
        languages: ['en'],
        archive: {
          fileName: `${ARCHIVE_ROOT}.tar.bz2`,
          rootDir: ARCHIVE_ROOT,
          upstreamUrl: overrides.upstreamUrl ?? `file://${archivePath}`,
          sha256: archiveSha,
          bytes: archiveBytes,
        },
        files: Object.entries(MODEL_FILES).map(([name, body]) => ({
          name,
          sha256: sha256(body),
          bytes: Buffer.byteLength(body),
        })),
        attribution: {
          title: 'A Test Model',
          author: 'Nobody At All',
          sourceUrl: 'https://example.invalid/test-model',
          distributedVia: null,
          license: {
            id: 'CC-BY-SA',
            name: 'Creative Commons Attribution-ShareAlike',
            url: 'https://example.invalid/licence',
          },
          licenseNote: null,
          modified: false,
        },
      },
    ],
  };
}

/**
 * Run the shipping script against a catalogue and a scratch models dir.
 *
 * `spawnSync` rather than `execFileSync` because the interesting diagnostics —
 * the mirror miss, the hash mismatch — are written to stderr, and the failure
 * cases have to be assertable without throwing.
 */
function runFetch(
  catalogue: unknown,
  modelsDir: string,
  args: string[] = [],
): { ok: boolean; output: string } {
  const cataloguePath = join(work, `catalogue-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(cataloguePath, JSON.stringify(catalogue));
  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CANDIDCUE_MODEL_CATALOGUE: cataloguePath,
      CANDIDCUE_MODELS_DIR: modelsDir,
    },
  });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

let scratchIndex = 0;
const freshModelsDir = () => {
  const dir = join(work, `models-${scratchIndex++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'cc-fetch-test-'));
  const stage = join(work, ARCHIVE_ROOT);
  mkdirSync(stage, { recursive: true });
  for (const [name, body] of Object.entries(MODEL_FILES)) {
    writeFileSync(join(stage, name), body);
  }
  // A file the catalogue does not list — the script must leave it behind.
  writeFileSync(join(stage, 'test_wavs_readme.txt'), 'not part of the model\n');

  archivePath = join(work, `${ARCHIVE_ROOT}.tar.bz2`);
  execFileSync('tar', ['-cjf', archivePath, '-C', work, ARCHIVE_ROOT]);
  archiveSha = sha256(readFileSync(archivePath));
  archiveBytes = statSync(archivePath).size;
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('fetch-stt-model.sh', () => {
  it('installs exactly the files the catalogue lists', () => {
    const dir = freshModelsDir();
    const { ok, output } = runFetch(catalogueFor(), dir);
    expect(ok, output).toBe(true);

    for (const [name, body] of Object.entries(MODEL_FILES)) {
      expect(readFileSync(join(dir, 'test-model', name), 'utf8')).toBe(body);
    }
    // Present in the archive, absent from the catalogue, so not installed.
    expect(() => statSync(join(dir, 'test-model', 'test_wavs_readme.txt'))).toThrow();
    // No staging file survived.
    expect(() => statSync(join(dir, 'test-model', '.tokens.txt.part'))).toThrow();
  });

  it('refuses to unpack an archive whose hash does not match', () => {
    const dir = freshModelsDir();
    const tampered = catalogueFor();
    tampered.models[0].archive.sha256 = 'f'.repeat(64);

    const { ok, output } = runFetch(tampered, dir);
    expect(ok).toBe(false);
    expect(output).toMatch(/expected sha256/);
    expect(output).toMatch(/Nothing was unpacked/);
    // The whole point: a mismatch must not leave model files behind.
    expect(() => statSync(join(dir, 'test-model', 'tokens.txt'))).toThrow();
  });

  it('refuses an archive whose byte count does not match', () => {
    const dir = freshModelsDir();
    const tampered = catalogueFor();
    tampered.models[0].archive.bytes = archiveBytes + 1;

    const { ok, output } = runFetch(tampered, dir);
    expect(ok).toBe(false);
    expect(output).toMatch(/expected \d+ bytes/);
    expect(() => statSync(join(dir, 'test-model', 'tokens.txt'))).toThrow();
  });

  it('falls back to upstream when the mirror misses, and still verifies', () => {
    const dir = freshModelsDir();
    const withDeadMirror = catalogueFor({
      mirrorBaseUrl: `file://${join(work, 'no-such-mirror')}`,
    });

    const { ok, output } = runFetch(withDeadMirror, dir);
    expect(ok, output).toBe(true);
    expect(output).toMatch(/Mirror miss/);
    expect(output).toMatch(/upstream: verified/);
    expect(readFileSync(join(dir, 'test-model', 'tokens.txt'), 'utf8')).toBe(
      MODEL_FILES['tokens.txt'],
    );
  });

  it('fails when neither mirror nor upstream yields verified bytes', () => {
    const dir = freshModelsDir();
    const broken = catalogueFor({
      mirrorBaseUrl: `file://${join(work, 'no-such-mirror')}`,
      upstreamUrl: `file://${join(work, 'no-such-archive.tar.bz2')}`,
    });

    const { ok, output } = runFetch(broken, dir);
    expect(ok).toBe(false);
    expect(output).toMatch(/Could not obtain a verified/);
  });

  it('skips the download when the installed files already hash correctly', () => {
    const dir = freshModelsDir();
    expect(runFetch(catalogueFor(), dir).ok).toBe(true);

    // Point upstream at nothing. A second run must not need it.
    const unreachable = catalogueFor({
      upstreamUrl: `file://${join(work, 'no-such-archive.tar.bz2')}`,
    });
    const { ok, output } = runFetch(unreachable, dir);
    expect(ok, output).toBe(true);
    expect(output).toMatch(/already present and verified/);
  });

  it('re-fetches when an installed file has been corrupted', () => {
    const dir = freshModelsDir();
    expect(runFetch(catalogueFor(), dir).ok).toBe(true);

    writeFileSync(join(dir, 'test-model', 'tokens.txt'), 'corrupted\n');
    const { ok, output } = runFetch(catalogueFor(), dir);
    expect(ok, output).toBe(true);
    // Existence alone used to be proof of a good install. It is not.
    expect(output).not.toMatch(/already present/);
    expect(readFileSync(join(dir, 'test-model', 'tokens.txt'), 'utf8')).toBe(
      MODEL_FILES['tokens.txt'],
    );
  });

  it('writes the attribution notice from the catalogue, every run', () => {
    const dir = freshModelsDir();
    expect(runFetch(catalogueFor(), dir).ok).toBe(true);

    const notice = join(dir, 'test-model', 'ATTRIBUTION.md');
    expect(readFileSync(notice, 'utf8')).toContain('Nobody At All');

    // A licence-only catalogue change must reach disk even though no download
    // happens — the fast path regenerates the notice too.
    const relicensed = catalogueFor();
    relicensed.models[0].attribution.author = 'Somebody Else';
    expect(runFetch(relicensed, dir).ok).toBe(true);
    expect(readFileSync(notice, 'utf8')).toContain('Somebody Else');
  });
});

describe('model-catalogue.mjs', () => {
  const run = (args: string[], catalogue?: unknown) => {
    const env = { ...process.env } as NodeJS.ProcessEnv;
    if (catalogue !== undefined) {
      const path = join(work, `cat-${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(path, JSON.stringify(catalogue));
      env.CANDIDCUE_MODEL_CATALOGUE = path;
    }
    const result = spawnSync('node', [HELPER, ...args], { encoding: 'utf8', env });
    return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  };

  it('accepts the committed catalogue', () => {
    const { ok, output } = run(['validate']);
    expect(ok, output).toBe(true);
    expect(output).toMatch(/catalogue ok/);
  });

  it('builds a content-addressed mirror URL so one URL names one set of bytes', () => {
    const withMirror = catalogueFor({ mirrorBaseUrl: 'https://models.example.com/' });
    const { ok, output } = run(['fields'], withMirror);
    expect(ok, output).toBe(true);
    const fields = output.split('\0');
    expect(fields[7]).toBe(
      `https://models.example.com/sha256/${archiveSha}/${ARCHIVE_ROOT}.tar.bz2`,
    );
  });

  it('emits no mirror URL when none is configured', () => {
    const { ok, output } = run(['fields'], catalogueFor());
    expect(ok, output).toBe(true);
    expect(output.split('\0')[7]).toBe('');
  });

  it.each([
    ['a bad digest', (c: any) => (c.models[0].archive.sha256 = 'nothex')],
    ['an uppercase digest', (c: any) => (c.models[0].archive.sha256 = 'A'.repeat(64))],
    ['a zero byte count', (c: any) => (c.models[0].archive.bytes = 0)],
    ['a path-traversing file name', (c: any) => (c.models[0].files[0].name = '../escape')],
    ['a path-traversing install dir', (c: any) => (c.models[0].installDir = '../escape')],
    ['a plain-http upstream', (c: any) => (c.models[0].archive.upstreamUrl = 'http://example.com/a')],
    ['a defaultModelId naming nothing', (c: any) => (c.defaultModelId = 'absent')],
    ['an unknown schema version', (c: any) => (c.schemaVersion = 99)],
    [
      'a modification with no statement of what changed',
      (c: any) => (c.models[0].attribution.modified = true),
    ],
  ])('rejects %s', (_label, mutate) => {
    const broken = catalogueFor();
    mutate(broken);
    expect(run(['validate'], broken).ok).toBe(false);
  });

  it('renders attribution deterministically', () => {
    const first = run(['attribution'], catalogueFor());
    const second = run(['attribution'], catalogueFor());
    expect(first.ok).toBe(true);
    expect(first.output).toBe(second.output);
    expect(first.output).toContain('unmodified');
  });

  it('states the modification when the catalogue says the files were changed', () => {
    const modified = catalogueFor();
    modified.models[0].attribution.modified = true;
    modified.models[0].attribution.licenseNote = 'Quantised to int8 by CandidCue.';

    const { ok, output } = run(['attribution'], modified);
    expect(ok, output).toBe(true);
    expect(output).toContain('with modifications');
    expect(output).toContain('Quantised to int8 by CandidCue.');
  });
});
