# Repository Guidelines

## Project Structure & Module Organization

- `src/control/` contains the Svelte editor, routes, stores, components, and services.
- `src/stage/` contains the presentation renderer and motion engine.
- `src/shared/` holds pure contracts, Markdown compilation, and alignment helpers; keep it free of I/O.
- `src/workers/` contains Web Workers; `assets/` contains bundled fonts.
- `src-tauri/` is the desktop core: IPC commands, SQLite migrations, on-device speech, and window management.
- `crates/` is a separate Rust workspace for `cc-align` and benchmark tooling; `bench/` stores benchmark inputs and reports.
- Tests live beside source and under `tests/{unit,dom,integration,e2e}`. Specifications live in `docs/`.

## Build, Test, and Development Commands

```bash
pnpm install              # install JavaScript dependencies
pnpm tauri dev            # run the two-window desktop app
pnpm build                # create the Vite production bundle
pnpm check                # authoritative Svelte/TypeScript validation
pnpm test                 # Node-based Vitest suite
pnpm test:dom             # jsdom component and accessibility tests
pnpm test:e2e             # Playwright browser journeys
cd src-tauri && cargo test
cd crates && cargo test   # standalone alignment/benchmark workspace
```

Use the pnpm version pinned in `package.json`. Run one test with `./node_modules/.bin/vitest run path/to/file.test.ts`. WebKit microphone tests require hardware; see `README.md`.

## Coding Style & Naming Conventions

TypeScript is strict. Use two-space indentation, single quotes, semicolons, and trailing commas. Name components `PascalCase.svelte`, most modules in kebab-case, and functions/variables in `camelCase`. Rust uses four-space indentation and `snake_case`. Do not run repository-wide `cargo fmt`; the older tree is not uniformly formatted.

## Testing Guidelines

Use Vitest for unit/integration tests, jsdom for components, Playwright for journeys, and Rust’s test harness. Name Vitest files `*.test.ts` and Playwright files `*.spec.ts`. Add regression coverage near the affected module. Run the narrowest suite first, then `pnpm check` and relevant broader suites. No coverage threshold is enforced.

## Branching (gitflow)

`develop` is the integration branch and the GitHub default. Branch `feature/*` and `bugfix/*` from `develop` and target pull requests at `develop`. `main` moves only on releases: `develop` is merged into `main` with a merge commit (never `--delete-branch`, which would delete `develop`), and a `v*` tag pushed from `main` triggers the three per-OS release workflows (`release-macos.yml`, `release-windows.yml`, `release-linux.yml`). See `docs/release-runbook.md`.

## Commit & Pull Request Guidelines

History uses subjects such as `feat(stage): ...`, `fix(audio): ...`, and `test(control): ...`. Keep commits focused, imperative, and scoped. Pull requests should explain the user-visible effect, link the issue, list verification, and include screenshots or recordings for UI changes. Call out hardware, network, or packaged-app behavior that browser tests cannot verify.

## Security & Configuration

Never commit recordings containing sensitive speech, or local databases. The app holds no API keys and makes no network speech calls — speech recognition is on-device; preserve that and the frontend CSP boundary. The ~161 MB model is fetched, not committed (`pnpm models:fetch`).
