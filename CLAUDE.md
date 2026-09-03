# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A voice-following teleprompter. You write Markdown in the **control** window;
pressing Present reshapes that window into the prompter on your chosen display
(single-window is the supported production path — `src/control/lib/start-take.ts`
— with the separate **stage** window kept for preview and compatibility); an
on-device model transcribes your speech; a deterministic Rust engine decides
where in the script you are and scrolls the prompter to match. Nothing on the glass is model-generated
— the model only transcribes, and it never leaves the machine.

Tauri 2 + Svelte 5 (runes) + TypeScript frontend, Rust core, SQLite.

## Commands

```bash
pnpm install
pnpm dev                # the real app: control + stage windows, on the first
                        # free port from 1420 up (scripts/dev.mjs)
pnpm tauri dev          # the same app, but pinned to 1420 — fails if it is taken
pnpm dev:vite           # frontend only in a browser (uses the mock backend)

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
# (The live-STT smoke test is gone: transcription is on-device, so cc-bench
# replays real speech through the real recogniser offline instead.)
```

Alignment benchmarks (`bench/README.md` has the full story):

```bash
cd crates
cargo run --release -p cc-bench -- tier-a --label mine --out ../bench/results/mine.json
cargo run --release -p cc-bench -- inspect starter skip_forward   # per-event decision trace

# Tier C: the RENDERED stage — opacity and placement, not engine position.
cargo run --release -p cc-bench -- tier-c --runs ../bench/runs-local --layouts 60hz --label mine
cargo run --release -p cc-bench -- tier-c --runs ../bench/runs-local --focus-lead 0   # as shipped
cargo run --release -p cc-bench -- difficulty | metamorphic | robustness --budget 2000
```

`bench/runs*/` `events.jsonl` and `gold.json` are in **Git LFS**. Without a fetch
they are ~130-byte pointers and a Tier B/C run simply finds no events rather than
failing loudly — check `git lfs ls-files` first if a corpus looks empty.

There is no lint script and no ESLint/Prettier config in the tree. Conventions:
single quotes, no Prettier. Do **not** run `cargo fmt` — the tree predates it
and it would rewrite unrelated files.

## Architecture

### Four entry points, one Vite config

`control.html`, `stage.html`, `identify.html`, `preferences.html` build from one
config into `dist/`; Tauri window URLs point at them directly. `identify.html`
backs the short-lived "which physical panel is display 2?" overlays;
`preferences.html` is Settings, which is its own window rather than a route in
the control window. Only the control window is declared in `tauri.conf.json`;
the stage, identify and preferences windows are created at runtime from
`src-tauri/src/windows/`.

### The menu bar belongs to the application, not to a window

`src-tauri/src/menu.rs` owns the native menu. Two properties are easy to break
and both have bitten:

- a menu command is delivered to the **focused** window (`command_target`),
  never unconditionally to control — otherwise ⌘W with Settings in front closes
  the document window behind it. Over a window that answers no commands (the
  stage), only the handful in `CONTEXT_FREE_COMMANDS` are forwarded and the
  rest are dropped;
- the menu's enabled state is pushed by whichever window is in front, and
  re-pushed on focus (`installMenuStateOnFocus`), because one menu is shared by
  two windows and the last push wins.

Commands are declared once in `src/control/lib/commands.ts`; `menu.rs` writes
the structure out again in Rust and a test compares the two accelerator sets in
both directions.

### The trust boundary is the point

Rust owns the SQLite database, the filesystem, and the speech recogniser. The
webviews only ever see typed IPC results, and neither window's CSP allows a
request to any remote host.

There are **no secrets any more**. The app used to hold one — a hosted STT
provider's API key, in the OS keychain — and the recogniser now runs on-device,
so the credential store went with it.

Speech-to-text is `src-tauri/src/speech/`: a sherpa-onnx streaming Zipformer
transducer (x-asr 480 ms, INT8, punctuated) over ~161 MB of ONNX graphs. The
graphs are **not in the bundle** — `bundle.resources` is empty and a stock build
ships zero model bytes. `cc_stt::local::ModelFiles::detect` works out how a
model archive names its graphs — upstream is not consistent and there is no
manifest. Renderer captures PCM → `push_transcription_audio` over IPC → a
dedicated OS thread owns the decoder → frames come back as events. The thread is
not optional: ONNX inference is blocking CPU work, and on the async runtime it
would starve every other command for the length of a take.

The model is **not in git and not in the installer**. Users install it from
**Settings › Speech**, which verifies the archive digest, extracts only
catalogue-named members and seals the result. `model_store::resolve` then looks
in a deliberate order: `CANDIDCUE_MODELS_DIR`, then that sealed download in
`$APPDATA/models/`, then a bundled resource stock builds do not have.
`pnpm models:fetch` only fills the source tree — **nothing reads that directory**
unless you export `CANDIDCUE_MODELS_DIR` at it, so a dev build otherwise takes
the same in-app download a user does. `LocalSttConfig::validate` names the
missing file rather than letting the C library return a bare null.

### Alignment: pure crate, hosted by the app

`crates/cc-align` is a deterministic engine — no I/O, no clocks, no randomness.
Time enters as explicit audio-clock milliseconds. The *same* crate runs live in
the app and offline in `cc-bench`, which is what makes benchmark numbers mean
anything.

`src-tauri/src/align/mod.rs` is its host: it sits next to the recogniser (where the
frames and the audio clock already are) and owns **the one conversion in the
system** between the engine's *atoms* (`$12` = two spoken words) and the app's
*tokens* (`$12` = one measured span on the glass). Nothing downstream of that
file ever sees an atom. Do not put lexical judgement — stopword lists,
tokenizers, "close enough" checks — in the host module; that all belongs to the
engine.

`crates/` is a **separate cargo workspace** from `src-tauri/` on purpose, so the
alignment core and benchmark tooling build without Tauri or a WebView.

One snapshot field is **dim-only and must stay that way**: `provisionalToken` is
a reversible frontier fed by fuzzy/phonetic evidence, and it is allowed to lead
precisely because shading can be taken back and scroll cannot. In the renderer it
reaches `cursorTokenIndex` and nothing else; wiring it into motion, `observed` or
`confirmed` would let a spelling guess move the document. `provisionalRetracted`
is a **one-shot** — the engine clears it after the snapshot that carries it, so
treat it as an event, not a state. As of 2026-07-30 the gate never opens on the
recorded corpus (`bench/README.md`, "The reversible dim frontier") — the
mechanism is proven only in `cc-bench`'s own harness, so do not describe it as
working on real takes.

### The motion path skips control

Rust publishes alignment snapshots **directly to the stage window**. Control is
out of the motion path entirely and receives its own copy only so it can report
on what happened — which is why a take summary can never disagree with what the
presenter saw.

Stage-side motion lives in `src/stage/motion/`: a persistent jerk-limited
follower (`controller.ts`, pure — the caller supplies `dt`, no rAF, no DOM) fed
by `engine.ts`, rendering through `src/stage/renderer/ScriptLayer.svelte`.

### How a prompter take is sized

A prompter fills whichever monitor the control window is on, and its type is
sized by **visual angle**, not pixels (`src/shared/optics.ts`). The profile that
drives it is chosen in `prompterOpticalProfile` (`services/stage-envelope.ts`)
in this order: a rig the operator calibrated **and chose** for that panel; else
the **automatic** profile, rebuilt from the landed panel on every Present
(`shared/optical-discovery.ts::automaticProfile` — hardware table for the two
Elgato models, otherwise the panel's own EDID millimetres, which Rust reads
via `windows/panel_size.rs` into `DisplayDescriptor.physicalSizeMm`); else the
flat 64px fallback, which only an unidentifiable panel gets now. The automatic
profile is never stored — its `rigName` is `AUTOMATIC_RIG_NAME` (a name the
wizard refuses) and that is how the appearance sheet and Live tell it from a
calibrated rig. A stored rig that is not chosen is deliberately never adopted.
On macOS the monitor `name` is tao's `Monitor #<model>`, so the "name contains
Prompter" check never fires there; the 9-inch is identified by its 1024x600
grid and everything else by millimetres. EDID lies in known ways, so
`plausible_panel_mm` refuses `0x0`, the `160x90` placeholder, any size whose
aspect disagrees with the pixel grid, and the 72-DPI estimate CoreGraphics
substitutes when a display has no EDID; `cargo test --lib windows::panel_size --
--ignored --nocapture` prints what the connected panels actually report.

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
src-tauri/src/    app.rs (command registry), commands/, windows/, align/, speech/,
                  coordinator/ (window generations, session, stage handshake),
                  database/, scripts/, assets/, sessions/, settings/
src-tauri/models/ dev-only recogniser fetch target (gitignored, never bundled)
crates/           cc-align (engine), cc-stt (STT protocol + on-device
                  recogniser), cc-bench
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
  **Tier C** scores the RENDERED stage: it ports the shipping TypeScript follower
  and dim ramp into Rust and simulates frames, so it can see what the glass shows
  rather than what the engine estimated — which is how the floored frontier and
  the retreat chatter were found. Being a port, it is a second implementation
  that can drift from `src/stage/motion/`; treat a Tier C number as evidence about
  the model until the behaviour is also asserted in the TypeScript suite. Its
  `focus_lead_atoms` corridor aim is NOT in the product (see `bench/README.md`).

**Verified by real use, not by anything above:** complete takes with a real
microphone, a real second monitor and real teleprompter glass. The app is used
this way and it works — but that is lived experience, not a row in a suite or
a benchmark. macOS ships WKWebView, for which Apple provides no WebDriver, so
nothing automated on this machine can drive the packaged app. A large green
suite here has repeatedly coexisted with a broken product — when a change
touches the live follow loop, say what the suite leaves unproven rather than
implying it covered the change.

## Gotchas

- `vite.config.ts` pins `decode-named-character-reference` to its non-DOM build.
  Without it the compiler worker throws `document is not defined` in dev and no
  script can be opened at all (production was unaffected, which hid it). The
  resolver throws rather than silently skipping the alias — don't "fix" that by
  making it optional.
- `docs/` specs describe an earlier design that included live coaching and an
  OpenAI semantic sidecar. Both were removed. Where a spec mentions coaching, a
  second model, or OpenAI, **the code is the authority** — see
  `src-tauri/src/speech/` for what actually happens now. The same applies to
  every mention of Inworld, the hosted STT service the app used to stream takes
  to: **no code talks to it and none can**. What survives is measurement — the
  frozen corpora under `bench/runs/` and `bench/runs-inworld-new/` that the
  on-device model was judged against, plus the prose in `bench/REPORT.md` that
  records the comparison. Those replay offline through `cc-stt`'s own event
  protocol; nothing re-captures them.
- Two known honest gaps, documented in the README: `pauseLocation` is not
  supplied to the cadence lane (choppy-delivery detection cannot fire), and the
  variety score runs in its documented degraded mode.
- The asset-protocol scope in `tauri.conf.json` allows only
  `$APPDATA/scripts/*/assets/*`, with a `deny` floor over script bodies,
  revisions, the database and logs. `deny` beats both `allow` and any runtime
  `allow_directory`, so it survives a future dynamic widening — keep it that way.
