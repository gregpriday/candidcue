//! Diagnostics (spec §44.11): structured logs with redaction, rolling
//! retention, system/application facts, exportable support bundle. No API
//! key, audio, script, or transcript content by default.
//!
//! The logs and their retention live in `logging`. Redaction does not exist
//! yet, and `logging`'s closing comment says why that is a decision rather
//! than a gap.

use serde::Serialize;

// `pub` rather than `pub(crate)`: the support-bundle privacy canaries in
// `tests/backup_tests.rs` drive `copy_support_logs` directly. That test is the
// only thing standing between "callers pass step names, not user content" —
// a convention — and a script line reaching a file the user emails to support.
pub mod logging;

/// The module-wide `allow(dead_code)` that used to sit at the top of this file
/// is scoped to these two instead: `get_system_diagnostics` builds its own,
/// wider struct, so this pair has no caller yet. Left narrow deliberately —
/// blanketing the module would also silence dead code in `logging`, which is
/// the part that has to keep working.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsSummary {
    pub app_version: String,
    pub os: String,
    pub arch: String,
}

#[allow(dead_code)]
pub fn summary(app: &tauri::AppHandle) -> DiagnosticsSummary {
    DiagnosticsSummary {
        app_version: app.package_info().version.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
    }
}
