use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

pub mod storage;

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppData {
    folders: Vec<Folder>,
    pages: Vec<Page>,
    blocks: Vec<TextBlock>,
    is_dark_mode: Option<bool>,
    session_state: Option<AppSessionState>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Folder {
    id: String,
    name: String,
    is_bookmarked: Option<bool>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    id: String,
    folder_id: String,
    title: String,
    is_bookmarked: Option<bool>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TextBlock {
    id: String,
    page_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    content: String,
    background_mode: Option<String>,
    rich_content: Option<serde_json::Value>,
    is_width_manually_resized: Option<bool>,
    image_data: Option<String>,
    image_name: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppSessionState {
    drawing_preferences: Option<serde_json::Value>,
    text_preferences: Option<serde_json::Value>,
    is_assistant_open: Option<bool>,
    is_drawing_tool_locked: Option<bool>,
    is_explorer_collapsed: Option<bool>,
    selected_folder_id: Option<String>,
    selected_page_id: Option<String>,
    open_page_tab_ids: Option<Vec<String>>,
    page_viewports: Option<HashMap<String, PageViewport>>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PageViewport {
    pan_offset: PanOffset,
    zoom_level: f64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PanOffset {
    x: f64,
    y: f64,
}

fn app_data_path(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;

    Ok(app_data_dir.join("note-data.json"))
}

fn storage_root(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    app_handle
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn initialize_storage(app_handle: tauri::AppHandle) -> Result<storage::StorageDiagnostics, String> {
    storage::initialize_storage_at(&storage_root(&app_handle)?)
}

#[tauri::command]
fn load_workspace_data(app_handle: tauri::AppHandle) -> Result<storage::WorkspaceData, String> {
    storage::load_workspace_data_at(&storage_root(&app_handle)?)
}

#[tauri::command]
fn apply_scene_changes(
    app_handle: tauri::AppHandle,
    batch: storage::SceneChangeBatch,
) -> Result<storage::SceneChangeResult, String> {
    storage::apply_scene_changes_at(&storage_root(&app_handle)?, batch)
}

#[tauri::command]
fn reconcile_workspace_structure(
    app_handle: tauri::AppHandle,
    structure: storage::WorkspaceStructure,
) -> Result<storage::WorkspaceStructureResult, String> {
    storage::reconcile_workspace_structure_at(&storage_root(&app_handle)?, structure)
}

#[tauri::command]
fn save_asset(
    app_handle: tauri::AppHandle,
    request: storage::SaveAssetRequest,
) -> Result<storage::AssetDto, String> {
    storage::repository::save_asset_at(&storage_root(&app_handle)?, request)
}

#[tauri::command]
fn load_asset(app_handle: tauri::AppHandle, asset_id: String) -> Result<storage::AssetDto, String> {
    storage::repository::load_asset_at(&storage_root(&app_handle)?, &asset_id)
}

#[tauri::command]
fn save_session_state(
    app_handle: tauri::AppHandle,
    state: serde_json::Value,
) -> Result<(), String> {
    storage::save_session_state_at(&storage_root(&app_handle)?, state)
}

#[tauri::command]
fn move_page_to_trash(app_handle: tauri::AppHandle, page_id: String) -> Result<(), String> {
    storage::trash_page_at(&storage_root(&app_handle)?, &page_id)
}

#[tauri::command]
fn move_folder_to_trash(app_handle: tauri::AppHandle, folder_id: String) -> Result<(), String> {
    storage::trash_folder_at(&storage_root(&app_handle)?, &folder_id)
}

#[tauri::command]
fn restore_page_from_trash(app_handle: tauri::AppHandle, page_id: String) -> Result<(), String> {
    storage::restore_page_at(&storage_root(&app_handle)?, &page_id)
}

#[tauri::command]
fn restore_folder_from_trash(
    app_handle: tauri::AppHandle,
    folder_id: String,
) -> Result<(), String> {
    storage::restore_folder_at(&storage_root(&app_handle)?, &folder_id)
}

#[tauri::command]
fn list_trash(app_handle: tauri::AppHandle) -> Result<Vec<storage::TrashEntryDto>, String> {
    storage::list_trash_at(&storage_root(&app_handle)?)
}

#[tauri::command]
fn get_trash_purge_preview(
    app_handle: tauri::AppHandle,
) -> Result<storage::TrashPurgePreview, String> {
    storage::trash_purge_preview_at(&storage_root(&app_handle)?)
}

#[tauri::command]
fn purge_trash(
    app_handle: tauri::AppHandle,
    request: storage::TrashPurgeRequest,
) -> Result<storage::TrashPurgePreview, String> {
    storage::purge_trash_at(&storage_root(&app_handle)?, request)
}

#[tauri::command]
fn load_app_data(app_handle: tauri::AppHandle) -> Result<AppData, String> {
    let data_path = app_data_path(&app_handle)?;

    if !data_path.exists() {
        return Ok(AppData::default());
    }

    let file_contents = fs::read_to_string(data_path).map_err(|error| error.to_string())?;
    serde_json::from_str(&file_contents).map_err(|error| error.to_string())
}

#[tauri::command]
fn save_app_data(app_handle: tauri::AppHandle, data: AppData) -> Result<(), String> {
    let data_path = app_data_path(&app_handle)?;

    if let Some(parent_dir) = data_path.parent() {
        fs::create_dir_all(parent_dir).map_err(|error| error.to_string())?;
    }

    let file_contents = serde_json::to_string_pretty(&data).map_err(|error| error.to_string())?;
    fs::write(data_path, file_contents).map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .invoke_handler(tauri::generate_handler![
            load_app_data,
            save_app_data,
            initialize_storage,
            load_workspace_data,
            apply_scene_changes,
            reconcile_workspace_structure,
            save_asset,
            load_asset,
            save_session_state,
            move_page_to_trash,
            move_folder_to_trash,
            restore_page_from_trash,
            restore_folder_from_trash,
            list_trash,
            get_trash_purge_preview,
            purge_trash
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
