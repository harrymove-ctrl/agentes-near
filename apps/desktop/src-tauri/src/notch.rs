//! The notch: a borderless window over the MacBook's camera
//! housing that shows what the agents are doing on this Mac. Off by default (Preferências → Geral):
//! the window only exists while it's on. Rust finds the notch and places the window; the web view
//! draws the island and asks for its size.

use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "notch";

/// The notch's size in points (it varies by model and with the menu bar's height).
#[derive(Serialize, Clone, Copy)]
pub struct NotchInfo {
    pub width: f64,
    pub height: f64,
}

/// Runs `f` on the main thread (AppKit) and waits for it. Only from a command running off it (async).
fn on_main<R: Send + 'static>(
    app: &AppHandle,
    f: impl FnOnce(&AppHandle) -> R + Send + 'static,
) -> Result<R, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(f(&handle));
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())
}

/// Creates the window (on) or destroys it (off).
pub fn set_enabled(app: &AppHandle, on: bool) -> Result<(), String> {
    let existing = app.get_webview_window(LABEL);
    if !on {
        if let Some(window) = existing {
            window.destroy().map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    if existing.is_some() {
        return Ok(());
    }
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
        .title("agentes.chat")
        .inner_size(400.0, 40.0)
        .visible(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .accept_first_mouse(true)
        .visible_on_all_workspaces(true)
        .build()
        .map_err(|e| e.to_string())?;
    on_main(app, move |_| {
        #[cfg(target_os = "macos")]
        if let Ok(ns) = window.ns_window() {
            native::configure(ns);
        }
        #[cfg(not(target_os = "macos"))]
        let _ = window;
    })
}

/// The notch of the screen that has one, if any (an external display alone has none).
pub fn info(app: &AppHandle) -> Result<Option<NotchInfo>, String> {
    on_main(app, |_| {
        #[cfg(target_os = "macos")]
        let found = native::find().map(|n| NotchInfo { width: n.width, height: n.height });
        #[cfg(not(target_os = "macos"))]
        let found = None;
        found
    })
}

/// Places the window, `width` × `height` points, centered on the notch and hanging from the top of
/// its screen; a zero size (or no notch) hides it. Returns the notch it was placed on.
pub fn place(app: &AppHandle, width: f64, height: f64) -> Result<Option<NotchInfo>, String> {
    let window = app.get_webview_window(LABEL).ok_or("notch window not found")?;
    on_main(app, move |_| {
        #[cfg(target_os = "macos")]
        {
            let found = native::find();
            match (&found, window.ns_window()) {
                (Some(n), Ok(ns)) if width > 0.0 && height > 0.0 => native::place(ns, n, width, height),
                _ => {
                    let _ = window.hide();
                }
            }
            found.map(|n| NotchInfo { width: n.width, height: n.height })
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (window, width, height);
            None
        }
    })
}

#[cfg(target_os = "macos")]
pub(crate) mod native {
    use std::ffi::c_void;

    use objc2::encode::{Encode, Encoding};
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send, sel};

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct CGPoint {
        pub x: f64,
        pub y: f64,
    }
    unsafe impl Encode for CGPoint {
        const ENCODING: Encoding = Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct CGSize {
        pub width: f64,
        pub height: f64,
    }
    unsafe impl Encode for CGSize {
        const ENCODING: Encoding = Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct CGRect {
        pub origin: CGPoint,
        pub size: CGSize,
    }
    unsafe impl Encode for CGRect {
        const ENCODING: Encoding = Encoding::Struct("CGRect", &[CGPoint::ENCODING, CGSize::ENCODING]);
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct NSEdgeInsets {
        top: f64,
        left: f64,
        bottom: f64,
        right: f64,
    }
    unsafe impl Encode for NSEdgeInsets {
        const ENCODING: Encoding =
            Encoding::Struct("NSEdgeInsets", &[f64::ENCODING, f64::ENCODING, f64::ENCODING, f64::ENCODING]);
    }

    pub struct Notch {
        /// The whole screen, in AppKit's coordinates (origin at the bottom left of the main screen).
        screen: CGRect,
        pub width: f64,
        pub height: f64,
    }

    /// The first screen with a camera housing: a top safe-area inset (macOS 12+). The notch's width
    /// is what's left between the two menu bar areas beside it.
    pub fn find() -> Option<Notch> {
        unsafe {
            let screens: *mut AnyObject = msg_send![class!(NSScreen), screens];
            let screens = screens.as_ref()?;
            let count: usize = msg_send![screens, count];
            for i in 0..count {
                let screen: *mut AnyObject = msg_send![screens, objectAtIndex: i];
                let Some(screen) = screen.as_ref() else { continue };
                let has: bool = msg_send![screen, respondsToSelector: sel!(safeAreaInsets)];
                if !has {
                    continue;
                }
                let insets: NSEdgeInsets = msg_send![screen, safeAreaInsets];
                if insets.top <= 0.0 {
                    continue;
                }
                let frame: CGRect = msg_send![screen, frame];
                let left: CGRect = msg_send![screen, auxiliaryTopLeftArea];
                let right: CGRect = msg_send![screen, auxiliaryTopRightArea];
                let width = frame.size.width - left.size.width - right.size.width;
                return Some(Notch {
                    screen: frame,
                    width: if width > 60.0 && width < frame.size.width / 2.0 { width } else { 200.0 },
                    height: insets.top,
                });
            }
            None
        }
    }

    /// Above the menu bar (NSMainMenuWindowLevel is 24) so the wings sit on it; on every Space and
    /// over full-screen apps; out of ⌘` and Mission Control.
    pub fn configure(ns_window: *mut c_void) {
        unsafe {
            let Some(w) = (ns_window as *mut AnyObject).as_ref() else { return };
            let _: () = msg_send![w, setLevel: 25isize];
            // canJoinAllSpaces | stationary | ignoresCycle | fullScreenAuxiliary
            let behavior: usize = (1 << 0) | (1 << 4) | (1 << 6) | (1 << 8);
            let _: () = msg_send![w, setCollectionBehavior: behavior];
            let _: () = msg_send![w, setHasShadow: false];
        }
        // Out of the Dock's list of windows and the Window menu, as the popover.
        crate::keep_out_of_window_list(ns_window);
    }

    /// Top-centered on the notch, shown without taking focus from the app in front.
    pub fn place(ns_window: *mut c_void, n: &Notch, width: f64, height: f64) {
        unsafe {
            let Some(w) = (ns_window as *mut AnyObject).as_ref() else { return };
            let frame = CGRect {
                origin: CGPoint {
                    x: (n.screen.origin.x + (n.screen.size.width - width) / 2.0).round(),
                    y: n.screen.origin.y + n.screen.size.height - height,
                },
                size: CGSize { width, height },
            };
            let _: () = msg_send![w, setFrame: frame, display: true];
            let _: () = msg_send![w, orderFrontRegardless];
        }
    }
}
