//! Atomic JSON read/write helpers (replaces main.js readJSON/writeJSON).

use crate::error::{AppError, AppResult};
use serde_json::Value;
use std::path::Path;

/// Read a JSON file, returning `Null` when absent or unparseable (matches the
/// renderer's tolerant prefs loading).
pub fn read(path: &Path) -> Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null)
}

/// Write JSON via a temp file + rename for atomicity.
pub fn write_atomic(path: &Path, value: &Value) -> AppResult<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(value)?;
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path).map_err(AppError::from)?;
    Ok(())
}
