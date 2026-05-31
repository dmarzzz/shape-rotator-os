//! research-swarm IPC. Desktop drives the real Rust supervisor; mobile cannot
//! spawn the research-agent subprocess, so it degrades to "unsupported".

use crate::state::AppState;
use serde_json::{json, Value};
use tauri::{AppHandle, State};

#[tauri::command]
pub fn swarm_status(state: State<'_, AppState>) -> Value {
    #[cfg(desktop)]
    {
        return state.swarm.status();
    }
    #[cfg(not(desktop))]
    {
        let _ = state;
        json!({ "state": "idle", "running": false })
    }
}

#[tauri::command]
pub async fn swarm_start(app: AppHandle, state: State<'_, AppState>, opts: Value) -> Result<Value, ()> {
    #[cfg(desktop)]
    {
        return Ok(state.swarm.start(app, &state.swf, opts).await);
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, opts, state);
        Ok(json!({ "ok": false, "error": "unsupported" }))
    }
}

#[tauri::command]
pub fn swarm_stop(state: State<'_, AppState>) -> Value {
    #[cfg(desktop)]
    {
        return state.swarm.stop();
    }
    #[cfg(not(desktop))]
    {
        let _ = state;
        json!({ "ok": true })
    }
}

#[tauri::command]
pub fn swarm_config_get(app: AppHandle, state: State<'_, AppState>) -> Value {
    #[cfg(desktop)]
    {
        let _ = &state;
        return state.swarm.config_get(&app);
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, state);
        json!({
            "lmModel": "anthropic/claude-sonnet-4-6",
            "lmApiBase": "",
            "hasApiKey": false,
            "agent": { "binFound": false, "binPath": null },
            "safeStorageAvailable": false
        })
    }
}

#[tauri::command]
pub fn swarm_config_set(app: AppHandle, state: State<'_, AppState>, opts: Value) -> Value {
    #[cfg(desktop)]
    {
        return state.swarm.config_set(&app, &opts);
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, state, opts);
        json!({ "ok": false, "error": "unsupported" })
    }
}
