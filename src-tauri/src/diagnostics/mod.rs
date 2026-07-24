//! Diagnostics (spec §44.11): structured logs with redaction, rolling
//! retention, system/application facts, exportable support bundle. No API
//! key, audio, script, or transcript content by default. Stub.

#![allow(dead_code)]

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsSummary {
    pub app_version: String,
    pub os: String,
    pub arch: String,
}

pub fn summary(app: &tauri::AppHandle) -> DiagnosticsSummary {
    DiagnosticsSummary {
        app_version: app.package_info().version.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
    }
}
