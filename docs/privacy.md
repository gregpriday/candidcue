# CandidCue Privacy

CandidCue is local-first. Projects, transcripts, plans, and session state live
on your machine. There is no CandidCue server. The only network traffic is from
the main process to the providers you configure.

## What is sent where

During a live interview:

- **Microphone audio** is streamed to **Inworld** for transcription.
- **Transcript and project text** are sent to **OpenAI** to prepare and conduct
  the interview (and to its moderation endpoint for safety classification).
- **Mira's question text** is sent to **Inworld** to generate speech.

CandidCue does **not** record or save your camera video, and **raw microphone
audio is never persisted by default** — it lives only in memory during a turn
for retry, then is released.

## Storage

- Provider credentials are encrypted at rest with Electron `safeStorage` and
  decrypted only in the main process immediately before use. They are never
  exposed to a renderer, log, or export.
- Session transcripts (raw + cleaned) are stored in the local SQLite database
  until you delete them.
- Generated TTS audio is cached only for the current session and cleaned up on
  normal completion or next launch.
- Diagnostic logs retain timing/metadata for 7 days with transcript text and
  credentials redacted. Production logs never include transcripts, prompts,
  credentials, or provider response bodies.

## Exports

Markdown/JSON exports contain your questions and answers but never credentials,
raw audio, provider headers, or local absolute paths.
