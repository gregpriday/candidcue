# Provider Setup

CandidCue is bring-your-own-credentials. You need two API keys, entered in
**Settings** inside the app. Keys are encrypted at rest with Electron
`safeStorage` and never leave the main process.

## OpenAI

Used for project preparation, runtime interviewing, transcript cleanup, endpoint
classification, question repair, and moderation.

1. Create a key at <https://platform.openai.com>.
2. Paste it into **Settings → OpenAI API Key**.
3. Click **Test** to verify access.

Models (configurable in `src/shared/constants/runtime-defaults.ts`):

| Role | Default |
|---|---|
| Project preparation (heavy, up-front) | `gpt-5.5` (high reasoning) |
| Live interviewer (per-turn questions) | `gpt-5.4-mini` (low reasoning) |
| Transcript cleanup | `gpt-5.4-mini` |
| Endpoint classifier | `gpt-5.4-nano` |
| Moderation | `omni-moderation-latest` |

## Inworld

Used for streaming speech-to-text and text-to-speech.

1. Get a key from <https://inworld.ai>.
2. Paste it into **Settings → Inworld API Key**.
3. Mira's voice id is configured per character (`videos/mira/character.json`,
   overridable via the `characters.mira.inworldVoiceId` setting).

> The live Inworld STT WebSocket endpoint and wire shape in
> `src/main/providers/factory.ts` are a documented assumption; confirm them
> against current Inworld docs before a production release.

## Credential storage

Credentials are set the same way in both development and packaged builds — enter
each key in **Settings → OpenAI API Key** or **Settings → Inworld API Key**. Keys
are encrypted immediately with Electron `safeStorage`, stored in the app's
user-data directory, and only ever decrypted inside the main process; they are
never written to logs, and stored keys are never returned to the renderer (it
sees only whether each key is set).

## What is sent where

See [privacy.md](./privacy.md). In short: microphone audio → Inworld; transcript
+ project text → OpenAI; Mira's question text → Inworld. Your camera video is
never touched, and raw audio is never persisted.
