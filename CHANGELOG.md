# Changelog

Release notes for CandidCue. The release workflow publishes the section
matching the tag it is building, so **a release with no section here does not
ship** — see `scripts/release-notes.mjs`.

Each version gets a `## v<version>` heading, newest first. Write for somebody
deciding whether to install it, not for somebody reading the diff.

## v1.0.0

The first release.

CandidCue is a voice-following teleprompter. You write a script in Markdown, it
displays on a second screen behind your camera — usually through teleprompter
glass — and it scrolls to keep your place as you speak. Nothing on the glass is
generated: an on-device recogniser transcribes you, and a deterministic local
engine decides where in the script you are.

### What it runs on

- **macOS 12 or later.** There is no Windows or Linux build.
- **Apple Silicon and Intel**, from one universal build.
- **A microphone.** Any input macOS offers — built-in, USB, or Bluetooth.
- **A second display** for prompter mode. Reader mode works on one screen.

### Speech recognition

- **English only.** The engine carries normalisation profiles for other
  languages, but English is the only one this build has been measured to
  follow, and unmeasured languages are absent rather than offered.
- **On-device.** No account, no API key, no audio upload. Your voice and your
  script never leave the machine.
- **The model is a separate download.** It is not in the installer. Install it
  from the Welcome screen or from Settings › Speech — about 128 MB to download
  and 162 MB on disk once unpacked, verified against a pinned digest.
  Everything else works without it, and once it is installed CandidCue needs no
  network at all.
- **Recognition is probabilistic.** It makes mistakes, and the prompter is
  built to trail you rather than guess ahead when it is unsure.

### On the stage

- **Takes open in Clean Take: just your script.** Pre-release builds opened
  every take in Diagnostic Take, with engine readouts and a strip of raw
  transcript on the glass, and nothing turned it off. Profiles carried over
  from those builds move to Clean Take as well.
- **Diagnostic Take is a switch in Settings › Teleprompter.** It brings back
  the readouts and the transcript, and shows tables, code and images in full
  instead of as one-line cues. Use it to check a rig or a script that will not
  follow; it applies to a take that is already running. Hold and fault
  messages show in either mode.

### Your data

- **Local, and yours.** Scripts are Markdown files on your disk; settings,
  calibrations and session history are in a local database. There is no cloud
  copy and no server-side recovery.
- **No telemetry.** No analytics, no crash upload, no update check, no licence
  check.
- **Transcripts are off by default.** Settings › Data, privacy & updates has
  **Save session transcripts** if you want them kept for 1, 7 or 30 days, or
  indefinitely.
- **Back up your own work.** **Export all data** writes a checked, restorable
  archive of your durable data: scripts, their revisions and images, settings
  and calibrations, session history, and any retained transcripts. It leaves
  out what is regenerable — caches, logs, diagnostics, and the speech model,
  which is third-party ONNX under its own licence rather than your data, and is
  reinstalled in a click. It is the supported backup, and it is worth testing
  rather than merely creating.

### Updates

CandidCue 1.0 updates manually and contains no updater. To update: quit
CandidCue, download the current signed DMG, replace the app in `/Applications`,
and reopen it. Your scripts, settings, calibrations, session history and
installed speech model are untouched by that. Settings › Data, privacy &
updates reports the installed version.

### Licence

Honour-system registration. CandidCue does not enforce it and stays fully
functional either way — but each person who moves from genuine evaluation to
regular use is obliged to register. There is no activation, key, or account.

### Known limitations

- Voice following is English only.
- The speech model is downloaded separately, on first use.
- Updates are manual; there is no in-app update notification.
- No cloud backup or sync.
- Dragging the reader-mode window to a display with different optics mid-take
  keeps the opening display's text scale until the take ends.
- Choppy-delivery detection does not report: the analysis deliberately emits no
  pause evidence rather than manufacturing findings it cannot support.
- The variety score omits tempo variation, terminal rush and emphasis contrast,
  and runs in a documented degraded mode as a result.

### Reporting problems

**Security issues** go to a private channel, not a public issue: open a
[private advisory](https://github.com/gregpriday/candidcue/security/advisories/new)
or email [greg@siteorigin.com](mailto:greg@siteorigin.com). The full policy,
including scope and safe harbour, is in
[SECURITY.md](https://github.com/gregpriday/candidcue/blob/main/.github/SECURITY.md).

**Everything else** — a defect, a question, a refund — goes to the support
address on the CandidCue website. When reporting a problem it helps to include
the version from Settings › Data, privacy & updates, your macOS version and
whether the Mac is Apple Silicon or Intel, your microphone and display setup,
and what the prompter actually did.
