// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK's DMA-BUF renderer draws a blank window on a lot of Linux
    // desktops (NVIDIA's proprietary driver above all, and any session without
    // a GPU). The shared-memory path it falls back to is plenty for a page of
    // text. Set before anything starts a thread, and only when the user has not
    // chosen for themselves.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    speaking_glass_lib::run()
}
