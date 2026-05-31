//! OS keychain-backed secret storage (desktop), replacing Electron safeStorage.
//! Stores the swarm Anthropic API key in Keychain / Credential Manager /
//! Secret Service. Falls back to a 0o600 file under userData when no secret
//! service is reachable (headless Linux / CI), mirroring safeStorage's
//! plaintext fallback.

use tauri::AppHandle;

const SERVICE: &str = "com.shape-rotator.os";
const ACCOUNT: &str = "swarm-anthropic-api-key";

fn dev_path(app: &AppHandle) -> std::path::PathBuf {
    crate::paths::user_data(app).join("swarm-api-key.dev")
}

/// True if the OS secret service is reachable (the keyring backend can be
/// constructed). Used for the renderer's `safeStorageAvailable` flag.
pub fn available() -> bool {
    keyring::Entry::new(SERVICE, ACCOUNT).is_ok()
}

pub fn read_key(app: &AppHandle) -> Option<String> {
    if let Ok(entry) = keyring::Entry::new(SERVICE, ACCOUNT) {
        if let Ok(pw) = entry.get_password() {
            if !pw.is_empty() {
                return Some(pw);
            }
        }
    }
    std::fs::read_to_string(dev_path(app))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Store (Some) or clear (None / empty) the key.
pub fn write_key(app: &AppHandle, plain: Option<&str>) {
    let entry = keyring::Entry::new(SERVICE, ACCOUNT).ok();
    match plain {
        Some(k) if !k.is_empty() => {
            if let Some(e) = &entry {
                if e.set_password(k).is_ok() {
                    let _ = std::fs::remove_file(dev_path(app));
                    return;
                }
            }
            // Fallback: 0o600 file.
            let _ = write_private(&dev_path(app), k);
        }
        _ => {
            if let Some(e) = &entry {
                let _ = e.delete_credential();
            }
            let _ = std::fs::remove_file(dev_path(app));
        }
    }
}

#[cfg(unix)]
fn write_private(path: &std::path::Path, contents: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(contents.as_bytes())
}

#[cfg(not(unix))]
fn write_private(path: &std::path::Path, contents: &str) -> std::io::Result<()> {
    std::fs::write(path, contents)
}
