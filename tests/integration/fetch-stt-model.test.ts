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
 * The real archive is ~128 MB, so these tests build a tiny `.tar.bz2` and a
 * throwaway catalogue, then run the ACTUAL shipping script against them with a
 * fake `curl` early on `PATH`. The script and the catalogue reader therefore
 * take exactly the production code path — there is no test-only branch inside
 * either of them, which was a deliberate choice: a scheme exception for tests
 * is a thing that can be reached in production by accident.
 *
 * What is deliberately NOT covered: the shipped app fetching a model at
 * runtime. Nothing does that yet — the model is still bundled as a Tauri
 * resource, and the in-app downloader is issue #152.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/*
 * These drive a real shell script: `tar`, `sha256sum`, a curl shim and a fake
 * archive per case. On an idle machine each case is well under a second; with
 * the rest of the suite running in parallel workers the first one has been
 * measured at 45 SECONDS, against vitest's 5 s default — so the release gate
 * failed on a test that had found nothing wrong.
 *
 * A generous ceiling rather than a tight one, deliberately: this file is about
 * what the script DOES (which bytes it installs, what it refuses), and it owns
 * no performance claim at all. The budgets that do own one are in
 * `src/shared/perf-budget.ts`, and they take the fastest of several runs
 * instead of widening.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const REPO_ROOT = resolve(__dirname, '../..');
const SCRIPT = join(REPO_ROOT, 'scripts/fetch-stt-model.sh');
const HELPER = join(REPO_ROOT, 'scripts/model-catalogue.mjs');

/** The shim serves this host and refuses every other one. */
const SERVED = 'https://fixtures.invalid/archive';
const REFUSED = 'https://gone.invalid/archive';

const ARCHIVE_ROOT = 'test-model-1970-01-01';
const MODEL_FILES: Record<string, string> = {
  'encoder.onnx': 'not really an onnx graph, but it hashes like one\n',
  'decoder.onnx': 'decoder bytes\n',
  'joiner.onnx': 'joiner bytes\n',
  'tokens.txt': '<blk> 0\na 1\nb 2\n',
};

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

let work: string;
let shimBin: string;
let archivePath: string;
let archiveSha: string;
let archiveBytes: number;

/**
 * Base environment for every child process.
 *
 * Both override variables are deleted rather than inherited: a developer with
 * `SPEAKING_GLASS_MODEL_CATALOGUE` exported would otherwise make "accepts the
 * committed catalogue" quietly validate some other file.
 */
function baseEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.SPEAKING_GLASS_MODEL_CATALOGUE;
  delete env.SPEAKING_GLASS_MODEL_MIRROR;
  delete env.SPEAKING_GLASS_MODELS_DIR;
  return env;
}

/**
 * The catalogue shape, spelled out so the fixtures are type-checked.
 *
 * Deliberately permissive where the real schema is not — `licenseNote` is
 * `string | null` so a test can set one, which an inferred `null` would forbid.
 */
interface TestCatalogue {
  schemaVersion: number;
  mirrorBaseUrl: string | null;
  defaultModelId: string;
  models: Array<{
    id: string;
    modelName: string;
    installDir: string;
    languages: string[];
    archive: {
      fileName: string;
      rootDir: string;
      upstreamUrl: string;
      sha256: string;
      bytes: number;
    };
    files: Array<{ name: string; sha256: string; bytes: number }>;
    attribution: {
      title: string;
      author: string;
      sourceUrl: string;
      distributedVia: string | null;
      license: { id: string; name: string; url: string };
      licenseNote: string | null;
      modified: boolean;
    };
  }>;
}

/** The single entry these fixtures carry. */
const entry = (catalogue: TestCatalogue) => catalogue.models[0]!;

/** A throwaway catalogue naming the fixture archive. */
function catalogueFor(
  overrides: { upstreamUrl?: string; mirrorBaseUrl?: string | null } = {},
): TestCatalogue {
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
          upstreamUrl: overrides.upstreamUrl ?? `${SERVED}/${ARCHIVE_ROOT}.tar.bz2`,
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
          /*
           * A real SPDX id, because the fetch script now copies
           * `legal/licenses/<id>.txt` beside the weights and refuses when
           * there is none. A bare licence family with no version was never a
           * licence anybody could ship under, so the fixture was quietly
           * asserting that an unshippable model installs fine.
           */
          license: {
            id: 'Apache-2.0',
            name: 'Apache License 2.0',
            url: 'https://www.apache.org/licenses/LICENSE-2.0',
          },
          licenseNote: null,
          modified: false,
        },
      },
    ],
  };
}

function writeCatalogue(catalogue: unknown): string {
  const path = join(work, `catalogue-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, typeof catalogue === 'string' ? catalogue : JSON.stringify(catalogue));
  return path;
}

/**
 * Run the shipping script.
 *
 * `spawnSync` rather than `execFileSync` because the interesting diagnostics —
 * the mirror miss, the hash mismatch — go to stderr, and the failure cases have
 * to be assertable without throwing.
 */
function runFetch(
  catalogue: unknown,
  modelsDir: string,
  args: string[] = [],
): { ok: boolean; output: string } {
  const env = baseEnv();
  env.SPEAKING_GLASS_MODEL_CATALOGUE = writeCatalogue(catalogue);
  env.SPEAKING_GLASS_MODELS_DIR = modelsDir;
  env.PATH = `${shimBin}${delimiter}${env.PATH ?? ''}`;
  env.SHIM_ARCHIVE = archivePath;

  const result = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env });
  if (result.error) return { ok: false, output: String(result.error) };
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
  // Present in the archive, absent from the catalogue. Must never be extracted.
  writeFileSync(join(stage, 'test_wavs_readme.txt'), 'not part of the model\n');

  archivePath = join(work, `${ARCHIVE_ROOT}.tar.bz2`);
  execFileSync('tar', ['-cjf', archivePath, '-C', work, ARCHIVE_ROOT]);
  archiveSha = sha256(readFileSync(archivePath));
  archiveBytes = statSync(archivePath).size;

  // A fake curl: serves one host from a local file, refuses everything else.
  // This is what lets the script keep `--proto '=https'` with no test seam.
  shimBin = join(work, 'bin');
  mkdirSync(shimBin, { recursive: true });
  const shim = [
    '#!/usr/bin/env bash',
    'set -uo pipefail',
    'url=""',
    'target=""',
    'while [[ $# -gt 0 ]]; do',
    '  case "$1" in',
    '    -o) target="$2"; shift 2 ;;',
    '    --connect-timeout|--retry|--max-filesize|--proto|--proto-redir) shift 2 ;;',
    '    -*) shift ;;',
    '    *) url="$1"; shift ;;',
    '  esac',
    'done',
    '[[ "${url}" == https://fixtures.invalid/* ]] || exit 22',
    'cp "${SHIM_ARCHIVE}" "${target}"',
  ].join('\n');
  writeFileSync(join(shimBin, 'curl'), `${shim}\n`);
  chmodSync(join(shimBin, 'curl'), 0o755);
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/*
 * Not on Windows. The script is a POSIX dev convenience behind
 * `pnpm models:fetch`, and these cases run it under `bash` with a bash `curl`
 * shim — which on Windows resolves to WSL's `bash.exe`, a different machine
 * that cannot read the `C:\…` paths it is handed. Every user installs the
 * model through Settings › Speech instead, on every platform, and that path is
 * Rust (`speech/model_download.rs`, `model_store.rs`) with tests of its own.
 * The catalogue helper and the committed-notice check below are plain node and
 * run everywhere; the archive built in `beforeAll` is still what they hash.
 */
describe.skipIf(process.platform === 'win32')('fetch-stt-model.sh', () => {
  it('installs exactly the files the catalogue lists', () => {
    const dir = freshModelsDir();
    const { ok, output } = runFetch(catalogueFor(), dir);
    expect(ok, output).toBe(true);

    for (const [name, body] of Object.entries(MODEL_FILES)) {
      expect(readFileSync(join(dir, 'test-model', name), 'utf8')).toBe(body);
    }
    // In the archive, not in the catalogue — so never even extracted.
    expect(() => statSync(join(dir, 'test-model', 'test_wavs_readme.txt'))).toThrow();
    // No staging file survived.
    expect(() => statSync(join(dir, 'test-model', '.tokens.txt.part'))).toThrow();
  });

  it('refuses to unpack an archive whose hash does not match', () => {
    const dir = freshModelsDir();
    const tampered = catalogueFor();
    entry(tampered).archive.sha256 = 'f'.repeat(64);

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
    entry(tampered).archive.bytes = archiveBytes + 1;

    const { ok, output } = runFetch(tampered, dir);
    expect(ok).toBe(false);
    expect(output).toMatch(/expected \d+ bytes/);
    expect(() => statSync(join(dir, 'test-model', 'tokens.txt'))).toThrow();
  });

  it('falls back to upstream when the mirror misses, and still verifies', () => {
    const dir = freshModelsDir();
    const withDeadMirror = catalogueFor({ mirrorBaseUrl: 'https://gone.invalid' });

    const { ok, output } = runFetch(withDeadMirror, dir);
    expect(ok, output).toBe(true);
    expect(output).toMatch(/Mirror miss/);
    expect(output).toMatch(/upstream: verified/);
    expect(readFileSync(join(dir, 'test-model', 'tokens.txt'), 'utf8')).toBe(
      MODEL_FILES['tokens.txt'],
    );
  });

  it('prefers the mirror when it answers', () => {
    const dir = freshModelsDir();
    // The mirror host is the one the shim serves; upstream is not.
    const served = catalogueFor({
      mirrorBaseUrl: 'https://fixtures.invalid',
      upstreamUrl: `${REFUSED}/${ARCHIVE_ROOT}.tar.bz2`,
    });

    const { ok, output } = runFetch(served, dir);
    expect(ok, output).toBe(true);
    expect(output).toMatch(/mirror: verified/);
    expect(output).not.toMatch(/Mirror miss/);
  });

  it('fails when neither mirror nor upstream yields verified bytes', () => {
    const dir = freshModelsDir();
    const broken = catalogueFor({
      mirrorBaseUrl: 'https://gone.invalid',
      upstreamUrl: `${REFUSED}/${ARCHIVE_ROOT}.tar.bz2`,
    });

    const { ok, output } = runFetch(broken, dir);
    expect(ok).toBe(false);
    expect(output).toMatch(/Could not obtain a verified/);
  });

  it('skips the download when the installed files already hash correctly', () => {
    const dir = freshModelsDir();
    expect(runFetch(catalogueFor(), dir).ok).toBe(true);

    // Point upstream at a host the shim refuses. A second run must not need it.
    const unreachable = catalogueFor({ upstreamUrl: `${REFUSED}/${ARCHIVE_ROOT}.tar.bz2` });
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

  it('re-downloads under --force even when everything verifies', () => {
    const dir = freshModelsDir();
    expect(runFetch(catalogueFor(), dir).ok).toBe(true);

    const { ok, output } = runFetch(catalogueFor(), dir, ['--force']);
    expect(ok, output).toBe(true);
    expect(output).toMatch(/upstream: verified/);
    expect(output).not.toMatch(/already present/);
  });

  it('writes the attribution notice from the catalogue, every run', () => {
    const dir = freshModelsDir();
    expect(runFetch(catalogueFor(), dir).ok).toBe(true);

    const notice = join(dir, 'test-model', 'ATTRIBUTION.md');
    expect(readFileSync(notice, 'utf8')).toContain('Nobody At All');

    // A licence-only catalogue change must reach disk even though no download
    // happens — the fast path regenerates the notice too.
    const relicensed = catalogueFor();
    entry(relicensed).attribution.author = 'Somebody Else';
    expect(runFetch(relicensed, dir).ok).toBe(true);
    expect(readFileSync(notice, 'utf8')).toContain('Somebody Else');
  });

  /*
   * Apache-2.0 §4(a) wants a COPY of the licence to travel with the work.
   * ATTRIBUTION.md said so and then linked to it, which leaves a user holding
   * the weights offline with the thing the licence covers and not the
   * licence. The text is written beside the weights now, by this script and
   * by the in-app installer alike.
   */
  it('writes the licence text beside the weights, not only a link to it', () => {
    const dir = freshModelsDir();
    expect(runFetch(catalogueFor(), dir).ok).toBe(true);

    const licence = join(dir, 'test-model', 'LICENSE-Apache-2.0.txt');
    const text = readFileSync(licence, 'utf8');
    expect(text).toContain('Apache License');
    expect(text.length, 'the committed licence text, not a stub').toBeGreaterThan(2000);

    // And the notice points at the file that is actually there.
    expect(readFileSync(join(dir, 'test-model', 'ATTRIBUTION.md'), 'utf8')).toContain(
      'LICENSE-Apache-2.0.txt',
    );
  });

  it('refuses to install a model under a licence it cannot show', () => {
    const dir = freshModelsDir();
    const unshippable = catalogueFor();
    entry(unshippable).attribution.license.id = 'Nobody-Committed-This-1.0';
    const result = runFetch(unshippable, dir);
    expect(result.ok, 'an uncommitted licence must stop the fetch').toBe(false);
    expect(result.output).toContain('No committed licence text');
  });

  it('rejects a catalogue whose field count does not match its file count', () => {
    const dir = freshModelsDir();
    // Hand-built stream: a well-formed header claiming three files, but only
    // one triple after it. The script must refuse rather than index past the
    // end of the array.
    const fakeHelper = join(work, 'lying-helper.mjs');
    writeFileSync(
      fakeHelper,
      [
        "const out = ['id','name','dir','a.tar.bz2','root','" +
          'a'.repeat(64) +
          "','10','','https://x.invalid/a','3'];",
        "out.push('tokens.txt','" + 'b'.repeat(64) + "','5');",
        "process.stdout.write(out.join('\\0') + '\\0');",
      ].join('\n'),
    );

    const env = baseEnv();
    env.SPEAKING_GLASS_MODELS_DIR = dir;
    env.PATH = `${shimBin}${delimiter}${env.PATH ?? ''}`;
    const patched = readFileSync(SCRIPT, 'utf8').replace(
      'HELPER="${REPO_ROOT}/scripts/model-catalogue.mjs"',
      `HELPER="${fakeHelper}"`,
    );
    const patchedScript = join(work, 'patched-fetch.sh');
    writeFileSync(patchedScript, patched);

    const result = spawnSync('bash', [patchedScript], { encoding: 'utf8', env });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/expected \d+ fields, got \d+/);
  });
});

describe('model-catalogue.mjs', () => {
  const run = (args: string[], catalogue?: unknown) => {
    const env = baseEnv();
    if (catalogue !== undefined) env.SPEAKING_GLASS_MODEL_CATALOGUE = writeCatalogue(catalogue);
    const result = spawnSync('node', [HELPER, ...args], { encoding: 'utf8', env });
    if (result.error) return { ok: false, output: String(result.error) };
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
    expect(output.split('\0')[7]).toBe(
      `https://models.example.com/sha256/${archiveSha}/${ARCHIVE_ROOT}.tar.bz2`,
    );
  });

  it('emits no mirror URL when none is configured, without shifting later fields', () => {
    const { ok, output } = run(['fields'], catalogueFor());
    expect(ok, output).toBe(true);
    const fields = output.split('\0');
    expect(fields[7]).toBe('');
    // The file count must still land in its documented slot.
    expect(fields[9]).toBe(String(Object.keys(MODEL_FILES).length));
  });

  it.each([
    ['a bad digest', (c: any) => (c.models[0].archive.sha256 = 'nothex')],
    ['an uppercase digest', (c: any) => (c.models[0].archive.sha256 = 'A'.repeat(64))],
    ['a zero byte count', (c: any) => (c.models[0].archive.bytes = 0)],
    ['a path-traversing file name', (c: any) => (c.models[0].files[0].name = '../escape')],
    ['a path-traversing install dir', (c: any) => (c.models[0].installDir = '../escape')],
    [
      'a plain-http upstream',
      (c: any) => (c.models[0].archive.upstreamUrl = 'http://example.com/a'),
    ],
    ['a file:// upstream', (c: any) => (c.models[0].archive.upstreamUrl = 'file:///etc/passwd')],
    ['a defaultModelId naming nothing', (c: any) => (c.defaultModelId = 'absent')],
    ['an unknown schema version', (c: any) => (c.schemaVersion = 99)],
    [
      'a modification with no statement of what changed',
      (c: any) => (c.models[0].attribution.modified = true),
    ],
    [
      'a modification whose statement is blank',
      (c: any) => {
        c.models[0].attribution.modified = true;
        c.models[0].attribution.licenseNote = '';
      },
    ],
  ])('rejects %s', (_label, mutate) => {
    const broken = catalogueFor();
    mutate(broken);
    expect(run(['validate'], broken).ok).toBe(false);
  });

  /**
   * A NUL anywhere in any emitted field is an extra delimiter, which shifts
   * every later field and hands the catalogue control of what bash reads as
   * FILE_COUNT. Bash re-evaluates a variable used in arithmetic, so a command
   * substitution landing there executes. These are the regression tests for
   * that; JSON writes the NUL as \u0000.
   */
  it.each([
    ['a model name', (c: any) => (c.models[0].modelName = 'a\u0000b')],
    ['an upstream URL', (c: any) => (c.models[0].archive.upstreamUrl = 'https://x.invalid/\u00000')],
    ['a title', (c: any) => (c.models[0].attribution.title = 'a\u0000b')],
    ['an author', (c: any) => (c.models[0].attribution.author = 'a\u0000b')],
    ['a licence note', (c: any) => (c.models[0].attribution.licenseNote = 'a\u0000b')],
    ['a language', (c: any) => (c.models[0].languages = ['e\u0000n'])],
  ])('refuses an embedded NUL in %s', (_label, mutate) => {
    const poisoned = catalogueFor();
    mutate(poisoned);
    const { ok, output } = run(['fields'], poisoned);
    expect(ok).toBe(false);
    expect(output).not.toContain('\0');
  });

  /**
   * The mirror override cannot carry a NUL at all — environment strings are
   * NUL-terminated, so one never survives the trip (Node refuses to spawn
   * with it outright). The catalogue FILE is the only route a NUL can take,
   * which is what the table above covers. What the override can still do is
   * name a host that is not https, so that is what gets checked here.
   */
  it.each([
    ['plain http', 'http://mirror.invalid'],
    ['a file URL', 'file:///tmp'],
    ['not a URL at all', 'mirror.invalid'],
  ])('refuses a mirror override that is %s', (_label, mirror) => {
    const env = baseEnv();
    env.SPEAKING_GLASS_MODEL_CATALOGUE = writeCatalogue(catalogueFor());
    env.SPEAKING_GLASS_MODEL_MIRROR = mirror;
    const result = spawnSync('node', [HELPER, 'fields'], { encoding: 'utf8', env });
    expect(result.status).not.toBe(0);
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
    entry(modified).attribution.modified = true;
    entry(modified).attribution.licenseNote = 'Quantised to int8 by Speaking Glass.';

    const { ok, output } = run(['attribution'], modified);
    expect(ok, output).toBe(true);
    expect(output).toContain('with modifications');
    expect(output).toContain('Quantised to int8 by Speaking Glass.');
  });
});

describe('the committed ATTRIBUTION.md', () => {
  /**
   * Byte-for-byte, not substring.
   *
   * The notice is generated output that is also committed, because the model
   * ships as a bundled resource and the file has to exist in a fresh clone. So
   * it can go stale: edit the licence in the catalogue, forget to re-run
   * `pnpm models:fetch`, and the bundle now carries a notice describing terms
   * the model is not distributed under. A substring check misses a licence-ID
   * change, a renamed archive, or a new licence note; comparing the whole
   * rendering misses nothing.
   */
  it('is exactly what the catalogue renders today', () => {
    const catalogue = JSON.parse(
      readFileSync(join(REPO_ROOT, 'src-tauri/models/catalogue.json'), 'utf8'),
    );
    const model = catalogue.models.find((m: any) => m.id === catalogue.defaultModelId);
    expect(model, 'defaultModelId must name an entry').toBeTruthy();

    const rendered = spawnSync('node', [HELPER, 'attribution', '--model', model.id], {
      encoding: 'utf8',
      env: baseEnv(),
    });
    expect(rendered.status, rendered.stderr).toBe(0);

    const committed = readFileSync(
      join(REPO_ROOT, 'src-tauri/models', model.installDir, 'ATTRIBUTION.md'),
      'utf8',
    );
    expect(committed).toBe(rendered.stdout);
  });
});
