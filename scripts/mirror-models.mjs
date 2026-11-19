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
 * hostname serves — a 404 cached at the edge before the upload can outlive it
 * by minutes — so each archive is fetched back from the URL a client uses and
 * hashed in full before the run passes, retrying past that cache's lifetime.
 * A length match is not enough: a same-length object of the wrong bytes is
 * exactly what a mirror must never get away with.
 *
 *   node scripts/mirror-models.mjs sync     upload what is missing, then verify
 *   node scripts/mirror-models.mjs verify   verify only; needs no credentials
 *
 * The release pipeline runs `verify` before it publishes anything, so a build
 * whose catalogue names a mirror that does not serve its archive never ships.
 *
 * `sync` reads the bucket through the aws CLI with `R2_ENDPOINT`, `R2_BUCKET`
 * and the usual `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, and
 * `SPEAKING_GLASS_PUBLIC_URL` names the origin that bucket is served from.
 * `SPEAKING_GLASS_MODEL_CATALOGUE` overrides the catalogue path.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CATALOGUE = join(ROOT, 'src-tauri', 'models', 'catalogue.json');
export const DEFAULT_PUBLIC_URL = 'https://updates.speakingglass.com';

const SHA256_RE = /^[0-9a-f]{64}$/;
const SPDX_RE = /^[A-Za-z0-9.-]+$/;
/*
 * Archive names and the mirror prefix become both an object key and a URL
 * path. Only characters that mean the same thing in both are allowed: a `#`,
 * `?` or `%` would be written into the key literally and then read by a client
 * as a fragment, a query or an escape, and the two would name different
 * objects.
 */
const URL_SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const URL_SAFE_PATH_RE = /^[A-Za-z0-9._~/-]*$/;
const ARCHIVE_CONTENT_TYPE = 'application/x-bzip2';
const IMMUTABLE = 'public, max-age=31536000, immutable';
// The notices may be reworded with the catalogue; an hour keeps a fix visible.
const NOTICE_CACHE = 'public, max-age=3600';
const FETCH_TIMEOUT_MS = 10 * 60_000;
/*
 * Cloudflare caches a 404 for three minutes by default. A lookup that lands
 * just before the upload can keep the public URL answering 404 for that long,
 * so the read-back keeps trying for longer than that: 8 tries, 30 s apart.
 */
const READ_BACK_ATTEMPTS = 8;
const READ_BACK_DELAY_MS = 30_000;

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
  if (!URL_SAFE_PATH_RE.test(basePath)) {
    throw new Error(`mirrorBaseUrl ${mirrorBaseUrl} has a path a bucket key cannot spell the same way`);
  }
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
  if (typeof id !== 'string' || !URL_SAFE_NAME_RE.test(id)) {
    throw new Error(`model id ${JSON.stringify(id)} is not a safe name`);
  }
  if (typeof model.installDir !== 'string' || !URL_SAFE_NAME_RE.test(model.installDir)) {
    throw new Error(`${id}: installDir is not a safe name`);
  }
  const archive = model.archive ?? {};
  if (typeof archive.fileName !== 'string' || !URL_SAFE_NAME_RE.test(archive.fileName)) {
    throw new Error(`${id}: archive.fileName ${JSON.stringify(archive.fileName)} is not a URL-safe name`);
  }
  if (!SHA256_RE.test(archive.sha256 ?? '')) throw new Error(`${id}: archive.sha256 is not a digest`);
  if (!Number.isSafeInteger(archive.bytes) || archive.bytes <= 0) {
    throw new Error(`${id}: archive.bytes must be a positive integer`);
  }
  httpsUrl(archive.upstreamUrl, `${id}: archive.upstreamUrl`);
  const licenseId = model.attribution?.license?.id;
  if (typeof licenseId !== 'string' || !SPDX_RE.test(licenseId)) {
    throw new Error(`${id}: licence id ${JSON.stringify(licenseId)} is not a bare SPDX id`);
  }
  // The notices share the archive's directory; an archive by either name
  // would be overwritten by its own notice after it was verified.
  if (archive.fileName === 'ATTRIBUTION.md' || archive.fileName === `LICENSE-${licenseId}.txt`) {
    throw new Error(`${id}: archive.fileName ${archive.fileName} collides with a notice beside it`);
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

/**
 * GET `url` and pass its body, hashed and bounded, to `sink` (or nowhere).
 *
 * A non-200 answer is returned with its body cancelled and nothing written.
 * The body runs through one `pipeline`, so an error anywhere — the network,
 * the byte ceiling, the file — rejects this call and closes everything, and
 * the timeout aborts the transfer rather than just the wait for headers.
 */
async function transfer(url, limit, sink, fetchFn, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`${url} took longer than ${timeoutMs} ms`)), timeoutMs);
  try {
    const response = await fetchFn(url, { redirect: 'follow', signal: controller.signal });
    // fetch follows a redirect from https to http; the app's hop policy
    // (`net::check_hop`) refuses one. Bytes the app would never accept must
    // not pass for a working mirror.
    const landed = response.url || url;
    if (url.startsWith('https:') && !landed.startsWith('https:')) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`${url} redirected to ${landed}, which is not https`);
    }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel().catch(() => {});
      return { status: response.status };
    }
    const hash = createHash('sha256');
    let bytes = 0;
    const meter = new Transform({
      transform(chunk, _encoding, done) {
        bytes += chunk.length;
        if (bytes > limit) {
          done(new Error(`body exceeded the catalogue's ${limit} bytes`));
          return;
        }
        hash.update(chunk);
        done(null, sink ? chunk : undefined);
      },
    });
    const stages = [Readable.fromWeb(response.body), meter];
    if (sink) stages.push(sink());
    else stages.push(async function* drain(source) {
      for await (const _ of source);
    });
    await pipeline(...stages, { signal: controller.signal });
    return { status: 200, sha256: hash.digest('hex'), bytes };
  } catch (error) {
    // An abort surfaces as a bare AbortError; the reason says it was the timeout.
    throw controller.signal.aborted ? controller.signal.reason : error;
  } finally {
    clearTimeout(timer);
  }
}

/** GET a URL, hash its body, and report what it served. Never reads past `limit`. */
export async function readBack(url, limit, { fetchFn = fetch, timeoutMs } = {}) {
  return transfer(url, limit, null, fetchFn, timeoutMs);
}

/**
 * Download `url` to `dest`, refusing anything that is not exactly the pinned
 * bytes. The file is not created for an error answer, and is removed when the
 * bytes are refused.
 */
export async function downloadVerified(url, dest, expected, { fetchFn = fetch } = {}) {
  let got;
  try {
    got = await transfer(url, expected.bytes, () => createWriteStream(dest), fetchFn);
  } catch (error) {
    rmSync(dest, { force: true });
    throw error;
  }
  let problem = '';
  if (got.status !== 200) problem = `upstream answered HTTP ${got.status}`;
  else if (got.bytes !== expected.bytes) problem = `upstream sent ${got.bytes} bytes, the catalogue pins ${expected.bytes}`;
  else if (got.sha256 !== expected.sha256) problem = `upstream sent sha256 ${got.sha256}, the catalogue pins ${expected.sha256}`;
  if (problem) {
    rmSync(dest, { force: true });
    throw new Error(problem);
  }
}

/* ----------------------------------------------------------------- the bucket */

/*
 * The aws CLI exits 254 when the service answered with an error, and prints
 * `An error occurred (<Code>) when calling the <Operation> operation`. Only
 * that shape, for that operation, is read as an answer: a connection failure
 * whose message happens to contain `404` is not "the object is absent".
 */
function serviceError(result, operation) {
  if (result.status !== 254) return null;
  const match = /An error occurred \(([A-Za-z0-9]+)\) when calling the (\w+) operation/.exec(result.stderr);
  return match && match[2] === operation ? match[1] : null;
}

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
      if (['404', 'NotFound', 'NoSuchKey'].includes(serviceError(result, 'HeadObject'))) return null;
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
      if (ifAbsent && ['412', 'PreconditionFailed'].includes(serviceError(result, 'PutObject'))) {
        return 'exists';
      }
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
export async function verifyArchive(
  url,
  expected,
  { read = readBack, attempts = READ_BACK_ATTEMPTS, delayMs = READ_BACK_DELAY_MS, log = console.log } = {},
) {
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

/**
 * Put the notice and licence beside the archive. Small, rewritten every run,
 * and written BEFORE the archive, so the archive is never public without them.
 */
export function syncNotices(model, { bucket, keys, root = ROOT }) {
  const attribution = join(root, 'src-tauri', 'models', model.installDir, 'ATTRIBUTION.md');
  const license = join(root, 'legal', 'licenses', `${model.attribution.license.id}.txt`);
  // Read both first: a missing notice must fail the run before either goes up.
  readFileSync(attribution);
  readFileSync(license);
  bucket.put(keys.attribution, attribution, {
    contentType: 'text/markdown; charset=utf-8',
    cacheControl: NOTICE_CACHE,
  });
  bucket.put(keys.license, license, { contentType: 'text/plain; charset=utf-8', cacheControl: NOTICE_CACHE });
}

/** `sync` over a whole catalogue: per model, the notices, then the archive. */
export async function syncCatalogue(catalogue, { publicUrl, bucket, download, scratch, root = ROOT, log = console.log, verify = verifyArchive }) {
  if (!catalogue.mirrorBaseUrl) {
    log('The catalogue names no mirror; nothing to do.');
    return;
  }
  const prefix = mirrorPrefix(catalogue.mirrorBaseUrl, publicUrl);
  for (const model of catalogue.models) {
    log(model.id);
    const keys = mirrorKeys(prefix, model);
    syncNotices(model, { bucket, keys, root });
    await syncModel(model, { bucket, keys, url: mirrorUrl(catalogue.mirrorBaseUrl, model), download, scratch, log, verify });
  }
}

/**
 * `verify` over a whole catalogue. Needs no credentials, and no bucket: it
 * asks the URL a client asks, wherever that is served from. Retried as long
 * as `sync`'s read-back, so a 404 the runner's edge cached just before the
 * seed cannot fail a release whose mirror is fine.
 */
export async function verifyCatalogue(catalogue, { log = console.log, verify = verifyArchive, attempts = READ_BACK_ATTEMPTS } = {}) {
  if (!catalogue.mirrorBaseUrl) {
    log('The catalogue names no mirror; nothing to verify.');
    return;
  }
  httpsUrl(catalogue.mirrorBaseUrl, 'mirrorBaseUrl');
  for (const model of catalogue.models) {
    log(model.id);
    await verify(mirrorUrl(catalogue.mirrorBaseUrl, model), model.archive, { log, attempts });
  }
}

async function main([command]) {
  const catalogue = loadCatalogue();
  if (command === 'verify') {
    await verifyCatalogue(catalogue);
    return;
  }
  if (command !== 'sync') throw new Error('usage: mirror-models.mjs sync|verify');
  if (!catalogue.mirrorBaseUrl) {
    console.log('The catalogue names no mirror; nothing to do.');
    return;
  }
  const publicUrl = process.env.SPEAKING_GLASS_PUBLIC_URL || DEFAULT_PUBLIC_URL;

  const bucket = awsBucket({ endpoint: process.env.R2_ENDPOINT, bucket: process.env.R2_BUCKET });
  const scratch = mkdtempSync(join(tmpdir(), 'mirror-models-'));
  try {
    await syncCatalogue(catalogue, { publicUrl, bucket, download: downloadVerified, scratch });
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
