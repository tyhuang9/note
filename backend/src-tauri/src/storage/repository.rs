use super::{assets, database, legacy_import, models::*};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde_json::Value;
use std::path::Path;

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
        "ink" if value.get("points").and_then(Value::as_array).is_none() => {
            return Err("ink element.points must be an array".into())
        }
        "shape" if value.get("shape").and_then(Value::as_str).is_none() => {
            return Err("shape element.shape must be a string".into())
        }
        "connector" if value.get("start").is_none() || value.get("end").is_none() => {
            return Err("connector endpoints are required".into())
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
            .prepare("SELECT id,name FROM folders ORDER BY rowid")
            .map_err(|e| e.to_string())?;
        let rows = s
            .query_map([], |r| {
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
pub fn apply_scene_changes_at(
    root: &Path,
    batch: SceneChangeBatch,
) -> Result<SceneChangeResult, String> {
    if batch.page_id.is_empty() || batch.base_revision < 0 {
        return Err("invalid pageId or baseRevision".into());
    }
    for e in &batch.upserts {
        validate_element(e, &batch.page_id)?
    }
    if batch.deleted_element_ids.iter().any(|id| id.is_empty()) {
        return Err("deleted element IDs must be non-empty".into());
    }
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
pub fn save_session_state_at(root: &Path, state: Value) -> Result<(), String> {
    if !state.is_object() {
        return Err("session state must be an object".into());
    }
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
}
