# CandidCue

A voice-following teleprompter. You write a script in Markdown; it displays on a
second screen behind your camera, usually through teleprompter glass; an
on-device speech recogniser transcribes you as you speak; and a local
alignment engine scrolls the script to keep your place. That is the whole product: it follows you, shows you where you
are, and lets you jump forward and back.

Nothing about the display is generated at runtime — the model never writes what
you see. It transcribes, and a deterministic local engine decides where you are.

Your work stays on your machine. Speech recognition runs on-device against a
streaming Zipformer transducer, so there is no account, no API key, and no audio
upload. On the benchmark corpus it matches the hosted service it replaced — see
`bench/REPORT.md`. The one network activity a stock build has is the
speech-model download you start yourself — one activity, not one request, since
a resume or a redirect is several. `docs/network-inventory.md` is the full
inventory, and the source every privacy claim in this repository is written
from.

## Running it

```bash
pnpm install
pnpm tauri dev
```

That opens the **control** window, where you write and configure. Pressing
Present reshapes THAT window into the prompter — the supported production path
is single-window (`src/control/lib/start-take.ts`), which is what removed the
cross-WebView critical path a take used to depend on. A separate **stage**
window still exists for the preview and compatibility paths, and
`src/stage/` is the renderer both use.

On first run, take the **"Open the sample script"** button — the sample is
written to be read out loud and tells you what to watch for while you read it.

Voice following needs nothing configured — no key, no account. It does need the
recogniser, which ships in neither git nor the installer: open **Settings ›
Speech** and install it from there (~128 MB to fetch, ~162 MB unpacked, checked
against a pinned digest). Everything else — writing, importing, the stage —
works without it.

Contributors can skip that download by fetching into the source tree and
pointing the app at it:

```bash
pnpm models:fetch                              # ~161 MB into src-tauri/models/
export CANDIDCUE_MODELS_DIR="$PWD/src-tauri/models"
```

Without that variable nothing reads `src-tauri/models/`, and `pnpm tauri dev`
takes the same in-app download a user does.

The recogniser runs in Rust, on its own thread, beside the alignment engine that
consumes it — the two share an audio clock, and a transcript frame never has to
cross a process boundary to reach the thing that times it. The renderer captures
audio and pushes PCM frames over IPC. No window's CSP allows a fetch to any
remote host, and the only thing Rust contacts anything for is a model download
the user started — `docs/network-inventory.md` has the whole picture, redirects
included.

## Testing

```bash
pnpm test        # unit suite, node
pnpm test:dom    # component tests, jsdom
pnpm test:e2e    # browser journeys, Playwright against the dev server
pnpm check       # typecheck (svelte-check) — authoritative
cd src-tauri && cargo test
```

### Release verification

One command, and CI runs the same one. There is no hand-assembled subset that
counts as equivalent — that ambiguity is what made the 1.0 readiness review
unable to certify a release.

```bash
pnpm release:verify --tier=fast   # gates only: completeness, versions, legal
pnpm release:verify --tier=code   # + typecheck, node, dom, both cargo workspaces
pnpm release:verify               # + clippy, browser journeys, production build
pnpm release:verify --list        # print the plan without running it
```

`--tier=fast` is worth running on its own; it takes under a second and covers
the two gates that fail most usefully:

```bash
pnpm verify:repo     # every referenced input exists in this checkout
pnpm version:check   # package.json / Cargo.toml / tauri.conf.json / version.ts agree
pnpm version:set 1.0.0   # change all four at once
```

Two gates belong to a tag rather than to a commit, so they run in the release
workflow instead of in `release:verify` — but both are runnable by hand:

```bash
pnpm version:tag v1.0.0     # the tag must name the version the artifact reports
pnpm notes:check v1.0.0 --check   # CHANGELOG.md must describe this release
```

Release notes live in [`CHANGELOG.md`](CHANGELOG.md) and the workflow publishes
the section matching the tag, so a release nobody described does not ship. A
release candidate reads the section for the release it is a candidate for —
`v1.0.0-rc.2` takes `## v1.0.0` — because the notes an RC ships under are the
ones being proofread.

`pnpm legal:check` is **expected to fail** until the business fills in the
`@@LEGAL_*@@` placeholders — that failure is the commercial release gate. Pass
`--allow-legal-failure` for a development build; the run then says loudly that
it is not releasable.

Toolchains are pinned exactly: `.nvmrc` for Node, `rust-toolchain.toml` for the
Rust compiler. The latter names a specific release rather than `stable`, so two
machines a month apart build the same tag with the same compiler.

The live network smoke test is gone with the service it tested. What replaced it
is stronger: `cc-bench` streams recorded speech through the real recogniser
offline and scores where the display ended up, so "a session that connects and
transcribes nothing" is now a benchmark row rather than a test that has to be
opted into. See `bench/README.md`.

## What is verified, and what is not

This distinction matters more than a test count, because a large green suite
here has repeatedly coexisted with a broken product.

**Verified by tests and by running it:** the Markdown compiler and directive
syntax; the alignment engine including section-boundary liveness; the stage
motion controller's realized velocity, acceleration and jerk limits; the Rust
core, its security model and the IPC boundary; and real speech through the live
recogniser into real transcript events.

**Verified only in a browser, not on a real device:** every frontend journey in
`pnpm test:e2e` runs against the Vite dev server with an injected Tauri shim, so
it proves the routes, stores, components and the exact IPC payloads the
frontend emits — and says nothing about Rust behaviour or WKWebView.

**Verified by running it, not by automation:** complete takes with a real
microphone, a real second monitor and real teleprompter glass. That is how the
app is used, and it works. No automated layer reaches that far, and on this
machine none can: macOS ships WKWebView, for which Apple provides no WebDriver,
so nothing automated can drive the packaged app. The motion engine's real
pixels, the mirror through glass and the live follow loop rest on use rather
than on the suite — worth remembering whenever the follow loop changes.

The reversible fuzzy dim frontier is a fourth: the engine can shade a word ahead
on close spelling or phonetic evidence, and the mechanism is proven correct in
`cc-bench`'s own harness (100% recall on respellings and proper nouns, 100%
rollback, no false bridge on unrelated speech). It has never fired on a recorded
take. Real streaming partials arrive several words at a time, carrying exact
matches and recogniser word splits alongside the near-miss, and the coherence
gate requires neither — so the gate stays shut on every fixture in the corpus.
That is why it is safe to ship and why it is not yet a win; `bench/README.md`
has the measurement.

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
src-tauri/      Rust core: database, scripts, assets, on-device STT, IPC
docs/           the three specifications this is built from
```

The specs in `docs/` describe an earlier design that included live coaching and
an OpenAI semantic sidecar. Both have been removed; the smooth-following spec
still governs tracking and motion, and the product spec covers everything else.
Where they describe coaching, a second model, or OpenAI, the code is the
authority — see `src-tauri/src/speech/` for what actually happens now.

## Legal

CandidCue is proprietary. [`LICENSE`](LICENSE) covers this source; the
[EULA](legal/EULA.md) covers the application. It is written for the
honour-system registration model: CandidCue does not technically enforce
registration and stays fully functional either way, but each person who moves
from genuine evaluation to regular use is obliged to register.

The [privacy policy](legal/PRIVACY_POLICY.md) is the one worth reading, because
the honest version is short: speech recognition runs on-device, nothing about
your scripts or your audio leaves the machine, and the only network activity the
app has in normal use is the speech-model download you start yourself. The
[refund policy](legal/REFUND_POLICY.md) is 30 days, no reason required.

These documents are drafted but not yet in force. Every fact that could not be
established from this repository — the legal entity, the jurisdiction, the
Merchant of Record, the website's log retention — is an `@@LEGAL_*@@`
placeholder rather than a guess.
[`legal/PLACEHOLDERS.md`](legal/PLACEHOLDERS.md) lists them, along with the
commands that re-check every factual claim the
privacy policy makes about the code. Both must be cleared before CandidCue is
sold.

## Conventions

Single quotes, no Prettier, and — as of this writing — no ESLint either: there
is no ESLint configuration in the tree, so "ESLint only" would be a claim about
tooling that does not exist. `pnpm check` (svelte-check) is the authoritative
static check for the frontend, and Clippy is for both Rust workspaces.

Run renderer tests one file per invocation (`./node_modules/.bin/vitest run
<file>`, not `npx`). Don't run `cargo fmt`; the tree predates it and it would
rewrite unrelated files.
