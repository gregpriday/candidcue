//! Application updates (spec §44.10): signed updater integration, release
//! channels, never install during Live. Stub — the updater plugin is not
//! wired yet.

#![allow(dead_code)]

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateCheckCadence {
    Off,
    OnLaunch,
    Daily,
    Weekly,
}

impl Default for UpdateCheckCadence {
    /// Spec Appendix A.1 default.
    fn default() -> Self {
        UpdateCheckCadence::Daily
    }
}
