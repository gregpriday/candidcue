/**
 * The speech-model mirror publisher, broken in each way it exists to refuse.
 *
 * `scripts/mirror-models.mjs` is what makes the catalogue's `mirrorBaseUrl`
 * answer (#198). Every failure it guards against is silent until upstream's
 * mutable tag moves: a key written somewhere the app never asks, an object
 * overwritten with different bytes, an upload that passed while the public URL
 * still served a 404. So each test constructs one of those and asserts the
 * script notices. Nothing here reaches a remote host — the transfers run
 * against a loopback server, and the bucket is a fake `aws`.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as mirror from '../../scripts/mirror-models.mjs';

const REPO_ROOT = resolve(__dirname, '../..');
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'mirror-models-'));
  dirs.push(dir);
  return dir;
};

const ARCHIVE = Buffer.from('a stand-in for a model archive, long enough to hash\n'.repeat(64));

function fixtureModel(bytes = ARCHIVE) {
  return {
    id: 'fixture',
    installDir: 'fixture',
    archive: {
      fileName: 'fixture.tar.bz2',
      upstreamUrl: 'https://upstream.invalid/fixture.tar.bz2',
      sha256: sha256(bytes),
      bytes: bytes.length,
    },
    attribution: { license: { id: 'Apache-2.0' } },
  };
}

/* ------------------------------------------------------ where the bytes live */

describe('the mirror key is derived from the URL a client asks for', () => {
  const PUBLIC = 'https://updates.speakingglass.com';

  it('strips the public origin off the mirror base', () => {
    expect(mirror.mirrorPrefix('https://updates.speakingglass.com/models', PUBLIC)).toBe('models');
    expect(mirror.mirrorPrefix('https://updates.speakingglass.com/models/', `${PUBLIC}/`)).toBe('models');
    expect(mirror.mirrorPrefix('https://updates.speakingglass.com', PUBLIC)).toBe('');
    expect(mirror.mirrorPrefix('https://cdn.example/root/models', 'https://cdn.example/root')).toBe('models');
  });

  it.each([
    ['another host', 'https://models.example/models'],
    ['a lookalike host', 'https://updates.speakingglass.com.evil.example/models'],
    ['plain http', 'http://updates.speakingglass.com/models'],
    ['a query', 'https://updates.speakingglass.com/models?x=1'],
    ['credentials', 'https://user:pw@updates.speakingglass.com/models'],
  ])('refuses a mirror base with %s', (_why, base) => {
    expect(() => mirror.mirrorPrefix(base, PUBLIC)).toThrow();
  });

  it('refuses a base outside the public path', () => {
    expect(() => mirror.mirrorPrefix('https://cdn.example/other/models', 'https://cdn.example/root')).toThrow(
      /outside/,
    );
  });

  it('puts the archive and its notices in one content-addressed directory', () => {
    const model = fixtureModel();
    const dir = `models/sha256/${model.archive.sha256}`;
    expect(mirror.mirrorKeys('models', model)).toEqual({
      archive: `${dir}/fixture.tar.bz2`,
      attribution: `${dir}/ATTRIBUTION.md`,
      license: `${dir}/LICENSE-Apache-2.0.txt`,
    });
    expect(mirror.mirrorKeys('', model).archive).toBe(`sha256/${model.archive.sha256}/fixture.tar.bz2`);
  });

  /*
   * The same literal `model_download.rs`'s
   * `the_shipped_catalogue_asks_the_mirror_before_upstream` pins, and the URL
   * `fetch-stt-model.sh` is handed: the three readers and the one writer
   * must agree on one string.
   */
  it('fills exactly the URL the app and the fetch script ask for', () => {
    const catalogue = mirror.loadCatalogue();
    const model = catalogue.models.find((m: { id: string }) => m.id === 'x-asr-480ms');
    const expected = `https://updates.speakingglass.com/models/sha256/${model.archive.sha256}/${model.archive.fileName}`;

    expect(catalogue.mirrorBaseUrl).toBe('https://updates.speakingglass.com/models');
    expect(mirror.mirrorUrl(catalogue.mirrorBaseUrl, model)).toBe(expected);

    const prefix = mirror.mirrorPrefix(catalogue.mirrorBaseUrl, mirror.DEFAULT_PUBLIC_URL);
    expect(`${mirror.DEFAULT_PUBLIC_URL}/${mirror.mirrorKeys(prefix, model).archive}`).toBe(expected);

    const env = { ...process.env };
    delete env.SPEAKING_GLASS_MODEL_MIRROR;
    delete env.SPEAKING_GLASS_MODEL_CATALOGUE;
    const fields = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/model-catalogue.mjs'), 'fields'], {
      encoding: 'utf8',
      env,
    });
    expect(fields.status, fields.stderr).toBe(0);
    expect(fields.stdout.split('\0')[7]).toBe(expected);
  });

  it('refuses a catalogue entry whose names would escape a key', () => {
    const model = fixtureModel();
    expect(() => mirror.checkModel({ ...model, archive: { ...model.archive, fileName: '../x' } })).toThrow();
    expect(() => mirror.checkModel({ ...model, archive: { ...model.archive, sha256: 'ABC' } })).toThrow();
    expect(() =>
      mirror.checkModel({ ...model, attribution: { license: { id: '../../etc/passwd' } } }),
    ).toThrow(/SPDX/);
    expect(mirror.checkModel(model)).toBe(model);
  });
});

/* ------------------------------------------------------------ the transfers */

describe('a transfer is judged on every byte', () => {
  const routes = new Map<string, { status: number; body: Buffer }>();
  let server: Server;
  let origin = '';

  beforeAll(async () => {
    server = createServer((req, res) => {
      const route = routes.get(req.url ?? '');
      if (!route) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(route.status, { 'content-length': route.body.length }).end(route.body);
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((done) => server.close(() => done())));

  const expected = { sha256: sha256(ARCHIVE), bytes: ARCHIVE.length };

  it('downloads the pinned bytes to disk', async () => {
    routes.set('/good', { status: 200, body: ARCHIVE });
    const dest = join(scratch(), 'a');
    await mirror.downloadVerified(`${origin}/good`, dest, expected);
    expect(readFileSync(dest).equals(ARCHIVE)).toBe(true);
  });

  it('refuses same-length bytes that are not the pinned ones', async () => {
    const wrong = Buffer.from(ARCHIVE);
    wrong[10] ^= 1;
    routes.set('/wrong', { status: 200, body: wrong });
    await expect(mirror.downloadVerified(`${origin}/wrong`, join(scratch(), 'b'), expected)).rejects.toThrow(
      /sha256/,
    );
  });

  it('stops reading at the pinned length', async () => {
    routes.set('/long', { status: 200, body: Buffer.concat([ARCHIVE, Buffer.from('more')]) });
    await expect(mirror.downloadVerified(`${origin}/long`, join(scratch(), 'c'), expected)).rejects.toThrow(
      /exceeded/,
    );
  });

  it('refuses an error page', async () => {
    routes.set('/gone', { status: 410, body: Buffer.from('gone') });
    await expect(mirror.downloadVerified(`${origin}/gone`, join(scratch(), 'd'), expected)).rejects.toThrow(
      /HTTP 410/,
    );
  });

  it('reads back a status, a length and a digest', async () => {
    routes.set('/good', { status: 200, body: ARCHIVE });
    expect(await mirror.readBack(`${origin}/good`, ARCHIVE.length)).toEqual({ status: 200, ...expected });
    expect(await mirror.readBack(`${origin}/missing`, ARCHIVE.length)).toEqual({ status: 404 });
  });
});

/* ---------------------------------------------------------- the verification */

describe('the run passes only once the public URL serves the pinned bytes', () => {
  const expected = { sha256: sha256(ARCHIVE), bytes: ARCHIVE.length };
  const quiet = () => {};

  it('waits out a cached 404', async () => {
    const answers = [{ status: 404 }, { status: 404 }, { status: 200, ...expected }];
    let reads = 0;
    await mirror.verifyArchive('https://m/x', expected, {
      read: async () => answers[reads++]!,
      attempts: 3,
      delayMs: 0,
      log: quiet,
    });
    expect(reads).toBe(3);
  });

  it('fails on a same-length object of the wrong bytes', async () => {
    await expect(
      mirror.verifyArchive('https://m/x', expected, {
        read: async () => ({ status: 200, bytes: expected.bytes, sha256: '0'.repeat(64) }),
        attempts: 2,
        delayMs: 0,
        log: quiet,
      }),
    ).rejects.toThrow(/sha256 0{64}/);
  });

  it('fails when the URL never answers', async () => {
    await expect(
      mirror.verifyArchive('https://m/x', expected, {
        read: async () => ({ status: 404 }),
        attempts: 2,
        delayMs: 0,
        log: quiet,
      }),
    ).rejects.toThrow(/HTTP 404/);
  });
});

/* ------------------------------------------------------------- the decisions */

function fakeBucket(existing: { size: number } | null, putOutcome: 'created' | 'exists' = 'created') {
  const calls = { heads: [] as string[], puts: [] as Array<{ key: string; ifAbsent?: boolean; cacheControl: string }> };
  return {
    calls,
    bucket: {
      head(key: string) {
        calls.heads.push(key);
        return existing;
      },
      put(key: string, _file: string, options: { ifAbsent?: boolean; cacheControl: string }) {
        calls.puts.push({ key, ...options });
        return putOutcome;
      },
    },
  };
}

describe('only an absent key is ever written', () => {
  const model = fixtureModel();
  const keys = mirror.mirrorKeys('models', model);
  const url = `https://updates.speakingglass.com/${keys.archive}`;
  const quiet = () => {};

  function harness(existing: { size: number } | null, putOutcome?: 'created' | 'exists') {
    const { bucket, calls } = fakeBucket(existing, putOutcome);
    const downloads: string[] = [];
    const verified: string[] = [];
    const run = () =>
      mirror.syncModel(model, {
        bucket,
        keys,
        url,
        scratch: scratch(),
        log: quiet,
        download: async (from: string) => {
          downloads.push(from);
        },
        verify: async (at: string) => {
          verified.push(at);
        },
      });
    return { run, calls, downloads, verified };
  }

  it('fetches upstream, writes conditionally and immutably, then verifies the client URL', async () => {
    const h = harness(null);
    await h.run();
    expect(h.downloads).toEqual([model.archive.upstreamUrl]);
    expect(h.calls.puts).toEqual([
      expect.objectContaining({ key: keys.archive, ifAbsent: true, cacheControl: expect.stringContaining('immutable') }),
    ]);
    expect(h.verified).toEqual([url]);
  });

  it('leaves an object already there alone, and still verifies it', async () => {
    const h = harness({ size: model.archive.bytes });
    await h.run();
    expect(h.downloads).toEqual([]);
    expect(h.calls.puts).toEqual([]);
    expect(h.verified).toEqual([url]);
  });

  it('refuses to touch an object of the wrong size', async () => {
    const h = harness({ size: model.archive.bytes - 1 });
    await expect(h.run()).rejects.toThrow(/never overwritten/);
    expect(h.downloads).toEqual([]);
    expect(h.calls.puts).toEqual([]);
    expect(h.verified).toEqual([]);
  });

  it('verifies what a concurrent writer put there', async () => {
    const h = harness(null, 'exists');
    await h.run();
    expect(h.verified).toEqual([url]);
  });

  it('uploads nothing when upstream does not yield the pinned bytes', async () => {
    const { bucket, calls } = fakeBucket(null);
    await expect(
      mirror.syncModel(model, {
        bucket,
        keys,
        url,
        scratch: scratch(),
        log: quiet,
        download: async () => {
          throw new Error('upstream sent sha256 x');
        },
      }),
    ).rejects.toThrow(/upstream/);
    expect(calls.puts).toEqual([]);
  });
});

/* ---------------------------------------------------------------- the bucket */

describe('the aws CLI is asked the right questions', () => {
  type Run = { status: number; stdout?: string; stderr?: string };
  function bucketAnswering(answer: Run) {
    const seen: string[][] = [];
    const bucket = mirror.awsBucket({
      endpoint: 'https://account.r2.example',
      bucket: 'speaking-glass',
      run: ((_cmd: string, args: string[]) => {
        seen.push(args);
        return { stdout: '', stderr: '', ...answer };
      }) as never,
    });
    return { bucket, seen };
  }

  it('reports an absent key as absent and a present one by size', () => {
    expect(
      bucketAnswering({ status: 254, stderr: 'An error occurred (404) when calling the HeadObject operation: Not Found' })
        .bucket.head('k'),
    ).toBeNull();
    expect(bucketAnswering({ status: 0, stdout: '{"ContentLength": 42}' }).bucket.head('k')).toEqual({ size: 42 });
  });

  it('does not mistake an access failure for an absent key', () => {
    const { bucket } = bucketAnswering({ status: 254, stderr: 'An error occurred (403) when calling the HeadObject operation: Forbidden' });
    expect(() => bucket.head('k')).toThrow(/403/);
  });

  it('writes an archive only if the key is absent, and reports losing the race', () => {
    const { bucket, seen } = bucketAnswering({
      status: 254,
      stderr: 'An error occurred (PreconditionFailed) when calling the PutObject operation',
    });
    expect(bucket.put('k', '/f', { contentType: 'a', cacheControl: 'c', ifAbsent: true })).toBe('exists');
    expect(seen[0]).toEqual(expect.arrayContaining(['--if-none-match', '*', '--endpoint-url', 'https://account.r2.example']));
    expect(() => bucket.put('k', '/f', { contentType: 'a', cacheControl: 'c' })).toThrow(/put-object/);
  });

  it('needs both the endpoint and the bucket', () => {
    expect(() => mirror.awsBucket({ endpoint: '', bucket: 'b' })).toThrow(/R2_ENDPOINT/);
  });
});
