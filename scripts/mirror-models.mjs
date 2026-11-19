#!/usr/bin/env node
/**
 * Put every speech-model archive the catalogue pins on the mirror it names,
 * and prove the mirror serves it.
 *
 * The catalogue's upstream URLs all point into the `asr-models` release tag on
 * `k2-fsa/sherpa-onnx`, which is mutable. If upstream re-tags it or drops an
 * asset, the pinned SHA-256 refuses the bytes and every new install fails at
 * the model step. `mirrorBaseUrl` is the way through: the app and
 * `fetch-stt-model.sh` ask `<mirrorBaseUrl>/sha256/<digest>/<file>` first and
 * upstream second, hash-checking both. This script is what makes that first
 * URL answer.
 *
 * ## The layout under `<public url>/`
 *
 *   <prefix>/sha256/<digest>/<archive file>
 *       The archive, byte for byte as upstream published it. Content-addressed:
 *       the digest is in the key, so the object is written once, with
 *       `If-None-Match: *`, and served `immutable`. An object already there is
 *       never overwritten — one holding the wrong bytes is a fault to look at,
 *       not something a re-run should paper over.
 *
 *   <prefix>/sha256/<digest>/ATTRIBUTION.md, LICENSE-<spdx id>.txt
 *       The notice and licence that travel with the model. The archive ships
 *       no licence file of its own, and redistributing it (Apache-2.0 §4)
 *       means handing both on with it.
 *
 * `<prefix>` is the part of `mirrorBaseUrl` after the bucket's public origin
 * (`models` for `https://updates.speakingglass.com/models`), so the key written
 * is derived from the exact URL a client will ask for, not restated beside it.
 *
 * ## What counts as done
 *
 * Not the upload. R2 accepting an object says nothing about what the public
 * hostname serves — a cached 404 can outlive it — so each archive is fetched
 * back from the URL a client uses and hashed in full before the run passes.
 * A length match is not enough: a same-length object of the wrong bytes is
 * exactly what a mirror must never get away with.
 *
 *   node scripts/mirror-models.mjs sync     upload what is missing, then verify
 *   node scripts/mirror-models.mjs verify   verify only; needs no credentials
 *
 * `sync` reads the bucket through the aws CLI with `R2_ENDPOINT`, `R2_BUCKET`
 * and the usual `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`.
 * `SPEAKING_GLASS_PUBLIC_URL` names the origin the bucket is served from;
 * `SPEAKING_GLASS_MODEL_CATALOGUE` overrides the catalogue path.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CATALOGUE = join(ROOT, 'src-tauri', 'models', 'catalogue.json');
export const DEFAULT_PUBLIC_URL = 'https://updates.speakingglass.com';

const SHA256_RE = /^[0-9a-f]{64}$/;
const SPDX_RE = /^[A-Za-z0-9.-]+$/;
const ARCHIVE_CONTENT_TYPE = 'application/x-bzip2';
const IMMUTABLE = 'public, max-age=31536000, immutable';
// The notices may be reworded with the catalogue; an hour keeps a fix visible.
const NOTICE_CACHE = 'public, max-age=3600';
const FETCH_TIMEOUT_MS = 10 * 60_000;

/** A name that stays one path segment: no traversal, no separators, no controls. */
function isSafeName(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    !name.startsWith('.') &&
    !/[/\\\u0000-\u001f\u007f]/.test(name)
  );
}

function httpsUrl(value, where) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${where} is not a valid URL: ${JSON.stringify(value)}`);
  }
  if (url.protocol !== 'https:') throw new Error(`${where} must be https, got ${url.protocol}`);
  if (url.username || url.password) throw new Error(`${where} must not carry credentials`);
  if (url.search || url.hash) throw new Error(`${where} must not carry a query or fragment`);
  return url;
}

/**
 * The client URL for a model's archive on the mirror — the same string
 * `model_download.rs::archive_urls` and `model-catalogue.mjs::mirrorUrl` build.
 */
export function mirrorUrl(base, model) {
  return `${base.replace(/\/+$/, '')}/sha256/${model.archive.sha256}/${model.archive.fileName}`;
}

/**
 * The bucket key prefix the mirror base sits at, or a refusal when the base is
 * not served by this bucket's public origin.
 *
 * Compared as parsed URLs, not strings: `https://updates.example.com.evil/x`
 * starts with `https://updates.example.com` and must not count.
 */
export function mirrorPrefix(mirrorBaseUrl, publicUrl) {
  const base = httpsUrl(mirrorBaseUrl, 'mirrorBaseUrl');
  const origin = httpsUrl(publicUrl, 'the public URL');
  if (base.origin !== origin.origin) {
    throw new Error(
      `mirrorBaseUrl ${mirrorBaseUrl} is not served from ${publicUrl}; this bucket cannot fill it`,
    );
  }
  const strip = (path) => path.replace(/^\/+|\/+$/g, '');
  const originPath = strip(origin.pathname);
  const basePath = strip(base.pathname);
  if (originPath && basePath !== originPath && !basePath.startsWith(`${originPath}/`)) {
    throw new Error(`mirrorBaseUrl ${mirrorBaseUrl} is outside ${publicUrl}`);
  }
  // `new URL` has already resolved any dot segments, exactly as a client will.
  return originPath ? basePath.slice(originPath.length).replace(/^\/+/, '') : basePath;
}

/** Bucket keys for one model: the archive and the two notices beside it. */
export function mirrorKeys(prefix, model) {
  const dir = `${prefix ? `${prefix}/` : ''}sha256/${model.archive.sha256}`;
  return {
    archive: `${dir}/${model.archive.fileName}`,
    attribution: `${dir}/ATTRIBUTION.md`,
    license: `${dir}/LICENSE-${model.attribution.license.id}.txt`,
  };
}

/** The fields this script relies on, checked before any of them reach a key or a URL. */
export function checkModel(model) {
  const id = model?.id;
  if (!isSafeName(id)) throw new Error(`model id ${JSON.stringify(id)} is not a safe name`);
  if (!isSafeName(model.installDir)) throw new Error(`${id}: installDir is not a safe name`);
  const archive = model.archive ?? {};
  if (!isSafeName(archive.fileName)) throw new Error(`${id}: archive.fileName is not a safe name`);
  if (!SHA256_RE.test(archive.sha256 ?? '')) throw new Error(`${id}: archive.sha256 is not a digest`);
  if (!Number.isSafeInteger(archive.bytes) || archive.bytes <= 0) {
    throw new Error(`${id}: archive.bytes must be a positive integer`);
  }
  httpsUrl(archive.upstreamUrl, `${id}: archive.upstreamUrl`);
  const licenseId = model.attribution?.license?.id;
  if (typeof licenseId !== 'string' || !SPDX_RE.test(licenseId)) {
    throw new Error(`${id}: licence id ${JSON.stringify(licenseId)} is not a bare SPDX id`);
  }
  return model;
}

export function loadCatalogue(path = process.env.SPEAKING_GLASS_MODEL_CATALOGUE || DEFAULT_CATALOGUE) {
  const catalogue = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(catalogue.models) || catalogue.models.length === 0) {
    throw new Error(`${path} has no models`);
  }
  catalogue.models.forEach(checkModel);
  return catalogue;
}

/* ------------------------------------------------------------------ transfer */

async function fetchWithTimeout(url, fetchFn) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return { response: await fetchFn(url, { redirect: 'follow', signal: controller.signal }), timer };
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

/**
 * Read a response body, hashing it and refusing to read past `limit` bytes.
 * `sink` receives each chunk (a file write stream for a download, nothing for
 * a read-back).
 */
async function digestBody(response, limit, sink) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error(`body exceeded the catalogue's ${limit} bytes`);
    hash.update(chunk);
    if (sink && !sink.write(chunk)) await new Promise((done) => sink.once('drain', done));
  }
  return { sha256: hash.digest('hex'), bytes };
}

/** GET a URL, hash its body, and report what it served. Never reads past `limit`. */
export async function readBack(url, limit, { fetchFn = fetch } = {}) {
  const { response, timer } = await fetchWithTimeout(url, fetchFn);
  try {
    if (response.status !== 200) {
      await response.body?.cancel?.();
      return { status: response.status };
    }
    return { status: 200, ...(await digestBody(response, limit)) };
  } finally {
    clearTimeout(timer);
  }
}

/** Download `url` to `dest`, refusing anything that is not exactly the pinned bytes. */
export async function downloadVerified(url, dest, expected, { fetchFn = fetch } = {}) {
  const { response, timer } = await fetchWithTimeout(url, fetchFn);
  const out = createWriteStream(dest);
  try {
    if (response.status !== 200) throw new Error(`upstream answered HTTP ${response.status}`);
    const got = await digestBody(response, expected.bytes, out);
    if (got.bytes !== expected.bytes) {
      throw new Error(`upstream sent ${got.bytes} bytes, the catalogue pins ${expected.bytes}`);
    }
    if (got.sha256 !== expected.sha256) {
      throw new Error(`upstream sent sha256 ${got.sha256}, the catalogue pins ${expected.sha256}`);
    }
  } finally {
    clearTimeout(timer);
    await new Promise((done, fail) => out.end((error) => (error ? fail(error) : done())));
  }
}

/* ----------------------------------------------------------------- the bucket */

/**
 * The bucket, through the aws CLI as the release action already uses it.
 * Arguments go as an array — no shell ever sees a key.
 */
export function awsBucket({ endpoint, bucket, run = spawnSync } = {}) {
  if (!endpoint || !bucket) throw new Error('sync needs R2_ENDPOINT and R2_BUCKET');
  const aws = (args) => {
    const result = run('aws', [...args, '--endpoint-url', endpoint, '--output', 'json'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION || 'auto',
        // R2 needs no S3 request checksums; asking only when required keeps
        // every CLI version working (the release action sets the same).
        AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required',
        AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required',
      },
    });
    if (result.error) throw new Error(`aws could not run: ${result.error.message}`);
    return result;
  };
  return {
    /** `{ size }` for an object that exists, `null` for one that does not. */
    head(key) {
      const result = aws(['s3api', 'head-object', '--bucket', bucket, '--key', key]);
      if (result.status === 0) return { size: JSON.parse(result.stdout).ContentLength };
      if (/\b(404|Not Found|NoSuchKey)\b/.test(result.stderr)) return null;
      throw new Error(`head-object ${key} failed: ${result.stderr.trim()}`);
    },
    /**
     * Write an object. With `ifAbsent`, the write is conditional and reports
     * `'exists'` when another writer got there first (HTTP 412).
     */
    put(key, file, { contentType, cacheControl, ifAbsent = false }) {
      const args = ['s3api', 'put-object', '--bucket', bucket, '--key', key, '--body', file];
      args.push('--content-type', contentType, '--cache-control', cacheControl);
      if (ifAbsent) args.push('--if-none-match', '*');
      const result = aws(args);
      if (result.status === 0) return 'created';
      if (ifAbsent && /\b(412|PreconditionFailed)\b/.test(result.stderr)) return 'exists';
      throw new Error(`put-object ${key} failed: ${result.stderr.trim()}`);
    },
  };
}

/* --------------------------------------------------------------- the commands */

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * The client URL must serve exactly the pinned bytes. Retried, because a 404
 * the edge cached before the upload can outlive it for a while.
 */
export async function verifyArchive(url, expected, { read = readBack, attempts = 6, delayMs = 20_000, log = console.log } = {}) {
  let last = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const got = await read(url, expected.bytes);
      if (got.status !== 200) last = `HTTP ${got.status}`;
      else if (got.bytes !== expected.bytes) last = `served ${got.bytes} bytes, the catalogue pins ${expected.bytes}`;
      else if (got.sha256 !== expected.sha256) last = `served sha256 ${got.sha256}, the catalogue pins ${expected.sha256}`;
      else {
        log(`  verified ${url}`);
        return;
      }
    } catch (error) {
      last = error.message;
    }
    if (attempt < attempts) {
      log(`  ${url}: ${last}; retrying (${attempt}/${attempts})`);
      await sleep(delayMs);
    }
  }
  throw new Error(`${url} does not serve the pinned archive: ${last}`);
}

/**
 * Make one model's mirror object exist and hold the pinned bytes.
 *
 * Only an ABSENT key is ever written. A key that exists at the wrong size is
 * reported and left alone, and one at the right size is still judged by its
 * public read-back, which hashes every byte.
 */
export async function syncModel(model, { bucket, keys, url, download, scratch, log = console.log, verify = verifyArchive }) {
  const expected = { sha256: model.archive.sha256, bytes: model.archive.bytes };
  const existing = bucket.head(keys.archive);
  if (existing && existing.size !== expected.bytes) {
    throw new Error(
      `${keys.archive} already holds ${existing.size} bytes, the catalogue pins ${expected.bytes}. ` +
        'A content-addressed object is never overwritten; remove it by hand after looking at it.',
    );
  }
  if (!existing) {
    log(`  ${keys.archive} is missing; fetching ${model.archive.upstreamUrl}`);
    const file = join(scratch, model.archive.fileName);
    await download(model.archive.upstreamUrl, file, expected);
    const outcome = bucket.put(keys.archive, file, {
      contentType: ARCHIVE_CONTENT_TYPE,
      cacheControl: IMMUTABLE,
      ifAbsent: true,
    });
    log(outcome === 'created' ? `  uploaded ${keys.archive}` : `  ${keys.archive} appeared meanwhile; verifying it`);
    rmSync(file, { force: true });
  } else {
    log(`  ${keys.archive} is already on the bucket`);
  }
  await verify(url, expected, { log });
}

/** Put the notice and licence beside the archive. Small, rewritten every run. */
function syncNotices(model, { bucket, keys }) {
  const attribution = join(ROOT, 'src-tauri', 'models', model.installDir, 'ATTRIBUTION.md');
  const license = join(ROOT, 'legal', 'licenses', `${model.attribution.license.id}.txt`);
  // Read first: a missing notice must fail the run before anything goes up.
  readFileSync(attribution);
  readFileSync(license);
  bucket.put(keys.attribution, attribution, {
    contentType: 'text/markdown; charset=utf-8',
    cacheControl: NOTICE_CACHE,
  });
  bucket.put(keys.license, license, { contentType: 'text/plain; charset=utf-8', cacheControl: NOTICE_CACHE });
}

async function main([command]) {
  if (command !== 'sync' && command !== 'verify') {
    throw new Error('usage: mirror-models.mjs sync|verify');
  }
  const catalogue = loadCatalogue();
  if (!catalogue.mirrorBaseUrl) {
    console.log('The catalogue names no mirror; nothing to do.');
    return;
  }
  const publicUrl = process.env.SPEAKING_GLASS_PUBLIC_URL || DEFAULT_PUBLIC_URL;
  const prefix = mirrorPrefix(catalogue.mirrorBaseUrl, publicUrl);

  if (command === 'verify') {
    for (const model of catalogue.models) {
      console.log(model.id);
      await verifyArchive(mirrorUrl(catalogue.mirrorBaseUrl, model), model.archive, { attempts: 1 });
    }
    return;
  }

  const bucket = awsBucket({ endpoint: process.env.R2_ENDPOINT, bucket: process.env.R2_BUCKET });
  const scratch = mkdtempSync(join(tmpdir(), 'mirror-models-'));
  try {
    for (const model of catalogue.models) {
      console.log(model.id);
      const keys = mirrorKeys(prefix, model);
      await syncModel(model, {
        bucket,
        keys,
        url: mirrorUrl(catalogue.mirrorBaseUrl, model),
        download: downloadVerified,
        scratch,
      });
      syncNotices(model, { bucket, keys });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`::error::mirror-models: ${error.message}`);
    process.exit(1);
  });
}
