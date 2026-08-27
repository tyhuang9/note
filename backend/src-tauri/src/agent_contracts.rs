//! Provider-neutral contracts for Note-owned agent capabilities.
//!
//! This module intentionally contains no host execution, database access, or
//! Tauri commands. Future native hosts and provider adapters must validate at
//! this boundary before invoking any workspace operation.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

pub const MANIFEST_ID: &str = "note-agent-v1";
pub const MANIFEST_SCHEMA_VERSION: &str = "1.0.0";
pub const CAPABILITY_SCHEMA_VERSION: &str = "1.0.0";
pub const MAX_TOOL_INPUT_BYTES: u64 = 64 * 1024;
pub const MAX_TOOL_RESULT_BYTES: u64 = 64 * 1024;
pub const MAX_SCREENSHOT_TRANSPORT_BYTES: u64 = 48 * 1024;
pub const MAX_JSON_SAFE_REVISION: i64 = 9_007_199_254_740_991;
pub const MAX_INVERSE_CHANGES: usize = 128;
pub const MAX_INVERSE_CHANGESET_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentManifest {
    pub id: String,
    pub schema_version: String,
    pub default_limits: DefaultLimits,
    pub capabilities: Vec<CapabilityContract>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DefaultLimits {
    pub max_tool_input_bytes: u64,
    pub max_concurrent_runs: u16,
    pub max_operations_per_change_set: u16,
    pub max_inverse_changes: u16,
    pub max_inverse_change_set_bytes: u64,
    pub default_read_timeout_ms: u64,
    pub default_mutation_timeout_ms: u64,
    pub max_rounds: u8,
    pub max_calls_per_round: u8,
    pub max_calls_per_run: u8,
    pub max_selected_descriptors: u8,
    pub max_viewport_summaries: u16,
    pub max_read_summaries: u16,
    pub max_detailed_elements: u8,
    pub max_touched_elements: u8,
    pub max_created_elements: u8,
    pub max_workspace_items: u8,
    pub max_tool_result_bytes: u64,
    pub max_screenshot_transport_bytes: u64,
}

pub const DEFAULT_LIMITS: DefaultLimits = DefaultLimits {
    max_tool_input_bytes: MAX_TOOL_INPUT_BYTES,
    max_concurrent_runs: 1,
    max_operations_per_change_set: 64,
    max_inverse_changes: MAX_INVERSE_CHANGES as u16,
    max_inverse_change_set_bytes: MAX_INVERSE_CHANGESET_BYTES,
    default_read_timeout_ms: 5_000,
    default_mutation_timeout_ms: 10_000,
    max_rounds: 5,
    max_calls_per_round: 8,
    max_calls_per_run: 24,
    max_selected_descriptors: 25,
    max_viewport_summaries: 120,
    max_read_summaries: 200,
    max_detailed_elements: 50,
    max_touched_elements: 50,
    max_created_elements: 25,
    max_workspace_items: 10,
    max_tool_result_bytes: MAX_TOOL_RESULT_BYTES,
    max_screenshot_transport_bytes: MAX_SCREENSHOT_TRANSPORT_BYTES,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum CapabilityId {
    WorkspaceListStructure,
    WorkspaceSearch,
    WorkspaceOpenPage,
    CanvasReadScene,
    CanvasReadElements,
    CanvasRequestScreenshot,
    WorkspaceCreateFolder,
    WorkspaceRenameFolder,
    WorkspaceCreatePage,
    WorkspaceRenamePage,
    WorkspaceMovePage,
    WorkspaceBookmarkPage,
    WorkspaceArchiveItems,
    WorkspaceRestoreItems,
    CanvasApplyOperations,
}

impl CapabilityId {
    pub const ALL: [Self; 15] = [
        Self::WorkspaceListStructure,
        Self::WorkspaceSearch,
        Self::WorkspaceOpenPage,
        Self::CanvasReadScene,
        Self::CanvasReadElements,
        Self::CanvasRequestScreenshot,
        Self::WorkspaceCreateFolder,
        Self::WorkspaceRenameFolder,
        Self::WorkspaceCreatePage,
        Self::WorkspaceRenamePage,
        Self::WorkspaceMovePage,
        Self::WorkspaceBookmarkPage,
        Self::WorkspaceArchiveItems,
        Self::WorkspaceRestoreItems,
        Self::CanvasApplyOperations,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::WorkspaceListStructure => "workspace.list_structure",
            Self::WorkspaceSearch => "workspace.search",
            Self::WorkspaceOpenPage => "workspace.open_page",
            Self::CanvasReadScene => "canvas.read_scene",
            Self::CanvasReadElements => "canvas.read_elements",
            Self::CanvasRequestScreenshot => "canvas.request_screenshot",
            Self::WorkspaceCreateFolder => "workspace.create_folder",
            Self::WorkspaceRenameFolder => "workspace.rename_folder",
            Self::WorkspaceCreatePage => "workspace.create_page",
            Self::WorkspaceRenamePage => "workspace.rename_page",
            Self::WorkspaceMovePage => "workspace.move_page",
            Self::WorkspaceBookmarkPage => "workspace.bookmark_page",
            Self::WorkspaceArchiveItems => "workspace.archive_items",
            Self::WorkspaceRestoreItems => "workspace.restore_items",
            Self::CanvasApplyOperations => "canvas.apply_operations",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|id| id.as_str() == value)
    }
}

impl Serialize for CapabilityId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for CapabilityId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(&value).ok_or_else(|| serde::de::Error::custom("unknown capability id"))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DataScope {
    WorkspaceStructure,
    WorkspaceContent,
    Page,
    CanvasScene,
    CanvasElements,
    Screenshot,
    WorkspaceMutation,
    CanvasMutation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityRisk {
    Read,
    Write,
    Destructive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreviewType {
    None,
    Navigation,
    Summary,
    Diff,
    CanvasOverlay,
    ArchiveSummary,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityContract {
    pub id: CapabilityId,
    pub schema_version: String,
    pub input_schema: Value,
    pub output_schema: Value,
    pub data_scope: DataScope,
    pub risk: CapabilityRisk,
    pub timeout_ms: u64,
    pub result_byte_limit: u64,
    pub preview_type: PreviewType,
}

/// Returns the only manifest a V1 host may advertise.
pub fn canonical_manifest() -> AgentManifest {
    AgentManifest {
        id: MANIFEST_ID.into(),
        schema_version: MANIFEST_SCHEMA_VERSION.into(),
        default_limits: DEFAULT_LIMITS,
        capabilities: vec![
            capability(
                CapabilityId::WorkspaceListStructure,
                object_schema(&[], json!({})),
                structure_output_schema(),
                DataScope::WorkspaceStructure,
                CapabilityRisk::Read,
                5_000,
                MAX_TOOL_RESULT_BYTES,
                PreviewType::None,
            ),
            capability(
                CapabilityId::WorkspaceSearch,
                object_schema(
                    &["query"],
                    json!({"query": string_schema(1, 512), "pageId": nullable_id_schema(), "limit": integer_schema(1, 100)}),
                ),
                search_output_schema(),
                DataScope::WorkspaceContent,
                CapabilityRisk::Read,
                5_000,
                MAX_TOOL_RESULT_BYTES,
                PreviewType::None,
            ),
            capability(
                CapabilityId::WorkspaceOpenPage,
                object_schema(&["pageId"], json!({"pageId": id_schema()})),
                page_output_schema(),
                DataScope::Page,
                CapabilityRisk::Read,
                5_000,
                MAX_TOOL_RESULT_BYTES,
                PreviewType::Navigation,
            ),
            capability(
                CapabilityId::CanvasReadScene,
                object_schema(
                    &["pageId"],
                    json!({"pageId": id_schema(), "includeText": boolean_schema()}),
                ),
                scene_output_schema(),
                DataScope::CanvasScene,
                CapabilityRisk::Read,
                5_000,
                MAX_TOOL_RESULT_BYTES,
                PreviewType::None,
            ),
            capability(
                CapabilityId::CanvasReadElements,
                object_schema(
                    &["pageId", "elementIds"],
                    json!({"pageId": id_schema(), "elementIds": array_schema(id_schema(), 1, 50)}),
                ),
                elements_output_schema(),
                DataScope::CanvasElements,
                CapabilityRisk::Read,
                5_000,
                MAX_TOOL_RESULT_BYTES,
                PreviewType::None,
            ),
            capability(
                CapabilityId::CanvasRequestScreenshot,
                object_schema(
                    &["pageId"],
                    json!({"pageId": id_schema(), "viewport": viewport_schema(), "scale": number_schema(0.5, 2.0)}),
                ),
                screenshot_output_schema(),
                DataScope::Screenshot,
                CapabilityRisk::Read,
                15_000,
                MAX_TOOL_RESULT_BYTES,
                PreviewType::None,
            ),
            capability(
                CapabilityId::WorkspaceCreateFolder,
                object_schema(&["name"], json!({"name": string_schema(1, 120)})),
                receipt_output_schema(),
                DataScope::WorkspaceMutation,
                CapabilityRisk::Write,
                10_000,
                MAX_TOOL_RESULT_BYTES,
                PreviewType::Diff,
            ),
            capability(
                CapabilityId::WorkspaceRenameFolder,
                object_schema(
                    &["folderId", "name", "expectedWorkspaceRevision"],
                    json!({"folderId": id_schema(), "name": string_schema(1, 120), "expectedWorkspaceRevision": revision_schema()}),
                ),
                receipt_output_schema(),
                DataScope::WorkspaceMutation,
                CapabilityRisk::Write,
                10_000,
                MAX_TOOL_RESULT_BYTES,
                PreviewType::Diff,
            ),
            capability(
                CapabilityId::WorkspaceCreatePage,
                object_schema(
                    &["folderId", "title"],
                    json!({"folderId": id_schema(), "title": string_schema(1, 240)}),
                ),
                receipt_output_schema(),
                DataScope::WorkspaceMutation,
                CapabilityRisk::Write,
                10_000,
                MAX_TOOL_RESULT_BYTES,
                PreviewType::Diff,
            ),
            capability(
                CapabilityId::WorkspaceRenamePage,
                object_schema(
                    &["pageId", "title", "expectedPageRevision"],
                    json!({"pageId": id_schema(), "title": string_schema(1, 240), "expectedPageRevision": revision_schema()}),
                ),
                receipt_output_schema(),
                DataScope::WorkspaceMutation,
                CapabilityRisk::Write,
                10_000,
                MAX_TOOL_RESULT_BYTES,
                PreviewType::Diff,
            ),
            capability(
                CapabilityId::WorkspaceMovePage,
                object_schema(
                    &["pageId", "folderId", "expectedPageRevision"],
                    json!({"pageId": id_schema(), "folderId": id_schema(), "expectedPageRevision": revision_schema()}),
                ),
                receipt_output_schema(),
                DataScope::WorkspaceMutation,
                CapabilityRisk::Write,
                10_000,
                MAX_TOOL_RESULT_BYTES,
                PreviewType::Diff,
            ),
            capability(
                CapabilityId::WorkspaceBookmarkPage,
                object_schema(
                    &["pageId", "bookmarked", "expectedPageRevision"],
                    json!({"pageId": id_schema(), "bookmarked": boolean_schema(), "expectedPageRevision": revision_schema()}),
                ),
                receipt_output_schema(),
                DataScope::WorkspaceMutation,
                CapabilityRisk::Write,
                10_000,
                MAX_TOOL_RESULT_BYTES,
                PreviewType::Diff,
            ),
            capability(
                CapabilityId::WorkspaceArchiveItems,
                object_schema(
                    &["items", "expectedWorkspaceRevision"],
                    json!({"items": array_schema(archive_item_schema(), 1, 10), "expectedWorkspaceRevision": revision_schema()}),
                ),
                receipt_output_schema(),
                DataScope::WorkspaceMutation,
                CapabilityRisk::Destructive,
                10_000,
                MAX_TOOL_RESULT_BYTES,
                PreviewType::ArchiveSummary,
            ),
            capability(
                CapabilityId::WorkspaceRestoreItems,
                object_schema(
                    &["items", "expectedWorkspaceRevision"],
                    json!({"items": array_schema(archive_item_schema(), 1, 10), "expectedWorkspaceRevision": revision_schema()}),
                ),
                receipt_output_schema(),
                DataScope::WorkspaceMutation,
                CapabilityRisk::Destructive,
                10_000,
                MAX_TOOL_RESULT_BYTES,
                PreviewType::ArchiveSummary,
            ),
            capability(
                CapabilityId::CanvasApplyOperations,
                object_schema(
                    &["pageId", "expectedPageRevision", "operations"],
                    json!({"pageId": id_schema(), "expectedPageRevision": revision_schema(), "operations": semantic_operations_schema()}),
                ),
                receipt_output_schema(),
                DataScope::CanvasMutation,
                CapabilityRisk::Write,
                10_000,
                MAX_TOOL_RESULT_BYTES,
                PreviewType::CanvasOverlay,
            ),
        ],
    }
}

fn capability(
    id: CapabilityId,
    input_schema: Value,
    output_schema: Value,
    data_scope: DataScope,
    risk: CapabilityRisk,
    timeout_ms: u64,
    result_byte_limit: u64,
    preview_type: PreviewType,
) -> CapabilityContract {
    CapabilityContract {
        id,
        schema_version: CAPABILITY_SCHEMA_VERSION.into(),
        input_schema,
        output_schema,
        data_scope,
        risk,
        timeout_ms,
        result_byte_limit,
        preview_type,
    }
}

fn object_schema(required: &[&str], properties: Value) -> Value {
    json!({"type":"object", "additionalProperties":false, "required":required, "properties":properties})
}
fn map_schema(value_schema: Value) -> Value {
    json!({"type":"object", "additionalProperties":value_schema, "required":[]})
}
fn id_schema() -> Value {
    string_schema(1, 128)
}
fn nullable_id_schema() -> Value {
    json!({"oneOf":[id_schema(), {"type":"null"}]})
}
fn string_schema(min_length: u64, max_length: u64) -> Value {
    json!({"type":"string", "minLength":min_length, "maxLength":max_length})
}
fn integer_schema(minimum: i64, maximum: i64) -> Value {
    json!({"type":"integer", "minimum":minimum, "maximum":maximum})
}
fn revision_schema() -> Value {
    integer_schema(0, MAX_JSON_SAFE_REVISION)
}
fn number_schema(minimum: f64, maximum: f64) -> Value {
    json!({"type":"number", "minimum":minimum, "maximum":maximum})
}
fn boolean_schema() -> Value {
    json!({"type":"boolean"})
}
fn array_schema(items: Value, min_items: u64, max_items: u64) -> Value {
    json!({"type":"array", "items":items, "minItems":min_items, "maxItems":max_items})
}
fn enum_schema(values: &[&str]) -> Value {
    json!({"type":"string", "enum":values})
}

fn folder_schema() -> Value {
    object_schema(
        &["id", "name", "isBookmarked"],
        json!({"id": id_schema(), "name": string_schema(1, 120), "isBookmarked": boolean_schema()}),
    )
}
fn page_schema() -> Value {
    object_schema(
        &["id", "folderId", "title", "isBookmarked", "revision"],
        json!({"id": id_schema(), "folderId": id_schema(), "title": string_schema(1, 240), "isBookmarked": boolean_schema(), "revision": revision_schema()}),
    )
}
fn structure_output_schema() -> Value {
    object_schema(
        &["workspaceRevision", "folders", "pages"],
        json!({"workspaceRevision": revision_schema(), "folders": array_schema(folder_schema(), 0, 10_000), "pages": array_schema(page_schema(), 0, 100_000)}),
    )
}
fn search_output_schema() -> Value {
    object_schema(
        &["matches"],
        json!({"matches": array_schema(object_schema(&["pageId", "title", "snippet"], json!({"pageId": id_schema(), "title": string_schema(0, 240), "snippet": string_schema(0, 2_000)})), 0, 200)}),
    )
}
fn page_output_schema() -> Value {
    object_schema(&["page"], json!({"page":page_schema()}))
}
fn scene_output_schema() -> Value {
    object_schema(
        &["pageId", "revision", "elements"],
        json!({"pageId":id_schema(), "revision":revision_schema(), "elements":array_schema(canvas_element_schema(), 0, 120)}),
    )
}
fn elements_output_schema() -> Value {
    object_schema(
        &["pageId", "revision", "elements"],
        json!({"pageId":id_schema(), "revision":revision_schema(), "elements":array_schema(canvas_element_schema(), 0, 50)}),
    )
}
fn screenshot_output_schema() -> Value {
    object_schema(
        &[
            "pageId",
            "revision",
            "mediaType",
            "dataBase64",
            "requiresApproval",
            "persisted",
        ],
        json!({"pageId":id_schema(), "revision":revision_schema(), "mediaType":enum_schema(&["image/png"]), "dataBase64":string_schema(1, MAX_SCREENSHOT_TRANSPORT_BYTES), "requiresApproval":boolean_schema(), "persisted":json!({"type":"boolean", "enum":[false]})}),
    )
}
fn viewport_schema() -> Value {
    object_schema(
        &["x", "y", "width", "height"],
        json!({"x":number_schema(-1_000_000.0, 1_000_000.0), "y":number_schema(-1_000_000.0, 1_000_000.0), "width":number_schema(1.0, 100_000.0), "height":number_schema(1.0, 100_000.0)}),
    )
}
fn archive_item_schema() -> Value {
    object_schema(
        &["kind", "id"],
        json!({"kind":enum_schema(&["folder", "page"]), "id":id_schema()}),
    )
}
fn receipt_output_schema() -> Value {
    object_schema(&["receipt"], json!({"receipt": mutation_receipt_schema()}))
}
fn mutation_receipt_schema() -> Value {
    object_schema(
        &[
            "auditId",
            "changeSetId",
            "changedResources",
            "workspaceRevision",
            "pageRevisions",
            "inverseChangeSet",
        ],
        json!({"auditId":id_schema(), "changeSetId":id_schema(), "changedResources":array_schema(changed_resource_schema(), 0, 10), "workspaceRevision":revision_schema(), "pageRevisions":map_schema(revision_schema()), "inverseChangeSet":inverse_change_set_schema()}),
    )
}
fn inverse_change_set_schema() -> Value {
    object_schema(
        &["inverseChangeSetId", "changes"],
        json!({
            "inverseChangeSetId":id_schema(),
            "changes":array_schema(json!({"oneOf":[
                object_schema(&["type", "kind", "id"], json!({"type":enum_schema(&["restore_resource"]), "kind":enum_schema(&["folder", "page", "canvas_element", "archive_item"]), "id":id_schema()})),
                object_schema(&["type", "operation"], json!({"type":enum_schema(&["reapply_workspace_operation"]), "operation":workspace_operation_schema()}))
            ]}), 0, MAX_INVERSE_CHANGES as u64)
        }),
    )
}
fn workspace_operation_schema() -> Value {
    let folder = || {
        object_schema(
            &["type", "folder_id", "name"],
            json!({"type":enum_schema(&["create_folder", "rename_folder"]), "folder_id":id_schema(), "name":string_schema(1,120)}),
        )
    };
    let create_page = object_schema(
        &["type", "page_id", "folder_id", "title"],
        json!({"type":enum_schema(&["create_page"]), "page_id":id_schema(), "folder_id":id_schema(), "title":string_schema(1,240)}),
    );
    let rename_page = object_schema(
        &["type", "page_id", "title"],
        json!({"type":enum_schema(&["rename_page"]), "page_id":id_schema(), "title":string_schema(1,240)}),
    );
    let move_page = object_schema(
        &["type", "page_id", "folder_id"],
        json!({"type":enum_schema(&["move_page"]), "page_id":id_schema(), "folder_id":id_schema()}),
    );
    let bookmark = object_schema(
        &["type", "page_id", "bookmarked"],
        json!({"type":enum_schema(&["bookmark_page"]), "page_id":id_schema(), "bookmarked":boolean_schema()}),
    );
    let archive = object_schema(
        &["type", "items"],
        json!({"type":enum_schema(&["archive_items", "restore_items"]), "items":array_schema(archive_item_schema(),1,10)}),
    );
    json!({"oneOf":[folder(), create_page, rename_page, move_page, bookmark, archive]})
}
fn changed_resource_schema() -> Value {
    object_schema(
        &["kind", "id", "newRevision"],
        json!({"kind":enum_schema(&["folder", "page", "canvas_element", "archive_item"]), "id":id_schema(), "newRevision":revision_schema()}),
    )
}
fn canvas_element_schema() -> Value {
    object_schema(
        &["id", "kind", "x", "y", "width", "height"],
        json!({"id":id_schema(), "kind":enum_schema(&["text", "shape", "connector"]), "x":number_schema(-1_000_000.0, 1_000_000.0), "y":number_schema(-1_000_000.0, 1_000_000.0), "width":number_schema(1.0, 100_000.0), "height":number_schema(1.0, 100_000.0)}),
    )
}

/// The semantic canvas operation union deliberately omits delete, grouping,
/// locking, arbitrary rotation, rich-text patches, image/ink edits, and every
/// connector endpoint except an anchor on a text or shape element.
fn semantic_operations_schema() -> Value {
    let text = object_schema(
        &["type", "elementId", "text", "x", "y"],
        json!({"type":enum_schema(&["create_text"]), "elementId":id_schema(), "text":string_schema(0, 10_000), "x":number_schema(-1_000_000.0, 1_000_000.0), "y":number_schema(-1_000_000.0, 1_000_000.0)}),
    );
    let replace_text = object_schema(
        &["type", "elementId", "text"],
        json!({"type":enum_schema(&["replace_text"]), "elementId":id_schema(), "text":string_schema(0, 10_000)}),
    );
    let shape = object_schema(
        &["type", "elementId", "shape", "x", "y", "width", "height"],
        json!({"type":enum_schema(&["create_shape"]), "elementId":id_schema(), "shape":enum_schema(&["rectangle", "ellipse", "diamond"]), "x":number_schema(-1_000_000.0, 1_000_000.0), "y":number_schema(-1_000_000.0, 1_000_000.0), "width":number_schema(1.0, 100_000.0), "height":number_schema(1.0, 100_000.0)}),
    );
    let move_elements = object_schema(
        &["type", "targets", "deltaX", "deltaY"],
        json!({"type":enum_schema(&["move_elements"]), "targets":array_schema(element_target_schema(), 1, 100), "deltaX":number_schema(-1_000_000.0, 1_000_000.0), "deltaY":number_schema(-1_000_000.0, 1_000_000.0)}),
    );
    let resize = object_schema(
        &["type", "elementId", "targetKind", "width", "height"],
        json!({"type":enum_schema(&["resize_element"]), "elementId":id_schema(), "targetKind":bindable_element_kind_schema(), "width":number_schema(1.0, 100_000.0), "height":number_schema(1.0, 100_000.0)}),
    );
    let style = object_schema(
        &["type", "elementId", "targetKind", "style"],
        json!({"type":enum_schema(&["set_style"]), "elementId":id_schema(), "targetKind":bindable_element_kind_schema(), "style":object_schema(&[], json!({"fill":string_schema(1, 32), "stroke":string_schema(1, 32), "strokeWidth":number_schema(0.5, 32.0), "opacity":number_schema(0.0, 1.0)}))}),
    );
    let connector = object_schema(
        &["type", "elementId", "start", "end"],
        json!({"type":enum_schema(&["create_connector"]), "elementId":id_schema(), "start":element_anchor_schema(), "end":element_anchor_schema()}),
    );
    let label = object_schema(
        &["type", "elementId", "label"],
        json!({"type":enum_schema(&["set_connector_label"]), "elementId":id_schema(), "label":string_schema(0, 1_000)}),
    );
    let line = object_schema(
        &[
            "type",
            "elementId",
            "startX",
            "startY",
            "endX",
            "endY",
            "style",
        ],
        json!({"type":enum_schema(&["create_line"]), "elementId":id_schema(), "startX":number_schema(-1_000_000.0,1_000_000.0), "startY":number_schema(-1_000_000.0,1_000_000.0), "endX":number_schema(-1_000_000.0,1_000_000.0), "endY":number_schema(-1_000_000.0,1_000_000.0), "style":line_style_schema()}),
    );
    let arrow = object_schema(
        &[
            "type",
            "elementId",
            "start",
            "end",
            "style",
            "label",
            "labelStyle",
        ],
        json!({"type":enum_schema(&["create_arrow"]), "elementId":id_schema(), "start":element_anchor_schema(), "end":element_anchor_schema(), "style":arrow_style_schema(), "label":string_schema(0,1_000), "labelStyle":text_style_schema()}),
    );
    let shape_text = object_schema(
        &["type", "elementId", "text", "textStyle"],
        json!({"type":enum_schema(&["set_shape_text"]), "elementId":id_schema(), "text":string_schema(0,10_000), "textStyle":text_style_schema()}),
    );
    let duplicate = object_schema(
        &["type", "targets", "deltaX", "deltaY"],
        json!({"type":enum_schema(&["duplicate_elements"]), "targets":array_schema(element_target_schema(),1,50), "deltaX":number_schema(-1_000_000.0,1_000_000.0), "deltaY":number_schema(-1_000_000.0,1_000_000.0)}),
    );
    let align = object_schema(
        &["type", "targets", "alignment"],
        json!({"type":enum_schema(&["align_elements"]), "targets":array_schema(element_target_schema(),2,50), "alignment":enum_schema(&["left", "center", "right", "top", "middle", "bottom"])}),
    );
    let distribute = object_schema(
        &["type", "targets", "axis"],
        json!({"type":enum_schema(&["distribute_elements"]), "targets":array_schema(element_target_schema(),3,50), "axis":enum_schema(&["horizontal", "vertical"])}),
    );
    let reorder = object_schema(
        &["type", "targets", "placement"],
        json!({"type":enum_schema(&["reorder_elements"]), "targets":array_schema(element_target_schema(),1,50), "placement":enum_schema(&["bring_to_front", "bring_forward", "send_backward", "send_to_back"])}),
    );
    array_schema(
        json!({"oneOf":[text, replace_text, shape, move_elements, resize, style, connector, label, line, arrow, shape_text, duplicate, align, distribute, reorder]}),
        1,
        64,
    )
}
fn line_style_schema() -> Value {
    object_schema(
        &["stroke", "strokeWidth"],
        json!({"stroke":string_schema(1,32), "strokeWidth":number_schema(0.5,32.0), "dash":enum_schema(&["solid", "dashed"])}),
    )
}
fn arrow_style_schema() -> Value {
    object_schema(
        &["stroke", "strokeWidth", "startArrowhead", "endArrowhead"],
        json!({"stroke":string_schema(1,32), "strokeWidth":number_schema(0.5,32.0), "startArrowhead":arrowhead_schema(), "endArrowhead":arrowhead_schema()}),
    )
}
fn arrowhead_schema() -> Value {
    enum_schema(&["none", "triangle", "arrow", "diamond"])
}
fn text_style_schema() -> Value {
    object_schema(
        &[],
        json!({"fontSize":integer_schema(8,96), "fontWeight":enum_schema(&["normal", "bold"]), "color":string_schema(1,32), "alignment":enum_schema(&["left", "center", "right"])}),
    )
}
fn bindable_element_kind_schema() -> Value {
    enum_schema(&["text", "shape"])
}
fn element_target_schema() -> Value {
    object_schema(
        &["elementId", "targetKind"],
        json!({"elementId":id_schema(), "targetKind":bindable_element_kind_schema()}),
    )
}
fn element_anchor_schema() -> Value {
    object_schema(
        &["elementId", "targetKind", "anchor"],
        json!({"elementId":id_schema(), "targetKind":bindable_element_kind_schema(), "anchor":enum_schema(&["top", "right", "bottom", "left", "center"])}),
    )
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolInvocation {
    pub capability_id: CapabilityId,
    pub schema_version: String,
    pub asserted_risk: CapabilityRisk,
    pub input: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ContractValidationError {
    #[error("unknown field: {0}")]
    UnknownField(String),
    #[error("unknown capability: {0}")]
    UnknownCapability(String),
    #[error("unsupported schema version: {0}")]
    UnsupportedSchemaVersion(String),
    #[error("capability risk does not match canonical contract")]
    RiskMismatch,
    #[error("manifest differs from canonical note-agent-v1 contract")]
    ManifestMismatch,
    #[error("payload exceeds {limit} bytes")]
    PayloadTooLarge { limit: u64 },
    #[error("schema violation at {path}: {message}")]
    SchemaViolation { path: String, message: String },
    #[error("inverse change set has too many changes")]
    TooManyInverseChanges,
    #[error("change set has too many operations")]
    TooManyOperations,
    #[error("canvas change set must bind one non-empty page transaction")]
    InvalidCanvasChangeSet,
    #[error("permission grant requests a capability outside its profile")]
    PermissionEscalation,
    #[error("canvas change set exceeds V1 creation or touched-element budgets")]
    CanvasBudgetExceeded,
}

/// Parses untrusted JSON and rejects unknown DTO fields before it reaches a host.
pub fn parse_manifest(value: &Value) -> Result<AgentManifest, ContractValidationError> {
    serde_json::from_value(value.clone())
        .map_err(|error| ContractValidationError::UnknownField(error.to_string()))
}

pub fn validate_manifest(manifest: &AgentManifest) -> Result<(), ContractValidationError> {
    if manifest.id != MANIFEST_ID || manifest.schema_version != MANIFEST_SCHEMA_VERSION {
        return Err(ContractValidationError::UnsupportedSchemaVersion(
            manifest.schema_version.clone(),
        ));
    }
    if manifest != &canonical_manifest() {
        return Err(ContractValidationError::ManifestMismatch);
    }
    Ok(())
}

pub fn validate_tool_invocation(
    invocation: &ToolInvocation,
) -> Result<CapabilityContract, ContractValidationError> {
    let manifest = canonical_manifest();
    let capability = manifest
        .capabilities
        .iter()
        .find(|contract| contract.id == invocation.capability_id)
        .ok_or_else(|| {
            ContractValidationError::UnknownCapability(invocation.capability_id.as_str().into())
        })?;
    if invocation.schema_version != capability.schema_version {
        return Err(ContractValidationError::UnsupportedSchemaVersion(
            invocation.schema_version.clone(),
        ));
    }
    if invocation.asserted_risk != capability.risk {
        return Err(ContractValidationError::RiskMismatch);
    }
    check_payload_size(&invocation.input, DEFAULT_LIMITS.max_tool_input_bytes)?;
    validate_json_schema(&capability.input_schema, &invocation.input, "$")?;
    Ok(capability.clone())
}

pub fn validate_tool_result(
    capability_id: CapabilityId,
    value: &Value,
) -> Result<(), ContractValidationError> {
    let manifest = canonical_manifest();
    let capability = manifest
        .capabilities
        .iter()
        .find(|contract| contract.id == capability_id)
        .ok_or_else(|| ContractValidationError::UnknownCapability(capability_id.as_str().into()))?;
    check_payload_size(value, capability.result_byte_limit)?;
    validate_json_schema(&capability.output_schema, value, "$")
}

pub fn check_payload_size(value: &Value, limit: u64) -> Result<(), ContractValidationError> {
    if serde_json::to_vec(value)
        .map_err(|error| ContractValidationError::SchemaViolation {
            path: "$".into(),
            message: error.to_string(),
        })?
        .len() as u64
        > limit
    {
        return Err(ContractValidationError::PayloadTooLarge { limit });
    }
    Ok(())
}

/// Supports the intentionally small JSON Schema subset used by this manifest.
pub fn validate_json_schema(
    schema: &Value,
    value: &Value,
    path: &str,
) -> Result<(), ContractValidationError> {
    if let Some(options) = schema.get("oneOf").and_then(Value::as_array) {
        let matches = options
            .iter()
            .filter(|option| validate_json_schema(option, value, path).is_ok())
            .count();
        return if matches == 1 {
            Ok(())
        } else {
            Err(violation(path, "must match exactly one schema"))
        };
    }
    let schema_type = schema
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| violation(path, "schema type is required"))?;
    let matches = match schema_type {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "boolean" => value.is_boolean(),
        "number" => value.is_number(),
        "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
        "null" => value.is_null(),
        _ => false,
    };
    if !matches {
        return Err(violation(path, format!("expected {schema_type}")));
    }
    if let Some(allowed) = schema.get("enum").and_then(Value::as_array) {
        if !allowed.contains(value) {
            return Err(violation(path, "not an allowed value"));
        }
    }
    match schema_type {
        "object" => {
            let object = value.as_object().expect("checked object");
            let empty_properties = serde_json::Map::new();
            let properties = schema
                .get("properties")
                .and_then(Value::as_object)
                .unwrap_or(&empty_properties);
            if schema.get("additionalProperties") == Some(&Value::Bool(false)) {
                if let Some(key) = object.keys().find(|key| !properties.contains_key(*key)) {
                    return Err(ContractValidationError::UnknownField(format!(
                        "{path}.{key}"
                    )));
                }
            }
            for required in schema
                .get("required")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                if !object.contains_key(required) {
                    return Err(violation(
                        path,
                        format!("missing required property {required}"),
                    ));
                }
            }
            for (key, property_schema) in properties {
                if let Some(property) = object.get(key) {
                    validate_json_schema(property_schema, property, &format!("{path}.{key}"))?;
                }
            }
            if let Some(additional_schema) = schema
                .get("additionalProperties")
                .filter(|value| value.is_object())
            {
                for (key, property) in object
                    .iter()
                    .filter(|(key, _)| !properties.contains_key(*key))
                {
                    validate_json_schema(additional_schema, property, &format!("{path}.{key}"))?;
                }
            }
        }
        "array" => {
            let items = value.as_array().expect("checked array");
            bounds(items.len() as f64, schema, path)?;
            if let Some(item_schema) = schema.get("items") {
                for (index, item) in items.iter().enumerate() {
                    validate_json_schema(item_schema, item, &format!("{path}[{index}]"))?;
                }
            }
        }
        "string" => bounds(
            value.as_str().expect("checked string").chars().count() as f64,
            schema,
            path,
        )?,
        "number" | "integer" => bounds(
            value
                .as_f64()
                .or_else(|| value.as_i64().map(|v| v as f64))
                .or_else(|| value.as_u64().map(|v| v as f64))
                .expect("checked number"),
            schema,
            path,
        )?,
        _ => {}
    }
    Ok(())
}

fn bounds(actual: f64, schema: &Value, path: &str) -> Result<(), ContractValidationError> {
    let minimum = schema
        .get("minimum")
        .and_then(Value::as_f64)
        .or_else(|| schema.get("minLength").and_then(Value::as_f64))
        .or_else(|| schema.get("minItems").and_then(Value::as_f64));
    let maximum = schema
        .get("maximum")
        .and_then(Value::as_f64)
        .or_else(|| schema.get("maxLength").and_then(Value::as_f64))
        .or_else(|| schema.get("maxItems").and_then(Value::as_f64));
    if minimum.is_some_and(|minimum| actual < minimum)
        || maximum.is_some_and(|maximum| actual > maximum)
    {
        return Err(violation(path, "outside allowed bounds"));
    }
    Ok(())
}
fn violation(path: &str, message: impl Into<String>) -> ContractValidationError {
    ContractValidationError::SchemaViolation {
        path: path.into(),
        message: message.into(),
    }
}

#[cfg(test)]
fn normalize_newlines(value: &str) -> String {
    value.replace("\r\n", "\n")
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentAdapterStatusRequest {
    pub manifest_id: String,
    pub manifest_schema_version: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentAdapterStatus {
    pub available: bool,
    pub provider: ProviderEndpointIdentity,
    pub reason: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListAgentsRequest {
    pub manifest_id: String,
    pub manifest_schema_version: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentDescriptor {
    pub agent_id: String,
    pub display_name: String,
    pub capabilities: Vec<CapabilityId>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartRunRequest {
    pub agent_id: String,
    pub prompt: String,
    pub permission_grant: PermissionGrant,
    pub provider_consent: ProviderConsent,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContinueRunRequest {
    pub run_id: String,
    pub response: Value,
    pub permission_grant: PermissionGrant,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelRunRequest {
    pub run_id: String,
    pub reason: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRun {
    pub run_id: String,
    pub state: AgentHostState,
    pub audit_id: String,
}

/// Provider adapters are transport-only. The host owns validation, permissions,
/// previewing, mutation execution, audit records, and cancellation semantics.
pub trait AgentAdapter {
    fn status(
        &self,
        request: AgentAdapterStatusRequest,
    ) -> Result<AgentAdapterStatus, AdapterContractError>;
    fn list_agents(
        &self,
        request: ListAgentsRequest,
    ) -> Result<Vec<AgentDescriptor>, AdapterContractError>;
    fn start_run(&self, request: StartRunRequest) -> Result<AgentRun, AdapterContractError>;
    fn continue_run(&self, request: ContinueRunRequest) -> Result<AgentRun, AdapterContractError>;
    fn cancel_run(&self, request: CancelRunRequest) -> Result<AgentRun, AdapterContractError>;
}
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AdapterContractError {
    #[error("adapter unavailable: {0}")]
    Unavailable(String),
    #[error("adapter rejected request: {0}")]
    Rejected(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentHostState {
    Queued,
    Running,
    AwaitingInput,
    AwaitingPermission,
    PreviewingChanges,
    ApplyingChanges,
    Completed,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionProfile {
    ReadOnly,
    WorkspaceEditor,
    CanvasEditor,
    ArchiveManager,
}
impl PermissionProfile {
    pub fn capabilities(self) -> BTreeSet<CapabilityId> {
        let reads: BTreeSet<_> = canonical_manifest()
            .capabilities
            .into_iter()
            .filter(|contract| contract.risk == CapabilityRisk::Read)
            .map(|contract| contract.id)
            .collect();
        match self {
            Self::ReadOnly => reads,
            Self::WorkspaceEditor => reads
                .into_iter()
                .chain([
                    CapabilityId::WorkspaceCreateFolder,
                    CapabilityId::WorkspaceRenameFolder,
                    CapabilityId::WorkspaceCreatePage,
                    CapabilityId::WorkspaceRenamePage,
                    CapabilityId::WorkspaceMovePage,
                    CapabilityId::WorkspaceBookmarkPage,
                ])
                .collect(),
            Self::CanvasEditor => reads
                .into_iter()
                .chain([CapabilityId::CanvasApplyOperations])
                .collect(),
            Self::ArchiveManager => reads
                .into_iter()
                .chain([
                    CapabilityId::WorkspaceArchiveItems,
                    CapabilityId::WorkspaceRestoreItems,
                ])
                .collect(),
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GrantDuration {
    ThisRun,
    UntilAppExit,
    Persistent,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PermissionScope {
    pub workspace_id: String,
    pub page_ids: Option<BTreeSet<String>>,
    pub capability_ids: BTreeSet<CapabilityId>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PermissionGrant {
    pub profile: PermissionProfile,
    pub scope: PermissionScope,
    pub duration: GrantDuration,
    pub granted_at_unix_ms: u64,
}
impl PermissionGrant {
    pub fn validate(&self) -> Result<(), ContractValidationError> {
        if self.scope.workspace_id.is_empty()
            || !self
                .scope
                .capability_ids
                .is_subset(&self.profile.capabilities())
        {
            return Err(ContractValidationError::PermissionEscalation);
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderTransport {
    LocalHttp,
    RemoteHttps,
    Process,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderEndpointIdentity {
    pub provider_id: String,
    pub display_name: String,
    pub transport: ProviderTransport,
    pub endpoint_origin: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderConsent {
    pub endpoint: ProviderEndpointIdentity,
    pub accepted_at_unix_ms: u64,
    pub data_may_leave_device: bool,
}

/// A change set is either a workspace transaction or one page-bound canvas
/// transaction. The tagged union prevents mixed workspace/canvas commits.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", deny_unknown_fields)]
pub enum WorkspaceChangeSet {
    Workspace {
        change_set_id: String,
        expected_workspace_revision: u64,
        target_fingerprints: Vec<TargetFingerprint>,
        operations: Vec<WorkspaceOperation>,
    },
    Canvas {
        change_set_id: String,
        page_id: String,
        expected_page_revision: u64,
        target_fingerprints: Vec<TargetFingerprint>,
        operations: Vec<SemanticCanvasOperation>,
    },
}
impl WorkspaceChangeSet {
    pub fn validate_bounds(&self) -> Result<(), ContractValidationError> {
        match self {
            Self::Workspace { operations, .. } => {
                if operations.is_empty()
                    || operations.len() > DEFAULT_LIMITS.max_operations_per_change_set as usize
                {
                    return Err(ContractValidationError::TooManyOperations);
                }
            }
            Self::Canvas {
                page_id,
                target_fingerprints,
                operations,
                ..
            } => {
                if page_id.is_empty()
                    || operations.is_empty()
                    || operations.len() > DEFAULT_LIMITS.max_operations_per_change_set as usize
                {
                    return Err(ContractValidationError::InvalidCanvasChangeSet);
                }
                if target_fingerprints.iter().any(|fingerprint| {
                    fingerprint.resource_kind == ChangedResourceKind::Page
                        && fingerprint.resource_id != *page_id
                }) {
                    return Err(ContractValidationError::InvalidCanvasChangeSet);
                }
                let created = operations
                    .iter()
                    .map(SemanticCanvasOperation::created_count)
                    .sum::<usize>();
                let touched: BTreeSet<_> = operations
                    .iter()
                    .flat_map(SemanticCanvasOperation::touched_ids)
                    .collect();
                if created > DEFAULT_LIMITS.max_created_elements as usize
                    || touched.len() > DEFAULT_LIMITS.max_touched_elements as usize
                {
                    return Err(ContractValidationError::CanvasBudgetExceeded);
                }
            }
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TargetFingerprint {
    pub resource_kind: ChangedResourceKind,
    pub resource_id: String,
    pub expected_revision: u64,
    pub content_hash: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangedResourceKind {
    Folder,
    Page,
    CanvasElement,
    ArchiveItem,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type", deny_unknown_fields)]
pub enum WorkspaceOperation {
    CreateFolder {
        folder_id: String,
        name: String,
    },
    RenameFolder {
        folder_id: String,
        name: String,
    },
    CreatePage {
        page_id: String,
        folder_id: String,
        title: String,
    },
    RenamePage {
        page_id: String,
        title: String,
    },
    MovePage {
        page_id: String,
        folder_id: String,
    },
    BookmarkPage {
        page_id: String,
        bookmarked: bool,
    },
    ArchiveItems {
        items: Vec<ArchiveItemTarget>,
    },
    RestoreItems {
        items: Vec<ArchiveItemTarget>,
    },
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type", deny_unknown_fields)]
pub enum SemanticCanvasOperation {
    CreateText {
        element_id: String,
        text: String,
        x: f64,
        y: f64,
    },
    ReplaceText {
        element_id: String,
        text: String,
    },
    CreateShape {
        element_id: String,
        shape: ShapeKind,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    },
    MoveElements {
        targets: Vec<ElementTarget>,
        delta_x: f64,
        delta_y: f64,
    },
    ResizeElement {
        element_id: String,
        target_kind: CanvasBindableElementKind,
        width: f64,
        height: f64,
    },
    SetStyle {
        element_id: String,
        target_kind: CanvasBindableElementKind,
        style: CanvasStyle,
    },
    CreateConnector {
        element_id: String,
        start: ElementAnchor,
        end: ElementAnchor,
    },
    SetConnectorLabel {
        element_id: String,
        label: String,
    },
    CreateLine {
        element_id: String,
        start_x: f64,
        start_y: f64,
        end_x: f64,
        end_y: f64,
        style: LineStyle,
    },
    CreateArrow {
        element_id: String,
        start: ElementAnchor,
        end: ElementAnchor,
        style: ArrowStyle,
        label: String,
        label_style: TextStyle,
    },
    SetShapeText {
        element_id: String,
        text: String,
        text_style: TextStyle,
    },
    DuplicateElements {
        targets: Vec<ElementTarget>,
        delta_x: f64,
        delta_y: f64,
    },
    AlignElements {
        targets: Vec<ElementTarget>,
        alignment: Alignment,
    },
    DistributeElements {
        targets: Vec<ElementTarget>,
        axis: DistributionAxis,
    },
    ReorderElements {
        targets: Vec<ElementTarget>,
        placement: ReorderPlacement,
    },
}
impl SemanticCanvasOperation {
    fn created_count(&self) -> usize {
        match self {
            Self::CreateText { .. }
            | Self::CreateShape { .. }
            | Self::CreateConnector { .. }
            | Self::CreateLine { .. }
            | Self::CreateArrow { .. } => 1,
            Self::DuplicateElements { targets, .. } => targets.len(),
            _ => 0,
        }
    }
    fn touched_ids(&self) -> Vec<&str> {
        match self {
            Self::MoveElements { targets, .. }
            | Self::DuplicateElements { targets, .. }
            | Self::AlignElements { targets, .. }
            | Self::DistributeElements { targets, .. }
            | Self::ReorderElements { targets, .. } => targets
                .iter()
                .map(|target| target.element_id.as_str())
                .collect(),
            Self::CreateConnector { start, end, .. } | Self::CreateArrow { start, end, .. } => {
                vec![start.element_id.as_str(), end.element_id.as_str()]
            }
            Self::CreateText { element_id, .. }
            | Self::ReplaceText { element_id, .. }
            | Self::CreateShape { element_id, .. }
            | Self::ResizeElement { element_id, .. }
            | Self::SetStyle { element_id, .. }
            | Self::SetConnectorLabel { element_id, .. }
            | Self::CreateLine { element_id, .. }
            | Self::SetShapeText { element_id, .. } => vec![element_id.as_str()],
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchiveItemTarget {
    pub kind: ArchiveItemKind,
    pub id: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchiveItemKind {
    Folder,
    Page,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LineStyle {
    pub stroke: String,
    pub stroke_width: f64,
    pub dash: Option<LineDash>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArrowStyle {
    pub stroke: String,
    pub stroke_width: f64,
    pub start_arrowhead: Arrowhead,
    pub end_arrowhead: Arrowhead,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextStyle {
    pub font_size: Option<u8>,
    pub font_weight: Option<FontWeight>,
    pub color: Option<String>,
    pub alignment: Option<TextAlignment>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LineDash {
    Solid,
    Dashed,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Arrowhead {
    None,
    Triangle,
    Arrow,
    Diamond,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FontWeight {
    Normal,
    Bold,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextAlignment {
    Left,
    Center,
    Right,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Alignment {
    Left,
    Center,
    Right,
    Top,
    Middle,
    Bottom,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DistributionAxis {
    Horizontal,
    Vertical,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReorderPlacement {
    BringToFront,
    BringForward,
    SendBackward,
    SendToBack,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShapeKind {
    Rectangle,
    Ellipse,
    Diamond,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CanvasBindableElementKind {
    Text,
    Shape,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ElementTarget {
    pub element_id: String,
    pub target_kind: CanvasBindableElementKind,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasStyle {
    pub fill: Option<String>,
    pub stroke: Option<String>,
    pub stroke_width: Option<f64>,
    pub opacity: Option<f64>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ElementAnchor {
    pub element_id: String,
    pub target_kind: CanvasBindableElementKind,
    pub anchor: ElementAnchorPosition,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ElementAnchorPosition {
    Top,
    Right,
    Bottom,
    Left,
    Center,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MutationReceipt {
    pub audit_id: String,
    pub change_set_id: String,
    pub changed_resources: Vec<ChangedResource>,
    pub workspace_revision: u64,
    pub page_revisions: BTreeMap<String, u64>,
    pub inverse_change_set: BoundedInverseChangeSet,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChangedResource {
    pub kind: ChangedResourceKind,
    pub id: String,
    pub new_revision: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoundedInverseChangeSet {
    pub inverse_change_set_id: String,
    pub changes: Vec<InverseChange>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type", deny_unknown_fields)]
pub enum InverseChange {
    RestoreResource {
        kind: ChangedResourceKind,
        id: String,
    },
    ReapplyWorkspaceOperation {
        operation: WorkspaceOperation,
    },
}
impl BoundedInverseChangeSet {
    pub fn validate_bounds(&self) -> Result<(), ContractValidationError> {
        if self.changes.len() > MAX_INVERSE_CHANGES {
            return Err(ContractValidationError::TooManyInverseChanges);
        }
        let value =
            serde_json::to_value(self).map_err(|error| violation("$", error.to_string()))?;
        check_payload_size(&value, MAX_INVERSE_CHANGESET_BYTES)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn registry_is_complete_and_read_only_is_non_mutating() {
        let manifest = canonical_manifest();
        assert_eq!(manifest.capabilities.len(), 15);
        assert_eq!(
            manifest
                .capabilities
                .iter()
                .filter(|c| c.risk == CapabilityRisk::Read)
                .count(),
            6
        );
        assert_eq!(PermissionProfile::ReadOnly.capabilities().len(), 6);
        assert!(!manifest
            .capabilities
            .iter()
            .any(|c| c.id.as_str().contains("delete")));
        assert!(!PermissionProfile::ReadOnly
            .capabilities()
            .iter()
            .any(|id| canonical_manifest()
                .capabilities
                .iter()
                .any(|c| c.id == *id && c.risk != CapabilityRisk::Read)));
    }

    #[test]
    fn canonical_manifest_matches_checked_in_golden() {
        let serialized = serde_json::to_string_pretty(&canonical_manifest()).unwrap();
        assert_eq!(
            normalize_newlines(&serialized),
            normalize_newlines(include_str!("agent_contracts_manifest.v1.json").trim_end())
        );
    }

    /// Regenerate the checked-in artifact after an intentional contract version
    /// change. Kept ignored so ordinary tests never mutate the worktree.
    #[test]
    #[ignore = "run explicitly to regenerate the canonical manifest artifact"]
    fn regenerate_checked_in_manifest_artifact() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("agent_contracts_manifest.v1.json");
        std::fs::write(
            path,
            serde_json::to_string_pretty(&canonical_manifest()).unwrap() + "\n",
        )
        .unwrap();
    }

    #[test]
    fn every_contract_has_a_strict_schema_and_positive_limits() {
        for capability in canonical_manifest().capabilities {
            assert_eq!(capability.schema_version, CAPABILITY_SCHEMA_VERSION);
            assert_eq!(capability.input_schema["additionalProperties"], false);
            assert!(capability.timeout_ms > 0 && capability.result_byte_limit > 0);
        }
    }

    #[test]
    fn registry_has_exact_unique_capability_ids() {
        let ids: BTreeSet<_> = canonical_manifest()
            .capabilities
            .into_iter()
            .map(|contract| contract.id)
            .collect();
        assert_eq!(ids, CapabilityId::ALL.into_iter().collect());
        assert_eq!(ids.len(), CapabilityId::ALL.len());
    }

    #[test]
    fn receipts_maps_screenshots_and_json_safe_revisions_validate() {
        let receipt = json!({"receipt": serde_json::to_value(MutationReceipt { audit_id: "audit".into(), change_set_id: "change".into(), changed_resources: vec![], workspace_revision: MAX_JSON_SAFE_REVISION as u64, page_revisions: BTreeMap::from([("page".into(), MAX_JSON_SAFE_REVISION as u64)]), inverse_change_set: BoundedInverseChangeSet { inverse_change_set_id: "undo".into(), changes: vec![InverseChange::RestoreResource { kind: ChangedResourceKind::Page, id: "page".into() }] } }).unwrap()});
        assert!(validate_tool_result(CapabilityId::WorkspaceCreatePage, &receipt).is_ok());
        let screenshot = json!({"pageId":"page","revision":0,"mediaType":"image/png","dataBase64":"x".repeat(MAX_SCREENSHOT_TRANSPORT_BYTES as usize),"requiresApproval":true,"persisted":false});
        assert!(validate_tool_result(CapabilityId::CanvasRequestScreenshot, &screenshot).is_ok());
        assert!(matches!(
            validate_tool_result(
                CapabilityId::CanvasRequestScreenshot,
                &json!({"pageId":"page","revision":MAX_JSON_SAFE_REVISION + 1,"mediaType":"image/png","dataBase64":"x","requiresApproval":true,"persisted":false})
            ),
            Err(ContractValidationError::SchemaViolation { .. })
        ));
    }

    #[test]
    fn permission_grants_cannot_escalate_profiles() {
        let grant = PermissionGrant {
            profile: PermissionProfile::ReadOnly,
            scope: PermissionScope {
                workspace_id: "workspace".into(),
                page_ids: None,
                capability_ids: BTreeSet::from([CapabilityId::CanvasApplyOperations]),
            },
            duration: GrantDuration::ThisRun,
            granted_at_unix_ms: 0,
        };
        assert_eq!(
            grant.validate(),
            Err(ContractValidationError::PermissionEscalation)
        );
    }

    #[test]
    fn invocation_validation_fails_closed() {
        let valid = ToolInvocation {
            capability_id: CapabilityId::WorkspaceSearch,
            schema_version: "1.0.0".into(),
            asserted_risk: CapabilityRisk::Read,
            input: json!({"query":"canvas", "limit":10}),
        };
        assert!(validate_tool_invocation(&valid).is_ok());
        assert_eq!(
            validate_tool_invocation(&ToolInvocation {
                asserted_risk: CapabilityRisk::Write,
                ..valid.clone()
            })
            .unwrap_err(),
            ContractValidationError::RiskMismatch
        );
        assert!(matches!(
            validate_tool_invocation(&ToolInvocation {
                schema_version: "2.0.0".into(),
                ..valid.clone()
            }),
            Err(ContractValidationError::UnsupportedSchemaVersion(_))
        ));
        assert!(matches!(
            validate_tool_invocation(&ToolInvocation {
                input: json!({"query":"canvas", "surprise":true}),
                ..valid
            }),
            Err(ContractValidationError::UnknownField(_))
        ));
    }

    #[test]
    fn manifest_parsing_and_validation_reject_drift() {
        let value = serde_json::to_value(canonical_manifest()).unwrap();
        assert!(validate_manifest(&parse_manifest(&value).unwrap()).is_ok());
        let mut unknown = value.clone();
        unknown["unknown"] = json!(true);
        assert!(matches!(
            parse_manifest(&unknown),
            Err(ContractValidationError::UnknownField(_))
        ));
        let mut drift = canonical_manifest();
        drift.capabilities[0].risk = CapabilityRisk::Write;
        assert_eq!(
            validate_manifest(&drift),
            Err(ContractValidationError::ManifestMismatch)
        );
    }

    #[test]
    fn semantic_operations_reject_excluded_forms() {
        let contract = canonical_manifest()
            .capabilities
            .into_iter()
            .find(|c| c.id == CapabilityId::CanvasApplyOperations)
            .unwrap();
        let valid = json!({"pageId":"p", "expectedPageRevision":0, "operations":[{"type":"create_connector", "elementId":"c", "start":{"elementId":"a", "targetKind":"shape", "anchor":"right"}, "end":{"elementId":"b", "targetKind":"text", "anchor":"left"}}]});
        assert!(validate_json_schema(&contract.input_schema, &valid, "$").is_ok());
        for invalid in [
            json!({"pageId":"p", "expectedPageRevision":0, "operations":[{"type":"delete_element", "elementId":"a"}]}),
            json!({"pageId":"p", "expectedPageRevision":0, "operations":[{"type":"move_elements", "targets":[{"elementId":"a", "targetKind":"shape"}], "deltaX":1, "deltaY":1, "rotation":45}]}),
            json!({"pageId":"p", "expectedPageRevision":0, "operations":[{"type":"create_connector", "elementId":"c", "start":{"elementId":"connector-1", "targetKind":"connector", "anchor":"right"}, "end":{"elementId":"b", "targetKind":"shape", "anchor":"left"}}]}),
        ] {
            assert!(validate_json_schema(&contract.input_schema, &invalid, "$").is_err());
        }
    }

    #[test]
    fn result_size_and_inverse_bounds_are_enforced() {
        assert!(matches!(
            check_payload_size(&json!("abcdef"), 3),
            Err(ContractValidationError::PayloadTooLarge { limit: 3 })
        ));
        let inverse = BoundedInverseChangeSet {
            inverse_change_set_id: "undo".into(),
            changes: (0..=MAX_INVERSE_CHANGES)
                .map(|index| InverseChange::RestoreResource {
                    kind: ChangedResourceKind::Page,
                    id: index.to_string(),
                })
                .collect(),
        };
        assert_eq!(
            inverse.validate_bounds(),
            Err(ContractValidationError::TooManyInverseChanges)
        );
    }

    #[test]
    fn canvas_change_set_cannot_mix_pages_or_be_empty() {
        let valid = WorkspaceChangeSet::Canvas {
            change_set_id: "change".into(),
            page_id: "page-a".into(),
            expected_page_revision: 3,
            target_fingerprints: vec![TargetFingerprint {
                resource_kind: ChangedResourceKind::Page,
                resource_id: "page-a".into(),
                expected_revision: 3,
                content_hash: "hash".into(),
            }],
            operations: vec![SemanticCanvasOperation::CreateText {
                element_id: "text-a".into(),
                text: "hello".into(),
                x: 0.0,
                y: 0.0,
            }],
        };
        assert!(valid.validate_bounds().is_ok());
        let invalid = WorkspaceChangeSet::Canvas {
            change_set_id: "change".into(),
            page_id: "page-a".into(),
            expected_page_revision: 3,
            target_fingerprints: vec![TargetFingerprint {
                resource_kind: ChangedResourceKind::Page,
                resource_id: "page-b".into(),
                expected_revision: 3,
                content_hash: "hash".into(),
            }],
            operations: vec![SemanticCanvasOperation::CreateText {
                element_id: "text-a".into(),
                text: "hello".into(),
                x: 0.0,
                y: 0.0,
            }],
        };
        assert_eq!(
            invalid.validate_bounds(),
            Err(ContractValidationError::InvalidCanvasChangeSet)
        );
    }
}
