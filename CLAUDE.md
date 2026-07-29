# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A voice-following teleprompter. You write Markdown in the **control** window; it
renders on a second display in the **stage** window; Grok (xAI) transcribes your
speech; a deterministic Rust engine decides where in the script you are and
scrolls the stage to match. Nothing on the glass is model-generated — the model
only transcribes.

Tauri 2 + Svelte 5 (runes) + TypeScript frontend, Rust core, SQLite.

## Commands

```bash
pnpm install
pnpm tauri dev          # the real app: control + stage windows
pnpm dev                # frontend only in a browser (uses the mock backend)

pnpm check              # svelte-check — the authoritative typecheck
pnpm test               # node vitest (~2000 tests): src/**/*.test.ts + tests/{unit,integration,e2e}
pnpm test:dom           # jsdom vitest, tests/dom/** only (separate config)
pnpm test:all           # both vitest projects
pnpm test:e2e           # Playwright against the Vite dev server
cd src-tauri && cargo test
cd crates && cargo test  # separate workspace: cc-align / cc-stt / cc-bench
```

Single test file / single test:

```bash
./node_modules/.bin/vitest run src/shared/optics.test.ts
./node_modules/.bin/vitest run --config vitest.dom.config.ts tests/dom/dialog.test.ts
./node_modules/.bin/vitest run tests/unit/contracts.test.ts -t 'name of test'
pnpm test:e2e -- tests/e2e/browser/stage-preview.spec.ts
cd src-tauri && cargo test --test stage_handshake_tests
```

Use `./node_modules/.bin/vitest`, **not** `npx vitest` — npx has resolved a
foreign vitest/chai here and produced bogus "Invalid Chai property" failures.

Opt-in live tests (skip cleanly without the flag + key, so the normal suite
never hits the network):

```bash
CANDIDCUE_LIVE_GROK=1 ./node_modules/.bin/vitest run tests/integration/grok-transcription.live.test.ts
```

Alignment benchmarks (`bench/README.md` has the full story):

```bash
cd crates
cargo run --release -p cc-bench -- tier-a --label mine --out ../bench/results/mine.json
cargo run --release -p cc-bench -- inspect starter skip_forward   # per-event decision trace
```

There is no lint script and no ESLint/Prettier config in the tree. Conventions:
single quotes, no Prettier. Do **not** run `cargo fmt` — the tree predates it
and it would rewrite unrelated files.

## Architecture

### Three entry points, one Vite config

`control.html`, `stage.html`, `identify.html` build from one config into
`dist/`; Tauri window URLs point at them directly. `identify.html` backs the
short-lived "which physical panel is display 2?" overlays. Only the control
window is declared in `tauri.conf.json`; the stage and identify windows are
created at runtime from `src-tauri/src/windows/`.

### The trust boundary is the point

Rust owns secrets (OS keychain), the SQLite database, the filesystem, and the
xAI socket. The webviews only ever see typed IPC results, and neither
window's CSP allows a request to any remote host.

The STT socket **must** live in Rust: Grok authenticates a stream with an
`Authorization: Bearer` *header*, a browser `WebSocket` cannot send one, and
xAI's own docs say the key must never reach client-side code. So: renderer
captures PCM → `push_transcription_audio` over IPC → `src-tauri/src/stt/stream.rs`
holds the connection → frames come back as events. Audio must keep flowing for
the length of a take; server-side VAD needs the silence to decide an utterance
ended.

The session is configured entirely by URL query — there is no config frame — and
audio goes out as raw binary. Finality arrives in two flags: `is_final` locks a
~3 s chunk, `speech_final` closes the utterance. The docs never say whether the
utterance-final repeats the locked chunks, so `Utterances::finish` checks rather
than guesses; see the module header. There is deliberately **no model setting** —
the streaming endpoint takes no model parameter.

### Alignment: pure crate, hosted by the app

`crates/cc-align` is a deterministic engine — no I/O, no clocks, no randomness.
Time enters as explicit audio-clock milliseconds. The *same* crate runs live in
the app and offline in `cc-bench`, which is what makes benchmark numbers mean
anything.

`src-tauri/src/align/mod.rs` is its host: it sits next to the socket (where the
frames and the audio clock already are) and owns **the one conversion in the
system** between the engine's *atoms* (`$12` = two spoken words) and the app's
*tokens* (`$12` = one measured span on the glass). Nothing downstream of that
file ever sees an atom. Do not put lexical judgement — stopword lists,
tokenizers, "close enough" checks — in the host module; that all belongs to the
engine.

`crates/` is a **separate cargo workspace** from `src-tauri/` on purpose, so the
alignment core and benchmark tooling build without Tauri or a WebView.

### The motion path skips control

Rust publishes alignment snapshots **directly to the stage window**. Control is
out of the motion path entirely and receives its own copy only so it can report
on what happened — which is why a take summary can never disagree with what the
presenter saw.

Stage-side motion lives in `src/stage/motion/`: a persistent jerk-limited
follower (`controller.ts`, pure — the caller supplies `dt`, no rAF, no DOM) fed
by `engine.ts`, rendering through `src/stage/renderer/ScriptLayer.svelte`.

### Stage event protocol

`src/shared/contracts/stage.ts` is the complete surface between control/Rust and
the stage. Event names use the `stage://` convention and are mirrored verbatim
in `src-tauri/src/windows/mod.rs::events`; a Rust test `include_str!`s the
TypeScript file to assert the two stay in sync, so **keep the string literals
grep-able**.

The stage window holds only `core:event:allow-listen`/`allow-unlisten` plus
emit permissions (`src-tauri/capabilities/stage.json`) — it never invokes
commands. `emitStageEvent` in `src/stage/events.ts` is a **broadcast**; Tauri
fans a webview emit out to every webview's JS listeners regardless of target, so
an event the stage emits must not share a name with one control listens for
(that is why `escapePressed`/`motionReport` exist as distinct names).

### IPC funnel

Every control-window service goes through `ipcInvoke` / `invokeOrMock` in
`src/control/services/ipc.ts` — one grep for `ipcInvoke(` audits every command
call site. Command names are exact snake_case; payload keys are camelCase.
`invokeOrMock` falls back to `mock-backend.ts` **only** when the Tauri runtime is
absent (plain-browser dev), so inside Tauri all errors propagate as real
`AppError`s. `setInvokeForTesting` injects a fake for unit tests.

### Layout

```
src/shared/       compiler (markdown/), contracts/, optics, line-break — no I/O, node-testable
src/control/      routes/ (Editor, Live, Settings, Calibrate, Library, Welcome),
                  stores/ (session.ts and smooth-follow.ts are the big ones),
                  services/ (ipc, voice-session, stage-envelope, audio/, stt/)
src/stage/        StageApp/StageDock, motion/, renderer/
src/workers/      compiler Web Worker
src-tauri/src/    app.rs (command registry), commands/, windows/, align/, stt/,
                  coordinator/ (window generations, session, stage handshake),
                  database/, scripts/, assets/, secrets/, sessions/, settings/
crates/           cc-align (engine), cc-stt (Tauri-free Grok client), cc-bench
bench/            fixture scripts, immutable captured replay runs, results
docs/             specifications
```

## Testing layers, and what each proves

- **node vitest** — shared logic, contracts, stores, services. The bulk.
- **jsdom vitest** (`tests/dom/`) — focus-management and stage-renderer
  components. Deliberately no `@testing-library/jest-dom`: it extends chai at
  import time and produced "Invalid Chai property" whenever files shared a
  worker. Assert with plain DOM reads. The whole directory runs in one
  invocation.
- **Playwright** (`tests/e2e/browser/`) — real Svelte frontend against the dev
  server with an injected Tauri shim (`fixtures/tauri-shim.ts`), so the app
  takes the production code path and each test owns its command responses.
  Specs labelled `[mock-backed]` use the app's own mock backend instead. Runs
  serially. Proves routes/stores/components/IPC payloads; says nothing about
  Rust or WKWebView.
- **cargo test** in `src-tauri/tests/` — ACL, IPC contract + roundtrip,
  persistence security, session lifecycle, stage handshake.
- **cc-bench** — Tier A deterministic synthetic scenarios; Tier B replays
  captured live-STT fixtures. Both replay through the same engine and evaluator.

**Not verified at all:** a complete take with a real microphone, a real second
monitor and real teleprompter glass. macOS ships WKWebView, for which Apple
provides no WebDriver, so nothing automated on this machine can drive the
packaged app. A large green suite here has repeatedly coexisted with a broken
product — when a change touches the live follow loop, say what is unproven
rather than implying the suite covered it.

## Gotchas

- `vite.config.ts` pins `decode-named-character-reference` to its non-DOM build.
  Without it the compiler worker throws `document is not defined` in dev and no
  script can be opened at all (production was unaffected, which hid it). The
  resolver throws rather than silently skipping the alias — don't "fix" that by
  making it optional.
- `docs/` specs describe an earlier design that included live coaching and an
  OpenAI semantic sidecar. Both were removed. Where a spec mentions coaching, a
  second model, or OpenAI, **the code is the authority** — see
  `src-tauri/src/stt/` for what actually happens now.
- Two known honest gaps, documented in the README: `pauseLocation` is not
  supplied to the cadence lane (choppy-delivery detection cannot fire), and the
  variety score runs in its documented degraded mode.
- The asset-protocol scope in `tauri.conf.json` allows only
  `$APPDATA/scripts/*/assets/*`, with a `deny` floor over script bodies,
  revisions, the database and logs. `deny` beats both `allow` and any runtime
  `allow_directory`, so it survives a future dynamic widening — keep it that way.
