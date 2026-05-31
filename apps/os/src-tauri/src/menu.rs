//! Native application menu (desktop). Reproduces the platform submenus plus a
//! Tools item "Ask Cohort (Hermes)…" bound to Cmd/Ctrl+Shift+H.

use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Runtime};

pub const HERMES_ID: &str = "hermes";

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let hermes = MenuItemBuilder::with_id(HERMES_ID, "Ask Cohort (Hermes)…")
        .accelerator("CmdOrCtrl+Shift+H")
        .build(app)?;

    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let view = SubmenuBuilder::new(app, "View").fullscreen().build()?;
    let tools = SubmenuBuilder::new(app, "Tools").item(&hermes).build()?;
    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .separator()
        .close_window()
        .build()?;

    let mut mb = MenuBuilder::new(app);

    #[cfg(target_os = "macos")]
    {
        let app_menu = SubmenuBuilder::new(app, "Shape Rotator OS")
            .about(None)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        mb = mb.item(&app_menu);
    }

    let menu = mb.item(&edit).item(&view).item(&tools).item(&window).build()?;
    Ok(menu)
}
