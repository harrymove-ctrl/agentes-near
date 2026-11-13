//! The main window as the person left it: size, place, maximized and zoom, kept between launches in
//! `window.json` (the app's config folder). Saved as it moves and resizes (at most every half second), when it
//! is closed and when the app quits.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
pub struct Saved {
    /// Logical points of the window's frame.
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    #[serde(default)]
    pub maximized: bool,
    /// Index into the zoom steps (menus.rs).
    pub zoom: Option<usize>,
}

/// When the frame was last written: moving the window sends many events.
#[derive(Default)]
pub struct LastSaved(Mutex<Option<Instant>>);

const EVERY: Duration = Duration::from_millis(500);

fn file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join("window.json"))
}

pub fn load(app: &AppHandle) -> Saved {
    file(app)
        .and_then(|path| std::fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write(app: &AppHandle, saved: &Saved) {
    let Some(path) = file(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(bytes) = serde_json::to_vec(saved) {
        let _ = std::fs::write(path, bytes);
    }
}

/// Changes what is saved (read, change, write).
pub fn update(app: &AppHandle, change: impl FnOnce(&mut Saved)) {
    let mut saved = load(app);
    let before = saved.clone();
    change(&mut saved);
    if saved != before {
        write(app, &saved);
    }
}

/// The frame as it is now. Full screen or minimized frames aren't kept (the window comes back as it was
/// before); a maximized one keeps its last normal frame. `throttle`: at most every half second.
pub fn remember(window: &tauri::Window, throttle: bool) {
    let app = window.app_handle();
    if throttle {
        let last = app.state::<LastSaved>();
        let mut at = last.0.lock().unwrap_or_else(|e| e.into_inner());
        if at.is_some_and(|t| t.elapsed() < EVERY) {
            return;
        }
        *at = Some(Instant::now());
    }
    if crate::main_window::in_full_screen(window) || window.is_minimized().unwrap_or(false) {
        return;
    }
    let maximized = window.is_maximized().unwrap_or(false);
    let scale = window.scale_factor().unwrap_or(1.0);
    let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else { return };
    update(app, |saved| {
        saved.maximized = maximized;
        if !maximized {
            saved.x = Some(f64::from(position.x) / scale);
            saved.y = Some(f64::from(position.y) / scale);
            saved.width = Some(f64::from(size.width) / scale);
            saved.height = Some(f64::from(size.height) / scale);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_reads_back_and_tolerates_missing_fields() {
        let saved = Saved { x: Some(10.0), y: Some(20.0), width: Some(1200.0), height: Some(780.0), maximized: true, zoom: Some(4) };
        let json = serde_json::to_vec(&saved).unwrap();
        assert_eq!(serde_json::from_slice::<Saved>(&json).unwrap(), saved);
        assert_eq!(serde_json::from_slice::<Saved>(b"{}").unwrap(), Saved::default());
    }
}
