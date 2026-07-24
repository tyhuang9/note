mod app_state;
mod error;
pub mod events;
mod mutation;
mod notes;
mod private_file;
mod security;

use app_state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .append_invoke_initialization_script(
            security::BROWSER_MEDIA_CAPTURE_DEFENSE_IN_DEPTH_SCRIPT,
        )
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            app.manage(AppState::new(app_data_dir));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            notes::load_app_data,
            notes::save_app_data
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
