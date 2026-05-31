//! Window topology helpers (desktop). The hermes window is a lazy, focus-
//! existing singleton, matching main.js createHermesWindow.

use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

pub fn open_hermes<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window("hermes") {
        let _ = w.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(app, "hermes", WebviewUrl::App("hermes/index.html".into()))
        .title("ask cohort · hermes")
        .inner_size(760.0, 680.0)
        .min_inner_size(560.0, 480.0)
        .build()?;
    Ok(())
}
