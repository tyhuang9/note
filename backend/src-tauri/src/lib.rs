mod app_state;
mod assistant;
mod calendar;
mod calendar_store;
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
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .append_invoke_initialization_script(
            security::BROWSER_MEDIA_CAPTURE_DEFENSE_IN_DEPTH_SCRIPT,
        );
    #[cfg(all(not(test), feature = "desktop-notifications"))]
    let builder = builder.plugin(tauri_plugin_notification::init());
    builder
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            let state = AppState::new(app_data_dir);
            state.start_calendar_initialization(Some(app.handle().clone()));
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            notes::load_app_data,
            notes::save_app_data,
            calendar::api::calendar_list_events,
            calendar::api::calendar_widget_agenda,
            calendar::api::calendar_agenda_page,
            calendar::api::calendar_search,
            calendar::api::calendar_get_event,
            calendar::api::calendar_create_event,
            calendar::api::calendar_update_event,
            calendar::api::calendar_delete_event,
            calendar::api::calendar_update_occurrence,
            calendar::api::calendar_delete_occurrence,
            calendar::api::calendar_get_settings,
            calendar::api::calendar_update_settings,
            calendar::api::calendar_readiness_get,
            calendar::api::calendar_retry_initialization,
            calendar::reminders::notification_status_get,
            calendar::reminders::notification_permission_request,
            calendar::import::import_ics_preview,
            calendar::import::import_ics_commit,
            calendar::export::export_ics,
            calendar::backup::backup_create,
            calendar::backup::backup_restore_preview,
            calendar::backup::backup_restore_commit,
            assistant::assistant_calendar_tool_execute,
            assistant::assistant_calendar_create_propose,
            assistant::assistant_calendar_create_revise,
            assistant::assistant_calendar_create_confirm,
            assistant::assistant_calendar_create_cancel,
            assistant::assistant_calendar_create_reconciliation_status,
            assistant::assistant_calendar_create_reconciliation_acknowledge
        ])
        .build(tauri::generate_context!())
        .expect("error while building Note")
        .run(|app, event| {
            #[cfg(desktop)]
            if matches!(event, tauri::RunEvent::Resumed) {
                calendar::reminders::trigger_reminder_resume(app);
            }
        });
}
