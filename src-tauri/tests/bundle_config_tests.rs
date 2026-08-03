//! `bundle.targets` is pinned to the macOS formats, and stays pinned until a
//! real build matrix proves the other platforms (issue #182).
//!
//! The config used to say `"targets": "all"`, which asks the bundler for every
//! format the host can produce. Nothing in the tree backs that breadth up.
//! There is no checked-in build matrix — no `.github/`, no CI of any kind — so
//! no Windows or Linux build is ever run automatically, and three things are
//! correspondingly unevidenced off macOS:
//!
//!  - `src/windows/present.rs` records a latent non-macOS compile defect in
//!    its own comment: the `#[cfg(not(target_os = "macos"))] mod pin` arm was
//!    missing a `use super::presentation_failed`, without which the whole arm
//!    is an unresolved-name error. It was corrected in passing while writing a
//!    sibling arm — by inspection, not by a build that failed.
//!  - `src/windows/sleep.rs` has no display-sleep implementation for anything
//!    that is not macOS or Windows. `Assertion::create` returns `None` there,
//!    so `acquire` logs "could not block display sleep for this take" and
//!    carries on; whether the panel then blanks mid-take is left to the
//!    system's own sleep policy.
//!  - `cc-stt` pulls `sherpa-onnx`, which selects and links a prebuilt ONNX
//!    runtime per target. Nothing here demonstrates that link resolving on a
//!    Windows or Linux host.
//!
//! What this is NOT: a behaviour change. `tauri-bundler` is single-host and
//! resolves `"all"` against the formats the current OS can actually produce,
//! so on macOS `"all"` was already emitting `app` + `dmg` and nothing else.
//! The pin changes what the config *promises*, not what it currently produces
//! — it stops the configuration from opting into Windows and Linux package
//! formats no build has exercised.
//!
//! Why `app` is listed and not just `dmg`: the bundler builds the `.app` as a
//! prerequisite of the disk image either way, but deletes it afterwards unless
//! the `app` target was asked for. Naming both is what keeps the standalone
//! `.app` in `bundle/macos/` alongside the `.dmg`.
//!
//! Why the rationale is here rather than beside the value it guards: Tauri's
//! `BundleConfig` is `deny_unknown_fields` (`additionalProperties: false` in
//! the published schema), so the `_comment` trick used further up the same
//! file — inside the asset-protocol scope, whose type does accept extra keys —
//! would make the whole config fail to parse. JSON has nowhere to put a
//! reason, so the reason lives in a test that fails when the reason stops
//! applying.

/// Widening this list is a claim that a platform works. Make the claim
/// deliberately.
///
/// Compared as a set, not a sequence. What is being pinned is which formats
/// are requested — no additions, no omissions, no duplicates. The bundler
/// sorts package types into its own dependency order before building
/// (`app` ahead of `dmg` regardless of how they were written), so the order in
/// this file carries no meaning and a reordering is not a regression worth
/// failing on. Membership is.
///
/// Note the contrast with the neighbouring assertion on `bundle.resources`
/// (`speech::tests::the_stock_bundle_ships_no_speech_model`), which
/// deliberately checks *reachability* rather than any form of equality: there
/// the failure mode is a model payload creeping back in under one of a dozen
/// spellings, so an exact check would be trivially evaded. Here the failure
/// mode is the opposite — the list simply growing — and enumerating exactly
/// what may appear is what catches it.
///
/// To unpin: build on a real Windows and Linux host, confirm the crate
/// compiles and `sherpa-onnx` links, decide what the `sleep` and `present`
/// cfg arms should actually do on that platform, and only then add the format
/// here. A green run on this machine is not evidence about any other one.
#[test]
fn bundle_targets_stay_macos_only_until_other_hosts_are_proven() {
    let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
        .expect("tauri.conf.json must be valid JSON");

    let targets = config
        .get("bundle")
        .and_then(|bundle| bundle.get("targets"))
        .expect("bundle.targets must be declared explicitly, not left to the default");

    // `"all"` is the value this guards against first, and it is not an array —
    // so name it before the shape check turns it into a confusing type error.
    assert!(
        targets != "all",
        "bundle.targets is `all`, which asks for every format the host can \
         produce. On macOS that happens to be app + dmg, so it looks harmless \
         right up until the build runs somewhere else. Name the formats \
         instead. See issue #182."
    );

    let mut requested: Vec<&str> = targets
        .as_array()
        .unwrap_or_else(|| {
            panic!("bundle.targets must be a list of bundle formats, found: {targets}")
        })
        .iter()
        .map(|entry| {
            entry
                .as_str()
                .unwrap_or_else(|| panic!("every bundle target must be a string, found: {entry}"))
        })
        .collect();
    requested.sort_unstable();

    assert_eq!(
        requested,
        ["app", "dmg"],
        "bundle.targets is pinned to the macOS formats until a build matrix \
         proves the others. No non-macOS host has been shown to compile \
         windows/present.rs's cfg arm or to link sherpa-onnx's prebuilt \
         runtime, and off macOS and Windows there is no display-sleep \
         implementation at all. Adding a Windows or Linux format here claims \
         otherwise. See issue #182. Found: {targets}"
    );
}
