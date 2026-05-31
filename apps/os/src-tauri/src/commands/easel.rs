//! easel / NDI bridge. STUB — the Node NDI sidecar + WS endpoint land in
//! Phase 9 (desktop only; the sidecar cannot run on iOS/Android, so
//! easel_available stays false there and the renderer hides projection).

use serde_json::Value;

#[tauri::command]
pub fn easel_available() -> bool {
    false
}

/// Returns `{ port, token }` for the renderer's direct WebSocket to the NDI
/// sidecar, or null when unavailable.
#[tauri::command]
pub fn easel_endpoint() -> Option<Value> {
    None
}
