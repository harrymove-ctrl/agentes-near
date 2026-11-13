// No console window on Windows release builds (later); macOS ignores it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Linux: WebKitGTK's DMA-BUF renderer leaves the window blank with NVIDIA's driver, in virtual machines and
    // in many AppImage setups; the older path draws everywhere. Set before any thread starts; the person's own
    // value wins.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    agentes_desktop_lib::run();
}
