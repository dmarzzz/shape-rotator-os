//! `--smoke-test` / SROS_SMOKE_TEST headless boot gate (desktop, CI).
//!
//! Replaces Electron's hidden-window + ipcMain.once("smoke:ready") flow: the
//! renderer calls the `signal_ready` command once boot() resolves; we race
//! that against a timeout and exit 0 (ready) / 1 (timeout).

use crate::state::AppState;
use std::time::Duration;
use tauri::{AppHandle, Manager};

pub fn is_smoke() -> bool {
    std::env::args().any(|a| a == "--smoke-test")
        || std::env::var("SROS_SMOKE_TEST").as_deref() == Ok("1")
}

pub fn arm(app: &AppHandle) {
    let timeout_ms: u64 = std::env::var("SROS_SMOKE_TIMEOUT_MS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(45_000);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let waited = tokio::time::timeout(
            Duration::from_millis(timeout_ms),
            state.smoke_ready.notified(),
        )
        .await;
        match waited {
            Ok(_) => {
                eprintln!("[smoke] renderer ready — exit 0");
                app.exit(0);
            }
            Err(_) => {
                eprintln!("[smoke] timed out after {timeout_ms}ms — exit 1");
                app.exit(1);
            }
        }
    });
}
