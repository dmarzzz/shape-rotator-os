//! Per-platform path resolution, mirroring Electron's app.getPath(...).
//!
//! NOTE on continuity: Electron stored userData at
//! `~/Library/Application Support/Shape Rotator OS` (keyed off the app NAME),
//! while Tauri's `app_data_dir()` keys off the IDENTIFIER
//! (`~/Library/Application Support/com.shape-rotator.os`). They differ, so a
//! one-time migration (copy prefs/window_state/swf-node-data from the old
//! dir on first run) is wired in `migrate_legacy_user_data`.

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Application user-data directory (Electron's `userData`). Created if missing.
pub fn user_data(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("com.shape-rotator.os"));
    let _ = std::fs::create_dir_all(&dir);
    dir
}

pub fn downloads(app: &AppHandle) -> PathBuf {
    app.path()
        .download_dir()
        .or_else(|_| app.path().home_dir().map(|h| h.join("Downloads")))
        .unwrap_or_else(|_| std::env::temp_dir())
}

pub fn desktop(app: &AppHandle) -> PathBuf {
    app.path()
        .desktop_dir()
        .or_else(|_| app.path().home_dir().map(|h| h.join("Desktop")))
        .unwrap_or_else(|_| std::env::temp_dir())
}

pub fn documents(app: &AppHandle) -> PathBuf {
    app.path()
        .document_dir()
        .or_else(|_| app.path().home_dir().map(|h| h.join("Documents")))
        .unwrap_or_else(|_| std::env::temp_dir())
}

pub fn prefs_file(app: &AppHandle) -> PathBuf {
    user_data(app).join("viz_prefs.json")
}

pub fn legacy_prefs_file(app: &AppHandle) -> PathBuf {
    user_data(app).join("wall_prefs.json")
}

/// One-time `wall_prefs.json` → `viz_prefs.json` rename (ported from main.js
/// `migratePrefsFile`). Safe to call every launch.
pub fn migrate_prefs_file(app: &AppHandle) {
    let new = prefs_file(app);
    let old = legacy_prefs_file(app);
    if !new.exists() && old.exists() {
        let _ = std::fs::rename(&old, &new);
    }
}

/// Copy key state out of the old Electron userData dir on first Tauri launch,
/// so window bounds / prefs / the swf-node agent token carry over. Desktop
/// only (mobile had no Electron build). Best-effort; never fails the boot.
#[cfg(desktop)]
pub fn migrate_legacy_user_data(app: &AppHandle) {
    let new_dir = user_data(app);
    // If we already have prefs, assume migration done / not needed.
    if prefs_file(app).exists() || legacy_prefs_file(app).exists() {
        return;
    }
    let Some(old_dir) = legacy_electron_user_data(app) else {
        return;
    };
    if !old_dir.exists() || old_dir == new_dir {
        return;
    }
    for entry in [
        "viz_prefs.json",
        "wall_prefs.json",
        "window_state.json",
        "swarm-config.json",
    ] {
        let from = old_dir.join(entry);
        if from.exists() {
            let _ = std::fs::copy(&from, new_dir.join(entry));
        }
    }
    // swf-node-data/ (incl. the agent token) — copy the tree if present.
    let from_swf = old_dir.join("swf-node-data");
    if from_swf.is_dir() {
        let _ = copy_dir(&from_swf, &new_dir.join("swf-node-data"));
    }
}

#[cfg(desktop)]
fn legacy_electron_user_data(app: &AppHandle) -> Option<PathBuf> {
    let home = app.path().home_dir().ok()?;
    let name = "Shape Rotator OS"; // Electron app name (productName)
    #[cfg(target_os = "macos")]
    {
        Some(home.join("Library/Application Support").join(name))
    }
    #[cfg(target_os = "linux")]
    {
        let base = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"));
        Some(base.join(name))
    }
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData/Roaming"));
        Some(base.join(name))
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        let _ = (home, name);
        None
    }
}

#[cfg(desktop)]
fn copy_dir(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let dst = to.join(entry.file_name());
        if ty.is_dir() {
            copy_dir(&entry.path(), &dst)?;
        } else if ty.is_file() {
            std::fs::copy(entry.path(), dst)?;
        }
    }
    Ok(())
}
