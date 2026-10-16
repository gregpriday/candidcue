#!/usr/bin/env node
/**
 * The one command a release runs. CI runs the same one.
 *
 * The 1.0 readiness review's complaint was not that the project has no tests —
 * it has thousands — but that "we ran the tests" meant a different subset every
 * time, chosen by whoever was at the keyboard, with no artifact proving which.
 * A release cannot be assembled by skipping a red suite if there is only one
 * definition of the suite.
 *
 * Usage:
 *   node scripts/release-verify.mjs                 — everything
 *   node scripts/release-verify.mjs --tier=fast     — the gates only (seconds)
 *   node scripts/release-verify.mjs --tier=code     — gates + typecheck + tests
 *   node scripts/release-verify.mjs --only=typecheck,node tests
 *   node scripts/release-verify.mjs --list          — print the plan and exit
 *
 * ## `--only` is how CI stays honest
 *
 * CI wants to run these steps in parallel jobs; this script runs them in one
 * ordered pass. Left alone, that means CI hand-copies each command and the two
 * definitions drift — which is the exact failure this file claims to prevent.
 *
 * So CI names steps out of THIS plan with `--only=`, and
 * `tests/integration/release-gates.test.ts` asserts that every step in the plan
 * is claimed by some CI job. A step added here without a home in CI fails a
 * test rather than quietly never running.
 *
 * ## The one step CI does not run
 *
 * `native licence review` is marked `releaseOnly`. It refuses while any
 * statically linked native component in `sbom/native-components.json` is
 * unreviewed — a fact only a person can settle, which should block a release
 * and should not redden every push. Nothing here treats the flag specially:
 * the step is `full` tier, so a bare run (which is what a tagged release does)
 * reaches it, and CI never names it in an `--only=` list. The flag exists so
 * the parity test can tell that deliberate exception from a step somebody
 * forgot to give a home, and so it can assert CI keeps not naming it.
 *
 * ## What is NOT here
 *
 * Signing, notarisation, stapling and the artifact inspection that follows them
 * need credentials this script must never assume, so they live in a separate
 * release workflow. This produces the evidence that the CODE is releasable;
 * that workflow produces the evidence that the ARTIFACT is.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Ordered cheapest-first inside each tier, so a broken checkout fails in
 * seconds rather than after a Rust build.
 *
 * `tier` is a floor: `fast` steps run in every tier.
 */
const STEPS = [
  {
    tier: 'fast',
    name: 'repository completeness',
    command: ['node', ['scripts/verify-repository.mjs']],
    proves: 'every referenced input exists in this checkout',
  },
  {
    tier: 'fast',
    name: 'version sync',
    command: ['node', ['scripts/version.mjs', 'check']],
    proves: 'package.json, Cargo.toml, tauri.conf.json and version.ts agree',
  },
  {
    // Full tier, but listed here rather than with the other full steps: the
    // tier filter keeps the array's order, so a full run that is going to stop
    // on an unreviewed licence stops in a second, not after a Rust build.
    tier: 'full',
    name: 'native licence review',
    command: ['node', ['scripts/verify-native-review.mjs']],
    proves: 'every statically linked native component has a confirmed licence',
    releaseOnly: true,
  },
  {
    tier: 'code',
    name: 'typecheck',
    command: ['pnpm', ['exec', 'svelte-check', '--tsconfig', './tsconfig.json']],
    proves: 'the frontend typechecks under the authoritative checker',
  },
  {
    tier: 'code',
    name: 'node tests',
    command: ['pnpm', ['exec', 'vitest', 'run']],
    proves: 'shared logic, contracts, stores and services',
  },
  {
    tier: 'code',
    name: 'dom tests',
    command: ['pnpm', ['exec', 'vitest', 'run', '--config', 'vitest.dom.config.ts']],
    proves: 'focus management and stage-renderer components',
  },
  {
    tier: 'code',
    name: 'rust tests (app)',
    command: ['cargo', ['test', '--locked', '--manifest-path', 'src-tauri/Cargo.toml']],
    proves: 'ACL, IPC contracts, persistence, lifecycle, stage handshake',
  },
  {
    tier: 'code',
    name: 'rust tests (alignment)',
    command: ['cargo', ['test', '--locked', '--manifest-path', 'crates/Cargo.toml']],
    proves: 'the deterministic alignment engine and the STT protocol',
  },
  {
    tier: 'full',
    name: 'clippy (app)',
    command: [
      'cargo',
      ['clippy', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--all-targets', '--', '-D', 'warnings'],
    ],
    proves: 'no new lint regressions in the app workspace',
  },
  {
    tier: 'full',
    name: 'clippy (alignment)',
    command: [
      'cargo',
      ['clippy', '--locked', '--manifest-path', 'crates/Cargo.toml', '--all-targets', '--', '-D', 'warnings'],
    ],
    proves: 'no new lint regressions in the alignment workspace',
  },
  {
    tier: 'full',
    name: 'browser journeys',
    command: ['pnpm', ['exec', 'playwright', 'test', '--config=playwright.config.ts']],
    proves: 'routes, stores and IPC payloads through the real frontend',
  },
  {
    tier: 'full',
    name: 'production frontend build',
    command: ['pnpm', ['exec', 'vite', 'build']],
    proves: 'the three entry points bundle',
  },
  {
    tier: 'full',
    name: 'supply chain',
    command: ['node', ['scripts/verify-supply-chain.mjs', 'licences']],
    proves: 'no production dependency is under an unreviewed licence',
  },
  {
    tier: 'full',
    name: 'third-party notices',
    command: ['node', ['scripts/generate-notices.mjs', '--check']],
    proves: 'the licence disclosure in the bundle still matches the dependency graph',
    // Committed generated output, so it goes stale silently — and a stale
    // licence disclosure is a wrong one, shipped inside the artifact.
  },
  {
    tier: 'full',
    name: 'no model weights',
    command: ['node', ['scripts/verify-no-model-weights.mjs']],
    proves: 'the bundle configuration declares no speech-model payload',
    // The configuration half only. Walking a BUILT `.app` needs one to exist,
    // so the release and CI bundle jobs pass the path as an argument.
  },
];

const TIER_ORDER = ['fast', 'code', 'full'];

/** Exported shape for the CI-parity test — the plan, without running it. */
export const PLAN = STEPS.map(({ tier, name, proves, releaseOnly = false }) => ({
  tier,
  name,
  proves,
  releaseOnly,
}));

/*
 * Importing this module for `PLAN` must not run anything.
 *
 * `import.meta.main` is the standard test and is available on the pinned Node.
 * A filename-suffix check was here first and got it wrong in both directions:
 * it missed a run through a differently named symlink, and it fired when the
 * module was imported by any entry point whose own name happened to end in
 * `release-verify.mjs`.
 */
if (import.meta.main) main();

function main() {
  const args = process.argv.slice(2);
  const tier = args.find((a) => a.startsWith('--tier='))?.slice('--tier='.length) ?? 'full';
  const only = args.find((a) => a.startsWith('--only='))?.slice('--only='.length);

  if (!TIER_ORDER.includes(tier)) {
    console.error(`Unknown tier "${tier}". Use one of: ${TIER_ORDER.join(', ')}.`);
    process.exit(1);
  }

  let plan = STEPS.filter((step) => TIER_ORDER.indexOf(step.tier) <= TIER_ORDER.indexOf(tier));

  if (only !== undefined) {
    if (tier !== 'full' && args.some((a) => a.startsWith('--tier='))) {
      // `--only` ignores the tier by design (CI selects exact steps), so
      // accepting both would print `--tier=fast` over a run containing a full
      // -tier step. Refusing is clearer than silently preferring one.
      console.error('--tier and --only cannot be combined: --only selects exact steps.');
      process.exit(1);
    }

    const wanted = only.split(',').map((name) => name.trim()).filter(Boolean);
    if (wanted.length === 0) {
      // `--only=` with nothing after it used to produce an empty plan, run
      // nothing, and print PASSED. A CI job that reports green having executed
      // zero steps is worse than one that fails.
      console.error('--only= was given no step names.');
      process.exit(1);
    }
    // An unknown name is an error, not an empty run. A CI job that silently
    // ran zero steps would report green for work it never did — the precise
    // failure `--only` was added to avoid.
    const unknown = wanted.filter((name) => !STEPS.some((step) => step.name === name));
    if (unknown.length > 0) {
      console.error(
        `Unknown step name(s): ${unknown.join(', ')}.\nThe plan is:\n` +
          STEPS.map((step) => `  ${step.name}`).join('\n'),
      );
      process.exit(1);
    }
    plan = STEPS.filter((step) => wanted.includes(step.name));
  }

  const label = only !== undefined ? `--only=${only}` : `--tier=${tier}`;

  // Independent of the branches above: whatever combination of flags got us
  // here, a plan of zero steps must never be reported as a successful run.
  if (plan.length === 0) {
    console.error(`release:verify ${label} selected no steps — refusing to report a green run.`);
    process.exit(1);
  }

  if (args.includes('--list')) {
    console.log(`release:verify ${label} runs ${plan.length} steps:\n`);
    for (const step of plan) console.log(`  ${step.name.padEnd(28)} ${step.proves}`);
    process.exit(0);
  }

  console.log(`release:verify ${label} — ${plan.length} steps\n`);

  const results = [];
  let hardFailure = false;

  for (const [index, step] of plan.entries()) {
    const [bin, argv] = step.command;
    process.stdout.write(`→ ${step.name}\n`);
    const started = process.hrtime.bigint();
    const run = spawnSync(bin, argv, { cwd: ROOT, stdio: 'inherit', shell: false });
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;

    const ok = run.status === 0;

    results.push({
      name: step.name,
      ok,
      seconds,
      status: run.status,
      signal: run.signal,
      error: run.error,
    });

    if (!ok) {
      hardFailure = true;
      // Everything after the first hard failure is recorded as NOT RUN rather
      // than omitted. An absent row reads as "fine" in a release record.
      for (const skipped of plan.slice(index + 1)) {
        results.push({ name: skipped.name, skipped: true });
      }
      // Stop here. Running the rest produces a wall of output in which the
      // thing that actually broke is no longer findable.
      break;
    }
  }

  console.log('\n─────────────────────────────────────────────');
  for (const result of results) {
    if (result.skipped) {
      console.log(`  NOT RUN     ${result.name.padEnd(28)} (an earlier step failed)`);
      continue;
    }
    const mark = result.ok ? 'PASS' : 'FAIL';
    console.log(`  ${mark.padEnd(11)} ${result.name.padEnd(28)} ${result.seconds.toFixed(1)}s`);
    if (!result.ok) {
      // Why it failed, in the summary itself. `spawnSync` reports a command
      // that could not start as `status: null` with an `error`, and a killed
      // process as `status: null` with a `signal` — both of which used to show
      // up here as an unexplained FAIL.
      if (result.error) console.log(`              could not run: ${result.error.message}`);
      else if (result.signal) console.log(`              killed by signal ${result.signal}`);
      else console.log(`              exit code ${result.status}`);
    }
  }

  if (hardFailure) {
    console.log('\nrelease:verify FAILED.');
    process.exit(1);
  }

  console.log('\nrelease:verify PASSED.');
}
