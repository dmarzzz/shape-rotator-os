//! Native OS notifications (macOS / Linux / Windows / iOS / Android) via
//! tauri-plugin-notification. Invoked from the renderer through api.notify.
//! All-platform (not desktop-gated) — the plugin supports mobile too.
use tauri::AppHandle;
use tauri_plugin_notification::{NotificationExt, PermissionState};

/// Show a native notification immediately.
#[tauri::command]
pub fn notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    let res = app
        .notification()
        .builder()
        .title(title.clone())
        .body(body)
        .show();
    if let Err(e) = &res {
        eprintln!("[notify] failed to show \"{title}\": {e}");
    }
    res.map_err(|e| e.to_string())
}

/// Request OS permission to post notifications. Surfaces the system prompt on
/// first use (macOS / iOS / Android). Returns true if granted.
#[tauri::command]
pub fn notify_request_permission(app: AppHandle) -> Result<bool, String> {
    let state = app
        .notification()
        .request_permission()
        .map_err(|e| e.to_string())?;
    Ok(state == PermissionState::Granted)
}

/// Current permission state, without prompting.
#[tauri::command]
pub fn notify_permission_granted(app: AppHandle) -> Result<bool, String> {
    let state = app
        .notification()
        .permission_state()
        .map_err(|e| e.to_string())?;
    Ok(state == PermissionState::Granted)
}
