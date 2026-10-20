//! `bundle.targets` is pinned to the macOS formats in the shared config, to
//! the NSIS installer in the Windows overlay (`tauri.windows.conf.json`, which
//! Tauri merges over the shared file when building on Windows), and to the
//! `.deb` and the AppImage in the Linux overlay (`tauri.linux.conf.json`).
//!
//! Linux is claimed on the same terms as Windows below: built, tested and
//! Clippy-clean on Ubuntu 22.04 x64, both packages installed and launched
//! there, and CI's `linux` job builds them on every push. Its cfg arms are
//! real now — WebKitGTK's microphone grant, fullscreen on the prompter's
//! monitor, display sleep held over the session bus — and `sherpa-onnx`'s
//! static Linux runtime links.
//!
//! Windows is claimed now because it has been proven the way the paragraphs
//! below ask: built, tested and run on a real Windows 11 host — the
//! `present.rs` cfg arms compile and present, `sherpa-onnx`'s static runtime
//! links and transcribes, display sleep is held through
//! `SetThreadExecutionState` — and CI's `windows` job builds the installer on
//! every push. What follows is the history of why the pin exists at all.
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

/// The Windows overlay asks for the NSIS installer and nothing else. The
/// shared config's `app` and `dmg` are macOS formats a Windows host cannot
/// produce, and an MSI would be a second installer nobody has exercised.
#[test]
fn windows_bundles_the_nsis_installer_and_nothing_else() {
    let overlay: serde_json::Value = serde_json::from_str(include_str!("../tauri.windows.conf.json"))
        .expect("tauri.windows.conf.json must be valid JSON");
    assert_eq!(
        overlay["bundle"]["targets"],
        serde_json::json!(["nsis"]),
        "the Windows overlay must name exactly the formats a Windows build has proven"
    );
}

/// The Linux overlay asks for the Debian package and the AppImage, and nothing
/// else. An RPM would be a third format no Linux build has exercised.
#[test]
fn linux_bundles_the_deb_and_the_appimage_and_nothing_else() {
    let overlay: serde_json::Value = serde_json::from_str(include_str!("../tauri.linux.conf.json"))
        .expect("tauri.linux.conf.json must be valid JSON");
    let mut targets: Vec<&str> = overlay["bundle"]["targets"]
        .as_array()
        .expect("the Linux overlay must name its bundle targets")
        .iter()
        .map(|target| target.as_str().expect("every bundle target must be a string"))
        .collect();
    targets.sort_unstable();
    assert_eq!(
        targets,
        ["appimage", "deb"],
        "the Linux overlay must name exactly the formats a Linux build has proven"
    );
}

/// Linux keeps the shared CSP: the overlay must not carry one.
///
/// Unlike WebView2, WebKitGTK registers custom schemes, so Tauri serves the
/// app, its assets and its IPC exactly as it does on macOS — `tauri://localhost`,
/// `asset://localhost`, `ipc://localhost` — and the shared policy's `'self'`,
/// `asset:` and `ipc:` already admit all three. A Linux copy would be a second
/// policy that a later tightening could miss.
#[test]
fn linux_uses_the_shared_csp() {
    let overlay: serde_json::Value = serde_json::from_str(include_str!("../tauri.linux.conf.json"))
        .expect("tauri.linux.conf.json must be valid JSON");
    assert!(
        overlay.get("app").is_none(),
        "the Linux overlay must not override `app` (and with it the shared CSP): {}",
        overlay["app"]
    );
}

/// The AppImage carries its own GStreamer.
///
/// Microphone capture in WebKitGTK is GStreamer: `getUserMedia` opens the input
/// through its device monitor and the PulseAudio/PipeWire source plugins. An
/// AppImage bundles `libgstreamer` with WebKit, and without its own plugins it
/// would load the HOST's, built against whatever GStreamer that distribution
/// ships — or find none at all. The `.deb` needs no such thing: the distro's
/// WebKitGTK package already depends on the plugin sets.
#[test]
fn the_appimage_bundles_the_media_framework() {
    let overlay: serde_json::Value = serde_json::from_str(include_str!("../tauri.linux.conf.json"))
        .expect("tauri.linux.conf.json must be valid JSON");
    assert_eq!(
        overlay["bundle"]["linux"]["appimage"]["bundleMediaFramework"],
        serde_json::json!(true),
        "the AppImage must bundle GStreamer's plugins, or the microphone depends on the host's"
    );
}

/// The Windows CSP is the shared one with `http://asset.localhost` added to the
/// three directives that load assets, and differs in nothing else.
///
/// WebView2 cannot register a custom scheme, so Tauri serves the asset protocol
/// there as `http://asset.localhost` — which a CSP naming only `asset:` blocks,
/// and every script image on Windows failed to load. It lives in the overlay so
/// the macOS policy is not widened by a host it never uses. Two copies of one
/// policy is how a tightening reaches one platform and not the other, so they
/// are held equal here, directive by directive.
#[test]
fn windows_csp_is_the_shared_csp_plus_the_asset_host() {
    fn directives(csp: &str) -> Vec<(String, Vec<String>)> {
        csp.split(';')
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .map(|part| {
                let mut words = part.split_whitespace().map(str::to_string);
                let name = words.next().expect("a directive has a name");
                (name, words.collect())
            })
            .collect()
    }
    let shared: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
        .expect("tauri.conf.json must be valid JSON");
    let overlay: serde_json::Value = serde_json::from_str(include_str!("../tauri.windows.conf.json"))
        .expect("tauri.windows.conf.json must be valid JSON");
    let shared = directives(shared["app"]["security"]["csp"].as_str().expect("a shared CSP"));
    let windows = directives(overlay["app"]["security"]["csp"].as_str().expect("a Windows CSP"));

    let expected: Vec<(String, Vec<String>)> = shared
        .into_iter()
        .map(|(name, mut sources)| {
            if matches!(name.as_str(), "default-src" | "img-src" | "media-src") {
                let at = sources
                    .iter()
                    .position(|source| source == "asset:")
                    .map_or(sources.len(), |index| index + 1);
                sources.insert(at, "http://asset.localhost".to_string());
            }
            (name, sources)
        })
        .collect();
    assert_eq!(windows, expected, "the Windows CSP has drifted from the shared one");
}
