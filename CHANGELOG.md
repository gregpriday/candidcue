# Changelog

Release notes for CandidCue. The release workflow publishes the section
matching the tag it is building, so **a release with no section here does not
ship** — see `scripts/release-notes.mjs`.

Each version gets a `## v<version>` heading, newest first. Write for somebody
deciding whether to install it, not for somebody reading the diff.

## v0.1.0

The first public release. CandidCue is free and open source under the MIT
licence.

CandidCue is a voice-following teleprompter. You write a script in Markdown, it
displays on a second screen behind your camera — usually through teleprompter
glass — and it scrolls to keep your place as you speak. Nothing on the glass is
generated: an on-device recogniser transcribes you, and a deterministic local
engine decides where in the script you are.

### What it runs on

- **macOS 12 or later**, on **Apple Silicon and Intel**, from one universal
  build. Signed and notarised: it opens without any Gatekeeper workaround.
- **Windows 11, 64-bit.** A per-user installer that needs no administrator
  rights. It is not code-signed, so the first time you run it Windows
  SmartScreen says it does not recognise the app: choose **More info**, then
  **Run anyway**. Windows 10 should work but has not been tested.
- **Linux, 64-bit**, as an AppImage or a `.deb`, built on Ubuntu 22.04 and
  needing that release's libraries or newer (WebKitGTK 4.1). Tested under X11;
  Wayland is untested.
- **A microphone**, and **a second display** for prompter mode. Reader mode
  works on one screen.

### Speech recognition

- **English only.** The engine carries normalisation profiles for other
  languages, but English is the only one this build has been measured to
  follow, and unmeasured languages are absent rather than offered.
- **On-device.** No account, no API key, no audio upload. Your voice and your
  script never leave the machine.
- **The model is a separate download.** It is not in the installer. Install it
  from the Welcome screen or from Settings › Speech — about 128 MB to download
  and 162 MB on disk once unpacked, verified against a pinned digest.
- **Recognition is probabilistic.** It makes mistakes, and the prompter is
  built to trail you rather than guess ahead when it is unsure.

### On the stage

- **Takes open in Clean Take: just your script.** Diagnostic Take, a switch in
  Settings › Teleprompter, adds engine readouts and a strip of raw transcript
  to the glass for checking a rig or a script that will not follow.

### Updates

CandidCue checks for updates by itself: shortly after it opens and every six
hours while it runs. When one is available it says so in the main window and
installs it only when you choose **Install and Restart**. It never prompts,
downloads or restarts during a take, and never draws on the glass. Every update
is signed, and CandidCue refuses one that does not verify against the key it
was built with. Turn the automatic check off in Settings; **Help › Check for
Updates…** still works when you want it. On Linux, the AppImage updates itself;
a `.deb` install is pointed at the download page instead.

### Your data and the network

- **Local, and yours.** Scripts are Markdown files on your disk; settings,
  calibrations and session history are in a local database. There is no cloud
  copy and no server-side recovery.
- **No telemetry.** No analytics, no crash upload, no account and no licence
  check. CandidCue talks to the network for two things only: downloading the
  speech model when you ask it to, and the update check, which sends nothing
  but the request itself (the app's version, platform and architecture) to
  `updates.speakingglass.com`.
- **Back up your own work.** **Export all data** writes a checked, restorable
  archive of your scripts, their revisions and images, settings, calibrations
  and session history.

### Known limitations

- Voice following is English only.
- The speech model is downloaded separately, on first use.
- No cloud backup or sync.
- The Windows build is not code-signed.
- Dragging the reader-mode window to a display with different optics mid-take
  keeps the opening display's text scale until the take ends.
- Choppy-delivery detection does not report: the analysis deliberately emits no
  pause evidence rather than manufacturing findings it cannot support.
- The variety score omits tempo variation, terminal rush and emphasis contrast,
  and runs in a documented degraded mode as a result.

### Reporting problems

**Security issues** go to a private channel, not a public issue: open a
[private advisory](https://github.com/gregpriday/candidcue/security/advisories/new)
or email [greg@siteorigin.com](mailto:greg@siteorigin.com). The full policy is
in [SECURITY.md](https://github.com/gregpriday/candidcue/blob/main/.github/SECURITY.md).

**Everything else** goes to
[GitHub Issues](https://github.com/gregpriday/candidcue/issues). It helps to
include the version (About CandidCue, or Settings), your operating system, your
microphone and display setup, and what the prompter actually did.
