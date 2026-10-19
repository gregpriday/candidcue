#!/usr/bin/env node
/**
 * The dependency advisory report, split into what is new and what somebody
 * already looked at.
 *
 * `cargo audit` and `pnpm audit` print every advisory that matches a lockfile,
 * whether or not it can reach the shipped app. Read raw, a report on the day
 * nothing changed looks exactly like one on the day something did.
 * `docs/advisory-exceptions.json` records each finding that has been traced and
 * accepted (why it does not reach the app, and when to look again), and this
 * sorts a report against it:
 *
 *   NEW                 reported, and covered by no exception: look at it
 *   REVIEW OVERDUE      accepted, but past the date it was due another look
 *   ACCEPTED            reported and accepted, printed with the reason
 *   NO LONGER REPORTED  an exception nothing matched, so it can be removed
 *   SCAN FAILED         a scanner produced no report, which is not a clean one
 *
 * Nothing is suppressed. An accepted finding is still printed, next to the
 * reason it was accepted, and `--save` keeps every scanner's raw output. A
 * finding matches an exception only on its exact lockfile, package, version and
 * advisory id, so a version bump or a second copy of a crate arrives as NEW
 * rather than inheriting a decision made about something else.
 *
 * This is not a gate, for the reason `scripts/verify-supply-chain.mjs` gives:
 * the release workflow runs it with `continue-on-error`. It exits 1 when
 * anything is new, overdue or failed, so the step is marked, and the release
 * carries on.
 *
 * Usage:
 *   node scripts/report-advisories.mjs               both Cargo lockfiles, production JavaScript
 *   node scripts/report-advisories.mjs --dev         JavaScript development dependencies too
 *   node scripts/report-advisories.mjs --save <dir>  also write each scanner's raw output into <dir>
 *   node scripts/report-advisories.mjs --from <dir>  sort output saved by --save instead of scanning
 *
 * `--register <file>` and `--today <YYYY-MM-DD>` exist so the tests can pin
 * both.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * How an accepted finding is kept out of the shipped app. The issue that
 * introduced the register (#296) asked for exactly this distinction, and a
 * fixed vocabulary is what keeps "it's fine" from becoming a category.
 */
const REACH = new Set([
  'disabled-feature', // in the lockfile, compiled into no build
  'other-target', // compiled only for a platform the release does not build
  'dev-only', // development or test tooling, never in the app bundle
  'unused-api', // ships, but the affected code is never called
  'no-vulnerability', // ships; the advisory reports a maintenance status, not a flaw
]);

/* ---------------------------------------------------------------- arguments */

function usage(message) {
  console.error(`${message}\n`);
  console.error('Usage: node scripts/report-advisories.mjs [--dev] [--save <dir>] [--from <dir>]');
  process.exit(2);
}

const options = { dev: false, save: null, from: null, register: 'docs/advisory-exceptions.json', today: null };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--dev') {
    options.dev = true;
    continue;
  }
  const key = { '--save': 'save', '--from': 'from', '--register': 'register', '--today': 'today' }[arg];
  if (key === undefined) usage(`Unknown argument: ${arg}`);
  const value = argv[++i];
  if (value === undefined || value.startsWith('--')) usage(`${arg} needs a value`);
  options[key] = value;
}
if (options.save !== null && options.from !== null) usage('--save and --from cannot be combined');

const today = options.today ?? new Date().toISOString().slice(0, 10);
if (!isDate(today)) usage(`--today must be a YYYY-MM-DD date, not ${today}`);

/** A real calendar date as YYYY-MM-DD, which is also what makes `<` compare them. */
function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/* ----------------------------------------------------------------- register */

/**
 * Read and check the register. A malformed register is an error rather than an
 * empty one: an exception that silently fails to load turns every accepted
 * finding into NEW, which is noise, and one that loads half-formed accepts
 * findings with no reason attached, which is worse.
 */
function loadRegister(path) {
  let register;
  try {
    register = JSON.parse(readFileSync(resolve(ROOT, path), 'utf8'));
  } catch (error) {
    console.error(`Could not read the exception register ${path}: ${error.message}`);
    process.exit(2);
  }

  const problems = [];
  const exceptions = Array.isArray(register?.exceptions) ? register.exceptions : [];
  if (!Array.isArray(register?.exceptions)) problems.push('it has no `exceptions` array');

  // A lockfile no scan reads would match nothing and could never be reported
  // stale either: an exception that silently does nothing.
  const lockfiles = new Set(SCANS.map((scan) => scan.lockfile));
  const byKey = new Map();
  exceptions.forEach((exception, index) => {
    const at = `exceptions[${index}]`;
    if (!lockfiles.has(exception?.lockfile)) {
      problems.push(`${at} names lockfile ${JSON.stringify(exception?.lockfile)}, which is not scanned`);
    }
    if (!REACH.has(exception?.reach)) problems.push(`${at} has reach ${JSON.stringify(exception?.reach)}`);
    if (typeof exception?.why !== 'string' || exception.why.trim() === '') problems.push(`${at} gives no reason`);
    if (!isDate(exception?.reviewBy)) problems.push(`${at} has no YYYY-MM-DD reviewBy`);
    if (!Array.isArray(exception?.findings) || exception.findings.length === 0) {
      problems.push(`${at} lists no findings`);
      return;
    }
    for (const finding of exception.findings) {
      if (!['package', 'version', 'id'].every((field) => typeof finding?.[field] === 'string' && finding[field] !== '')) {
        problems.push(`${at} has a finding without package, version and id`);
        continue;
      }
      const k = key(exception.lockfile, finding);
      if (byKey.has(k)) problems.push(`${at} repeats ${describe(finding)} in ${exception.lockfile}`);
      byKey.set(k, exception);
    }
  });

  if (problems.length > 0) {
    console.error(`The exception register ${path} is malformed:`);
    for (const problem of problems) console.error(`  • ${problem}`);
    process.exit(2);
  }
  return { exceptions, byKey };
}

function key(lockfile, { package: name, version, id }) {
  return `${lockfile}\u0000${name}@${version}\u0000${id}`;
}

function describe({ package: name, version, id }) {
  return `${name} ${version} ${id}`;
}

/* -------------------------------------------------------------------- scans */

/**
 * What a release scans. Each is a separate scan, so one scanner failing is
 * reported as that scanner failing, and the others still run.
 */
const SCANS = [
  {
    lockfile: 'src-tauri/Cargo.lock',
    saved: 'advisories-cargo-app.json',
    command: ['cargo', 'audit', '--json', '--file', 'src-tauri/Cargo.lock'],
    parse: parseCargoAudit,
  },
  {
    lockfile: 'crates/Cargo.lock',
    saved: 'advisories-cargo-crates.json',
    command: ['cargo', 'audit', '--json', '--file', 'crates/Cargo.lock'],
    parse: parseCargoAudit,
  },
  options.dev
    ? {
        lockfile: 'pnpm-lock.yaml',
        label: 'pnpm-lock.yaml (all dependencies)',
        saved: 'advisories-pnpm-all.json',
        command: ['pnpm', 'audit', '--json'],
        parse: parsePnpmAudit,
      }
    : {
        lockfile: 'pnpm-lock.yaml',
        label: 'pnpm-lock.yaml (production)',
        saved: 'advisories-pnpm-prod.json',
        command: ['pnpm', 'audit', '--json', '--prod'],
        parse: parsePnpmAudit,
        production: true,
      },
];

/**
 * The raw output of one scan, from the scanner or from `--from`. Both tools
 * exit non-zero when they FIND something, so the exit status says nothing
 * about whether the scan worked; only a report that parses does.
 */
function collect(scan) {
  if (options.from !== null) {
    const path = resolve(options.from, scan.saved);
    if (!existsSync(path)) return { stdout: '', stderr: `no saved report at ${path}` };
    return { stdout: readFileSync(path, 'utf8'), stderr: '' };
  }

  const [command, ...args] = scan.command;
  const settings = { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };
  const result =
    process.platform === 'win32'
      ? spawnSync(throughCmd(command, args), { ...settings, shell: true })
      : spawnSync(command, args, settings);
  const stdout = result.stdout ?? '';
  const stderr = result.error ? `could not run ${command}: ${result.error.message}` : (result.stderr ?? '');
  // Never an empty file: the publish job attaches every file in provenance/ to
  // the GitHub release, and GitHub refuses a zero-byte asset, so a scanner that
  // printed nothing would turn a reported failure into a failed publish.
  if (options.save !== null && stdout !== '') {
    mkdirSync(resolve(options.save), { recursive: true });
    writeFileSync(resolve(options.save, scan.saved), stdout);
  }
  return { stdout, stderr };
}

/**
 * A command line for cmd.exe, which is how a scanner is reached on Windows.
 *
 * There `pnpm` is a `pnpm.cmd` shim: a direct spawn finds no `pnpm.exe`, so the
 * pnpm scan failed with ENOENT before pnpm ran, and since the fix for
 * CVE-2024-27980 Node will not spawn a batch file without a shell. cmd.exe
 * resolves a bare name through PATHEXT, the way a terminal does, and receives
 * the arguments unquoted: exact for the plain tokens in SCANS, and refused for
 * anything else rather than reinterpreted. Kept in step with the copy in
 * generate-notices.mjs, which says more.
 */
function throughCmd(command, args) {
  const tokens = [command, ...args];
  const unsafe = tokens.find((token) => !/^[\w@+=:,./\\-]+$/.test(token));
  if (unsafe !== undefined) {
    throw new Error(`${JSON.stringify(unsafe)} cannot be passed through cmd.exe unquoted`);
  }
  return tokens.join(' ');
}

function scanOne(scan) {
  let collected;
  try {
    collected = collect(scan);
  } catch (error) {
    return { scan, error: error.message };
  }
  let report;
  try {
    report = JSON.parse(collected.stdout);
  } catch {
    return { scan, error: firstLine(collected.stderr) || 'the scanner printed no JSON report' };
  }
  try {
    return { scan, ...scan.parse(report, scan.lockfile) };
  } catch (error) {
    return { scan, error: error.message };
  }
}

/**
 * A finding the report can name. Anything less means the scanner's output is
 * not what this was written against, and a report built on it is not one to
 * trust: the scan fails rather than dropping the finding.
 */
function identified(finding) {
  for (const field of ['package', 'version', 'id']) {
    if (typeof finding[field] !== 'string' || finding[field] === '') {
      throw new Error(`a reported finding has no ${field}; the report format may have changed`);
    }
  }
  return finding;
}

function firstLine(text) {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? ''
  );
}

/**
 * `cargo audit --json`. Vulnerabilities and warnings (unmaintained, unsound,
 * yanked) are both findings: a warning is exactly as noisy unexplained. A
 * yanked release has no advisory, so its id is the word `yanked`.
 */
function parseCargoAudit(report, lockfile) {
  const vulnerabilities = report?.vulnerabilities;
  if (!Array.isArray(vulnerabilities?.list)) throw new Error('not a cargo-audit JSON report');
  if (typeof vulnerabilities.count === 'number' && vulnerabilities.count !== vulnerabilities.list.length) {
    throw new Error(`cargo-audit counted ${vulnerabilities.count} vulnerabilities and listed ${vulnerabilities.list.length}`);
  }
  const warnings = report.warnings ?? {};
  if (typeof warnings !== 'object' || Array.isArray(warnings)) throw new Error('cargo-audit warnings are not a map');

  const findings = vulnerabilities.list.map((entry) =>
    identified({
      lockfile,
      package: entry?.package?.name,
      version: entry?.package?.version,
      id: entry?.advisory?.id,
      kind: 'vulnerability',
      title: String(entry?.advisory?.title ?? '').trim(),
    }),
  );
  for (const [kind, entries] of Object.entries(warnings)) {
    if (!Array.isArray(entries)) throw new Error(`cargo-audit ${kind} warnings are not a list`);
    for (const warning of entries) {
      findings.push(
        identified({
          lockfile,
          package: warning?.package?.name,
          version: warning?.package?.version,
          id: warning?.advisory?.id ?? kind,
          kind,
          title: String(warning?.advisory?.title ?? `${kind} release`).trim(),
        }),
      );
    }
  }
  const database = report.database ?? {};
  const commit = typeof database['last-commit'] === 'string' ? database['last-commit'].slice(0, 7) : '?';
  const updated = typeof database['last-updated'] === 'string' ? database['last-updated'].slice(0, 10) : '?';
  return { findings, source: `advisory database ${commit}, ${updated}` };
}

/**
 * `pnpm audit --json`, the npm v6 shape: one record per advisory, with the
 * installed versions it matched under `findings`. One finding per version, so
 * an exception for one copy of a package does not cover another.
 */
function parsePnpmAudit(report, lockfile) {
  if (report?.error !== undefined) {
    throw new Error(firstLine(String(report.error?.message ?? report.error)) || 'pnpm audit reported an error');
  }
  if (report === null || typeof report?.advisories !== 'object' || Array.isArray(report.advisories)) {
    throw new Error('not a pnpm audit JSON report');
  }
  const findings = [];
  for (const advisory of Object.values(report.advisories)) {
    // An advisory with no installed version it matched names nothing to look
    // at, and skipping it would read as one fewer finding.
    if (!Array.isArray(advisory?.findings) || advisory.findings.length === 0) {
      throw new Error(`pnpm audit listed ${advisory?.github_advisory_id ?? 'an advisory'} without the versions it matched`);
    }
    const versions = new Set(advisory.findings.map((found) => found?.version));
    for (const version of versions) {
      findings.push(
        identified({
          lockfile,
          package: advisory.module_name,
          version,
          id: advisory.github_advisory_id ?? (advisory.id === undefined ? undefined : String(advisory.id)),
          kind: advisory.severity ?? 'advisory',
          title: String(advisory.title ?? '').trim(),
        }),
      );
    }
  }
  return { findings, source: 'npm registry advisories' };
}

/* ----------------------------------------------------------------- classify */

const register = loadRegister(options.register);
const results = SCANS.map(scanOne);

const sections = { new: [], overdue: [], accepted: [], gone: [], failed: [] };
const matched = new Set();

for (const result of results) {
  if (result.error !== undefined) {
    sections.failed.push(result);
    continue;
  }
  for (const finding of result.findings) {
    const k = key(finding.lockfile, finding);
    const exception = register.byKey.get(k);
    if (exception === undefined) {
      sections.new.push({ finding });
      continue;
    }
    matched.add(k);
    if (exception.reach === 'dev-only' && result.scan.production) {
      // Accepted because it never ships, and the production scan says it does.
      sections.new.push({ finding, note: 'accepted as dev-only, but the production scan reports it' });
    } else if (exception.reviewBy < today) {
      sections.overdue.push({ finding, exception });
    } else {
      sections.accepted.push({ finding, exception });
    }
  }
}

/*
 * An exception is only "no longer reported" when a scan that would have
 * reported it ran and did not. A failed scan says nothing, and the production
 * JavaScript scan never covers a dev-only exception.
 */
const notCovered = [];
for (const exception of register.exceptions) {
  const result = results.find((r) => r.scan.lockfile === exception.lockfile);
  for (const finding of exception.findings) {
    if (matched.has(key(exception.lockfile, finding))) continue;
    if (result === undefined || result.error !== undefined) continue;
    if (exception.reach === 'dev-only' && result.scan.production) {
      notCovered.push(finding);
      continue;
    }
    sections.gone.push({ finding: { ...finding, lockfile: exception.lockfile }, exception });
  }
}

/* -------------------------------------------------------------------- print */

const annotate = process.env.GITHUB_ACTIONS === 'true';

console.log(`Dependency advisories, ${today}`);
for (const result of results) {
  const label = result.scan.label ?? result.scan.lockfile;
  if (result.error !== undefined) console.log(`  ${label}: SCAN FAILED`);
  else console.log(`  ${label}: ${result.findings.length} reported (${result.source})`);
}
console.log(`  Exceptions: ${options.register}`);

heading('NEW', sections.new.length);
for (const { finding, note } of sections.new) {
  console.log(`  ${line(finding)}`);
  if (note !== undefined) console.log(`      ${note}`);
  if (annotate) console.log(`::warning::new advisory: ${finding.lockfile} ${describe(finding)}`);
}

heading('REVIEW OVERDUE', sections.overdue.length);
printByException(sections.overdue);
if (annotate && sections.overdue.length > 0) {
  console.log(`::warning::${sections.overdue.length} accepted advisories are past their review date`);
}

heading('ACCEPTED', sections.accepted.length);
printByException(sections.accepted);

heading('NO LONGER REPORTED', sections.gone.length);
printByException(sections.gone);

heading('SCAN FAILED', sections.failed.length);
for (const { scan, error } of sections.failed) {
  console.log(`  ${scan.label ?? scan.lockfile}: ${error}`);
  if (annotate) console.log(`::warning::advisory scan failed: ${scan.label ?? scan.lockfile}`);
}

if (notCovered.length > 0) {
  console.log(
    `\n${notCovered.length} dev-only exception${notCovered.length === 1 ? '' : 's'} not checked: ` +
      'the production scan does not cover development dependencies (run with --dev).',
  );
}

const attention = sections.new.length + sections.overdue.length + sections.failed.length;
console.log(
  `\nResult: ${sections.new.length} new, ${sections.overdue.length} overdue, ` +
    `${sections.accepted.length} accepted, ${sections.gone.length} no longer reported, ` +
    `${sections.failed.length} failed.`,
);
process.exit(attention > 0 ? 1 : 0);

function heading(title, count) {
  console.log(`\n${title} (${count})`);
  if (count === 0) console.log('  none');
}

function line(finding) {
  // A NO LONGER REPORTED entry comes from the register, which has no kind or title.
  const kind = finding.kind === undefined ? '' : `  [${finding.kind}]`;
  const title = finding.title ? `: ${finding.title}` : '';
  return `${finding.lockfile}  ${describe(finding)}${kind}${title}`;
}

/** The reason once per exception, then every finding it covers. */
function printByException(entries) {
  const groups = new Map();
  for (const entry of entries) {
    if (!groups.has(entry.exception)) groups.set(entry.exception, []);
    groups.get(entry.exception).push(entry.finding);
  }
  for (const [exception, findings] of groups) {
    for (const finding of findings) console.log(`  ${line(finding)}`);
    const followUp = exception.followUp === undefined ? '' : ` Follow-up: ${exception.followUp}.`;
    console.log(`      ${exception.reach}, review by ${exception.reviewBy}. ${exception.why}${followUp}`);
  }
}
