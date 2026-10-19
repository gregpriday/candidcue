fn main() {
    let windows_msvc = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    let mut attributes = tauri_build::Attributes::new();
    if windows_msvc {
        /*
         * ONE C RUNTIME PER BINARY.
         *
         * sherpa-onnx's Windows prebuilt is compiled `/MT` — the static CRT —
         * and Rust links the DLL CRT by default, so a plain `cargo build` or
         * `cargo test` linked both (`LNK4098: defaultlib 'LIBCMT' conflicts`):
         * two runtimes, two heaps' worth of state, in one process. The Tauri
         * CLI already avoids it for the app it builds by setting this variable,
         * which makes tauri-build link the static VC runtime; setting it here
         * gives every other build the same layout, tests included. The UCRT
         * stays dynamic — it is part of Windows 10 and later.
         */
        std::env::set_var("STATIC_VCRUNTIME", "true");
        /*
         * THE APPLICATION MANIFEST, IN EVERY BINARY.
         *
         * tauri-build puts the manifest that selects Common Controls v6 into a
         * resource it links into the app binary only. The dialog plugin imports
         * `TaskDialogIndirect`, which exists only in v6, so every TEST binary —
         * linked without the manifest — failed to load before a single test
         * ran (`STATUS_ENTRYPOINT_NOT_FOUND`). Embedding it through the linker
         * instead covers the app, the unit tests and the integration tests
         * alike; the resource's copy is turned off so the two do not collide.
         * This is Tauri's own documented arrangement for testing on Windows.
         */
        attributes = attributes.windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
