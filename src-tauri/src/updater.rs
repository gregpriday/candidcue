//! In-app updates: find, download, verify and install a newer Speaking Glass
//! (docs/updates.md, #191).
//!
//! ---------------------------------------------------------------------------
//! RUST OWNS THE NETWORK, AND THE WHOLE OF THE UPDATER
//! ---------------------------------------------------------------------------
//! `tauri-plugin-updater` is registered, but no webview holds an `updater:*` or
//! `process:*` permission and the JavaScript package is not installed. The
//! control window reaches the updater through two typed commands
//! (`commands/update_cmds.rs`) and nothing else, so everything that decides
//! WHETHER a check or an install may happen lives here, where a compromised or
//! confused renderer cannot skip it:
//!
//!   - the endpoint is one compile-time base URL, and the channel is derived
//!     from this binary's own version — never from an argument;
//!   - the signature is checked against the public key compiled into
//!     `tauri.conf.json` (`plugins.updater.pubkey`) before a byte is installed;
//!   - an install is REFUSED while a take is running or the control window is
//!     presenting ([`install_refusal`]), whatever the UI thought;
//!   - an install is refused on a build that cannot replace itself
//!     ([`install_support`]) — a `.deb`, a development build, an app running
//!     from a translocated quarantine copy — and the UI offers the download
//!     page instead;
//!   - an automatic check is refused when the user turned checks off
//!     (`commands/update_cmds.rs` reads the setting before calling [`check`]).
//!
//! ---------------------------------------------------------------------------
//! WHAT A CHECK SENDS
//! ---------------------------------------------------------------------------
//! One HTTPS `GET` of [`endpoint_for_version`], carrying what the request itself
//! carries and nothing else: the URL (channel, OS and architecture), a
//! `User-Agent: SpeakingGlass/<version>`, an `Accept` header, and the machine's IP
//! address. No identifier, no cookie, no body. `docs/network-inventory.md` is
//! the public statement of exactly this, and the test that guards it reads this
//! file.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::errors::{AppError, ErrorCategory, RecoveryAction};
use crate::windows::CONTROL_LABEL;

/// Where every update manifest lives. The ONE place the application names the
/// update host; `docs/network-inventory.md` names the same host, and
/// `tests/integration/network-inventory.test.ts` holds the two together.
///
/// As permanent as the signing key: it is compiled into every installed copy,
/// so moving it strands every copy that knows only the old one.
pub const UPDATE_BASE_URL: &str = "https://updates.speakingglass.com/releases/";

/// Rust → control: an install is downloading, installing or about to restart.
/// Mirrored verbatim in `src/shared/contracts/updates.ts`.
pub const UPDATE_PROGRESS_EVENT: &str = "update://progress";

/// How long a CHECK may take before it is reported as failed. Not applied to
/// the download, which is as large as the app and may be slow for minutes.
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);

/// How long the connection may go silent, during a check or a download, before
/// it is given up. A limit on silence rather than on the whole transfer: a slow
/// line still finishes, and a server that stops sending without closing the
/// connection no longer leaves the notice on "Downloading" forever with no way
/// to retry.
const READ_TIMEOUT: Duration = Duration::from_secs(60);

/// The least interval between two download-progress events. A download arrives
/// in thousands of chunks, and an event per chunk would be an IPC flood for a
/// progress bar that cannot draw that fast.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(150);

/* ------------------------------------------------------------------ channel */

/// Which stream of releases this build follows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    /// A release: `0.1.0`.
    Latest,
    /// A prerelease that says it is a beta: `0.2.0-beta.1`.
    Beta,
    /// Any other prerelease: `1.0.0-rc.1`, `0.3.0-alpha.2`.
    Rc,
}

impl Channel {
    pub fn as_str(self) -> &'static str {
        match self {
            Channel::Latest => "latest",
            Channel::Beta => "beta",
            Channel::Rc => "rc",
        }
    }
}

/// The channel a build follows, read from its OWN compiled version.
///
/// No prerelease part is `latest`; a prerelease that mentions `beta` (in any
/// case) is `beta`; every other prerelease — `rc`, `alpha`, anything — is `rc`.
/// Build metadata (`+…`) is not a prerelease and is ignored, so `1.0.0+abc` is a
/// release and `1.0.0-rc.1+beta` is still an rc.
///
/// Derived rather than chosen, so a build cannot be talked onto another stream:
/// a release only ever sees releases, and a release candidate sees release
/// candidates until it is replaced by a build whose version says otherwise.
pub fn channel_for_version(version: &str) -> Channel {
    let without_build = version.split('+').next().unwrap_or(version);
    match without_build.split_once('-') {
        None => Channel::Latest,
        Some((_, "")) => Channel::Latest,
        Some((_, prerelease)) if prerelease.to_ascii_lowercase().contains("beta") => {
            Channel::Beta
        }
        Some(_) => Channel::Rc,
    }
}

/// The manifest URL for a build of this version.
///
/// `{{target}}` and `{{arch}}` are the plugin's own placeholders, filled at
/// request time with `darwin`/`windows`/`linux` and `aarch64`/`x86_64`. The
/// release pipeline publishes one file per pair —
/// `releases/latest-darwin-aarch64.json` and so on — in the plugin's
/// dynamic-server format (`version`, `notes`, `pub_date`, `url`, `signature` at
/// the top level).
pub fn endpoint_for_version(version: &str) -> String {
    format!(
        "{UPDATE_BASE_URL}{}-{{{{target}}}}-{{{{arch}}}}.json",
        channel_for_version(version).as_str()
    )
}

/* ------------------------------------------------- can this copy install? */

/// How this copy of the application was packaged, as far as installing over it
/// is concerned. Our own enum rather than the bundler's, so the policy below is
/// a pure function a test can drive on every platform.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Packaging {
    MacApp,
    AppImage,
    Deb,
    Rpm,
    Nsis,
    Msi,
    /// A development build, or a binary run outside any installer's layout.
    Unknown,
}

/// What the running copy can do with an update it has found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallSupport {
    /// The updater can replace this copy in place and restart it.
    SelfInstall,
    /// It cannot; the UI offers the download page instead.
    DownloadPage,
}

/// Whether this copy can install an update over itself.
///
/// - **macOS**: only an `.app` bundle — the plugin swaps the whole bundle
///   directory, so a binary outside one (`cargo run`, `tauri dev`) would have
///   its build directory replaced by an app. A bundle macOS has TRANSLOCATED
///   (run from a quarantined download without being moved first) lives on a
///   read-only mount, and installing over it cannot succeed.
/// - **Windows**: only a copy an installer put there (NSIS or MSI). The plugin
///   runs the new installer, which closes this copy and reopens the new one.
/// - **Linux**: only an AppImage, and only when the process is really running
///   from one (`APPIMAGE` is set). The plugin CAN install a `.deb` or `.rpm` —
///   with `pkexec dpkg -i` — but only from a payload of that type, and the
///   release pipeline publishes one manifest per platform pointing at the
///   AppImage. Feeding that to `dpkg` fails with "invalid updater binary
///   format" after the whole download, so a package install is sent to the
///   download page before anything is fetched.
pub fn install_support(
    os: &str,
    packaging: Packaging,
    executable: &Path,
    running_from_appimage: bool,
) -> InstallSupport {
    let supported = match os {
        "macos" => packaging == Packaging::MacApp && is_inside_app_bundle(executable),
        "windows" => matches!(packaging, Packaging::Nsis | Packaging::Msi),
        "linux" => packaging == Packaging::AppImage && running_from_appimage,
        _ => false,
    };
    if supported {
        InstallSupport::SelfInstall
    } else {
        InstallSupport::DownloadPage
    }
}

/// `…/Speaking Glass.app/Contents/MacOS/speaking-glass`, and not translocated.
fn is_inside_app_bundle(executable: &Path) -> bool {
    let text = executable.to_string_lossy();
    if text.contains("/AppTranslocation/") {
        return false;
    }
    let Some(macos) = executable.parent() else { return false };
    let Some(contents) = macos.parent() else { return false };
    let Some(bundle) = contents.parent() else { return false };
    macos.file_name().is_some_and(|name| name == "MacOS")
        && contents.file_name().is_some_and(|name| name == "Contents")
        && bundle
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))
}

/// The running copy's packaging, from the marker the bundler patches into the
/// binary. macOS reports `App` even for a development binary, which is why
/// [`install_support`] also checks the path there.
fn current_packaging() -> Packaging {
    use tauri::utils::config::BundleType;
    match tauri::utils::platform::bundle_type() {
        Some(BundleType::App) | Some(BundleType::Dmg) => Packaging::MacApp,
        Some(BundleType::AppImage) => Packaging::AppImage,
        Some(BundleType::Deb) => Packaging::Deb,
        Some(BundleType::Rpm) => Packaging::Rpm,
        Some(BundleType::Nsis) => Packaging::Nsis,
        Some(BundleType::Msi) => Packaging::Msi,
        None => Packaging::Unknown,
    }
}

fn current_os() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "other"
    }
}

/// [`install_support`] for the process that is running.
pub fn current_install_support<R: Runtime>(app: &AppHandle<R>) -> InstallSupport {
    let executable = std::env::current_exe().unwrap_or_default();
    #[cfg(target_os = "linux")]
    let running_from_appimage = app.env().appimage.is_some();
    #[cfg(not(target_os = "linux"))]
    let running_from_appimage = {
        let _ = app;
        false
    };
    install_support(
        current_os(),
        current_packaging(),
        &executable,
        running_from_appimage,
    )
}

/* -------------------------------------------------- never during a take */

/// The refusal for an install attempted while a take is on, or `None`.
///
/// Two independent facts, either of which is enough:
///
///   - `presenting`: the control window has been reshaped into the prompter
///     (`windows/present.rs`). An install ends by restarting the app, which is
///     the glass going dark in front of somebody reading it.
///   - `take_running`: a session is open in the coordinator. A take exists from
///     the moment it starts arming, before the window has moved, and a take in
///     a separate stage window never presents the control window at all.
///
/// Pure so the rule is tested as a rule; [`take_gate`] supplies the facts.
pub fn install_refusal(presenting: bool, take_running: bool) -> Option<AppError> {
    if !(presenting || take_running) {
        return None;
    }
    Some(
        AppError::structured(
            "UPDATE_BLOCKED_BY_TAKE",
            ErrorCategory::Validation,
            "An update cannot be installed during a take. It will wait until the take ends.",
            true,
        )
        .with_log(format!(
            "install refused: presenting={presenting} take_running={take_running}"
        )),
    )
}

/// [`install_refusal`] for the application as it is right now.
fn take_gate<R: Runtime>(app: &AppHandle<R>) -> Result<(), AppError> {
    let presenting = crate::windows::present::is_presenting();
    let take_running = app
        .try_state::<crate::coordinator::AppCoordinator>()
        .is_some_and(|coordinator| coordinator.snapshot().session.session_id.is_some());
    match install_refusal(presenting, take_running) {
        Some(refusal) => Err(refusal),
        None => Ok(()),
    }
}

/// Set from the moment an install passes its last take check until the app
/// restarts, and cleared if the install fails instead.
///
/// [`take_gate`] alone is a snapshot: a take started a second after it passed
/// would be running when the restart lands. So the install claims this latch
/// and checks for a take as ONE step, and a take begins only through
/// [`begin_take_unless_restarting`], which reads the latch and records the
/// session as one step too. [`LIFECYCLE`] makes each of the two atomic with
/// respect to the other: whichever runs first, the second one sees it.
static RESTART_COMMITTED: AtomicBool = AtomicBool::new(false);

/// Held across "claim the restart, then look for a take" and across "look for
/// a restart, then record the take". Nothing else takes it, and neither side
/// awaits while holding it.
static LIFECYCLE: Mutex<()> = Mutex::new(());

fn lifecycle() -> std::sync::MutexGuard<'static, ()> {
    LIFECYCLE.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Record the start of a take with `begin`, unless an installed update is about
/// to restart the app, in which case `begin` is not called.
pub fn begin_take_unless_restarting<T>(begin: impl FnOnce() -> T) -> Result<T, AppError> {
    let _lifecycle = lifecycle();
    match restart_refusal() {
        Some(refusal) => Err(refusal),
        None => Ok(begin()),
    }
}

/// The refusal for a take started while an installed update is about to
/// restart the app, or `None`.
pub fn restart_refusal() -> Option<AppError> {
    if !RESTART_COMMITTED.load(Ordering::SeqCst) {
        return None;
    }
    Some(
        AppError::structured(
            "UPDATE_RESTART_PENDING",
            ErrorCategory::Validation,
            "Speaking Glass is restarting to finish installing an update. Start the take after it reopens.",
            true,
        )
        .with_log("take refused: an installed update is about to restart the app"),
    )
}

/// Holds [`RESTART_COMMITTED`] and lets it go again unless the install got as
/// far as restarting.
struct RestartCommitment {
    kept: bool,
}

impl RestartCommitment {
    fn claim() -> Self {
        RESTART_COMMITTED.store(true, Ordering::SeqCst);
        Self { kept: false }
    }

    fn keep(mut self) {
        self.kept = true;
    }
}

impl Drop for RestartCommitment {
    fn drop(&mut self) {
        if !self.kept {
            RESTART_COMMITTED.store(false, Ordering::SeqCst);
        }
    }
}

/// Run the quit handshake (`windows/shutdown.rs`) so the editor flushes before
/// the process goes away, and say whether this caller owns it.
///
/// The updater has to ask itself. Tauri ignores `prevent_exit` for a restart,
/// so the handshake the run loop starts on an ordinary quit never gets to wait
/// for a restart; and on Windows the plugin ends the process itself, with
/// `std::process::exit`, without an exit request at all. When a quit is
/// already flushing, this waits for it to finish instead of starting another.
fn flush_before_restart<R: Runtime>(app: &AppHandle<R>) -> bool {
    use crate::windows::shutdown::{run_shutdown_handshake, ShutdownState, SHUTDOWN_DEADLINE};
    if run_shutdown_handshake(app) {
        return true;
    }
    let deadline = Instant::now() + SHUTDOWN_DEADLINE + Duration::from_secs(1);
    while Instant::now() < deadline && !app.state::<ShutdownState>().is_finished() {
        std::thread::sleep(Duration::from_millis(20));
    }
    false
}

/* ------------------------------------------------------------------ state */

/// The update the last check found, held for the install that may follow.
///
/// Held in Rust rather than handed to the renderer: the install command takes
/// no argument, so the webview cannot name a URL, a signature or a version to
/// install — it can only say "install what you found".
#[derive(Default)]
pub struct UpdaterState {
    pending: Mutex<Option<Update>>,
    installing: AtomicBool,
}

impl UpdaterState {
    fn set_pending(&self, update: Option<Update>) {
        match self.pending.lock() {
            Ok(mut slot) => *slot = update,
            Err(poisoned) => *poisoned.into_inner() = update,
        }
    }

    fn pending(&self) -> Option<Update> {
        match self.pending.lock() {
            Ok(slot) => slot.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        }
    }
}

/// Clears the installing flag however the install ends — except by the process
/// exiting, which is the one ending that does not need it cleared.
struct InstallingGuard<'a>(&'a AtomicBool);

impl Drop for InstallingGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/* ---------------------------------------------------------------- results */

/// What a check found. `available: false` covers both "this is the newest
/// version" and "nothing is published on this channel yet".
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub available: bool,
    pub current_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    /// The manifest's `pub_date`, as the server wrote it (RFC 3339).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    /// False when this copy cannot replace itself; see [`install_support`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub can_install: Option<bool>,
}

impl UpdateCheckResult {
    pub fn none(current_version: String) -> Self {
        Self {
            available: false,
            current_version,
            version: None,
            notes: None,
            date: None,
            can_install: None,
        }
    }
}

/// Install progress, as the control window draws it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum UpdateProgress {
    #[serde(rename_all = "camelCase")]
    Downloading {
        downloaded: u64,
        /// `None` when the server sent no `Content-Length`.
        total: Option<u64>,
    },
    /// Downloaded and verified; replacing the app now.
    Installing,
    /// Installed; Speaking Glass is about to close and reopen.
    Restarting,
}

fn emit_progress<R: Runtime>(app: &AppHandle<R>, progress: UpdateProgress) {
    if let Err(err) = app.emit_to(CONTROL_LABEL, UPDATE_PROGRESS_EVENT, &progress) {
        tracing::debug!(error = %err, "update progress could not be delivered");
    }
}

/* ------------------------------------------------------------------ check */

/// Ask the update server whether a newer build exists on this build's channel.
///
/// A manifest that is not there — a 404 from a channel with no release yet, or
/// any other non-success status — is "no update", not an error: the plugin
/// reports it as `ReleaseNotFound`, and an error there would greet every user
/// of a fresh channel with a failure on every launch. A 204 is "no update" in
/// the plugin already.
pub async fn check<R: Runtime>(app: &AppHandle<R>) -> Result<UpdateCheckResult, AppError> {
    let current_version = app.package_info().version.to_string();
    let endpoint = endpoint_for_version(&current_version);
    let url: tauri::Url = endpoint.parse().map_err(|err| {
        AppError::Internal(format!("the update endpoint {endpoint} is not a URL: {err}"))
    })?;

    // The update this returns carries the hook and the client settings into
    // `install`. On Windows the plugin runs `on_before_exit` after the new
    // installer is on disk and just before it ends this process.
    let handshake_app = app.clone();
    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .and_then(|builder| builder.header("User-Agent", format!("SpeakingGlass/{current_version}")))
        .map(|builder| {
            builder
                .timeout(CHECK_TIMEOUT)
                .configure_client(|client| client.read_timeout(READ_TIMEOUT))
                .on_before_exit(move || {
                    flush_before_restart(&handshake_app);
                })
        })
        .and_then(|builder| builder.build())
        .map_err(check_error)?;

    let state = app.state::<UpdaterState>();
    match updater.check().await {
        Ok(Some(update)) => {
            let support = current_install_support(app);
            let result = UpdateCheckResult {
                available: true,
                current_version,
                version: Some(update.version.clone()),
                notes: update.body.clone().filter(|notes| !notes.trim().is_empty()),
                date: update
                    .raw_json
                    .get("pub_date")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
                can_install: Some(support == InstallSupport::SelfInstall),
            };
            tracing::info!(
                version = %update.version,
                can_install = support == InstallSupport::SelfInstall,
                "an update is available"
            );
            state.set_pending(Some(update));
            Ok(result)
        }
        Ok(None) => {
            state.set_pending(None);
            Ok(UpdateCheckResult::none(current_version))
        }
        Err(tauri_plugin_updater::Error::ReleaseNotFound) => {
            tracing::info!(%endpoint, "no update manifest is published for this build's channel");
            state.set_pending(None);
            Ok(UpdateCheckResult::none(current_version))
        }
        Err(err) => Err(check_error(err)),
    }
}

fn check_error(err: tauri_plugin_updater::Error) -> AppError {
    use tauri_plugin_updater::Error as E;
    match &err {
        // A manifest that arrived and does not make sense is the server's
        // fault, not the user's network — and saying "check your connection"
        // about it would send them to their router for nothing.
        E::Serialization(_)
        | E::Semver(_)
        | E::TargetNotFound(_)
        | E::TargetsNotFound(_)
        | E::UrlParse(_) => AppError::structured(
            "UPDATE_RESPONSE_INVALID",
            ErrorCategory::Network,
            "The update server sent an answer Speaking Glass could not read. Try again later.",
            true,
        ),
        _ => AppError::structured(
            "UPDATE_CHECK_FAILED",
            ErrorCategory::Network,
            "Speaking Glass could not reach the update server. Check your internet connection, then try again.",
            true,
        )
        .with_action(RecoveryAction::Retry),
    }
    .with_log(format!("update check failed: {err}"))
}

/* ---------------------------------------------------------------- install */

/// Download, verify and install the update the last check found, then restart.
///
/// Refused during a take, twice over: before the download, and again after it,
/// because a download takes long enough for a take to start in the middle of
/// it. Refused on a copy that cannot replace itself, and when no check has
/// found anything to install.
///
/// The signature is verified inside the plugin's `download`, against the public
/// key in `tauri.conf.json`, before `install` is ever called. An update whose
/// signature does not verify is never written anywhere the app would run it.
///
/// On macOS and Linux the files are replaced in place, the quit handshake runs
/// ([`flush_before_restart`]) so the editor flushes, and then the app restarts
/// into the new build. On Windows the plugin hands over to the NSIS installer
/// (`installMode: passive`, so a progress bar and no questions): the handshake
/// runs in `on_before_exit`, the plugin ends this process, and the installer
/// reopens the app when it is done, so `install` does not return there.
///
/// From the last take check on, `start_session` is refused
/// ([`restart_refusal`]), so no take can begin in the seconds before the
/// restart.
pub async fn install<R: Runtime>(app: &AppHandle<R>) -> Result<(), AppError> {
    take_gate(app)?;

    let state = app.state::<UpdaterState>();
    if state.installing.swap(true, Ordering::SeqCst) {
        return Err(AppError::structured(
            "UPDATE_BUSY",
            ErrorCategory::Validation,
            "An update is already being installed.",
            true,
        ));
    }
    let _guard = InstallingGuard(&state.installing);

    let Some(update) = state.pending() else {
        return Err(AppError::structured(
            "UPDATE_NOT_AVAILABLE",
            ErrorCategory::Validation,
            "There is no update waiting to be installed. Check for updates again.",
            true,
        ));
    };

    if current_install_support(app) != InstallSupport::SelfInstall {
        return Err(AppError::structured(
            "UPDATE_SELF_INSTALL_UNSUPPORTED",
            ErrorCategory::Validation,
            "This copy of Speaking Glass cannot update itself. Download the new version from speakingglass.com.",
            true,
        ));
    }

    tracing::info!(version = %update.version, "downloading update");
    emit_progress(app, UpdateProgress::Downloading { downloaded: 0, total: None });

    let progress_app = app.clone();
    let mut downloaded: u64 = 0;
    let mut last_emit = Instant::now();
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                let finished = total.is_some_and(|total| downloaded >= total);
                if finished || last_emit.elapsed() >= PROGRESS_INTERVAL {
                    last_emit = Instant::now();
                    emit_progress(&progress_app, UpdateProgress::Downloading { downloaded, total });
                }
            },
            || {},
        )
        .await
        .map_err(download_error)?;

    // A take may have started while the download ran. The verified bytes are
    // dropped rather than held: the next attempt checks the signature again.
    // The commitment and the check are one step, so a take that starts after
    // it is refused rather than cut off by the restart.
    let commitment = {
        let _lifecycle = lifecycle();
        let commitment = RestartCommitment::claim();
        take_gate(app)?;
        commitment
    };

    tracing::info!(version = %update.version, "update verified; installing");
    emit_progress(app, UpdateProgress::Installing);
    let installer = update.clone();
    let installed = tauri::async_runtime::spawn_blocking(move || installer.install(bytes))
        .await
        .map_err(|err| AppError::Internal(format!("the update installer stopped: {err}")))
        .and_then(|result| result.map_err(install_error));
    if let Err(err) = installed {
        // On Windows the plugin runs the quit handshake (`on_before_exit`)
        // before it launches the installer, and the launch can still fail.
        // The editor has flushed and the recogniser is stopped by then, and
        // the handshake does not run twice, so carrying on would leave the
        // next quit unflushed. Start again cleanly, on the current version.
        if app
            .state::<crate::windows::shutdown::ShutdownState>()
            .is_finished()
        {
            tracing::warn!("the update installer did not start after the app shut down; restarting");
            app.request_restart();
        }
        return Err(err);
    }

    // Only macOS and Linux get here: on Windows `install` ran the handshake in
    // `on_before_exit` and then ended the process.
    tracing::info!(version = %update.version, "update installed; restarting");
    emit_progress(app, UpdateProgress::Restarting);
    state.set_pending(None);
    commitment.keep();
    let flush_app = app.clone();
    let owner = tauri::async_runtime::spawn_blocking(move || flush_before_restart(&flush_app))
        .await
        .unwrap_or(false);
    // The editor has flushed, so the run loop lets this exit through at once.
    // A quit that was already under way owns the exit instead, and the new
    // version opens the next time Speaking Glass does.
    if owner {
        app.request_restart();
    }
    Ok(())
}

fn download_error(err: tauri_plugin_updater::Error) -> AppError {
    use tauri_plugin_updater::Error as E;
    match &err {
        E::Minisign(_)
        | E::Base64(_)
        | E::SignatureUtf8(_)
        | E::SignedVersionMismatch { .. }
        | E::MissingSignedVersion => AppError::structured(
            "UPDATE_SIGNATURE_INVALID",
            ErrorCategory::Validation,
            "The downloaded update did not pass its signature check, so it was not installed.",
            false,
        )
        .with_log(format!("update signature rejected: {err}")),
        _ => AppError::structured(
            "UPDATE_DOWNLOAD_FAILED",
            ErrorCategory::Network,
            "The update could not be downloaded. Check your internet connection, then try again.",
            true,
        )
        .with_action(RecoveryAction::Retry)
        .with_log(format!("update download failed: {err}")),
    }
}

fn install_error(err: tauri_plugin_updater::Error) -> AppError {
    AppError::structured(
        "UPDATE_INSTALL_FAILED",
        ErrorCategory::Storage,
        "The update was downloaded but could not be installed. Try again, or download the new version from speakingglass.com.",
        true,
    )
    .with_log(format!("update install failed: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn a_release_follows_latest() {
        assert_eq!(channel_for_version("0.1.0"), Channel::Latest);
        assert_eq!(channel_for_version("1.0.0"), Channel::Latest);
        assert_eq!(channel_for_version("12.40.3"), Channel::Latest);
    }

    #[test]
    fn build_metadata_is_not_a_prerelease() {
        assert_eq!(channel_for_version("1.0.0+20261019"), Channel::Latest);
        assert_eq!(channel_for_version("1.0.0+beta"), Channel::Latest);
        assert_eq!(channel_for_version("1.0.0-rc.1+beta"), Channel::Rc);
    }

    #[test]
    fn a_beta_follows_beta_whatever_its_spelling() {
        assert_eq!(channel_for_version("0.2.0-beta"), Channel::Beta);
        assert_eq!(channel_for_version("0.2.0-beta.3"), Channel::Beta);
        assert_eq!(channel_for_version("0.2.0-BETA.1"), Channel::Beta);
        assert_eq!(channel_for_version("0.2.0-public-beta.1"), Channel::Beta);
    }

    #[test]
    fn every_other_prerelease_follows_rc() {
        assert_eq!(channel_for_version("1.0.0-rc.1"), Channel::Rc);
        assert_eq!(channel_for_version("1.0.0-alpha.2"), Channel::Rc);
        assert_eq!(channel_for_version("1.0.0-nightly"), Channel::Rc);
        assert_eq!(channel_for_version("1.0.0-0.3.7"), Channel::Rc);
    }

    #[test]
    fn the_endpoint_is_one_host_and_the_plugins_own_placeholders() {
        assert_eq!(
            endpoint_for_version("0.1.0"),
            "https://updates.speakingglass.com/releases/latest-{{target}}-{{arch}}.json"
        );
        assert_eq!(
            endpoint_for_version("0.2.0-beta.1"),
            "https://updates.speakingglass.com/releases/beta-{{target}}-{{arch}}.json"
        );
        assert_eq!(
            endpoint_for_version("1.0.0-rc.1"),
            "https://updates.speakingglass.com/releases/rc-{{target}}-{{arch}}.json"
        );
    }

    /// The endpoint has to survive `Url` parsing with the placeholders intact
    /// (percent-encoded in the path, which the plugin also replaces), and has to
    /// stay https — the plugin refuses anything else in a release build.
    #[test]
    fn the_endpoint_parses_as_an_https_url() {
        let url: tauri::Url = endpoint_for_version("0.1.0").parse().expect("a URL");
        assert_eq!(url.scheme(), "https");
        assert_eq!(url.host_str(), Some("updates.speakingglass.com"));
        assert_eq!(
            url.path(),
            "/releases/latest-%7B%7Btarget%7D%7D-%7B%7Barch%7D%7D.json"
        );
    }

    /// The running binary's own version must map to a real channel file name,
    /// whatever the release engineer sets it to.
    #[test]
    fn this_build_has_a_channel() {
        let version = env!("CARGO_PKG_VERSION");
        let endpoint = endpoint_for_version(version);
        assert!(endpoint.starts_with(UPDATE_BASE_URL));
        assert!(["latest-", "beta-", "rc-"]
            .iter()
            .any(|prefix| endpoint[UPDATE_BASE_URL.len()..].starts_with(prefix)));
    }

    #[test]
    fn nothing_refuses_an_install_at_rest() {
        assert!(install_refusal(false, false).is_none());
    }

    /// The other half of "never during a take": once an install is committed,
    /// a take is refused, and a failed install lets takes start again.
    /// (`keep` is not exercised: it holds the latch for the life of the
    /// process, and this process runs every other test in the crate.)
    #[test]
    fn a_take_is_refused_only_while_an_install_is_committed() {
        let mut began = 0;
        assert!(begin_take_unless_restarting(|| began += 1).is_ok(), "no install: takes start");
        let commitment = RestartCommitment::claim();
        let refused = begin_take_unless_restarting(|| began += 1)
            .expect_err("a committed install must refuse a take");
        assert_eq!(refused.code(), "UPDATE_RESTART_PENDING");
        assert_eq!(began, 1, "a refused take must not be recorded at all");
        drop(commitment);
        assert!(
            begin_take_unless_restarting(|| began += 1).is_ok(),
            "an install that failed must not block takes"
        );
    }

    #[test]
    fn an_install_is_refused_while_presenting_or_during_a_take() {
        for (presenting, take_running) in [(true, false), (false, true), (true, true)] {
            let refusal = install_refusal(presenting, take_running)
                .unwrap_or_else(|| panic!("presenting={presenting} take={take_running} was allowed"));
            assert_eq!(refusal.code(), "UPDATE_BLOCKED_BY_TAKE");
        }
    }

    /// The gate reads the REAL presentation latch and the REAL coordinator, so
    /// a take recorded in the coordinator refuses an install even though no
    /// window has moved yet.
    #[test]
    fn the_live_gate_refuses_while_the_coordinator_holds_a_session() {
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        handle.manage(crate::coordinator::AppCoordinator::default());
        assert!(take_gate(&handle).is_ok(), "no take, no presentation: allowed");

        handle
            .state::<crate::coordinator::AppCoordinator>()
            .begin_session("session-1".into(), "script-1".into(), None);
        let refused = take_gate(&handle).expect_err("a running take must refuse an install");
        assert_eq!(refused.code(), "UPDATE_BLOCKED_BY_TAKE");

        handle
            .state::<crate::coordinator::AppCoordinator>()
            .end_session("session-1");
        assert!(take_gate(&handle).is_ok(), "the take ended, so the install may go ahead");
    }

    #[test]
    fn a_mac_app_bundle_installs_itself() {
        let exe = PathBuf::from("/Applications/Speaking Glass.app/Contents/MacOS/speaking-glass");
        assert_eq!(
            install_support("macos", Packaging::MacApp, &exe, false),
            InstallSupport::SelfInstall
        );
    }

    #[test]
    fn a_mac_development_binary_does_not() {
        // The plugin would replace the parent DIRECTORY of this binary — the
        // whole cargo target directory — with the downloaded app.
        let exe = PathBuf::from("/Users/me/speaking-glass/src-tauri/target/debug/speaking-glass");
        assert_eq!(
            install_support("macos", Packaging::MacApp, &exe, false),
            InstallSupport::DownloadPage
        );
    }

    #[test]
    fn a_translocated_mac_app_does_not() {
        let exe = PathBuf::from(
            "/private/var/folders/x/AppTranslocation/ABC/d/Speaking Glass.app/Contents/MacOS/speaking-glass",
        );
        assert_eq!(
            install_support("macos", Packaging::MacApp, &exe, false),
            InstallSupport::DownloadPage
        );
    }

    #[test]
    fn windows_installs_only_what_an_installer_put_there() {
        let exe = PathBuf::from(r"C:\Program Files\Speaking Glass\speaking-glass.exe");
        assert_eq!(
            install_support("windows", Packaging::Nsis, &exe, false),
            InstallSupport::SelfInstall
        );
        assert_eq!(
            install_support("windows", Packaging::Msi, &exe, false),
            InstallSupport::SelfInstall
        );
        assert_eq!(
            install_support("windows", Packaging::Unknown, &exe, false),
            InstallSupport::DownloadPage
        );
    }

    #[test]
    fn linux_installs_only_a_running_appimage() {
        let exe = PathBuf::from("/tmp/.mount_CandidXyz/usr/bin/speaking-glass");
        assert_eq!(
            install_support("linux", Packaging::AppImage, &exe, true),
            InstallSupport::SelfInstall
        );
        // Bundled as an AppImage but not running from one (extracted).
        assert_eq!(
            install_support("linux", Packaging::AppImage, &exe, false),
            InstallSupport::DownloadPage
        );
    }

    /// The .deb finding, as a test: the plugin's deb path would be fed the
    /// AppImage the pipeline publishes, so a package install is sent to the
    /// download page instead of downloading something it cannot install.
    #[test]
    fn a_linux_package_install_is_sent_to_the_download_page() {
        let exe = PathBuf::from("/usr/bin/speaking-glass");
        for packaging in [Packaging::Deb, Packaging::Rpm, Packaging::Unknown] {
            assert_eq!(
                install_support("linux", packaging, &exe, false),
                InstallSupport::DownloadPage,
                "{packaging:?}"
            );
        }
    }

    #[test]
    fn a_check_result_serialises_in_the_shape_the_frontend_reads() {
        let none = serde_json::to_value(UpdateCheckResult::none("0.1.0".into())).unwrap();
        assert_eq!(none, serde_json::json!({ "available": false, "currentVersion": "0.1.0" }));

        let found = serde_json::to_value(UpdateCheckResult {
            available: true,
            current_version: "0.1.0".into(),
            version: Some("0.2.0".into()),
            notes: Some("Faster following.".into()),
            date: Some("2026-10-19T12:00:00Z".into()),
            can_install: Some(true),
        })
        .unwrap();
        assert_eq!(
            found,
            serde_json::json!({
                "available": true,
                "currentVersion": "0.1.0",
                "version": "0.2.0",
                "notes": "Faster following.",
                "date": "2026-10-19T12:00:00Z",
                "canInstall": true,
            })
        );
    }

    #[test]
    fn progress_serialises_as_a_tagged_phase() {
        assert_eq!(
            serde_json::to_value(UpdateProgress::Downloading { downloaded: 10, total: Some(20) })
                .unwrap(),
            serde_json::json!({ "phase": "downloading", "downloaded": 10, "total": 20 })
        );
        assert_eq!(
            serde_json::to_value(UpdateProgress::Installing).unwrap(),
            serde_json::json!({ "phase": "installing" })
        );
        assert_eq!(
            serde_json::to_value(UpdateProgress::Restarting).unwrap(),
            serde_json::json!({ "phase": "restarting" })
        );
    }

    /// The event name and the base URL are spelled once in TypeScript too.
    #[test]
    fn the_typescript_contract_names_the_same_event() {
        let ts = include_str!("../../src/shared/contracts/updates.ts");
        assert!(
            ts.contains(&format!("'{UPDATE_PROGRESS_EVENT}'")),
            "UPDATE_PROGRESS_EVENT is spelled differently in src/shared/contracts/updates.ts"
        );
    }

    /// The public key in `tauri.conf.json` is the project's, and the config
    /// never turns on anything a throwaway test setup needs.
    #[test]
    fn the_committed_config_pins_the_project_key_and_nothing_dangerous() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json parses");
        let updater = &conf["plugins"]["updater"];
        assert_eq!(
            updater["pubkey"].as_str(),
            Some(
                "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDMwMUY0OEQwQTgwMThFNDcKUldSSGpnR28wRWdmTUJVY1NUbzdvaE1xKzRrelhqM2VoUnhPKy92V1pJOFo0MmV3SFBuZFJmU0sK"
            ),
            "the updater must trust the project's key and no other"
        );
        assert_eq!(updater["windows"]["installMode"].as_str(), Some("passive"));
        for key in [
            "dangerousInsecureTransportProtocol",
            "dangerousAcceptInvalidCerts",
            "dangerousAcceptInvalidHostnames",
            "allowDowngrades",
            "endpoints",
        ] {
            assert!(
                updater.get(key).is_none(),
                "plugins.updater.{key} is set in the committed config; the endpoint is \
                 UPDATE_BASE_URL in updater.rs and nothing may loosen transport or downgrades"
            );
        }
        // The release workflow turns this on with `tauri build --config`, so a
        // build without the private key still works.
        assert!(
            conf["bundle"].get("createUpdaterArtifacts").is_none(),
            "bundle.createUpdaterArtifacts must stay out of the committed config"
        );
    }
}
