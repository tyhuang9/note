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
pub const MAX_JSON_SAFE_REVISION: i64 = 9_007_199_254_740_991;
pub const MAX_SCREENSHOT_APPROVAL_LIFETIME_MS: u64 = 5 * 60 * 1_000;
pub const MAX_AGENT_PROMPT_BYTES: usize = 32 * 1024;
pub const MAX_AGENT_DESCRIPTORS: usize = 64;
pub const MAX_ADAPTER_MESSAGE_BYTES: usize = 1_024;
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
    ScreenshotApproval,
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
                object_schema(&[], json!({"includeTrashMetadata": boolean_schema()})),
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
                    json!({"query": string_schema(1, 512), "pageId": nullable_id_schema(), "limit": integer_schema(1, 200)}),
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
                scene_input_schema(),
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
                    &["pageId", "viewport"],
                    json!({"pageId": id_schema(), "viewport": viewport_schema(), "scale": number_schema(0.5, 2.0)}),
                ),
                screenshot_output_schema(),
                DataScope::Screenshot,
                CapabilityRisk::Read,
                15_000,
                MAX_TOOL_RESULT_BYTES,
                PreviewType::ScreenshotApproval,
            ),
            capability(
                CapabilityId::WorkspaceCreateFolder,
                object_schema(
                    &["name", "expectedWorkspaceRevision"],
                    json!({"name": string_schema(1, 120), "expectedWorkspaceRevision": revision_schema()}),
                ),
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
                    &["folderId", "title", "expectedWorkspaceRevision"],
                    json!({"folderId": id_schema(), "title": string_schema(1, 240), "expectedWorkspaceRevision": revision_schema()}),
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
                    &["pageId", "title", "expectedWorkspaceRevision"],
                    json!({"pageId": id_schema(), "title": string_schema(1, 240), "expectedWorkspaceRevision": revision_schema()}),
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
                    &["pageId", "folderId", "expectedWorkspaceRevision"],
                    json!({"pageId": id_schema(), "folderId": id_schema(), "expectedWorkspaceRevision": revision_schema()}),
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
                    &["pageId", "bookmarked", "expectedWorkspaceRevision"],
                    json!({"pageId": id_schema(), "bookmarked": boolean_schema(), "expectedWorkspaceRevision": revision_schema()}),
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
fn non_empty_object_schema(properties: Value) -> Value {
    json!({"type":"object", "additionalProperties":false, "required":[], "minProperties":1, "properties":properties})
}
fn map_schema(value_schema: Value) -> Value {
    json!({"type":"object", "additionalProperties":value_schema, "required":[]})
}
fn id_schema() -> Value {
    string_schema(1, 128)
}
fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
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
fn completeness_schema() -> Value {
    object_schema(
        &["returnedCount", "isComplete"],
        json!({
            "returnedCount": integer_schema(0, DEFAULT_LIMITS.max_read_summaries as i64),
            "isComplete": boolean_schema(),
            "totalCount": integer_schema(0, MAX_JSON_SAFE_REVISION),
            "reason": enum_schema(&["complete", "result_limit", "scope_limit"])
        }),
    )
}
fn trash_metadata_schema() -> Value {
    object_schema(
        &["kind", "id", "name", "trashedAt"],
        json!({
            "kind": enum_schema(&["folder", "page"]),
            "id": id_schema(),
            "name": string_schema(1, 240),
            "trashedAt": string_schema(1, 64)
        }),
    )
}
fn structure_output_schema() -> Value {
    object_schema(
        &["workspaceRevision", "folders", "pages", "completeness"],
        json!({
            "workspaceRevision": revision_schema(),
            "folders": array_schema(folder_schema(), 0, DEFAULT_LIMITS.max_read_summaries as u64),
            "pages": array_schema(page_schema(), 0, DEFAULT_LIMITS.max_read_summaries as u64),
            "trashMetadata": array_schema(trash_metadata_schema(), 0, DEFAULT_LIMITS.max_read_summaries as u64),
            "completeness": completeness_schema()
        }),
    )
}
fn search_output_schema() -> Value {
    object_schema(
        &["matches", "completeness"],
        json!({
            "matches": array_schema(object_schema(
                &["pageId", "kind", "title", "snippet"],
                json!({
                    "pageId": id_schema(),
                    "kind": enum_schema(&["title", "plain_text", "shape_text", "connector_label"]),
                    "title": string_schema(0, 240),
                    "snippet": string_schema(0, 2_000)
                })
            ), 0, DEFAULT_LIMITS.max_read_summaries as u64),
            "completeness": completeness_schema()
        }),
    )
}
fn page_output_schema() -> Value {
    object_schema(&["page"], json!({"page":page_schema()}))
}
fn scene_output_schema() -> Value {
    object_schema(
        &["pageId", "revision", "elements", "completeness"],
        json!({"pageId":id_schema(), "revision":revision_schema(), "elements":array_schema(canvas_element_schema(), 0, DEFAULT_LIMITS.max_viewport_summaries as u64), "completeness":completeness_schema()}),
    )
}
fn elements_output_schema() -> Value {
    object_schema(
        &["pageId", "revision", "elements", "completeness"],
        json!({"pageId":id_schema(), "revision":revision_schema(), "elements":array_schema(canvas_element_schema(), 0, DEFAULT_LIMITS.max_detailed_elements as u64), "completeness":completeness_schema()}),
    )
}
fn screenshot_output_schema() -> Value {
    object_schema(
        &[
            "approvalArtifact",
            "attachmentId",
            "mediaType",
            "requiresApproval",
            "persisted",
        ],
        json!({
            "approvalArtifact":screenshot_approval_artifact_schema(),
            "attachmentId":id_schema(),
            "mediaType":enum_schema(&["image/png"]),
            "requiresApproval":json!({"type":"boolean", "enum":[true]}),
            "persisted":json!({"type":"boolean", "enum":[false]})
        }),
    )
}
fn provider_endpoint_schema() -> Value {
    object_schema(
        &[
            "providerId",
            "displayName",
            "transport",
            "normalizedEndpointIdentity",
        ],
        json!({
            "providerId":id_schema(),
            "displayName":string_schema(1,120),
            "transport":enum_schema(&["local_http", "remote_https", "process"]),
            "normalizedEndpointIdentity":string_schema(1,2_048)
        }),
    )
}
fn screenshot_approval_artifact_schema() -> Value {
    object_schema(
        &[
            "approvalId",
            "attachmentId",
            "runId",
            "toolCallId",
            "provider",
            "pageId",
            "pageRevision",
            "viewport",
            "scale",
            "issuedAtUnixMs",
            "expiresAtUnixMs",
            "singleUse",
        ],
        json!({
            "approvalId":id_schema(),
            "attachmentId":id_schema(),
            "runId":id_schema(),
            "toolCallId":id_schema(),
            "provider":provider_endpoint_schema(),
            "pageId":id_schema(),
            "pageRevision":revision_schema(),
            "viewport":viewport_schema(),
            "scale":number_schema(0.5,2.0),
            "issuedAtUnixMs":revision_schema(),
            "expiresAtUnixMs":revision_schema(),
            "singleUse":json!({"type":"boolean", "enum":[true]})
        }),
    )
}
fn scene_input_schema() -> Value {
    let active_page = object_schema(
        &["pageId", "scope"],
        json!({"pageId":id_schema(), "scope":enum_schema(&["active_page"])}),
    );
    let viewport = object_schema(
        &["pageId", "scope", "viewport"],
        json!({"pageId":id_schema(), "scope":enum_schema(&["viewport"]), "viewport":viewport_schema()}),
    );
    let selection = object_schema(
        &["pageId", "scope", "elementIds"],
        json!({"pageId":id_schema(), "scope":enum_schema(&["selection"]), "elementIds":array_schema(id_schema(), 1, DEFAULT_LIMITS.max_selected_descriptors as u64)}),
    );
    json!({"type":"object", "additionalProperties":false, "oneOf":[active_page, viewport, selection]})
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
            "runId",
            "toolCallId",
            "changedResources",
            "workspaceRevision",
            "pageRevisions",
            "inverseChangeSet",
        ],
        json!({"auditId":id_schema(), "changeSetId":id_schema(), "runId":id_schema(), "toolCallId":id_schema(), "changedResources":array_schema(changed_resource_schema(), 0, DEFAULT_LIMITS.max_touched_elements as u64), "workspaceRevision":revision_schema(), "pageRevisions":map_schema(revision_schema()), "inverseChangeSet":inverse_change_set_schema()}),
    )
}
fn inverse_change_set_schema() -> Value {
    object_schema(
        &["inverseChangeSetId", "changes"],
        json!({
            "inverseChangeSetId":id_schema(),
            "changes":array_schema(json!({"oneOf":[
                object_schema(&["type", "kind", "id"], json!({"type":enum_schema(&["restore_resource"]), "kind":enum_schema(&["workspace", "folder", "page", "canvas_element", "archive_item"]), "id":id_schema()})),
                object_schema(&["type", "operation"], json!({"type":enum_schema(&["reapply_workspace_operation"]), "operation":workspace_operation_schema()}))
            ]}), 0, MAX_INVERSE_CHANGES as u64)
        }),
    )
}
fn workspace_operation_schema() -> Value {
    let folder = || {
        object_schema(
            &["type", "folderId", "name"],
            json!({"type":enum_schema(&["create_folder", "rename_folder"]), "folderId":id_schema(), "name":string_schema(1,120)}),
        )
    };
    let create_page = object_schema(
        &["type", "pageId", "folderId", "title"],
        json!({"type":enum_schema(&["create_page"]), "pageId":id_schema(), "folderId":id_schema(), "title":string_schema(1,240)}),
    );
    let rename_page = object_schema(
        &["type", "pageId", "title"],
        json!({"type":enum_schema(&["rename_page"]), "pageId":id_schema(), "title":string_schema(1,240)}),
    );
    let move_page = object_schema(
        &["type", "pageId", "folderId"],
        json!({"type":enum_schema(&["move_page"]), "pageId":id_schema(), "folderId":id_schema()}),
    );
    let bookmark = object_schema(
        &["type", "pageId", "bookmarked"],
        json!({"type":enum_schema(&["bookmark_page"]), "pageId":id_schema(), "bookmarked":boolean_schema()}),
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
        json!({"kind":enum_schema(&["workspace", "folder", "page", "canvas_element", "archive_item"]), "id":id_schema(), "newRevision":revision_schema()}),
    )
}
fn canvas_element_schema() -> Value {
    object_schema(
        &["id", "kind", "x", "y", "width", "height", "summary"],
        json!({"id":id_schema(), "kind":enum_schema(&["text", "shape", "line", "connector", "image", "ink"]), "x":number_schema(-1_000_000.0, 1_000_000.0), "y":number_schema(-1_000_000.0, 1_000_000.0), "width":number_schema(1.0, 100_000.0), "height":number_schema(1.0, 100_000.0), "summary":string_schema(0, 2_000)}),
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
        json!({"type":enum_schema(&["move_elements"]), "targets":array_schema(element_target_schema(), 1, DEFAULT_LIMITS.max_touched_elements as u64), "deltaX":number_schema(-1_000_000.0, 1_000_000.0), "deltaY":number_schema(-1_000_000.0, 1_000_000.0)}),
    );
    let resize = object_schema(
        &["type", "elementId", "targetKind", "width", "height"],
        json!({"type":enum_schema(&["resize_element"]), "elementId":id_schema(), "targetKind":mutable_element_kind_schema(), "width":number_schema(1.0, 100_000.0), "height":number_schema(1.0, 100_000.0)}),
    );
    let style = object_schema(
        &["type", "elementId", "targetKind", "style"],
        json!({"type":enum_schema(&["set_style"]), "elementId":id_schema(), "targetKind":mutable_element_kind_schema(), "style":non_empty_object_schema(json!({"fill":string_schema(1, 32), "stroke":string_schema(1, 32), "strokeWidth":number_schema(0.5, 32.0), "opacity":number_schema(0.0, 1.0)}))}),
    );
    let text_style = object_schema(
        &["type", "elementId", "targetKind", "style"],
        json!({"type":enum_schema(&["set_text_style"]), "elementId":id_schema(), "targetKind":bindable_element_kind_schema(), "style":text_style_schema()}),
    );
    let connector = object_schema(
        &["type", "elementId", "start", "end"],
        json!({"type":enum_schema(&["create_connector"]), "elementId":id_schema(), "start":element_anchor_schema(), "end":element_anchor_schema()}),
    );
    let label = object_schema(
        &["type", "elementId", "label"],
        json!({"type":enum_schema(&["set_connector_label"]), "elementId":id_schema(), "label":string_schema(0, 1_000), "labelStyle":text_style_schema()}),
    );
    let arrowheads = object_schema(
        &["type", "elementId", "startArrowhead", "endArrowhead"],
        json!({"type":enum_schema(&["set_arrowheads"]), "elementId":id_schema(), "startArrowhead":arrowhead_schema(), "endArrowhead":arrowhead_schema()}),
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
        &["type", "elementId", "start", "end", "style", "label"],
        json!({"type":enum_schema(&["create_arrow"]), "elementId":id_schema(), "start":element_anchor_schema(), "end":element_anchor_schema(), "style":arrow_style_schema(), "label":string_schema(0,1_000), "labelStyle":text_style_schema()}),
    );
    let shape_text = object_schema(
        &["type", "elementId", "text"],
        json!({"type":enum_schema(&["set_shape_text"]), "elementId":id_schema(), "text":string_schema(0,10_000), "textStyle":text_style_schema()}),
    );
    let duplicate = object_schema(
        &["type", "targets", "deltaX", "deltaY"],
        json!({"type":enum_schema(&["duplicate_elements"]), "targets":array_schema(element_target_schema(),1,DEFAULT_LIMITS.max_created_elements as u64), "deltaX":number_schema(-1_000_000.0,1_000_000.0), "deltaY":number_schema(-1_000_000.0,1_000_000.0)}),
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
        json!({"oneOf":[text, replace_text, shape, move_elements, resize, style, text_style, connector, label, arrowheads, line, arrow, shape_text, duplicate, align, distribute, reorder]}),
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
    non_empty_object_schema(
        json!({"fontSize":integer_schema(8,96), "fontWeight":enum_schema(&["normal", "bold"]), "color":string_schema(1,32), "alignment":enum_schema(&["left", "center", "right"])}),
    )
}
fn bindable_element_kind_schema() -> Value {
    enum_schema(&["text", "shape"])
}
fn mutable_element_kind_schema() -> Value {
    enum_schema(&["text", "shape", "line", "connector"])
}
fn element_target_schema() -> Value {
    object_schema(
        &["elementId", "targetKind"],
        json!({"elementId":id_schema(), "targetKind":mutable_element_kind_schema()}),
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
    pub run_id: String,
    pub tool_call_id: String,
    pub provider: ProviderEndpointIdentity,
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
    #[error("workspace change set must bind one non-empty workspace transaction")]
    InvalidWorkspaceChangeSet,
    #[error("permission grant requests a capability outside its profile")]
    PermissionEscalation,
    #[error("canvas change set exceeds V1 creation or touched-element budgets")]
    CanvasBudgetExceeded,
    #[error("agent context exceeds V1 bounds")]
    ContextBoundsExceeded,
    #[error("run and tool-call identifiers must both be non-empty")]
    InvalidIdempotencyKey,
    #[error("provider endpoint identity is not canonical or safe")]
    InvalidProviderEndpoint,
    #[error("adapter DTO exceeds V1 bounds")]
    AdapterBoundsExceeded,
    #[error("screenshot approval artifact is invalid or does not match the request")]
    InvalidScreenshotApproval,
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
    ToolCallIdempotencyKey {
        run_id: invocation.run_id.clone(),
        tool_call_id: invocation.tool_call_id.clone(),
    }
    .validate()?;
    invocation.provider.validate()?;
    check_serialized_size(invocation, MAX_TOOL_INPUT_BYTES)?;
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
    if capability_id == CapabilityId::CanvasRequestScreenshot {
        return Err(ContractValidationError::InvalidScreenshotApproval);
    }
    validate_tool_result_schema(capability_id, value)
}

fn validate_tool_result_schema(
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

fn check_serialized_size<T: Serialize>(
    value: &T,
    limit: u64,
) -> Result<(), ContractValidationError> {
    let value = serde_json::to_value(value).map_err(|error| violation("$", error.to_string()))?;
    check_payload_size(&value, limit)
}

fn viewport_is_valid(viewport: &ViewportContext) -> bool {
    viewport.x.is_finite()
        && viewport.y.is_finite()
        && viewport.width.is_finite()
        && viewport.height.is_finite()
        && (-1_000_000.0..=1_000_000.0).contains(&viewport.x)
        && (-1_000_000.0..=1_000_000.0).contains(&viewport.y)
        && (1.0..=100_000.0).contains(&viewport.width)
        && (1.0..=100_000.0).contains(&viewport.height)
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
            bounds(object.len() as f64, schema, path)?;
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
        .or_else(|| schema.get("minItems").and_then(Value::as_f64))
        .or_else(|| schema.get("minProperties").and_then(Value::as_f64));
    let maximum = schema
        .get("maximum")
        .and_then(Value::as_f64)
        .or_else(|| schema.get("maxLength").and_then(Value::as_f64))
        .or_else(|| schema.get("maxItems").and_then(Value::as_f64))
        .or_else(|| schema.get("maxProperties").and_then(Value::as_f64));
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
impl AgentAdapterStatusRequest {
    pub fn validate(&self) -> Result<(), ContractValidationError> {
        if self.manifest_id != MANIFEST_ID
            || self.manifest_schema_version != MANIFEST_SCHEMA_VERSION
        {
            return Err(ContractValidationError::UnsupportedSchemaVersion(
                self.manifest_schema_version.clone(),
            ));
        }
        check_serialized_size(self, MAX_TOOL_INPUT_BYTES)
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentAdapterStatus {
    pub available: bool,
    pub provider: ProviderEndpointIdentity,
    pub reason: Option<String>,
}
impl AgentAdapterStatus {
    pub fn validate(&self) -> Result<(), ContractValidationError> {
        self.provider.validate()?;
        if self
            .reason
            .as_ref()
            .is_some_and(|reason| reason.len() > MAX_ADAPTER_MESSAGE_BYTES)
        {
            return Err(ContractValidationError::AdapterBoundsExceeded);
        }
        check_serialized_size(self, MAX_TOOL_RESULT_BYTES)
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListAgentsRequest {
    pub manifest_id: String,
    pub manifest_schema_version: String,
}
impl ListAgentsRequest {
    pub fn validate(&self) -> Result<(), ContractValidationError> {
        AgentAdapterStatusRequest {
            manifest_id: self.manifest_id.clone(),
            manifest_schema_version: self.manifest_schema_version.clone(),
        }
        .validate()
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentDescriptor {
    pub agent_id: String,
    pub display_name: String,
    pub capabilities: Vec<CapabilityId>,
}
impl AgentDescriptor {
    pub fn validate(&self) -> Result<(), ContractValidationError> {
        let capabilities: BTreeSet<_> = self.capabilities.iter().copied().collect();
        if !valid_identifier(&self.agent_id)
            || self.display_name.trim().is_empty()
            || self.display_name.chars().count() > 120
            || self.capabilities.len() > CapabilityId::ALL.len()
            || capabilities.len() != self.capabilities.len()
        {
            return Err(ContractValidationError::AdapterBoundsExceeded);
        }
        check_serialized_size(self, MAX_TOOL_RESULT_BYTES)
    }
}
pub fn validate_agent_descriptors(
    descriptors: &[AgentDescriptor],
) -> Result<(), ContractValidationError> {
    if descriptors.len() > MAX_AGENT_DESCRIPTORS {
        return Err(ContractValidationError::AdapterBoundsExceeded);
    }
    let mut ids = BTreeSet::new();
    for descriptor in descriptors {
        descriptor.validate()?;
        if !ids.insert(descriptor.agent_id.as_str()) {
            return Err(ContractValidationError::AdapterBoundsExceeded);
        }
    }
    check_serialized_size(&descriptors, MAX_TOOL_RESULT_BYTES)
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartRunRequest {
    pub agent_id: String,
    pub prompt: String,
    pub context: AgentContextEnvelope,
    pub permission_grant: PermissionGrant,
    pub provider_consent: ProviderConsent,
}
impl StartRunRequest {
    pub fn validate(&self) -> Result<(), ContractValidationError> {
        if !valid_identifier(&self.agent_id)
            || self.prompt.trim().is_empty()
            || self.prompt.len() > MAX_AGENT_PROMPT_BYTES
        {
            return Err(ContractValidationError::AdapterBoundsExceeded);
        }
        self.context.validate_bounds()?;
        self.provider_consent.validate()?;
        check_serialized_size(self, MAX_TOOL_INPUT_BYTES)
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContinueRunRequest {
    pub run_id: String,
    pub response: Value,
    pub context: AgentContextEnvelope,
    pub permission_grant: PermissionGrant,
}
impl ContinueRunRequest {
    pub fn validate(&self) -> Result<(), ContractValidationError> {
        if !valid_identifier(&self.run_id) {
            return Err(ContractValidationError::AdapterBoundsExceeded);
        }
        check_payload_size(&self.response, MAX_TOOL_RESULT_BYTES)?;
        self.context.validate_bounds()?;
        check_serialized_size(self, MAX_TOOL_INPUT_BYTES)
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelRunRequest {
    pub run_id: String,
    pub reason: Option<String>,
}
impl CancelRunRequest {
    pub fn validate(&self) -> Result<(), ContractValidationError> {
        if !valid_identifier(&self.run_id)
            || self
                .reason
                .as_ref()
                .is_some_and(|reason| reason.len() > MAX_ADAPTER_MESSAGE_BYTES)
        {
            return Err(ContractValidationError::AdapterBoundsExceeded);
        }
        check_serialized_size(self, MAX_TOOL_INPUT_BYTES)
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRun {
    pub run_id: String,
    pub state: AgentHostState,
    pub audit_id: String,
}
impl AgentRun {
    pub fn validate(&self) -> Result<(), ContractValidationError> {
        if !valid_identifier(&self.run_id) || !valid_identifier(&self.audit_id) {
            return Err(ContractValidationError::AdapterBoundsExceeded);
        }
        check_serialized_size(self, MAX_TOOL_RESULT_BYTES)
    }
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
    Idle,
    Running,
    AwaitingApproval,
    Executing,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionProfile {
    ReadOnly,
    AskBeforeChanges,
    FullNoteAccess,
    Custom,
}
pub const DEFAULT_PERMISSION_PROFILE: PermissionProfile = PermissionProfile::AskBeforeChanges;
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
            Self::AskBeforeChanges | Self::FullNoteAccess => {
                CapabilityId::ALL.into_iter().collect()
            }
            Self::Custom => BTreeSet::new(),
        }
    }

    pub fn mutation_approval_policy(self) -> MutationApprovalPolicy {
        match self {
            Self::ReadOnly => MutationApprovalPolicy::NotApplicable,
            Self::AskBeforeChanges => MutationApprovalPolicy::EveryChange,
            Self::FullNoteAccess => MutationApprovalPolicy::Automatic,
            Self::Custom => MutationApprovalPolicy::GrantControlled,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MutationApprovalPolicy {
    NotApplicable,
    EveryChange,
    Automatic,
    GrantControlled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GlobalAgentPermissionSettings {
    pub default_profile: PermissionProfile,
    pub custom_capability_ids: BTreeSet<CapabilityId>,
}
impl GlobalAgentPermissionSettings {
    pub fn allowed_capabilities(&self) -> BTreeSet<CapabilityId> {
        if self.default_profile == PermissionProfile::Custom {
            self.custom_capability_ids.clone()
        } else {
            self.default_profile.capabilities()
        }
    }

    pub fn validate(&self) -> Result<(), ContractValidationError> {
        if self.default_profile != PermissionProfile::Custom
            && !self.custom_capability_ids.is_empty()
        {
            return Err(ContractValidationError::PermissionEscalation);
        }
        check_serialized_size(self, MAX_TOOL_INPUT_BYTES)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceAgentPause {
    pub workspace_id: String,
    pub actions_paused: bool,
}

impl WorkspaceAgentPause {
    pub fn effective_profile(&self, global: &GlobalAgentPermissionSettings) -> PermissionProfile {
        if self.actions_paused {
            PermissionProfile::ReadOnly
        } else {
            global.default_profile
        }
    }

    pub fn allowed_capabilities(
        &self,
        global: &GlobalAgentPermissionSettings,
    ) -> BTreeSet<CapabilityId> {
        if self.actions_paused {
            PermissionProfile::ReadOnly.capabilities()
        } else {
            global.allowed_capabilities()
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GrantDuration {
    Once,
    ThisRun,
    ThisSession,
    Global,
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
    pub fn validate_for(
        &self,
        global: &GlobalAgentPermissionSettings,
        pause: &WorkspaceAgentPause,
    ) -> Result<(), ContractValidationError> {
        global.validate()?;
        if !valid_identifier(&self.scope.workspace_id)
            || self.scope.workspace_id != pause.workspace_id
            || self.profile != pause.effective_profile(global)
            || self.scope.page_ids.as_ref().is_some_and(|page_ids| {
                page_ids.len() > DEFAULT_LIMITS.max_read_summaries as usize
                    || page_ids.iter().any(|id| !valid_identifier(id))
            })
            || self.granted_at_unix_ms > MAX_JSON_SAFE_REVISION as u64
            || !self
                .scope
                .capability_ids
                .is_subset(&pause.allowed_capabilities(global))
        {
            return Err(ContractValidationError::PermissionEscalation);
        }
        check_serialized_size(self, MAX_TOOL_INPUT_BYTES)
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
    pub normalized_endpoint_identity: String,
}
impl ProviderEndpointIdentity {
    pub fn validate(&self) -> Result<(), ContractValidationError> {
        if !valid_identifier(&self.provider_id)
            || self.display_name.trim().is_empty()
            || self.display_name.chars().count() > 120
            || self.normalized_endpoint_identity.len() > 2_048
        {
            return Err(ContractValidationError::InvalidProviderEndpoint);
        }
        let endpoint = url::Url::parse(&self.normalized_endpoint_identity)
            .map_err(|_| ContractValidationError::InvalidProviderEndpoint)?;
        if !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
            || endpoint.path() != "/"
        {
            return Err(ContractValidationError::InvalidProviderEndpoint);
        }
        let host = endpoint
            .host_str()
            .ok_or(ContractValidationError::InvalidProviderEndpoint)?;
        let expected = match self.transport {
            ProviderTransport::LocalHttp => {
                let loopback = host.eq_ignore_ascii_case("localhost")
                    || host
                        .parse::<std::net::IpAddr>()
                        .is_ok_and(|address| address.is_loopback());
                if endpoint.scheme() != "http" || !loopback {
                    return Err(ContractValidationError::InvalidProviderEndpoint);
                }
                endpoint.origin().ascii_serialization()
            }
            ProviderTransport::RemoteHttps => {
                if endpoint.scheme() != "https" {
                    return Err(ContractValidationError::InvalidProviderEndpoint);
                }
                endpoint.origin().ascii_serialization()
            }
            ProviderTransport::Process => {
                if endpoint.scheme() != "process" || endpoint.port().is_some() {
                    return Err(ContractValidationError::InvalidProviderEndpoint);
                }
                format!("process://{host}")
            }
        };
        if self.normalized_endpoint_identity != expected {
            return Err(ContractValidationError::InvalidProviderEndpoint);
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContentSharingScope {
    Selection,
    ActivePageScene,
    WorkspaceSearch,
    TrashMetadata,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderConsent {
    pub endpoint: ProviderEndpointIdentity,
    pub scopes: BTreeSet<ContentSharingScope>,
    pub accepted_at_unix_ms: u64,
    pub data_may_leave_device: bool,
}

impl ProviderConsent {
    pub fn validate(&self) -> Result<(), ContractValidationError> {
        self.endpoint.validate()?;
        if self.scopes.is_empty()
            || self.scopes.len() > 4
            || self.accepted_at_unix_ms > MAX_JSON_SAFE_REVISION as u64
            || (self.endpoint.transport == ProviderTransport::RemoteHttps
                && !self.data_may_leave_device)
        {
            return Err(ContractValidationError::InvalidProviderEndpoint);
        }
        Ok(())
    }

    pub fn permits(&self, endpoint: &ProviderEndpointIdentity, scope: ContentSharingScope) -> bool {
        self.validate().is_ok() && &self.endpoint == endpoint && self.scopes.contains(&scope)
    }
}

/// The bounded, provider-shareable context for one model turn. It deliberately
/// contains semantic descriptors rather than raw scene payloads, image bytes,
/// ink points, credentials, or reusable approvals.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentContextEnvelope {
    pub schema_version: String,
    pub workspace_id: String,
    pub workspace_revision: u64,
    pub active_page: Option<ActivePageContext>,
    pub selection: Vec<SelectedElementDescriptor>,
    pub viewport: Option<ViewportContext>,
}

impl AgentContextEnvelope {
    pub fn validate_bounds(&self) -> Result<(), ContractValidationError> {
        if self.schema_version != CAPABILITY_SCHEMA_VERSION {
            return Err(ContractValidationError::UnsupportedSchemaVersion(
                self.schema_version.clone(),
            ));
        }
        if !valid_identifier(&self.workspace_id)
            || self.workspace_revision > MAX_JSON_SAFE_REVISION as u64
            || self.selection.len() > DEFAULT_LIMITS.max_selected_descriptors as usize
            || self.active_page.as_ref().is_some_and(|page| {
                !valid_identifier(&page.page_id)
                    || page.title.chars().count() > 240
                    || page.page_revision > MAX_JSON_SAFE_REVISION as u64
            })
            || self.selection.iter().any(|descriptor| {
                !valid_identifier(&descriptor.element_id)
                    || descriptor.fingerprint.is_empty()
                    || descriptor.fingerprint.len() > 256
                    || descriptor.summary.chars().count() > 2_000
            })
            || self
                .viewport
                .as_ref()
                .is_some_and(|viewport| !viewport_is_valid(viewport))
        {
            return Err(ContractValidationError::ContextBoundsExceeded);
        }
        check_serialized_size(self, MAX_TOOL_INPUT_BYTES)?;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivePageContext {
    pub page_id: String,
    pub title: String,
    pub page_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectedElementDescriptor {
    pub element_id: String,
    pub kind: SemanticElementKind,
    pub summary: String,
    pub fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ViewportContext {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScreenshotToolResult {
    pub approval_artifact: ScreenshotApprovalArtifact,
    pub attachment_id: String,
    pub media_type: String,
    pub requires_approval: bool,
    pub persisted: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScreenshotApprovalArtifact {
    pub approval_id: String,
    pub attachment_id: String,
    pub run_id: String,
    pub tool_call_id: String,
    pub provider: ProviderEndpointIdentity,
    pub page_id: String,
    pub page_revision: u64,
    pub viewport: ViewportContext,
    pub scale: f64,
    pub issued_at_unix_ms: u64,
    pub expires_at_unix_ms: u64,
    pub single_use: bool,
}

impl ScreenshotApprovalArtifact {
    #[allow(clippy::too_many_arguments)]
    pub fn validate_for(
        &self,
        key: &ToolCallIdempotencyKey,
        provider: &ProviderEndpointIdentity,
        page_id: &str,
        page_revision: u64,
        viewport: &ViewportContext,
        scale: f64,
        attachment_id: &str,
        now_unix_ms: u64,
    ) -> Result<(), ContractValidationError> {
        key.validate()?;
        provider.validate()?;
        self.provider.validate()?;
        if !valid_identifier(&self.approval_id)
            || !valid_identifier(&self.attachment_id)
            || self.attachment_id != attachment_id
            || self.run_id != key.run_id
            || self.tool_call_id != key.tool_call_id
            || &self.provider != provider
            || self.page_id != page_id
            || !valid_identifier(page_id)
            || self.page_revision != page_revision
            || page_revision > MAX_JSON_SAFE_REVISION as u64
            || &self.viewport != viewport
            || self.scale != scale
            || !scale.is_finite()
            || !self.single_use
            || !(0.5..=2.0).contains(&self.scale)
            || self.page_revision > MAX_JSON_SAFE_REVISION as u64
            || self.issued_at_unix_ms > MAX_JSON_SAFE_REVISION as u64
            || self.expires_at_unix_ms > MAX_JSON_SAFE_REVISION as u64
            || self.expires_at_unix_ms <= self.issued_at_unix_ms
            || self.expires_at_unix_ms - self.issued_at_unix_ms
                > MAX_SCREENSHOT_APPROVAL_LIFETIME_MS
            || now_unix_ms > self.expires_at_unix_ms
            || !viewport_is_valid(&self.viewport)
        {
            return Err(ContractValidationError::InvalidScreenshotApproval);
        }
        check_serialized_size(self, MAX_TOOL_RESULT_BYTES)?;
        Ok(())
    }
}

/// Native hosts must compare and consume the complete stored approval in one
/// transaction. Missing, expired, mismatched, or previously consumed approvals
/// must fail; screenshot bytes must not be exposed before this call succeeds.
pub trait ScreenshotApprovalConsumer {
    fn consume_atomically(
        &mut self,
        expected: &ScreenshotApprovalArtifact,
    ) -> Result<(), ContractValidationError>;
}

pub fn validate_and_consume_screenshot_tool_result<C: ScreenshotApprovalConsumer>(
    value: &Value,
    expected: &ScreenshotApprovalArtifact,
    now_unix_ms: u64,
    consumer: &mut C,
) -> Result<ScreenshotToolResult, ContractValidationError> {
    validate_tool_result_schema(CapabilityId::CanvasRequestScreenshot, value)?;
    let result: ScreenshotToolResult = serde_json::from_value(value.clone())
        .map_err(|error| ContractValidationError::UnknownField(error.to_string()))?;
    let key = ToolCallIdempotencyKey {
        run_id: expected.run_id.clone(),
        tool_call_id: expected.tool_call_id.clone(),
    };
    expected.validate_for(
        &key,
        &expected.provider,
        &expected.page_id,
        expected.page_revision,
        &expected.viewport,
        expected.scale,
        &expected.attachment_id,
        now_unix_ms,
    )?;
    if result.approval_artifact != *expected
        || result.attachment_id != expected.attachment_id
        || result.attachment_id != result.approval_artifact.attachment_id
    {
        return Err(ContractValidationError::InvalidScreenshotApproval);
    }
    consumer.consume_atomically(expected)?;
    Ok(result)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SemanticElementKind {
    Text,
    Shape,
    Line,
    Connector,
    Image,
    Ink,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompletenessReason {
    Complete,
    ResultLimit,
    ScopeLimit,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompletenessMetadata {
    pub returned_count: u16,
    pub is_complete: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<CompletenessReason>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    tag = "scope",
    deny_unknown_fields
)]
pub enum SceneReadRequest {
    ActivePage {
        page_id: String,
    },
    Viewport {
        page_id: String,
        viewport: ViewportContext,
    },
    Selection {
        page_id: String,
        element_ids: Vec<String>,
    },
}
impl SceneReadRequest {
    pub fn validate(&self) -> Result<(), ContractValidationError> {
        let valid = match self {
            Self::ActivePage { page_id } => valid_identifier(page_id),
            Self::Viewport { page_id, viewport } => {
                valid_identifier(page_id) && viewport_is_valid(viewport)
            }
            Self::Selection {
                page_id,
                element_ids,
            } => {
                let unique: BTreeSet<_> = element_ids.iter().collect();
                valid_identifier(page_id)
                    && !element_ids.is_empty()
                    && element_ids.len() <= DEFAULT_LIMITS.max_selected_descriptors as usize
                    && unique.len() == element_ids.len()
                    && element_ids.iter().all(|id| valid_identifier(id))
            }
        };
        if !valid {
            return Err(ContractValidationError::ContextBoundsExceeded);
        }
        check_serialized_size(self, MAX_TOOL_INPUT_BYTES)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrashMetadataDescriptor {
    pub kind: ArchiveItemKind,
    pub id: String,
    pub name: String,
    pub trashed_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolCallIdempotencyKey {
    pub run_id: String,
    pub tool_call_id: String,
}

impl ToolCallIdempotencyKey {
    pub fn validate(&self) -> Result<(), ContractValidationError> {
        if self.run_id.is_empty()
            || self.run_id.len() > 128
            || self.tool_call_id.is_empty()
            || self.tool_call_id.len() > 128
        {
            return Err(ContractValidationError::InvalidIdempotencyKey);
        }
        Ok(())
    }
}

/// A change set is either a workspace transaction or one page-bound canvas
/// transaction. The tagged union prevents mixed workspace/canvas commits.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    tag = "kind",
    deny_unknown_fields
)]
pub enum WorkspaceChangeSet {
    Workspace {
        change_set_id: String,
        run_id: String,
        tool_call_id: String,
        workspace_id: String,
        expected_workspace_revision: u64,
        target_fingerprints: Vec<TargetFingerprint>,
        operations: Vec<WorkspaceOperation>,
    },
    Canvas {
        change_set_id: String,
        run_id: String,
        tool_call_id: String,
        page_id: String,
        expected_page_revision: u64,
        target_fingerprints: Vec<TargetFingerprint>,
        operations: Vec<SemanticCanvasOperation>,
    },
}
impl WorkspaceChangeSet {
    pub fn validate_bounds(&self) -> Result<(), ContractValidationError> {
        match self {
            Self::Workspace {
                change_set_id,
                run_id,
                tool_call_id,
                workspace_id,
                expected_workspace_revision,
                target_fingerprints,
                operations,
                ..
            } => {
                ToolCallIdempotencyKey {
                    run_id: run_id.clone(),
                    tool_call_id: tool_call_id.clone(),
                }
                .validate()?;
                if !valid_identifier(change_set_id)
                    || !valid_identifier(workspace_id)
                    || operations.is_empty()
                    || operations.len() > DEFAULT_LIMITS.max_workspace_items as usize
                    || operations
                        .iter()
                        .map(WorkspaceOperation::affected_item_count)
                        .sum::<usize>()
                        > DEFAULT_LIMITS.max_workspace_items as usize
                    || *expected_workspace_revision > MAX_JSON_SAFE_REVISION as u64
                    || target_fingerprints.len()
                        > DEFAULT_LIMITS.max_workspace_items as usize * 2 + 1
                    || !fingerprints_are_valid(target_fingerprints)
                    || target_fingerprints.iter().any(|fingerprint| {
                        fingerprint.resource_kind == ChangedResourceKind::CanvasElement
                    })
                    || !target_fingerprints.iter().any(|fingerprint| {
                        fingerprint.resource_kind == ChangedResourceKind::Workspace
                            && fingerprint.resource_id == *workspace_id
                            && fingerprint.expected_revision == *expected_workspace_revision
                    })
                {
                    return Err(ContractValidationError::InvalidWorkspaceChangeSet);
                }
                let required_targets: BTreeSet<_> = operations
                    .iter()
                    .flat_map(WorkspaceOperation::target_identities)
                    .chain([(ChangedResourceKind::Workspace, workspace_id.as_str())])
                    .collect();
                let provided_targets: BTreeSet<_> = target_fingerprints
                    .iter()
                    .map(|fingerprint| {
                        (fingerprint.resource_kind, fingerprint.resource_id.as_str())
                    })
                    .collect();
                if provided_targets != required_targets {
                    return Err(ContractValidationError::InvalidWorkspaceChangeSet);
                }
                for operation in operations {
                    let value = serde_json::to_value(operation)
                        .map_err(|error| violation("$", error.to_string()))?;
                    validate_json_schema(&workspace_operation_schema(), &value, "$.operations")?;
                }
            }
            Self::Canvas {
                change_set_id,
                run_id,
                tool_call_id,
                page_id,
                expected_page_revision,
                target_fingerprints,
                operations,
                ..
            } => {
                ToolCallIdempotencyKey {
                    run_id: run_id.clone(),
                    tool_call_id: tool_call_id.clone(),
                }
                .validate()?;
                if !valid_identifier(change_set_id)
                    || !valid_identifier(page_id)
                    || operations.is_empty()
                    || operations.len() > DEFAULT_LIMITS.max_operations_per_change_set as usize
                    || *expected_page_revision > MAX_JSON_SAFE_REVISION as u64
                    || !fingerprints_are_valid(target_fingerprints)
                {
                    return Err(ContractValidationError::InvalidCanvasChangeSet);
                }
                if !target_fingerprints.iter().any(|fingerprint| {
                    fingerprint.resource_kind == ChangedResourceKind::Page
                        && fingerprint.resource_id == *page_id
                        && fingerprint.expected_revision == *expected_page_revision
                }) || target_fingerprints.iter().any(|fingerprint| {
                    matches!(
                        fingerprint.resource_kind,
                        ChangedResourceKind::Workspace
                            | ChangedResourceKind::Folder
                            | ChangedResourceKind::ArchiveItem
                    ) || (fingerprint.resource_kind == ChangedResourceKind::Page
                        && fingerprint.resource_id != *page_id)
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
                if target_fingerprints.len() > DEFAULT_LIMITS.max_touched_elements as usize + 1 {
                    return Err(ContractValidationError::InvalidCanvasChangeSet);
                }
                let required_targets: BTreeSet<_> = operations
                    .iter()
                    .flat_map(SemanticCanvasOperation::existing_target_ids)
                    .collect();
                let provided_targets: BTreeSet<_> = target_fingerprints
                    .iter()
                    .filter(|fingerprint| {
                        fingerprint.resource_kind == ChangedResourceKind::CanvasElement
                    })
                    .map(|fingerprint| fingerprint.resource_id.as_str())
                    .collect();
                if provided_targets != required_targets {
                    return Err(ContractValidationError::InvalidCanvasChangeSet);
                }
                let value = serde_json::to_value(operations)
                    .map_err(|error| violation("$", error.to_string()))?;
                validate_json_schema(&semantic_operations_schema(), &value, "$.operations")?;
            }
        }
        check_serialized_size(self, MAX_TOOL_INPUT_BYTES)?;
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
fn fingerprints_are_valid(fingerprints: &[TargetFingerprint]) -> bool {
    let mut identities = BTreeSet::new();
    fingerprints.iter().all(|fingerprint| {
        valid_identifier(&fingerprint.resource_id)
            && !fingerprint.content_hash.is_empty()
            && fingerprint.content_hash.len() <= 256
            && fingerprint.expected_revision <= MAX_JSON_SAFE_REVISION as u64
            && identities.insert((fingerprint.resource_kind, fingerprint.resource_id.as_str()))
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangedResourceKind {
    Workspace,
    Folder,
    Page,
    CanvasElement,
    ArchiveItem,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    tag = "type",
    deny_unknown_fields
)]
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

impl WorkspaceOperation {
    fn affected_item_count(&self) -> usize {
        match self {
            Self::ArchiveItems { items } | Self::RestoreItems { items } => items.len(),
            _ => 1,
        }
    }

    fn target_identities(&self) -> Vec<(ChangedResourceKind, &str)> {
        match self {
            Self::CreateFolder { .. } => vec![],
            Self::RenameFolder { folder_id, .. } => {
                vec![(ChangedResourceKind::Folder, folder_id)]
            }
            Self::CreatePage { folder_id, .. } => {
                vec![(ChangedResourceKind::Folder, folder_id)]
            }
            Self::RenamePage { page_id, .. } | Self::BookmarkPage { page_id, .. } => {
                vec![(ChangedResourceKind::Page, page_id)]
            }
            Self::MovePage { page_id, folder_id } => vec![
                (ChangedResourceKind::Page, page_id),
                (ChangedResourceKind::Folder, folder_id),
            ],
            Self::ArchiveItems { items } | Self::RestoreItems { items } => items
                .iter()
                .map(|item| {
                    (
                        match item.kind {
                            ArchiveItemKind::Folder => ChangedResourceKind::Folder,
                            ArchiveItemKind::Page => ChangedResourceKind::Page,
                        },
                        item.id.as_str(),
                    )
                })
                .collect(),
        }
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    tag = "type",
    deny_unknown_fields
)]
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
        target_kind: CanvasMutableElementKind,
        width: f64,
        height: f64,
    },
    SetStyle {
        element_id: String,
        target_kind: CanvasMutableElementKind,
        style: CanvasStyle,
    },
    SetTextStyle {
        element_id: String,
        target_kind: CanvasBindableElementKind,
        style: TextStyle,
    },
    CreateConnector {
        element_id: String,
        start: ElementAnchor,
        end: ElementAnchor,
    },
    SetConnectorLabel {
        element_id: String,
        label: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        label_style: Option<TextStyle>,
    },
    SetArrowheads {
        element_id: String,
        start_arrowhead: Arrowhead,
        end_arrowhead: Arrowhead,
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
        #[serde(skip_serializing_if = "Option::is_none")]
        label_style: Option<TextStyle>,
    },
    SetShapeText {
        element_id: String,
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        text_style: Option<TextStyle>,
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
            | Self::SetTextStyle { element_id, .. }
            | Self::SetConnectorLabel { element_id, .. }
            | Self::SetArrowheads { element_id, .. }
            | Self::CreateLine { element_id, .. }
            | Self::SetShapeText { element_id, .. } => vec![element_id.as_str()],
        }
    }

    fn existing_target_ids(&self) -> Vec<&str> {
        match self {
            Self::CreateText { .. } | Self::CreateShape { .. } | Self::CreateLine { .. } => vec![],
            Self::CreateConnector { start, end, .. } | Self::CreateArrow { start, end, .. } => {
                vec![start.element_id.as_str(), end.element_id.as_str()]
            }
            Self::MoveElements { targets, .. }
            | Self::DuplicateElements { targets, .. }
            | Self::AlignElements { targets, .. }
            | Self::DistributeElements { targets, .. }
            | Self::ReorderElements { targets, .. } => targets
                .iter()
                .map(|target| target.element_id.as_str())
                .collect(),
            Self::ReplaceText { element_id, .. }
            | Self::ResizeElement { element_id, .. }
            | Self::SetStyle { element_id, .. }
            | Self::SetTextStyle { element_id, .. }
            | Self::SetConnectorLabel { element_id, .. }
            | Self::SetArrowheads { element_id, .. }
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
    #[serde(skip_serializing_if = "Option::is_none")]
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_size: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_weight: Option<FontWeight>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CanvasMutableElementKind {
    Text,
    Shape,
    Line,
    Connector,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ElementTarget {
    pub element_id: String,
    pub target_kind: CanvasMutableElementKind,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CanvasStyle {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stroke: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stroke_width: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
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
    pub run_id: String,
    pub tool_call_id: String,
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

    fn provider_identity() -> ProviderEndpointIdentity {
        ProviderEndpointIdentity {
            provider_id: "provider".into(),
            display_name: "Provider".into(),
            transport: ProviderTransport::RemoteHttps,
            normalized_endpoint_identity: "https://provider.example".into(),
        }
    }

    fn permission_context(
        profile: PermissionProfile,
        custom_capability_ids: BTreeSet<CapabilityId>,
    ) -> (GlobalAgentPermissionSettings, WorkspaceAgentPause) {
        (
            GlobalAgentPermissionSettings {
                default_profile: profile,
                custom_capability_ids,
            },
            WorkspaceAgentPause {
                workspace_id: "workspace".into(),
                actions_paused: false,
            },
        )
    }

    fn screenshot_artifact() -> ScreenshotApprovalArtifact {
        ScreenshotApprovalArtifact {
            approval_id: "approval".into(),
            attachment_id: "attachment".into(),
            run_id: "run".into(),
            tool_call_id: "call".into(),
            provider: provider_identity(),
            page_id: "page".into(),
            page_revision: 0,
            viewport: ViewportContext {
                x: 0.0,
                y: 0.0,
                width: 640.0,
                height: 480.0,
            },
            scale: 1.0,
            issued_at_unix_ms: 1_000,
            expires_at_unix_ms: 2_000,
            single_use: true,
        }
    }

    #[derive(Default)]
    struct OneShotScreenshotApprovals {
        consumed: BTreeSet<String>,
    }

    impl ScreenshotApprovalConsumer for OneShotScreenshotApprovals {
        fn consume_atomically(
            &mut self,
            expected: &ScreenshotApprovalArtifact,
        ) -> Result<(), ContractValidationError> {
            if self.consumed.insert(expected.approval_id.clone()) {
                Ok(())
            } else {
                Err(ContractValidationError::InvalidScreenshotApproval)
            }
        }
    }

    fn screenshot_result(artifact: &ScreenshotApprovalArtifact) -> Value {
        json!({
            "approvalArtifact": serde_json::to_value(artifact).unwrap(),
            "attachmentId": artifact.attachment_id,
            "mediaType": "image/png",
            "requiresApproval": true,
            "persisted": false
        })
    }

    fn context_envelope() -> AgentContextEnvelope {
        AgentContextEnvelope {
            schema_version: CAPABILITY_SCHEMA_VERSION.into(),
            workspace_id: "workspace".into(),
            workspace_revision: 0,
            active_page: Some(ActivePageContext {
                page_id: "page".into(),
                title: "Page".into(),
                page_revision: 0,
            }),
            selection: vec![],
            viewport: None,
        }
    }

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
    fn host_states_and_pause_policy_match_v1() {
        assert_eq!(
            DEFAULT_PERMISSION_PROFILE,
            PermissionProfile::AskBeforeChanges
        );
        assert_eq!(
            serde_json::to_value([
                AgentHostState::Idle,
                AgentHostState::Running,
                AgentHostState::AwaitingApproval,
                AgentHostState::Executing,
                AgentHostState::Completed,
                AgentHostState::Failed,
                AgentHostState::Cancelled,
            ])
            .unwrap(),
            json!([
                "idle",
                "running",
                "awaiting_approval",
                "executing",
                "completed",
                "failed",
                "cancelled"
            ])
        );
        let global = GlobalAgentPermissionSettings {
            default_profile: PermissionProfile::FullNoteAccess,
            custom_capability_ids: BTreeSet::new(),
        };
        let pause = WorkspaceAgentPause {
            workspace_id: "workspace".into(),
            actions_paused: true,
        };
        assert_eq!(
            pause.effective_profile(&global),
            PermissionProfile::ReadOnly
        );
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
        let receipt = json!({"receipt": serde_json::to_value(MutationReceipt { audit_id: "audit".into(), change_set_id: "change".into(), run_id: "run".into(), tool_call_id: "call".into(), changed_resources: vec![], workspace_revision: MAX_JSON_SAFE_REVISION as u64, page_revisions: BTreeMap::from([("page".into(), MAX_JSON_SAFE_REVISION as u64)]), inverse_change_set: BoundedInverseChangeSet { inverse_change_set_id: "undo".into(), changes: vec![InverseChange::RestoreResource { kind: ChangedResourceKind::Page, id: "page".into() }] } }).unwrap()});
        assert!(validate_tool_result(CapabilityId::WorkspaceCreatePage, &receipt).is_ok());
        let artifact = screenshot_artifact();
        let screenshot = screenshot_result(&artifact);
        assert_eq!(
            validate_tool_result(CapabilityId::CanvasRequestScreenshot, &screenshot),
            Err(ContractValidationError::InvalidScreenshotApproval)
        );
        let mut approvals = OneShotScreenshotApprovals::default();
        assert!(validate_and_consume_screenshot_tool_result(
            &screenshot,
            &artifact,
            1_500,
            &mut approvals,
        )
        .is_ok());
        let mut invalid_screenshot = screenshot_result(&artifact);
        invalid_screenshot["approvalArtifact"]["pageRevision"] = json!(MAX_JSON_SAFE_REVISION + 1);
        assert!(matches!(
            validate_and_consume_screenshot_tool_result(
                &invalid_screenshot,
                &artifact,
                1_500,
                &mut OneShotScreenshotApprovals::default(),
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
        let (global, pause) = permission_context(PermissionProfile::ReadOnly, BTreeSet::new());
        assert_eq!(
            grant.validate_for(&global, &pause),
            Err(ContractValidationError::PermissionEscalation)
        );
    }

    #[test]
    fn permission_grants_allow_registered_capabilities_within_profile() {
        let grant = PermissionGrant {
            profile: PermissionProfile::AskBeforeChanges,
            scope: PermissionScope {
                workspace_id: "workspace".into(),
                page_ids: Some(BTreeSet::from(["page".into()])),
                capability_ids: BTreeSet::from([
                    CapabilityId::CanvasReadScene,
                    CapabilityId::CanvasApplyOperations,
                ]),
            },
            duration: GrantDuration::ThisRun,
            granted_at_unix_ms: 0,
        };
        let (global, pause) =
            permission_context(PermissionProfile::AskBeforeChanges, BTreeSet::new());
        assert!(grant.validate_for(&global, &pause).is_ok());
        assert_eq!(
            PermissionProfile::AskBeforeChanges.mutation_approval_policy(),
            MutationApprovalPolicy::EveryChange
        );
        assert_eq!(
            PermissionProfile::FullNoteAccess.mutation_approval_policy(),
            MutationApprovalPolicy::Automatic
        );
    }

    #[test]
    fn custom_permission_grants_are_limited_to_saved_allowlist() {
        let (global, pause) = permission_context(
            PermissionProfile::Custom,
            BTreeSet::from([CapabilityId::CanvasReadScene]),
        );
        let grant = |capability_id| PermissionGrant {
            profile: PermissionProfile::Custom,
            scope: PermissionScope {
                workspace_id: "workspace".into(),
                page_ids: None,
                capability_ids: BTreeSet::from([capability_id]),
            },
            duration: GrantDuration::ThisSession,
            granted_at_unix_ms: 0,
        };
        assert!(grant(CapabilityId::CanvasReadScene)
            .validate_for(&global, &pause)
            .is_ok());
        assert_eq!(
            grant(CapabilityId::CanvasApplyOperations).validate_for(&global, &pause),
            Err(ContractValidationError::PermissionEscalation)
        );
    }

    #[test]
    fn provider_consent_is_bound_to_endpoint_identity_and_scope() {
        let endpoint = ProviderEndpointIdentity {
            provider_id: "provider".into(),
            display_name: "Provider".into(),
            transport: ProviderTransport::RemoteHttps,
            normalized_endpoint_identity: "https://provider.example".into(),
        };
        let consent = ProviderConsent {
            endpoint: endpoint.clone(),
            scopes: BTreeSet::from([ContentSharingScope::ActivePageScene]),
            accepted_at_unix_ms: 0,
            data_may_leave_device: true,
        };
        assert!(consent.permits(&endpoint, ContentSharingScope::ActivePageScene));
        assert!(!consent.permits(&endpoint, ContentSharingScope::WorkspaceSearch));
        assert!(!consent.permits(
            &ProviderEndpointIdentity {
                normalized_endpoint_identity: "https://other.example".into(),
                ..endpoint
            },
            ContentSharingScope::ActivePageScene
        ));
    }

    #[test]
    fn provider_endpoints_reject_credentials_and_noncanonical_origins() {
        assert!(provider_identity().validate().is_ok());
        for invalid in [
            "https://user:secret@provider.example",
            "https://provider.example/path",
            "https://provider.example?token=secret",
            "https://PROVIDER.example",
        ] {
            assert_eq!(
                ProviderEndpointIdentity {
                    normalized_endpoint_identity: invalid.into(),
                    ..provider_identity()
                }
                .validate(),
                Err(ContractValidationError::InvalidProviderEndpoint)
            );
        }
        assert_eq!(
            ProviderEndpointIdentity {
                transport: ProviderTransport::LocalHttp,
                normalized_endpoint_identity: "http://example.com".into(),
                ..provider_identity()
            }
            .validate(),
            Err(ContractValidationError::InvalidProviderEndpoint)
        );
    }

    #[test]
    fn screenshot_approval_is_expiring_single_use_and_request_bound() {
        let artifact = screenshot_artifact();
        let key = ToolCallIdempotencyKey {
            run_id: "run".into(),
            tool_call_id: "call".into(),
        };
        assert!(artifact
            .validate_for(
                &key,
                &provider_identity(),
                "page",
                0,
                &artifact.viewport,
                1.0,
                "attachment",
                1_500,
            )
            .is_ok());
        assert_eq!(
            artifact.validate_for(
                &key,
                &provider_identity(),
                "other-page",
                0,
                &artifact.viewport,
                1.0,
                "attachment",
                1_500,
            ),
            Err(ContractValidationError::InvalidScreenshotApproval)
        );
        assert_eq!(
            artifact.validate_for(
                &key,
                &provider_identity(),
                "page",
                0,
                &artifact.viewport,
                1.0,
                "attachment",
                2_001,
            ),
            Err(ContractValidationError::InvalidScreenshotApproval)
        );
    }

    #[test]
    fn screenshot_result_rejects_attachment_swaps_and_consumes_once() {
        let artifact = screenshot_artifact();
        let mut swapped = screenshot_result(&artifact);
        swapped["attachmentId"] = json!("other-attachment");
        let mut approvals = OneShotScreenshotApprovals::default();
        assert_eq!(
            validate_and_consume_screenshot_tool_result(&swapped, &artifact, 1_500, &mut approvals,),
            Err(ContractValidationError::InvalidScreenshotApproval)
        );
        assert!(approvals.consumed.is_empty());

        let mut fully_swapped = screenshot_result(&artifact);
        fully_swapped["attachmentId"] = json!("other-attachment");
        fully_swapped["approvalArtifact"]["attachmentId"] = json!("other-attachment");
        assert_eq!(
            validate_and_consume_screenshot_tool_result(
                &fully_swapped,
                &artifact,
                1_500,
                &mut approvals,
            ),
            Err(ContractValidationError::InvalidScreenshotApproval)
        );
        assert!(approvals.consumed.is_empty());

        let result = screenshot_result(&artifact);
        assert!(validate_and_consume_screenshot_tool_result(
            &result,
            &artifact,
            1_500,
            &mut approvals,
        )
        .is_ok());
        assert_eq!(
            validate_and_consume_screenshot_tool_result(&result, &artifact, 1_500, &mut approvals,),
            Err(ContractValidationError::InvalidScreenshotApproval)
        );
    }

    #[test]
    fn restore_invocation_uses_typed_items_and_workspace_revision() {
        let invocation = ToolInvocation {
            run_id: "run".into(),
            tool_call_id: "call".into(),
            provider: provider_identity(),
            capability_id: CapabilityId::WorkspaceRestoreItems,
            schema_version: CAPABILITY_SCHEMA_VERSION.into(),
            asserted_risk: CapabilityRisk::Destructive,
            input: json!({
                "items":[{"kind":"page", "id":"page"}],
                "expectedWorkspaceRevision":7
            }),
        };
        assert!(validate_tool_invocation(&invocation).is_ok());
    }

    #[test]
    fn style_dtos_round_trip_through_semantic_operation_schema() {
        let operations = vec![
            SemanticCanvasOperation::CreateLine {
                element_id: "line".into(),
                start_x: 0.0,
                start_y: 0.0,
                end_x: 10.0,
                end_y: 10.0,
                style: LineStyle {
                    stroke: "#000".into(),
                    stroke_width: 1.0,
                    dash: None,
                },
            },
            SemanticCanvasOperation::SetStyle {
                element_id: "shape".into(),
                target_kind: CanvasMutableElementKind::Shape,
                style: CanvasStyle {
                    fill: Some("#fff".into()),
                    stroke: None,
                    stroke_width: None,
                    opacity: None,
                },
            },
            SemanticCanvasOperation::SetShapeText {
                element_id: "shape".into(),
                text: "label".into(),
                text_style: Some(TextStyle {
                    font_size: None,
                    font_weight: None,
                    color: Some("#000".into()),
                    alignment: None,
                }),
            },
            SemanticCanvasOperation::SetConnectorLabel {
                element_id: "connector".into(),
                label: "label".into(),
                label_style: None,
            },
            SemanticCanvasOperation::SetTextStyle {
                element_id: "text".into(),
                target_kind: CanvasBindableElementKind::Text,
                style: TextStyle {
                    font_size: Some(16),
                    font_weight: None,
                    color: None,
                    alignment: None,
                },
            },
        ];
        let value = serde_json::to_value(&operations).unwrap();
        assert!(validate_json_schema(&semantic_operations_schema(), &value, "$").is_ok());
        assert_eq!(
            serde_json::from_value::<Vec<SemanticCanvasOperation>>(value).unwrap(),
            operations
        );
    }

    #[test]
    fn inverse_workspace_operation_round_trips_through_receipt_schema() {
        let inverse = BoundedInverseChangeSet {
            inverse_change_set_id: "inverse".into(),
            changes: vec![InverseChange::ReapplyWorkspaceOperation {
                operation: WorkspaceOperation::RestoreItems {
                    items: vec![ArchiveItemTarget {
                        kind: ArchiveItemKind::Page,
                        id: "page".into(),
                    }],
                },
            }],
        };
        let value = serde_json::to_value(&inverse).unwrap();
        assert!(validate_json_schema(&inverse_change_set_schema(), &value, "$").is_ok());
        assert_eq!(
            serde_json::from_value::<BoundedInverseChangeSet>(value).unwrap(),
            inverse
        );
    }

    #[test]
    fn invocation_validation_fails_closed() {
        let valid = ToolInvocation {
            run_id: "run".into(),
            tool_call_id: "call".into(),
            provider: provider_identity(),
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
    fn read_contracts_are_bounded_complete_and_trash_metadata_only() {
        let manifest = canonical_manifest();
        let list = manifest
            .capabilities
            .iter()
            .find(|contract| contract.id == CapabilityId::WorkspaceListStructure)
            .unwrap();
        assert!(validate_json_schema(
            &list.input_schema,
            &json!({"includeTrashMetadata":true}),
            "$"
        )
        .is_ok());
        let trash_schema = &list.output_schema["properties"]["trashMetadata"]["items"];
        assert!(trash_schema["properties"].get("content").is_none());
        assert!(trash_schema["properties"].get("scene").is_none());

        let scene = manifest
            .capabilities
            .iter()
            .find(|contract| contract.id == CapabilityId::CanvasReadScene)
            .unwrap();
        for request in [
            SceneReadRequest::ActivePage {
                page_id: "page".into(),
            },
            SceneReadRequest::Viewport {
                page_id: "page".into(),
                viewport: ViewportContext {
                    x: 0.0,
                    y: 0.0,
                    width: 100.0,
                    height: 100.0,
                },
            },
            SceneReadRequest::Selection {
                page_id: "page".into(),
                element_ids: vec!["element".into()],
            },
        ] {
            let value = serde_json::to_value(request).unwrap();
            assert!(validate_json_schema(&scene.input_schema, &value, "$").is_ok());
        }
        assert!(
            scene.output_schema["properties"]["elements"]["items"]["properties"]
                .get("dataBase64")
                .is_none()
        );
        assert!(
            scene.output_schema["properties"]["elements"]["items"]["properties"]
                .get("points")
                .is_none()
        );
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
            run_id: "run".into(),
            tool_call_id: "call".into(),
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
            run_id: "run".into(),
            tool_call_id: "call".into(),
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

    #[test]
    fn change_sets_require_exact_fingerprints_and_canonical_operation_bounds() {
        let workspace = |target_fingerprints, operations| WorkspaceChangeSet::Workspace {
            change_set_id: "change".into(),
            run_id: "run".into(),
            tool_call_id: "call".into(),
            workspace_id: "workspace".into(),
            expected_workspace_revision: 4,
            target_fingerprints,
            operations,
        };
        let workspace_fingerprint = TargetFingerprint {
            resource_kind: ChangedResourceKind::Workspace,
            resource_id: "workspace".into(),
            expected_revision: 4,
            content_hash: "workspace-fingerprint".into(),
        };
        assert!(workspace(
            vec![workspace_fingerprint.clone()],
            vec![WorkspaceOperation::CreateFolder {
                folder_id: "folder".into(),
                name: "Folder".into(),
            }],
        )
        .validate_bounds()
        .is_ok());
        assert_eq!(
            workspace(
                vec![],
                vec![WorkspaceOperation::CreateFolder {
                    folder_id: "folder".into(),
                    name: "Folder".into(),
                }],
            )
            .validate_bounds(),
            Err(ContractValidationError::InvalidWorkspaceChangeSet)
        );
        assert!(matches!(
            workspace(
                vec![workspace_fingerprint],
                vec![WorkspaceOperation::CreateFolder {
                    folder_id: "folder".into(),
                    name: String::new(),
                }],
            )
            .validate_bounds(),
            Err(ContractValidationError::SchemaViolation { .. })
        ));

        let missing_element_fingerprint = WorkspaceChangeSet::Canvas {
            change_set_id: "change".into(),
            run_id: "run".into(),
            tool_call_id: "call".into(),
            page_id: "page".into(),
            expected_page_revision: 0,
            target_fingerprints: vec![TargetFingerprint {
                resource_kind: ChangedResourceKind::Page,
                resource_id: "page".into(),
                expected_revision: 0,
                content_hash: "page-fingerprint".into(),
            }],
            operations: vec![SemanticCanvasOperation::ReplaceText {
                element_id: "text".into(),
                text: "updated".into(),
            }],
        };
        assert_eq!(
            missing_element_fingerprint.validate_bounds(),
            Err(ContractValidationError::InvalidCanvasChangeSet)
        );
    }

    #[test]
    fn v1_detailed_touched_and_created_boundaries_are_enforced() {
        let detailed_ids: Vec<_> = (0..DEFAULT_LIMITS.max_detailed_elements)
            .map(|index| format!("element-{index}"))
            .collect();
        let detailed = ToolInvocation {
            run_id: "run".into(),
            tool_call_id: "call".into(),
            provider: provider_identity(),
            capability_id: CapabilityId::CanvasReadElements,
            schema_version: CAPABILITY_SCHEMA_VERSION.into(),
            asserted_risk: CapabilityRisk::Read,
            input: json!({"pageId":"page", "elementIds":detailed_ids}),
        };
        assert!(validate_tool_invocation(&detailed).is_ok());
        let mut too_many_detailed = detailed;
        too_many_detailed.input["elementIds"]
            .as_array_mut()
            .unwrap()
            .push(json!("element-over"));
        assert!(validate_tool_invocation(&too_many_detailed).is_err());

        let targets = |count: usize| {
            (0..count)
                .map(|index| ElementTarget {
                    element_id: format!("element-{index}"),
                    target_kind: CanvasMutableElementKind::Shape,
                })
                .collect::<Vec<_>>()
        };
        let canvas = |operations: Vec<SemanticCanvasOperation>| {
            let mut target_fingerprints = vec![TargetFingerprint {
                resource_kind: ChangedResourceKind::Page,
                resource_id: "page".into(),
                expected_revision: 0,
                content_hash: "page-fingerprint".into(),
            }];
            target_fingerprints.extend(
                operations
                    .iter()
                    .flat_map(SemanticCanvasOperation::existing_target_ids)
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .map(|element_id| TargetFingerprint {
                        resource_kind: ChangedResourceKind::CanvasElement,
                        resource_id: element_id.into(),
                        expected_revision: 0,
                        content_hash: format!("fingerprint-{element_id}"),
                    }),
            );
            WorkspaceChangeSet::Canvas {
                change_set_id: "change".into(),
                run_id: "run".into(),
                tool_call_id: "call".into(),
                page_id: "page".into(),
                expected_page_revision: 0,
                target_fingerprints,
                operations,
            }
        };

        assert!(canvas(vec![SemanticCanvasOperation::MoveElements {
            targets: targets(DEFAULT_LIMITS.max_touched_elements as usize),
            delta_x: 1.0,
            delta_y: 1.0,
        }])
        .validate_bounds()
        .is_ok());
        assert_eq!(
            canvas(vec![SemanticCanvasOperation::MoveElements {
                targets: targets(DEFAULT_LIMITS.max_touched_elements as usize + 1),
                delta_x: 1.0,
                delta_y: 1.0,
            }])
            .validate_bounds(),
            Err(ContractValidationError::CanvasBudgetExceeded)
        );

        let creates = |count: usize| {
            (0..count)
                .map(|index| SemanticCanvasOperation::CreateText {
                    element_id: format!("created-{index}"),
                    text: String::new(),
                    x: index as f64,
                    y: 0.0,
                })
                .collect::<Vec<_>>()
        };
        assert!(
            canvas(creates(DEFAULT_LIMITS.max_created_elements as usize))
                .validate_bounds()
                .is_ok()
        );
        assert_eq!(
            canvas(creates(DEFAULT_LIMITS.max_created_elements as usize + 1)).validate_bounds(),
            Err(ContractValidationError::CanvasBudgetExceeded)
        );
    }

    #[test]
    fn context_and_idempotency_keys_are_bounded() {
        let descriptor = |index| SelectedElementDescriptor {
            element_id: format!("element-{index}"),
            kind: SemanticElementKind::Shape,
            summary: "shape".into(),
            fingerprint: format!("fingerprint-{index}"),
        };
        let mut context = AgentContextEnvelope {
            schema_version: CAPABILITY_SCHEMA_VERSION.into(),
            workspace_id: "workspace".into(),
            workspace_revision: 0,
            active_page: None,
            selection: (0..DEFAULT_LIMITS.max_selected_descriptors)
                .map(descriptor)
                .collect(),
            viewport: None,
        };
        assert!(context.validate_bounds().is_ok());
        context.selection.push(descriptor(255));
        assert_eq!(
            context.validate_bounds(),
            Err(ContractValidationError::ContextBoundsExceeded)
        );
        assert_eq!(
            ToolCallIdempotencyKey {
                run_id: "run".into(),
                tool_call_id: String::new(),
            }
            .validate(),
            Err(ContractValidationError::InvalidIdempotencyKey)
        );
    }

    #[test]
    fn adapter_dtos_bound_identifiers_vectors_values_and_total_bytes() {
        let descriptor = AgentDescriptor {
            agent_id: "agent".into(),
            display_name: "Agent".into(),
            capabilities: vec![CapabilityId::WorkspaceSearch],
        };
        assert!(validate_agent_descriptors(&[descriptor.clone()]).is_ok());
        let mut duplicate_capabilities = descriptor.clone();
        duplicate_capabilities
            .capabilities
            .push(CapabilityId::WorkspaceSearch);
        assert_eq!(
            duplicate_capabilities.validate(),
            Err(ContractValidationError::AdapterBoundsExceeded)
        );
        assert_eq!(
            validate_agent_descriptors(&vec![descriptor; MAX_AGENT_DESCRIPTORS + 1]),
            Err(ContractValidationError::AdapterBoundsExceeded)
        );

        let continue_request = ContinueRunRequest {
            run_id: "run".into(),
            response: json!("x".repeat(MAX_TOOL_RESULT_BYTES as usize)),
            context: context_envelope(),
            permission_grant: PermissionGrant {
                profile: PermissionProfile::ReadOnly,
                scope: PermissionScope {
                    workspace_id: "workspace".into(),
                    page_ids: None,
                    capability_ids: BTreeSet::from([CapabilityId::WorkspaceSearch]),
                },
                duration: GrantDuration::ThisRun,
                granted_at_unix_ms: 0,
            },
        };
        assert!(matches!(
            continue_request.validate(),
            Err(ContractValidationError::PayloadTooLarge { .. })
        ));

        let start_request = StartRunRequest {
            agent_id: "agent".into(),
            prompt: "x".repeat(MAX_AGENT_PROMPT_BYTES + 1),
            context: context_envelope(),
            permission_grant: continue_request.permission_grant,
            provider_consent: ProviderConsent {
                endpoint: provider_identity(),
                scopes: BTreeSet::from([ContentSharingScope::ActivePageScene]),
                accepted_at_unix_ms: 0,
                data_may_leave_device: true,
            },
        };
        assert_eq!(
            start_request.validate(),
            Err(ContractValidationError::AdapterBoundsExceeded)
        );
    }
}
