#!/usr/bin/env node
/**
 * The update feed on R2: what a release puts there, and the checks that stand
 * between a build and an installed copy seeing it.
 *
 * Every platform publishes from its own workflow (`release-macos.yml`,
 * `release-windows.yml`, `release-linux.yml`), so nothing here is shared
 * between them: each one stages, uploads and verifies only its own files and
 * its own feed entries, and a failed Windows run cannot strand a macOS build.
 *
 * ## The layout under `<public url>/releases/`
 *
 *   <version>/<installer, updater payload, .sig, SHA256SUMS-<os>.txt>
 *       Written once, served `immutable`. A version directory never changes
 *       after its feed entry points at it.
 *
 *   <channel>-<target>-<arch>.json
 *       What the in-app updater polls (`src-tauri/src/updater.rs` builds the
 *       URL from the same three parts). One file per platform, in the
 *       plugin's single-platform format: version, notes, pub_date, url,
 *       signature. macOS ships one universal payload, so `darwin-aarch64` and
 *       `darwin-x86_64` both name it.
 *
 *   <channel>-<os>.json
 *       What a download page reads: the installers for that OS, with sizes
 *       and digests. Nothing in the app reads it.
 *
 * Both kinds of JSON are served `no-cache`, and both go up only after every
 * file they name has been read back from the public URL byte for byte. A
 * client must never fetch an entry that points at a missing, partial or stale
 * file.
 *
 * ## Channels
 *
 * A version with no prerelease part publishes to `latest`; one whose
 * prerelease part contains `beta` publishes to `beta`; every other
 * prerelease (`rc`, `alpha`, …) publishes to `rc`. An installed copy polls the
 * channel of its own version, so a stable install never sees a candidate.
 *
 * Usage:
 *   node scripts/release-feed.mjs channel <version>
 *   node scripts/release-feed.mjs stage --os <macos|windows|linux> --bundle <dir> --out <dir> [--notes <file>]
 *   node scripts/release-feed.mjs monotonic --stage <dir>
 *   node scripts/release-feed.mjs verify-files --stage <dir>
 *   node scripts/release-feed.mjs verify-feed --stage <dir>
 *
 * `CANDIDCUE_PUBLIC_URL` overrides the public origin (default
 * https://updates.candidcue.com).
 */

import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_PUBLIC_URL = 'https://updates.candidcue.com';
export const PRODUCT = 'CandidCue';

const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/;

/* ------------------------------------------------------------ versions */

/** The feed a version publishes to, and the feed an install of it polls. */
export function channelFor(version) {
  if (!SEMVER.test(version)) throw new Error(`"${version}" is not a semver version`);
  const dash = version.indexOf('-');
  if (dash === -1) return 'latest';
  return /beta/i.test(version.slice(dash + 1)) ? 'beta' : 'rc';
}

/**
 * Semver precedence: -1, 0 or 1. Build metadata is not accepted at all (the
 * macOS bundle version rejects `+`), so it never has to be ignored here.
 */
export function compareVersions(a, b) {
  for (const v of [a, b]) {
    if (!SEMVER.test(v)) throw new Error(`"${v}" is not a semver version`);
  }
  const split = (v) => {
    const dash = v.indexOf('-');
    const core = (dash === -1 ? v : v.slice(0, dash)).split('.').map(Number);
    const pre = dash === -1 ? [] : v.slice(dash + 1).split('.');
    return { core, pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) {
    if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  }
  // A version without a prerelease outranks the same version with one.
  if (x.pre.length === 0 || y.pre.length === 0) {
    if (x.pre.length === y.pre.length) return 0;
    return x.pre.length === 0 ? 1 : -1;
  }
  const numeric = /^\d+$/;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = numeric.test(p);
    const qn = numeric.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/**
 * What the live feed means for a candidate version, per platform.
 *
 * Equal is "already published", not a failure: re-running a release whose
 * feed already went up must upload nothing rather than rewrite what clients
 * are being served. Lower is a refusal — the updater would never offer it,
 * and a feed that names it hides every newer build until it is corrected.
 */
export function monotonicVerdict(live, candidate) {
  if (live === null) return 'first';
  const order = compareVersions(candidate, live);
  if (order === 0) return 'published';
  return order > 0 ? 'newer' : 'older';
}

/* ------------------------------------------------------------- platforms */

/**
 * What each OS ships, and under which names.
 *
 * The names are decided HERE rather than taken from the bundler, which names
 * the macOS updater payload `CandidCue.app.tar.gz` with no version at all —
 * fine in a build directory, a collision waiting to happen in a directory of
 * releases.
 */
export const PLATFORMS = {
  macos: {
    targets: ['darwin-aarch64', 'darwin-x86_64'],
    payload: { find: ['macos', '.app.tar.gz'], name: (v) => `${PRODUCT}_${v}_universal.app.tar.gz` },
    downloads: [
      { kind: 'dmg', arch: 'universal', find: ['dmg', '.dmg'], name: (v) => `${PRODUCT}_${v}_universal.dmg` },
    ],
  },
  windows: {
    targets: ['windows-x86_64'],
    payload: { find: ['nsis', '-setup.exe'], name: (v) => `${PRODUCT}_${v}_x64-setup.exe` },
    // The installer IS the updater payload on Windows, so the download and
    // the update are the same file.
    downloads: [{ kind: 'nsis', arch: 'x64', payload: true }],
  },
  linux: {
    targets: ['linux-x86_64'],
    payload: { find: ['appimage', '.AppImage'], name: (v) => `${PRODUCT}_${v}_amd64.AppImage` },
    downloads: [
      { kind: 'appimage', arch: 'x64', payload: true },
      { kind: 'deb', arch: 'x64', find: ['deb', '.deb'], name: (v) => `${PRODUCT}_${v}_amd64.deb` },
    ],
  },
};

export const updaterFeedName = (channel, target) => `${channel}-${target}.json`;
export const downloadsFeedName = (channel, os) => `${channel}-${os}.json`;

function releasesUrl(publicUrl) {
  return `${publicUrl.replace(/\/+$/, '')}/releases`;
}

/** Exactly one file in `<bundle>/<dir>` ending with `suffix`, or a refusal. */
function findOne(bundle, dir, suffix) {
  const where = join(bundle, dir);
  const found = existsSync(where)
    ? readdirSync(where).filter((name) => name.endsWith(suffix) && !name.endsWith('.sig'))
    : [];
  if (found.length !== 1) {
    throw new Error(
      `expected exactly one *${suffix} in ${where}, found ${found.length}` +
        (found.length ? `: ${found.join(', ')}` : ''),
    );
  }
  return join(where, found[0]);
}

/* ------------------------------------------------------------- signatures */

/**
 * The updater public key from `tauri.conf.json`, as an Ed25519 key object.
 *
 * Tauri's key is base64 of a minisign public key FILE: an untrusted comment
 * line, then base64 of `Ed` + 8-byte key id + 32-byte key.
 */
export function updaterPublicKey(pubkeyBase64) {
  const text = Buffer.from(pubkeyBase64, 'base64').toString('utf8');
  const line = text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('untrusted comment:'));
  const raw = Buffer.from(line ?? '', 'base64');
  if (raw.length !== 42 || raw.subarray(0, 2).toString('latin1') !== 'Ed') {
    throw new Error('the updater public key is not a minisign Ed25519 public key');
  }
  return {
    keyId: raw.subarray(2, 10),
    key: createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: raw.subarray(10).toString('base64url') },
      format: 'jwk',
    }),
  };
}

/**
 * Verify a Tauri `.sig` (base64 of a minisign signature file) over `data`
 * with `publicKey`, the way the installed app will.
 *
 * This is the check that matters most and the one nothing else makes. The
 * bundler signs with whatever `TAURI_SIGNING_PRIVATE_KEY` it was handed; the
 * app verifies with the key it was BUILT with. A secret rotated or pasted
 * from the wrong file produces a release that publishes cleanly and that
 * every installed copy then refuses, silently, forever. Verifying here turns
 * that into a failed release.
 */
export function verifyUpdaterSignature(sigBase64, data, publicKey) {
  const text = Buffer.from(sigBase64.trim(), 'base64').toString('utf8');
  const lines = text.split('\n').map((l) => l.trim());
  if (!lines[0]?.startsWith('untrusted comment:')) throw new Error('not a minisign signature');
  const sig = Buffer.from(lines[1] ?? '', 'base64');
  const trusted = lines[2] ?? '';
  const globalSig = Buffer.from(lines[3] ?? '', 'base64');
  if (sig.length !== 74 || !trusted.startsWith('trusted comment: ') || globalSig.length !== 64) {
    throw new Error('malformed minisign signature');
  }
  const algorithm = sig.subarray(0, 2).toString('latin1');
  if (!sig.subarray(2, 10).equals(publicKey.keyId)) {
    throw new Error(
      `signed with key ${sig.subarray(2, 10).toString('hex')}, but the app trusts ` +
        `${publicKey.keyId.toString('hex')}`,
    );
  }
  let message;
  if (algorithm === 'ED') message = createHash('blake2b512').update(data).digest();
  else if (algorithm === 'Ed') message = data;
  else throw new Error(`unknown minisign algorithm "${algorithm}"`);
  const signature = sig.subarray(10);
  if (!verifySignature(null, message, publicKey.key, signature)) {
    throw new Error('the signature does not verify against the payload');
  }
  const global = Buffer.concat([signature, Buffer.from(trusted.slice('trusted comment: '.length))]);
  if (!verifySignature(null, global, publicKey.key, globalSig)) {
    throw new Error('the trusted comment signature does not verify');
  }
}

/* ------------------------------------------------------------------ stage */

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Lay out one OS's release exactly as it will sit on R2, and write its feed
 * entries — without touching the network.
 *
 * Everything the publish job uploads comes out of this directory, so the
 * build job can verify the whole release (signature against the key the app
 * ships, names, digests) before anything holding upload credentials runs.
 */
export function stage({ os, bundle, out, version, notes, publicUrl, pubkey, now = new Date() }) {
  const platform = PLATFORMS[os];
  if (!platform) throw new Error(`unknown OS "${os}"; expected one of ${Object.keys(PLATFORMS).join(', ')}`);
  const channel = channelFor(version);
  const base = releasesUrl(publicUrl);

  rmSync(out, { recursive: true, force: true });
  const filesDir = join(out, 'files', version);
  const feedDir = join(out, 'feed');
  mkdirSync(filesDir, { recursive: true });
  mkdirSync(feedDir, { recursive: true });

  // The updater payload and its signature.
  const payloadSource = findOne(bundle, ...platform.payload.find);
  const sigSource = `${payloadSource}.sig`;
  if (!existsSync(sigSource) || statSync(sigSource).size === 0) {
    // `tauri build` exits 0 and simply writes no .sig when the signing key is
    // missing. The release would publish and every client would refuse it.
    throw new Error(
      `no updater signature at ${sigSource}. TAURI_SIGNING_PRIVATE_KEY did not reach the build, ` +
        'or createUpdaterArtifacts was off.',
    );
  }
  const payloadName = platform.payload.name(version);
  const signature = readFileSync(sigSource, 'utf8').trim();
  verifyUpdaterSignature(signature, readFileSync(payloadSource), updaterPublicKey(pubkey));
  copyFileSync(payloadSource, join(filesDir, payloadName));
  writeFileSync(join(filesDir, `${payloadName}.sig`), `${signature}\n`);

  const downloads = platform.downloads.map((download) => {
    let name;
    if (download.payload) {
      name = payloadName;
    } else {
      name = download.name(version);
      copyFileSync(findOne(bundle, ...download.find), join(filesDir, name));
    }
    const path = join(filesDir, name);
    return {
      kind: download.kind,
      arch: download.arch,
      name,
      url: `${base}/${version}/${name}`,
      size: statSync(path).size,
      sha256: sha256File(path),
    };
  });

  const sums = readdirSync(filesDir)
    .sort()
    .map((name) => `${sha256File(join(filesDir, name))}  ${name}`)
    .join('\n');
  writeFileSync(join(filesDir, `SHA256SUMS-${os}.txt`), `${sums}\n`);

  const pubDate = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const entry = {
    version,
    notes: notes ?? '',
    pub_date: pubDate,
    url: `${base}/${version}/${payloadName}`,
    signature,
  };
  for (const target of platform.targets) {
    writeFileSync(join(feedDir, updaterFeedName(channel, target)), `${JSON.stringify(entry, null, 2)}\n`);
  }
  const downloadsEntry = {
    version,
    channel,
    os,
    pub_date: pubDate,
    release_url: `https://github.com/gregpriday/candidcue/releases/tag/v${version}`,
    files: downloads,
  };
  writeFileSync(join(feedDir, downloadsFeedName(channel, os)), `${JSON.stringify(downloadsEntry, null, 2)}\n`);

  const release = { version, channel, os, targets: platform.targets, publicUrl };
  writeFileSync(join(out, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
  return release;
}

/* ----------------------------------------------------------- the network */

const FETCH_TIMEOUT_MS = 60_000;

async function fetchWithTimeout(url, init = {}, fetchFn = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetchFn(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Defeats any cache between here and R2 without changing what is asked for. */
const fresh = (url) => `${url}${url.includes('?') ? '&' : '?'}cb=${Date.now()}-${Math.random().toString(36).slice(2)}`;

function readRelease(stageDir) {
  return JSON.parse(readFileSync(join(stageDir, 'release.json'), 'utf8'));
}

/**
 * Refuse a version that is not newer than what each platform's feed already
 * serves; report when every platform already serves exactly this version.
 */
export async function monotonic(stageDir, { fetchFn = fetch, log = console.log } = {}) {
  const release = readRelease(stageDir);
  const base = releasesUrl(release.publicUrl);
  const verdicts = [];
  for (const target of release.targets) {
    const url = `${base}/${updaterFeedName(release.channel, target)}`;
    const response = await fetchWithTimeout(fresh(url), { headers: { 'cache-control': 'no-cache' } }, fetchFn);
    let live = null;
    if (response.status === 404) {
      live = null;
    } else if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${url}; refusing to guess what is live`);
    } else {
      const body = await response.json();
      if (typeof body?.version !== 'string') throw new Error(`${url} has no version`);
      live = body.version;
    }
    const verdict = monotonicVerdict(live, release.version);
    log(`[monotonic] ${target}: live ${live ?? '(none)'}, candidate ${release.version}: ${verdict}`);
    if (verdict === 'older') {
      throw new Error(
        `${release.version} is older than the ${live} that ${url} already serves. ` +
          'Publishing it would hide every newer build behind it.',
      );
    }
    verdicts.push(verdict);
  }
  return { skip: verdicts.every((verdict) => verdict === 'published') };
}

async function sha256OfResponse(response) {
  const hash = createHash('sha256');
  for await (const chunk of response.body) hash.update(chunk);
  return hash.digest('hex');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Every staged file is served at its public URL with the bytes that were
 * staged.
 *
 * Bytes, not a HEAD and a Content-Length. The versioned files are cached at
 * the edge as immutable, so a re-run that rebuilt a payload under a version
 * that was already uploaded once would be served the OLD bytes beside a feed
 * entry carrying the NEW signature — and every client would reject it.
 */
export async function verifyFiles(stageDir, { fetchFn = fetch, log = console.log, attempts = 5, delayMs = 10_000 } = {}) {
  const release = readRelease(stageDir);
  const base = releasesUrl(release.publicUrl);
  const filesDir = join(stageDir, 'files', release.version);
  for (const name of readdirSync(filesDir).sort()) {
    const expected = sha256File(join(filesDir, name));
    const url = `${base}/${release.version}/${name}`;
    let last = '';
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const response = await fetchWithTimeout(url, {}, fetchFn);
        if (response.status !== 200) {
          last = `HTTP ${response.status}`;
        } else {
          const actual = await sha256OfResponse(response);
          if (actual === expected) {
            last = '';
            break;
          }
          last = `served sha256 ${actual}, staged ${expected}`;
        }
      } catch (error) {
        last = error.message;
      }
      if (attempt < attempts) await sleep(delayMs);
    }
    if (last) {
      throw new Error(
        `${url}: ${last}. If the bytes differ, this version was uploaded before with different ` +
          'contents and the edge is serving the old ones; publish a new version instead.',
      );
    }
    log(`[verify] ${url}: OK`);
  }
}

/** Every staged feed entry is served exactly as staged, and uncached. */
export async function verifyFeed(stageDir, { fetchFn = fetch, log = console.log, attempts = 5, delayMs = 5_000 } = {}) {
  const release = readRelease(stageDir);
  const base = releasesUrl(release.publicUrl);
  const feedDir = join(stageDir, 'feed');
  for (const name of readdirSync(feedDir).sort()) {
    const expected = JSON.parse(readFileSync(join(feedDir, name), 'utf8'));
    const url = `${base}/${name}`;
    let last = '';
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        // Asked for as a client asks, with no cache-buster: what matters is
        // what an installed copy is served.
        const response = await fetchWithTimeout(url, { headers: { 'cache-control': 'no-cache' } }, fetchFn);
        const cacheControl = response.headers.get('cache-control') ?? '';
        if (response.status !== 200) {
          last = `HTTP ${response.status}`;
        } else if (!/no-cache/.test(cacheControl)) {
          last = `served with Cache-Control "${cacheControl}", which lets a stale entry outlive this release`;
        } else if (!isDeepStrictEqual(await response.json(), expected)) {
          last = 'served content differs from the staged entry';
        } else {
          last = '';
          break;
        }
      } catch (error) {
        last = error.message;
      }
      if (attempt < attempts) await sleep(delayMs);
    }
    if (last) throw new Error(`${url}: ${last}`);
    log(`[verify] ${url}: OK`);
  }
}

/* -------------------------------------------------------------------- CLI */

function option(args, name) {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
}

function required(args, name) {
  const value = option(args, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function main(argv) {
  const [command, ...args] = argv;
  const publicUrl = process.env.CANDIDCUE_PUBLIC_URL || DEFAULT_PUBLIC_URL;
  switch (command) {
    case 'channel': {
      const channel = channelFor(args[0] ?? JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version);
      console.log(channel);
      setOutput('channel', channel);
      return;
    }
    case 'stage': {
      const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
      const conf = JSON.parse(readFileSync(join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
      const pubkey = conf.plugins?.updater?.pubkey;
      if (!pubkey) throw new Error('tauri.conf.json declares no plugins.updater.pubkey');
      const notesFile = option(args, '--notes');
      const release = stage({
        os: required(args, '--os'),
        bundle: required(args, '--bundle'),
        out: required(args, '--out'),
        version,
        notes: notesFile ? readFileSync(notesFile, 'utf8').trim() : '',
        publicUrl,
        pubkey,
      });
      console.log(`staged ${release.os} ${release.version} for the ${release.channel} channel`);
      for (const name of readdirSync(join(required(args, '--out'), 'files', version))) console.log(`  ${version}/${name}`);
      for (const name of readdirSync(join(required(args, '--out'), 'feed'))) console.log(`  ${name}`);
      return;
    }
    case 'monotonic': {
      const { skip } = await monotonic(required(args, '--stage'));
      setOutput('skip_upload', String(skip));
      if (skip) console.log('[monotonic] every platform already serves this version; nothing to upload.');
      return;
    }
    case 'verify-files':
      await verifyFiles(required(args, '--stage'));
      return;
    case 'verify-feed':
      await verifyFeed(required(args, '--stage'));
      return;
    default:
      throw new Error(`unknown command "${command ?? ''}"`);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`::error::release-feed: ${error.message}`);
    process.exit(1);
  });
}

