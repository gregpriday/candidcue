//! The operating system's own glass, under the desk's windows.
//!
//! ---------------------------------------------------------------------------
//! WHAT THIS IS
//! ---------------------------------------------------------------------------
//! A Mac draws its sidebars on vibrancy — the frosted material Finder and Mail
//! sit on, which lets a blur of the desktop through and dims itself when the
//! window is not in front. Windows 11 draws its navigation and title areas on
//! Mica, a backdrop tinted from the wallpaper. Both are the platform's, not an
//! imitation of the other's: the app asks each system for its own material and
//! the page decides where it shows (`src/control/lib/window-material.ts`).
//!
//! Linux has no such material for an application to ask for (the compositor
//! owns any blur), and Windows before 11 22H2 has no documented Mica. They get
//! none, which is exactly the opaque desk the app had before — the page's
//! rules only clear the chrome when there is something under it.
//!
//! ---------------------------------------------------------------------------
//! HOW IT REACHES THE PAGE BEFORE THE FIRST PAINT
//! ---------------------------------------------------------------------------
//! The material is decided once, at startup, and handed to every webview in an
//! initialization script — a global the page reads synchronously while it
//! mounts (`window.__SPEAKING_GLASS_WINDOW_MATERIAL__`). An IPC round trip would
//! resolve after the first frame, and that frame would show the rail opaque and
//! then clear. Only the windows in [`MATERIAL_WINDOWS`] are given the material
//! itself; the others read the global and ignore it.
//!
//! ---------------------------------------------------------------------------
//! WHY NOTHING BREAKS IF IT FAILS
//! ---------------------------------------------------------------------------
//! The page clears the chrome on the strength of the prediction. If the effect
//! then cannot be applied, the backing is left opaque rather than made
//! transparent, so the chrome shows the webview's own default background — a
//! plain sidebar, never a hole. That is why Mica goes through DWM directly
//! with its result checked (`set_system_backdrop`) rather than through
//! window-vibrancy, whose Windows calls report success whatever DWM said.
//! Vibrancy needs the main thread, which [`attach`] guarantees, and Mica the
//! build [`native`] checks for, so this is a floor rather than a path anyone
//! is expected to see.
//!
//! ---------------------------------------------------------------------------
//! NEVER UNDER A TAKE
//! ---------------------------------------------------------------------------
//! A presenting window is black glass or paper, and a frame of desktop showing
//! through either is the artifact `present.rs` exists to prevent. So a take
//! takes the material away ([`suspend`]) before it paints the backing black,
//! and gives it back ([`resume`]) once the window is the desk again.
//!
//! The escape hatch, for comparison and for anybody whose GPU disagrees with
//! the effect: `SPEAKING_GLASS_WINDOW_MATERIAL=none`.

use std::sync::OnceLock;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::window::Color;
use tauri::{Runtime, Window};

use super::preferences::PREFERENCES_LABEL;
use super::CONTROL_LABEL;

/// The windows that sit on the material: the document window and Settings.
/// The stage is a presentation surface and the identify cards are momentary;
/// neither has a navigation rail to show it through.
pub const MATERIAL_WINDOWS: [&str; 2] = [CONTROL_LABEL, PREFERENCES_LABEL];

/// The environment variable that turns the material off.
pub const OVERRIDE_ENV: &str = "SPEAKING_GLASS_WINDOW_MATERIAL";


/// A system material the page knows how to show through.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Material {
    /// macOS `NSVisualEffectView`, the sidebar material.
    Vibrancy,
    /// Windows 11's Mica system backdrop.
    Mica,
}

impl Material {
    /// The name the page matches on (`data-window-material`).
    pub fn as_str(self) -> &'static str {
        match self {
            Material::Vibrancy => "vibrancy",
            Material::Mica => "mica",
        }
    }
}

/// What this machine can lay under a window, before any override.
pub fn native() -> Option<Material> {
    #[cfg(target_os = "macos")]
    {
        // Every macOS the app supports (12 and later) has the sidebar material.
        Some(Material::Vibrancy)
    }
    #[cfg(windows)]
    {
        // The documented system backdrop (DWMWA_SYSTEMBACKDROP_TYPE) arrived
        // with Windows 11 22H2, build 22621. Windows 10 and 11's first release
        // report major version 10 as well, so the build is the test; before it
        // the desk is the opaque one.
        if windows_version::OsVersion::current().build >= 22621 {
            Some(Material::Mica)
        } else {
            None
        }
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        None
    }
}

/// The material to use, given what the machine has and what the environment
/// asks for.
///
/// The override can only take the material AWAY. Asking for one the platform
/// does not have would clear the rail over a window with nothing behind it, so
/// any value but an explicit "off" means "whatever the machine has".
pub fn decide(native: Option<Material>, requested: Option<&str>) -> Option<Material> {
    match requested.map(|value| value.trim().to_ascii_lowercase()) {
        Some(value) if matches!(value.as_str(), "none" | "off" | "0" | "false") => None,
        _ => native,
    }
}

/// The material this run uses, decided once.
pub fn chosen() -> Option<Material> {
    static CHOSEN: OnceLock<Option<Material>> = OnceLock::new();
    *CHOSEN.get_or_init(|| decide(native(), std::env::var(OVERRIDE_ENV).ok().as_deref()))
}

/// The initialization script that tells a page which material it is on.
///
/// `null` rather than an absent property when there is none, so a page can
/// tell "Rust said none" from "this is a plain browser" if it ever needs to.
pub fn init_script(material: Option<Material>) -> String {
    let value = match material {
        Some(material) => format!("'{}'", material.as_str()),
        None => "null".to_string(),
    };
    // The titlebar is an overlay on a Mac whatever the material: the control
    // window's config and the Settings builder both ask for it there.
    let titlebar = if cfg!(target_os = "macos") { "'overlay'" } else { "null" };
    format!(
        "window.__SPEAKING_GLASS_WINDOW_MATERIAL__ = {value}; \
         window.__SPEAKING_GLASS_TITLEBAR__ = {titlebar};"
    )
}

/// Fully transparent: the backing every material window has while it shows
/// the material, so the page's clear column is the material and not the
/// webview's own white.
const CLEAR: Color = Color(0, 0, 0, 0);

/// The plugin that carries the initialization script and lays the material
/// under each material window as its webview comes up.
pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    let material = chosen();
    Builder::new("window-material")
        .js_init_script(init_script(material))
        .on_webview_ready(move |webview| {
            if !MATERIAL_WINDOWS.contains(&webview.label()) {
                return;
            }
            let window = webview.window();
            unify_titlebar(&window);
            if material.is_none() {
                return;
            }
            attach(&window, material);
        })
        .on_page_load(|webview, payload| {
            // A material that could not be laid (see `attach`) was promised to
            // the page before it failed; once the page is up, take the
            // promise back so it paints its chrome opaque again.
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
                && refused().lock().is_ok_and(|labels| labels.contains(webview.label()))
            {
                let _ = webview.eval("delete document.documentElement.dataset.windowMaterial;");
            }
        })
        .build()
}

/// Lay the material under `window` and clear its backing to show it.
///
/// On the main thread, which vibrancy requires; inline when already there
/// (Tauri runs a main-thread task in place on the main thread), which is the
/// case for the control window at startup and for Settings on a Mac — so the
/// material is down before the page's first frame.
pub fn attach<R: Runtime>(window: &Window<R>, material: Option<Material>) {
    let Some(material) = material else { return };
    let target = window.clone();
    let queued = window.run_on_main_thread(move || {
        if let Err(error) = apply(&target, material) {
            // The backing stays opaque, and the page is told on load that its
            // chrome has nothing under it: a plain sidebar, never a hole.
            tracing::warn!(%error, material = material.as_str(), "no window material");
            if let Ok(mut labels) = refused().lock() {
                labels.insert(target.label().to_string());
            }
            return;
        }
        let _ = target.set_background_color(Some(CLEAR));
        clear_webview_backing(&target);
    });
    if let Err(error) = queued {
        tracing::warn!(%error, "could not reach the main thread to lay the window material");
    }
}

/// The windows whose material was refused, so their pages can be told.
fn refused() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    static REFUSED: OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> = OnceLock::new();
    REFUSED.get_or_init(Default::default)
}

/// Take the material away for a take. The caller paints the backing black.
pub fn suspend<R: Runtime>(window: &Window<R>) {
    if chosen().is_none() {
        return;
    }
    let target = window.clone();
    let _ = window.run_on_main_thread(move || {
        let _ = remove(&target);
    });
}

/// Put the desk's window back once a take has ended: the unified titlebar, and
/// the material — or, with no material, the OS default backing the restore
/// path has always used.
///
/// The titlebar has to be given back as well as the material because a
/// prompter take strips the window to borderless, and AppKit drops a window's
/// toolbar along with its titlebar: without it the restored window's traffic
/// lights fall back to AppKit's bare-overlay position, above the toolbar
/// band's middle. A reading-window take keeps its titlebar and its toolbar;
/// [`unify_titlebar`] leaves a window that still has one alone.
pub fn resume<R: Runtime>(window: &Window<R>) {
    unify_titlebar(window);
    match chosen() {
        Some(material) => attach(window, Some(material)),
        None => {
            // Both layers, as the take painted both black: the native window
            // and every webview in it (`WebviewWindow::set_background_color`
            // is the pair; a `Window` holds them separately).
            let _ = window.set_background_color(None);
            for webview in window.webviews() {
                let _ = webview.set_background_color(None);
            }
        }
    }
}

/// Give a Mac window a unified titlebar the height of the page's toolbar band.
///
/// The titlebar is an overlay (tauri.conf.json, `titleBarStyle: Overlay`): the
/// page runs under it, its toolbar band IS the titlebar, and the traffic lights
/// sit on it. AppKit centres the lights in the titlebar, and a bare overlay
/// titlebar is 32pt — ten points shorter than the band, so the lights sat above
/// the toolbar's middle. An empty unified `NSToolbar` makes AppKit's titlebar
/// 52pt and centres the lights in it, 19pt in — Tahoe's own geometry, which the
/// page's band then matches (`--toolbar-h` under `data-titlebar='overlay'`).
///
/// The toolbar has no items and draws nothing over the page: hit-testing still
/// lands on the webview everywhere in the band (checked on macOS 26), so the
/// page's buttons click and its drag regions move the window.
///
/// Placing the lights by hand instead (`trafficLightPosition`) does not hold:
/// AppKit lays the titlebar out again on every resize and focus change, and
/// Tauri re-places them only for a window built in code.
#[cfg(target_os = "macos")]
fn unify_titlebar<R: Runtime>(window: &Window<R>) {
    let target = window.clone();
    let _ = window.run_on_main_thread(move || {
        use objc2::{MainThreadMarker, MainThreadOnly};
        use objc2_app_kit::{NSTitlebarSeparatorStyle, NSToolbar, NSWindow, NSWindowToolbarStyle};
        use objc2_foundation::ns_string;

        let Some(mtm) = MainThreadMarker::new() else { return };
        let Ok(ns_window) = target.ns_window() else { return };
        if ns_window.is_null() {
            return;
        }
        // SAFETY: tao's NSWindow, alive for as long as `target` is, and touched
        // only here on the main thread.
        let ns_window = unsafe { &*(ns_window as *const NSWindow) };
        if ns_window.toolbar().is_some() {
            return;
        }
        let toolbar =
            NSToolbar::initWithIdentifier(NSToolbar::alloc(mtm), ns_string!("speaking-glass.titlebar"));
        ns_window.setToolbar(Some(&toolbar));
        ns_window.setToolbarStyle(NSWindowToolbarStyle::Unified);
        // The page's toolbar draws its own bottom edge, where the chrome ends.
        ns_window.setTitlebarSeparatorStyle(NSTitlebarSeparatorStyle::None);
    });
}

#[cfg(not(target_os = "macos"))]
fn unify_titlebar<R: Runtime>(_window: &Window<R>) {}

/// Give a Mac window its unified titlebar back after `present.rs` has
/// restored its decorations from borderless — mid-take, on a switch from the
/// prompter to a reading window, as well as when the take ends ([`resume`]).
/// A window that still has its toolbar is left alone.
pub fn restore_titlebar<R: Runtime>(window: &Window<R>) {
    unify_titlebar(window);
}

/// The webview's own backing, cleared alongside the window's.
///
/// `Window::set_background_color` paints the native window; the webview inside
/// it keeps its default white until it is told otherwise, and that white would
/// sit between the material and the page. On a Mac this is the private
/// `drawsBackground` key wry sets under the `macos-private-api` feature; on
/// Windows it is WebView2's default background, which takes a zero alpha.
///
/// (On macOS 26 a transparent WKWebView paints nothing under the titlebar at
/// all — not the canvas, not the under-page colour — which is why the
/// titlebar strip is the material whatever this sets, and why the page's
/// toolbar band is glass too: tokens.css, WINDOW MATERIAL.)
fn clear_webview_backing<R: Runtime>(window: &Window<R>) {
    for webview in window.webviews() {
        let _ = webview.set_background_color(Some(CLEAR));
    }
}

#[cfg(target_os = "macos")]
fn apply<R: Runtime>(window: &Window<R>, material: Material) -> Result<(), String> {
    use window_vibrancy::{NSVisualEffectMaterial, NSVisualEffectState};
    match material {
        Material::Vibrancy => {
            // Never two: a resume after a take, or a second attach, replaces.
            let _ = window_vibrancy::clear_vibrancy(window);
            window_vibrancy::apply_vibrancy(
                window,
                NSVisualEffectMaterial::Sidebar,
                // Dims to the inactive material when the window is behind
                // another, as every Mac sidebar does.
                Some(NSVisualEffectState::FollowsWindowActiveState),
                None,
            )
            .map_err(|error| error.to_string())
        }
        Material::Mica => Err("Mica is a Windows material".into()),
    }
}

#[cfg(target_os = "macos")]
fn remove<R: Runtime>(window: &Window<R>) -> Result<(), String> {
    window_vibrancy::clear_vibrancy(window)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Mica, through DWM's documented system backdrop, with its result checked.
///
/// Not `window_vibrancy::apply_mica`: the 0.6 release discards the HRESULT of
/// the very call that does the work and reports success whatever DWM said, and
/// a material that silently failed under a window created transparent is a
/// window with nothing behind its rail. Checked here, a refusal leaves the
/// backing opaque, as on any platform without the material.
#[cfg(windows)]
fn apply<R: Runtime>(window: &Window<R>, material: Material) -> Result<(), String> {
    use windows::Win32::Graphics::Dwm::DWMSBT_MAINWINDOW;
    match material {
        Material::Mica => set_system_backdrop(window, DWMSBT_MAINWINDOW),
        Material::Vibrancy => Err("vibrancy is a macOS material".into()),
    }
}

#[cfg(windows)]
fn remove<R: Runtime>(window: &Window<R>) -> Result<(), String> {
    use windows::Win32::Graphics::Dwm::DWMSBT_NONE;
    set_system_backdrop(window, DWMSBT_NONE)
}

#[cfg(windows)]
fn set_system_backdrop<R: Runtime>(
    window: &Window<R>,
    backdrop: windows::Win32::Graphics::Dwm::DWM_SYSTEMBACKDROP_TYPE,
) -> Result<(), String> {
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_SYSTEMBACKDROP_TYPE};
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    // SAFETY: a live HWND from Tauri, and a pointer to a value of exactly the
    // size passed, read synchronously by DWM.
    unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_SYSTEMBACKDROP_TYPE,
            std::ptr::from_ref(&backdrop).cast(),
            std::mem::size_of_val(&backdrop) as u32,
        )
    }
    .map_err(|error| error.to_string())
}

#[cfg(not(any(target_os = "macos", windows)))]
fn apply<R: Runtime>(_window: &Window<R>, _material: Material) -> Result<(), String> {
    Err("this platform has no window material".into())
}

#[cfg(not(any(target_os = "macos", windows)))]
fn remove<R: Runtime>(_window: &Window<R>) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_override_can_take_the_material_away() {
        for off in ["none", "off", "0", "false", " NONE "] {
            assert_eq!(decide(Some(Material::Vibrancy), Some(off)), None, "{off:?}");
            assert_eq!(decide(Some(Material::Mica), Some(off)), None, "{off:?}");
        }
    }

    #[test]
    fn the_override_cannot_conjure_a_material_the_machine_lacks() {
        // Linux, or Windows 10: nothing under the window, whatever is asked.
        assert_eq!(decide(None, Some("vibrancy")), None);
        assert_eq!(decide(None, Some("mica")), None);
        // And a machine with one keeps its own rather than the one named.
        assert_eq!(decide(Some(Material::Mica), Some("vibrancy")), Some(Material::Mica));
    }

    #[test]
    fn no_override_is_whatever_the_machine_has() {
        assert_eq!(decide(Some(Material::Vibrancy), None), Some(Material::Vibrancy));
        assert_eq!(decide(Some(Material::Mica), Some("")), Some(Material::Mica));
        assert_eq!(decide(None, None), None);
    }

    #[test]
    fn the_page_is_told_by_name_or_told_none() {
        assert!(init_script(Some(Material::Vibrancy))
            .starts_with("window.__SPEAKING_GLASS_WINDOW_MATERIAL__ = 'vibrancy';"));
        assert!(init_script(Some(Material::Mica))
            .starts_with("window.__SPEAKING_GLASS_WINDOW_MATERIAL__ = 'mica';"));
        assert!(init_script(None).starts_with("window.__SPEAKING_GLASS_WINDOW_MATERIAL__ = null;"));
    }

    #[test]
    fn the_page_is_told_whether_the_titlebar_is_an_overlay() {
        let script = init_script(None);
        if cfg!(target_os = "macos") {
            assert!(script.ends_with("window.__SPEAKING_GLASS_TITLEBAR__ = 'overlay';"), "{script}");
        } else {
            assert!(script.ends_with("window.__SPEAKING_GLASS_TITLEBAR__ = null;"), "{script}");
        }
    }

    /// The control window's overlay titlebar is declared in tauri.conf.json and
    /// the Settings window's in code; both hide the title, which the unified
    /// titlebar would otherwise draw over the page's toolbar band.
    #[test]
    fn the_control_window_has_an_overlay_titlebar() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).expect("tauri.conf.json");
        let control = &config["app"]["windows"][0];
        assert_eq!(control["titleBarStyle"], "Overlay");
        assert_eq!(control["hiddenTitle"], true);
        assert!(
            control.get("trafficLightPosition").is_none(),
            "AppKit centres the lights in the unified titlebar; a fixed position fights it"
        );
    }

    #[test]
    fn only_the_desk_windows_sit_on_the_material() {
        assert_eq!(MATERIAL_WINDOWS, ["control", "preferences"]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_mac_always_has_vibrancy() {
        assert_eq!(native(), Some(Material::Vibrancy));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_has_none() {
        assert_eq!(native(), None);
    }
}
