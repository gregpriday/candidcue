/**
 * The update feed, broken in each way it exists to refuse.
 *
 * `scripts/release-feed.mjs` stands between a signed build and every installed
 * copy of Speaking Glass. Each failure it guards against is silent in production:
 * a payload signed with the wrong key publishes cleanly and is then refused by
 * every client, a regressed feed hides every newer build, and a feed entry that
 * goes up before its payload is readable points clients at a 404. So each test
 * here constructs that failure and asserts the script notices, rather than
 * asserting that a clean release passes.
 *
 * Signatures are made with node:crypto in the exact minisign layout Tauri's
 * `signer sign` writes (checked against a real one when this was written), so
 * the suite needs neither the Tauri CLI nor a key on disk.
 */

import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import * as feed from '../../scripts/release-feed.mjs';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-feed-'));
  dirs.push(dir);
  return dir;
};

/* ------------------------------------------------- a minisign key, in-process */

function minisignKey(keyId = Buffer.from('0123456789abcdef', 'hex')) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  const line = Buffer.concat([Buffer.from('Ed'), keyId, raw]).toString('base64');
  const pubkey = Buffer.from(`untrusted comment: minisign public key: TEST\n${line}\n`).toString('base64');
  return { pubkey, privateKey, keyId };
}

function minisignSign(data: Buffer, key: { privateKey: KeyObject; keyId: Buffer }) {
  const digest = createHash('blake2b512').update(data).digest();
  const signature = sign(null, digest, key.privateKey);
  const trusted = 'timestamp:1792407038\tfile:payload';
  const global = sign(null, Buffer.concat([signature, Buffer.from(trusted)]), key.privateKey);
  const text =
    'untrusted comment: signature from tauri secret key\n' +
    `${Buffer.concat([Buffer.from('ED'), key.keyId, signature]).toString('base64')}\n` +
    `trusted comment: ${trusted}\n` +
    `${global.toString('base64')}\n`;
  return Buffer.from(text).toString('base64');
}

/* ------------------------------------------------------- a fake bundle tree */

const PUBLIC = 'https://updates.example.test';

function macBundle(key: ReturnType<typeof minisignKey>, opts: { sig?: 'good' | 'missing' | 'other-key' } = {}) {
  const bundle = scratch();
  mkdirSync(join(bundle, 'macos'), { recursive: true });
  mkdirSync(join(bundle, 'dmg'), { recursive: true });
  const payload = Buffer.from('a signed, notarised app, tarred');
  writeFileSync(join(bundle, 'macos', 'Speaking Glass.app.tar.gz'), payload);
  writeFileSync(join(bundle, 'dmg', 'SpeakingGlass_0.1.0_universal.dmg'), 'a disk image');
  const sig = opts.sig ?? 'good';
  if (sig === 'good') writeFileSync(join(bundle, 'macos', 'Speaking Glass.app.tar.gz.sig'), minisignSign(payload, key));
  if (sig === 'other-key') {
    writeFileSync(
      join(bundle, 'macos', 'Speaking Glass.app.tar.gz.sig'),
      minisignSign(payload, minisignKey(Buffer.from('fedcba9876543210', 'hex'))),
    );
  }
  return bundle;
}

function stageMac(key = minisignKey(), opts: { version?: string; sig?: 'good' | 'missing' | 'other-key' } = {}) {
  const out = join(scratch(), 'stage');
  const release = feed.stage({
    os: 'macos',
    bundle: macBundle(key, opts),
    out,
    version: opts.version ?? '0.1.0',
    notes: 'What changed.',
    publicUrl: PUBLIC,
    pubkey: key.pubkey,
    now: new Date('2026-10-19T12:00:00.123Z'),
  });
  return { out, release };
}

/* ------------------------------------------------------------------- tests */

describe('a version publishes to, and polls, the channel it belongs to', () => {
  it.each([
    ['0.1.0', 'latest'],
    ['1.2.3', 'latest'],
    ['0.2.0-rc.1', 'rc'],
    ['0.2.0-alpha.3', 'rc'],
    ['0.2.0-beta.2', 'beta'],
  ])('%s → %s', (version, channel) => {
    expect(feed.channelFor(version)).toBe(channel);
  });

  it('refuses something that is not a version', () => {
    expect(() => feed.channelFor('v0.1.0')).toThrow();
    expect(() => feed.channelFor('0.1')).toThrow();
  });
});

describe('versions compare by semver precedence', () => {
  it.each([
    ['0.1.0', '0.1.1', -1],
    ['0.10.0', '0.9.0', 1],
    ['1.0.0-rc.1', '1.0.0', -1],
    ['1.0.0-rc.2', '1.0.0-rc.10', -1],
    ['1.0.0-alpha', '1.0.0-alpha.1', -1],
    ['1.0.0-alpha.beta', '1.0.0-beta', -1],
    ['1.0.0-1', '1.0.0-alpha', -1],
    ['0.1.0', '0.1.0', 0],
  ])('%s vs %s', (a, b, order) => {
    expect(feed.compareVersions(a, b)).toBe(order);
    expect(feed.compareVersions(b, a)).toBe(-order || 0);
  });

  it('calls an equal live version published, a lower one a refusal, and no feed a first release', () => {
    expect(feed.monotonicVerdict(null, '0.1.0')).toBe('first');
    expect(feed.monotonicVerdict('0.1.0', '0.1.0')).toBe('published');
    expect(feed.monotonicVerdict('0.1.0', '0.1.1')).toBe('newer');
    expect(feed.monotonicVerdict('0.2.0', '0.1.1')).toBe('older');
  });
});

describe('staging lays out exactly what will be uploaded', () => {
  it('writes one feed entry per platform, all naming the one universal payload', () => {
    const { out } = stageMac();
    expect(readdirSync(join(out, 'feed')).sort()).toEqual([
      'latest-darwin-aarch64.json',
      'latest-darwin-x86_64.json',
      'latest-macos.json',
    ]);
    const arm = JSON.parse(readFileSync(join(out, 'feed', 'latest-darwin-aarch64.json'), 'utf8'));
    const intel = JSON.parse(readFileSync(join(out, 'feed', 'latest-darwin-x86_64.json'), 'utf8'));
    expect(arm).toEqual(intel);
    expect(arm).toMatchObject({
      version: '0.1.0',
      notes: 'What changed.',
      pub_date: '2026-10-19T12:00:00Z',
      url: `${PUBLIC}/releases/0.1.0/SpeakingGlass_0.1.0_universal.app.tar.gz`,
    });
    expect(typeof arm.signature).toBe('string');
  });

  it('versions the payload name the bundler leaves unversioned', () => {
    const { out } = stageMac();
    expect(readdirSync(join(out, 'files', '0.1.0')).sort()).toEqual([
      'SHA256SUMS-macos.txt',
      'SpeakingGlass_0.1.0_universal.app.tar.gz',
      'SpeakingGlass_0.1.0_universal.app.tar.gz.sig',
      'SpeakingGlass_0.1.0_universal.dmg',
    ]);
  });

  it('gives a download page sizes and digests that match the files', () => {
    const { out } = stageMac();
    const downloads = JSON.parse(readFileSync(join(out, 'feed', 'latest-macos.json'), 'utf8'));
    expect(downloads.files).toHaveLength(1);
    const [dmg] = downloads.files;
    const bytes = readFileSync(join(out, 'files', '0.1.0', dmg.name));
    expect(dmg.size).toBe(bytes.length);
    expect(dmg.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    const sums = readFileSync(join(out, 'files', '0.1.0', 'SHA256SUMS-macos.txt'), 'utf8');
    expect(sums).toContain(`${dmg.sha256}  ${dmg.name}`);
  });

  it('stages a release candidate on the rc channel, never on latest', () => {
    const { out } = stageMac(minisignKey(), { version: '0.2.0-rc.1' });
    expect(readdirSync(join(out, 'feed')).every((name) => name.startsWith('rc-'))).toBe(true);
  });

  it('refuses a payload with no signature, which `tauri build` produces silently', () => {
    expect(() => stageMac(minisignKey(), { sig: 'missing' })).toThrow(/no updater signature/);
  });

  it('refuses a payload signed by a key the app does not trust', () => {
    expect(() => stageMac(minisignKey(), { sig: 'other-key' })).toThrow(/signed with key/);
  });

  it('refuses a payload altered after it was signed', () => {
    const key = minisignKey();
    const payload = Buffer.from('the original bytes');
    const tampered = Buffer.from('the original bytez');
    expect(() =>
      feed.verifyUpdaterSignature(minisignSign(payload, key), tampered, feed.updaterPublicKey(key.pubkey)),
    ).toThrow(/does not verify/);
  });

  it('refuses a bundle directory holding two candidates rather than guessing', () => {
    const key = minisignKey();
    const bundle = macBundle(key);
    writeFileSync(join(bundle, 'dmg', 'SpeakingGlass_0.0.9_universal.dmg'), 'a leftover');
    expect(() =>
      feed.stage({ os: 'macos', bundle, out: join(scratch(), 's'), version: '0.1.0', publicUrl: PUBLIC, pubkey: key.pubkey }),
    ).toThrow(/exactly one/);
  });

  /*
   * The installed updater decodes base64 strictly; Node skips what it does not
   * understand. Staging what only Node can read would publish an update every
   * client refuses.
   */
  it('refuses a signature only a lenient decoder can read', () => {
    const key = minisignKey();
    const payload = Buffer.from('the payload');
    const sig = minisignSign(payload, key);
    const publicKey = feed.updaterPublicKey(key.pubkey);
    expect(() => feed.verifyUpdaterSignature(sig, payload, publicKey)).not.toThrow();
    expect(() => feed.verifyUpdaterSignature(`!${sig}`, payload, publicKey)).toThrow(/standard base64/);
    expect(() => feed.verifyUpdaterSignature(`${sig}\n`, payload, publicKey)).toThrow(/standard base64/);
    const inner = Buffer.from(sig, 'base64').toString('utf8').replace('\n', '\n ');
    expect(() =>
      feed.verifyUpdaterSignature(Buffer.from(inner).toString('base64'), payload, publicKey),
    ).toThrow(/standard base64/);
  });

  it('splits lines as Rust does, keeping a bare carriage return at the end', () => {
    expect(feed.rustLines('a\nb\n')).toEqual(['a', 'b', '']);
    expect(feed.rustLines('a\r\nb\r\n')).toEqual(['a', 'b', '']);
    expect(feed.rustLines('a\nb')).toEqual(['a', 'b']);
    expect(feed.rustLines('a\nb\r')).toEqual(['a', 'b\r']);
  });

  it('refuses a signature whose last line ends in a carriage return Rust would keep', () => {
    const key = minisignKey();
    const payload = Buffer.from('the payload');
    const inner = Buffer.from(minisignSign(payload, key), 'base64').toString('utf8').replace(/\n$/, '\r');
    expect(() =>
      feed.verifyUpdaterSignature(Buffer.from(inner).toString('base64'), payload, feed.updaterPublicKey(key.pubkey)),
    ).toThrow(/standard base64/);
  });

  it('accepts the public key this repository ships', () => {
    const conf = JSON.parse(readFileSync(join(__dirname, '../../src-tauri/tauri.conf.json'), 'utf8'));
    expect(() => feed.updaterPublicKey(conf.plugins.updater.pubkey)).not.toThrow();
  });
});

/* ------------------------------------------------- the network, faked */

type Route = { status: number; body?: string | Buffer; headers?: Record<string, string> };

function fakeFetch(routes: Record<string, Route | (() => Route)>) {
  const seen: string[] = [];
  const asked: string[] = [];
  const requests: { url: string; headers: Headers; cache: RequestCache | undefined }[] = [];
  const fetchFn = async (url: string, init: RequestInit = {}) => {
    const path = url.replace(/[?&]cb=[^&]+/, '');
    seen.push(path);
    asked.push(url);
    requests.push({ url, headers: new Headers(init.headers), cache: init.cache });
    const entry = routes[path];
    const route = typeof entry === 'function' ? entry() : entry ?? { status: 404 };
    const body = typeof route.body === 'string' ? route.body : new Uint8Array(route.body ?? []);
    return new Response(route.status === 404 ? 'not found' : body, {
      status: route.status,
      headers: route.headers,
    });
  };
  return { fetchFn, seen, asked, requests };
}

const quiet = { log: () => {}, attempts: 2, delayMs: 0 };

/** `routes` with the one at `url` served under `cacheControl` (none when undefined). */
function withHeader(routes: Record<string, Route>, url: string, cacheControl: string | undefined) {
  const route = routes[url];
  if (!route) throw new Error(`no route for ${url}`);
  return { ...routes, [url]: { ...route, headers: cacheControl === undefined ? {} : { 'cache-control': cacheControl } } };
}

describe('the monotonic gate', () => {
  it('lets a first release through when no feed exists yet', async () => {
    const { out } = stageMac();
    const { fetchFn } = fakeFetch({});
    await expect(feed.monotonic(out, { fetchFn, log: () => {} })).resolves.toEqual({
      verdicts: ['first', 'first'],
    });
  });

  it('refuses a version older than the one the feed serves', async () => {
    const { out } = stageMac();
    const live = { status: 200, body: JSON.stringify({ version: '0.2.0' }) };
    const { fetchFn } = fakeFetch({
      [`${PUBLIC}/releases/latest-darwin-aarch64.json`]: live,
      [`${PUBLIC}/releases/latest-darwin-x86_64.json`]: live,
    });
    await expect(feed.monotonic(out, { fetchFn, log: () => {} })).rejects.toThrow(/older/);
  });

  /*
   * A publish that failed half way (one architecture's entry up, the other
   * not, or the downloads manifest missing) is repaired by running it again.
   * Skipping every write because one feed already serves the version used to
   * leave the rest broken, and skip the checks that would have said so.
   */
  it('lets a re-run through to repair a partial publish', async () => {
    const { out } = stageMac();
    const same = { status: 200, body: JSON.stringify({ version: '0.1.0' }) };
    const both = fakeFetch({
      [`${PUBLIC}/releases/latest-darwin-aarch64.json`]: same,
      [`${PUBLIC}/releases/latest-darwin-x86_64.json`]: same,
    });
    await expect(feed.monotonic(out, { fetchFn: both.fetchFn, log: () => {} })).resolves.toEqual({
      verdicts: ['published', 'published'],
    });

    const one = fakeFetch({ [`${PUBLIC}/releases/latest-darwin-aarch64.json`]: same });
    await expect(feed.monotonic(out, { fetchFn: one.fetchFn, log: () => {} })).resolves.toEqual({
      verdicts: ['published', 'first'],
    });
  });

  it('fails closed on anything but a 200 or a 404', async () => {
    const { out } = stageMac();
    const { fetchFn } = fakeFetch({ [`${PUBLIC}/releases/latest-darwin-aarch64.json`]: { status: 503 } });
    await expect(feed.monotonic(out, { fetchFn, log: () => {} })).rejects.toThrow(/HTTP 503/);
  });
});

describe('a published file never changes', () => {
  function published(out: string, override: Record<string, Route> = {}) {
    const dir = join(out, 'files', '0.1.0');
    const routes: Record<string, Route> = {};
    for (const name of readdirSync(dir)) {
      routes[`${PUBLIC}/releases/0.1.0/${name}`] = { status: 200, body: readFileSync(join(dir, name)) };
    }
    return { ...routes, ...override };
  }

  it('calls every file new on a first publish', async () => {
    const { out } = stageMac();
    const { fetchFn } = fakeFetch({});
    const { unpublished, published: there } = await feed.writeOnce(out, { fetchFn, log: () => {} });
    expect(there).toEqual([]);
    expect(unpublished).toHaveLength(4);
  });

  it('lets a re-run of the same build through, file for file', async () => {
    const { out } = stageMac();
    const { fetchFn } = fakeFetch(published(out));
    const result = await feed.writeOnce(out, { fetchFn, log: () => {} });
    expect(result.unpublished).toEqual([]);
    expect(result.published).toHaveLength(4);
  });

  /*
   * The defect: a whole release re-run rebuilds the payload with new bytes and
   * a new signature under the same name, and uploading it would put one
   * build's bytes beside another build's signature in a live feed entry.
   */
  it('refuses a rebuild under a version already published', async () => {
    const { out } = stageMac();
    const { fetchFn } = fakeFetch(
      published(out, {
        [`${PUBLIC}/releases/0.1.0/SpeakingGlass_0.1.0_universal.app.tar.gz`]: { status: 200, body: 'the first build' },
      }),
    );
    await expect(feed.writeOnce(out, { fetchFn, log: () => {} })).rejects.toThrow(/already published with different bytes/);
  });

  it('asks the origin past the cache, so a cached 404 cannot outlive the upload', async () => {
    const { out } = stageMac();
    const { fetchFn, asked } = fakeFetch({});
    await feed.writeOnce(out, { fetchFn, log: () => {} });
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((url) => /[?&]cb=/.test(url))).toBe(true);
  });

  it('fails closed on anything but a 200 or a 404', async () => {
    const { out } = stageMac();
    const { fetchFn } = fakeFetch({ [`${PUBLIC}/releases/0.1.0/SpeakingGlass_0.1.0_universal.dmg`]: { status: 403 } });
    await expect(feed.writeOnce(out, { fetchFn, log: () => {} })).rejects.toThrow(/HTTP 403/);
  });
});

describe('a release is published through the origin it was staged for', () => {
  it('accepts the same origin, with or without a trailing slash', () => {
    const { out } = stageMac();
    expect(() => feed.checkOrigin(out, PUBLIC)).not.toThrow();
    expect(() => feed.checkOrigin(out, `${PUBLIC}/`)).not.toThrow();
  });

  it('refuses another one', () => {
    const { out } = stageMac();
    expect(() => feed.checkOrigin(out, 'https://updates.speakingglass.com')).toThrow(/staged for/);
  });

  /*
   * The publisher's default origin and the updater's compiled base are two
   * constants in two languages. If they part, every release lands somewhere no
   * installed copy looks.
   */
  it('publishes by default to the base the app polls', () => {
    const updater = readFileSync(join(__dirname, '../../src-tauri/src/updater.rs'), 'utf8');
    const base = /pub const UPDATE_BASE_URL: &str = "([^"]+)";/.exec(updater)?.[1];
    expect(base, 'UPDATE_BASE_URL could not be read out of updater.rs').toBeDefined();
    // Trailing slashes trimmed the way the script's own releasesUrl() does.
    expect(`${feed.DEFAULT_PUBLIC_URL.replace(/\/+$/, '')}/releases/`).toBe(base);
  });
});

describe('only the newest stable release may be called Latest', () => {
  it('picks the newest stable tag by semver, not by the order it is given', () => {
    expect(feed.newestStable(['v0.1.0'])).toBe('v0.1.0');
    expect(feed.newestStable(['v0.2.0', 'v0.10.0', 'v0.9.1'])).toBe('v0.10.0');
  });

  it('never hands Latest to a prerelease', () => {
    expect(feed.newestStable(['v0.2.0', 'v0.3.0-rc.1', 'v0.3.0-beta.2'])).toBe('v0.2.0');
  });

  it('names nothing when there is no stable release yet', () => {
    expect(feed.newestStable([])).toBeNull();
    expect(feed.newestStable(['v0.1.0-rc.1', 'nightly', '0.1.0'])).toBeNull();
  });
});

describe('nothing is announced until it is readable', () => {
  function servedFiles(out: string, override: Record<string, Route> = {}) {
    const dir = join(out, 'files', '0.1.0');
    const routes: Record<string, Route> = {};
    for (const name of readdirSync(dir)) {
      routes[`${PUBLIC}/releases/0.1.0/${name}`] = {
        status: 200,
        body: readFileSync(join(dir, name)),
        headers: { 'cache-control': feed.IMMUTABLE_CACHE_CONTROL },
      };
    }
    return { ...routes, ...override };
  }

  it('passes when every file is served byte for byte', async () => {
    const { out } = stageMac();
    const { fetchFn } = fakeFetch(servedFiles(out));
    await expect(feed.verifyFiles(out, { fetchFn, ...quiet })).resolves.toBeUndefined();
  });

  it('fails on a missing file', async () => {
    const { out } = stageMac();
    const routes = servedFiles(out);
    delete routes[`${PUBLIC}/releases/0.1.0/SpeakingGlass_0.1.0_universal.dmg`];
    const { fetchFn } = fakeFetch(routes);
    await expect(feed.verifyFiles(out, { fetchFn, ...quiet })).rejects.toThrow(/HTTP 404/);
  });

  it('fails when the edge serves different bytes under the same name', async () => {
    const { out } = stageMac();
    const { fetchFn } = fakeFetch(
      servedFiles(out, {
        [`${PUBLIC}/releases/0.1.0/SpeakingGlass_0.1.0_universal.app.tar.gz`]: {
          status: 200,
          body: 'an earlier build',
          headers: { 'cache-control': feed.IMMUTABLE_CACHE_CONTROL },
        },
      }),
    );
    await expect(feed.verifyFiles(out, { fetchFn, ...quiet })).rejects.toThrow(/served sha256/);
  });

  it('retries a file that is not readable yet', async () => {
    const { out } = stageMac();
    let calls = 0;
    const dmg = readFileSync(join(out, 'files', '0.1.0', 'SpeakingGlass_0.1.0_universal.dmg'));
    const { fetchFn } = fakeFetch(
      servedFiles(out, {
        [`${PUBLIC}/releases/0.1.0/SpeakingGlass_0.1.0_universal.dmg`]: (() =>
          ++calls === 1
            ? { status: 404 }
            : { status: 200, body: dmg, headers: { 'cache-control': feed.IMMUTABLE_CACHE_CONTROL } }) as unknown as Route,
      }),
    );
    await expect(feed.verifyFiles(out, { fetchFn, ...quiet })).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  /*
   * The bytes can be right and the lifetime wrong: an upload that lost its
   * `--cache-control`, or an edge rule that rewrites it. Nothing else reads
   * the header back.
   */
  it.each([
    ['no Cache-Control at all', undefined],
    ['a short lifetime', 'public, max-age=3600, immutable'],
    ['a longer lifetime than was set', 'public, max-age=63072000, immutable'],
    ['a year without immutable, as Cloudflare strips it', 'public, max-age=31536000'],
    ['a year without public', 'max-age=31536000, immutable'],
    ['a valued public', 'public=1, max-age=31536000, immutable'],
    ['a shorter lifetime for the edge', 'public, max-age=31536000, s-maxage=60, immutable'],
    ['two lifetimes that disagree', 'public, max-age=31536000, max-age=60, immutable'],
    ['two lifetimes that disagree, the other way round', 'public, max-age=60, max-age=31536000, immutable'],
    ['a lookalike public', 'x-public, max-age=31536000, immutable'],
    ['a lookalike immutable', 'public, max-age=31536000, x-immutable'],
    ['no-cache as well', 'public, max-age=31536000, immutable, no-cache'],
    ['no-store as well', 'public, max-age=31536000, immutable, no-store'],
    ['private as well', 'public, max-age=31536000, immutable, private'],
    ['an unterminated quote hiding a lifetime', 'public, max-age=31536000", immutable'],
    ["the feed's lifetime", feed.UNCACHED_CACHE_CONTROL],
  ])('fails on a file served with %s', async (_label, cacheControl) => {
    const { out } = stageMac();
    const routes = withHeader(servedFiles(out), `${PUBLIC}/releases/0.1.0/SpeakingGlass_0.1.0_universal.dmg`, cacheControl);
    const { fetchFn } = fakeFetch(routes);
    await expect(feed.verifyFiles(out, { fetchFn, ...quiet })).rejects.toThrow(
      /SpeakingGlass_0\.1\.0_universal\.dmg: served with Cache-Control/,
    );
  });

  it('checks every file it uploads, not just the installer', async () => {
    for (const name of [
      'SpeakingGlass_0.1.0_universal.app.tar.gz',
      'SpeakingGlass_0.1.0_universal.app.tar.gz.sig',
      'SHA256SUMS-macos.txt',
    ]) {
      const { out } = stageMac();
      const routes = withHeader(servedFiles(out), `${PUBLIC}/releases/0.1.0/${name}`, 'public, max-age=300');
      const { fetchFn } = fakeFetch(routes);
      await expect(feed.verifyFiles(out, { fetchFn, ...quiet })).rejects.toThrow(`${name}: served with Cache-Control`);
    }
  });

  it('retries a file whose edge copy still carries an old lifetime', async () => {
    const { out } = stageMac();
    const url = `${PUBLIC}/releases/0.1.0/SpeakingGlass_0.1.0_universal.dmg`;
    const routes = servedFiles(out);
    const good = routes[url]!;
    let calls = 0;
    routes[url] = (() =>
      ++calls === 1
        ? { ...good, headers: { 'cache-control': 'public, max-age=60, immutable' } }
        : good) as unknown as Route;
    const { fetchFn } = fakeFetch(routes);
    await expect(feed.verifyFiles(out, { fetchFn, ...quiet })).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  /*
   * A rejected body is dropped, never read: an installer is large, and a
   * header that is wrong says nothing its bytes could change.
   */
  it.each([
    ['an error status', 503, feed.IMMUTABLE_CACHE_CONTROL, /HTTP 503/],
    ['the wrong lifetime', 200, 'max-age=60', /served with Cache-Control/],
  ])('drops the body of a file refused for %s without reading it', async (_label, status, cacheControl, error) => {
    const { out } = stageMac();
    let pulls = 0;
    let cancels = 0;
    const fetchFn = async () =>
      new Response(
        new ReadableStream(
          {
            pull() {
              pulls++;
            },
            cancel() {
              cancels++;
            },
          },
          { highWaterMark: 0 },
        ),
        { status, headers: { 'cache-control': cacheControl } },
      );
    await expect(feed.verifyFiles(out, { fetchFn, ...quiet })).rejects.toThrow(error);
    expect(pulls).toBe(0);
    expect(cancels).toBe(quiet.attempts);
  });

  it('reports the refusal, not a failure to drop the body', async () => {
    const { out } = stageMac();
    const fetchFn = async () =>
      new Response(
        new ReadableStream({
          cancel() {
            throw new Error('the stream would not close');
          },
        }),
        { status: 200, headers: { 'cache-control': 'max-age=60' } },
      );
    await expect(feed.verifyFiles(out, { fetchFn, ...quiet })).rejects.toThrow(/served with Cache-Control "max-age=60"/);
  });

  it.each([
    ['in any case and order', 'Immutable,PUBLIC ,  Max-Age=31536000'],
    ['with the same lifetime for the edge', 'public, max-age=31536000, s-maxage=31536000, immutable'],
    ['with a quoted, zero-padded lifetime', 'public, max-age="031536000", immutable'],
    ['with an argument to immutable, which is ignored', 'public, max-age=31536000, immutable=yes'],
    ['with an unrelated directive', 'public, max-age=31536000, immutable, no-transform'],
  ])('accepts the immutable lifetime %s', async (_label, cacheControl) => {
    const { out } = stageMac();
    const routes = servedFiles(out);
    for (const route of Object.values(routes)) route.headers = { 'cache-control': cacheControl };
    const { fetchFn } = fakeFetch(routes);
    await expect(feed.verifyFiles(out, { fetchFn, ...quiet })).resolves.toBeUndefined();
  });
});

describe('the feed is verified as clients will read it', () => {
  function servedFeed(out: string, headers: Record<string, string> = { 'cache-control': feed.UNCACHED_CACHE_CONTROL }) {
    const routes: Record<string, Route> = {};
    for (const name of readdirSync(join(out, 'feed'))) {
      routes[`${PUBLIC}/releases/${name}`] = { status: 200, body: readFileSync(join(out, 'feed', name)), headers };
    }
    return routes;
  }

  it('passes when every entry is served as staged, uncached', async () => {
    const { out } = stageMac();
    const { fetchFn } = fakeFetch(servedFeed(out));
    await expect(feed.verifyFeed(out, { fetchFn, ...quiet })).resolves.toBeUndefined();
  });

  it('fails on an entry served with a cache lifetime', async () => {
    const { out } = stageMac();
    const { fetchFn } = fakeFetch(servedFeed(out, { 'cache-control': 'public, max-age=31536000, immutable' }));
    await expect(feed.verifyFeed(out, { fetchFn, ...quiet })).rejects.toThrow(/Cache-Control/);
  });

  /*
   * Each row breaks one thing about an otherwise correct header, and only one
   * entry carries it, so a check that looked at the first entry, or at the
   * header as a whole, would let it through.
   */
  it.each([
    ['no-cache alone, which a cache may still store', 'no-cache'],
    ['no-cache naming only a header field', 'no-cache="Set-Cookie", no-store, must-revalidate'],
    ['no no-cache', 'no-store, must-revalidate'],
    ['no-store alone', 'no-store'],
    ['no must-revalidate', 'no-cache, no-store'],
    ['a valued no-store', 'no-cache, no-store=1, must-revalidate'],
    ['a valued must-revalidate', 'no-cache, no-store, must-revalidate=1'],
    ['a lifetime as well', 'no-cache, no-store, must-revalidate, max-age=60'],
    ['a lifetime for the edge as well', 'no-cache, no-store, must-revalidate, s-maxage=60'],
    ['a licence to serve it stale while revalidating', 'no-cache, no-store, must-revalidate, stale-while-revalidate=60'],
    ['a licence to serve it stale on error', 'no-cache, no-store, must-revalidate, stale-if-error=60'],
    ['public as well', 'no-cache, no-store, must-revalidate, public'],
    ['immutable as well', 'no-cache, no-store, must-revalidate, immutable'],
    ['a lookalike no-cache', 'x-no-cache, no-store, must-revalidate'],
    ['an unterminated quote hiding the policy', 'ext="never closed, no-cache, no-store, must-revalidate'],
    ['no Cache-Control at all', undefined],
  ])('fails on an entry served with %s', async (_label, cacheControl) => {
    const { out } = stageMac();
    const routes = withHeader(servedFeed(out), `${PUBLIC}/releases/latest-macos.json`, cacheControl);
    const { fetchFn } = fakeFetch(routes);
    await expect(feed.verifyFeed(out, { fetchFn, ...quiet })).rejects.toThrow(
      /latest-macos\.json: served with Cache-Control/,
    );
  });

  it('fails on an entry that is not served', async () => {
    const { out } = stageMac();
    const routes = servedFeed(out);
    routes[`${PUBLIC}/releases/latest-macos.json`] = { ...routes[`${PUBLIC}/releases/latest-macos.json`]!, status: 503 };
    const { fetchFn } = fakeFetch(routes);
    await expect(feed.verifyFeed(out, { fetchFn, ...quiet })).rejects.toThrow(/latest-macos\.json: HTTP 503/);
  });

  it.each(['HIT', 'STALE', 'UPDATING', 'REVALIDATED'])(
    'fails on an entry Cloudflare answered from its cache (%s), whatever its header says',
    async (status) => {
      const { out } = stageMac();
      const routes = servedFeed(out);
      const url = `${PUBLIC}/releases/latest-macos.json`;
      routes[url] = {
        ...routes[url]!,
        headers: { 'cache-control': feed.UNCACHED_CACHE_CONTROL, 'cf-cache-status': status },
      };
      const { fetchFn } = fakeFetch(routes);
      await expect(feed.verifyFeed(out, { fetchFn, ...quiet })).rejects.toThrow(
        new RegExp(`latest-macos\\.json: served from Cloudflare's cache \\(CF-Cache-Status ${status}\\)`),
      );
    },
  );

  it('accepts an entry Cloudflare passed through', async () => {
    const { out } = stageMac();
    for (const status of ['BYPASS', 'DYNAMIC', 'MISS']) {
      const { fetchFn } = fakeFetch(
        servedFeed(out, { 'cache-control': feed.UNCACHED_CACHE_CONTROL, 'cf-cache-status': status }),
      );
      await expect(feed.verifyFeed(out, { fetchFn, ...quiet })).resolves.toBeUndefined();
    }
  });

  it('asks as the updater does, with nothing that could make a cache answer differently', async () => {
    const { out } = stageMac();
    const { fetchFn, requests } = fakeFetch(servedFeed(out));
    await feed.verifyFeed(out, { fetchFn, ...quiet });
    expect(requests.length).toBeGreaterThan(0);
    for (const { url, headers, cache } of requests) {
      expect(url).not.toContain('cb=');
      expect(headers.has('cache-control')).toBe(false);
      expect(headers.has('pragma')).toBe(false);
      expect(cache ?? 'default').toBe('default');
    }
  });

  it.each([
    ['in any case and order', 'must-revalidate,NO-STORE ,No-Cache'],
    ['with a zero lifetime spelled out', 'no-cache, no-store, must-revalidate, max-age=0, s-maxage=00'],
  ])('accepts the uncached policy %s', async (_label, cacheControl) => {
    const { out } = stageMac();
    const { fetchFn } = fakeFetch(servedFeed(out, { 'cache-control': cacheControl }));
    await expect(feed.verifyFeed(out, { fetchFn, ...quiet })).resolves.toBeUndefined();
  });

  it('fails on a stale entry', async () => {
    const { out } = stageMac();
    const routes = servedFeed(out);
    const staged = JSON.parse(readFileSync(join(out, 'feed', 'latest-darwin-x86_64.json'), 'utf8'));
    routes[`${PUBLIC}/releases/latest-darwin-x86_64.json`] = {
      status: 200,
      body: JSON.stringify({ ...staged, version: '0.0.9' }),
      headers: { 'cache-control': feed.UNCACHED_CACHE_CONTROL },
    };
    const { fetchFn } = fakeFetch(routes);
    await expect(feed.verifyFeed(out, { fetchFn, ...quiet })).rejects.toThrow(/differs/);
  });
});

describe('Cache-Control is read as directives, not as text', () => {
  const read = (header: string | null) => {
    const directives = feed.cacheDirectives(header);
    if (directives === null) throw new Error(`"${header}" did not parse`);
    return directives;
  };

  it('lower-cases names, trims, and unquotes values', () => {
    expect([...read(' Public,MAX-AGE="60" , immutable')]).toEqual([
      ['public', true],
      ['max-age', '60'],
      ['immutable', true],
    ]);
  });

  it('does not split a quoted value at its comma', () => {
    expect([...read('no-cache="Set-Cookie, Vary", no-store')]).toEqual([
      ['no-cache', 'Set-Cookie, Vary'],
      ['no-store', true],
    ]);
  });

  it('unescapes a quoted value and keeps its escaped quote inside it', () => {
    expect([...read('ext="a\\"b, c", no-store')]).toEqual([
      ['ext', 'a"b, c'],
      ['no-store', true],
    ]);
  });

  it('marks a directive given twice with different values as conflicting', () => {
    expect(typeof feed.CONFLICTING).toBe('symbol');
    expect(read('max-age=60, max-age=31536000').get('max-age')).toBe(feed.CONFLICTING);
    expect(read('max-age=31536000, max-age=60').get('max-age')).toBe(feed.CONFLICTING);
    expect(read('no-cache, no-cache="Set-Cookie"').get('no-cache')).toBe(feed.CONFLICTING);
    expect(read('no-store, no-store').get('no-store')).toBe(true);
  });

  it('reads nothing from an absent or empty header, or from empty members', () => {
    expect(read(null).size).toBe(0);
    expect(read('').size).toBe(0);
    expect([...read(' , no-store,, ,')]).toEqual([['no-store', true]]);
  });

  it.each([
    ['an unterminated quote', 'ext="never closed, no-store'],
    ['a stray quote after a value', 'max-age=60", no-store'],
    ['a value with no name', '=60, no-store'],
    ['a name that is not a token', 'no store, max-age=60'],
    ['a value that is not a token', 'max-age=6 0'],
  ])('refuses %s rather than reading past it', (_label, header) => {
    expect(feed.cacheDirectives(header)).toBeNull();
  });

  it('accepts exactly what the publish step uploads', () => {
    expect(feed.immutableCacheProblem(feed.IMMUTABLE_CACHE_CONTROL)).toBeNull();
    expect(feed.uncachedProblem(feed.UNCACHED_CACHE_CONTROL)).toBeNull();
  });
});
