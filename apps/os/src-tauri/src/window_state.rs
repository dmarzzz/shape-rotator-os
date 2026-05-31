//! Window bounds persistence (desktop). Same `window_state.json` filename as
//! Electron for continuity. Restores size/position/fullscreen with a simple
//! off-screen guard (drops a position no monitor contains).

use serde::{Deserialize, Serialize};
use tauri::{Manager, PhysicalPosition, PhysicalSize};

#[derive(Serialize, Deserialize, Default)]
struct WinState {
    width: Option<u32>,
    height: Option<u32>,
    x: Option<i32>,
    y: Option<i32>,
    fullscreen: Option<bool>,
}

fn file(app: &tauri::AppHandle) -> std::path::PathBuf {
    crate::paths::user_data(app).join("window_state.json")
}

pub fn restore(win: &tauri::WebviewWindow) {
    let app = win.app_handle();
    let st: WinState =
        serde_json::from_value(crate::json_store::read(&file(app))).unwrap_or_default();

    if let (Some(w), Some(h)) = (st.width, st.height) {
        if w >= 200 && h >= 200 {
            let _ = win.set_size(PhysicalSize::new(w, h));
        }
    }
    if let (Some(x), Some(y)) = (st.x, st.y) {
        if position_visible(win, x, y) {
            let _ = win.set_position(PhysicalPosition::new(x, y));
        }
    }
    if st.fullscreen == Some(true) {
        let _ = win.set_fullscreen(true);
    }
}

/// Persist current bounds. The window-event callback hands a `Window`.
pub fn save(win: &tauri::Window) {
    let app = win.app_handle();
    let size = win.inner_size().ok();
    let pos = win.outer_position().ok();
    let fullscreen = win.is_fullscreen().unwrap_or(false);
    let st = WinState {
        width: size.map(|s| s.width),
        height: size.map(|s| s.height),
        x: pos.map(|p| p.x),
        y: pos.map(|p| p.y),
        fullscreen: Some(fullscreen),
    };
    if let Ok(v) = serde_json::to_value(st) {
        let _ = crate::json_store::write_atomic(&file(app), &v);
    }
}

/// True if (x+50, y+50) lands inside some connected monitor (drops bounds left
/// over from a now-disconnected display).
fn position_visible(win: &tauri::WebviewWindow, x: i32, y: i32) -> bool {
    let probe = (x + 50, y + 50);
    let Ok(monitors) = win.available_monitors() else {
        return true;
    };
    if monitors.is_empty() {
        return true;
    }
    monitors.iter().any(|m| {
        let p = m.position();
        let s = m.size();
        probe.0 >= p.x
            && probe.1 >= p.y
            && probe.0 < p.x + s.width as i32
            && probe.1 < p.y + s.height as i32
    })
}
