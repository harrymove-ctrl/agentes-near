//! The main window's cover: a page of the app itself (`cover.html`, local) over the server's page, so the
//! window is never blank. It shows when the app opens (at least 1 s), whenever the page loads whole again
//! (⌘R, macOS ending the page, switching servers) and while the server can't be reached; it goes when the
//! page says it painted (`page_ready`). The cover only asks the server open now whether it answers, to tell
//! offline from down, and may only ask to load the page again or to step aside (capabilities/cover.json).
//!
//! A page that never paints while its server answers (seen on macOS: the web view's own HTTP cache left it stuck,
//! and only clearing it brought the site back) is never left as a blank window: the cover loads it again, then
//! again with that cache cleared (cookies and the site's storage stay: no one is signed out, nothing typed is
//! lost), and then says it didn't open. An opening that never painted clears that cache on the next one, and
//! each step is written to the window's log (`window.log` in the app's log folder).

use std::sync::Mutex;
use std::time::{Duration, Instant};

use std::io::Write;
use std::path::PathBuf;

use tauri::window::Color;
use tauri::{AppHandle, LogicalPosition, Manager, WebviewBuilder, WebviewUrl};

use crate::main_window;

pub const LABEL: &str = "main-cover";

/// The splash when the app opens stays at least this long, even when the site is ready sooner.
pub const OPENING: Duration = Duration::from_secs(1);
/// The cover fades out (cover.css) before it is hidden.
const FADE: Duration = Duration::from_millis(260);
/// The sky's deepest tone (packages/ui sky SKY_TONES[0]), before the cover's page paints.
const SKY: Color = Color(10, 63, 156, 255);
/// Written when the window opens, removed when the site paints: still there at the next opening, the last one
/// never painted.
const PENDING_FILE: &str = "page-pending";

#[derive(Default)]
pub struct Cover(Mutex<Shown>);

#[derive(Default)]
struct Shown {
    /// Since when it covers the site, and for how long at least; `None` when hidden.
    since: Option<(Instant, Duration)>,
    /// Each showing gets a new one: a late hide meant for an earlier showing does nothing.
    generation: u64,
}

/// Adds the cover to the freshly made main window, showing (the splash).
pub fn attach(app: &AppHandle, window: &tauri::Window) -> tauri::Result<()> {
    let size = window.inner_size()?;
    let cover = WebviewBuilder::new(LABEL, WebviewUrl::App("cover.html".into()))
        // Transparent only where the site shows through it as it fades: a transparent WebView2 shows black, not
        // the web view under it, and drops the color.
        .transparent(!cfg!(target_os = "windows"))
        .background_color(SKY)
        .auto_resize();
    window.add_child(cover, LogicalPosition::new(0.0, 0.0), size)?;
    let mut shown = lock(app);
    shown.since = Some((Instant::now(), OPENING));
    shown.generation += 1;
    Ok(())
}

fn lock(app: &AppHandle) -> std::sync::MutexGuard<'_, Shown> {
    app.state::<Cover>().inner().0.lock().unwrap_or_else(|e| e.into_inner())
}

/// Covers the site now (it is loading a whole page again), for at least `min`. Already covering (the
/// splash, when the first load starts), it keeps whatever minimum is left.
pub fn show(app: &AppHandle, min: Duration) {
    let Some(cover) = app.get_webview(LABEL) else { return };
    let was_shown = {
        let mut shown = lock(app);
        let now = Instant::now();
        let left = shown
            .since
            .map(|(since, before)| before.saturating_sub(since.elapsed()))
            .unwrap_or_default();
        let was_shown = shown.since.is_some();
        shown.generation += 1;
        shown.since = Some((now, min.max(left)));
        was_shown
    };
    if !was_shown {
        let _ = cover.eval("window.__coverShown?.()");
    }
    let _ = cover.show();
    main_window::keep_lights(app);
    // Typing goes to what shows, not to the page loading behind it.
    if window_is_key(app) {
        let _ = cover.set_focus();
    }
}

/// The main window is the one in front (focus moves only inside it, never brings it forward).
fn window_is_key(app: &AppHandle) -> bool {
    app.get_window(main_window::LABEL)
        .and_then(|w| w.is_focused().ok())
        .unwrap_or(false)
}

/// The site painted: the cover fades and steps aside (after its minimum, when it has one).
pub fn hide(app: &AppHandle) {
    let (wait, generation) = {
        let shown = lock(app);
        let Some((since, min)) = shown.since else { return };
        (min.saturating_sub(since.elapsed()), shown.generation)
    };
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(wait);
        let current = |app: &AppHandle| lock(app).generation == generation;
        let Some(cover) = app.get_webview(LABEL) else { return };
        if !current(&app) {
            return;
        }
        let _ = cover.eval("window.__coverFade?.()");
        std::thread::sleep(FADE);
        {
            let mut shown = lock(&app);
            if shown.generation != generation {
                return; // shown again meanwhile
            }
            shown.since = None;
        }
        let _ = cover.hide();
        // Hiding a web view lays the window out anew, the buttons back at the title bar's top.
        main_window::keep_lights(&app);
        if window_is_key(&app) {
            if let Some(site) = app.get_webview(main_window::LABEL) {
                let _ = site.set_focus();
            }
        }
    });
}

/// The server here answers now at the address the window opens (local_server.rs: it came up, or Tailscale
/// shares it again). The window opens with the app, before that server is up: its first load was refused and
/// left nothing to reload, and the cover's own checks then find the server up and wait for a page that never
/// comes, so while the site hasn't painted, the window asks for it again.
pub fn server_here_ready(app: &AppHandle) {
    if lock(app).since.is_none() {
        return; // the site painted already
    }
    let Some(site) = main_window::site(app) else { return };
    let origin = site.origin().ascii_serialization();
    if !crate::local_server::is_here(app, &origin) || !crate::local_server::answers_within(app, &origin, Duration::ZERO)
    {
        return;
    }
    if let Some(page) = app.get_webview(main_window::LABEL) {
        let _ = page.navigate(site);
    }
}

/// The server here can't start while a page of it is on screen: the cover comes back over it (Try again, Copy
/// details), and loads the page again once it answers.
pub fn over_server_here(app: &AppHandle) {
    let Some(site) = main_window::site(app) else { return };
    if crate::local_server::is_here(app, &site.origin().ascii_serialization()) {
        show(app, Duration::ZERO);
    }
}

/// The site, once it painted its first screen (apps/web `pageReady`).
#[tauri::command]
pub fn page_ready(app: AppHandle, webview: tauri::Webview) -> Result<(), String> {
    if webview.label() != main_window::LABEL {
        return Err("only the site says it painted".into());
    }
    if let Some(path) = pending_path(&app).filter(|p| p.exists()) {
        let _ = std::fs::remove_file(path);
    }
    hide(&app);
    Ok(())
}

fn pending_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(PENDING_FILE))
}

/// The main window was just made: when the last opening never painted, its web cache goes first (the site is
/// asked for again once it is gone), and this opening is marked until the site paints.
pub fn opening(app: &AppHandle) {
    let Some(path) = pending_path(app) else { return };
    if path.exists() {
        note(app, "the last opening never painted: clearing the web cache");
        let handle = app.clone();
        clear_http_cache(app, move || load_again(&handle));
    }
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&path, b"");
}

/// The site, from its server again (a first load that never arrived leaves nothing to reload).
fn load_again(app: &AppHandle) {
    if let (Some(page), Some(site)) = (app.get_webview(main_window::LABEL), main_window::site(app)) {
        let _ = page.navigate(site);
    }
}

/// One line in the window's log: what the cover did to bring a stuck page back, to learn why it got stuck.
fn note(app: &AppHandle, what: &str) {
    let Ok(dir) = app.path().app_log_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("window.log")) {
        let _ = writeln!(file, "{at} {} {what}", app.package_info().version);
    }
}

/// Empties the web views' HTTP caches (on disk and in memory), never their cookies or the sites' storage, then
/// runs `then`. On macOS that is the default website data store's, which every web view of the app uses.
#[cfg(target_os = "macos")]
fn clear_http_cache(app: &AppHandle, then: impl FnOnce() + Send + 'static) {
    use block2::RcBlock;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use std::sync::Mutex;

    let then = Mutex::new(Some(then));
    let _ = app.run_on_main_thread(move || {
        // SAFETY: WebKit's data store, on the main thread; the strings, set and date are autoreleased objects
        // used right here, and the block is copied by WebKit and called once on the main thread.
        unsafe {
            let store: *mut AnyObject = msg_send![class!(WKWebsiteDataStore), defaultDataStore];
            let kinds: [*mut AnyObject; 2] = [
                msg_send![class!(NSString), stringWithUTF8String: c"WKWebsiteDataTypeDiskCache".as_ptr()],
                msg_send![class!(NSString), stringWithUTF8String: c"WKWebsiteDataTypeMemoryCache".as_ptr()],
            ];
            let since: *mut AnyObject = msg_send![class!(NSDate), distantPast];
            if store.is_null() || kinds.iter().any(|k| k.is_null()) || since.is_null() {
                if let Some(then) = then.lock().ok().and_then(|mut t| t.take()) {
                    then();
                }
                return;
            }
            let set: *mut AnyObject = msg_send![class!(NSSet), setWithObjects: kinds.as_ptr(), count: kinds.len()];
            let done = RcBlock::new(move || {
                if let Some(then) = then.lock().ok().and_then(|mut t| t.take()) {
                    then();
                }
            });
            let _: () = msg_send![store, removeDataOfTypes: set, modifiedSince: since, completionHandler: &*done];
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn clear_http_cache(_app: &AppHandle, then: impl FnOnce() + Send + 'static) {
    then();
}

/// The cover: load the site again (the cover stays until it paints): the server is reachable again after it
/// wasn't, or it answers and the page never painted. `fresh`: with the web cache cleared first.
#[tauri::command]
pub fn cover_retry(
    app: AppHandle,
    webview: tauri::Webview,
    fresh: Option<bool>,
    why: Option<String>,
) -> Result<(), String> {
    if webview.label() != LABEL {
        return Err("only the cover asks this".into());
    }
    let page = app.get_webview(main_window::LABEL).ok_or("no site")?;
    // A first load that never arrived leaves nothing to reload: go to the server again.
    let site = main_window::site(&app).ok_or("no server chosen")?;
    if let Some(why) = why.as_deref().filter(|w| w.len() <= 80) {
        let how = if fresh == Some(true) { " with the web cache cleared" } else { "" };
        note(&app, &format!("{why}: loading again{how}"));
    }
    if fresh == Some(true) {
        let handle = app.clone();
        clear_http_cache(&app, move || load_again(&handle));
        return Ok(());
    }
    page.navigate(site).map_err(|e| e.to_string())
}

/// The cover: which server the window opens, to ask whether it answers and to name it when it doesn't.
#[tauri::command]
pub fn cover_server(app: AppHandle, webview: tauri::Webview) -> Result<Option<String>, String> {
    if webview.label() != LABEL {
        return Err("only the cover asks this".into());
    }
    Ok(main_window::site(&app).map(|s| s.origin().ascii_serialization()))
}

/// The cover's Copy details over a server other than the one here: the window's own story (the app's version, the
/// server it opens, what the cover did, from `window.log`), never the server here's.
#[tauri::command]
pub fn cover_details(app: AppHandle, webview: tauri::Webview) -> Result<String, String> {
    if webview.label() != LABEL {
        return Err("only the cover asks this".into());
    }
    let server = main_window::site(&app).map(|s| s.origin().ascii_serialization()).unwrap_or_default();
    let log = app
        .path()
        .app_log_dir()
        .ok()
        .and_then(|d| std::fs::read_to_string(d.join("window.log")).ok())
        .unwrap_or_default();
    Ok(window_details(&app.package_info().version.to_string(), std::env::consts::OS, &server, &log))
}

/// What the window's Copy details says: versions, the server, the last lines of `window.log`.
pub fn window_details(version: &str, os: &str, server: &str, log: &str) -> String {
    let lines: Vec<&str> = log.lines().collect();
    let tail = lines[lines.len().saturating_sub(40)..].join("\n");
    format!("agentes.chat {version} ({os})\nserver: {server}\n\nwindow.log:\n{tail}\n")
}

/// The cover: the person chose to see the page as it is ("Mostrar assim mesmo"), after it didn't open.
#[tauri::command]
pub fn cover_hide(app: AppHandle, webview: tauri::Webview) -> Result<(), String> {
    if webview.label() != LABEL {
        return Err("only the cover asks this".into());
    }
    note(&app, "the page never painted: shown as it is, by hand");
    hide(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_windows_own_details() {
        let log: String = (1..=50).map(|n| format!("{n} 0.6.0 step {n}\n")).collect();
        let text = window_details("0.6.0", "macos", "https://chat.example.com", &log);
        assert!(text.starts_with("agentes.chat 0.6.0 (macos)\nserver: https://chat.example.com\n"));
        // The last 40 lines only.
        assert!(text.contains("11 0.6.0 step 11") && !text.contains("\n10 0.6.0 step 10"));
        assert!(window_details("0.6.0", "macos", "", "").ends_with("window.log:\n\n"));
    }
}
