#!/usr/bin/env node
/**
 * Are the credentials a release needs actually there?
 *
 * Every release credential is a repository (or environment) secret the owner
 * adds by hand, and GitHub hands a workflow an EMPTY STRING for a secret that
 * does not exist. Nothing refuses that by itself: an empty
 * `APPLE_SIGNING_IDENTITY` surfaces as a codesign error at the end of a cold
 * universal build, an empty `APPLE_API_ISSUER` as a notarytool rejection, an
 * empty R2 key as an S3 error halfway through a publish. Each of those names
 * the tool that tripped, never the secret that is missing, and arrives an hour
 * after the run started.
 *
 * So each release workflow asks first, by NAME, and fails before anything is
 * built (or, for R2, before anything is published), listing every missing
 * secret at once:
 *
 *   node scripts/release-credentials.mjs build macos|windows|linux
 *   node scripts/release-credentials.mjs publish
 *
 * The workflow passes each secret through `env:` under its own repository
 * name. This script never prints a value — only names, and whether each is
 * present. Present is nearly all it can establish: whether a certificate
 * imports, a key signs or a bucket accepts a write is for the step that uses
 * it. The one exception is the SHAPE of `APPLE_SIGNING_IDENTITY` (see
 * `FORMATS`), because the wrong shape does not fail at all: it signs.
 *
 * A missing credential is a failure in every run that reaches this, dry runs
 * included. There is deliberately no unsigned fallback: a dry run exists to
 * prove the signing and notarisation a release depends on, and CI already
 * builds the unsigned macOS `.app`, Windows installer and Linux packages
 * (`ci.yml`).
 *
 * R2 is checked by the publish job and not by the gates, because publishing is
 * the only job that names a GitHub Environment (`release-stable` /
 * `release-prerelease`). Secrets kept on that environment are invisible to
 * every other job, so a gate there would call a correctly configured release
 * "missing". Checking where they are used also covers re-running only a failed
 * publish job, which never runs the gates again.
 */

import { appendFileSync } from 'node:fs';

/**
 * The secrets each check requires, by the name the owner gives them in the
 * repository settings. `release-gates.test.ts` holds each workflow's mapping
 * to exactly these lists.
 */
export const REQUIRED = {
  build: {
    macos: [
      'APPLE_CERTIFICATE',
      'APPLE_CERTIFICATE_PASSWORD',
      'APPLE_SIGNING_IDENTITY',
      'APPLE_API_KEY',
      'APPLE_API_KEY_ID',
      'APPLE_API_ISSUER',
      'TAURI_SIGNING_PRIVATE_KEY',
    ],
    windows: ['TAURI_SIGNING_PRIVATE_KEY'],
    linux: ['TAURI_SIGNING_PRIVATE_KEY'],
  },
  publish: ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ENDPOINT', 'SPEAKING_GLASS_R2_BUCKET'],
};

/*
 * Not checked, on purpose: `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is empty for
 * a key generated without one, which Tauri accepts. A wrong password fails
 * the signing itself, and `release-feed.mjs stage` verifies the signature
 * against the key the app ships with.
 */

/**
 * `Developer ID Application: <name> (<TEAM ID>)`, and nothing else.
 *
 * The identity is the one credential whose wrong value does not fail. Tauri
 * hands it straight to `codesign --sign`, so:
 *
 *   `-`                         is codesign's ad-hoc identity: the build
 *                               signs ad hoc and succeeds, the very failure
 *                               #189 is about, now with a green tick;
 *   `Apple Development: …`,     sign happily and are refused by notarisation
 *   `Apple Distribution: …`,    (or, for the Mac App Store identities, by
 *   `3rd Party Mac Developer…`  Gatekeeper) after the universal build;
 *   a certificate's SHA-1       signs correctly, but names no Team ID, and
 *                               `verify-signed-bundle.mjs` binds the signed
 *                               bundle to the team named here.
 *
 * A Team ID is ten upper-case letters and digits. The whole string must
 * match, so a value pasted with a trailing newline is refused here rather
 * than by `codesign` failing to find an identity with a newline in its name.
 * `verify-signed-bundle.mjs` reads the Team ID out of the same pattern.
 */
export const DEVELOPER_ID_IDENTITY = /^Developer ID Application: \S(?:.*\S)? \(([A-Z0-9]{10})\)$/;

/**
 * Secrets whose value must also have a shape, checked only once present.
 * `describe` is what the failure says the value should look like; the value
 * itself is never printed.
 */
export const FORMATS = {
  APPLE_SIGNING_IDENTITY: {
    pattern: DEVELOPER_ID_IDENTITY,
    describe:
      'the full "Developer ID Application: <name> (<TEAM ID>)" name of the certificate, exactly as ' +
      '`security find-identity -p codesigning` prints it ("-" signs ad hoc, an Apple Development or ' +
      'Mac App Store identity cannot be notarised for direct download, and a SHA-1 hash names no Team ID)',
  },
};

/** The present names in `names` whose value does not have its declared shape. */
export function malformed(names, env) {
  return names.filter((name) => {
    const format = FORMATS[name];
    const value = env[name] ?? '';
    return format !== undefined && value.trim() !== '' && !format.pattern.test(value);
  });
}

const RUNBOOK = 'docs/release-runbook.md';

/** The names in `required` that are unset, empty or only whitespace in `env`. */
export function missing(required, env) {
  return required.filter((name) => (env[name] ?? '').trim() === '');
}

function requiredFor(argv) {
  const [kind, os, ...rest] = argv;
  if (kind === 'build' && Object.hasOwn(REQUIRED.build, os ?? '') && rest.length === 0) {
    return {
      label: `the ${os} build`,
      names: REQUIRED.build[os],
      where: 'the repository settings',
      after: 'This build attempt stopped before building anything.',
    };
  }
  if (kind === 'publish' && os === undefined) {
    return {
      label: 'publishing',
      names: REQUIRED.publish,
      where: 'the repository settings or the release environment',
      after: 'This publish attempt stopped before writing anything; once the secrets are added, re-run only this publish job.',
    };
  }
  return undefined;
}

function main(argv, env) {
  const wanted = requiredFor(argv);
  if (!wanted) {
    console.error(
      `Usage: node scripts/release-credentials.mjs build <${Object.keys(REQUIRED.build).join('|')}>\n` +
        '       node scripts/release-credentials.mjs publish',
    );
    return 2;
  }

  const absent = missing(wanted.names, env);
  const invalid = malformed(wanted.names, env);
  const status = (name) => (absent.includes(name) ? 'MISSING' : invalid.includes(name) ? 'INVALID' : 'present');
  for (const name of wanted.names) {
    console.log(`  ${status(name)}  ${name}`);
  }

  if (env.GITHUB_STEP_SUMMARY) {
    const cell = (name) => (status(name) === 'present' ? 'present' : `**${status(name).toLowerCase()}**`);
    const rows = wanted.names.map((name) => `| \`${name}\` | ${cell(name)} |`);
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      [`### Credentials for ${wanted.label}`, '', '| Secret | |', '|---|---|', ...rows, '', ''].join('\n'),
    );
  }

  if (absent.length > 0) {
    console.error(
      `::error title=Missing release credentials::${wanted.label} needs ${absent.length === 1 ? 'a secret that is' : `${absent.length} secrets that are`} ` +
        `not set: ${absent.join(', ')}. Add ${absent.length === 1 ? 'it' : 'them'} in ${wanted.where} ` +
        `(${RUNBOOK} lists what each holds). ${wanted.after}`,
    );
  }
  for (const name of invalid) {
    console.error(
      `::error title=Malformed release credential::${name} is set, but not to ${FORMATS[name].describe}. ` +
        `Correct it in ${wanted.where} (${RUNBOOK} lists what each holds). ${wanted.after}`,
    );
  }
  if (absent.length > 0 || invalid.length > 0) return 1;
  console.log(`\nEvery credential ${wanted.label} needs is present.`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
