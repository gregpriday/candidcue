# CandidCue

A voice-following teleprompter. You write a script in Markdown; it displays on a
second screen behind your camera, usually through teleprompter glass; OpenAI
Realtime transcribes you as you speak; and a local alignment engine scrolls the
script to keep your place. A coaching rail along the bottom reports pace, vocal
variety and filler words while you present.

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

You will need an OpenAI API key to do anything with voice. Add it in Settings;
it is stored in the OS keychain and never reaches the frontend. The permanent
key stays in Rust — the browser side only ever sees short-lived ephemeral
credentials minted per session.

## Testing

```bash
pnpm test        # unit suite, node
pnpm test:dom    # component tests, jsdom
pnpm test:e2e    # browser journeys, Playwright against the dev server
pnpm check       # typecheck (svelte-check) — authoritative
cd src-tauri && cargo test
```

There is also a live smoke test that talks to the real OpenAI API. It is opt-in
and skips cleanly without both variables, so the normal suite never touches the
network or spends money:

```bash
CANDIDCUE_LIVE_OPENAI=1 cargo test --test live_openai -- --nocapture
```

It validates the key, mints a real ephemeral credential, and makes one
structured-output call — roughly a few cents.

## What is verified, and what is not

This distinction matters more than a test count, because a large green suite
here has repeatedly coexisted with a broken product.

**Verified by tests and by running it:** the Markdown compiler and directive
syntax; the alignment engine including section-boundary liveness; the stage
motion controller's realized velocity, acceleration and jerk limits; the whole
coaching analysis stack; the Rust core, its security model and the IPC
boundary; and the OpenAI credential path against the live API.

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
src/shared/     compiler, alignment, coaching, contracts — no I/O, testable in node
src/control/    the control window (routes, stores, services)
src/stage/      the stage window (renderer, motion)
src/workers/    compiler and tracking Web Workers
src-tauri/      Rust core: database, scripts, assets, secrets, OpenAI, IPC
docs/           the three specifications this is built from
```

The three specs in `docs/` are the source of truth, and they override each
other in a defined order: the coaching-rail spec wins for the rail and delivery
analytics, the smooth-following spec wins for tracking and motion, and the
product spec covers everything else.

## Conventions

Single quotes, no Prettier — ESLint only. Run renderer tests one file per
invocation (`./node_modules/.bin/vitest run <file>`, not `npx`). Don't run
`cargo fmt`; the tree predates it and it would rewrite unrelated files.
