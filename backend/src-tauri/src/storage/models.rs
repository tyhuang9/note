use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FolderDto {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub is_bookmarked: bool,
    #[serde(default = "active_lifecycle")]
    pub lifecycle: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trashed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PageDto {
    pub id: String,
    pub folder_id: String,
    pub title: String,
    #[serde(default)]
    pub is_bookmarked: bool,
    pub revision: i64,
    #[serde(default = "active_lifecycle")]
    pub lifecycle: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trashed_at: Option<i64>,
}

pub fn active_lifecycle() -> String {
    "active".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntryDto {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub trashed_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrashPurgePreview {
    pub folder_count: i64,
    pub page_count: i64,
    pub element_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrashPurgeRequest {
    pub expected_page_count: i64,
    pub expected_element_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceData {
    pub folders: Vec<FolderDto>,
    pub pages: Vec<PageDto>,
    pub elements: Vec<Value>,
    pub is_dark_mode: Option<bool>,
    pub session_state: Option<Value>,
    pub warnings: Vec<String>,
}

/// Workspace metadata is deliberately kept separate from scene changes.  This
/// lets the renderer save page elements with revision checks while folder/page
/// operations remain one small, validated transaction.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStructure {
    #[serde(default)]
    pub folders: Vec<FolderDto>,
    #[serde(default)]
    pub pages: Vec<WorkspacePageDto>,
    pub is_dark_mode: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePageDto {
    pub id: String,
    pub folder_id: String,
    pub title: String,
    #[serde(default)]
    pub is_bookmarked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStructureResult {
    pub pages: Vec<PageDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneChangeBatch {
    pub page_id: String,
    pub base_revision: i64,
    #[serde(default)]
    pub upserts: Vec<Value>,
    #[serde(default)]
    pub deleted_element_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SceneChangeResult {
    pub page_id: String,
    pub new_revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StorageDiagnostics {
    pub database_path: String,
    pub schema_version: i64,
    pub imported_legacy_data: bool,
    pub backup_path: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAssetRequest {
    pub data_base64: String,
    pub media_type: String,
    pub file_name: Option<String>,
    pub natural_width: Option<u32>,
    pub natural_height: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AssetDto {
    pub id: String,
    pub file_name: String,
    pub media_type: String,
    pub byte_size: u64,
    pub natural_width: Option<u32>,
    pub natural_height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_base64: Option<String>,
}
