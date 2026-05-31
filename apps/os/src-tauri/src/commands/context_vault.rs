//! Context-vault IPC. STUB — full FS/inference port lands in Phase 4.

use serde_json::{json, Value};
use tauri::AppHandle;

#[tauri::command]
pub fn context_vault_manifest(_app: AppHandle) -> Value {
    json!({ "ok": true, "manifest": { "sources": [], "articles": [] }, "roots": [], "vaultDir": null })
}

#[tauri::command]
pub fn context_vault_scan(_app: AppHandle) -> Value {
    json!({ "ok": true, "manifest": { "sources": [], "articles": [] } })
}

#[tauri::command]
pub fn context_vault_read_source(_app: AppHandle, _id: String) -> Value {
    json!({ "ok": false, "error": "not_implemented" })
}

#[tauri::command]
pub fn context_vault_read_raw_bundle(_app: AppHandle) -> Value {
    json!({ "ok": false, "error": "not_implemented" })
}

#[tauri::command]
pub fn context_vault_reveal_source(_app: AppHandle, _id: String) -> Value {
    json!({ "ok": false })
}

#[tauri::command]
pub fn context_vault_reveal_corpus(_app: AppHandle) -> Value {
    json!({ "ok": false })
}
