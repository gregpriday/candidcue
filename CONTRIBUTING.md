# Contributing to Speaking Glass

Thanks for helping. Speaking Glass is free and open source under the
[MIT licence](LICENSE); by opening a pull request you agree to license your
contribution the same way.

## Reporting problems

- **Bugs and questions** go to
  [GitHub Issues](https://github.com/gregpriday/candidcue/issues) (the app's
  **Help › Report a Problem** opens GitHub's new-issue form in your browser).
  Include the version (About Speaking Glass), your operating system, your
  microphone and display setup, and what the prompter actually did.
- **Security issues** never go in a public issue. Follow
  [`.github/SECURITY.md`](.github/SECURITY.md).

## Setting up

The [README](README.md#building-from-source) has the build steps for macOS,
Windows and Linux. In short: Node 26.4 (`.nvmrc`), pnpm 10 (the exact version is
`packageManager` in `package.json`), and the Rust toolchain pinned in
`rust-toolchain.toml`, then:

```bash
pnpm install
pnpm dev
```

Two things are easy to miss:

- **Git LFS.** The captured benchmark runs (`events.jsonl` and `gold.json`
  under `bench/runs*/`) are in Git LFS. Without `git lfs pull` they are small
  pointer files, and a benchmark replay stops with an error naming one.
- **Playwright browsers.** Run `pnpm exec playwright install chromium` once
  before `pnpm test:e2e` (on Linux, add `--with-deps` for the system
  libraries).

The speech model is not in the repository. Install it from the app
(**Settings › Speech**), or fetch it from the command line as the README
describes.

## Making a change

The project uses gitflow. Branch from `develop` (`feature/…` or `bugfix/…`) and
open the pull request against `develop`. `main` moves only when a release is
cut.

Code style: TypeScript is strict; single quotes, semicolons, trailing commas,
two-space indentation, no Prettier. Name components `PascalCase.svelte`, most
other modules in kebab-case, and functions and variables in `camelCase`. Rust
is four-space `snake_case`. Please don't run `cargo fmt` across the tree: it
predates it, and the result would rewrite unrelated files.

Commit subjects follow the conventional form already in the history:
`feat(stage): …`, `fix(audio): …`, `test(control): …`, with an imperative
subject. Keep each commit focused.

Never commit recordings that contain sensitive speech, or a local application
database. Recognition stays on-device and the webviews' CSP allows no remote
host; a change should keep both that way.

## Testing

Run the narrowest tests that cover your change first, then the wider ones:

```bash
pnpm check                    # svelte-check, the authoritative typecheck
pnpm test                     # unit and integration tests (node)
pnpm test:dom                 # component tests (jsdom)
pnpm test:e2e                 # browser journeys (Playwright)
cargo test --manifest-path src-tauri/Cargo.toml  # the app's Rust core
cargo test --manifest-path crates/Cargo.toml     # engine, recogniser, benchmarks
```

Vitest files are `*.test.ts` and Playwright specs `*.spec.ts`. A single file
runs with `./node_modules/.bin/vitest run path/to/file.test.ts` (use the local
binary, not `npx vitest`); a file under `tests/dom/` needs
`--config vitest.dom.config.ts` as well. A single Playwright spec runs with
`./node_modules/.bin/playwright test --config=playwright.config.ts <spec>`;
`pnpm test:e2e -- <spec>` runs the whole suite. Playwright reuses a dev server
already listening on its port (1420 by default), so if another checkout's
server is running there, set `SPEAKING_GLASS_E2E_PORT` to a free port or the
suite tests that checkout instead of yours. Add regression coverage next to
the module you changed.

The browser journeys run the real frontend against the Vite dev server, not the
packaged app, and nothing in the suite drives a real microphone through a full
take. A change that touches the live follow loop (recognition, alignment,
motion) also needs a take read aloud with a real microphone, and
[`docs/real-rig-test-protocol.md`](docs/real-rig-test-protocol.md) is the
checklist for one on a prompter rig. [`bench/README.md`](bench/README.md)
explains the alignment benchmarks, which are how a change to the engine is
measured.

## Pull requests

- Explain the effect a user would notice, and link the issue it resolves.
- List what you ran to verify it.
- Include a screenshot or a short recording for a visible UI change.
- Say what the tests cannot show: hardware, a real prompter, the packaged app,
  network behaviour, or an operating system you could not try.

[`CLAUDE.md`](CLAUDE.md) holds the detailed architecture notes, written for
coding agents but just as useful to people.
