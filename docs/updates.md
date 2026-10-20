# How CandidCue updates

CandidCue finds, downloads, verifies and installs its own updates, from the
project's update host, through `tauri-plugin-updater`. The user decides when an
update is installed, and it is never installed during a take.

Everything below is the *current* behaviour, not a plan.
`docs/network-inventory.md` is the public statement of what the check sends and
where; this file is how the mechanism works.

## What the app does

**It checks.** About 15 seconds after launch, and then every 6 hours while it
runs, the control window asks Rust to check — when **Settings › Data, privacy &
updates › Check for updates automatically** is on, which is the default. **Help
› Check for Updates…** checks at any time, whatever the switch says; asking is
consent to that one request.

A check is one HTTPS `GET` of the manifest for this build's channel, platform
and architecture:

```
https://updates.speakingglass.com/releases/<channel>-<os>-<arch>.json
```

with `User-Agent: CandidCue/<version>`, `Accept: application/json` and, as any
request does, the user's IP address. No body, no cookie, no identifier.

**It shows a notice, and waits.** When a newer version is found, a quiet card in
the bottom corner of the document window offers **Install and Restart** or
**Later**. It is not a native dialog and it is not in the toast stack, because
both can be drawn over the glass. **Later** hides it for that version until the
next launch; choosing **Check for Updates…** again shows it again. A manual
check that finds nothing says "CandidCue is up to date (<version>)", and one
that fails says why in plain language. An automatic check that fails says
nothing and runs again at the next tick.

**It installs only when asked.** **Install and Restart** flushes the editor
(an install is refused if a script could not be saved), downloads the payload
with a progress bar, verifies its signature, installs it, and restarts. A
download whose connection goes silent for a minute fails and can be retried.

Rust runs the quit handshake itself just before the process goes away
(`updater::flush_before_restart`), so whatever was typed during the download
is saved as it would be on ⌘Q. It has to: Tauri ignores `prevent_exit` for a
restart, so the handshake an ordinary quit starts could not hold it.

- **macOS**: the `.app` bundle is replaced in place, the handshake runs, then
  the app restarts. If the app sits somewhere the user cannot write, macOS
  asks for an administrator password.
- **Windows**: the plugin writes the new installer, runs the handshake in its
  `on_before_exit` hook, and hands over to the NSIS installer in `passive`
  mode (a progress bar and no questions), which reopens CandidCue when it is
  done. The install call does not return.
- **Linux**: an AppImage is replaced in place, the handshake runs, and the app
  restarts. See below for `.deb`.

## Never during a take, never on the glass

Present reshapes the control window itself into the prompter
(`src/control/lib/start-take.ts`, `src-tauri/src/windows/present.rs`), so
anything the updater drew there during a take would be on the glass. The rule is
enforced twice:

- **In Rust.** `install_update` refuses with `UPDATE_BLOCKED_BY_TAKE` while the
  control window is presenting (`present::is_presenting`) or a take's session is
  open in the coordinator — and checks again after the download, because a take
  can start while one runs (`updater::install_refusal`, unit-tested). From that
  last check until the restart, `start_session` refuses a new take with
  `UPDATE_RESTART_PENDING` (`updater::restart_refusal`), so no take can begin
  in the seconds the install and restart take.
- **In the window.** The notice renders nothing from the moment a take starts
  arming until the glass is gone (`takeStarting`, `session.active`, the
  presenting phase). An update found during a take is held, not dropped, and
  the notice appears when the take ends. A manual check's toast is dropped if a
  take started while it ran. Help › Check for Updates… is greyed out during a
  take, like the Help menu's web links.

## Channels and the endpoint

The channel is derived from the build's own compiled version
(`updater::channel_for_version`), never chosen:

| Version | Channel | Manifest |
|---|---|---|
| `0.1.0` (no prerelease) | `latest` | `releases/latest-<os>-<arch>.json` |
| `0.2.0-beta.1` (prerelease containing `beta`) | `beta` | `releases/beta-<os>-<arch>.json` |
| `1.0.0-rc.1`, `0.3.0-alpha.2` (any other prerelease) | `rc` | `releases/rc-<os>-<arch>.json` |

`<os>` and `<arch>` are the plugin's `{{target}}` and `{{arch}}`: `darwin`,
`windows` or `linux`, and `aarch64` or `x86_64`. The base,
`https://updates.speakingglass.com/releases/`, is one constant
(`UPDATE_BASE_URL` in `src-tauri/src/updater.rs`). It is compiled into every
installed copy, so it is as permanent as the signing key.

The release pipeline publishes one file per platform in the plugin's
dynamic-server format — `version`, `notes`, `pub_date`, `url` and `signature` at
the top level, where `signature` is the contents of the `.sig` file the bundler
writes:

```json
{
  "version": "0.1.0",
  "notes": "…",
  "pub_date": "2026-10-19T12:00:00Z",
  "url": "https://updates.speakingglass.com/releases/0.1.0/<payload>",
  "signature": "<contents of the .sig file>"
}
```

`latest-darwin-aarch64.json` and `latest-darwin-x86_64.json` both point at the
universal macOS payload. A manifest that is not there — a channel with nothing
published yet answers 404 — is "no update", not an error, and so is a `204`.

## Signatures

Every payload is verified against the minisign public key in
`src-tauri/tauri.conf.json` (`plugins.updater.pubkey`) before anything is
installed; a payload that does not verify is rejected with
`UPDATE_SIGNATURE_INVALID` and never written where the app would run it.

- **The private key never enters the repository.** It is the CI secret
  `TAURI_SIGNING_PRIVATE_KEY` (with `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`).
  Losing it strands every installed copy on its current version, because a copy
  accepts only updates signed by the key it shipped with.
- **The committed config does not set `bundle.createUpdaterArtifacts`.** The
  release workflow turns it on with `tauri build --config`, so a local or CI
  build without the private key still builds.
- **For local testing**, generate a throwaway keypair with
  `pnpm tauri signer generate` outside the repository and build with its public
  key passed through `--config`. Never commit either half.

## What Rust owns

The webviews hold no `updater:*` or `process:*` permission, and the JavaScript
updater package is not installed. The control window reaches the updater
through two commands and one event (`src/shared/contracts/updates.ts`):

| Surface | Shape |
|---|---|
| `check_for_update { automatic }` | `{ available: false, currentVersion }` or `{ available: true, version, currentVersion, notes?, date?, canInstall }` |
| `install_update` | no argument; installs what the last check found, then restarts |
| `update://progress` (Rust → control) | `{ phase: 'downloading', downloaded, total }`, `{ phase: 'installing' }`, `{ phase: 'restarting' }` |

Neither command takes a URL, a version or a signature. An automatic check is
refused in Rust (`UPDATE_CHECK_DISABLED`) when the switch is off, so turning it
off is a promise about the network kept by the code that owns the network.

## A copy that cannot replace itself

`updater::install_support` decides whether this copy can install over itself.
When it cannot, the notice offers **Download**, which opens
`https://candidcue.com` (`open_web_destination("download")`, the same named path
Help › Download Latest Version uses) instead of **Install and Restart**:

- **Linux `.deb` (and `.rpm`).** The plugin can install a `.deb` — with
  `pkexec dpkg -i` — but only from a `.deb` payload, and the pipeline publishes
  one manifest per platform pointing at the AppImage. Fed to `dpkg`, that fails
  after the whole download with "invalid updater binary format". So a package
  install checks normally and is sent to the download page instead. If the
  pipeline ever publishes per-bundle manifests (the plugin's `{{bundle_type}}`
  placeholder), `.deb` self-update becomes possible.
- **A development build** (`tauri dev`, `cargo run`), which the plugin would
  "install" over its build directory.
- **A macOS app run from a translocated quarantine copy**, which lives on a
  read-only mount.

## Turning it off

**Settings › Data, privacy & updates › Check for updates automatically.** Off,
CandidCue contacts the update host only when the user chooses Help › Check for
Updates…. The setting is Rust-owned (`general.checkForUpdates`), so a cleared
browser store cannot turn it back on.

## Updating by hand

Download the new build from <https://candidcue.com> and replace the app.
Scripts, revisions, assets, settings, calibrations, the database and the
installed speech model all live in the application data directory, not in the
bundle, so replacing the app — by hand or through the updater — touches none of
them.
