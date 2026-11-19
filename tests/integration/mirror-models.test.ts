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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    expect(mirror.mirrorPrefix('https://cdn.example/a/b/c', 'https://cdn.example/a')).toBe('b/c');
  });

  it.each([
    ['another host', 'https://models.example/models'],
    ['a lookalike host', 'https://updates.speakingglass.com.evil.example/models'],
    ['plain http', 'http://updates.speakingglass.com/models'],
    ['a query', 'https://updates.speakingglass.com/models?x=1'],
    ['credentials', 'https://user:pw@updates.speakingglass.com/models'],
    ['a password alone', 'https://:pw@updates.speakingglass.com/models'],
    ['a fragment', 'https://updates.speakingglass.com/models#x'],
    ['another port', 'https://updates.speakingglass.com:8443/models'],
    ['a path a key cannot spell', 'https://updates.speakingglass.com/mod%23els'],
  ])('refuses a mirror base with %s', (_why, base) => {
    expect(() => mirror.mirrorPrefix(base, PUBLIC)).toThrow();
  });

  it('refuses a base outside the public path', () => {
    expect(() => mirror.mirrorPrefix('https://cdn.example/other/models', 'https://cdn.example/root')).toThrow(
      /outside/,
    );
    // A sibling that merely starts with the same letters is outside too.
    expect(() => mirror.mirrorPrefix('https://cdn.example/rooted/models', 'https://cdn.example/root')).toThrow(
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
    const mit = { ...model, attribution: { license: { id: 'MIT' } } };
    expect(mirror.mirrorKeys('models', mit).license).toBe(`${dir}/LICENSE-MIT.txt`);
  });

  /*
   * The same literal `model_download.rs`'s
   * `the_shipped_catalogue_asks_the_mirror_before_upstream` pins, and the URL
   * `fetch-stt-model.sh` is handed: the three readers and the one writer
   * must agree on one string.
   */
  it('fills exactly the URL the app and the fetch script ask for', () => {
    const catalogue = mirror.loadCatalogue();
    const model = catalogue.models.find((m) => m.id === 'x-asr-480ms');
    if (!model) throw new Error('the catalogue lost x-asr-480ms');
    const base = catalogue.mirrorBaseUrl;
    expect(base).toBe('https://updates.speakingglass.com/models');
    if (!base) return;
    const expected = `https://updates.speakingglass.com/models/sha256/${model.archive.sha256}/${model.archive.fileName}`;

    expect(mirror.mirrorUrl(base, model)).toBe(expected);

    const prefix = mirror.mirrorPrefix(base, mirror.DEFAULT_PUBLIC_URL);
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
    expect(() => mirror.checkModel({ ...model, installDir: '../models' })).toThrow(/installDir/);
    expect(() => mirror.checkModel({ ...model, archive: { ...model.archive, bytes: 0 } })).toThrow(/bytes/);
    expect(() =>
      mirror.checkModel({ ...model, archive: { ...model.archive, upstreamUrl: 'http://x.example/a' } }),
    ).toThrow(/https/);
    expect(mirror.checkModel(model)).toBe(model);
  });

  // `#` and `?` go into a key literally and are read by a client as a
  // fragment and a query: the upload and the download would name two objects.
  it.each(['model#1.tar.bz2', 'model?.tar.bz2', 'model%20.tar.bz2', 'model one.tar.bz2'])(
    'refuses an archive name a URL would read differently: %s',
    (fileName) => {
      const model = fixtureModel();
      expect(() => mirror.checkModel({ ...model, archive: { ...model.archive, fileName } })).toThrow(/URL-safe/);
    },
  );

  it('refuses an archive name its own notice would overwrite', () => {
    const model = fixtureModel();
    for (const fileName of ['ATTRIBUTION.md', 'LICENSE-Apache-2.0.txt']) {
      expect(() => mirror.checkModel({ ...model, archive: { ...model.archive, fileName } })).toThrow(/collides/);
    }
  });
});

/* ------------------------------------------------------------ the transfers */

describe('a transfer is judged on every byte', () => {
  const routes = new Map<string, { status: number; body: Buffer; length?: number }>();
  let server: Server;
  let origin = '';

  beforeAll(async () => {
    server = createServer((req, res) => {
      const route = routes.get(req.url ?? '');
      if (!route) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(route.status, { 'content-length': route.length ?? route.body.length });
      if (route.length !== undefined && route.length > route.body.length) {
        // Promise more than is sent, then drop: a transfer cut short.
        res.write(route.body, () => res.destroy());
        return;
      }
      res.end(route.body);
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

  it('refuses same-length bytes that are not the pinned ones, and keeps none of them', async () => {
    const wrong = Buffer.from(ARCHIVE);
    wrong[10] = wrong[10]! ^ 1;
    routes.set('/wrong', { status: 200, body: wrong });
    const dest = join(scratch(), 'b');
    await expect(mirror.downloadVerified(`${origin}/wrong`, dest, expected)).rejects.toThrow(/sha256/);
    expect(existsSync(dest)).toBe(false);
  });

  it('compares the whole digest, not a prefix of it', async () => {
    routes.set('/good', { status: 200, body: ARCHIVE });
    const last = expected.sha256.at(-1) === '0' ? '1' : '0';
    const nearly = { ...expected, sha256: `${expected.sha256.slice(0, -1)}${last}` };
    await expect(mirror.downloadVerified(`${origin}/good`, join(scratch(), 'b2'), nearly)).rejects.toThrow(/sha256/);
  });

  it('refuses a body shorter than the pinned length', async () => {
    routes.set('/short', { status: 200, body: ARCHIVE.subarray(0, 100) });
    await expect(mirror.downloadVerified(`${origin}/short`, join(scratch(), 'b3'), expected)).rejects.toThrow(
      /100 bytes/,
    );
  });

  it('fails a transfer that drops mid-body, and keeps nothing', async () => {
    routes.set('/drop', { status: 200, body: ARCHIVE.subarray(0, 100), length: ARCHIVE.length });
    const dest = join(scratch(), 'b4');
    await expect(mirror.downloadVerified(`${origin}/drop`, dest, expected)).rejects.toThrow();
    expect(existsSync(dest)).toBe(false);
  });

  it('survives a file it cannot write, rather than crashing the process', async () => {
    routes.set('/good', { status: 200, body: ARCHIVE });
    const dest = join(scratch(), 'no-such-directory', 'a');
    await expect(mirror.downloadVerified(`${origin}/good`, dest, expected)).rejects.toThrow(/ENOENT/);
  });

  it('stops reading at the pinned length', async () => {
    routes.set('/long', { status: 200, body: Buffer.concat([ARCHIVE, Buffer.from('more')]) });
    await expect(mirror.downloadVerified(`${origin}/long`, join(scratch(), 'c'), expected)).rejects.toThrow(
      /exceeded/,
    );
  });

  it('refuses an error page without creating the file', async () => {
    routes.set('/gone', { status: 410, body: Buffer.from('gone') });
    const dest = join(scratch(), 'd');
    await expect(mirror.downloadVerified(`${origin}/gone`, dest, expected)).rejects.toThrow(/HTTP 410/);
    expect(existsSync(dest)).toBe(false);
  });

  it('refuses a partial-content answer even when it carries the pinned bytes', async () => {
    routes.set('/partial', { status: 206, body: ARCHIVE });
    await expect(mirror.downloadVerified(`${origin}/partial`, join(scratch(), 'e'), expected)).rejects.toThrow(
      /HTTP 206/,
    );
  });

  it('reads back a status, a length and a digest', async () => {
    routes.set('/good', { status: 200, body: ARCHIVE });
    expect(await mirror.readBack(`${origin}/good`, ARCHIVE.length)).toEqual({ status: 200, ...expected });
    expect(await mirror.readBack(`${origin}/missing`, ARCHIVE.length)).toEqual({ status: 404 });
    routes.set('/forbidden', { status: 403, body: Buffer.from('no') });
    expect(await mirror.readBack(`${origin}/forbidden`, ARCHIVE.length)).toEqual({ status: 403 });
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

  it('fails on a same-length object of the wrong bytes, after every attempt', async () => {
    const last = expected.sha256.at(-1) === '0' ? '1' : '0';
    const nearly = `${expected.sha256.slice(0, -1)}${last}`;
    let reads = 0;
    await expect(
      mirror.verifyArchive('https://m/x', expected, {
        read: async () => {
          reads++;
          return { status: 200, bytes: expected.bytes, sha256: nearly };
        },
        attempts: 4,
        delayMs: 0,
        log: quiet,
      }),
    ).rejects.toThrow(nearly);
    expect(reads).toBe(4);
  });

  it('fails on the pinned digest at the wrong length', async () => {
    await expect(
      mirror.verifyArchive('https://m/x', expected, {
        read: async () => ({ status: 200, bytes: expected.bytes - 1, sha256: expected.sha256 }),
        attempts: 1,
        delayMs: 0,
        log: quiet,
      }),
    ).rejects.toThrow(/bytes/);
  });

  it('refuses bytes reached through a redirect down to http, as the app does', async () => {
    const downgraded = (async () => ({
      status: 200,
      url: 'http://mirror.example/x',
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(ARCHIVE));
          controller.close();
        },
      }),
    })) as unknown as typeof fetch;
    await expect(mirror.readBack('https://mirror.example/x', ARCHIVE.length, { fetchFn: downgraded })).rejects.toThrow(
      /not https/,
    );
  });

  it('names the timeout when a transfer stalls, not a bare abort', async () => {
    // A fetch that never answers until it is aborted, as fetch itself does.
    const stalled = ((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as unknown as typeof fetch;
    await expect(mirror.readBack('https://m/x', 1, { fetchFn: stalled, timeoutMs: 20 })).rejects.toThrow(
      'took longer than 20 ms',
    );
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

  const pinned = { sha256: model.archive.sha256, bytes: model.archive.bytes };

  function harness(existing: { size: number } | null, putOutcome?: 'created' | 'exists') {
    const { bucket, calls } = fakeBucket(existing, putOutcome);
    const downloads: Array<{ from: string; expected: unknown }> = [];
    const verified: Array<{ at: string; expected: unknown }> = [];
    const trace: string[] = [];
    const tracedBucket = {
      head: (key: string) => {
        trace.push(`head ${key}`);
        return bucket.head(key);
      },
      put: (key: string, file: string, options: { contentType: string; cacheControl: string; ifAbsent?: boolean }) => {
        trace.push(`put ${key}`);
        return bucket.put(key, file, options);
      },
    };
    const run = () =>
      mirror.syncModel(model, {
        bucket: tracedBucket,
        keys,
        url,
        scratch: scratch(),
        log: quiet,
        download: async (from: string, _dest: string, expected: unknown) => {
          trace.push(`download ${from}`);
          downloads.push({ from, expected });
        },
        verify: async (at: string, expected: unknown) => {
          trace.push(`verify ${at}`);
          verified.push({ at, expected });
        },
      });
    return { run, calls, downloads, verified, trace };
  }

  it('fetches upstream, writes conditionally and immutably, then verifies the client URL', async () => {
    const h = harness(null);
    await h.run();
    expect(h.trace).toEqual([
      `head ${keys.archive}`,
      `download ${model.archive.upstreamUrl}`,
      `put ${keys.archive}`,
      `verify ${url}`,
    ]);
    expect(h.downloads).toEqual([{ from: model.archive.upstreamUrl, expected: pinned }]);
    expect(h.calls.puts).toEqual([
      expect.objectContaining({ key: keys.archive, ifAbsent: true, cacheControl: expect.stringContaining('immutable') }),
    ]);
    expect(h.verified).toEqual([{ at: url, expected: pinned }]);
  });

  it('leaves an object already there alone, and still verifies it', async () => {
    const h = harness({ size: model.archive.bytes });
    await h.run();
    expect(h.downloads).toEqual([]);
    expect(h.calls.puts).toEqual([]);
    expect(h.verified).toEqual([{ at: url, expected: pinned }]);
  });

  it.each([-1, 1])('refuses to touch an object %i byte(s) off the pinned size', async (delta) => {
    const h = harness({ size: model.archive.bytes + delta });
    await expect(h.run()).rejects.toThrow(/never overwritten/);
    expect(h.downloads).toEqual([]);
    expect(h.calls.puts).toEqual([]);
    expect(h.verified).toEqual([]);
  });

  it('verifies what a concurrent writer put there', async () => {
    const h = harness(null, 'exists');
    await h.run();
    expect(h.verified).toEqual([{ at: url, expected: pinned }]);
  });

  it('uploads and verifies nothing when upstream does not yield the pinned bytes', async () => {
    const { bucket, calls } = fakeBucket(null);
    let verified = 0;
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
        verify: async () => {
          verified++;
        },
      }),
    ).rejects.toThrow(/upstream/);
    expect(calls.puts).toEqual([]);
    expect(verified).toBe(0);
  });
});

/* ------------------------------------------------------------ the whole run */

describe('a sync over the catalogue', () => {
  const quiet = () => {};
  const second = {
    ...fixtureModel(Buffer.from('a second archive\n'.repeat(32))),
    id: 'second',
    installDir: 'x-asr-480ms',
  };
  const first = { ...fixtureModel(), installDir: 'x-asr-480ms' };
  const catalogue = { mirrorBaseUrl: 'https://cdn.example/models', models: [first, second] };

  it("writes each model's notices before its archive, at the keys the client URL implies", async () => {
    const trace: string[] = [];
    const bodies = new Map<string, string>();
    const bucket = {
      head: (key: string) => {
        trace.push(`head ${key}`);
        return null;
      },
      put: (key: string, file: string) => {
        trace.push(`put ${key}`);
        bodies.set(key, readFileSync(file, 'utf8'));
        return 'created' as const;
      },
    };
    const verified: string[] = [];
    await mirror.syncCatalogue(catalogue, {
      publicUrl: 'https://cdn.example',
      bucket,
      scratch: scratch(),
      log: quiet,
      download: async (_from: string, dest: string) => {
        writeFileSync(dest, 'archive bytes');
      },
      verify: async (at: string) => {
        verified.push(at);
      },
    });

    const expectedTrace = [first, second].flatMap((model) => {
      const keys = mirror.mirrorKeys('models', model);
      return [`put ${keys.attribution}`, `put ${keys.license}`, `head ${keys.archive}`, `put ${keys.archive}`];
    });
    expect(trace).toEqual(expectedTrace);
    expect(verified).toEqual([first, second].map((model) => mirror.mirrorUrl(catalogue.mirrorBaseUrl, model)));

    const keys = mirror.mirrorKeys('models', first);
    expect(bodies.get(keys.attribution)).toBe(
      readFileSync(join(REPO_ROOT, 'src-tauri/models/x-asr-480ms/ATTRIBUTION.md'), 'utf8'),
    );
    expect(bodies.get(keys.license)).toBe(readFileSync(join(REPO_ROOT, 'legal/licenses/Apache-2.0.txt'), 'utf8'));
    expect(bodies.get(keys.archive)).toBe('archive bytes');
  });

  it('writes nothing when a notice is missing', async () => {
    const { bucket, calls } = fakeBucket(null);
    await expect(
      mirror.syncCatalogue(
        { ...catalogue, models: [{ ...first, installDir: 'no-such-model' }] },
        {
          publicUrl: 'https://cdn.example',
          bucket,
          scratch: scratch(),
          log: quiet,
          download: async () => {},
          verify: async () => {},
        },
      ),
    ).rejects.toThrow(/ENOENT/);
    expect(calls.heads).toEqual([]);
    expect(calls.puts).toEqual([]);
  });

  it('refuses a catalogue whose mirror this bucket does not serve, before touching it', async () => {
    const { bucket, calls } = fakeBucket(null);
    await expect(
      mirror.syncCatalogue(catalogue, {
        publicUrl: 'https://updates.speakingglass.com',
        bucket,
        scratch: scratch(),
        log: quiet,
        download: async () => {},
      }),
    ).rejects.toThrow(/not served from/);
    expect(calls.puts).toEqual([]);
  });

  it('does nothing for a catalogue with no mirror', async () => {
    const { bucket, calls } = fakeBucket(null);
    await mirror.syncCatalogue(
      { ...catalogue, mirrorBaseUrl: null },
      { publicUrl: 'https://cdn.example', bucket, scratch: scratch(), log: quiet, download: async () => {} },
    );
    expect(calls.heads).toEqual([]);
  });

  it('verifies every model at its client URL, whatever origin the bucket is published under', async () => {
    const seen: Array<{ at: string; attempts: number }> = [];
    await mirror.verifyCatalogue(catalogue, {
      log: quiet,
      attempts: 3,
      verify: async (at: string, _expected: unknown, options: { attempts: number }) => {
        seen.push({ at, attempts: options.attempts });
      },
    });
    expect(seen).toEqual(
      [first, second].map((model) => ({ at: mirror.mirrorUrl(catalogue.mirrorBaseUrl, model), attempts: 3 })),
    );
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

  it('asks for exactly the key, in exactly the bucket', () => {
    const { bucket, seen } = bucketAnswering({ status: 0, stdout: '{"ContentLength": 1}' });
    bucket.head('models/sha256/ab/x.tar.bz2');
    expect(seen[0]).toEqual([
      's3api', 'head-object', '--bucket', 'speaking-glass', '--key', 'models/sha256/ab/x.tar.bz2',
      '--endpoint-url', 'https://account.r2.example', '--output', 'json',
    ]);
  });

  it('does not mistake an access failure for an absent key', () => {
    const { bucket } = bucketAnswering({ status: 254, stderr: 'An error occurred (403) when calling the HeadObject operation: Forbidden' });
    expect(() => bucket.head('k')).toThrow(/403/);
  });

  it('does not mistake a connection failure that mentions 404 for an absent key', () => {
    const { bucket } = bucketAnswering({
      status: 255,
      stderr: 'Could not connect to the endpoint URL: "https://account.r2.example:404/k"',
    });
    expect(() => bucket.head('k')).toThrow(/Could not connect/);
  });

  it('writes an archive only if the key is absent, and reports losing the race', () => {
    const { bucket, seen } = bucketAnswering({
      status: 254,
      stderr: 'An error occurred (PreconditionFailed) when calling the PutObject operation',
    });
    expect(bucket.put('k', '/f', { contentType: 'a', cacheControl: 'c', ifAbsent: true })).toBe('exists');
    expect(seen[0]).toEqual([
      's3api', 'put-object', '--bucket', 'speaking-glass', '--key', 'k', '--body', '/f',
      '--content-type', 'a', '--cache-control', 'c', '--if-none-match', '*',
      '--endpoint-url', 'https://account.r2.example', '--output', 'json',
    ]);
    // An unconditional write that fails the same way is a failure, not a race.
    expect(() => bucket.put('k', '/f', { contentType: 'a', cacheControl: 'c' })).toThrow(/put-object/);
  });

  it('reports a successful write as created', () => {
    const { bucket } = bucketAnswering({ status: 0, stdout: '{}' });
    expect(bucket.put('k', '/f', { contentType: 'a', cacheControl: 'c', ifAbsent: true })).toBe('created');
  });

  it('needs both the endpoint and the bucket', () => {
    expect(() => mirror.awsBucket({ endpoint: '', bucket: 'b' })).toThrow(/R2_ENDPOINT/);
    expect(() => mirror.awsBucket({ endpoint: 'https://e', bucket: '' })).toThrow(/R2_BUCKET/);
  });
});
