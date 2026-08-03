//! `bundle.targets` is pinned to the macOS formats, and stays pinned until a
//! real build matrix proves the other platforms (issue #182).
//!
//! The config used to say `"targets": "all"`. Nothing backed that up. This app
//! has only ever been built, run and measured on macOS, and three separate
//! things are unproven anywhere else:
//!
//!  - `src/windows/present.rs` carries a `#[cfg(not(target_os = "macos"))]`
//!    module whose own comment admits no non-macOS target has ever compiled
//!    the file. It was last corrected by inspection, not by a build — which is
//!    to say it is correct in the way unexecuted code is always correct.
//!  - `src/windows/sleep.rs` has three arms: macOS, Windows, and a catch-all
//!    no-op that Linux lands in. There, the display-sleep assertion silently
//!    does nothing and the panel blanks in the middle of a take.
//!  - `cc-stt` pulls `sherpa-onnx`, whose prebuilt ONNX runtime is linked
//!    per-platform. That link has never been attempted off macOS.
//!
//! With no CI, nothing would have caught any of it.
//!
//! What this is NOT: a behaviour change. `tauri-bundler` is single-host and
//! already filters `"all"` down to the formats the current OS's native tooling
//! can produce, so on macOS `"all"` was only ever emitting `app` + `dmg`
//! anyway. The pin changes what the config *promises*, not what it currently
//! produces — it stops the configuration from opting into Windows and Linux
//! package formats that no build has ever exercised.
//!
//! Why the rationale is here rather than beside the value it guards: Tauri's
//! `BundleConfig` is `deny_unknown_fields` (`additionalProperties: false` in
//! the published schema), so the `_comment` trick used further up the same
//! file — inside the asset-protocol scope, whose type does accept extra keys —
//! would make the whole config fail to parse. JSON has nowhere to put a
//! reason, so the reason lives in a test that fails when the reason stops
//! applying.

use serde_json::json;

/// Widening this list is a claim that a platform works. Make the claim
/// deliberately.
///
/// Note the shape of the assertion. The neighbouring test on
/// `bundle.resources` (`speech::tests::the_stock_bundle_ships_no_speech_model`)
/// deliberately checks *containment* rather than equality, because there the
/// failure mode is a payload sneaking back in under any of a dozen spellings.
/// Here the opposite is true: the whole point is that this list does not grow.
/// Any addition — `msi`, `nsis`, `deb`, `rpm`, `appimage` — is exactly the
/// event worth failing on, so the assertion is exact equality and nothing
/// weaker would do the job.
///
/// To unpin: build on a real Windows and Linux host, confirm the crate
/// compiles and `sherpa-onnx` links, decide what the sleep and present cfg
/// arms should actually do on that platform, and only then add the format
/// here. A green run on this machine is not evidence about any other one.
#[test]
fn bundle_targets_stay_macos_only_until_other_hosts_are_proven() {
    let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
        .expect("tauri.conf.json must be valid JSON");

    let targets = config
        .get("bundle")
        .and_then(|bundle| bundle.get("targets"))
        .expect("bundle.targets must be declared explicitly, not left to the default");

    assert_eq!(
        *targets,
        json!(["app", "dmg"]),
        "bundle.targets is pinned to the macOS formats until a build matrix \
         proves the others. `all` and any Windows/Linux format are what this \
         guards against: no non-macOS target has ever compiled \
         windows/present.rs's cfg arm or linked sherpa-onnx, and on Linux the \
         display-sleep assertion in windows/sleep.rs is a no-op. See issue \
         #182. Found: {targets}"
    );
}

/// `"all"` specifically, called out on its own.
///
/// The exact-equality test above already fails on `"all"`, but it fails the
/// same way it would for a stray typo. This one names the regression, so the
/// output says which mistake was made rather than only that two values
/// differed. It is the value the field held before #182, and the value a
/// contributor reaching for "why isn't it building a .msi" would most
/// naturally put back.
#[test]
fn bundle_targets_is_not_the_all_wildcard() {
    let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
        .expect("tauri.conf.json must be valid JSON");

    assert_ne!(
        config["bundle"]["targets"],
        json!("all"),
        "`all` asks the bundler for every format the host can produce. On \
         macOS that happens to be app + dmg, so this looks harmless right up \
         until someone runs the build on Windows or Linux, where it would \
         attempt package formats this codebase has never compiled for. Name \
         the formats instead."
    );
}
