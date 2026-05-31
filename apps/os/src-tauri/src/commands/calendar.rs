//! Calendar export. PNG is fully native (decode the renderer's data URL →
//! save dialog → write). PDF reuses the exact same path: the renderer/shim
//! produces a PDF data URL (jsPDF) and hands it to this command, so the
//! offscreen-window + printToPDF mechanism is gone.

use base64::Engine;
use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub async fn export_calendar(app: AppHandle, opts: Value) -> Value {
    let format = if opts.get("format").and_then(Value::as_str) == Some("pdf") {
        "pdf"
    } else {
        "png"
    };
    let stamp = chrono::Local::now().format("%Y-%m-%d").to_string();
    let base = opts
        .get("filename")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("cohort-calendar-{stamp}"));
    let default_name = format!("{base}.{format}");

    let Some(data_url) = opts.get("dataUrl").and_then(Value::as_str) else {
        return json!({ "ok": false, "reason": "no_data" });
    };
    let Some(bytes) = decode_data_url(data_url) else {
        return json!({ "ok": false, "reason": "bad_data_url" });
    };

    let (title, filter_name) = if format == "pdf" {
        ("Export cohort calendar (PDF)", "PDF")
    } else {
        ("Export cohort calendar (PNG)", "PNG image")
    };

    let chosen = app
        .dialog()
        .file()
        .set_title(title)
        .set_directory(crate::paths::desktop(&app))
        .set_file_name(&default_name)
        .add_filter(filter_name, &[format])
        .blocking_save_file();

    let Some(path) = chosen else {
        return json!({ "ok": false, "reason": "cancelled" });
    };
    let path = match path.into_path() {
        Ok(p) => p,
        Err(e) => return json!({ "ok": false, "reason": "bad_path", "detail": e.to_string() }),
    };

    match std::fs::write(&path, bytes) {
        Ok(_) => json!({ "ok": true, "path": path.to_string_lossy() }),
        Err(e) => json!({ "ok": false, "reason": "export_failed", "detail": e.to_string() }),
    }
}

fn decode_data_url(s: &str) -> Option<Vec<u8>> {
    let idx = s.find("base64,")?;
    base64::engine::general_purpose::STANDARD
        .decode(s[idx + "base64,".len()..].as_bytes())
        .ok()
}
