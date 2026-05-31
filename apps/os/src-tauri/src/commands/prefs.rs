//! prefs:load / prefs:save → userData/viz_prefs.json

use crate::error::AppResult;
use crate::{json_store, paths};
use serde_json::{json, Value};
use tauri::AppHandle;

#[tauri::command]
pub fn prefs_load(app: AppHandle) -> Value {
    let v = json_store::read(&paths::prefs_file(&app));
    if v.is_null() {
        json!({})
    } else {
        v
    }
}

#[tauri::command]
pub fn prefs_save(app: AppHandle, d: Value) -> AppResult<bool> {
    json_store::write_atomic(&paths::prefs_file(&app), &d)?;
    Ok(true)
}
