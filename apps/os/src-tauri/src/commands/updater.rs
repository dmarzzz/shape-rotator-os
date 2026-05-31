//! App-update IPC. STUB — tauri-plugin-updater wiring lands in Phase 7.
//! get_app_info is real (drives the version chip + canAutoUpdate gating).

use serde_json::{json, Value};
use tauri::AppHandle;

#[tauri::command]
pub fn check_app_update(_app: AppHandle) -> Value {
    json!({ "ok": false, "reason": "dev_mode" })
}

#[tauri::command]
pub fn apply_app_update(_app: AppHandle) -> Value {
    json!({ "ok": false, "reason": "dev_mode" })
}

#[tauri::command]
pub fn apply_update_and_restart(_app: AppHandle) -> Value {
    json!({ "ok": false, "reason": "dev_mode" })
}

#[tauri::command]
pub fn download_and_reveal_update(_app: AppHandle) -> Value {
    json!({ "ok": false, "reason": "dev_mode" })
}

#[tauri::command]
pub fn get_app_info(_app: AppHandle) -> Value {
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "isPackaged": !cfg!(debug_assertions),
        "platform": tauri_plugin_os::platform(),
        "arch": tauri_plugin_os::arch(),
        "canAutoUpdate": false,
        "isAppImage": std::env::var("APPIMAGE").is_ok(),
        "signed": option_env!("SROS_SIGNED").is_some()
    })
}
