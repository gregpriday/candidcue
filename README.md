# CandidCue

A desktop **interview conductor** for solo presenters. CandidCue puts an
animated AI interviewer — **Mira** — on a teleprompter, listens to you through a
microphone, and asks short, context-aware questions that help you deliver
natural, self-contained answers. It does **not** record or edit your camera; its
job ends at conducting the interview and preserving a transcript.

## Stack

- **Electron 42.4.1** (exact-pinned), Electron Forge + Vite
- **TypeScript** (strict), **React 18**, CSS Modules + design tokens
- **Zod** for all IPC and provider-result validation
- **SQLite** via Node's built-in `node:sqlite`, behind a repository interface
- **OpenAI** (Responses + Moderation) for interview intelligence
- **Inworld** streaming STT + buffered TTS
- **CodeMirror** markdown editors for project source/notes
- **Vitest** for unit/integration tests

## Getting started

```bash
npm install
npm run media:index     # build the Mira media manifest (needs ffprobe)
npm start               # launch via Electron Forge
```

Then open **Settings** and add your OpenAI and Inworld API keys
(see [docs/provider-setup.md](docs/provider-setup.md)).

## Quality gate

```bash
npm run typecheck   # tsc --noEmit (strict)
npm test            # vitest (unit + integration)
npm run verify      # typecheck + test + media:validate + prompts:validate
```

> Note: `tsc`/`vitest` may be wrapped by a local CLI proxy that summarizes
> output. For an authoritative type check run the binary directly:
> `node node_modules/typescript/bin/tsc --noEmit`.

## Architecture

Two windows, one trusted core. The **main process** owns the session state
machine, providers, encrypted credentials, persistence, and media planning. The
**ControlWindow** is the operator UI; the **StageWindow** is the teleprompter
surface. Renderers are sandboxed and reach main only through typed preload
bridges — never `ipcRenderer`, never provider credentials.

```
src/
  shared/      domain types, Zod schemas, constants, errors, contracts, utils
  main/        orchestrator, providers (+ fakes), persistence, media, security,
               diagnostics, export, characters, prompts, IPC, windows
  preload/     control.ts, stage.ts  (contextBridge surfaces)
  renderer/    control/ (operator UI)  stage/ (teleprompter)
prompts/       versioned system prompts
videos/mira/   bundled interviewer media + generated manifest
tests/         unit, integration, e2e, provider-contract, evals, fixtures
```

See [docs/architecture.md](docs/architecture.md),
[docs/privacy.md](docs/privacy.md), and
[docs/media-authoring.md](docs/media-authoring.md).

## Security model

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` on every window
- A privileged `candidcue://` protocol serves only allow-listed local assets
  (path traversal rejected); arbitrary network URLs are never proxied
- Strict Content-Security-Policy; microphone permitted only to the stage origin;
  camera and all other capabilities denied
- Provider credentials encrypted with `safeStorage`, decrypted only in main
- Imported project text is treated as untrusted data, never as instructions
