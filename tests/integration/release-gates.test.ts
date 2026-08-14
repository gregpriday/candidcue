/**
 * The release gates, driven the way CI drives them.
 *
 * `scripts/version.mjs` and `scripts/verify-repository.mjs` exist because the
 * 1.0 readiness review could not certify a release: three manifests carried
 * `0.1.0` independently, two more copies sat hard-coded in frontend source, and
 * the review artifact referenced files nobody could prove were in the
 * repository. Both problems are now machine-checked.
 *
 * A gate is only worth having if it FAILS on the thing it is for, so every test
 * here breaks something in a scratch copy of the repository and asserts the
 * gate notices. Asserting only that a clean tree passes would be satisfied by a
 * script that prints "OK" and exits — which is exactly the failure mode both
 * scripts are meant to close.
 *
 * Each test copies the manifests it needs into a temporary tree rather than
 * mutating the working copy. A gate test that leaves the repository broken when
 * it fails is worse than no gate test.
 *
 * verify-repository:ignore-imports — this file writes fixture MODULE SOURCE to
 * temporary directories, and those fixtures import things that deliberately do
 * not exist. Without the directive the completeness gate reads its own test's
 * string literals as broken imports and fails on them, which is a nicely
 * circular way to make a gate unusable.
 */

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../..');
const VERSION_SCRIPT = join(REPO_ROOT, 'scripts/version.mjs');
const REPO_SCRIPT = join(REPO_ROOT, 'scripts/verify-repository.mjs');

const workspaces: string[] = [];

afterAll(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

/**
 * A scratch tree containing only what a gate reads.
 *
 * Copying the whole repository would take seconds per test and drag
 * `node_modules` and `target` along with it. Each gate below declares the paths
 * it needs, which also documents what the gate actually depends on.
 */
function scratchRepo(paths: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'candidcue-gate-'));
  workspaces.push(dir);
  for (const rel of paths) {
    const from = join(REPO_ROOT, rel);
    const to = join(dir, rel);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true });
  }
  return dir;
}

function run(script: string, args: string[], cwd: string) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/* --------------------------------------------------------- version sync */

const VERSION_FILES = [
  'package.json',
  'src-tauri/Cargo.toml',
  'src-tauri/tauri.conf.json',
  'src/shared/version.ts',
  'src/shared/markdown/compile.ts',
  'crates/cc-align/Cargo.toml',
];

/**
 * The version script resolves its own paths from `import.meta.url`, so it must
 * be copied into the scratch tree to operate on it.
 */
function scratchVersionRepo(): { dir: string; script: string } {
  const dir = scratchRepo([...VERSION_FILES, 'scripts/version.mjs']);
  // `strayVersionLiterals` globs `src/**`; the tree only holds what we copied,
  // which is the point — the two files that matter for that rule are here.
  return { dir, script: join(dir, 'scripts/version.mjs') };
}

describe('the version gate keeps five copies of the version in agreement', () => {
  it('passes on the repository as committed', () => {
    const result = run(VERSION_SCRIPT, ['check'], REPO_ROOT);
    expect(result.output).toContain('Version sync OK');
    expect(result.status).toBe(0);
  });

  it('fails when Cargo.toml drifts from package.json', () => {
    const { dir, script } = scratchVersionRepo();
    const cargo = join(dir, 'src-tauri/Cargo.toml');
    writeFileSync(
      cargo,
      readFileSync(cargo, 'utf8').replace(/^version = ".*"$/m, 'version = "9.9.9"'),
    );

    const result = run(script, ['check'], dir);
    expect(result.status, 'a drifted manifest must fail the gate').toBe(1);
    expect(result.output).toContain('src-tauri/Cargo.toml');
  });

  it('fails when the bundle version drifts from package.json', () => {
    const { dir, script } = scratchVersionRepo();
    const conf = join(dir, 'src-tauri/tauri.conf.json');
    writeFileSync(conf, readFileSync(conf, 'utf8').replace(/"version": "[^"]+"/, '"version": "0.0.1"'));

    const result = run(script, ['check'], dir);
    expect(result.status).toBe(1);
    // The bundle version is what `app_version` reports and what a support
    // request quotes; naming the file is the whole value of the message.
    expect(result.output).toContain('tauri.conf.json');
  });

  it('fails when a hard-coded version literal returns to product source', () => {
    /*
     * The specific regression: `settings.ts` carried `'0.1.0'` and
     * `'0.1.0-dev'` fallbacks that survived every version bump, so a
     * browser-dev diagnostics paste reported a version that had not been real
     * for months.
     */
    const { dir, script } = scratchVersionRepo();
    const target = join(dir, 'src/shared/markdown/compile.ts');
    writeFileSync(
      target,
      `${readFileSync(target, 'utf8')}\nexport const FALLBACK_VERSION = '0.1.0';\n`,
    );

    const result = run(script, ['check'], dir);
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/hard-coded version literal/);
  });

  it('does not fire on a version literal that is only being explained', () => {
    /*
     * Anti-vacuity in the other direction. The postmortem comments that record
     * WHY `'0.1.0'` was removed contain the string `'0.1.0'`. A gate that fails
     * on its own explanation teaches people to delete the explanation, so
     * comments are excluded — and that exclusion needs a test of its own,
     * because it is also the easiest way to accidentally disable the rule.
     */
    const { dir, script } = scratchVersionRepo();
    const target = join(dir, 'src/shared/markdown/compile.ts');
    writeFileSync(
      target,
      `${readFileSync(target, 'utf8')}\n// A hard-coded '0.1.0' used to sit here.\n`,
    );

    const result = run(script, ['check'], dir);
    expect(result.status, 'a comment is not a claim about the running version').toBe(0);
  });

  it('leaves COMPILER_VERSION alone, because it is not the app version', () => {
    // It is the compiled-document cache key. If this ever starts failing, the
    // exemption in `INDEPENDENT_VERSIONS` was widened into a hole.
    const source = readFileSync(join(REPO_ROOT, 'scripts/version.mjs'), 'utf8');
    expect(source).toContain('COMPILER_VERSION');
    expect(run(VERSION_SCRIPT, ['check'], REPO_ROOT).status).toBe(0);
  });

  it('fails when the frontend fallback version drifts', () => {
    /*
     * `src/shared/version.ts` is the consumer with no compiler behind it: a
     * wrong number there does not break a build, it just makes the app report
     * a version it is not. Without this test, deleting that consumer from the
     * check would leave the whole suite green — the `set` test proves the
     * WRITER touches the file, not that `check` notices later drift.
     */
    const { dir, script } = scratchVersionRepo();
    const target = join(dir, 'src/shared/version.ts');
    writeFileSync(
      target,
      readFileSync(target, 'utf8').replace(/APP_VERSION = '[^']+'/, "APP_VERSION = '0.0.9'"),
    );

    const result = run(script, ['check'], dir);
    expect(result.status).toBe(1);
    expect(result.output).toContain('src/shared/version.ts');
  });

  it('names the missing file instead of dying with a stack trace', () => {
    /*
     * A gate that exits non-zero by CRASHING is indistinguishable from a gate
     * that exits non-zero by working, and it tells the operator nothing about
     * what to fix. Both were true here before: a missing manifest produced an
     * ENOENT traceback.
     */
    const dir = scratchRepo(['scripts/version.mjs']);
    const result = run(join(dir, 'scripts/version.mjs'), ['check'], dir);
    expect(result.status).toBe(1);
    expect(result.output).toContain('package.json');
    expect(result.output, 'a stack trace is not a diagnostic').not.toContain('at readFileSync');
  });

  it('writes nothing at all when one consumer cannot be rewritten', () => {
    /*
     * `set` used to write each file as it went, so a missing or unwritable
     * later consumer left the tree half-bumped — package.json on the new
     * version, version.ts on the old. That is the exact split this script
     * exists to prevent, produced by the script itself.
     */
    const { dir, script } = scratchVersionRepo();
    const before = readFileSync(join(dir, 'package.json'), 'utf8');
    rmSync(join(dir, 'src/shared/version.ts'));

    const result = run(script, ['set', '7.7.7'], dir);
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/nothing was written/i);
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before);
  });

  it('fails when the stray-literal scan matches nothing', () => {
    /*
     * The scan reports violations it FINDS, so a glob that matches nothing
     * reports nothing and the gate goes green — indistinguishable from a clean
     * tree. A directory rename is exactly the kind of change that would switch
     * this branch off silently.
     */
    const dir = scratchRepo([
      'scripts/version.mjs',
      'package.json',
      'src-tauri/Cargo.toml',
      'src-tauri/tauri.conf.json',
      'crates/cc-align/Cargo.toml',
    ]);
    // `version.ts` is read directly, so give it one and leave `src/` otherwise
    // empty — that is the collapsed-glob condition, not a missing-file one.
    mkdirSync(join(dir, 'src/shared'), { recursive: true });
    cpSync(join(REPO_ROOT, 'src/shared/version.ts'), join(dir, 'src/shared/version.ts'));

    const result = run(join(dir, 'scripts/version.mjs'), ['check'], dir);
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/examined no files under src\//);
  });

  it('refuses a version the macOS bundle cannot carry', () => {
    const { dir, script } = scratchVersionRepo();
    // `+build` metadata is valid semver and invalid as a CFBundleShortVersionString.
    const result = run(script, ['set', '1.0.0+build.7'], dir);
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/bundle-safe/);
  });

  it('sets every consumer at once, so a bump cannot be half-applied', () => {
    const { dir, script } = scratchVersionRepo();
    expect(run(script, ['set', '2.3.4'], dir).status).toBe(0);

    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version).toBe('2.3.4');
    expect(readFileSync(join(dir, 'src-tauri/Cargo.toml'), 'utf8')).toMatch(/^version = "2\.3\.4"$/m);
    expect(readFileSync(join(dir, 'src-tauri/tauri.conf.json'), 'utf8')).toContain('"version": "2.3.4"');
    expect(readFileSync(join(dir, 'src/shared/version.ts'), 'utf8')).toContain("APP_VERSION = '2.3.4'");

    expect(run(script, ['check'], dir).status).toBe(0);
  });

  it('leaves the internal crates on their own version line', () => {
    /*
     * cc-align, cc-stt and cc-bench are libraries with no public version
     * surface. Syncing them to the app would make every release look like an
     * engine change; the gate asserts the rule rather than ignoring the files.
     */
    const { dir, script } = scratchVersionRepo();

    // Setup must be known-good, or the assertion below could be passing
    // because the version bump half-failed rather than because the crate rule
    // fired.
    expect(run(script, ['set', '2.3.4'], dir).status, 'setup bump must succeed').toBe(0);
    expect(run(script, ['check'], dir).status, 'the bumped tree must be clean first').toBe(0);
    expect(readFileSync(join(dir, 'crates/cc-align/Cargo.toml'), 'utf8')).not.toContain('"2.3.4"');

    const drifted = join(dir, 'crates/cc-align/Cargo.toml');
    writeFileSync(
      drifted,
      readFileSync(drifted, 'utf8').replace(/^version = ".*"$/m, 'version = "2.3.4"'),
    );
    const result = run(script, ['check'], dir);
    expect(result.status, 'a crate silently adopting the app version must be noticed').toBe(1);
    // The specific diagnostic, not just a non-zero exit: without this the test
    // passes on any unrelated failure the scratch tree happens to produce.
    expect(result.output).toContain('crates/cc-align/Cargo.toml');
  });
});

/* ------------------------------------------------ repository completeness */

describe('the completeness gate proves the checkout can build', () => {
  it('passes on the repository as committed', () => {
    const result = run(REPO_SCRIPT, [], REPO_ROOT);
    expect(result.output).toContain('Repository completeness OK');
    expect(result.status).toBe(0);
  });

  it('resolves a non-trivial number of references', () => {
    /*
     * Anti-vacuity. A script whose globs silently matched nothing would print
     * "OK — 0 references resolve" and pass forever, which is precisely the
     * shape of the problem the readiness review hit. The floor is far below
     * the real count (over a thousand) and far above zero.
     */
    const result = run(REPO_SCRIPT, [], REPO_ROOT);
    const count = Number(result.output.match(/(\d+) references resolve/)?.[1] ?? 0);
    expect(count).toBeGreaterThan(200);
  });

  it('fails when a lockfile is missing', () => {
    const dir = scratchRepo(['scripts/verify-repository.mjs', 'package.json']);
    const result = run(join(dir, 'scripts/verify-repository.mjs'), [], dir);
    expect(result.status).toBe(1);
    expect(result.output).toContain('pnpm-lock.yaml');
  });

  it('fails when the Rust toolchain is left on a moving channel', () => {
    /*
     * `channel = "stable"` is what the repository used to pin, and it means two
     * machines a month apart compile the same tag with different compilers.
     * This is not a hypothetical: it is the state the readiness review found.
     */
    const dir = scratchRepo(['scripts/verify-repository.mjs']);
    writeFileSync(join(dir, 'rust-toolchain.toml'), '[toolchain]\nchannel = "stable"\n');
    const result = run(join(dir, 'scripts/verify-repository.mjs'), [], dir);
    expect(result.output).toMatch(/moving channel/);
    expect(result.status).toBe(1);
  });

  it('accepts an exact toolchain pin even when the file explains why', () => {
    /*
     * The committed `rust-toolchain.toml` contains the literal text
     * `channel = "stable"` inside the comment saying why `stable` is wrong.
     * Matching that comment made the gate report a correctly-pinned file as
     * unpinned — the same defect three separate checks hit during this work.
     *
     * The real repository is the fixture here, not a scratch tree. An earlier
     * version of this test copied only the script and the toolchain file into
     * a tmpdir and asserted merely that `/moving channel/` was ABSENT from the
     * output — which a crashing or gutted script satisfies trivially, since
     * that tree fails for a dozen other reasons anyway. Running the committed
     * pin through a complete checkout is the only way "accepted" means
     * accepted.
     */
    const result = run(REPO_SCRIPT, [], REPO_ROOT);
    expect(result.status, 'the committed checkout must pass').toBe(0);
    expect(result.output).not.toMatch(/moving channel/);

    // Anti-vacuity partner: prove the pin the gate just accepted is the one
    // this test thinks it is, and that the misleading comment is still there.
    const toolchain = readFileSync(join(REPO_ROOT, 'rust-toolchain.toml'), 'utf8');
    expect(toolchain).toMatch(/^channel = "\d+\.\d+\.\d+"$/m);
    expect(
      toolchain,
      'the comment that used to defeat this check must still be present, or the test proves nothing',
    ).toContain('channel = "stable"');
  });

  it('fails when a relative import does not resolve', () => {
    /*
     * The most common real break, and the one the readiness review actually
     * hit: source importing a module that is not in the checkout. Without a
     * mutation for it, gutting the entire frontend-import branch would leave
     * the suite green.
     */
    const dir = scratchRepo([
      'scripts/verify-repository.mjs',
      'package.json',
      'pnpm-lock.yaml',
      'rust-toolchain.toml',
    ]);
    mkdirSync(join(dir, 'src/control'), { recursive: true });
    writeFileSync(join(dir, 'src/control/thing.ts'), "import { x } from './does-not-exist';\n");
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(join(dir, 'tests/placeholder.ts'), 'export const ok = true;\n');

    const result = run(join(dir, 'scripts/verify-repository.mjs'), [], dir);
    expect(result.status).toBe(1);
    expect(result.output).toContain('./does-not-exist');
  });

  it('sees the import forms this codebase actually uses', () => {
    /*
     * A narrower matcher missed side-effect imports, multi-line `import`
     * statements and `vi.mock`, which is how half the test suite names a
     * module. A missed FORM is a silent hole — the gate reports nothing and
     * looks like it checked.
     *
     * The `vi.mock` case is not hypothetical: broadening the matcher is what
     * found five test files mocking `services/semantic-sidecar`, a module
     * removed with the OpenAI sidecar.
     */
    const dir = scratchRepo([
      'scripts/verify-repository.mjs',
      'package.json',
      'pnpm-lock.yaml',
      'rust-toolchain.toml',
    ]);
    mkdirSync(join(dir, 'src/control'), { recursive: true });
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(join(dir, 'src/control/side-effect.ts'), "import './gone-a';\n");
    writeFileSync(
      join(dir, 'src/control/multiline.ts'),
      "import {\n  aLongName,\n  another,\n} from './gone-b';\n",
    );
    writeFileSync(join(dir, 'tests/mocked.ts'), "vi.mock('../src/control/gone-c');\n");

    const output = run(join(dir, 'scripts/verify-repository.mjs'), [], dir).output;
    expect(output, 'side-effect import').toContain('./gone-a');
    expect(output, 'multi-line import').toContain('./gone-b');
    expect(output, 'vi.mock').toContain('gone-c');
  });

  it('does not read a quoted module path inside a comment as an import', () => {
    /*
     * The other direction. The contracts barrel's own header says «Import from
     * '.../shared/contracts' rather than from individual files», and the
     * broadened matcher read that as an import of a path with an ellipsis in
     * it. A gate that fails on documentation gets the documentation deleted.
     */
    const dir = scratchRepo([
      'scripts/verify-repository.mjs',
      'package.json',
      'pnpm-lock.yaml',
      'rust-toolchain.toml',
    ]);
    mkdirSync(join(dir, 'src/control'), { recursive: true });
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(
      join(dir, 'src/control/documented.ts'),
      "/** Import from './made-up-module' rather than from individual files. */\n" +
        "// and also never from '../another-fiction'\n" +
        'export const ok = true;\n',
    );
    writeFileSync(join(dir, 'tests/placeholder.ts'), 'export const ok = true;\n');

    const output = run(join(dir, 'scripts/verify-repository.mjs'), [], dir).output;
    expect(output).not.toContain('made-up-module');
    expect(output).not.toContain('another-fiction');
  });

  it('fails when an embedded Rust input is absent', () => {
    /*
     * `include_str!` of a missing file is a compile error, but it surfaces
     * three layers down inside cargo. The completeness gate exists to name the
     * input first — and without a mutation, gutting this branch is invisible.
     */
    const dir = scratchRepo([
      'scripts/verify-repository.mjs',
      'package.json',
      'pnpm-lock.yaml',
      'rust-toolchain.toml',
    ]);
    mkdirSync(join(dir, 'src-tauri/src'), { recursive: true });
    mkdirSync(join(dir, 'crates/cc-align/src'), { recursive: true });
    writeFileSync(
      join(dir, 'src-tauri/src/lib.rs'),
      'const DATA: &str = include_str!("../assets/gone.txt");\n',
    );
    writeFileSync(join(dir, 'crates/cc-align/src/lib.rs'), 'pub fn ok() {}\n');

    const result = run(join(dir, 'scripts/verify-repository.mjs'), [], dir);
    expect(result.status).toBe(1);
    expect(result.output).toContain('gone.txt');
  });

  it('fails when a font a stylesheet points at is absent', () => {
    const dir = scratchRepo([
      'scripts/verify-repository.mjs',
      'package.json',
      'pnpm-lock.yaml',
      'rust-toolchain.toml',
    ]);
    mkdirSync(join(dir, 'src/styles'), { recursive: true });
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(join(dir, 'src/styles/x.ts'), 'export const ok = true;\n');
    writeFileSync(
      join(dir, 'src/styles/fonts.css'),
      "@font-face { src: url('../../assets/fonts/missing.woff2'); }\n",
    );
    writeFileSync(join(dir, 'tests/placeholder.ts'), 'export const ok = true;\n');

    const result = run(join(dir, 'scripts/verify-repository.mjs'), [], dir);
    expect(result.status).toBe(1);
    expect(result.output).toContain('missing.woff2');
  });

  it('does not accept a directory as a resolved module', () => {
    /*
     * `existsSync` returns true for a DIRECTORY, so deleting
     * `src/shared/contracts/index.ts` while leaving the folder behind
     * satisfied this gate — even though every `from '../shared/contracts'` in
     * the tree would then fail to resolve. A barrel file is exactly the kind
     * of thing that gets deleted in a refactor and leaves its directory.
     */
    const dir = scratchRepo([
      'scripts/verify-repository.mjs',
      'package.json',
      'pnpm-lock.yaml',
      'rust-toolchain.toml',
    ]);
    mkdirSync(join(dir, 'src/control/barrel-dir'), { recursive: true });
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(join(dir, 'src/control/uses-it.ts'), "import { x } from './barrel-dir';\n");
    writeFileSync(join(dir, 'tests/placeholder.ts'), 'export const ok = true;\n');

    const emptyDir = run(join(dir, 'scripts/verify-repository.mjs'), [], dir);
    expect(emptyDir.status, 'a directory with no index file is not a module').toBe(1);
    expect(emptyDir.output).toContain('./barrel-dir');

    // Anti-vacuity partner: with an index file present it must resolve.
    writeFileSync(join(dir, 'src/control/barrel-dir/index.ts'), 'export const x = 1;\n');
    expect(run(join(dir, 'scripts/verify-repository.mjs'), [], dir).output).not.toContain(
      './barrel-dir',
    );
  });

  it('checks the worker the compiler is loaded through', () => {
    /*
     * `new URL('../../workers/compiler.worker.ts', import.meta.url)` is not an
     * import statement, and it is load-bearing: that worker compiles every
     * script. A rename that missed it produces an app that cannot open a
     * document, while an import-only scan reports everything resolved.
     */
    const dir = scratchRepo([
      'scripts/verify-repository.mjs',
      'package.json',
      'pnpm-lock.yaml',
      'rust-toolchain.toml',
    ]);
    mkdirSync(join(dir, 'src/control'), { recursive: true });
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(
      join(dir, 'src/control/loads-worker.ts'),
      "const w = new Worker(new URL('../workers/gone.worker.ts', import.meta.url));\n",
    );
    writeFileSync(join(dir, 'tests/placeholder.ts'), 'export const ok = true;\n');

    const result = run(join(dir, 'scripts/verify-repository.mjs'), [], dir);
    expect(result.status).toBe(1);
    expect(result.output).toContain('gone.worker.ts');
  });

  it('rejects a moving Node or Rust pin, and scopes the Rust one to its table', () => {
    const dir = scratchRepo([
      'scripts/verify-repository.mjs',
      'package.json',
      'pnpm-lock.yaml',
    ]);
    writeFileSync(join(dir, '.nvmrc'), 'lts/*\n');
    /*
     * The `channel` here is under `[other]`, not `[toolchain]`. Matching the
     * first textual `channel =` anywhere let a value in an unrelated table
     * satisfy the check while the toolchain itself still tracked `stable`.
     */
    writeFileSync(
      join(dir, 'rust-toolchain.toml'),
      '[other]\nchannel = "1.97.0"\n\n[toolchain]\nchannel = "stable"\n',
    );

    const result = run(join(dir, 'scripts/verify-repository.mjs'), [], dir);
    expect(result.status).toBe(1);
    expect(result.output, 'a moving Node alias is not a pin').toMatch(/exact Node version/);
    expect(result.output, 'the [toolchain] channel is the one that counts').toMatch(
      /moving channel "stable"/,
    );
  });

  it('fails when a scan collapses to nothing rather than reporting clean', () => {
    /*
     * The whole family of silent holes, in one assertion. Every branch of this
     * gate reports violations it FINDS, so a glob that matches nothing reports
     * nothing — which reads identically to a clean tree. A directory rename is
     * exactly the change that would do it.
     */
    const dir = scratchRepo([
      'scripts/verify-repository.mjs',
      'package.json',
      'pnpm-lock.yaml',
      'rust-toolchain.toml',
    ]);
    const result = run(join(dir, 'scripts/verify-repository.mjs'), [], dir);
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/matched nothing/);
  });
});

/* ------------------------------------------------------ no model weights */

const MODEL_SCRIPT = join(REPO_ROOT, 'scripts/verify-no-model-weights.mjs');

/** A minimal but structurally valid macOS `.app`, plus whatever else is asked for. */
function scratchApp(extra: Array<{ path: string; bytes?: number }> = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'candidcue-app-'));
  workspaces.push(dir);
  const app = join(dir, 'CandidCue.app');
  mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
  mkdirSync(join(app, 'Contents/Resources'), { recursive: true });
  writeFileSync(join(app, 'Contents/Info.plist'), '<plist/>\n');
  writeFileSync(join(app, 'Contents/MacOS/candidcue'), 'x');
  for (const { path, bytes } of extra) {
    const target = join(app, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.alloc(bytes ?? 1));
  }
  return app;
}

/*
 * The CONFIGURATION half, which is the half that got weaker.
 *
 * `bundle.resources` was `[]` and asserted empty, which is trivially safe.
 * Shipping the licence notices opened it, and an allow-list of destination
 * names is only as good as what it says about the SOURCE: Tauri resolves a map
 * source three ways — a plain file, a glob whose every match lands under the
 * destination, and a DIRECTORY, which it walks and copies wholesale. The last
 * one is the dangerous shape and the one a size ceiling cannot see, because
 * `statSync` on a directory reports an inode of a couple of hundred bytes.
 */
describe('opening bundle.resources for notices did not open it for models', () => {
  const NEEDS = [
    'scripts/verify-no-model-weights.mjs',
    'src-tauri/tauri.conf.json',
    'THIRD_PARTY_NOTICES.md',
    'assets/fonts/LICENSE.txt',
  ];

  function withResources(resources: unknown, extra?: (dir: string) => void) {
    const dir = scratchRepo(NEEDS);
    const conf = join(dir, 'src-tauri/tauri.conf.json');
    const parsed = JSON.parse(readFileSync(conf, 'utf8'));
    parsed.bundle.resources = resources;
    writeFileSync(conf, `${JSON.stringify(parsed, null, 2)}\n`);
    extra?.(dir);
    return run(join(dir, 'scripts/verify-no-model-weights.mjs'), [], dir);
  }

  it('accepts the two notices this repository actually ships', () => {
    const conf = JSON.parse(readFileSync(join(REPO_ROOT, 'src-tauri/tauri.conf.json'), 'utf8'));
    expect(withResources(conf.bundle.resources).status).toBe(0);
  });

  it('refuses a destination nobody allow-listed', () => {
    const refused = withResources({ '../THIRD_PARTY_NOTICES.md': 'models/weights.onnx' });
    expect(refused.status).toBe(1);
    expect(refused.output).toContain('not allow-listed');
  });

  /* The leak: an allow-listed NAME over a source Tauri walks. */
  it('refuses a directory source, however innocent its destination', () => {
    const refused = withResources({ models: 'THIRD_PARTY_NOTICES.md' }, (dir) => {
      mkdirSync(join(dir, 'src-tauri/models/x-asr-480ms'), { recursive: true });
      writeFileSync(join(dir, 'src-tauri/models/x-asr-480ms/encoder.onnx'), Buffer.alloc(1024));
    });
    expect(refused.status).toBe(1);
    expect(refused.output).toContain('not a regular file');
  });

  it('refuses a glob source, which copies every match under one name', () => {
    const refused = withResources({ 'models/*/*.onnx': 'THIRD_PARTY_NOTICES.md' });
    expect(refused.status).toBe(1);
    expect(refused.output).toContain('glob');
  });

  it('refuses an allow-listed name over something far too large to be a notice', () => {
    const refused = withResources({ '../big.bin': 'THIRD_PARTY_NOTICES.md' }, (dir) => {
      writeFileSync(join(dir, 'big.bin'), Buffer.alloc(3 * 1024 * 1024));
    });
    expect(refused.status).toBe(1);
    expect(refused.output).toContain('not the file that was');
  });

  it('refuses an allow-listed name over a file that is not there', () => {
    const refused = withResources({ '../GONE.md': 'THIRD_PARTY_NOTICES.md' });
    expect(refused.status).toBe(1);
    expect(refused.output).toContain('does not exist');
  });

  /* Every other payload mechanism stays empty, allow-list or no allow-list. */
  it('still refuses every other way of putting files in a bundle', () => {
    const dir = scratchRepo(NEEDS);
    const conf = join(dir, 'src-tauri/tauri.conf.json');
    const parsed = JSON.parse(readFileSync(conf, 'utf8'));
    parsed.bundle.externalBin = ['binaries/whatever'];
    writeFileSync(conf, `${JSON.stringify(parsed, null, 2)}\n`);
    const refused = run(join(dir, 'scripts/verify-no-model-weights.mjs'), [], dir);
    expect(refused.status).toBe(1);
    expect(refused.output).toContain('externalBin');
  });
});

describe('the installer is proven to carry no speech-model weights', () => {
  it('passes on a plain valid bundle', () => {
    const result = run(MODEL_SCRIPT, [scratchApp()], REPO_ROOT);
    expect(result.status).toBe(0);
    expect(result.output).toMatch(/2 files inspected/);
  });

  it('refuses to vouch for a path that is not a bundle', () => {
    /*
     * This script used to accept any path that existed. Pointed at a regular
     * file, an empty directory, or a path whose glob matched nothing, it
     * printed "the installer contains no model weights" having inspected zero
     * files — a claim made on the strength of looking at nothing, which is
     * exactly how a check survives the build step it watches being renamed.
     */
    expect(run(MODEL_SCRIPT, [join(REPO_ROOT, 'package.json')], REPO_ROOT).status).toBe(1);

    const empty = mkdtempSync(join(tmpdir(), 'candidcue-empty-'));
    workspaces.push(empty);
    const result = run(MODEL_SCRIPT, [empty], REPO_ROOT);
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/does not look like a macOS application bundle/);
  });

  it('sees a HIDDEN model file', () => {
    /*
     * The blind spot that mattered most: `globSync('**\/*')` does not match
     * dot-prefixed entries, so a bundle containing
     * `Contents/Resources/.model.onnx` satisfied the layout check and exited 0
     * without ever looking at the model. A gate whose bypass is "put a dot in
     * front of the filename" is not a gate.
     */
    const app = scratchApp([{ path: 'Contents/Resources/.model.onnx' }]);
    const result = run(MODEL_SCRIPT, [app], REPO_ROOT);
    expect(result.status).toBe(1);
    expect(result.output).toContain('.model.onnx');
  });

  it('sees a large payload whose name merely mentions the runtime', () => {
    /*
     * The runtime exemption used to be `/onnxruntime|sherpa/i` against the
     * whole PATH, which waved past every size rule for anything mentioning
     * them — including a 161 MB `sherpa-model.data`, precisely the payload
     * this script exists to catch. It is now an exact basename list with
     * per-library ceilings.
     */
    const app = scratchApp([
      { path: 'Contents/Resources/sherpa-model.data', bytes: 9 * 1024 * 1024 },
    ]);
    const result = run(MODEL_SCRIPT, [app], REPO_ROOT);
    expect(result.status).toBe(1);
    expect(result.output).toContain('sherpa-model.data');
  });

  it('still lets the real runtime library through', () => {
    // Anti-vacuity partner: if the exemption were simply deleted, the test
    // above would pass and this one would fail.
    const app = scratchApp([
      { path: 'Contents/Frameworks/libonnxruntime.dylib', bytes: 30 * 1024 * 1024 },
    ]);
    expect(run(MODEL_SCRIPT, [app], REPO_ROOT).status).toBe(0);
  });

  it('fails when a payload declaration other than resources is used', () => {
    /*
     * `bundle.resources` is not the only way to put files in a Tauri bundle.
     * Checking it alone made this a check on one spelling of the mistake.
     */
    const source = readFileSync(MODEL_SCRIPT, 'utf8');
    for (const declaration of ['externalBin', 'macOS', 'frameworks', 'resources']) {
      expect(source, `${declaration} must be among the payload declarations checked`).toContain(
        declaration,
      );
    }
  });
});

/* ---------------------------------------------- CI runs the same definition */

describe('CI is defined by the release plan, not a hand-copied subset', () => {
  const workflowSource = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');

  /**
   * Comments stripped, for the same reason every other scanner in this change
   * set strips them: the workflow's header explains what
   * `--allow-legal-failure` does, and counting occurrences in raw text made
   * the prose count as a second use of the flag.
   */
  const workflow = workflowSource
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

  it('claims every step in the release plan', async () => {
    /*
     * The claim README and the runner both make is that "CI runs the same
     * command". That was false when first written: CI hand-copied each command
     * and the two definitions were free to drift — the precise failure the
     * single runner was introduced to eliminate.
     *
     * CI now names steps out of the plan with `--only=`, and this asserts the
     * plan is fully covered. A step added to `release-verify.mjs` with no home
     * in CI fails here instead of quietly never running on any push.
     */
    const { PLAN } = await import('../../scripts/release-verify.mjs');
    expect(PLAN.length, 'importing the plan must not yield an empty list').toBeGreaterThan(5);

    const unclaimed = PLAN.filter((step: { name: string }) => !workflow.includes(step.name));
    expect(
      unclaimed.map((step: { name: string }) => step.name),
      'these release-plan steps are not named by any CI job',
    ).toEqual([]);
  });

  it('names only steps the plan actually defines', async () => {
    /*
     * The other direction: `--only=` rejects an unknown name at runtime, but
     * that failure would only appear on a push. A typo in the workflow is
     * worth catching here.
     */
    const { PLAN } = await import('../../scripts/release-verify.mjs');
    const known = new Set(PLAN.map((step: { name: string }) => step.name));

    const named = [...workflow.matchAll(/--only='([^']+)'/g)]
      .flatMap((match) => match[1]!.split(','))
      .map((name) => name.trim())
      // The Rust job builds its list from a matrix, so the literal in the
      // workflow is an expression rather than a step name.
      .filter((name) => !name.includes('${{'));

    expect(named.length, 'no --only= invocations found — this test would pass vacuously').toBeGreaterThan(3);
    expect(named.filter((name) => !known.has(name))).toEqual([]);
  });

  it('suppresses the legal gate only where that is intended', () => {
    /*
     * `--allow-legal-failure` is how CI tolerates unresolved `@@LEGAL_*@@`
     * placeholders without training people to ignore a red build. It must not
     * spread: a job that passed it around the test or build steps would be
     * suppressing nothing useful and hiding the flag's meaning.
     */
    const occurrences = workflow.match(/--allow-legal-failure/g) ?? [];
    expect(occurrences.length, 'exactly one job may tolerate the legal gate').toBe(1);
    // And it must be the job that actually runs the legal gate.
    const gatesJob = workflow.slice(workflow.indexOf('gates:'), workflow.indexOf('frontend:'));
    expect(gatesJob).toContain('--allow-legal-failure');
    expect(gatesJob).toContain('legal gate');
  });
});

/* ------------------------------------------------ the release workflow */

describe('the release workflow cannot publish an unverified build', () => {
  const workflow = readFileSync(join(REPO_ROOT, '.github/workflows/release.yml'), 'utf8');
  const uncommented = workflow
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

  it('does not suppress the legal gate', () => {
    /*
     * `ci.yml` passes `--allow-legal-failure` so day-to-day pushes are not
     * blocked by placeholders only the business can fill in. A RELEASE must
     * not: a build shipping an `@@LEGAL_*@@` in its licence agreement is the
     * one outcome nobody can undo after the fact.
     */
    expect(uncommented, 'a release may not tolerate unresolved placeholders').not.toContain(
      '--allow-legal-failure',
    );
    expect(uncommented, 'and it must run the gate at all').toContain('release-verify.mjs');
  });

  it('inspects the artifact rather than trusting the build', () => {
    /*
     * The review's point: a Tauri app can pass every test in the repository
     * and still fail after signing — entitlements, nested binaries,
     * quarantine, a missing resource, an architecture mismatch. None of that
     * is visible from source.
     */
    expect(uncommented).toContain('verify-signed-bundle.mjs');
    expect(uncommented, 'and without the unsigned escape hatch').not.toMatch(
      /verify-signed-bundle\.mjs[^\n]*--unsigned/,
    );
  });

  it('publishes only after everything else has run', () => {
    /*
     * Ordering is the guarantee. A publish step that ran before the
     * inspection would put an unverified artifact on a download page, and no
     * later failure could take it back.
     */
    const inspect = uncommented.indexOf('verify-signed-bundle.mjs');
    const checksums = uncommented.indexOf('shasum -a 256');
    const publish = uncommented.indexOf('gh release create');

    expect(inspect, 'the inspection step must exist').toBeGreaterThan(-1);
    expect(publish, 'the publish step must exist').toBeGreaterThan(-1);
    expect(inspect).toBeLessThan(publish);
    expect(checksums).toBeLessThan(publish);
  });

  it('records the provenance a release has to carry', () => {
    for (const evidence of ['provenance/toolchain.txt', 'SHA256SUMS', 'verify-supply-chain.mjs']) {
      expect(uncommented, `${evidence} must be produced`).toContain(evidence);
    }
    // rustc and node versions, not just "we built it".
    expect(uncommented).toContain('rustc --version');
    expect(uncommented).toContain('node --version');
  });

  it('builds for both architectures', () => {
    /*
     * An arm64-only release does not open on an Intel Mac, and what the user
     * sees is "the application cannot be opened" with no reason given.
     */
    expect(uncommented).toContain('universal-apple-darwin');
  });

  it('fails rather than producing an unsigned build', () => {
    expect(uncommented).toMatch(/APPLE_CERTIFICATE/);
    expect(
      uncommented,
      'a missing certificate must stop the release, not silently produce an unsigned one',
    ).toMatch(/An unsigned build is not a release/);
  });

  /*
   * The tag and the source version are two independent declarations of the
   * same fact, and nothing forced them to agree. `v1.0.0` building
   * `1.0.0-rc.2` produces a signed, notarised artifact whose About box, its
   * download page and its checksum record each name a different thing — and it
   * is published before anyone reads the version.
   */
  it('refuses a tag that does not name the version being built', () => {
    expect(uncommented, 'the tag gate must run').toContain('version.mjs tag');
    const gate = uncommented.indexOf('version.mjs tag');
    const build = uncommented.indexOf('tauri build');
    expect(build, 'the build step must exist').toBeGreaterThan(-1);
    expect(gate, 'checking after the build wastes a notarisation round trip').toBeLessThan(build);
  });

  /*
   * The published notes used to be one sentence in this file, identical for
   * every release: true, and no help at all to somebody deciding whether to
   * install it. Reading them from the repository puts them under review with
   * the code, and CHECKING them before the build makes an undescribed release
   * a fast failure rather than a published one.
   */
  it('publishes notes written in the repository', () => {
    expect(uncommented).toContain('release-notes.mjs');
    expect(uncommented, 'the notes must come from a file, not a literal').toContain('--notes-file');
    expect(uncommented, 'and not from the old fixed sentence').not.toContain(
      '--notes "Signed and notarised',
    );
    const check = uncommented.indexOf('release-notes.mjs');
    expect(check).toBeLessThan(uncommented.indexOf('tauri build'));
  });

  /*
   * `set -e` exits the step the moment the build fails, so a trailing `rm`
   * never ran on exactly the runs where somebody afterwards goes digging
   * through the workspace. The decoded App Store Connect private key has to be
   * removed on every exit path, not only the happy one.
   */
  /*
   * `set -e` exits the step the moment the build fails, so a trailing `rm`
   * never ran on exactly the runs where somebody afterwards goes digging
   * through the workspace. And an EXIT trap alone does not run for a SIGNAL,
   * which is how a cancelled workflow ends — so the decoded App Store Connect
   * private key and the decoded .p12 both need INT/TERM as well.
   */
  it('removes every decoded credential on failure and on cancellation', () => {
    for (const signal of ['EXIT', 'INT', 'TERM']) {
      const traps = uncommented.match(new RegExp(`trap [^\\n]*\\b${signal}\\s*$`, 'gm')) ?? [];
      expect(traps.length, `both credential steps must trap ${signal}`).toBe(2);
    }
    // And a last sweep that runs even if a step never returns at all.
    expect(uncommented).toMatch(/if: always\(\)/);
    expect(uncommented).toMatch(/rm -f[^\n]*apple-api-key\.p8[^\n]*certificate\.p12/);
  });

  /*
   * The header said "Four repository secrets" and then listed six. A release
   * operator provisioning from that comment stops two short and discovers it
   * at the signing step of a real release.
   *
   * Compared as two SETS, not as a count. A count stays green when a real
   * `secrets.APPLE_*` reference is deleted but the header still lists it —
   * which is the same defect pointing the other way, and the more dangerous
   * one: the release then builds unsigned-adjacent with a secret nobody knows
   * stopped being used.
   */
  it('documents exactly the Apple secrets it uses', () => {
    // Up to the first line that IS `on:`, not the first occurrence of those
    // two characters — the header prose contains several.
    const header = workflow.slice(0, workflow.search(/^on:$/m));
    const documented = new Set(header.match(/\bAPPLE_[A-Z_0-9]+\b/g) ?? []);
    const used = new Set(
      [...workflow.matchAll(/secrets\.(APPLE_[A-Z_0-9]+)/g)].map((match) => match[1]),
    );
    expect([...used].sort(), 'every secret used must be documented').toEqual([...documented].sort());
    expect(used.size, 'six, as the header now says').toBe(6);
    expect(workflow).toMatch(/Six repository secrets/);
    expect(workflow).not.toMatch(/Four repository secrets/);
  });

  /*
   * `gh release create` defaults to a full release, so `v1.0.0-rc.1` would
   * have published as the Latest release of CandidCue — offered on the
   * releases page as the thing to download.
   */
  it('marks a prerelease tag as a prerelease', () => {
    expect(uncommented).toContain('--prerelease');
    expect(uncommented, 'and must not be able to become Latest').toContain('--latest=false');
  });

  /*
   * `gh release create` CREATES a missing tag from the default branch. A tag
   * deleted or moved while the run was building would be silently recreated at
   * a different commit, with artifacts built from the original one attached.
   */
  it('publishes only against a tag that already exists', () => {
    expect(uncommented).toContain('--verify-tag');
  });
});

/* ------------------------------------------------ the release notes */

/**
 * The two tag-scoped gates, RUN rather than grepped for.
 *
 * The workflow assertions above can only prove that a step invoking these
 * scripts sits before the build. That is worth pinning — ordering is the whole
 * point of a pre-build gate — but it would stay green if either script became
 * `process.exit(0)`. These drive the scripts against scratch trees and break
 * the thing each one is for.
 */
describe('the tag gate refuses what it exists to refuse', () => {
  const NEEDS = [...VERSION_FILES, 'scripts/version.mjs'];

  function tagCheck(tag: string, version?: string) {
    const dir = scratchRepo(NEEDS);
    if (version !== undefined) {
      const manifest = join(dir, 'package.json');
      const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
      parsed.version = version;
      writeFileSync(manifest, `${JSON.stringify(parsed, null, 2)}\n`);
    }
    return run(join(dir, 'scripts/version.mjs'), ['tag', tag], dir);
  }

  it('accepts the tag that names the version', () => {
    const version = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version;
    expect(tagCheck(`v${version}`).status).toBe(0);
  });

  /*
   * The defect in one line: `v1.0.0` building `1.0.0-rc.2` produces a signed,
   * notarised artifact whose About box disagrees with its own download page.
   */
  it('refuses a tag that names a different version', () => {
    const refused = tagCheck('v1.0.0', '1.0.0-rc.2');
    expect(refused.status).toBe(1);
    expect(refused.output).toContain('Tag/version mismatch');
  });

  it('refuses a tag that is not exactly `v` plus the version', () => {
    const version = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version;
    for (const tag of [`release-v${version}`, version, `v${version}-final`]) {
      expect(tagCheck(tag).status, `${tag} must be refused`).toBe(1);
    }
  });

  /*
   * The tag agreeing with package.json while tauri.conf.json lags is the same
   * defect one file further down — and tauri.conf.json is the one the bundle
   * reports as CFBundleShortVersionString.
   */
  it('refuses a matching tag when a consumer manifest has drifted', () => {
    const dir = scratchRepo(NEEDS);
    const version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
    const conf = join(dir, 'src-tauri/tauri.conf.json');
    writeFileSync(conf, readFileSync(conf, 'utf8').replace(version, '0.9.9'));
    const refused = run(join(dir, 'scripts/version.mjs'), ['tag', `v${version}`], dir);
    expect(refused.status).toBe(1);
    expect(refused.output).toContain('tauri.conf.json');
  });
});

describe('the release notes gate refuses what it exists to refuse', () => {
  const NEEDS = ['scripts/release-notes.mjs', 'CHANGELOG.md'];

  function notesFor(changelog: string, tag = 'v1.0.0') {
    const dir = scratchRepo(NEEDS);
    writeFileSync(join(dir, 'CHANGELOG.md'), changelog);
    return run(join(dir, 'scripts/release-notes.mjs'), [tag, '--check'], dir);
  }

  const REAL = readFileSync(join(REPO_ROOT, 'CHANGELOG.md'), 'utf8');
  const WRITTEN =
    'CandidCue 1.0 is a voice-following teleprompter for macOS 12 and later, on ' +
    'Apple Silicon and Intel. Voice following is English only and the speech model ' +
    'is a separate download you start yourself.';

  it('accepts the notes this repository actually ships', () => {
    expect(notesFor(REAL).status).toBe(0);
  });

  it('refuses a tag with no section', () => {
    const refused = notesFor(REAL, 'v9.9.9');
    expect(refused.status).toBe(1);
    expect(refused.output).toContain('no "## v9.9.9" section');
  });

  it('lets a candidate read the release it is a candidate for', () => {
    expect(notesFor(REAL, 'v1.0.0-rc.7').status).toBe(0);
  });

  it('refuses a section that is empty or a stub', () => {
    expect(notesFor('# Changelog\n\n## v1.0.0\n').status).toBe(1);
    expect(notesFor(`# Changelog\n\n## v1.0.0\n\nTODO: ${WRITTEN}\n`).status).toBe(1);
    expect(notesFor(`# Changelog\n\n## v1.0.0\n\nTBD. ${WRITTEN}\n`).status).toBe(1);
  });

  /*
   * A section whose bulk is an HTML comment or a code fence clears a raw
   * character count and renders as an empty release page. That is the same
   * "described nowhere" outcome the gate exists to prevent, arriving through
   * the front door.
   */
  it('refuses a section that renders as nothing', () => {
    expect(notesFor(`# Changelog\n\n## v1.0.0\n\n<!--\n${WRITTEN}\n-->\n`).status).toBe(1);
    expect(notesFor(`# Changelog\n\n## v1.0.0\n\n\`\`\`\n${WRITTEN}\n\`\`\`\n`).status).toBe(1);
  });

  /*
   * The parser must not find a heading inside a code block. Release notes are
   * exactly the kind of document that quotes shell and Markdown, and treating
   * a quoted `## v…` as a section would publish a code sample.
   */
  it('does not mistake a heading inside a fence for a section', () => {
    for (const fence of ['```', '~~~', '````']) {
      const inside = `# Changelog\n\n${fence}\n## v1.0.0\n\n${WRITTEN}\n${fence}\n`;
      expect(notesFor(inside).status, `a heading inside ${fence} is not a section`).toBe(1);
    }
  });

  it('does not mistake a heading inside an HTML comment for a section', () => {
    expect(notesFor(`# Changelog\n\n<!--\n## v1.0.0\n\n${WRITTEN}\n-->\n`).status).toBe(1);
  });

  /*
   * `## v1.0.0 — First release` is a real heading. The first version ignored
   * it, which was worse than not finding it: it did not terminate the section
   * above either, so one version's notes silently absorbed the next one's.
   */
  it('reads a heading that carries trailing text, and lets it end the section above', () => {
    const trailing = `# Changelog\n\n## v1.0.0 — First release\n\n${WRITTEN}\n`;
    expect(notesFor(trailing).status).toBe(0);

    const bleeding =
      `# Changelog\n\n## v2.0.0\n\nThe second release. ${WRITTEN}\n\n` +
      `## v1.0.0 — First release\n\n${WRITTEN}\n`;
    const dir = scratchRepo(NEEDS);
    writeFileSync(join(dir, 'CHANGELOG.md'), bleeding);
    const printed = run(join(dir, 'scripts/release-notes.mjs'), ['v2.0.0'], dir);
    expect(printed.status).toBe(0);
    expect(printed.output, 'v2.0.0 must not absorb the section below it').not.toContain(
      'First release',
    );
  });

  it('refuses two sections for the same version', () => {
    const twice = `# Changelog\n\n## v1.0.0\n\n${WRITTEN}\n\n## v1.0.0\n\nSomething else. ${WRITTEN}\n`;
    const refused = notesFor(twice);
    expect(refused.status).toBe(1);
    expect(refused.output).toContain('more than one');
  });

  it('refuses a tag that is not a release tag at all', () => {
    for (const tag of ['v-company-1.0.0', 'vfinal', '1.0.0', 'latest']) {
      expect(notesFor(REAL, tag).status, `${tag} must be refused`).toBe(1);
    }
  });
});

describe('the notes this tree would actually publish', () => {
  const version = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version;

  /*
   * The SECTION, extracted the way the workflow extracts it — not the whole
   * CHANGELOG.
   *
   * Searching the file would let every assertion below be satisfied by an old
   * release's section, or by a code fence, or by an HTML comment, while the
   * section this tree would publish said none of it. What a release page shows
   * is one section, so that is what gets asserted on.
   */
  const dir = scratchRepo(['scripts/release-notes.mjs', 'CHANGELOG.md']);
  const extracted = run(join(dir, 'scripts/release-notes.mjs'), [`v${version}`], dir);

  it('has a section for the version this tree declares', () => {
    /*
     * A release candidate reads the release it is a candidate for, which is
     * what `release-notes.mjs` does: rewriting the same notes for every rc.N
     * is churn, and the notes an RC ships under are the ones being proofread.
     */
    expect(extracted.status, extracted.output).toBe(0);
  });

  /*
   * The 1.0 contract, as a test. Each of these is a fact a buyer needs before
   * downloading, and each is one the readiness review named as required.
   */
  it('states the 1.0 contract a buyer needs before downloading', () => {
    for (const fact of [
      /macOS 12/,
      /Apple Silicon and Intel/i,
      /English only/i,
      /separate download|not in the installer/i,
      /manual|manually/i,
      /no cloud/i,
      /probabilistic/i,
    ]) {
      expect(extracted.output, `the notes must state: ${fact}`).toMatch(fact);
    }
  });

  /*
   * The exclusions, stated rather than merely unclaimed.
   *
   * Note what this deliberately does NOT try to be: a blacklist of overclaims.
   * "No telemetry opt-out; CandidCue collects analytics" evades any phrase ban
   * anyone can write, so a blacklist here would buy confidence it cannot
   * deliver. What a test CAN check is that each exclusion the review named is
   * present and specific — which is the thing that goes missing when notes are
   * rewritten in a hurry.
   */
  it('states each exclusion the 1.0 contract depends on', () => {
    expect(extracted.output, 'macOS-only must be explicit').toMatch(/no Windows or Linux build/i);
    expect(extracted.output, 'the absence of an updater must be explicit').toMatch(
      /contains no updater/i,
    );
    expect(extracted.output, 'the absence of telemetry must be explicit').toMatch(/No telemetry/i);

    // The two documented degraded analyses must be listed as limitations,
    // never implied to work.
    expect(extracted.output).toMatch(/choppy/i);
    expect(extracted.output).toMatch(/variety score/i);
  });

  /*
   * The model size is the one number here that drifts silently: the catalogue
   * changes and prose does not. Both figures are checked against the catalogue
   * that the installer actually reads, in the MiB-as-MB the app displays.
   */
  it('quotes the model size the catalogue actually declares', () => {
    const catalogue = JSON.parse(
      readFileSync(join(REPO_ROOT, 'src-tauri/models/catalogue.json'), 'utf8'),
    );
    const model = catalogue.models.find(
      (entry: { id: string }) => entry.id === catalogue.defaultModelId,
    );
    const mib = (bytes: number) => Math.round(bytes / 1024 / 1024);
    const download = mib(model.archive.bytes);
    const installed = mib(
      model.files.reduce((total: number, file: { bytes: number }) => total + file.bytes, 0),
    );
    expect(extracted.output, `the download size must read ${download} MB`).toContain(
      `${download} MB`,
    );
    expect(extracted.output, `the installed size must read ${installed} MB`).toContain(
      `${installed} MB`,
    );
  });

  it('quotes the minimum macOS version the bundle actually sets', () => {
    const conf = JSON.parse(
      readFileSync(join(REPO_ROOT, 'src-tauri/tauri.conf.json'), 'utf8'),
    );
    const minimum = String(conf.bundle.macOS.minimumSystemVersion).split('.')[0];
    expect(extracted.output).toContain(`macOS ${minimum}`);
  });
});

/* -------------------------------------------- the release pipeline's authority */

describe('the release pipeline holds no more authority than it needs', () => {
  const RELEASE = '.github/workflows/release.yml';
  const workflow = readFileSync(join(REPO_ROOT, RELEASE), 'utf8');
  const uncommented = workflow
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

  /** A job's body: from its key to the next key at the same indentation. */
  const job = (name: string): string => {
    const start = uncommented.indexOf(`\n  ${name}:`);
    expect(start, `${RELEASE} has no ${name} job`).toBeGreaterThan(-1);
    const rest = uncommented.slice(start + 1);
    const next = rest.search(/\n {2}[a-z][\w-]*:\n/);
    return next === -1 ? rest : rest.slice(0, next);
  };

  /*
   * The readiness review's point, and it is about blast radius rather than
   * about trust. The build job runs the whole test suite, a cargo build, the
   * bundler and every verification script — thousands of packages' worth of
   * code — and none of it needs to be able to write to the repository. A
   * compromised dependency in that job must not be able to create a release,
   * move a tag, or push a commit.
   */
  it('builds with read-only permissions and publishes from a separate job', () => {
    expect(uncommented, 'the workflow default must be read-only').toMatch(
      /^permissions:\n\s+contents: read/m,
    );

    const build = job('build');
    expect(build, 'the build job must state its permissions rather than inherit them').toContain(
      'permissions:',
    );
    expect(
      build.includes('contents: write'),
      'the build job can write to the repository. It runs the most third-party ' +
        'code in the pipeline and needs none of that authority — move whatever ' +
        'needs it into the publish job.',
    ).toBe(false);

    const publish = job('publish');
    expect(publish, 'publishing needs write, and is the only step that does').toContain(
      'contents: write',
    );
    expect(publish, 'and it must consume the build job rather than rebuild').toContain(
      'needs: build',
    );
    expect(
      publish.includes('tauri build'),
      'the publish job builds. Then a write-capable job is running the bundler ' +
        'and the whole point of the split is gone.',
    ).toBe(false);
  });

  /*
   * A GitHub Environment is the only mechanism that can make a publication
   * wait for a person. Naming one costs nothing when it is unconfigured —
   * GitHub creates an unprotected environment on demand — and the moment
   * somebody adds a required reviewer to `release-stable`, every stable
   * release needs a deliberate human action.
   */
  it('routes stable and prerelease publications through separate environments', () => {
    const publish = job('publish');
    expect(publish, 'the publish job must name an environment').toContain('environment:');
    expect(publish).toContain('release-stable');
    expect(publish).toContain('release-prerelease');
  });

  /*
   * The copyleft evidence has to be about the bytes that ship.
   *
   * Two earlier shapes of this step did not establish that. Rebuilding each
   * architecture AFTER the signed app existed described a rebuild; building
   * them BEFORE and hoping for a cache hit does not work either, because the
   * Tauri CLI adds `--bins`, `tauri/custom-protocol` and its own deployment
   * target, so a hand-written cargo command compiles something else.
   *
   * The shape that holds is a per-target rustflag: cargo applies it to its own
   * target, so the BUNDLER'S OWN links write the maps. What this asserts is
   * that arrangement — one map variable per triple, and a byte comparison
   * against the slices lipo actually combined.
   */
  it('takes its copyleft maps from the links that ship', () => {
    expect(uncommented, 'the map check must still run').toContain(
      'verify-no-copyleft-objects.mjs',
    );

    for (const triple of ['AARCH64_APPLE_DARWIN', 'X86_64_APPLE_DARWIN']) {
      expect(
        uncommented,
        `CARGO_TARGET_${triple}_RUSTFLAGS must carry the link map for that slice. A ` +
          `plain RUSTFLAGS cannot: both targets would write to one path and the ` +
          `second link would overwrite the first one's evidence.`,
      ).toContain(`CARGO_TARGET_${triple}_RUSTFLAGS`);
    }

    expect(
      uncommented,
      'a separate `cargo build` for the maps is the shape that does not work — the ' +
        'bundler passes flags of its own, so the hand-written command compiles ' +
        'something else and the maps describe it',
    ).not.toMatch(/cargo build[^\n]*--target "\$arch/);

    expect(
      uncommented,
      'the packaged slices must be compared against the linked ones, byte for byte',
    ).toMatch(/lipo[^\n]*-thin/);
    expect(uncommented, 'and compared, not merely extracted').toMatch(/\bcmp -s\b/);
  });
});

describe('third-party actions are pinned to immutable commits', () => {
  /*
   * A tag is a moving pointer. `actions/checkout@v4` is whatever the owner
   * last pushed to that tag, and repointing a popular tag at a malicious
   * commit is a supply-chain attack that has happened rather than one that
   * might. A full commit SHA cannot be repointed.
   *
   * First-party `actions/*` are not exempt. The compromise that made this a
   * standard practice was of a widely-used action, and "we trust the owner" is
   * the assumption it broke.
   */
  const WORKFLOWS = ['.github/workflows/ci.yml', '.github/workflows/release.yml'];

  it('has workflows to check', () => {
    expect(WORKFLOWS.length).toBeGreaterThan(1);
  });

  it.each(WORKFLOWS)('%s pins every action it uses', (relPath) => {
    const source = readFileSync(join(REPO_ROOT, relPath), 'utf8');
    const uses = [...source.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((match) => match[1]!);
    expect(uses.length, `${relPath} declares no actions — the scan has rotted`).toBeGreaterThan(3);

    const unpinned = uses.filter((ref) => !/@[0-9a-f]{40}$/.test(ref));
    expect(
      unpinned,
      `${relPath} uses actions by a mutable reference:\n` +
        unpinned.map((ref) => `  ${ref}`).join('\n') +
        `\n\nPin each to a full commit SHA with the version in a trailing ` +
        `comment:\n  gh api repos/<owner>/<repo>/git/ref/tags/<tag> --jq .object.sha\n` +
        `(dereference the result with git/tags/<sha> if it is an annotated tag).`,
    ).toEqual([]);

    // A bare SHA is unreadable. Every pin carries the version it was.
    const undocumented = [...source.matchAll(/^\s*-?\s*uses:\s*(\S+@[0-9a-f]{40})(.*)$/gm)]
      .filter((match) => !/#\s*v?\d/.test(match[2]!))
      .map((match) => match[1]!);
    expect(
      undocumented,
      `${relPath} pins these without saying which version they are:\n` +
        undocumented.map((ref) => `  ${ref}`).join('\n') +
        `\n\nAdd a trailing comment — nobody can review or update a bare hash.`,
    ).toEqual([]);
  });
});
