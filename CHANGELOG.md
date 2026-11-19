# Changelog

Release notes for Speaking Glass. The release workflow publishes the section
matching the tag it is building (a release candidate such as `v0.1.0-rc.1`
reads the `v0.1.0` section unless it has its own), so **a release with no
section here does not ship** — see `scripts/release-notes.mjs`.

Each version gets a `## v<version>` heading, newest first. Write for somebody
deciding whether to install it, not for somebody reading the diff.

## v0.1.0

The first public release. Speaking Glass is free and open source under the MIT
licence.

Speaking Glass is a voice-following teleprompter. You write a script in Markdown, it
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
  **Run anyway**. A preview: before release an automated check installs it
  and sees the app stay up, but this installer has not yet followed a voice
  with a real microphone. Windows 10 should work but has not been tested.
- **Linux, 64-bit**, as an AppImage or a `.deb`, built on Ubuntu 22.04 and
  needing that release's libraries or newer (WebKitGTK 4.1). A preview, like
  Windows: both packages have run only in an X11 (Xvfb) test container, and
  neither has followed a voice; a real desktop, Wayland and two monitors are
  untested.
- **A microphone**, and **a second display** for a prompter rig. A reading
  window, or a full-screen prompter on the same screen, works on one display.

### Speech recognition

- **English only.** English is the only language the alignment engine
  normalises and the only one it has been measured to follow.
- **On-device.** No account, no API key, no audio upload. Recognition runs on
  your computer, so your voice and your script are not sent anywhere.
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

Speaking Glass checks for updates by itself: shortly after it opens and every six
hours while it runs. When one is available it says so in the main window and
installs it only when you choose **Install and Restart**. It never prompts,
installs or restarts during a take, and never draws on the glass. Every update
is signed, and Speaking Glass refuses one that does not verify against the key it
was built with. Turn the automatic check off in Settings; **Help › Check for
Updates…** still works when you want it. On Linux, the AppImage installs
updates itself;
a `.deb` install is pointed at the download page instead.

### Your data and the network

- **Local, and yours.** Scripts are Markdown files on your disk; settings,
  calibrations and session history are in a local database. There is no cloud
  copy and no server-side recovery.
- **No telemetry.** No analytics, no crash upload, no account and no licence
  check. Speaking Glass talks to the network for three things only:
  downloading the speech model when you ask it to; the update check, which
  sends nothing but the request itself (the app's version, release channel,
  platform and architecture) to `updates.speakingglass.com`; and downloading an
  update when you choose to install one. The
  [network inventory](https://github.com/gregpriday/candidcue/blob/HEAD/docs/network-inventory.md)
  lists exactly what each request sends.
- **Back up your own work.** **Export all data** writes a checksummed backup
  folder of your scripts, their revisions and images, settings, calibrations
  and session history. A complete export can be restored from Settings.

### Known limitations

- Voice following is English only.
- The speech model is a separate download, which you start yourself.
- No cloud backup or sync.
- The Windows build is not code-signed.
- The Windows and Linux builds are previews: none of their installers has
  followed a voice with a real microphone yet.
- Dragging a reading window to a display with different optics mid-take
  keeps the opening display's text scale until the take ends.

### Reporting problems

**Security issues** go to a private channel, not a public issue: open a
[private advisory](https://github.com/gregpriday/candidcue/security/advisories/new)
or email [greg@siteorigin.com](mailto:greg@siteorigin.com). The full policy is
in [SECURITY.md](https://github.com/gregpriday/candidcue/blob/HEAD/.github/SECURITY.md).

**Everything else** goes to
[GitHub Issues](https://github.com/gregpriday/candidcue/issues);
**Help › Report a Problem** opens GitHub's new-issue form in your browser. It helps to
include the version (About Speaking Glass, or Settings), your operating system, your
microphone and display setup, and what the prompter actually did.
