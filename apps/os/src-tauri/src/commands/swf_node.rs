//! swf-node supervisor IPC. Desktop drives the real Rust supervisor; mobile
//! returns "unsupported" (no local daemon — the renderer uses a remote
//! swf-node over the network instead, see env_get serverUrl).

use crate::state::AppState;
use serde_json::{json, Value};
use tauri::State;

#[tauri::command]
pub fn swf_node_status(state: State<'_, AppState>) -> String {
    #[cfg(desktop)]
    {
        return state.swf.status();
    }
    #[cfg(not(desktop))]
    {
        let _ = state;
        "unsupported".to_string()
    }
}

#[tauri::command]
pub fn swf_node_restart(state: State<'_, AppState>) -> Value {
    #[cfg(desktop)]
    {
        let ok = state.swf.restart();
        json!({ "ok": ok, "status": state.swf.status() })
    }
    #[cfg(not(desktop))]
    {
        let _ = state;
        json!({ "ok": false, "status": "unsupported" })
    }
}

#[tauri::command]
pub fn swf_node_external_info(state: State<'_, AppState>) -> Option<Value> {
    #[cfg(desktop)]
    {
        return state.swf.external_info();
    }
    #[cfg(not(desktop))]
    {
        let _ = state;
        None
    }
}

#[tauri::command]
pub fn swf_agent_token(state: State<'_, AppState>) -> Option<String> {
    #[cfg(desktop)]
    {
        return state.swf.agent_token();
    }
    #[cfg(not(desktop))]
    {
        let _ = state;
        None
    }
}
