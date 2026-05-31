//! env:get, shell:openExternal, shell:openDownloadedInstaller, clipboard:write,
//! and the smoke `signalReady` sentinel.

use crate::error::{AppError, AppResult};
use crate::paths;
use crate::state::AppState;
use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub fn env_get() -> Value {
    let server_url = std::env::var("SWF_NODE_URL")
        .ok()
        .or_else(|| std::env::var("SRWK_SERVER").ok())
        .unwrap_or_else(|| "http://127.0.0.1:7777".to_string());
    let mode = std::env::var("SRWK_ROLE").unwrap_or_else(|_| "visualizer".to_string());
    json!({ "serverUrl": server_url, "mode": mode })
}

#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> AppResult<()> {
    // Electron restricted this to https; allow http(s) only.
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(AppError::msg("only http(s) urls are allowed"));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| AppError::msg(e.to_string()))
}

#[tauri::command]
pub fn clipboard_write(app: AppHandle, text: String) -> Value {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    match app.clipboard().write_text(text) {
        Ok(_) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

/// Open an installer the user downloaded — only inside ~/Downloads and only
/// with an allow-listed extension (ports the main.js guard).
#[tauri::command]
pub fn open_downloaded_installer(app: AppHandle, path: String) -> Value {
    let downloads = paths::downloads(&app);
    let p = std::path::PathBuf::from(&path);
    let canon = p.canonicalize().unwrap_or(p);
    let ext_ok = canon
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| ["dmg", "exe", "deb", "appimage"].contains(&e.to_lowercase().as_str()))
        .unwrap_or(false);
    if !canon.starts_with(&downloads) || !ext_ok {
        return json!({ "ok": false, "error": "path not allowed" });
    }
    match app
        .opener()
        .open_path(canon.to_string_lossy().to_string(), None::<&str>)
    {
        Ok(_) => json!({ "ok": true, "path": canon.to_string_lossy() }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

/// Renderer-ready sentinel for `--smoke-test`. No-op outside smoke mode.
#[tauri::command]
pub fn signal_ready(state: tauri::State<'_, AppState>) {
    state.smoke_ready.notify_waiters();
}
