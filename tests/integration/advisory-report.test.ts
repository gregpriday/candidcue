/**
 * The advisory report, and the exception register it reads.
 *
 * `scripts/report-advisories.mjs` sorts what `cargo audit` and `pnpm audit`
 * print against `docs/advisory-exceptions.json`, so a release's advisory report
 * separates NEW findings from ones somebody already traced and accepted. The
 * scanners query a database that changes on its own, so nothing here runs one:
 * the report is fed saved scanner output through `--from`, which is the same
 * path the release's raw output can be re-read through later.
 *
 * What matters most is that the register cannot quietly hide something. An
 * exception covers one exact lockfile, package, version and advisory id; a
 * scan that failed is a failure rather than a clean result; and a dev-only
 * exception stops covering a finding the moment the production scan reports it.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fakeTool } from '../helpers/fake-tool';

const REPO_ROOT = resolve(__dirname, '../..');
const SCRIPT = join(REPO_ROOT, 'scripts/report-advisories.mjs');
const REGISTER = 'docs/advisory-exceptions.json';
const TODAY = '2026-10-17';

const workspaces: string[] = [];

afterAll(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'candidcue-advisories-'));
  workspaces.push(dir);
  return dir;
}

/* ------------------------------------------------------ scanner output */

type Crate = [name: string, version: string, id: string | null];

/** The parts of `cargo audit --json` the report reads. */
function cargoReport(vulnerabilities: Crate[] = [], warnings: Record<string, Crate[]> = {}) {
  const entry = ([name, version, id]: Crate, kind: string) => ({
    kind,
    package: { name, version },
    advisory: id === null ? null : { id, title: `${name} advisory` },
  });
  return {
    database: { 'last-commit': '64f92cdc64401fab', 'last-updated': '2026-10-17T01:27:42+02:00' },
    vulnerabilities: {
      found: vulnerabilities.length > 0,
      count: vulnerabilities.length,
      list: vulnerabilities.map((crate) => entry(crate, 'vulnerability')),
    },
    warnings: Object.fromEntries(
      Object.entries(warnings).map(([kind, crates]) => [kind, crates.map((crate) => entry(crate, kind))]),
    ),
  };
}

/** The parts of `pnpm audit --json` the report reads. */
function pnpmReport(advisories: Array<[name: string, versions: string[], id: string]> = []) {
  return {
    actions: [],
    advisories: Object.fromEntries(
      advisories.map(([name, versions, id], index) => [
        String(index + 1),
        {
          module_name: name,
          github_advisory_id: id,
          severity: 'high',
          title: `${name} advisory`,
          findings: versions.map((version) => ({ version, paths: [`.>${name}`] })),
        },
      ]),
    ),
    muted: [],
    metadata: {},
  };
}

interface Saved {
  app?: unknown;
  crates?: unknown;
  prod?: unknown;
  all?: unknown;
}

/** A `--save` directory. A scan given as `null` is missing; a string is written raw. */
function saved({ app = cargoReport(), crates = cargoReport(), prod = pnpmReport(), all = pnpmReport() }: Saved) {
  const dir = scratch();
  const files: Array<[string, unknown]> = [
    ['advisories-cargo-app.json', app],
    ['advisories-cargo-crates.json', crates],
    ['advisories-pnpm-prod.json', prod],
    ['advisories-pnpm-all.json', all],
  ];
  for (const [file, content] of files) {
    if (content === null) continue;
    writeFileSync(join(dir, file), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

/* ------------------------------------------------------------ register */

interface Exception {
  lockfile: string;
  findings: Array<{ package: string; version: string; id: string }>;
  reach: string;
  why: string;
  reviewBy: string;
  followUp?: string;
}

function exception(overrides: Partial<Exception> = {}): Exception {
  return {
    lockfile: 'src-tauri/Cargo.lock',
    findings: [{ package: 'rsa', version: '0.9.10', id: 'RUSTSEC-2023-0071' }],
    reach: 'disabled-feature',
    why: 'Listed by sqlx-mysql, which is not enabled.',
    reviewBy: '2027-01-17',
    ...overrides,
  };
}

function registerOf(exceptions: Exception[]): string {
  const path = join(scratch(), 'advisory-exceptions.json');
  writeFileSync(path, JSON.stringify({ about: 'test register', exceptions }));
  return path;
}

function report(from: string, register: string, extra: string[] = []) {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, '--from', from, '--register', register, '--today', TODAY, ...extra],
    { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** The lines under one heading of the report, up to the next blank line. */
function section(output: string, title: string): string[] {
  const lines = output.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`${title} (`));
  expect(start, `the report has a ${title} section`).toBeGreaterThan(-1);
  const end = lines.findIndex((line, index) => index > start && line.trim() === '');
  return lines.slice(start + 1, end === -1 ? undefined : end).filter((line) => line.trim() !== 'none');
}

const RSA: Crate = ['rsa', '0.9.10', 'RUSTSEC-2023-0071'];

/* ------------------------------------------------------------ the sort */

describe('the advisory report', () => {
  it('accepts a finding the register names exactly, and prints the reason with it', () => {
    const result = report(saved({ app: cargoReport([RSA]) }), registerOf([exception()]));

    expect(result.status, result.output).toBe(0);
    expect(section(result.output, 'NEW')).toEqual([]);
    const accepted = section(result.output, 'ACCEPTED').join('\n');
    expect(accepted).toContain('rsa 0.9.10 RUSTSEC-2023-0071');
    expect(accepted).toContain('Listed by sqlx-mysql, which is not enabled.');
    expect(accepted).toContain('review by 2027-01-17');
  });

  it('reports a finding no exception names as NEW, and exits 1', () => {
    const result = report(
      saved({ app: cargoReport([RSA, ['rustls', '0.23.42', 'RUSTSEC-2026-0285']]) }),
      registerOf([exception()]),
    );

    expect(result.status, result.output).toBe(1);
    expect(section(result.output, 'NEW').join('\n')).toContain('rustls 0.23.42 RUSTSEC-2026-0285');
    expect(section(result.output, 'ACCEPTED').join('\n')).toContain('rsa 0.9.10');
  });

  it('does not let an exception cover another version, or the same crate in another lockfile', () => {
    /*
     * The register accepts a decision about one copy of a crate. A bump, or a
     * second workspace starting to depend on it, is a different question and
     * has to be asked again.
     */
    const result = report(
      saved({
        app: cargoReport([['rsa', '0.9.11', 'RUSTSEC-2023-0071']]),
        crates: cargoReport([RSA]),
      }),
      registerOf([exception()]),
    );

    expect(result.status, result.output).toBe(1);
    const fresh = section(result.output, 'NEW');
    expect(fresh).toHaveLength(2);
    expect(fresh.join('\n')).toContain('src-tauri/Cargo.lock  rsa 0.9.11');
    expect(fresh.join('\n')).toContain('crates/Cargo.lock  rsa 0.9.10');
    expect(section(result.output, 'ACCEPTED')).toEqual([]);
    // And the exception that matched nothing is offered for removal.
    expect(section(result.output, 'NO LONGER REPORTED').join('\n')).toContain('rsa 0.9.10 RUSTSEC-2023-0071');
  });

  it('does not let an exception cover another advisory on the same package and version', () => {
    const result = report(
      saved({ app: cargoReport([RSA, ['rsa', '0.9.10', 'RUSTSEC-2099-0001']]) }),
      registerOf([exception()]),
    );

    expect(result.status, result.output).toBe(1);
    expect(section(result.output, 'NEW').join('\n')).toContain('rsa 0.9.10 RUSTSEC-2099-0001');
    const accepted = section(result.output, 'ACCEPTED').join('\n');
    expect(accepted).toContain('rsa 0.9.10 RUSTSEC-2023-0071');
    expect(accepted).not.toContain('RUSTSEC-2099-0001');
  });

  it('moves an accepted finding past its review date to REVIEW OVERDUE', () => {
    const result = report(saved({ app: cargoReport([RSA]) }), registerOf([exception({ reviewBy: '2026-10-16' })]));

    expect(result.status, result.output).toBe(1);
    expect(section(result.output, 'REVIEW OVERDUE').join('\n')).toContain('rsa 0.9.10');
    expect(section(result.output, 'ACCEPTED')).toEqual([]);
  });

  it('treats a missing or unreadable scan as a failure, never as a clean one', () => {
    const result = report(
      saved({ app: null, crates: 'error: no such command: `audit`', prod: { error: { message: 'ENOTFOUND' } } }),
      registerOf([exception()]),
    );

    expect(result.status, result.output).toBe(1);
    const failed = section(result.output, 'SCAN FAILED').join('\n');
    expect(failed).toContain('src-tauri/Cargo.lock');
    expect(failed).toContain('crates/Cargo.lock');
    expect(failed).toContain('ENOTFOUND');
    // A scan that did not run cannot say an exception is stale.
    expect(section(result.output, 'NO LONGER REPORTED')).toEqual([]);
  });

  it('fails a scan it cannot read completely, rather than dropping what it could not read', () => {
    /*
     * Each of these parses as JSON and would once have produced a shorter,
     * cleaner report: a finding nobody can name, a count the list disagrees
     * with, an advisory without the versions it matched.
     */
    const cases: Array<[string, Saved]> = [
      ['a vulnerability without its version', { app: cargoReport([['rsa', '', 'RUSTSEC-2023-0071']]) }],
      [
        'a count the list disagrees with',
        { app: { ...cargoReport(), vulnerabilities: { found: true, count: 1, list: [] } } },
      ],
      ['warnings that are not a list', { app: { ...cargoReport(), warnings: { unsound: null } } }],
      [
        'an advisory without the versions it matched',
        {
          prod: {
            ...pnpmReport(),
            advisories: { '1': { module_name: 'devalue', github_advisory_id: 'GHSA-x', findings: [] } },
          },
        },
      ],
    ];
    for (const [label, scans] of cases) {
      const result = report(saved(scans), registerOf([]));
      expect(result.status, `${label}\n${result.output}`).toBe(1);
      expect(section(result.output, 'SCAN FAILED'), label).toHaveLength(1);
    }

    // A saved report it cannot even open fails that scan, and the rest still run.
    const dir = saved({ app: null, crates: cargoReport([RSA]) });
    mkdirSync(join(dir, 'advisories-cargo-app.json'));
    const result = report(dir, registerOf([]));
    expect(section(result.output, 'SCAN FAILED').join('\n')).toContain('src-tauri/Cargo.lock');
    expect(section(result.output, 'NEW').join('\n')).toContain('crates/Cargo.lock  rsa 0.9.10');
  });

  it('saves what the scanners print, and never an empty file', () => {
    /*
     * The publish job attaches every file in provenance/ to the GitHub
     * release, and GitHub refuses a zero-byte asset. A cargo audit that could
     * not fetch its database prints nothing, and saving that would turn a
     * reported failure into a failed publish.
     */
    const bin = scratch();
    fakeTool(bin, 'cargo', "console.error('error: could not fetch advisory database');\nprocess.exit(1);\n");
    fakeTool(bin, 'pnpm', `console.log(${JSON.stringify(JSON.stringify(pnpmReport()))});\n`);
    const out = scratch();

    const result = spawnSync(
      process.execPath,
      [SCRIPT, '--save', out, '--register', join(REPO_ROOT, REGISTER), '--today', TODAY],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env, GITHUB_ACTIONS: '', PATH: `${bin}${delimiter}${process.env.PATH}` },
      },
    );
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(1);
    expect(section(output, 'SCAN FAILED').join('\n')).toContain('could not fetch advisory database');
    expect(readdirSync(out)).toEqual(['advisories-pnpm-prod.json']);
    expect(JSON.parse(readFileSync(join(out, 'advisories-pnpm-prod.json'), 'utf8'))).toEqual(pnpmReport());
  });

  it('reports every kind of cargo warning, including a yank with no advisory id', () => {
    const result = report(
      saved({
        app: cargoReport([], {
          unmaintained: [['proc-macro-error', '1.0.4', 'RUSTSEC-2024-0370']],
          yanked: [['chacha20', '0.10.1', null]],
        }),
      }),
      registerOf([]),
    );

    expect(result.status, result.output).toBe(1);
    const fresh = section(result.output, 'NEW').join('\n');
    expect(fresh).toContain('proc-macro-error 1.0.4 RUSTSEC-2024-0370  [unmaintained]');
    expect(fresh).toContain('chacha20 0.10.1 yanked  [yanked]');
  });

  it('stops covering a dev-only finding once the production scan reports it', () => {
    const tinypool = exception({
      lockfile: 'pnpm-lock.yaml',
      findings: [{ package: 'tinypool', version: '1.1.1', id: 'GHSA-5gmw-xhrv-c9v3' }],
      reach: 'dev-only',
      why: 'The test runner.',
    });
    const register = registerOf([tinypool]);

    const production = report(saved({ prod: pnpmReport([['tinypool', ['1.1.1'], 'GHSA-5gmw-xhrv-c9v3']]) }), register);
    expect(production.status, production.output).toBe(1);
    expect(section(production.output, 'NEW').join('\n')).toContain('accepted as dev-only, but the production scan');

    const everything = report(
      saved({ all: pnpmReport([['tinypool', ['1.1.1'], 'GHSA-5gmw-xhrv-c9v3']]) }),
      register,
      ['--dev'],
    );
    expect(everything.status, everything.output).toBe(0);
    expect(section(everything.output, 'ACCEPTED').join('\n')).toContain('tinypool 1.1.1');
  });

  it('does not call a dev-only exception stale because the production scan cannot see it', () => {
    const register = registerOf([
      exception({
        lockfile: 'pnpm-lock.yaml',
        findings: [{ package: 'tinypool', version: '1.1.1', id: 'GHSA-5gmw-xhrv-c9v3' }],
        reach: 'dev-only',
      }),
    ]);

    const production = report(saved({}), register);
    expect(production.status, production.output).toBe(0);
    expect(section(production.output, 'NO LONGER REPORTED')).toEqual([]);
    expect(production.output).toContain('1 dev-only exception not checked');

    const everything = report(saved({}), register, ['--dev']);
    expect(section(everything.output, 'NO LONGER REPORTED').join('\n')).toContain('tinypool 1.1.1');
  });

  it('splits a pnpm advisory by installed version', () => {
    const register = registerOf([
      exception({
        lockfile: 'pnpm-lock.yaml',
        findings: [{ package: 'undici', version: '7.29.0', id: 'GHSA-rfgv-xxqx-mfg5' }],
        reach: 'dev-only',
      }),
    ]);
    const all = pnpmReport([['undici', ['7.29.0', '6.21.0'], 'GHSA-rfgv-xxqx-mfg5']]);
    const result = report(saved({ all }), register, ['--dev']);

    expect(result.status, result.output).toBe(1);
    expect(section(result.output, 'ACCEPTED').join('\n')).toContain('undici 7.29.0');
    expect(section(result.output, 'NEW').join('\n')).toContain('undici 6.21.0');
  });

  it('refuses a register entry without a scanned lockfile, a recognised reach, a reason or a review date', () => {
    for (const broken of [
      // A lockfile nothing scans matches nothing, and could never be reported stale.
      exception({ lockfile: 'src-tauri/Cargo.lok' }),
      exception({ reach: 'fine' }),
      exception({ why: ' ' }),
      exception({ reviewBy: 'next year' }),
      exception({ reviewBy: '2026-02-30' }),
      exception({ findings: [] }),
    ]) {
      const result = report(saved({}), registerOf([broken]));
      expect(result.status, result.output).toBe(2);
      expect(result.output).toContain('is malformed');
    }
  });
});

/* ------------------------------------------------------ the real register */

/** `name@version` for every package a lockfile resolves. */
function locked(lockfile: string): Set<string> {
  const text = readFileSync(join(REPO_ROOT, lockfile), 'utf8');
  const found = new Set<string>();
  if (lockfile.endsWith('Cargo.lock')) {
    for (const match of text.matchAll(/^name = "([^"]+)"\nversion = "([^"]+)"$/gm)) found.add(`${match[1]}@${match[2]}`);
  } else {
    // pnpm v9: `  tinypool@1.1.1:` and `  '@vitest/mocker@3.2.7':`, with peer suffixes in snapshots.
    for (const match of text.matchAll(/^ {2}'?(@?[^@\s'(]+)@([^(':\s]+)/gm)) found.add(`${match[1]}@${match[2]}`);
  }
  return found;
}

describe('docs/advisory-exceptions.json', () => {
  const register = JSON.parse(readFileSync(join(REPO_ROOT, REGISTER), 'utf8')) as { exceptions: Exception[] };

  it('is a register the report accepts', () => {
    const result = report(saved({}), join(REPO_ROOT, REGISTER), ['--dev']);
    expect(result.output).not.toContain('is malformed');
    expect(result.status, result.output).toBe(0);
  });

  it('names only packages at versions their lockfile actually resolves', () => {
    /*
     * An exception for a version that is no longer locked covers nothing, and
     * reads as though somebody had looked at what is. This is the offline half
     * of NO LONGER REPORTED: it fails the moment a bump leaves an entry behind,
     * without waiting for a scan.
     */
    const stale: string[] = [];
    for (const { lockfile, findings } of register.exceptions) {
      const versions = locked(lockfile);
      for (const finding of findings) {
        if (!versions.has(`${finding.package}@${finding.version}`)) {
          stale.push(`${lockfile}: ${finding.package}@${finding.version} (${finding.id})`);
        }
      }
    }
    expect(stale, 'update or remove these exceptions').toEqual([]);
  });

  it('links a follow-up only to an issue in this repository', () => {
    for (const { followUp } of register.exceptions) {
      if (followUp === undefined) continue;
      expect(followUp).toMatch(/^https:\/\/github\.com\/gregpriday\/candidcue\/issues\/\d+$/);
    }
  });
});

/* ---------------------------------------------------- the release workflow */

describe('the release advisory step', () => {
  const workflow = readFileSync(join(REPO_ROOT, '.github/workflows/release-macos.yml'), 'utf8');
  const uncommented = workflow
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

  it('runs the report, records it, and still cannot block a release', () => {
    /*
     * The report exits 1 when something is new. That is meant to mark the
     * step, not to stop a tag building for a reason nobody in the repository
     * introduced (`scripts/verify-supply-chain.mjs` has the argument), so the
     * step that runs it has to stay `continue-on-error`.
     */
    const at = uncommented.indexOf('report-advisories.mjs');
    expect(at, 'the release must run scripts/report-advisories.mjs').toBeGreaterThan(-1);
    const stepStart = uncommented.lastIndexOf('- name:', at);
    const stepEnd = uncommented.indexOf('- name:', at);
    const step = uncommented.slice(stepStart, stepEnd === -1 ? undefined : stepEnd);

    expect(step).toMatch(/^\s*continue-on-error: true\s*$/m);
    expect(step).toContain('provenance/advisories.txt');
    // `gh release create` attaches `provenance/*` one file at a time; a
    // subdirectory there would fail the publish.
    expect(step).toMatch(/--save provenance(\s|$)/);
  });
});
