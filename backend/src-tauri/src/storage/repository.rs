use super::{assets, database, legacy_import, models::*};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde_json::Value;
use std::{io::Write, path::Path};

/// These folders are real rows solely to satisfy the page foreign key. They
/// are not user folders and are filtered from the workspace DTO.
pub const ROOT_FOLDER_ID: &str = "";
pub const TEMPLATE_FOLDER_ID: &str = "__note_page_templates__";
const MAX_INK_POINTS: usize = 20_000;
const MAX_INK_PAYLOAD_BYTES: usize = 8 * 1024 * 1024;
const MAX_INK_LOCAL_COORDINATE: f64 = 1_000_000.0;
const MAX_INK_BRUSH_SIZE: f64 = 512.0;
const MAX_SCENE_BATCH_BYTES: usize = 32 * 1024 * 1024;
const MAX_SCENE_BATCH_UPSERTS: usize = 5_000;
const MAX_SCENE_BATCH_DELETES: usize = 20_000;

struct PayloadLimitWriter {
    bytes_written: usize,
    exceeded: bool,
    limit: usize,
}

impl Write for PayloadLimitWriter {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        if buffer.len() > self.limit.saturating_sub(self.bytes_written) {
            self.exceeded = true;
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "ink payload size limit exceeded",
            ));
        }
        self.bytes_written += buffer.len();
        Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn required_string<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| format!("element.{key} must be a non-empty string"))
}
fn finite(value: &Value, key: &str) -> Result<Option<f64>, String> {
    match value.get(key) {
        None => Ok(None),
        Some(v) => v
            .as_f64()
            .filter(|n| n.is_finite())
            .map(Some)
            .ok_or_else(|| format!("element.{key} must be finite")),
    }
}

fn required_finite(value: &Value, key: &str, context: &str) -> Result<f64, String> {
    value
        .get(key)
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
        .ok_or_else(|| format!("{context}.{key} must be a finite number"))
}

fn required_finite_object(
    value: &serde_json::Map<String, Value>,
    key: &str,
    context: &str,
) -> Result<f64, String> {
    value
        .get(key)
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
        .ok_or_else(|| format!("{context}.{key} must be a finite number"))
}

fn validate_ink_color(color: &Value) -> Result<(), String> {
    let color = color
        .as_object()
        .ok_or("ink brush.color must be an object")?;
    match color.get("kind").and_then(Value::as_str) {
        Some("theme") => match color.get("token").and_then(Value::as_str) {
            Some("foreground" | "muted") => Ok(()),
            _ => Err("ink theme color token must be foreground or muted".into()),
        },
        Some("fixed") => {
            let value = color
                .get("value")
                .and_then(Value::as_str)
                .ok_or("ink fixed color.value must be a string")?;
            if matches!(value.len(), 7 | 9)
                && value.starts_with('#')
                && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                Ok(())
            } else {
                Err("ink fixed color must use #RRGGBB or #RRGGBBAA".into())
            }
        }
        _ => Err("ink brush.color kind must be theme or fixed".into()),
    }
}

fn validate_ink_element(value: &Value) -> Result<(), String> {
    let points = value
        .get("points")
        .and_then(Value::as_array)
        .ok_or("ink element.points must be an array")?;
    if points.is_empty() {
        return Err("ink element.points must contain at least one point".into());
    }
    if points.len() > MAX_INK_POINTS {
        return Err(format!(
            "ink element.points exceeds the {MAX_INK_POINTS} point limit"
        ));
    }
    let width = required_finite(value, "width", "ink element")?;
    let height = required_finite(value, "height", "ink element")?;
    for (index, point) in points.iter().enumerate() {
        let tuple = point
            .as_array()
            .filter(|tuple| tuple.len() == 3)
            .ok_or_else(|| format!("ink point {index} must be exactly [x, y, pressure]"))?;
        let coordinate = |position: usize, name: &str| {
            tuple[position]
                .as_f64()
                .filter(|number| number.is_finite())
                .ok_or_else(|| format!("ink point {index} {name} must be finite"))
        };
        let x = coordinate(0, "x")?;
        let y = coordinate(1, "y")?;
        let pressure = coordinate(2, "pressure")?;
        if !(0.0..=width.min(MAX_INK_LOCAL_COORDINATE)).contains(&x)
            || !(0.0..=height.min(MAX_INK_LOCAL_COORDINATE)).contains(&y)
        {
            return Err(format!(
                "ink point {index} coordinates must be local to the element and no greater than {MAX_INK_LOCAL_COORDINATE}"
            ));
        }
        if !(0.0..=1.0).contains(&pressure) {
            return Err(format!(
                "ink point {index} pressure must be between 0 and 1"
            ));
        }
    }

    let brush = value
        .get("brush")
        .and_then(Value::as_object)
        .ok_or("ink element.brush must be an object")?;
    if !matches!(
        brush.get("kind").and_then(Value::as_str),
        Some("pen" | "highlighter")
    ) {
        return Err("ink brush.kind must be pen or highlighter".into());
    }
    validate_ink_color(brush.get("color").ok_or("ink brush.color is required")?)?;
    let size = required_finite_object(brush, "size", "ink brush")?;
    if !(0.0 < size && size <= MAX_INK_BRUSH_SIZE) {
        return Err(format!(
            "ink brush.size must be greater than 0 and at most {MAX_INK_BRUSH_SIZE}"
        ));
    }
    for key in ["opacity", "smoothing", "streamline"] {
        let setting = required_finite_object(brush, key, "ink brush")?;
        if !(0.0..=1.0).contains(&setting) {
            return Err(format!("ink brush.{key} must be between 0 and 1"));
        }
    }
    let thinning = required_finite_object(brush, "thinning", "ink brush")?;
    if !(-1.0..=1.0).contains(&thinning) {
        return Err("ink brush.thinning must be between -1 and 1".into());
    }
    if brush
        .get("simulatePressure")
        .and_then(Value::as_bool)
        .is_none()
    {
        return Err("ink brush.simulatePressure must be boolean".into());
    }

    let mut writer = PayloadLimitWriter {
        bytes_written: 0,
        exceeded: false,
        limit: MAX_INK_PAYLOAD_BYTES,
    };
    if let Err(error) = serde_json::to_writer(&mut writer, value) {
        if writer.exceeded {
            return Err(format!(
                "ink element payload exceeds the {MAX_INK_PAYLOAD_BYTES} byte limit"
            ));
        }
        return Err(format!("ink element payload cannot be serialized: {error}"));
    }
    Ok(())
}

fn validate_primitive_style(value: &Value, context: &str) -> Result<(), String> {
    let Some(style) = value.get("style") else {
        return Ok(());
    };
    let style = style
        .as_object()
        .ok_or_else(|| format!("{context}.style must be an object"))?;
    if let Some(fill_color) = style.get("fillColor") {
        if !fill_color.is_null() {
            validate_ink_color(fill_color)?;
        }
    }
    if let Some(stroke_color) = style.get("strokeColor") {
        validate_ink_color(stroke_color)?;
    }
    for (key, min, max) in [
        ("roughness", 0.0, 10.0),
        ("roundness", 0.0, 1.0),
        ("strokeWidth", 0.0, 512.0),
    ] {
        if let Some(number) = style.get(key) {
            let number = number
                .as_f64()
                .filter(|number| number.is_finite())
                .ok_or_else(|| format!("{context}.style.{key} must be finite"))?;
            if !(min..=max).contains(&number) || (key == "strokeWidth" && number == 0.0) {
                return Err(format!("{context}.style.{key} is out of range"));
            }
        }
    }
    if let Some(seed) = style.get("seed") {
        if seed
            .as_u64()
            .filter(|seed| *seed <= u32::MAX as u64)
            .is_none()
        {
            return Err(format!(
                "{context}.style.seed must be an unsigned 32-bit integer"
            ));
        }
    }
    if let Some(stroke_style) = style.get("strokeStyle") {
        if !matches!(stroke_style.as_str(), Some("solid" | "dashed" | "dotted")) {
            return Err(format!("{context}.style.strokeStyle is invalid"));
        }
    }
    Ok(())
}

fn validate_connector_endpoint(value: &Value, context: &str) -> Result<(), String> {
    let endpoint = value
        .as_object()
        .ok_or_else(|| format!("{context} must be an object"))?;
    match endpoint.get("kind").and_then(Value::as_str) {
        Some("free") => {
            required_finite_object(endpoint, "x", context)?;
            required_finite_object(endpoint, "y", context)?;
        }
        Some(kind @ ("element" | "group" | "connector")) => {
            let (target, position) = match kind {
                "element" => ("targetElementId", "anchor"),
                "group" => ("targetGroupId", "anchor"),
                _ => ("targetConnectorId", "pathT"),
            };
            endpoint
                .get(target)
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| format!("{context}.{target} must be a non-empty string"))?;
            let t = if position == "anchor" {
                endpoint
                    .get("anchor")
                    .and_then(Value::as_object)
                    .and_then(|anchor| anchor.get("t"))
            } else {
                endpoint.get("pathT")
            };
            if t.and_then(Value::as_f64)
                .filter(|t| t.is_finite() && (0.0..=1.0).contains(t))
                .is_none()
            {
                return Err(format!("{context}.{position} must be within 0 and 1"));
            }
            if required_finite_object(endpoint, "gap", context)? < 0.0 {
                return Err(format!("{context}.gap cannot be negative"));
            }
        }
        _ => return Err(format!("{context}.kind is invalid")),
    }
    Ok(())
}

fn validate_scene_batch(batch: &SceneChangeBatch) -> Result<(), String> {
    if batch.upserts.len() > MAX_SCENE_BATCH_UPSERTS {
        return Err(format!(
            "scene batch exceeds the {MAX_SCENE_BATCH_UPSERTS} upsert limit"
        ));
    }
    if batch.deleted_element_ids.len() > MAX_SCENE_BATCH_DELETES {
        return Err(format!(
            "scene batch exceeds the {MAX_SCENE_BATCH_DELETES} delete limit"
        ));
    }
    if batch.deleted_element_ids.iter().any(|id| id.is_empty()) {
        return Err("deleted element IDs must be non-empty".into());
    }
    let mut writer = PayloadLimitWriter {
        bytes_written: 0,
        exceeded: false,
        limit: MAX_SCENE_BATCH_BYTES,
    };
    for element in &batch.upserts {
        validate_element(element, &batch.page_id)?;
        if let Err(error) = serde_json::to_writer(&mut writer, element) {
            if writer.exceeded {
                return Err(format!(
                    "scene batch payload exceeds the {MAX_SCENE_BATCH_BYTES} byte limit"
                ));
            }
            return Err(format!("scene batch element cannot be serialized: {error}"));
        }
    }
    Ok(())
}
fn validate_element(value: &Value, page_id: &str) -> Result<(), String> {
    if !value.is_object() {
        return Err("element must be a JSON object".into());
    }
    required_string(value, "id")?;
    if required_string(value, "pageId")? != page_id {
        return Err("element pageId does not match batch pageId".into());
    }
    let kind = required_string(value, "type")?;
    if !matches!(kind, "text" | "image" | "ink" | "shape" | "connector") {
        return Err(format!("unsupported element type: {kind}"));
    }
    let opacity = finite(value, "opacity")?.ok_or("element.opacity is required")?;
    if !(0.0..=1.0).contains(&opacity) {
        return Err("element.opacity must be between 0 and 1".into());
    }
    for key in ["x", "y", "width", "height", "rotation"] {
        let v = finite(value, key)?;
        if matches!(key, "width" | "height") && v.is_some_and(|n| n < 0.0) {
            return Err(format!("element.{key} cannot be negative"));
        }
    }
    for key in ["zIndex", "createdAt", "updatedAt"] {
        if value.get(key).and_then(Value::as_i64).is_none()
            && value
                .get(key)
                .and_then(Value::as_u64)
                .filter(|n| *n <= i64::MAX as u64)
                .is_none()
        {
            return Err(format!("element.{key} must be an integer"));
        }
    }
    if value.get("locked").and_then(Value::as_bool).is_none() {
        return Err("element.locked must be boolean".into());
    }
    if kind != "connector"
        && ["x", "y", "width", "height", "rotation"]
            .iter()
            .any(|k| value.get(*k).is_none())
    {
        return Err("box element geometry is incomplete".into());
    }
    match kind {
        "text" if value.get("content").and_then(Value::as_str).is_none() => {
            return Err("text element.content must be a string".into())
        }
        "image"
            if value
                .get("assetId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .is_none() =>
        {
            return Err("image element.assetId must be a non-empty string".into())
        }
        "ink" => validate_ink_element(value)?,
        "shape" => {
            if !matches!(
                value.get("shape").and_then(Value::as_str),
                Some("rectangle" | "ellipse" | "diamond")
            ) {
                return Err("shape element.shape is invalid".into());
            }
            validate_primitive_style(value, "shape")?;
        }
        "connector" => {
            validate_connector_endpoint(
                value.get("start").ok_or("connector.start is required")?,
                "connector.start",
            )?;
            validate_connector_endpoint(
                value.get("end").ok_or("connector.end is required")?,
                "connector.end",
            )?;
            if let Some(routing) = value.get("routing") {
                if routing.as_str() != Some("straight") {
                    return Err("connector.routing must be straight".into());
                }
            }
            validate_primitive_style(value, "connector")?;
            if let Some(style) = value.get("style").and_then(Value::as_object) {
                for key in ["startArrowhead", "endArrowhead"] {
                    if let Some(arrow) = style.get(key) {
                        if !matches!(arrow.as_str(), Some("none" | "arrow")) {
                            return Err(format!("connector.style.{key} is invalid"));
                        }
                    }
                }
            }
        }
        _ => {}
    }
    Ok(())
}
fn number_i64(v: &Value, key: &str) -> i64 {
    v.get(key)
        .and_then(Value::as_i64)
        .or_else(|| v.get(key).and_then(Value::as_u64).map(|n| n as i64))
        .unwrap()
}

pub fn initialize_storage_at(root: &Path) -> Result<StorageDiagnostics, String> {
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let db = root.join("note.db");
    let mut c = database::open(&db)?;
    let version = database::migrate(&mut c)?;
    let import = legacy_import::import_if_needed(
        &mut c,
        &root.join("note-data.json"),
        &root.join("backups"),
        &root.join("assets"),
    )?;
    Ok(StorageDiagnostics {
        database_path: db.to_string_lossy().into_owned(),
        schema_version: version,
        imported_legacy_data: import.imported,
        backup_path: import.backup_path.map(|p| p.to_string_lossy().into_owned()),
        warnings: import.warnings,
    })
}
pub fn load_workspace_data_at(root: &Path) -> Result<WorkspaceData, String> {
    let mut c = database::open(&root.join("note.db"))?;
    database::migrate(&mut c)?;
    let folders = {
        let mut s = c
            .prepare("SELECT id,name FROM folders WHERE id NOT IN (?,?) ORDER BY rowid")
            .map_err(|e| e.to_string())?;
        let rows = s
            .query_map(params![ROOT_FOLDER_ID, TEMPLATE_FOLDER_ID], |r| {
                Ok(FolderDto {
                    id: r.get(0)?,
                    name: r.get(1)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    let pages = {
        let mut s = c
            .prepare("SELECT id,folder_id,title,is_bookmarked,revision FROM pages ORDER BY rowid")
            .map_err(|e| e.to_string())?;
        let rows = s
            .query_map([], |r| {
                Ok(PageDto {
                    id: r.get(0)?,
                    folder_id: r.get(1)?,
                    title: r.get(2)?,
                    is_bookmarked: r.get::<_, i64>(3)? != 0,
                    revision: r.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    let elements = {
        let mut s = c
            .prepare("SELECT payload_json FROM elements ORDER BY page_id,z_index,id")
            .map_err(|e| e.to_string())?;
        let rows = s
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .map(|v| {
                serde_json::from_str(&v.map_err(|e| e.to_string())?)
                    .map_err(|e| format!("corrupt element payload: {e}"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    let theme: Option<String> = c
        .query_row("SELECT theme FROM app_settings WHERE id=1", [], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    let session: Option<String> = c
        .query_row("SELECT state_json FROM session_state WHERE id=1", [], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(WorkspaceData {
        folders,
        pages,
        elements,
        is_dark_mode: theme.map(|v| v == "dark"),
        session_state: session
            .map(|v| serde_json::from_str(&v).map_err(|e| format!("corrupt session state: {e}")))
            .transpose()?,
        warnings: Vec::new(),
    })
}

fn validate_workspace_structure(structure: &WorkspaceStructure) -> Result<(), String> {
    let mut folder_ids = std::collections::HashSet::new();
    for folder in &structure.folders {
        if folder.id.trim().is_empty() {
            return Err("folder.id must be a non-empty string".into());
        }
        if matches!(folder.id.as_str(), ROOT_FOLDER_ID | TEMPLATE_FOLDER_ID) {
            return Err(format!("folder.id {} is reserved", folder.id));
        }
        if folder.name.trim().is_empty() {
            return Err("folder.name must be a non-empty string".into());
        }
        if !folder_ids.insert(folder.id.as_str()) {
            return Err(format!("duplicate folder id: {}", folder.id));
        }
    }

    let mut page_ids = std::collections::HashSet::new();
    for page in &structure.pages {
        if page.id.trim().is_empty() {
            return Err("page.id must be a non-empty string".into());
        }
        if page.title.trim().is_empty() {
            return Err("page.title must be a non-empty string".into());
        }
        if !page_ids.insert(page.id.as_str()) {
            return Err(format!("duplicate page id: {}", page.id));
        }
        if !matches!(page.folder_id.as_str(), ROOT_FOLDER_ID | TEMPLATE_FOLDER_ID)
            && !folder_ids.contains(page.folder_id.as_str())
        {
            return Err(format!(
                "page {} references missing folder {}",
                page.id, page.folder_id
            ));
        }
    }
    Ok(())
}

/// Reconciles user-visible folders and pages in a single transaction. Scene
/// rows are intentionally not accepted here: callers flush the corresponding
/// page queues before issuing a potentially destructive structure update.
pub fn reconcile_workspace_structure_at(
    root: &Path,
    structure: WorkspaceStructure,
) -> Result<WorkspaceStructureResult, String> {
    validate_workspace_structure(&structure)?;
    let mut connection = database::open(&root.join("note.db"))?;
    database::migrate(&mut connection)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;

    transaction
        .execute(
            "INSERT INTO folders(id,name) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name",
            params![ROOT_FOLDER_ID, "Root"],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO folders(id,name) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name",
            params![TEMPLATE_FOLDER_ID, "Templates"],
        )
        .map_err(|error| error.to_string())?;
    for folder in &structure.folders {
        transaction
            .execute(
                "INSERT INTO folders(id,name) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name",
                params![folder.id, folder.name.trim()],
            )
            .map_err(|error| format!("save folder {}: {error}", folder.id))?;
    }

    let desired_page_ids: std::collections::HashSet<&str> = structure
        .pages
        .iter()
        .map(|page| page.id.as_str())
        .collect();
    let existing_page_ids = {
        let mut statement = transaction
            .prepare("SELECT id FROM pages")
            .map_err(|error| error.to_string())?;
        let page_ids = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        page_ids
    };
    for page_id in existing_page_ids {
        if !desired_page_ids.contains(page_id.as_str()) {
            transaction
                .execute("DELETE FROM pages WHERE id=?", [page_id])
                .map_err(|error| error.to_string())?;
        }
    }
    for page in &structure.pages {
        transaction
            .execute(
                "INSERT INTO pages(id,folder_id,title,is_bookmarked) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET folder_id=excluded.folder_id,title=excluded.title,is_bookmarked=excluded.is_bookmarked",
                params![page.id, page.folder_id, page.title.trim(), page.is_bookmarked as i64],
            )
            .map_err(|error| format!("save page {}: {error}", page.id))?;
    }

    let desired_folder_ids: std::collections::HashSet<&str> = structure
        .folders
        .iter()
        .map(|folder| folder.id.as_str())
        .chain([ROOT_FOLDER_ID, TEMPLATE_FOLDER_ID])
        .collect();
    let existing_folder_ids = {
        let mut statement = transaction
            .prepare("SELECT id FROM folders")
            .map_err(|error| error.to_string())?;
        let folder_ids = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        folder_ids
    };
    for folder_id in existing_folder_ids {
        if !desired_folder_ids.contains(folder_id.as_str()) {
            transaction
                .execute("DELETE FROM folders WHERE id=?", [folder_id])
                .map_err(|error| error.to_string())?;
        }
    }
    if let Some(is_dark_mode) = structure.is_dark_mode {
        transaction
            .execute(
                "INSERT INTO app_settings(id,theme) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET theme=excluded.theme",
                [if is_dark_mode { "dark" } else { "light" }],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;

    let pages = load_workspace_data_at(root)?.pages;
    Ok(WorkspaceStructureResult { pages })
}
pub fn apply_scene_changes_at(
    root: &Path,
    batch: SceneChangeBatch,
) -> Result<SceneChangeResult, String> {
    if batch.page_id.is_empty() || batch.base_revision < 0 {
        return Err("invalid pageId or baseRevision".into());
    }
    validate_scene_batch(&batch)?;
    let mut c = database::open(&root.join("note.db"))?;
    database::migrate(&mut c)?;
    let tx = c
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let revision: Option<i64> = tx
        .query_row(
            "SELECT revision FROM pages WHERE id=?",
            [&batch.page_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let revision = revision.ok_or_else(|| format!("page not found: {}", batch.page_id))?;
    if revision != batch.base_revision {
        return Err(format!(
            "revision conflict: expected {revision}, received {}",
            batch.base_revision
        ));
    }
    for id in &batch.deleted_element_ids {
        tx.execute(
            "DELETE FROM elements WHERE id=? AND page_id=?",
            params![id, batch.page_id],
        )
        .map_err(|e| e.to_string())?;
    }
    for e in &batch.upserts {
        let json = serde_json::to_string(e).map_err(|e| e.to_string())?;
        let kind = required_string(e, "type")?;
        if kind == "image" {
            assets::validate_reference(&tx, &root.join("assets"), required_string(e, "assetId")?)?;
        }
        let locked = e["locked"].as_bool().unwrap() as i64;
        let existing_page: Option<String> = tx
            .query_row(
                "SELECT page_id FROM elements WHERE id=?",
                [required_string(e, "id")?],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if existing_page
            .as_deref()
            .is_some_and(|id| id != batch.page_id)
        {
            return Err(format!(
                "element {} already belongs to another page",
                required_string(e, "id")?
            ));
        }
        tx.execute("INSERT INTO elements(id,page_id,element_type,x,y,width,height,rotation,z_index,opacity,locked,group_id,created_at,updated_at,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET page_id=excluded.page_id,element_type=excluded.element_type,x=excluded.x,y=excluded.y,width=excluded.width,height=excluded.height,rotation=excluded.rotation,z_index=excluded.z_index,opacity=excluded.opacity,locked=excluded.locked,group_id=excluded.group_id,updated_at=excluded.updated_at,payload_json=excluded.payload_json",params![required_string(e,"id")?,batch.page_id,kind,finite(e,"x")?,finite(e,"y")?,finite(e,"width")?,finite(e,"height")?,finite(e,"rotation")?,number_i64(e,"zIndex"),e["opacity"].as_f64(),locked,e.get("groupId").and_then(Value::as_str),number_i64(e,"createdAt"),number_i64(e,"updatedAt"),json]).map_err(|er|format!("upsert element: {er}"))?;
    }
    let next = revision + 1;
    tx.execute(
        "UPDATE pages SET revision=? WHERE id=?",
        params![next, batch.page_id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(SceneChangeResult {
        page_id: batch.page_id,
        new_revision: next,
    })
}
fn validate_session_state(state: &Value) -> Result<(), String> {
    let session = state.as_object().ok_or("session state must be an object")?;
    if let Some(locked) = session.get("isDrawingToolLocked") {
        if !locked.is_boolean() {
            return Err("session state.isDrawingToolLocked must be boolean".into());
        }
    }
    let Some(preferences) = session.get("drawingPreferences") else {
        return Ok(());
    };
    let preferences = preferences
        .as_object()
        .ok_or("session state.drawingPreferences must be an object")?;
    for tool in [
        "pen",
        "highlighter",
        "rectangle",
        "ellipse",
        "diamond",
        "line",
        "arrow",
    ] {
        let context = format!("session state.drawingPreferences.{tool}");
        let preference = preferences
            .get(tool)
            .and_then(Value::as_object)
            .ok_or_else(|| format!("{context} must be an object"))?;
        validate_ink_color(
            preference
                .get("strokeColor")
                .ok_or_else(|| format!("{context}.strokeColor is required"))?,
        )?;
        if let Some(background) = preference.get("backgroundColor") {
            if !background.is_null() {
                validate_ink_color(background)?;
            }
        } else {
            return Err(format!("{context}.backgroundColor is required"));
        }
        for (key, minimum, maximum, allow_zero) in [
            ("opacity", 0.0, 1.0, true),
            ("roughness", 0.0, 10.0, true),
            ("roundness", 0.0, 1.0, true),
            ("strokeWidth", 0.0, 512.0, false),
        ] {
            let number = preference
                .get(key)
                .and_then(Value::as_f64)
                .filter(|number| number.is_finite())
                .ok_or_else(|| format!("{context}.{key} must be finite"))?;
            if !(minimum..=maximum).contains(&number) || (!allow_zero && number == 0.0) {
                return Err(format!("{context}.{key} is out of range"));
            }
        }
        if !matches!(
            preference.get("strokeStyle").and_then(Value::as_str),
            Some("solid" | "dashed" | "dotted")
        ) {
            return Err(format!("{context}.strokeStyle is invalid"));
        }
    }
    Ok(())
}

pub fn save_session_state_at(root: &Path, state: Value) -> Result<(), String> {
    validate_session_state(&state)?;
    let mut c = database::open(&root.join("note.db"))?;
    database::migrate(&mut c)?;
    c.execute("INSERT INTO session_state(id,state_json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json",[serde_json::to_string(&state).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
    Ok(())
}
pub fn save_asset_at(root: &Path, request: SaveAssetRequest) -> Result<AssetDto, String> {
    let mut c = database::open(&root.join("note.db"))?;
    database::migrate(&mut c)?;
    assets::save(&c, &root.join("assets"), request)
}
pub fn load_asset_at(root: &Path, id: &str) -> Result<AssetDto, String> {
    let mut c = database::open(&root.join("note.db"))?;
    database::migrate(&mut c)?;
    assets::load(&c, &root.join("assets"), id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use serde_json::json;
    use std::fs;
    use tempfile::TempDir;

    fn root() -> TempDir {
        tempfile::tempdir().unwrap()
    }
    fn seed_page(root: &Path) {
        initialize_storage_at(root).unwrap();
        let connection = database::open(&root.join("note.db")).unwrap();
        connection
            .execute("INSERT INTO folders(id,name) VALUES('f','Folder')", [])
            .unwrap();
        connection
            .execute(
                "INSERT INTO pages(id,folder_id,title) VALUES('p','f','Page')",
                [],
            )
            .unwrap();
    }
    fn element(id: &str, updated_at: i64) -> Value {
        json!({"id":id,"pageId":"p","type":"text","x":1.0,"y":2.0,"width":100.0,"height":40.0,"rotation":0.0,"zIndex":0,"opacity":1.0,"locked":false,"createdAt":1,"updatedAt":updated_at,"content":"hello"})
    }
    fn image_element(id: &str, asset_id: &str) -> Value {
        json!({"id":id,"pageId":"p","type":"image","x":1.0,"y":2.0,"width":100.0,"height":40.0,"rotation":0.0,"zIndex":0,"opacity":1.0,"locked":false,"createdAt":1,"updatedAt":1,"assetId":asset_id,"naturalWidth":100,"naturalHeight":40,"fit":"contain"})
    }
    fn ink_element() -> Value {
        json!({
            "id":"ink-1","pageId":"p","type":"ink","x":1.0,"y":2.0,
            "width":100.0,"height":40.0,"rotation":0.0,"zIndex":0,
            "opacity":1.0,"locked":false,"createdAt":1,"updatedAt":1,
            "points":[[2.0,3.0,0.5],[98.0,38.0,1.0]],
            "brush":{
                "kind":"pen","color":{"kind":"theme","token":"foreground"},
                "size":4.0,"opacity":1.0,"thinning":0.45,"smoothing":0.5,
                "streamline":0.45,"simulatePressure":true
            }
        })
    }
    fn assert_ink_rejected_without_revision_change(root: &Path, ink: Value, message: &str) {
        let error = apply_scene_changes_at(
            root,
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 0,
                upserts: vec![ink],
                deleted_element_ids: vec![],
            },
        )
        .unwrap_err();
        assert!(
            error.contains(message),
            "unexpected validation error: {error}"
        );
        assert_eq!(load_workspace_data_at(root).unwrap().pages[0].revision, 0);
    }

    fn drawing_preferences() -> Value {
        let preference = json!({
            "backgroundColor":null,
            "opacity":1.0,
            "roughness":1.2,
            "roundness":0.0,
            "strokeColor":{"kind":"theme","token":"foreground"},
            "strokeStyle":"solid",
            "strokeWidth":2.0
        });
        json!({
            "pen":preference.clone(),
            "highlighter":preference.clone(),
            "rectangle":preference.clone(),
            "ellipse":preference.clone(),
            "diamond":preference.clone(),
            "line":preference.clone(),
            "arrow":preference
        })
    }

    #[test]
    fn session_drawing_preferences_require_valid_typed_values() {
        assert!(validate_session_state(&json!({
            "isDrawingToolLocked":true,
            "drawingPreferences":drawing_preferences()
        }))
        .is_ok());

        let mut invalid = drawing_preferences();
        invalid["pen"]["strokeWidth"] = json!(0);
        let error = validate_session_state(&json!({"drawingPreferences":invalid})).unwrap_err();
        assert!(error.contains("pen.strokeWidth"));
        assert!(
            validate_session_state(&json!({"isDrawingToolLocked":"yes"}))
                .unwrap_err()
                .contains("must be boolean")
        );
    }

    #[test]
    fn primitive_payloads_validate_new_fields_and_preserve_legacy_payloads() {
        let directory = root();
        seed_page(directory.path());
        let legacy_shape = json!({"id":"shape","pageId":"p","type":"shape","x":0.0,"y":0.0,"width":10.0,"height":10.0,"rotation":0.0,"zIndex":0,"opacity":1.0,"locked":false,"createdAt":1,"updatedAt":1,"shape":"rectangle"});
        apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 0,
                upserts: vec![legacy_shape],
                deleted_element_ids: vec![],
            },
        )
        .unwrap();
        let invalid = json!({"id":"bad","pageId":"p","type":"shape","x":0.0,"y":0.0,"width":10.0,"height":10.0,"rotation":0.0,"zIndex":1,"opacity":1.0,"locked":false,"createdAt":1,"updatedAt":1,"shape":"rectangle","style":{"strokeStyle":"zigzag","seed":-1,"roughness":-1,"roundness":2,"strokeWidth":0}});
        let error = apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 1,
                upserts: vec![invalid],
                deleted_element_ids: vec![],
            },
        )
        .unwrap_err();
        assert!(error.contains("roughness"));
        assert_eq!(
            load_workspace_data_at(directory.path()).unwrap().pages[0].revision,
            1
        );
    }

    #[test]
    fn primitive_colors_allow_legacy_omission_and_nullable_fill_but_reject_null_stroke() {
        let directory = root();
        seed_page(directory.path());
        let legacy_shape = json!({"id":"legacy","pageId":"p","type":"shape","x":0.0,"y":0.0,"width":10.0,"height":10.0,"rotation":0.0,"zIndex":0,"opacity":1.0,"locked":false,"createdAt":1,"updatedAt":1,"shape":"rectangle"});
        let transparent_shape = json!({"id":"transparent","pageId":"p","type":"shape","x":20.0,"y":0.0,"width":10.0,"height":10.0,"rotation":0.0,"zIndex":1,"opacity":1.0,"locked":false,"createdAt":1,"updatedAt":1,"shape":"rectangle","style":{"fillColor":null,"strokeColor":{"kind":"theme","token":"foreground"}}});
        apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 0,
                upserts: vec![legacy_shape, transparent_shape],
                deleted_element_ids: vec![],
            },
        )
        .unwrap();

        let null_stroke = json!({"id":"null-stroke","pageId":"p","type":"shape","x":40.0,"y":0.0,"width":10.0,"height":10.0,"rotation":0.0,"zIndex":2,"opacity":1.0,"locked":false,"createdAt":1,"updatedAt":1,"shape":"rectangle","style":{"strokeColor":null}});
        let error = apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 1,
                upserts: vec![null_stroke],
                deleted_element_ids: vec![],
            },
        )
        .unwrap_err();
        assert!(error.contains("ink brush.color must be an object"));
        assert_eq!(
            load_workspace_data_at(directory.path()).unwrap().pages[0].revision,
            1
        );
    }

    #[test]
    fn empty_initialization_and_migration_are_idempotent() {
        let directory = root();
        let first = initialize_storage_at(directory.path()).unwrap();
        let second = initialize_storage_at(directory.path()).unwrap();
        assert_eq!(first.schema_version, database::SCHEMA_VERSION);
        assert!(!first.imported_legacy_data);
        assert_eq!(first.schema_version, second.schema_version);
        assert!(directory.path().join("note.db").exists());
    }

    #[test]
    fn scene_batch_insert_update_delete_and_revision_conflict() {
        let directory = root();
        seed_page(directory.path());
        assert_eq!(
            apply_scene_changes_at(
                directory.path(),
                SceneChangeBatch {
                    page_id: "p".into(),
                    base_revision: 0,
                    upserts: vec![element("e", 1)],
                    deleted_element_ids: vec![]
                }
            )
            .unwrap()
            .new_revision,
            1
        );
        let conflict = apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 0,
                upserts: vec![],
                deleted_element_ids: vec![],
            },
        )
        .unwrap_err();
        assert!(conflict.contains("revision conflict"));
        apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 1,
                upserts: vec![element("e", 2)],
                deleted_element_ids: vec![],
            },
        )
        .unwrap();
        apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 2,
                upserts: vec![],
                deleted_element_ids: vec!["e".into()],
            },
        )
        .unwrap();
        assert!(load_workspace_data_at(directory.path())
            .unwrap()
            .elements
            .is_empty());
    }

    #[test]
    fn corrupt_batch_is_rejected_before_revision_changes() {
        let directory = root();
        seed_page(directory.path());
        let mut bad = element("e", 1);
        bad["opacity"] = json!(2.0);
        assert!(apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 0,
                upserts: vec![bad],
                deleted_element_ids: vec![]
            }
        )
        .is_err());
        assert_eq!(
            load_workspace_data_at(directory.path()).unwrap().pages[0].revision,
            0
        );
    }

    #[test]
    fn valid_phase_four_ink_is_persisted() {
        let directory = root();
        seed_page(directory.path());
        let result = apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 0,
                upserts: vec![ink_element()],
                deleted_element_ids: vec![],
            },
        )
        .unwrap();
        assert_eq!(result.new_revision, 1);
        assert_eq!(
            load_workspace_data_at(directory.path())
                .unwrap()
                .elements
                .len(),
            1
        );
    }

    #[test]
    fn ink_without_brush_is_rejected_atomically() {
        let directory = root();
        seed_page(directory.path());
        let mut ink = ink_element();
        ink.as_object_mut().unwrap().remove("brush");
        assert_ink_rejected_without_revision_change(
            directory.path(),
            ink,
            "brush must be an object",
        );
    }

    #[test]
    fn malformed_ink_tuple_and_pressure_are_rejected_atomically() {
        let directory = root();
        seed_page(directory.path());
        let mut malformed = ink_element();
        malformed["points"] = json!([[1.0, 2.0]]);
        assert_ink_rejected_without_revision_change(
            directory.path(),
            malformed,
            "exactly [x, y, pressure]",
        );

        let mut bad_pressure = ink_element();
        bad_pressure["points"] = json!([[1.0, 2.0, 1.1]]);
        assert_ink_rejected_without_revision_change(
            directory.path(),
            bad_pressure,
            "pressure must be between 0 and 1",
        );
    }

    #[test]
    fn excessive_ink_points_and_payload_are_rejected_atomically() {
        let directory = root();
        seed_page(directory.path());
        let mut too_many = ink_element();
        too_many["points"] = Value::Array(
            (0..=MAX_INK_POINTS)
                .map(|_| json!([1.0, 1.0, 0.5]))
                .collect(),
        );
        assert_ink_rejected_without_revision_change(directory.path(), too_many, "point limit");

        let mut oversized = ink_element();
        oversized["padding"] = Value::String("x".repeat(MAX_INK_PAYLOAD_BYTES));
        assert_ink_rejected_without_revision_change(directory.path(), oversized, "payload exceeds");
    }

    #[test]
    fn excessive_scene_batch_count_and_bytes_are_rejected_atomically() {
        let directory = root();
        seed_page(directory.path());
        let too_many = vec![element("duplicate-is-not-reached", 1); MAX_SCENE_BATCH_UPSERTS + 1];
        let count_error = apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 0,
                upserts: too_many,
                deleted_element_ids: vec![],
            },
        )
        .unwrap_err();
        assert!(count_error.contains("upsert limit"));
        assert_eq!(
            load_workspace_data_at(directory.path()).unwrap().pages[0].revision,
            0
        );

        let mut first = element("large-1", 1);
        first["content"] = Value::String("x".repeat(17 * 1024 * 1024));
        let mut second = element("large-2", 1);
        second["content"] = Value::String("x".repeat(17 * 1024 * 1024));
        let byte_error = apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 0,
                upserts: vec![first, second],
                deleted_element_ids: vec![],
            },
        )
        .unwrap_err();
        assert!(byte_error.contains("batch payload exceeds"));
        assert_eq!(
            load_workspace_data_at(directory.path()).unwrap().pages[0].revision,
            0
        );
    }

    #[test]
    fn invalid_ink_color_and_brush_ranges_are_rejected_atomically() {
        let directory = root();
        seed_page(directory.path());
        let mut bad_color = ink_element();
        bad_color["brush"]["color"] = json!({"kind":"fixed","value":"red"});
        assert_ink_rejected_without_revision_change(directory.path(), bad_color, "#RRGGBB");

        for (key, value, message) in [
            ("size", json!(513.0), "size must be"),
            ("opacity", json!(-0.1), "opacity must be between"),
            ("thinning", json!(1.1), "thinning must be between"),
            ("smoothing", json!(1.1), "smoothing must be between"),
            ("streamline", json!(1.1), "streamline must be between"),
            (
                "simulatePressure",
                json!("yes"),
                "simulatePressure must be boolean",
            ),
        ] {
            let mut invalid = ink_element();
            invalid["brush"][key] = value;
            assert_ink_rejected_without_revision_change(directory.path(), invalid, message);
        }
    }

    #[test]
    fn deleting_page_cascades_elements() {
        let directory = root();
        seed_page(directory.path());
        apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 0,
                upserts: vec![element("e", 1)],
                deleted_element_ids: vec![],
            },
        )
        .unwrap();
        let connection = database::open(&directory.path().join("note.db")).unwrap();
        connection
            .execute("DELETE FROM pages WHERE id='p'", [])
            .unwrap();
        let count: i64 = connection
            .query_row("SELECT count(*) FROM elements", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn asset_write_and_read_round_trip() {
        let directory = root();
        initialize_storage_at(directory.path()).unwrap();
        let bytes = b"png bytes";
        let saved = save_asset_at(
            directory.path(),
            SaveAssetRequest {
                data_base64: STANDARD.encode(bytes),
                media_type: "image/png".into(),
                file_name: Some("../../unsafe.png".into()),
                natural_width: Some(2),
                natural_height: Some(3),
            },
        )
        .unwrap();
        let loaded = load_asset_at(directory.path(), &saved.id).unwrap();
        assert_eq!(STANDARD.decode(loaded.data_base64.unwrap()).unwrap(), bytes);
        assert!(!directory.path().join("unsafe.png").exists());
    }

    #[test]
    fn asset_decode_enforces_encoded_and_decoded_boundaries() {
        let at_limit = vec![7_u8; assets::MAX_ASSET_BYTES];
        assert_eq!(
            assets::decode_base64_limited(&STANDARD.encode(&at_limit))
                .unwrap()
                .len(),
            assets::MAX_ASSET_BYTES
        );

        let encoded_limit = assets::MAX_ASSET_BYTES.div_ceil(3) * 4;
        let encoded_too_large = "A".repeat(encoded_limit + 1);
        assert!(assets::decode_base64_limited(&encoded_too_large)
            .unwrap_err()
            .contains("maximum encoded size"));

        let decoded_too_large = vec![7_u8; assets::MAX_ASSET_BYTES + 1];
        assert!(
            assets::decode_base64_limited(&STANDARD.encode(decoded_too_large))
                .unwrap_err()
                .contains("maximum decoded size")
        );
    }

    #[test]
    fn image_batch_rejects_missing_asset_without_revision_advance() {
        let directory = root();
        seed_page(directory.path());
        let error = apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 0,
                upserts: vec![image_element("image", "missing")],
                deleted_element_ids: vec![],
            },
        )
        .unwrap_err();
        assert!(error.contains("image asset not found"));
        assert_eq!(
            load_workspace_data_at(directory.path()).unwrap().pages[0].revision,
            0
        );
    }

    #[test]
    fn image_batch_rejects_asset_row_without_managed_file() {
        let directory = root();
        seed_page(directory.path());
        let connection = database::open(&directory.path().join("note.db")).unwrap();
        connection.execute("INSERT INTO assets(id,relative_path,file_name,media_type,byte_size,created_at) VALUES('missing-file','missing.png','missing.png','image/png',1,1)", []).unwrap();
        drop(connection);

        let error = apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 0,
                upserts: vec![image_element("image", "missing-file")],
                deleted_element_ids: vec![],
            },
        )
        .unwrap_err();
        assert!(error.contains("file is unavailable"));
        assert_eq!(
            load_workspace_data_at(directory.path()).unwrap().pages[0].revision,
            0
        );
    }

    #[test]
    fn legacy_import_creates_backup_preserves_mixed_content_and_is_idempotent() {
        let directory = root();
        let legacy = json!({"folders":[{"id":"f","name":"F"}],"pages":[{"id":"p","folderId":"f","title":"P"}],"blocks":[{"id":"b","pageId":"p","x":1,"y":2,"width":3,"height":4,"content":"text","richContent":{"type":"doc","content":[{"type":"paragraph"}]},"imageData":format!("data:image/png;base64,{}",STANDARD.encode(b"image")),"imageName":"x.png"}],"isDarkMode":true,"sessionState":{"selectedPageId":"p","pageViewports":{"p":{"panOffset":{"x":1,"y":2},"zoomLevel":1.5}}}});
        let path = directory.path().join("note-data.json");
        fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();
        let original = fs::read(&path).unwrap();
        let first = initialize_storage_at(directory.path()).unwrap();
        assert!(first.imported_legacy_data);
        assert_eq!(first.warnings.len(), 1);
        assert_eq!(fs::read(&path).unwrap(), original);
        assert!(std::path::Path::new(&first.backup_path.unwrap()).exists());
        let loaded = load_workspace_data_at(directory.path()).unwrap();
        assert_eq!(loaded.elements.len(), 2);
        assert_eq!(
            loaded.elements[0]["richContent"],
            legacy["blocks"][0]["richContent"]
        );
        let second = initialize_storage_at(directory.path()).unwrap();
        assert!(!second.imported_legacy_data);
        assert_eq!(
            load_workspace_data_at(directory.path())
                .unwrap()
                .elements
                .len(),
            2
        );
    }

    #[test]
    fn malformed_legacy_rolls_back_and_preserves_original() {
        let directory = root();
        let raw=br#"{"folders":[{"id":"f","name":"F"}],"pages":[{"id":"p","folderId":"missing","title":"P"}],"blocks":[]}"#;
        let path = directory.path().join("note-data.json");
        fs::write(&path, raw).unwrap();
        assert!(initialize_storage_at(directory.path()).is_err());
        assert_eq!(fs::read(path).unwrap(), raw);
        let connection = database::open(&directory.path().join("note.db")).unwrap();
        let count: i64 = connection
            .query_row("SELECT count(*) FROM folders", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn mixed_legacy_image_id_avoids_later_original_block_id() {
        let directory = root();
        let legacy = json!({
            "folders":[{"id":"f","name":"F"}],
            "pages":[{"id":"p","folderId":"f","title":"P"}],
            "blocks":[
                {"id":"b","pageId":"p","x":0,"y":0,"width":10,"height":10,"content":"text","imageData":format!("data:image/png;base64,{}",STANDARD.encode(b"image"))},
                {"id":"b-image","pageId":"p","x":20,"y":20,"width":10,"height":10,"content":"later block"}
            ]
        });
        fs::write(
            directory.path().join("note-data.json"),
            serde_json::to_vec(&legacy).unwrap(),
        )
        .unwrap();

        initialize_storage_at(directory.path()).unwrap();
        let ids = load_workspace_data_at(directory.path())
            .unwrap()
            .elements
            .into_iter()
            .map(|element| element["id"].as_str().unwrap().to_owned())
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(ids.len(), 3);
        assert!(ids.contains("b"));
        assert!(ids.contains("b-image"));
        assert!(ids.contains("b-image-2"));
    }

    #[test]
    fn workspace_structure_keeps_hidden_root_and_template_folders() {
        let directory = root();
        initialize_storage_at(directory.path()).unwrap();
        let result = reconcile_workspace_structure_at(
            directory.path(),
            WorkspaceStructure {
                folders: vec![FolderDto {
                    id: "projects".into(),
                    name: "Projects".into(),
                }],
                pages: vec![
                    WorkspacePageDto {
                        id: "root-page".into(),
                        folder_id: ROOT_FOLDER_ID.into(),
                        title: "Root".into(),
                        is_bookmarked: false,
                    },
                    WorkspacePageDto {
                        id: "template-page".into(),
                        folder_id: TEMPLATE_FOLDER_ID.into(),
                        title: "Template".into(),
                        is_bookmarked: true,
                    },
                    WorkspacePageDto {
                        id: "project-page".into(),
                        folder_id: "projects".into(),
                        title: "Project".into(),
                        is_bookmarked: false,
                    },
                ],
                is_dark_mode: Some(true),
            },
        )
        .unwrap();

        assert_eq!(result.pages.len(), 3);
        assert_eq!(
            load_workspace_data_at(directory.path()).unwrap().folders,
            vec![FolderDto {
                id: "projects".into(),
                name: "Projects".into()
            }]
        );
        let connection = database::open(&directory.path().join("note.db")).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM folders", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            3
        );
    }

    #[test]
    fn workspace_structure_rejects_bad_foreign_keys_and_preserves_revisions() {
        let directory = root();
        initialize_storage_at(directory.path()).unwrap();
        let saved = reconcile_workspace_structure_at(
            directory.path(),
            WorkspaceStructure {
                folders: vec![FolderDto {
                    id: "folder".into(),
                    name: "Folder".into(),
                }],
                pages: vec![WorkspacePageDto {
                    id: "page".into(),
                    folder_id: "folder".into(),
                    title: "Original".into(),
                    is_bookmarked: false,
                }],
                is_dark_mode: None,
            },
        )
        .unwrap();
        assert_eq!(saved.pages[0].revision, 0);
        let mut page_element = element("element", 1);
        page_element["pageId"] = json!("page");
        apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "page".into(),
                base_revision: 0,
                upserts: vec![page_element],
                deleted_element_ids: vec![],
            },
        )
        .unwrap();
        let updated = reconcile_workspace_structure_at(
            directory.path(),
            WorkspaceStructure {
                folders: vec![FolderDto {
                    id: "folder".into(),
                    name: "Folder renamed".into(),
                }],
                pages: vec![WorkspacePageDto {
                    id: "page".into(),
                    folder_id: "folder".into(),
                    title: "Renamed".into(),
                    is_bookmarked: true,
                }],
                is_dark_mode: None,
            },
        )
        .unwrap();
        assert_eq!(updated.pages[0].revision, 1);
        let rejected = reconcile_workspace_structure_at(
            directory.path(),
            WorkspaceStructure {
                folders: vec![],
                pages: vec![WorkspacePageDto {
                    id: "bad".into(),
                    folder_id: "missing".into(),
                    title: "Bad".into(),
                    is_bookmarked: false,
                }],
                is_dark_mode: None,
            },
        )
        .unwrap_err();
        assert!(rejected.contains("missing folder"));
        let loaded = load_workspace_data_at(directory.path()).unwrap();
        assert_eq!(loaded.pages.len(), 1);
        assert_eq!(loaded.pages[0].title, "Renamed");
        assert_eq!(loaded.pages[0].revision, 1);
    }

    #[test]
    fn legacy_root_page_migrates_with_hidden_folder() {
        let directory = root();
        let legacy = json!({
            "folders": [],
            "pages": [{"id":"root-page","folderId":"","title":"Root"}],
            "blocks": []
        });
        fs::write(
            directory.path().join("note-data.json"),
            serde_json::to_vec(&legacy).unwrap(),
        )
        .unwrap();
        initialize_storage_at(directory.path()).unwrap();
        let loaded = load_workspace_data_at(directory.path()).unwrap();
        assert!(loaded.folders.is_empty());
        assert_eq!(loaded.pages[0].folder_id, ROOT_FOLDER_ID);
    }
}
