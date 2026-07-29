# CandidCue

A voice-following teleprompter. You write a script in Markdown; it displays on a
second screen behind your camera, usually through teleprompter glass; Grok (xAI)
transcribes you as you speak; and a local alignment engine scrolls the script to
keep your place. That is the whole product: it follows you, shows you where you
are, and lets you jump forward and back.

Nothing about the display is generated at runtime — the model never writes what
you see. It transcribes, and a deterministic local engine decides where you are.

## Running it

```bash
pnpm install
pnpm tauri dev
```

That opens two windows: the **control** window, where you write and configure,
and the **stage** window, which goes on your second display. On first run, take
the **"Open the sample script"** button — the sample is written to be read out
loud and tells you what to watch for while you read it.

You will need an xAI API key to do anything with voice. Add it in Settings
→ Speech; it is stored in the OS keychain and never reaches the frontend.

The key never leaves Rust, and neither does the transcription socket. That is
not only a precaution: xAI authenticates a stream with an `Authorization`
header, and a browser `WebSocket` cannot send one. The renderer captures audio
and pushes PCM frames over IPC; Rust holds the connection and emits transcript
events back. Neither window's CSP allows a request to any remote host.

## Testing

```bash
pnpm test        # unit suite, node
pnpm test:dom    # component tests, jsdom
pnpm test:e2e    # browser journeys, Playwright against the dev server
pnpm check       # typecheck (svelte-check) — authoritative
cd src-tauri && cargo test
```

There is also a live smoke test that streams real audio to the real xAI API
and asserts on the words that come back. It is opt-in and skips cleanly without
both the flag and a key, so the normal suite never touches the network or spends
money:

```bash
CANDIDCUE_LIVE_GROK=1 pnpm vitest run tests/integration/grok-transcription.live.test.ts
```

It is the only test that can tell a healthy socket apart from one that
transcribes nothing, which is the failure this app has shipped twice. It also
pins the two protocol facts the docs get wrong: auth is a header, not a query
parameter, and inbound frames are `result`-wrapped except errors.

## What is verified, and what is not

This distinction matters more than a test count, because a large green suite
here has repeatedly coexisted with a broken product.

**Verified by tests and by running it:** the Markdown compiler and directive
syntax; the alignment engine including section-boundary liveness; the stage
motion controller's realized velocity, acceleration and jerk limits; the Rust
core, its security model and the IPC boundary; and real speech through the live
xAI API into real transcript events.

**Verified only in a browser, not on a real device:** every frontend journey in
`pnpm test:e2e` runs against the Vite dev server with an injected Tauri shim, so
it proves the routes, stores, components and the exact IPC payloads the
frontend emits — and says nothing about Rust behaviour or WKWebView.

**Not verified at all, and this is the honest gap:** a complete take with a real
microphone, a real Realtime session, a real second monitor and real teleprompter
glass. macOS ships WKWebView, for which Apple provides no WebDriver, so no
automated layer on this machine can drive the packaged app. The motion engine's
actual pixels, the mirror through glass, and the live follow loop are unproven
outside unit tests and need someone in front of a camera.

Two smaller known gaps: `pauseLocation` is not supplied to the cadence lane, so
choppy-delivery detection cannot fire (the orchestrator deliberately offers no
pauses rather than defaulting to a value that would manufacture false
findings); and the tempo-variation, terminal-rush-rate and emphasis-contrast
terms are absent from the variety score, which runs in its documented degraded
mode as a result.

## Layout

```
src/shared/     compiler, alignment, contracts — no I/O, testable in node
src/control/    the control window (routes, stores, services)
src/stage/      the stage window (renderer, motion)
src/workers/    compiler and tracking Web Workers
src-tauri/      Rust core: database, scripts, assets, secrets, Grok STT, IPC
docs/           the three specifications this is built from
```

The specs in `docs/` describe an earlier design that included live coaching and
an OpenAI semantic sidecar. Both have been removed; the smooth-following spec
still governs tracking and motion, and the product spec covers everything else.
Where they describe coaching, a second model, or OpenAI, the code is the
authority — see `src-tauri/src/stt/` for what actually happens now.

## Conventions

Single quotes, no Prettier — ESLint only. Run renderer tests one file per
invocation (`./node_modules/.bin/vitest run <file>`, not `npx`). Don't run
`cargo fmt`; the tree predates it and it would rewrite unrelated files.
