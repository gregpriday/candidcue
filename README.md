# CandidCue

A voice-following teleprompter for macOS and Windows. Write your script in
Markdown, press Present, and read. CandidCue listens with a speech recogniser
that runs on your computer, works out where you are in the script, and scrolls
to keep your next words in the reading band. Ad-lib, pause, or start a
sentence over, and it waits for you rather than running ahead.

It is free and open source, built for recording videos on a prompter rig (an
Elgato Prompter or any display behind glass), and it works in an ordinary
window on a single screen too.

## Status

CandidCue is getting ready for v1.0.0. There is no signed download yet, so for
now you build it from source (below). The remaining work is tracked in the
[issues](https://github.com/gregpriday/candidcue/issues).

## What it does

- **Follows your voice.** Recognition runs on device (a streaming Zipformer
  transducer through sherpa-onnx), and a deterministic alignment engine, not a
  language model, decides where you are. Nothing on the glass is generated.
- **Built for glass.** Present moves the window onto the display you pinned in
  Settings, sizes the type for viewing distance rather than pixels, and can
  mirror it for a beam splitter. Presenting in a window suits a laptop and
  webcam.
- **Markdown scripts.** Headings divide the script into sections, plus a few
  extras:
  - `[Cue: look at camera two]` puts a note on the glass that is never spoken
    or followed.
  - `[Pause]`, `[Beat]` and `[Breathe]` are shorthand cues.
  - `[Take: Intro]` starts a part you can record on its own.
  - `GUI{say="gooey"}` shows one thing and follows the voice saying another.
  - `:::silent` and `:::stage` blocks are shown but never followed.
- **Your files.** Scripts are Markdown files on disk, with revision history and
  an Export all data backup.

## Privacy

No account, no telemetry and no API key. Recognition happens on device, so your
audio and your script are not uploaded anywhere. The only network activity in
normal use is the speech model download you start yourself (about 128 MB,
checked against a pinned SHA-256). [`docs/network-inventory.md`](docs/network-inventory.md)
lists every network path in the app, and an update check planned for v1.0.0
([#191](https://github.com/gregpriday/candidcue/issues/191)) will be added there
when it lands.

## Requirements

- macOS 12 or later, Apple Silicon or Intel; or Windows 11, 64-bit (x64).
  Windows 10 should work — it has the same WebView2 runtime, which the
  installer fetches where it is missing — but is not tested.
- Linux x64: Ubuntu 22.04 or later, as a `.deb` or an AppImage, with a
  PulseAudio or PipeWire sound server for the microphone. Other distributions
  with glibc 2.35 and WebKitGTK 4.1 should work but are not tested.
- A microphone
- A second display for prompter mode (optional)
- English, for voice following

## Building from source

```bash
pnpm install
pnpm dev
```

You need Node 26.4 (`.nvmrc`), pnpm 10 and the Rust toolchain pinned in
`rust-toolchain.toml`. `pnpm dev` starts the app on the first free port from
1420.

On Windows you also need the Visual Studio Build Tools with the "Desktop
development with C++" workload (the MSVC linker and Windows SDK). Everything
else is the same: `pnpm install`, `pnpm dev`, and `pnpm tauri build` produces
the NSIS installer (`src-tauri/tauri.windows.conf.json` sets the target).

On Linux (Ubuntu 22.04 or later) install the WebKitGTK toolchain first:

```bash
sudo apt-get install build-essential pkg-config file xdg-utils patchelf \
  libwebkit2gtk-4.1-dev libgtk-3-dev libdbus-1-dev librsvg2-dev
```

`pnpm tauri build` then produces a `.deb` and an AppImage
(`src-tauri/tauri.linux.conf.json` sets the targets).

The speech model is not in the repository or the app bundle. Install it from
the Welcome screen or **Settings › Speech**. To skip that download while
developing:

```bash
pnpm models:fetch                                   # ~161 MB into src-tauri/models/
export CANDIDCUE_MODELS_DIR="$PWD/src-tauri/models"
```

`models:fetch` is a POSIX shell script. On Windows, install the model from the
app instead; `CANDIDCUE_MODELS_DIR` can then point at the copy it keeps in
`%APPDATA%\com.candidcue.app\models`.

Then open the sample script from the Welcome screen and read it aloud. It tells
you what to watch for.

## Development

```bash
pnpm check                   # svelte-check, the authoritative typecheck
pnpm test                    # unit tests (node)
pnpm test:dom                # component tests (jsdom)
pnpm test:e2e                # browser journeys (Playwright)
cd src-tauri && cargo test   # the app's Rust core
cd crates && cargo test      # alignment engine, recogniser, benchmarks
```

```
src/shared/    compiler, contracts, optics (no I/O)
src/control/   the main window: library, editor, settings, takes
src/stage/     the prompter renderer and motion
src-tauri/     Rust: storage, windows, speech, the alignment host
crates/        cc-align (alignment engine), cc-stt (recogniser), cc-bench
bench/         replay corpora (Git LFS) and benchmark results
```

[`CLAUDE.md`](CLAUDE.md) has the detailed architecture notes and
[`bench/README.md`](bench/README.md) explains the alignment benchmarks. Code
style is single quotes and no Prettier. Please don't run `cargo fmt`; the tree
predates it and it would rewrite unrelated files.

The browser journeys exercise the frontend against the Vite server, not the
packaged app — nothing here drives that (on macOS nothing can: Apple ships no
WebDriver for WKWebView) — so a change to the live follow loop also needs a
real take with a real microphone.

### Branches

The project uses gitflow. Branch from `develop` and open your pull request
against `develop`; that is where all work is integrated. `main` only moves when
a release is cut: `develop` is merged into `main` and the release is tagged
there (see [`docs/release-runbook.md`](docs/release-runbook.md)).

## Licence

CandidCue is moving to the MIT licence
([#223](https://github.com/gregpriday/candidcue/issues/223)). Until that change
lands, the `LICENSE` file still carries an earlier proprietary notice.
Third-party components are listed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md),
and security reports go through [`.github/SECURITY.md`](.github/SECURITY.md).
