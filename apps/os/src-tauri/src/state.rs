//! Shared, Manager-managed application state.
//!
//! Supervisor fields are desktop-only — they spawn/supervise child processes,
//! which iOS/Android forbid. On mobile the corresponding commands degrade to
//! "unsupported" and the renderer hides that UI.

use tokio::sync::Notify;

#[cfg(desktop)]
use crate::supervisor::{swarm::Swarm, swf_node::SwfNode};

pub struct AppState {
    /// Notified by the `signal_ready` command; the `--smoke-test` boot path
    /// awaits it (replaces Electron's `ipcMain.once("smoke:ready")`).
    pub smoke_ready: Notify,

    /// swf-node daemon supervisor (Phase 5).
    #[cfg(desktop)]
    pub swf: SwfNode,

    /// research-swarm supervisor (Phase 6).
    #[cfg(desktop)]
    pub swarm: Swarm,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            smoke_ready: Notify::new(),
            #[cfg(desktop)]
            swf: SwfNode::new(),
            #[cfg(desktop)]
            swarm: Swarm::new(),
        }
    }
}

impl AppState {
    pub fn new() -> Self {
        Self::default()
    }
}
