//! The benchmark identity: a build that measures itself (issue #240).
//!
//! The unit budgets (`src/shared/perf-budget.ts`) take the fastest of several
//! warmed runs, which is what keeps them stable under parallel load and also
//! what makes them blind to a cold start or a tail. What a presenter waits
//! for — first launch, opening a long script, Present to the first readable
//! line, a long frame mid-take — can only be measured in the packaged app,
//! and nothing automated can drive a packaged WKWebView (Apple ships no
//! WebDriver). So the app drives itself: `scripts/perf-run.mjs` builds it
//! under a SEPARATE bundle identifier and launches it with
//! [`SCENARIO_ENV`] set, and the control window runs a fixed scenario
//! (`src/control/lib/perf/scenario.ts`) and reports through the existing
//! `log_client_diagnostic` command.
//!
//! Two rules keep that from ever touching somebody's real library:
//!
//! - The scenario arms ONLY under [`PERF_IDENTIFIER`]. The identifier decides
//!   the data folder (`dirs::data_dir()/identifier`), the WebKit store and the
//!   single-instance socket, so a perf build cannot open, focus or write the
//!   app people use. The environment variable on the production identifier
//!   is refused, not honoured.
//! - The perf identity never runs the CandidCue folder copy (`legacy_data`).
//!   Its whole point is a known, empty profile; copying the owner's old
//!   library into it would both measure the wrong thing and put a second copy
//!   of their scripts somewhere they never asked for one.
//!
//! The environment variable is required as well as the identifier so that
//! opening a perf build by hand is just an empty app rather than a scenario
//! that creates scripts and starts takes on its own.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Listener, Manager, Runtime};

/// The bundle identifier the benchmark build is made under
/// (`bench/perf/tauri.perf.conf.json`).
pub const PERF_IDENTIFIER: &str = "com.speakingglass.perf";

/// Set (to anything but an "off" word) by the runner to arm the scenario.
pub const SCENARIO_ENV: &str = "SPEAKING_GLASS_PERF_SCENARIO";

/// What the scenario emits when its last record is written. Rust answers by
/// asking to exit, which runs the same shutdown handshake ⌘Q does — the
/// page's stores are flushed, so the second launch of a pair really does find
/// what the first one saved. The control window has no permission to close
/// itself, and adding a command for it would widen every window's grant.
pub const FINISHED_EVENT: &str = "perf://finished";

/// Is this the benchmark identity at all? Decides the legacy-copy skip.
pub fn is_perf_identity(identifier: &str) -> bool {
    identifier == PERF_IDENTIFIER
}

/// Should the scenario run? Only the perf identity, and only when asked.
pub fn armed(identifier: &str, requested: Option<&str>) -> bool {
    let asked = match requested.map(|value| value.trim().to_ascii_lowercase()) {
        Some(value) => !value.is_empty() && !matches!(value.as_str(), "0" | "off" | "false" | "no"),
        None => false,
    };
    asked && is_perf_identity(identifier)
}

/// Decide once, from this process's identifier and environment, and say so
/// in the log when a request is refused: an env var that silently did nothing
/// would cost whoever set it an evening.
pub fn decide(identifier: &str) -> bool {
    let requested = std::env::var(SCENARIO_ENV).ok();
    let armed = armed(identifier, requested.as_deref());
    if requested.is_some() && !armed && !is_perf_identity(identifier) {
        eprintln!(
            "{SCENARIO_ENV} is ignored: the scenario runs only in a build made under {PERF_IDENTIFIER}"
        );
    }
    armed
}

/// The initialization script that tells the control page it is a benchmark.
/// `false` rather than absent, so the page can tell "Rust said no" from a
/// plain browser, as the window-material script does.
pub fn init_script(armed: bool) -> String {
    format!("window.__SPEAKING_GLASS_PERF__ = {armed};")
}

/// The plugin that carries the flag to every page and, when armed, turns the
/// scenario's finish into an orderly exit.
pub fn plugin<R: Runtime>(armed: bool) -> TauriPlugin<R> {
    Builder::new("perf-scenario")
        .js_init_script(init_script(armed))
        .setup(move |app, _api| {
            if armed {
                let handle = app.app_handle().clone();
                app.listen_any(FINISHED_EVENT, move |_event| {
                    tracing::info!("perf scenario finished; exiting");
                    handle.exit(0);
                });
            }
            Ok(())
        })
        .on_webview_ready(move |webview| {
            // In front of everything for the length of the run. The
            // scenario's clock is animation frames, and WKWebView stops them
            // for a window another one covers: on a desk somebody is using,
            // that froze a take until the runner killed it.
            if armed && webview.label() == crate::windows::CONTROL_LABEL {
                let _ = webview.window().set_always_on_top(true);
            }
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_scenario_arms_only_under_the_perf_identifier() {
        assert!(armed(PERF_IDENTIFIER, Some("1")));
        assert!(!armed("com.speakingglass.app", Some("1")));
        assert!(!armed("com.candidcue.app", Some("1")));
        assert!(!armed(PERF_IDENTIFIER, None));
    }

    #[test]
    fn an_off_word_or_an_empty_value_does_not_arm_it() {
        for value in ["", " ", "0", "off", "FALSE", "no"] {
            assert!(!armed(PERF_IDENTIFIER, Some(value)), "{value:?} armed the scenario");
        }
    }

    #[test]
    fn only_the_perf_identity_skips_the_legacy_copy() {
        assert!(is_perf_identity(PERF_IDENTIFIER));
        assert!(!is_perf_identity("com.speakingglass.app"));
    }

    #[test]
    fn the_init_script_states_the_flag_either_way() {
        assert_eq!(init_script(true), "window.__SPEAKING_GLASS_PERF__ = true;");
        assert_eq!(init_script(false), "window.__SPEAKING_GLASS_PERF__ = false;");
    }

    /// The identifier the runner builds under must be the one this module
    /// arms on; a typo in either would build an app that never measures.
    #[test]
    fn the_perf_build_config_uses_the_perf_identifier() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../bench/perf/tauri.perf.conf.json"))
                .expect("bench/perf/tauri.perf.conf.json is JSON");
        assert_eq!(config["identifier"], PERF_IDENTIFIER);
    }
}
