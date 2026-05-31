//! Shape Rotator OS — Tauri backend (replaces Electron main + preload).
//!
//! `run()` is the shared entry point for desktop (called from main.rs) and
//! mobile (via `tauri::mobile_entry_point`). Subsystems that need child
//! processes / native libs (swf-node, research-swarm, NDI sidecar, updater)
//! are desktop-only; their commands degrade to "unsupported" on iOS/Android,
//! where the renderer hides the corresponding UI.

mod commands;
mod error;
mod json_store;
mod matrix;
mod paths;
mod state;

#[cfg(desktop)]
mod menu;
#[cfg(desktop)]
mod secrets;
#[cfg(desktop)]
mod smoke;
#[cfg(desktop)]
mod supervisor;
#[cfg(desktop)]
mod window_state;
#[cfg(desktop)]
mod windows;

use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init());

    // E2E only. Starts a WebDriver bridge inside the WKWebView so WebdriverIO
    // can drive the app on macOS. Registered on the builder (not at runtime) so
    // the plugin's initialization script — window.__WEBDRIVER__ — is injected
    // into the page at webview creation; without that, every execute/findElement
    // hangs. Compiled in ONLY with `--features webdriver`, never in release.
    #[cfg(feature = "webdriver")]
    {
        builder = builder.plugin(tauri_plugin_webdriver_automation::init());
    }

    // Desktop-only plugins + native menu (no mobile equivalent).
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_process::init())
            .menu(|handle| menu::build(handle))
            .on_menu_event(|app, event| {
                if event.id().0.as_str() == menu::HERMES_ID {
                    let _ = windows::open_hermes(app);
                }
            });
        // tauri_plugin_updater is wired in Phase 7.
    }

    let app = builder
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::prefs::prefs_load,
            commands::prefs::prefs_save,
            commands::env_shell::env_get,
            commands::env_shell::open_external,
            commands::env_shell::clipboard_write,
            commands::env_shell::open_downloaded_installer,
            commands::env_shell::signal_ready,
            commands::context_vault::context_vault_manifest,
            commands::context_vault::context_vault_scan,
            commands::context_vault::context_vault_read_source,
            commands::context_vault::context_vault_read_raw_bundle,
            commands::context_vault::context_vault_reveal_source,
            commands::context_vault::context_vault_reveal_corpus,
            commands::updater::check_app_update,
            commands::updater::apply_app_update,
            commands::updater::apply_update_and_restart,
            commands::updater::download_and_reveal_update,
            commands::updater::get_app_info,
            commands::calendar::export_calendar,
            commands::swf_node::swf_node_status,
            commands::swf_node::swf_node_restart,
            commands::swf_node::swf_node_external_info,
            commands::swf_node::swf_agent_token,
            commands::swarm::swarm_status,
            commands::swarm::swarm_start,
            commands::swarm::swarm_stop,
            commands::swarm::swarm_config_get,
            commands::swarm::swarm_config_set,
            commands::easel::easel_available,
            commands::easel::easel_endpoint,
            commands::notify::notify,
            commands::notify::notify_request_permission,
            commands::notify::notify_permission_granted,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            paths::migrate_prefs_file(&handle);
            #[cfg(desktop)]
            {
                paths::migrate_legacy_user_data(&handle);
                // Begin swf-node supervision (mirrors app.whenReady → startSwfNode).
                app.state::<AppState>().swf.start(handle.clone());
            }

            // Main window is created hidden (config visible:false); restore
            // saved bounds before first paint, then show.
            if let Some(win) = app.get_webview_window("main") {
                #[cfg(desktop)]
                window_state::restore(&win);
                let _ = win.show();
            }

            // CI headless boot gate.
            #[cfg(desktop)]
            if smoke::is_smoke() {
                smoke::arm(&handle);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(desktop)]
            {
                // Persist main-window bounds on move/resize/close.
                if window.label() == "main" {
                    match event {
                        tauri::WindowEvent::Resized(_)
                        | tauri::WindowEvent::Moved(_)
                        | tauri::WindowEvent::CloseRequested { .. } => window_state::save(window),
                        _ => {}
                    }
                }
                // Re-check the daemon on focus (heals a crashed backend after an
                // in-place update). recheck() is a no-op when it's up.
                if let tauri::WindowEvent::Focused(true) = event {
                    window.state::<AppState>().swf.recheck();
                }
            }
            #[cfg(not(desktop))]
            {
                let _ = (window, event);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        // Graceful swf-node shutdown on quit (mirrors app.on("before-quit")).
        #[cfg(desktop)]
        if let tauri::RunEvent::ExitRequested { .. } = &event {
            let state = app_handle.state::<AppState>();
            tauri::async_runtime::block_on(state.swf.stop());
        }
        let _ = (app_handle, event);
    });
}
