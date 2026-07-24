use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Read, Write},
    path::PathBuf,
};

use serde::{Deserialize, Serialize};
use tauri::{
    ipc::{InvokeBody, Request},
    State, WebviewWindow,
};

use crate::{app_state::AppState, error::NativeError, private_file::atomic_write_private};

const APP_DATA_FILE_NAME: &str = "note-data.json";
const MAX_APP_DATA_BYTES: usize = 128 * 1024 * 1024;
const MAX_FOLDERS: usize = 10_000;
const MAX_PAGES: usize = 100_000;
const MAX_BLOCKS: usize = 200_000;
const MAX_SESSION_TABS: usize = 10_000;
const MAX_VIEWPORTS: usize = 100_000;
const MAX_ID_BYTES: usize = 4 * 1024;
const MAX_LABEL_BYTES: usize = 1024 * 1024;
const MAX_BLOCK_CONTENT_BYTES: usize = 8 * 1024 * 1024;
const MAX_IMAGE_SOURCE_BYTES: usize = 32 * 1024 * 1024;
const MAX_IMAGE_NAME_BYTES: usize = 1024 * 1024;
const MAX_RICH_CONTENT_DEPTH: usize = 64;
const MAX_RICH_CONTENT_NODES: usize = 1_000_000;
const MAX_RICH_CONTENT_STRING_BYTES: usize = 8 * 1024 * 1024;
const MAX_RICH_CONTENT_KEY_BYTES: usize = 4 * 1024;
const MAX_AGGREGATE_RECORDS: usize = 500_000;
const MAX_AGGREGATE_DECODED_IMAGE_BYTES: usize = 96 * 1024 * 1024;

const PRODUCTION_VALIDATION_LIMITS: ValidationLimits = ValidationLimits {
    aggregate_bytes: MAX_APP_DATA_BYTES,
    aggregate_decoded_image_bytes: MAX_AGGREGATE_DECODED_IMAGE_BYTES,
    aggregate_records: MAX_AGGREGATE_RECORDS,
    output_bytes: MAX_APP_DATA_BYTES,
};

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PersistedAppDataV1 {
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
    is_assistant_open: Option<bool>,
    is_explorer_collapsed: Option<bool>,
    selected_folder_id: Option<String>,
    selected_page_id: Option<String>,
    open_page_tab_ids: Option<Vec<String>>,
    page_viewports: Option<HashMap<String, PageViewport>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace_tabs: Option<Vec<PersistedWorkspaceTab>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    selected_workspace_tab_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedWorkspaceTab {
    id: String,
    #[serde(default)]
    title: String,
    view: WorkspaceView,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
enum WorkspaceView {
    Note {
        #[serde(rename = "pageId")]
        page_id: String,
    },
    Agenda {
        #[serde(default = "default_agenda_view")]
        view: AgendaView,
    },
    Settings {
        #[serde(skip_serializing_if = "Option::is_none")]
        section: Option<String>,
    },
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum AgendaView {
    Agenda,
    Month,
}

const fn default_agenda_view() -> AgendaView {
    AgendaView::Agenda
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

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SaveAppData {
    folders: Vec<SaveFolder>,
    pages: Vec<SavePage>,
    blocks: Vec<SaveTextBlock>,
    is_dark_mode: Option<bool>,
    session_state: Option<SaveAppSessionState>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SaveFolder {
    id: String,
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SavePage {
    id: String,
    folder_id: String,
    title: String,
    is_bookmarked: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SaveTextBlock {
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

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SaveAppSessionState {
    is_assistant_open: Option<bool>,
    is_explorer_collapsed: Option<bool>,
    selected_folder_id: Option<String>,
    selected_page_id: Option<String>,
    open_page_tab_ids: Option<Vec<String>>,
    page_viewports: Option<HashMap<String, SavePageViewport>>,
    workspace_tabs: Option<Vec<SaveWorkspaceTab>>,
    selected_workspace_tab_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SaveWorkspaceTab {
    id: String,
    title: String,
    view: SaveWorkspaceView,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase", tag = "kind")]
enum SaveWorkspaceView {
    Note {
        #[serde(rename = "pageId")]
        page_id: String,
    },
    Agenda {
        view: AgendaView,
    },
    Settings {
        section: Option<String>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SavePageViewport {
    pan_offset: SavePanOffset,
    zoom_level: f64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SavePanOffset {
    x: f64,
    y: f64,
}

impl From<SaveAppData> for PersistedAppDataV1 {
    fn from(data: SaveAppData) -> Self {
        Self {
            folders: data
                .folders
                .into_iter()
                .map(|folder| Folder {
                    id: folder.id,
                    name: folder.name,
                })
                .collect(),
            pages: data
                .pages
                .into_iter()
                .map(|page| Page {
                    id: page.id,
                    folder_id: page.folder_id,
                    title: page.title,
                    is_bookmarked: page.is_bookmarked,
                })
                .collect(),
            blocks: data
                .blocks
                .into_iter()
                .map(|block| TextBlock {
                    id: block.id,
                    page_id: block.page_id,
                    x: block.x,
                    y: block.y,
                    width: block.width,
                    height: block.height,
                    content: block.content,
                    rich_content: block.rich_content,
                    is_width_manually_resized: block.is_width_manually_resized,
                    image_data: block.image_data,
                    image_name: block.image_name,
                })
                .collect(),
            is_dark_mode: data.is_dark_mode,
            session_state: data.session_state.map(Into::into),
        }
    }
}

impl From<SaveAppSessionState> for AppSessionState {
    fn from(session: SaveAppSessionState) -> Self {
        Self {
            is_assistant_open: session.is_assistant_open,
            is_explorer_collapsed: session.is_explorer_collapsed,
            selected_folder_id: session.selected_folder_id,
            selected_page_id: session.selected_page_id,
            open_page_tab_ids: session.open_page_tab_ids,
            page_viewports: session.page_viewports.map(|viewports| {
                viewports
                    .into_iter()
                    .map(|(page_id, viewport)| {
                        (
                            page_id,
                            PageViewport {
                                pan_offset: PanOffset {
                                    x: viewport.pan_offset.x,
                                    y: viewport.pan_offset.y,
                                },
                                zoom_level: viewport.zoom_level,
                            },
                        )
                    })
                    .collect()
            }),
            workspace_tabs: session.workspace_tabs.map(|tabs| {
                tabs.into_iter()
                    .map(|tab| PersistedWorkspaceTab {
                        id: tab.id,
                        title: tab.title,
                        view: match tab.view {
                            SaveWorkspaceView::Note { page_id } => WorkspaceView::Note { page_id },
                            SaveWorkspaceView::Agenda { view } => WorkspaceView::Agenda { view },
                            SaveWorkspaceView::Settings { section } => {
                                WorkspaceView::Settings { section }
                            }
                        },
                    })
                    .collect()
            }),
            selected_workspace_tab_id: session.selected_workspace_tab_id,
        }
    }
}

#[derive(Clone, Copy)]
struct ValidationLimits {
    aggregate_bytes: usize,
    aggregate_decoded_image_bytes: usize,
    aggregate_records: usize,
    output_bytes: usize,
}

pub(crate) struct NotesService {
    data_path: PathBuf,
}

impl NotesService {
    pub(crate) fn new(app_data_dir: PathBuf) -> Self {
        Self {
            data_path: app_data_dir.join(APP_DATA_FILE_NAME),
        }
    }

    fn load(&self) -> Result<PersistedAppDataV1, NativeError> {
        let metadata = match fs::symlink_metadata(&self.data_path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(PersistedAppDataV1::default());
            }
            Err(_) => return Err(NativeError::storage_unavailable()),
        };

        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(NativeError::storage_unavailable());
        }
        if metadata.len() > MAX_APP_DATA_BYTES as u64 {
            return Err(NativeError::data_too_large("noteData"));
        }

        let file = File::open(&self.data_path).map_err(|_| NativeError::storage_unavailable())?;
        let mut file_contents = Vec::with_capacity(metadata.len() as usize);
        file.take((MAX_APP_DATA_BYTES + 1) as u64)
            .read_to_end(&mut file_contents)
            .map_err(|_| NativeError::storage_unavailable())?;
        if file_contents.len() > MAX_APP_DATA_BYTES {
            return Err(NativeError::data_too_large("noteData"));
        }

        let data: PersistedAppDataV1 = serde_json::from_slice(&file_contents)
            .map_err(|_| NativeError::invalid_data(Some("noteData")))?;
        validate_app_data(&data, PRODUCTION_VALIDATION_LIMITS)?;
        Ok(data)
    }

    fn save_raw(&self, raw: &[u8]) -> Result<(), NativeError> {
        self.save_raw_with_limits(raw, PRODUCTION_VALIDATION_LIMITS)
    }

    fn save_raw_with_limits(
        &self,
        raw: &[u8],
        limits: ValidationLimits,
    ) -> Result<(), NativeError> {
        let command_data: SaveAppData =
            serde_json::from_slice(raw).map_err(|_| NativeError::invalid_data(Some("noteData")))?;
        let data = PersistedAppDataV1::from(command_data);
        self.save_with_limits(&data, limits)
    }

    fn save_with_limits(
        &self,
        data: &PersistedAppDataV1,
        limits: ValidationLimits,
    ) -> Result<(), NativeError> {
        validate_app_data(data, limits)?;
        let file_contents = serialize_bounded(data, limits.output_bytes)?;

        let parent = self
            .data_path
            .parent()
            .ok_or_else(NativeError::storage_unavailable)?;
        fs::create_dir_all(parent).map_err(|_| NativeError::storage_unavailable())?;
        atomic_write_private(&self.data_path, &file_contents)
            .map_err(|_| NativeError::storage_unavailable())
    }
}

fn ensure_notes_window_label(label: &str) -> Result<(), NativeError> {
    if label == "main" {
        Ok(())
    } else {
        Err(NativeError::forbidden_window())
    }
}

#[tauri::command]
pub(crate) fn load_app_data(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<PersistedAppDataV1, NativeError> {
    ensure_notes_window_label(window.label())?;
    state.notes.load()
}

#[tauri::command]
pub(crate) fn save_app_data(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: Request<'_>,
) -> Result<(), NativeError> {
    save_app_data_body(window.label(), &state, request.body(), MAX_APP_DATA_BYTES)
}

fn save_app_data_body(
    caller_label: &str,
    state: &AppState,
    body: &InvokeBody,
    raw_byte_limit: usize,
) -> Result<(), NativeError> {
    ensure_notes_window_label(caller_label)?;
    let raw = match body {
        InvokeBody::Raw(raw) => raw,
        InvokeBody::Json(_) => return Err(NativeError::invalid_data(Some("noteData"))),
    };
    if raw.len() > raw_byte_limit {
        return Err(NativeError::data_too_large("noteData"));
    }

    let _admission = state.note_mutations.begin()?;
    state.notes.save_raw(raw)
}

fn validate_app_data(
    data: &PersistedAppDataV1,
    limits: ValidationLimits,
) -> Result<(), NativeError> {
    validate_count(data.folders.len(), MAX_FOLDERS, "folders")?;
    validate_count(data.pages.len(), MAX_PAGES, "pages")?;
    validate_count(data.blocks.len(), MAX_BLOCKS, "blocks")?;

    for folder in &data.folders {
        validate_string(&folder.id, MAX_ID_BYTES, "folders")?;
        validate_string(&folder.name, MAX_LABEL_BYTES, "folders")?;
    }

    for page in &data.pages {
        validate_string(&page.id, MAX_ID_BYTES, "pages")?;
        validate_string(&page.folder_id, MAX_ID_BYTES, "pages")?;
        validate_string(&page.title, MAX_LABEL_BYTES, "pages")?;
    }

    let mut rich_content_nodes = 0;
    for block in &data.blocks {
        validate_string(&block.id, MAX_ID_BYTES, "blocks")?;
        validate_string(&block.page_id, MAX_ID_BYTES, "blocks")?;
        validate_finite(block.x, "blocks")?;
        validate_finite(block.y, "blocks")?;
        validate_finite(block.width, "blocks")?;
        validate_finite(block.height, "blocks")?;
        validate_string(&block.content, MAX_BLOCK_CONTENT_BYTES, "blocks")?;
        if let Some(rich_content) = &block.rich_content {
            validate_rich_content(rich_content, 1, &mut rich_content_nodes)?;
        }
        if let Some(image_data) = &block.image_data {
            validate_image_source(image_data)?;
        }
        if let Some(image_name) = &block.image_name {
            validate_string(image_name, MAX_IMAGE_NAME_BYTES, "blocks")?;
        }
    }

    if let Some(session) = &data.session_state {
        validate_session(session)?;
    }
    validate_cumulative_budgets(data, limits)
}

fn validate_session(session: &AppSessionState) -> Result<(), NativeError> {
    for value in [
        session.selected_folder_id.as_deref(),
        session.selected_page_id.as_deref(),
        session.selected_workspace_tab_id.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        validate_string(value, MAX_ID_BYTES, "sessionState")?;
    }

    if let Some(tab_ids) = &session.open_page_tab_ids {
        validate_count(tab_ids.len(), MAX_SESSION_TABS, "sessionState")?;
        for tab_id in tab_ids {
            validate_string(tab_id, MAX_ID_BYTES, "sessionState")?;
        }
    }

    if let Some(tabs) = &session.workspace_tabs {
        validate_count(tabs.len(), MAX_SESSION_TABS, "sessionState")?;
        for tab in tabs {
            validate_string(&tab.id, MAX_ID_BYTES, "sessionState")?;
            validate_string(&tab.title, MAX_LABEL_BYTES, "sessionState")?;
            match &tab.view {
                WorkspaceView::Note { page_id } => {
                    validate_string(page_id, MAX_ID_BYTES, "sessionState")?;
                }
                WorkspaceView::Settings {
                    section: Some(section),
                } => {
                    validate_string(section, MAX_ID_BYTES, "sessionState")?;
                }
                WorkspaceView::Agenda { .. } | WorkspaceView::Settings { section: None } => {}
            }
        }
    }

    if let Some(viewports) = &session.page_viewports {
        validate_count(viewports.len(), MAX_VIEWPORTS, "sessionState")?;
        for (page_id, viewport) in viewports {
            validate_string(page_id, MAX_ID_BYTES, "sessionState")?;
            validate_finite(viewport.pan_offset.x, "sessionState")?;
            validate_finite(viewport.pan_offset.y, "sessionState")?;
            validate_finite(viewport.zoom_level, "sessionState")?;
        }
    }
    Ok(())
}

fn validate_cumulative_budgets(
    data: &PersistedAppDataV1,
    limits: ValidationLimits,
) -> Result<(), NativeError> {
    let mut budget = ValidationBudget::new(limits);
    budget.add_records(data.folders.len(), "folders")?;
    budget.add_records(data.pages.len(), "pages")?;
    budget.add_records(data.blocks.len(), "blocks")?;

    for folder in &data.folders {
        budget.add_bytes(folder.id.len(), "folders")?;
        budget.add_bytes(folder.name.len(), "folders")?;
    }
    for page in &data.pages {
        budget.add_bytes(page.id.len(), "pages")?;
        budget.add_bytes(page.folder_id.len(), "pages")?;
        budget.add_bytes(page.title.len(), "pages")?;
    }
    for block in &data.blocks {
        budget.add_bytes(block.id.len(), "blocks")?;
        budget.add_bytes(block.page_id.len(), "blocks")?;
        budget.add_bytes(block.content.len(), "blocks")?;
        if let Some(value) = &block.rich_content {
            validate_cumulative_rich_content(value, &mut budget)?;
        }
        if let Some(source) = &block.image_data {
            budget.add_bytes(source.len(), "imageData")?;
            budget.add_decoded_image_bytes(decoded_image_size(source)?)?;
        }
        if let Some(name) = &block.image_name {
            budget.add_bytes(name.len(), "blocks")?;
        }
    }

    if let Some(session) = &data.session_state {
        for value in [
            session.selected_folder_id.as_deref(),
            session.selected_page_id.as_deref(),
            session.selected_workspace_tab_id.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            budget.add_bytes(value.len(), "sessionState")?;
        }
        if let Some(tab_ids) = &session.open_page_tab_ids {
            budget.add_records(tab_ids.len(), "sessionState")?;
            for tab_id in tab_ids {
                budget.add_bytes(tab_id.len(), "sessionState")?;
            }
        }
        if let Some(tabs) = &session.workspace_tabs {
            budget.add_records(tabs.len(), "sessionState")?;
            for tab in tabs {
                budget.add_bytes(tab.id.len(), "sessionState")?;
                budget.add_bytes(tab.title.len(), "sessionState")?;
                match &tab.view {
                    WorkspaceView::Note { page_id } => {
                        budget.add_bytes(page_id.len(), "sessionState")?;
                    }
                    WorkspaceView::Settings {
                        section: Some(section),
                    } => budget.add_bytes(section.len(), "sessionState")?,
                    WorkspaceView::Agenda { .. } | WorkspaceView::Settings { section: None } => {}
                }
            }
        }
        if let Some(viewports) = &session.page_viewports {
            budget.add_records(viewports.len(), "sessionState")?;
            for page_id in viewports.keys() {
                budget.add_bytes(page_id.len(), "sessionState")?;
            }
        }
    }
    Ok(())
}

fn validate_cumulative_rich_content(
    value: &serde_json::Value,
    budget: &mut ValidationBudget,
) -> Result<(), NativeError> {
    budget.add_records(1, "richContent")?;
    match value {
        serde_json::Value::String(value) => budget.add_bytes(value.len(), "richContent"),
        serde_json::Value::Array(values) => {
            for value in values {
                validate_cumulative_rich_content(value, budget)?;
            }
            Ok(())
        }
        serde_json::Value::Object(values) => {
            for (key, value) in values {
                budget.add_bytes(key.len(), "richContent")?;
                validate_cumulative_rich_content(value, budget)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

struct ValidationBudget {
    bytes: usize,
    decoded_image_bytes: usize,
    limits: ValidationLimits,
    records: usize,
}

impl ValidationBudget {
    fn new(limits: ValidationLimits) -> Self {
        Self {
            bytes: 0,
            decoded_image_bytes: 0,
            limits,
            records: 0,
        }
    }

    fn add_bytes(&mut self, amount: usize, field: &'static str) -> Result<(), NativeError> {
        self.bytes = self
            .bytes
            .checked_add(amount)
            .ok_or_else(|| NativeError::data_too_large(field))?;
        if self.bytes > self.limits.aggregate_bytes {
            return Err(NativeError::data_too_large(field));
        }
        Ok(())
    }

    fn add_decoded_image_bytes(&mut self, amount: usize) -> Result<(), NativeError> {
        self.decoded_image_bytes = self
            .decoded_image_bytes
            .checked_add(amount)
            .ok_or_else(|| NativeError::data_too_large("imageData"))?;
        if self.decoded_image_bytes > self.limits.aggregate_decoded_image_bytes {
            return Err(NativeError::data_too_large("imageData"));
        }
        Ok(())
    }

    fn add_records(&mut self, amount: usize, field: &'static str) -> Result<(), NativeError> {
        self.records = self
            .records
            .checked_add(amount)
            .ok_or_else(|| NativeError::data_too_large(field))?;
        if self.records > self.limits.aggregate_records {
            return Err(NativeError::data_too_large(field));
        }
        Ok(())
    }
}

struct LimitedBuffer {
    bytes: Vec<u8>,
    limit: usize,
}

impl LimitedBuffer {
    fn new(limit: usize) -> Self {
        Self {
            bytes: Vec::with_capacity(limit.min(64 * 1024)),
            limit,
        }
    }
}

impl Write for LimitedBuffer {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let next_len = self
            .bytes
            .len()
            .checked_add(bytes.len())
            .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::FileTooLarge))?;
        if next_len > self.limit {
            return Err(std::io::Error::from(std::io::ErrorKind::FileTooLarge));
        }
        if next_len > self.bytes.capacity() {
            let target_capacity = self
                .bytes
                .capacity()
                .saturating_mul(2)
                .max(next_len)
                .min(self.limit);
            self.bytes
                .try_reserve_exact(target_capacity - self.bytes.len())
                .map_err(|_| {
                    std::io::Error::new(
                        std::io::ErrorKind::OutOfMemory,
                        "serialization allocation failed",
                    )
                })?;
        }
        if self.bytes.capacity() < next_len {
            return Err(std::io::Error::new(
                std::io::ErrorKind::OutOfMemory,
                "serialization allocation failed",
            ));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn serialize_bounded(
    data: &PersistedAppDataV1,
    output_limit: usize,
) -> Result<Vec<u8>, NativeError> {
    let mut output = LimitedBuffer::new(output_limit);
    serde_json::to_writer_pretty(&mut output, data).map_err(|error| {
        if error.io_error_kind() == Some(std::io::ErrorKind::FileTooLarge) {
            NativeError::data_too_large("noteData")
        } else {
            NativeError::invalid_data(Some("noteData"))
        }
    })?;
    Ok(output.bytes)
}

fn validate_rich_content(
    value: &serde_json::Value,
    depth: usize,
    node_count: &mut usize,
) -> Result<(), NativeError> {
    if depth > MAX_RICH_CONTENT_DEPTH {
        return Err(NativeError::data_too_large("richContent"));
    }
    *node_count = node_count
        .checked_add(1)
        .ok_or_else(|| NativeError::data_too_large("richContent"))?;
    if *node_count > MAX_RICH_CONTENT_NODES {
        return Err(NativeError::data_too_large("richContent"));
    }

    match value {
        serde_json::Value::String(value) => {
            validate_string(value, MAX_RICH_CONTENT_STRING_BYTES, "richContent")
        }
        serde_json::Value::Array(values) => {
            for value in values {
                validate_rich_content(value, depth + 1, node_count)?;
            }
            Ok(())
        }
        serde_json::Value::Object(values) => {
            for (key, value) in values {
                validate_string(key, MAX_RICH_CONTENT_KEY_BYTES, "richContent")?;
                validate_rich_content(value, depth + 1, node_count)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn validate_image_source(source: &str) -> Result<(), NativeError> {
    let decoded_bytes = decoded_image_size(source)?;
    if decoded_bytes > MAX_IMAGE_SOURCE_BYTES {
        return Err(NativeError::data_too_large("imageData"));
    }
    Ok(())
}

fn decoded_image_size(source: &str) -> Result<usize, NativeError> {
    if !source
        .get(.."data:image/".len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("data:image/"))
    {
        if source
            .get(.."http://".len())
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("http://"))
            || source
                .get(.."https://".len())
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("https://"))
        {
            validate_string(source, MAX_ID_BYTES, "imageData")?;
            return Ok(0);
        }
        return Err(NativeError::invalid_data(Some("imageData")));
    }

    let (metadata, encoded) = source
        .split_once(',')
        .ok_or_else(|| NativeError::invalid_data(Some("imageData")))?;
    let decoded_bytes = if metadata
        .get(metadata.len().saturating_sub(";base64".len())..)
        .is_some_and(|suffix| suffix.eq_ignore_ascii_case(";base64"))
    {
        decoded_base64_len(encoded).ok_or_else(|| NativeError::invalid_data(Some("imageData")))?
    } else {
        encoded.len()
    };
    Ok(decoded_bytes)
}

fn decoded_base64_len(encoded: &str) -> Option<usize> {
    let mut characters = 0usize;
    let mut padding = 0usize;
    let mut saw_padding = false;

    for byte in encoded.bytes() {
        if byte.is_ascii_whitespace() {
            continue;
        }
        if byte == b'=' {
            saw_padding = true;
            padding = padding.checked_add(1)?;
            if padding > 2 {
                return None;
            }
        } else if byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/') {
            if saw_padding {
                return None;
            }
        } else {
            return None;
        }
        characters = characters.checked_add(1)?;
    }

    if characters == 0 || !characters.is_multiple_of(4) {
        return None;
    }
    characters
        .checked_div(4)?
        .checked_mul(3)?
        .checked_sub(padding)
}

fn validate_count(actual: usize, maximum: usize, field: &'static str) -> Result<(), NativeError> {
    if actual > maximum {
        Err(NativeError::data_too_large(field))
    } else {
        Ok(())
    }
}

fn validate_string(
    value: &str,
    maximum_bytes: usize,
    field: &'static str,
) -> Result<(), NativeError> {
    if value.len() > maximum_bytes {
        Err(NativeError::data_too_large(field))
    } else {
        Ok(())
    }
}

fn validate_finite(value: f64, field: &'static str) -> Result<(), NativeError> {
    if value.is_finite() {
        Ok(())
    } else {
        Err(NativeError::invalid_data(Some(field)))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;

    use super::*;
    use crate::error::NativeErrorCode;

    fn empty_app_data() -> PersistedAppDataV1 {
        PersistedAppDataV1::default()
    }

    fn text_block() -> TextBlock {
        TextBlock {
            id: "block-1".to_owned(),
            page_id: "page-1".to_owned(),
            x: 0.0,
            y: 0.0,
            width: 320.0,
            height: 160.0,
            content: "hello".to_owned(),
            rich_content: None,
            is_width_manually_resized: None,
            image_data: None,
            image_name: None,
        }
    }

    fn valid_save_json() -> serde_json::Value {
        json!({
            "folders": [{ "id": "folder-1", "name": "Folder" }],
            "pages": [{
                "id": "page-1",
                "folderId": "folder-1",
                "title": "Page",
                "isBookmarked": true
            }],
            "blocks": [{
                "id": "block-1",
                "pageId": "page-1",
                "x": 0.0,
                "y": 0.0,
                "width": 320.0,
                "height": 160.0,
                "content": "hello",
                "richContent": { "type": "doc", "content": [] },
                "isWidthManuallyResized": false,
                "imageData": null,
                "imageName": null
            }],
            "isDarkMode": true,
            "sessionState": {
                "isAssistantOpen": false,
                "isExplorerCollapsed": true,
                "selectedFolderId": "folder-1",
                "selectedPageId": "page-1",
                "openPageTabIds": ["page-1"],
                "pageViewports": {
                    "page-1": {
                        "panOffset": { "x": 1.0, "y": 2.0 },
                        "zoomLevel": 1.0
                    }
                },
                "workspaceTabs": [
                    {
                        "id": "note:page-1",
                        "title": "Page",
                        "view": { "kind": "note", "pageId": "page-1" }
                    },
                    {
                        "id": "agenda:month",
                        "title": "Month",
                        "view": { "kind": "agenda", "view": "month" }
                    },
                    {
                        "id": "settings:models",
                        "title": "Settings",
                        "view": { "kind": "settings", "section": "models" }
                    }
                ],
                "selectedWorkspaceTabId": "note:page-1"
            }
        })
    }

    fn test_limits(
        aggregate_bytes: usize,
        aggregate_records: usize,
        output_bytes: usize,
    ) -> ValidationLimits {
        ValidationLimits {
            aggregate_bytes,
            aggregate_decoded_image_bytes: usize::MAX,
            aggregate_records,
            output_bytes,
        }
    }

    #[test]
    fn note_persistence_requires_the_exact_main_label() {
        assert_eq!(ensure_notes_window_label("main"), Ok(()));
        for label in [
            "widget",
            "quick-command",
            "event-editor",
            "Main",
            "main-2",
            "main*",
            "",
        ] {
            assert_eq!(
                ensure_notes_window_label(label),
                Err(NativeError::forbidden_window())
            );
        }
    }

    #[test]
    fn capability_labels_match_command_authorization() {
        for (source, allowed) in [
            (include_str!("../capabilities/main.json"), true),
            (include_str!("../capabilities/widget.json"), false),
            (include_str!("../capabilities/quick-command.json"), false),
            (include_str!("../capabilities/event-editor.json"), false),
        ] {
            let capability: serde_json::Value = serde_json::from_str(source).unwrap();
            for label in capability["windows"].as_array().unwrap() {
                assert_eq!(
                    ensure_notes_window_label(label.as_str().unwrap()).is_ok(),
                    allowed
                );
            }
        }
    }

    #[test]
    fn missing_file_keeps_the_existing_empty_wire_contract() {
        let directory = tempfile::tempdir().unwrap();
        let service = NotesService::new(directory.path().to_path_buf());

        let loaded = service.load().unwrap();
        assert_eq!(
            serde_json::to_value(loaded).unwrap(),
            json!({
                "folders": [],
                "pages": [],
                "blocks": [],
                "isDarkMode": null,
                "sessionState": null
            })
        );
    }

    #[test]
    fn legacy_and_workspace_session_fields_round_trip() {
        let directory = tempfile::tempdir().unwrap();
        let service = NotesService::new(directory.path().to_path_buf());
        let data_path = directory.path().join(APP_DATA_FILE_NAME);
        let source = valid_save_json();
        fs::write(&data_path, serde_json::to_vec(&source).unwrap()).unwrap();

        let loaded = service.load().unwrap();
        service
            .save_with_limits(&loaded, PRODUCTION_VALIDATION_LIMITS)
            .unwrap();
        let saved: serde_json::Value =
            serde_json::from_slice(&fs::read(data_path).unwrap()).unwrap();

        assert_eq!(saved["sessionState"]["selectedPageId"], "page-1");
        assert_eq!(saved["sessionState"]["openPageTabIds"], json!(["page-1"]));
        assert_eq!(
            saved["sessionState"]["workspaceTabs"],
            source["sessionState"]["workspaceTabs"]
        );
        assert_eq!(
            saved["sessionState"]["selectedWorkspaceTabId"],
            "note:page-1"
        );
    }

    #[test]
    fn sectionless_settings_and_agenda_round_trip_preserve_order_and_selection() {
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::new(directory.path().to_path_buf());
        let source = json!({
            "folders": [],
            "pages": [],
            "blocks": [],
            "sessionState": {
                "workspaceTabs": [
                    {
                        "id": "settings",
                        "title": "Settings",
                        "view": { "kind": "settings" }
                    },
                    {
                        "id": "agenda:month",
                        "title": "Month",
                        "view": { "kind": "agenda", "view": "month" }
                    }
                ],
                "selectedWorkspaceTabId": "agenda:month"
            }
        });
        let body = InvokeBody::Raw(serde_json::to_vec(&source).unwrap());

        save_app_data_body("main", &state, &body, MAX_APP_DATA_BYTES).unwrap();
        let loaded = serde_json::to_value(state.notes.load().unwrap()).unwrap();
        let tabs = loaded["sessionState"]["workspaceTabs"].as_array().unwrap();

        assert_eq!(tabs[0]["id"], "settings");
        assert!(tabs[0]["view"].get("section").is_none());
        assert_eq!(tabs[1]["id"], "agenda:month");
        assert_eq!(
            tabs[1]["view"],
            json!({ "kind": "agenda", "view": "month" })
        );
        assert_eq!(
            loaded["sessionState"]["selectedWorkspaceTabId"],
            "agenda:month"
        );
    }

    #[test]
    fn persisted_load_is_tolerant_but_save_dtos_reject_unknown_fields_throughout() {
        let mut tolerant = valid_save_json();
        for pointer in [
            "",
            "/folders/0",
            "/pages/0",
            "/blocks/0",
            "/sessionState",
            "/sessionState/workspaceTabs/0",
            "/sessionState/workspaceTabs/0/view",
            "/sessionState/pageViewports/page-1",
            "/sessionState/pageViewports/page-1/panOffset",
        ] {
            tolerant
                .pointer_mut(pointer)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .insert("futureField".to_owned(), json!(true));
        }
        assert!(serde_json::from_value::<PersistedAppDataV1>(tolerant).is_ok());

        for pointer in [
            "",
            "/folders/0",
            "/pages/0",
            "/blocks/0",
            "/sessionState",
            "/sessionState/workspaceTabs/0",
            "/sessionState/workspaceTabs/0/view",
            "/sessionState/pageViewports/page-1",
            "/sessionState/pageViewports/page-1/panOffset",
        ] {
            let mut strict = valid_save_json();
            strict
                .pointer_mut(pointer)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .insert("unknownField".to_owned(), json!(true));
            assert!(
                serde_json::from_value::<SaveAppData>(strict).is_err(),
                "strict save DTO accepted unknown field at {pointer}"
            );
        }
    }

    #[test]
    fn oversized_existing_file_is_rejected_before_deserialization() {
        let directory = tempfile::tempdir().unwrap();
        let data_path = directory.path().join(APP_DATA_FILE_NAME);
        let file = File::create(&data_path).unwrap();
        file.set_len((MAX_APP_DATA_BYTES + 1) as u64).unwrap();
        let service = NotesService::new(directory.path().to_path_buf());

        let error = service.load().unwrap_err();
        assert_eq!(error.code, NativeErrorCode::DataTooLarge);
        assert_eq!(error.field, Some("noteData"));
    }

    #[test]
    fn invalid_raw_save_does_not_replace_existing_data() {
        let directory = tempfile::tempdir().unwrap();
        let service = NotesService::new(directory.path().to_path_buf());
        let data_path = directory.path().join(APP_DATA_FILE_NAME);
        fs::write(&data_path, b"existing").unwrap();
        let mut data = valid_save_json();
        data["folders"][0]["name"] = json!("x".repeat(MAX_LABEL_BYTES + 1));

        let error = service
            .save_raw(&serde_json::to_vec(&data).unwrap())
            .unwrap_err();

        assert_eq!(error.code, NativeErrorCode::DataTooLarge);
        assert_eq!(fs::read(data_path).unwrap(), b"existing");
    }

    #[test]
    fn raw_transport_is_bounded_before_admission_and_json_transport_is_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::new(directory.path().to_path_buf());
        let data_path = directory.path().join(APP_DATA_FILE_NAME);
        fs::write(&data_path, b"existing").unwrap();
        let admission = state.note_mutations.begin().unwrap();

        let oversized = InvokeBody::Raw(vec![b'x'; 33]);
        let error = save_app_data_body("main", &state, &oversized, 32).unwrap_err();
        assert_eq!(error.code, NativeErrorCode::DataTooLarge);

        drop(admission);
        let json_body = InvokeBody::Json(valid_save_json());
        let error = save_app_data_body("main", &state, &json_body, MAX_APP_DATA_BYTES).unwrap_err();
        assert_eq!(error.code, NativeErrorCode::InvalidData);
        assert_eq!(fs::read(data_path).unwrap(), b"existing");
    }

    #[test]
    fn concurrent_near_limit_save_is_rejected_before_parsing_and_preserves_file() {
        let directory = tempfile::tempdir().unwrap();
        let state = Arc::new(AppState::new(directory.path().to_path_buf()));
        let data_path = directory.path().join(APP_DATA_FILE_NAME);
        fs::write(&data_path, b"existing").unwrap();
        let admission = state.note_mutations.begin().unwrap();
        let contender = Arc::clone(&state);

        let thread = std::thread::spawn(move || {
            let body = InvokeBody::Raw(vec![b' '; 255]);
            save_app_data_body("main", &contender, &body, 256)
        });
        let error = thread.join().unwrap().unwrap_err();

        assert_eq!(error.code, NativeErrorCode::MutationUnavailable);
        assert_eq!(fs::read(&data_path).unwrap(), b"existing");
        drop(admission);
    }

    #[test]
    fn calendar_admission_does_not_reject_note_save() {
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::new(directory.path().to_path_buf());
        let _calendar_admission = state.calendar_mutations.begin().unwrap();
        let body = InvokeBody::Raw(serde_json::to_vec(&valid_save_json()).unwrap());

        save_app_data_body("main", &state, &body, MAX_APP_DATA_BYTES).unwrap();
    }

    #[test]
    fn aggregate_and_hard_output_limits_preserve_existing_file() {
        let directory = tempfile::tempdir().unwrap();
        let service = NotesService::new(directory.path().to_path_buf());
        let data_path = directory.path().join(APP_DATA_FILE_NAME);
        fs::write(&data_path, b"existing").unwrap();
        let mut data = empty_app_data();
        data.folders = vec![
            Folder {
                id: "a".to_owned(),
                name: "12345678".to_owned(),
            },
            Folder {
                id: "b".to_owned(),
                name: "12345678".to_owned(),
            },
        ];

        let aggregate_error = service
            .save_with_limits(&data, test_limits(10, usize::MAX, MAX_APP_DATA_BYTES))
            .unwrap_err();
        assert_eq!(aggregate_error.code, NativeErrorCode::DataTooLarge);
        assert_eq!(fs::read(&data_path).unwrap(), b"existing");

        let output_error = service
            .save_with_limits(&data, test_limits(usize::MAX, usize::MAX, 16))
            .unwrap_err();
        assert_eq!(output_error.code, NativeErrorCode::DataTooLarge);
        assert_eq!(fs::read(data_path).unwrap(), b"existing");
    }

    #[test]
    fn limited_writer_never_grows_past_its_logical_cap() {
        let mut writer = LimitedBuffer::new(16);
        writer.write_all(b"12345678").unwrap();
        writer.write_all(b"abcdefgh").unwrap();
        assert_eq!(writer.bytes.len(), 16);
        assert!(writer.bytes.capacity() <= 16);
        assert_eq!(
            writer.write_all(b"x").unwrap_err().kind(),
            std::io::ErrorKind::FileTooLarge
        );
    }

    #[test]
    fn limited_writer_reserves_from_length_when_a_large_chunk_crosses_initial_capacity() {
        let limit = 128 * 1024;
        let prefix = vec![b'p'; 1024];
        let large_chunk = vec![b'x'; 96 * 1024];
        let mut writer = LimitedBuffer::new(limit);

        writer.write_all(&prefix).unwrap();
        writer.write_all(&large_chunk).unwrap();

        assert_eq!(writer.bytes.len(), prefix.len() + large_chunk.len());
        assert!(writer.bytes.capacity() >= writer.bytes.len());
        assert!(writer.bytes.capacity() <= limit);
        assert_eq!(&writer.bytes[..prefix.len()], prefix.as_slice());
        assert_eq!(&writer.bytes[prefix.len()..], large_chunk.as_slice());
    }

    #[test]
    fn valid_raw_save_publishes_the_strict_payload() {
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::new(directory.path().to_path_buf());
        let body = InvokeBody::Raw(serde_json::to_vec(&valid_save_json()).unwrap());

        save_app_data_body("main", &state, &body, MAX_APP_DATA_BYTES).unwrap();

        let saved: serde_json::Value =
            serde_json::from_slice(&fs::read(directory.path().join(APP_DATA_FILE_NAME)).unwrap())
                .unwrap();
        assert_eq!(
            saved["sessionState"]["workspaceTabs"][1]["view"]["view"],
            "month"
        );
        assert_eq!(
            saved["sessionState"]["workspaceTabs"][2]["view"]["section"],
            "models"
        );
    }

    #[test]
    fn collection_and_rich_content_depth_limits_are_enforced() {
        let mut too_many_folders = empty_app_data();
        too_many_folders.folders = (0..=MAX_FOLDERS)
            .map(|index| Folder {
                id: index.to_string(),
                name: String::new(),
            })
            .collect();
        assert_eq!(
            validate_app_data(&too_many_folders, PRODUCTION_VALIDATION_LIMITS)
                .unwrap_err()
                .code,
            NativeErrorCode::DataTooLarge
        );

        let mut nested = json!(null);
        for _ in 0..MAX_RICH_CONTENT_DEPTH {
            nested = json!({ "content": nested });
        }
        let mut deep_data = empty_app_data();
        let mut block = text_block();
        block.rich_content = Some(nested);
        deep_data.blocks.push(block);
        assert_eq!(
            validate_app_data(&deep_data, PRODUCTION_VALIDATION_LIMITS)
                .unwrap_err()
                .field,
            Some("richContent")
        );
    }

    #[test]
    fn base64_image_size_is_measured_after_decoding() {
        assert_eq!(decoded_base64_len("YQ=="), Some(1));
        assert_eq!(decoded_base64_len("YWI="), Some(2));
        assert_eq!(decoded_base64_len("YWJj"), Some(3));
        assert_eq!(decoded_base64_len("YW=J"), None);
        assert_eq!(decoded_base64_len("not data"), None);
    }

    #[test]
    fn non_finite_numeric_values_are_rejected_before_serialization() {
        let mut data = empty_app_data();
        let mut block = text_block();
        block.width = f64::NAN;
        data.blocks.push(block);

        let error = validate_app_data(&data, PRODUCTION_VALIDATION_LIMITS).unwrap_err();
        assert_eq!(error.code, NativeErrorCode::InvalidData);
        assert_eq!(error.field, Some("blocks"));
    }
}
