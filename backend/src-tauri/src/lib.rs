use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

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
    rich_content: Option<serde_json::Value>,
    is_width_manually_resized: Option<bool>,
    image_data: Option<String>,
    image_name: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppSessionState {
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
        .invoke_handler(tauri::generate_handler![load_app_data, save_app_data])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
