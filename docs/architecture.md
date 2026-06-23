# CandidCue Architecture

CandidCue is a local-first Electron 42 desktop app that conducts camera-facing
interviews. It never records or edits the user's camera; it only conducts the
interview and preserves a transcript/session record.

## Processes

- **Main process** (`src/main`) — the trusted application core and single
  source of truth. Owns window/display management, the session state machine
  and orchestrator, provider clients, encrypted credentials, SQLite
  persistence, media planning, exports, logging, and recovery.
- **ControlWindow renderer** (`src/renderer/control`) — operator UI: projects,
  settings, preflight, live operator console, review. Talks to main only
  through its typed preload bridge. Never sees provider credentials.
- **StageWindow renderer** (`src/renderer/stage`) — the teleprompter surface:
  microphone capture (AudioWorklet → PCM), avatar video playback, speech audio,
  minimal status. Sends PCM over a dedicated `MessagePort`.

## Layers and dependency rules

```
src/shared   → domain types, Zod schemas, constants, errors, contracts, utils
src/main     → orchestrator, providers, persistence, media, security, export
src/preload  → contextBridge surfaces (no secrets, no provider clients)
src/renderer → React UIs (no Node, no ipcRenderer access)
```

- `src/shared` imports no Electron or provider code.
- Provider adapters implement domain interfaces (`src/shared/contracts`); domain
  code never imports SDK-specific types.
- Persistence returns domain objects; React never runs SQL.
- Stage playback never decides the next interview question.
- No renderer touches `ipcRenderer` directly.

## Session flow

The orchestrator runs a single exclusive turn pipeline: play question → open
mic gate → stream STT → commit (Space or conservative endpoint) → finalize
transcript → clean + moderate → generate next question (GPT-5.5) → validate →
TTS → select duration-matched speaking clip → play. Audio end is the
authoritative end of Mira's speaking turn. See `state-machine.ts` for the
canonical states and `orchestrator.ts` for the pipeline.

## Persistence

SQLite via Node's built-in `node:sqlite`, hidden behind `CandidCueRepository`
(`src/shared/contracts/repository.ts`). Turn commits are atomic. Raw transcripts
are immutable; raw audio is never persisted.

## Providers

- **OpenAI** (Responses API + moderation) — project preparation, runtime
  interviewing, transcript cleanup, endpoint classification, question repair.
- **Inworld** — streaming STT and buffered TTS.

All provider calls run in main; renderers never hold credentials.
