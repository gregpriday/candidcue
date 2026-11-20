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
  const dir = mkdtempSync(join(tmpdir(), 'speaking-glass-advisories-'));
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
function pnpmReport(
  advisories: Array<[name: string, versions: string[], id: string, severity?: string]> = [],
  dependencies = 134,
) {
  return {
    actions: [],
    advisories: Object.fromEntries(
      advisories.map(([name, versions, id, severity = 'high'], index) => [
        String(index + 1),
        {
          module_name: name,
          github_advisory_id: id,
          severity,
          title: `${name} advisory`,
          findings: versions.map((version) => ({ version, paths: [`.>${name}`] })),
        },
      ]),
    ),
    muted: [],
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
      dependencies,
      devDependencies: 0,
      optionalDependencies: 0,
      totalDependencies: dependencies,
    },
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

function report(from: string, register: string, extra: string[] = [], today: string | null = TODAY) {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, '--from', from, '--register', register, ...(today === null ? [] : ['--today', today]), ...extra],
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
      ['no warnings map at all', { app: { ...cargoReport(), warnings: undefined } }],
      [
        'vulnerabilities found, and none listed',
        { app: { ...cargoReport(), vulnerabilities: { found: true, count: 0, list: [] } } },
      ],
      ['no vulnerability count', { app: { ...cargoReport(), vulnerabilities: { found: false, list: [] } } }],
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
        env: {
          ...process.env,
          GITHUB_ACTIONS: '',
          SPEAKING_GLASS_ADVISORY_RETRY_MS: '0',
          CARGO_HOME: scratch(),
        CARGO_HOME: scratch(),
          PATH: `${bin}${delimiter}${process.env.PATH}`,
        },
      },
    );
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(1);
    expect(section(output, 'SCAN FAILED').join('\n')).toContain('could not fetch advisory database');
    expect(readdirSync(out)).toEqual(['advisories-pnpm-prod.json']);
    expect(JSON.parse(readFileSync(join(out, 'advisories-pnpm-prod.json'), 'utf8'))).toEqual(pnpmReport());
  });

  it('reports unmaintained and yanked warnings, a yank with no advisory id included, and lets a tag through', () => {
    /*
     * A maintenance notice is news, not a flaw: it is listed as NEW like any
     * other finding, and on its own it never refuses a tag.
     */
    const result = report(
      saved({
        app: cargoReport([], {
          unmaintained: [['proc-macro-error', '1.0.4', 'RUSTSEC-2024-0370']],
          yanked: [['chacha20', '0.10.1', null]],
        }),
      }),
      registerOf([]),
    );

    expect(result.status, result.output).toBe(0);
    const fresh = section(result.output, 'NEW').join('\n');
    expect(fresh).toContain('proc-macro-error 1.0.4 RUSTSEC-2024-0370  [unmaintained]');
    expect(fresh).toContain('chacha20 0.10.1 yanked  [yanked]');
    expect(section(result.output, 'REFUSES A TAG')).toEqual([]);
    expect(result.output).toContain('Verdict: nothing here refuses a release tag.');
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

/* ---------------------------------------------------------- the policy */

describe('what refuses a release tag', () => {
  const refused = (output: string) => section(output, 'REFUSES A TAG').join('\n');

  it('refuses an uncovered vulnerability', () => {
    const result = report(saved({ app: cargoReport([['zip', '9.0.4', 'RUSTSEC-2026-0548']]) }), registerOf([]));

    expect(result.status, result.output).toBe(1);
    expect(refused(result.output)).toContain('new: src-tauri/Cargo.lock  zip 9.0.4 RUSTSEC-2026-0548  [vulnerability]');
    expect(result.output).toContain('Verdict: a release tag would be REFUSED (1).');
  });

  it('refuses an uncovered unsound warning', () => {
    const result = report(
      saved({ crates: cargoReport([], { unsound: [['tokio', '1.47.1', 'RUSTSEC-2026-0001']] }) }),
      registerOf([]),
    );

    expect(result.status, result.output).toBe(1);
    expect(refused(result.output)).toContain('crates/Cargo.lock  tokio 1.47.1 RUSTSEC-2026-0001  [unsound]');
  });

  it('refuses a cargo warning of a kind it does not know, rather than letting it through', () => {
    const result = report(
      saved({ app: cargoReport([], { notice: [['serde', '1.0.0', 'RUSTSEC-2099-0002']] }) }),
      registerOf([]),
    );

    expect(result.status, result.output).toBe(1);
    expect(refused(result.output)).toContain('serde 1.0.0 RUSTSEC-2099-0002  [notice]');
  });

  it('refuses an uncovered pnpm advisory of low severity', () => {
    const result = report(
      saved({ prod: pnpmReport([['dompurify', ['3.2.6'], 'GHSA-low0-0000-0000', 'low']]) }),
      registerOf([]),
    );

    expect(result.status, result.output).toBe(1);
    expect(refused(result.output)).toContain('pnpm-lock.yaml  dompurify 3.2.6 GHSA-low0-0000-0000  [low]');
  });

  it('refuses a vulnerability whose exception is past its review date', () => {
    const result = report(saved({ app: cargoReport([RSA]) }), registerOf([exception({ reviewBy: '2026-10-16' })]));

    expect(result.status, result.output).toBe(1);
    expect(refused(result.output)).toContain('review overdue: src-tauri/Cargo.lock  rsa 0.9.10 RUSTSEC-2023-0071');
  });

  it('reports an overdue exception for an unmaintained crate, and lets the tag through', () => {
    const unic: Crate = ['unic-common', '0.9.0', 'RUSTSEC-2025-0080'];
    const result = report(
      saved({ app: cargoReport([], { unmaintained: [unic] }) }),
      registerOf([
        exception({
          findings: [{ package: 'unic-common', version: '0.9.0', id: 'RUSTSEC-2025-0080' }],
          reach: 'no-vulnerability',
          reviewBy: '2026-10-16',
        }),
      ]),
    );

    expect(result.status, result.output).toBe(0);
    expect(section(result.output, 'REVIEW OVERDUE').join('\n')).toContain('unic-common 0.9.0');
    expect(refused(result.output)).toBe('');
  });

  it('does not let a no-vulnerability exception cover a finding that refuses', () => {
    /*
     * The exception was written about a maintenance notice. If the same id
     * comes back as a flaw, the reason no longer holds.
     */
    const unic = { package: 'unic-common', version: '0.9.0', id: 'RUSTSEC-2025-0080' };
    const register = registerOf([exception({ findings: [unic], reach: 'no-vulnerability' })]);

    const notice = report(saved({ app: cargoReport([], { notice: [['unic-common', '0.9.0', unic.id]] }) }), register);
    expect(notice.status, notice.output).toBe(1);
    expect(section(notice.output, 'NEW').join('\n')).toContain('accepted as no-vulnerability, but reported as notice');

    const unmaintained = report(
      saved({ app: cargoReport([], { unmaintained: [['unic-common', '0.9.0', unic.id]] }) }),
      register,
    );
    expect(unmaintained.status, unmaintained.output).toBe(0);
    expect(section(unmaintained.output, 'ACCEPTED').join('\n')).toContain('unic-common 0.9.0');
  });

  it('refuses a failed scan', () => {
    const result = report(saved({ crates: null }), registerOf([]));

    expect(result.status, result.output).toBe(1);
    expect(refused(result.output)).toContain('scan failed: crates/Cargo.lock');
  });

  it('treats a pnpm report that counts no dependencies as a failed scan, not a clean one', () => {
    for (const prod of [pnpmReport([], 0), { ...pnpmReport(), metadata: { dependencies: 134 } }]) {
      const result = report(saved({ prod }), registerOf([]));

      expect(result.status, result.output).toBe(1);
      expect(section(result.output, 'SCAN FAILED').join('\n')).toContain('counted no dependencies');
      expect(refused(result.output)).toContain('scan failed: pnpm-lock.yaml (production)');
    }
  });

  it('counts optional-only production packages as audited', () => {
    const prod = pnpmReport();
    prod.metadata = { ...prod.metadata, dependencies: 0, optionalDependencies: 3, totalDependencies: 3 };
    const result = report(saved({ prod }), registerOf([]));

    expect(result.status, result.output).toBe(0);
    expect(section(result.output, 'SCAN FAILED')).toEqual([]);
  });

  it('never lets a pnpm advisory through on a kind that only cargo treats as report-only', () => {
    const result = report(
      saved({ prod: pnpmReport([['marked', ['15.0.0'], 'GHSA-yank-0000-0000', 'yanked']]) }),
      registerOf([]),
    );

    expect(result.status, result.output).toBe(1);
    expect(refused(result.output)).toContain('marked 15.0.0 GHSA-yank-0000-0000');
  });

  it('passes a scan with nothing unreviewed in it', () => {
    const result = report(saved({}), registerOf([]));

    expect(result.status, result.output).toBe(0);
    expect(refused(result.output)).toBe('');
  });

  it('annotates what refuses as an error and what does not as a warning, on GitHub', () => {
    const result = spawnSync(
      process.execPath,
      [
        SCRIPT,
        '--from',
        saved({
          app: cargoReport([['zip', '9.0.4', 'RUSTSEC-2026-0548']], { yanked: [['chacha20', '0.10.1', null]] }),
        }),
        '--register',
        registerOf([]),
        '--today',
        TODAY,
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true' } },
    );

    expect(result.stdout).toContain('::error::new advisory: src-tauri/Cargo.lock zip 9.0.4 RUSTSEC-2026-0548 [vulnerability]');
    expect(result.stdout).toContain('::warning::new advisory: src-tauri/Cargo.lock chacha20 0.10.1 yanked [yanked]');
  });

  it('retries a live scan that fails, and fails it only after the last attempt', () => {
    /*
     * A registry timeout passes; a failed scan refuses a tag. The stand-in
     * cargo fails its first call on each lockfile and answers the second, and
     * the stand-in pnpm never answers at all.
     */
    const bin = scratch();
    const state = scratch();
    fakeTool(
      bin,
      'cargo',
      `import fs from 'node:fs';
import path from 'node:path';
const file = path.join(${JSON.stringify(state)}, process.argv[process.argv.length - 1].replace(/\\W/g, '_'));
if (!fs.existsSync(file)) {
  fs.writeFileSync(file, '1');
  console.error('error: could not fetch advisory database');
  process.exit(1);
}
console.log(${JSON.stringify(JSON.stringify(cargoReport()))});
`,
    );
    fakeTool(bin, 'pnpm', "import fs from 'node:fs';\nfs.appendFileSync(process.env.PNPM_CALLS, 'x');\nprocess.exit(1);\n");
    const calls = join(state, 'pnpm-calls');

    const result = spawnSync(process.execPath, [SCRIPT, '--register', registerOf([]), '--today', TODAY], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_ACTIONS: '',
        SPEAKING_GLASS_ADVISORY_RETRY_MS: '0',
        CARGO_HOME: scratch(),
        PNPM_CALLS: calls,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
      },
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(1);
    expect(output).toContain('src-tauri/Cargo.lock: 0 reported');
    expect(output).toContain('crates/Cargo.lock: 0 reported');
    expect(readFileSync(calls, 'utf8')).toBe('xxx');
    expect(section(output, 'SCAN FAILED').join('\n')).toContain('(after 3 attempts)');
  });
});

describe('a scanner killed partway', () => {
  it.skipIf(process.platform === 'win32')('is a failed scan, even when what it printed parses', () => {
    const bin = scratch();
    fakeTool(
      bin,
      'cargo',
      `import fs from 'node:fs';
fs.writeSync(1, ${JSON.stringify(JSON.stringify(cargoReport()))});
process.kill(process.pid, 'SIGKILL');
`,
    );
    fakeTool(bin, 'pnpm', `console.log(${JSON.stringify(JSON.stringify(pnpmReport()))});\n`);

    const result = spawnSync(process.execPath, [SCRIPT, '--register', registerOf([]), '--today', TODAY], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_ACTIONS: '',
        SPEAKING_GLASS_ADVISORY_RETRY_MS: '0',
        CARGO_HOME: scratch(),
        PATH: `${bin}${delimiter}${process.env.PATH}`,
      },
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(1);
    const failed = section(output, 'SCAN FAILED').join('\n');
    expect(failed).toContain('src-tauri/Cargo.lock: cargo was killed by SIGKILL');
    expect(failed).toContain('crates/Cargo.lock');
  });
});

/** Run the script against stand-in scanners on PATH, the way a release does. */
function live(bin: string, args: string[] = [], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, '--register', registerOf([]), '--today', TODAY, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_ACTIONS: '',
      SPEAKING_GLASS_ADVISORY_RETRY_MS: '0',
      CARGO_HOME: scratch(),
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      ...env,
    },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** Stand-ins that print a clean report, then exit with `exit`. */
function cleanScanners(exit = 0): string {
  const bin = scratch();
  fakeTool(bin, 'cargo', `console.log(${JSON.stringify(JSON.stringify(cargoReport()))});\nprocess.exitCode = ${exit};\n`);
  fakeTool(bin, 'pnpm', `console.log(${JSON.stringify(JSON.stringify(pnpmReport()))});\nprocess.exitCode = ${exit};\n`);
  return bin;
}

describe('a live scan', () => {
  it('reads a report from a scanner that exits 1 for its findings, and fails one that exits otherwise', () => {
    expect(live(cleanScanners(1)).status).toBe(0);

    const crashed = live(cleanScanners(3));
    expect(crashed.status, crashed.output).toBe(1);
    const failed = section(crashed.output, 'SCAN FAILED').join('\n');
    expect(failed).toContain('src-tauri/Cargo.lock: cargo exited with status 3');
    expect(failed).toContain('pnpm-lock.yaml (production): pnpm exited with status 3');
  });

  it('asks pnpm for every severity, and only the production tree unless --dev', () => {
    const bin = scratch();
    const calls = join(scratch(), 'pnpm-args');
    fakeTool(bin, 'cargo', `console.log(${JSON.stringify(JSON.stringify(cargoReport()))});\n`);
    fakeTool(
      bin,
      'pnpm',
      `import fs from 'node:fs';
fs.appendFileSync(process.env.PNPM_ARGS, process.argv.slice(2).join(' ') + '\\n');
console.log(${JSON.stringify(JSON.stringify(pnpmReport()))});
`,
    );
    expect(live(bin, [], { PNPM_ARGS: calls }).status).toBe(0);
    expect(live(bin, ['--dev'], { PNPM_ARGS: calls }).status).toBe(0);
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual([
      'audit --json --prod --audit-level low',
      'audit --json --audit-level low',
    ]);
  });

  it('fails the Cargo scans when a cargo-audit configuration could hide findings', () => {
    const cargoHome = scratch();
    writeFileSync(join(cargoHome, 'audit.toml'), '[advisories]\nignore = ["RUSTSEC-2026-0548"]\n');
    const result = live(cleanScanners(), [], { CARGO_HOME: cargoHome });

    expect(result.status, result.output).toBe(1);
    const failed = section(result.output, 'SCAN FAILED').join('\n');
    expect(failed).toContain('audit.toml configures cargo audit');
    expect(failed).not.toContain('pnpm-lock.yaml');
  });

  it('clears what an earlier run saved, so a silent scanner is not replayed as clean', () => {
    const out = scratch();
    writeFileSync(join(out, 'advisories-cargo-app.json'), JSON.stringify(cargoReport()));
    const bin = cleanScanners();
    fakeTool(bin, 'cargo', 'process.exit(1);\n');

    expect(live(bin, ['--save', out]).status).toBe(1);
    expect(readdirSync(out)).toEqual(['advisories-pnpm-prod.json']);
    expect(section(report(out, registerOf([])).output, 'SCAN FAILED').join('\n')).toContain('src-tauri/Cargo.lock');
  });

  it('refuses an argument it does not know, inherited names included', () => {
    for (const arg of ['constructor', '__proto__', '--nope']) {
      const result = report(saved({}), registerOf([]), [arg, 'x']);
      expect(result.status, arg).toBe(2);
      expect(result.output, arg).toContain('Unknown argument');
    }
  });
});

describe('the accepted-risk reach', () => {
  const zip = (overrides: Partial<Exception> = {}) =>
    exception({
      findings: [{ package: 'zip', version: '4.6.1', id: 'RUSTSEC-2026-0548' }],
      reach: 'accepted-risk',
      why: 'The updater extracts its own signed payload with it; the fix needs an updater release.',
      followUp: 'https://github.com/gregpriday/candidcue/issues/487',
      reviewBy: '2026-11-16',
      ...overrides,
    });

  it('covers a shipped finding with a follow-up and a review inside 30 days', () => {
    const result = report(saved({ app: cargoReport([['zip', '4.6.1', 'RUSTSEC-2026-0548']]) }), registerOf([zip()]));

    expect(result.status, result.output).toBe(0);
    const accepted = section(result.output, 'ACCEPTED').join('\n');
    expect(accepted).toContain('accepted-risk, review by 2026-11-16');
    expect(accepted).toContain('Follow-up: https://github.com/gregpriday/candidcue/issues/487');
  });

  it('still loads once its review date has passed, and then refuses as overdue', () => {
    const result = report(
      saved({ app: cargoReport([['zip', '4.6.1', 'RUSTSEC-2026-0548']]) }),
      registerOf([zip({ reviewBy: '2026-10-16' })]),
    );

    expect(result.status, result.output).toBe(1);
    expect(section(result.output, 'REFUSES A TAG').join('\n')).toContain('review overdue: src-tauri/Cargo.lock  zip 4.6.1');
  });

  it('refuses an entry with no follow-up issue, or one reviewed more than 30 days out', () => {
    const { followUp: _omitted, ...noFollowUp } = zip();
    for (const [label, broken, problem] of [
      ['no follow-up', noFollowUp as Exception, 'links no follow-up issue'],
      ['a follow-up that is not an issue', zip({ followUp: 'see the tracker' }), 'not a GitHub issue URL'],
      [
        'a follow-up in a list',
        zip({ followUp: ['https://github.com/gregpriday/candidcue/issues/487'] as unknown as string }),
        'not a GitHub issue URL',
      ],
      ['a follow-up with no repository', zip({ followUp: 'https://github.com/.././issues/1' }), 'not a GitHub issue URL'],
      ['31 days out', zip({ reviewBy: '2026-11-17' }), 'more than 30 days ahead'],
    ] as const) {
      const result = report(saved({}), registerOf([broken]));
      expect(result.status, `${label}\n${result.output}`).toBe(2);
      expect(result.output, label).toContain('is malformed');
      expect(result.output, label).toContain(problem);
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
    // Today's date, not the pinned one: an accepted-risk entry is held to 30
    // days from when the scan runs.
    const result = report(saved({}), join(REPO_ROOT, REGISTER), ['--dev'], null);
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

/* ------------------------------------------------- the release workflows */

const uncommented = (relPath: string) =>
  readFileSync(join(REPO_ROOT, relPath), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

/** A job's body: from its key to the next key at the same indentation. */
function jobOf(source: string, name: string): string {
  const start = source.indexOf(`\n  ${name}:\n`);
  expect(start, `no ${name} job`).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const next = rest.search(/\n {2}[a-z][\w-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

/** One step, from its `- ` to the next step at the same indentation. */
function stepOf(job: string, marker: string): string {
  const at = job.indexOf(marker);
  expect(at, `no step with ${marker}`).toBeGreaterThan(-1);
  const start = job.lastIndexOf('\n      - ', at);
  const next = job.indexOf('\n      - ', at);
  return job.slice(start + 1, next === -1 ? undefined : next);
}

const SCAN_ACTION = './.github/actions/advisory-scan';
const RELEASE_WORKFLOWS = ['release-macos.yml', 'release-windows.yml', 'release-linux.yml'];
// The publish job's own predicate: a tag, and not a dry run. A push has no
// inputs, so `inputs.dry_run != true` holds there too.
const ENFORCED_ON_TAGS = "enforce: ${{ startsWith(github.ref, 'refs/tags/v') && inputs.dry_run != true }}";

describe('the release advisory gate', () => {
  it.each(RELEASE_WORKFLOWS)('%s scans in its gates job, enforced on a tag that is not a dry run', (file) => {
    const workflow = uncommented(`.github/workflows/${file}`);
    const gates = jobOf(workflow, 'gates');
    const step = stepOf(gates, SCAN_ACTION);

    expect(step).toMatch(/^ {8}uses: \.\/\.github\/actions\/advisory-scan$/m);
    expect(step).toContain(ENFORCED_ON_TAGS);
    // Nothing turns the verdict back into a report: not the step, not a
    // condition on it, not an input of the workflow.
    expect(step).not.toMatch(/continue-on-error/);
    expect(step).not.toMatch(/^\s*if:/m);
    expect(workflow.match(/^ {6}[a-z_]+:\n {8}description:/gm), 'the only workflow input is dry_run').toHaveLength(1);
    expect(workflow).toMatch(/^ {6}dry_run:\n/m);

    // The publish job runs on exactly the condition the gate enforces on.
    expect(jobOf(workflow, 'publish')).toMatch(/^ {4}if: startsWith\(github\.ref, 'refs\/tags\/v'\) && inputs\.dry_run != true$/m);

    // No job anywhere else scans, so no other step can contradict the gate.
    expect(workflow.split(SCAN_ACTION)).toHaveLength(2);
    expect(workflow).not.toContain('report-advisories.mjs');
  });

  it('keeps the macOS report and raw output in the release provenance, from the scan that gated it', () => {
    const workflow = uncommented('.github/workflows/release-macos.yml');
    const gates = jobOf(workflow, 'gates');
    expect(stepOf(gates, SCAN_ACTION)).toMatch(/^\s*save: provenance$/m);
    const upload = stepOf(gates, 'actions/upload-artifact@');
    expect(upload).toMatch(/^\s*id: advisories$/m);
    expect(upload).toMatch(/^\s*path: provenance\/$/m);
    expect(gates).toContain('advisories: ${{ steps.advisories.outputs.artifact-id }}');

    // The build takes it by ID from this run, which a re-run of only the
    // build (a new attempt) can still read, and checks it arrived before the
    // provenance is uploaded.
    const build = jobOf(workflow, 'build');
    expect(build).toMatch(/^\s*actions: read$/m);
    expect(build).toContain(`run: '[[ "$ADVISORIES" =~ ^[0-9]+$ ]]'`);
    expect(build.indexOf('ADVISORIES: ${{ needs.gates.outputs.advisories }}')).toBeLessThan(
      build.indexOf('actions/download-artifact@'),
    );
    const download = stepOf(build, 'actions/download-artifact@');
    expect(download).not.toMatch(/^\s*if:/m);
    expect(download).toContain('artifact-ids: ${{ needs.gates.outputs.advisories }}');
    expect(download).toMatch(/^\s*path: provenance$/m);
    expect(download).toMatch(/^\s*merge-multiple: true$/m);
    expect(download).toContain('run-id: ${{ github.run_id }}');
    expect(download).toContain('github-token: ${{ github.token }}');
    const check = build.indexOf('test -s provenance/advisories.txt');
    expect(check).toBeGreaterThan(build.indexOf('actions/download-artifact@'));
    expect(check).toBeLessThan(build.indexOf('name: speaking-glass-release-macos'));
  });

  it('runs the same scan on develop every day, red on what would refuse a tag', () => {
    const workflow = uncommented('.github/workflows/advisories.yml');
    expect(workflow).toMatch(/^ {2}schedule:\n {4}- cron: '[^']+'$/m);
    expect(workflow).toMatch(/^ {2}workflow_dispatch:$/m);
    expect(workflow).not.toMatch(/^ {2}(push|pull_request):/m);
    // Its own concurrency group, apart from CI and the releases.
    expect(workflow).toContain('group: advisories-${{ github.ref }}');
    const job = jobOf(workflow, 'scan');
    expect(job).not.toMatch(/^ {4}if:/m);
    const scan = stepOf(job, SCAN_ACTION);
    expect(scan).toMatch(/^ {8}uses: \.\/\.github\/actions\/advisory-scan$/m);
    expect(scan).toMatch(/^\s*enforce: 'true'$/m);
    expect(scan).not.toMatch(/continue-on-error|^\s*if:/m);
    // Daily, not some rarer schedule that would still match a looser check.
    expect(workflow).toMatch(/- cron: '\d+ \d+ \* \* \*'/);
  });
});

describe('the advisory scan action', () => {
  const ACTION = '.github/actions/advisory-scan/action.yml';
  const action = uncommented(ACTION);
  const VERDICT_STEP = '- name: Scan, and say whether a tag would be refused';

  it('installs cargo-audit at a pinned version, and treats a failed install as a failed scan', () => {
    const install = action.slice(action.indexOf('- name: Install cargo-audit'), action.indexOf(VERDICT_STEP));
    expect(install).toMatch(/^\s*id: install$/m);
    expect(install).toMatch(/CARGO_AUDIT_VERSION: '\d+\.\d+\.\d+'/);
    expect(install).toContain('cargo install cargo-audit --locked --version "$CARGO_AUDIT_VERSION" --root "$root"');
    // Its failure is recorded, never swallowed, and the verdict refuses on it.
    expect(install).not.toMatch(/\|\|\s*true/);
    expect(install).not.toMatch(/set \+e/);
    expect(install).toContain('echo "installed=false" >> "$GITHUB_OUTPUT"');
  });

  it('binds the verdict step to its inputs, and nothing can skip it', () => {
    const step = action.slice(action.indexOf(VERDICT_STEP));
    expect(step).not.toMatch(/^\s*(if|continue-on-error):/m);
    expect(step).toContain('ENFORCE: ${{ inputs.enforce }}');
    expect(step).toContain('SAVE: ${{ inputs.save }}');
    expect(step).toContain('INSTALLED: ${{ steps.install.outputs.installed }}');
    expect(step).not.toMatch(/set \+e/);
    expect(action).not.toMatch(/^\s*(if|continue-on-error):/m);
  });

  // bash finds the stand-in `node` by its bare name, which a Windows `.cmd`
  // stand-in does not answer to.
  it.skipIf(process.platform === 'win32')('decides the way its header says, run as the runner runs it', () => {
    /*
     * The verdict step's whole `run` block, with the flags GitHub runs a
     * composite `shell: bash` step with, against a stand-in `node` that
     * answers as the report would, and only when it is asked for the report.
     */
    const raw = readFileSync(join(REPO_ROOT, ACTION), 'utf8');
    const step = raw.slice(raw.indexOf(VERDICT_STEP));
    const block = step.slice(step.indexOf('      run: |\n') + '      run: |\n'.length);
    const body = block
      .split('\n')
      .map((line) => line.replace(/^ {8}/, ''))
      .join('\n');
    const cases: Array<[label: string, verdict: number, installed: string, enforce: string, exit: number]> = [
      ['clean, enforced', 0, 'true', 'true', 0],
      ['refused, enforced', 1, 'true', 'true', 1],
      ['refused, a dry run', 1, 'true', 'false', 0],
      ['malformed register, enforced', 2, 'true', 'true', 1],
      ['clean but cargo-audit missing, enforced', 0, 'false', 'true', 1],
      ['clean but cargo-audit missing, a dry run', 0, 'false', 'false', 0],
      ['clean, but enforce is neither true nor false', 0, 'true', 'True', 1],
      ['refused, and enforce is empty', 1, 'true', '', 1],
    ];
    for (const [label, verdict, installed, enforce, exit] of cases) {
      const dir = scratch();
      const bin = scratch();
      fakeTool(
        bin,
        'node',
        `const args = process.argv.slice(2);
if (args.join(' ') !== 'scripts/report-advisories.mjs --save provenance') {
  console.log('unexpected node ' + args.join(' '));
  process.exit(99);
}
console.log('report body');
process.exit(${verdict});
`,
      );
      const summary = join(dir, 'summary.md');
      const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', body], {
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH}`,
          RUNNER_TEMP: dir,
          GITHUB_STEP_SUMMARY: summary,
          ENFORCE: enforce,
          SAVE: 'provenance',
          INSTALLED: installed,
        },
      });
      const output = `${result.stdout}${result.stderr}`;
      expect(result.status, `${label}\n${output}`).toBe(exit);
      if (enforce !== 'true' && enforce !== 'false') {
        expect(output, label).toContain('enforce must be');
        continue;
      }
      const written = readFileSync(summary, 'utf8');
      expect(written, label).toContain('report body');
      expect(written, label).not.toContain('unexpected node');
      const clean = verdict === 0 && installed === 'true';
      expect(written, label).toContain(clean ? 'Nothing here refuses' : 'REFUSED');
      if (!clean) expect(result.stdout, label).toMatch(/^::error::.*REFUSED/m);
      expect(readFileSync(join(dir, 'provenance/advisories.txt'), 'utf8'), label).toContain('report body');
      if (installed !== 'true') expect(written, label).toContain('cargo-audit could not be installed');
    }
  });
});
