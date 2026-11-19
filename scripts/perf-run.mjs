#!/usr/bin/env node
/**
 * Record what a presenter waits for, on this Mac (issue #240).
 *
 *   pnpm tauri build --bundles app --config bench/perf/tauri.perf.conf.json
 *   node scripts/perf-run.mjs --pairs 20 --label mac-studio-m4-max
 *   node scripts/perf-compare.mjs bench/perf/mac-studio-m4-max.json <new report>
 *
 * Each PAIR is two launches of the benchmark build on a profile emptied just
 * before it: a first use (Welcome) and a relaunch that opens the fixture
 * twice and presents it twice (`src/control/lib/perf/scenario.ts`). The page
 * reports through `log_client_diagnostic`; this reads the records back out of
 * the profile's `logs/client-trace.log` after each process exits, so nothing
 * here depends on how `tracing` formats stdout.
 *
 * It only ever touches the benchmark identity's own folders, by exact name
 * (`PROFILE_DIRS`): the build is made under `com.speakingglass.perf`, which is
 * what keeps the real app's library, WebKit storage and running instance out
 * of reach (`src-tauri/src/perf.rs`).
 *
 * The windows it opens appear on the desk display — reader mode with no saved
 * frame stays where the control window opened — so run it at a quiet desk,
 * with nothing else building or testing: everything here is wall-clock, and a
 * busy machine is a slower machine.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  REPORT_SCHEMA,
  SCENARIO_ID,
  assemblePair,
  parseTrace,
  seriesOf,
  summarise,
} from './perf-report.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IDENTIFIER = 'com.speakingglass.perf';
const FIXTURE = 'bench/scripts/huge.md';
const DEFAULT_APP = 'src-tauri/target/release/bundle/macos/Speaking Glass Perf.app';
const LAUNCH_TIMEOUT_MS = 180_000;
const SETTLE_MS = 2_000;

const LIBRARY = join(homedir(), 'Library');
/** Every folder the benchmark identity can leave behind, and nothing else. */
const PROFILE_DIRS = [
  join(LIBRARY, 'Application Support', IDENTIFIER),
  join(LIBRARY, 'WebKit', IDENTIFIER),
  join(LIBRARY, 'Caches', IDENTIFIER),
  join(LIBRARY, 'HTTPStorages', IDENTIFIER),
  join(LIBRARY, 'HTTPStorages', `${IDENTIFIER}.binarycookies`),
  join(LIBRARY, 'Saved Application State', `${IDENTIFIER}.savedState`),
];
const TRACE = join(LIBRARY, 'Application Support', IDENTIFIER, 'logs', 'client-trace.log');

function args(argv) {
  const out = { pairs: 10, label: null, app: DEFAULT_APP, out: null };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--pairs') out.pairs = Number(value);
    else if (key === '--label') out.label = value;
    else if (key === '--app') out.app = value;
    else if (key === '--out') out.out = value;
    else throw new Error(`unknown argument ${key}`);
    i++;
  }
  if (!Number.isInteger(out.pairs) || out.pairs < 1) throw new Error('--pairs must be a whole number above 0');
  if (!out.label || !/^[a-z0-9][a-z0-9-]*$/.test(out.label)) {
    throw new Error('--label is required: lower-case words and hyphens, naming the Mac (e.g. mac-studio-m4-max)');
  }
  out.out ??= join('bench', 'perf', 'runs', `${out.label}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  return out;
}

function sh(cmd, argv) {
  try {
    return execFileSync(cmd, argv, { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function machine() {
  const displays = (() => {
    try {
      const json = JSON.parse(sh('system_profiler', ['SPDisplaysDataType', '-json']) ?? '{}');
      return (json.SPDisplaysDataType ?? []).flatMap((gpu) =>
        (gpu.spdisplays_ndrvs ?? []).map((d) => ({
          name: d._name,
          resolution: d._spdisplays_resolution ?? d.spdisplays_resolution ?? null,
          main: d.spdisplays_main === 'spdisplays_yes',
        })),
      );
    } catch {
      return [];
    }
  })();
  return {
    model: sh('sysctl', ['-n', 'hw.model']),
    chip: sh('sysctl', ['-n', 'machdep.cpu.brand_string']),
    memoryGb: Math.round(Number(sh('sysctl', ['-n', 'hw.memsize'])) / 2 ** 30),
    os: `${sh('sw_vers', ['-productName'])} ${sh('sw_vers', ['-productVersion'])} (${sh('sw_vers', ['-buildVersion'])})`,
    displays,
  };
}

/** The control window's eager bundle, as `dist/control.html` loads it. */
function assets() {
  const dist = join(ROOT, 'dist');
  const html = join(dist, 'control.html');
  if (!existsSync(html)) return null;
  const text = readFileSync(html, 'utf8');
  const refs = [...text.matchAll(/(?:src|href)="\/(assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]);
  const files = refs.map((path) => {
    const bytes = readFileSync(join(dist, path));
    return { path, raw: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length };
  });
  const sum = (filter, key) => files.filter(filter).reduce((n, f) => n + f[key], 0);
  const js = (f) => f.path.endsWith('.js');
  const entry = files.find((f) => /^assets\/control-[^/]+\.js$/.test(f.path)) ?? null;
  return {
    entry,
    eagerJs: { raw: sum(js, 'raw'), gzip: sum(js, 'gzip') },
    eagerCss: { raw: sum((f) => !js(f), 'raw'), gzip: sum((f) => !js(f), 'gzip') },
    files,
  };
}

function binaryOf(app) {
  const exe = sh('plutil', ['-extract', 'CFBundleExecutable', 'raw', join(app, 'Contents', 'Info.plist')]);
  const id = sh('plutil', ['-extract', 'CFBundleIdentifier', 'raw', join(app, 'Contents', 'Info.plist')]);
  if (id !== IDENTIFIER) {
    throw new Error(`${app} is ${id ?? 'not an app bundle'}, not ${IDENTIFIER}: build it with bench/perf/tauri.perf.conf.json`);
  }
  return join(app, 'Contents', 'MacOS', exe);
}

function clearProfile() {
  for (const dir of PROFILE_DIRS) rmSync(dir, { recursive: true, force: true });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One process: spawn, wait for it to exit by itself, read its records. */
async function launch(binary) {
  rmSync(TRACE, { force: true });
  const spawnedAt = performance.timeOrigin + performance.now();
  const child = spawn(binary, [], {
    env: { ...process.env, SPEAKING_GLASS_PERF_SCENARIO: '1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const exit = await new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolveExit('timeout');
    }, LAUNCH_TIMEOUT_MS);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolveExit(signal ?? code);
    });
  });
  const records = existsSync(TRACE) ? parseTrace(readFileSync(TRACE, 'utf8')) : [];
  if (exit !== 0) records.push({ kind: 'error', step: 'process', message: `exited with ${exit}` });
  return { spawnedAt, records };
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('the recording is defined for a Mac (WKWebView)');
  const opts = args(process.argv.slice(2));
  const binary = binaryOf(resolve(ROOT, opts.app));
  if (sh('pgrep', ['-f', binary]) !== null) throw new Error('the benchmark app is already running; quit it first');

  const fixture = readFileSync(join(ROOT, FIXTURE));
  const report = {
    schema: REPORT_SCHEMA,
    label: opts.label,
    recordedAt: new Date().toISOString(),
    scenario: {
      id: SCENARIO_ID,
      fixture: FIXTURE,
      fixtureSha256: createHash('sha256').update(fixture).digest('hex'),
    },
    machine: machine(),
    build: {
      commit: sh('git', ['-C', ROOT, 'rev-parse', 'HEAD']),
      dirty: (sh('git', ['-C', ROOT, 'status', '--porcelain', '--untracked-files=no']) ?? '') !== '',
      app: opts.app,
      assets: assets(),
    },
    pairs: [],
  };

  for (let pair = 1; pair <= opts.pairs; pair++) {
    clearProfile();
    const firstUse = await launch(binary);
    await sleep(SETTLE_MS);
    const relaunch = await launch(binary);
    await sleep(SETTLE_MS);
    const assembled = assemblePair({
      pair,
      firstUse: firstUse.records,
      relaunch: relaunch.records,
      spawnedAt: { firstUse: firstUse.spawnedAt, relaunch: relaunch.spawnedAt },
    });
    report.pairs.push(assembled);
    const l = assembled.launches;
    process.stdout.write(
      `pair ${pair}/${opts.pairs}: ${assembled.valid ? 'ok' : `INVALID (${assembled.problems.join('; ')})`}` +
        ` launch ${l.cold?.spawnToReadyMs ?? '—'}/${l.warm?.spawnToReadyMs ?? '—'} ms` +
        ` open ${assembled.opens.map((o) => o.ms).join('/')} ms` +
        ` present ${assembled.presents.map((p) => p.ms).join('/')} ms\n`,
    );
  }
  clearProfile();

  const out = resolve(ROOT, opts.out);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 1)}\n`);
  process.stdout.write(`\n${opts.out}\n`);
  for (const [name, values] of Object.entries(seriesOf(report))) {
    const s = summarise(values);
    process.stdout.write(`${name.padEnd(34)} n=${s.n} p50=${s.p50} p95=${s.p95} max=${s.max}\n`);
  }
  if (report.pairs.some((p) => !p.valid)) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 2;
});
