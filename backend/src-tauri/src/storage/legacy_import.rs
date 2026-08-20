use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use super::assets;
use super::repository::{ROOT_FOLDER_ID, TEMPLATE_FOLDER_ID};

const IMPORT_MARKER: &str = "legacy_import_v1_completed";

#[derive(Default)]
pub struct ImportOutcome {
    pub imported: bool,
    pub backup_path: Option<PathBuf>,
    pub warnings: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyData {
    folders: Vec<LegacyFolder>,
    pages: Vec<LegacyPage>,
    #[serde(default)]
    blocks: Vec<LegacyBlock>,
    is_dark_mode: Option<bool>,
    session_state: Option<Value>,
}
#[derive(Deserialize)]
struct LegacyFolder {
    id: String,
    name: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyPage {
    id: String,
    folder_id: String,
    title: String,
    #[serde(default)]
    is_bookmarked: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyBlock {
    id: String,
    page_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    #[serde(default)]
    content: String,
    background_mode: Option<String>,
    rich_content: Option<Value>,
    is_width_manually_resized: Option<bool>,
    image_data: Option<String>,
    image_name: Option<String>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}
fn meaningful_text(block: &LegacyBlock) -> bool {
    !block.content.trim().is_empty()
        || block
            .rich_content
            .as_ref()
            .and_then(|v| v.get("content"))
            .and_then(Value::as_array)
            .is_some_and(|v| !v.is_empty())
}
fn decode_data_url(value: &str) -> Result<(String, Vec<u8>), String> {
    let (header, data) = value
        .split_once(',')
        .ok_or("legacy image is not a data URL")?;
    let media = header
        .strip_prefix("data:")
        .and_then(|v| v.strip_suffix(";base64"))
        .ok_or("legacy image must be a base64 data URL")?;
    let bytes = assets::decode_base64_limited(data)
        .map_err(|error| format!("invalid legacy image payload: {error}"))?;
    Ok((media.to_owned(), bytes))
}
fn valid_number(n: f64, name: &str) -> Result<f64, String> {
    if n.is_finite() && (!matches!(name, "width" | "height") || n >= 0.0) {
        Ok(n)
    } else {
        Err(format!("legacy {name} is invalid"))
    }
}

pub fn import_if_needed(
    connection: &mut Connection,
    legacy_path: &Path,
    backup_dir: &Path,
    assets_dir: &Path,
) -> Result<ImportOutcome, String> {
    let marked: Option<String> = connection
        .query_row(
            "SELECT value FROM metadata WHERE key=?",
            [IMPORT_MARKER],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if marked.is_some() || !legacy_path.exists() {
        return Ok(ImportOutcome::default());
    }
    let backup = create_timestamped_backup(legacy_path, backup_dir)
        .map_err(|e| format!("back up legacy data: {e}"))?;
    let original = fs::read(legacy_path).map_err(|e| format!("read legacy data: {e}"))?;
    let legacy: LegacyData =
        serde_json::from_slice(&original).map_err(|e| format!("parse legacy data: {e}"))?;
    let mut staged = Vec::new();
    let result = (|| -> Result<Vec<String>, String> {
        let tx = connection.transaction().map_err(|e| e.to_string())?;
        let mut warnings = Vec::new();
        let mut folder_ids: HashSet<String> = HashSet::new();
        let mut page_ids = HashSet::new();
        let mut element_ids = HashSet::new();
        for block in &legacy.blocks {
            if block.id.is_empty() || !element_ids.insert(block.id.clone()) {
                return Err(format!(
                    "invalid or duplicate legacy block id: {}",
                    block.id
                ));
            }
        }
        for f in &legacy.folders {
            if f.id.is_empty() || !folder_ids.insert(f.id.clone()) {
                return Err(format!("invalid or duplicate legacy folder id: {}", f.id));
            }
            tx.execute(
                "INSERT INTO folders(id,name) VALUES(?,?)",
                params![f.id, f.name],
            )
            .map_err(|e| format!("import folder {}: {e}", f.id))?;
        }
        // The UI represents its root and templates locations by folder IDs
        // without visible folder records. Persist hidden rows so the existing
        // page FK remains valid while preserving the legacy page shape.
        let uses_root = legacy
            .pages
            .iter()
            .any(|page| page.folder_id == ROOT_FOLDER_ID);
        let uses_templates = legacy
            .pages
            .iter()
            .any(|page| page.folder_id == TEMPLATE_FOLDER_ID)
            && !folder_ids.contains(TEMPLATE_FOLDER_ID);
        if uses_root {
            folder_ids.insert(ROOT_FOLDER_ID.to_owned());
            tx.execute(
                "INSERT INTO folders(id,name) VALUES(?,?)",
                params![ROOT_FOLDER_ID, "Root"],
            )
            .map_err(|e| format!("import root folder: {e}"))?;
        }
        if uses_templates {
            folder_ids.insert(TEMPLATE_FOLDER_ID.to_owned());
            tx.execute(
                "INSERT INTO folders(id,name) VALUES(?,?)",
                params![TEMPLATE_FOLDER_ID, "Templates"],
            )
            .map_err(|e| format!("import template folder: {e}"))?;
        }
        for p in &legacy.pages {
            if p.id.is_empty() || !page_ids.insert(&p.id) {
                return Err(format!("invalid or duplicate legacy page id: {}", p.id));
            }
            if !folder_ids.contains(&p.folder_id) {
                return Err(format!(
                    "legacy page {} references missing folder {}",
                    p.id, p.folder_id
                ));
            }
            tx.execute(
                "INSERT INTO pages(id,folder_id,title,is_bookmarked) VALUES(?,?,?,?)",
                params![p.id, p.folder_id, p.title, p.is_bookmarked as i64],
            )
            .map_err(|e| format!("import page {}: {e}", p.id))?;
        }
        for (z, b) in legacy.blocks.iter().enumerate() {
            if !page_ids.contains(&b.page_id) {
                return Err(format!(
                    "legacy block {} references missing page {}",
                    b.id, b.page_id
                ));
            }
            for (n, v) in [
                ("x", b.x),
                ("y", b.y),
                ("width", b.width),
                ("height", b.height),
            ] {
                valid_number(v, n)?;
            }
            let timestamp = now_ms();
            let has_text = meaningful_text(b);
            if has_text || b.image_data.is_none() {
                let background_mode = match b.background_mode.as_deref() {
                    Some("transparent") => "transparent",
                    _ => "surface",
                };
                let payload = json!({"id":b.id,"pageId":b.page_id,"type":"text","x":b.x,"y":b.y,"width":b.width,"height":b.height,"rotation":0.0,"zIndex":z as i64,"opacity":1.0,"locked":false,"createdAt":timestamp,"updatedAt":timestamp,"backgroundMode":background_mode,"content":b.content,"richContent":b.rich_content,"isWidthManuallyResized":b.is_width_manually_resized});
                insert_element(&tx, &payload)?;
            }
            if let Some(data) = &b.image_data {
                let mut image_id = b.id.clone();
                if has_text {
                    let base = format!("{}-image", b.id);
                    image_id = base.clone();
                    let mut suffix = 2;
                    while element_ids.contains(&image_id) {
                        image_id = format!("{base}-{suffix}");
                        suffix += 1
                    }
                    element_ids.insert(image_id.clone());
                    warnings.push(format!(
                        "Legacy block {} contained text and an image; both were preserved",
                        b.id
                    ));
                }
                let (media, bytes) = decode_data_url(data)?;
                let (asset, path) = assets::write_bytes(
                    &tx,
                    assets_dir,
                    &bytes,
                    &media,
                    b.image_name.as_deref(),
                    Some(b.width.max(0.0) as u32),
                    Some(b.height.max(0.0) as u32),
                )?;
                staged.push(path);
                let payload = json!({"id":image_id,"pageId":b.page_id,"type":"image","x":b.x,"y":b.y,"width":b.width,"height":b.height,"rotation":0.0,"zIndex":z as i64 + if has_text{1}else{0},"opacity":1.0,"locked":false,"createdAt":timestamp,"updatedAt":timestamp,"assetId":asset.id,"fileName":b.image_name,"naturalWidth":b.width,"naturalHeight":b.height,"fit":"contain"});
                insert_element(&tx, &payload)?;
            }
        }
        if let Some(dark) = legacy.is_dark_mode {
            tx.execute("INSERT INTO app_settings(id,theme) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET theme=excluded.theme",[if dark{"dark"}else{"light"}]).map_err(|e|e.to_string())?;
        }
        if let Some(session) = &legacy.session_state {
            let mut stored = session.clone();
            if let Some(viewports) = stored
                .get_mut("pageViewports")
                .and_then(Value::as_object_mut)
            {
                for (page_id, viewport) in viewports.iter() {
                    if !page_ids.contains(page_id) {
                        return Err(format!("viewport references missing page {page_id}"));
                    }
                    let pan = viewport
                        .get("panOffset")
                        .ok_or("viewport panOffset missing")?;
                    let x = pan
                        .get("x")
                        .and_then(Value::as_f64)
                        .ok_or("viewport pan x invalid")?;
                    let y = pan
                        .get("y")
                        .and_then(Value::as_f64)
                        .ok_or("viewport pan y invalid")?;
                    let zoom = viewport
                        .get("zoomLevel")
                        .and_then(Value::as_f64)
                        .ok_or("viewport zoom invalid")?;
                    if !x.is_finite() || !y.is_finite() || !zoom.is_finite() || zoom <= 0.0 {
                        return Err("viewport values invalid".into());
                    }
                    tx.execute(
                        "INSERT INTO page_viewports(page_id,pan_x,pan_y,zoom) VALUES(?,?,?,?)",
                        params![page_id, x, y, zoom],
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
            tx.execute(
                "INSERT INTO session_state(id,state_json) VALUES(1,?)",
                [serde_json::to_string(&stored).map_err(|e| e.to_string())?],
            )
            .map_err(|e| e.to_string())?;
        }
        let counts = (
            tx.query_row("SELECT count(*) FROM folders", [], |r| r.get::<_, i64>(0))
                .map_err(|e| e.to_string())?,
            tx.query_row("SELECT count(*) FROM pages", [], |r| r.get::<_, i64>(0))
                .map_err(|e| e.to_string())?,
        );
        if counts != (folder_ids.len() as i64, legacy.pages.len() as i64) {
            return Err("legacy import count validation failed".into());
        }
        tx.execute(
            "INSERT INTO metadata(key,value) VALUES(?,?)",
            params![IMPORT_MARKER, now_ms().to_string()],
        )
        .map_err(|e| e.to_string())?;
        tx.commit()
            .map_err(|e| format!("commit legacy import: {e}"))?;
        Ok(warnings)
    })();
    match result {
        Ok(warnings) => Ok(ImportOutcome {
            imported: true,
            backup_path: Some(backup),
            warnings,
        }),
        Err(error) => {
            for path in staged {
                let _ = fs::remove_file(path);
            }
            Err(format!(
                "legacy import failed (original and backup preserved): {error}"
            ))
        }
    }
}

fn insert_element(connection: &Connection, p: &Value) -> Result<(), String> {
    connection.execute("INSERT INTO elements(id,page_id,element_type,x,y,width,height,rotation,z_index,opacity,locked,created_at,updated_at,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",params![p["id"].as_str(),p["pageId"].as_str(),p["type"].as_str(),p["x"].as_f64(),p["y"].as_f64(),p["width"].as_f64(),p["height"].as_f64(),p["rotation"].as_f64(),p["zIndex"].as_i64(),p["opacity"].as_f64(),0,p["createdAt"].as_i64(),p["updatedAt"].as_i64(),serde_json::to_string(p).map_err(|e|e.to_string())?]).map_err(|e|format!("insert legacy element: {e}"))?;
    Ok(())
}

/// Copies a legacy data file byte-for-byte into a timestamped backup.
///
/// The destination is opened with `create_new`, so an existing backup is
/// never overwritten. The helper is intentionally not called by the runtime
/// yet; it is kept reusable for a later import flow. File contents are synced
/// before returning; directory-entry durability remains the caller/import
/// flow's responsibility.
pub fn create_timestamped_backup(source: &Path, backup_dir: &Path) -> io::Result<PathBuf> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?
        .as_nanos();

    create_timestamped_backup_at(source, backup_dir, timestamp)
}

/// Deterministic variant used by import code and tests that need to control
/// the timestamp and prove collision behavior.
pub fn create_timestamped_backup_at(
    source: &Path,
    backup_dir: &Path,
    timestamp: u128,
) -> io::Result<PathBuf> {
    let source_name = source.file_name().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "legacy backup source must have a file name",
        )
    })?;

    fs::create_dir_all(backup_dir)?;

    let backup_name = format!("{}.backup-{}", source_name.to_string_lossy(), timestamp);
    let backup_path = backup_dir.join(backup_name);
    let mut source_file = File::open(source)?;
    let mut backup_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&backup_path)?;

    if let Err(error) = io::copy(&mut source_file, &mut backup_file)
        .and_then(|_| backup_file.flush())
        .and_then(|_| backup_file.sync_all())
    {
        let _ = fs::remove_file(&backup_path);
        return Err(error);
    }

    Ok(backup_path)
}

#[cfg(test)]
mod tests {
    use super::create_timestamped_backup_at;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_directory() -> std::path::PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after the Unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "note-legacy-backup-test-{}-{}",
            std::process::id(),
            timestamp
        ));

        fs::create_dir_all(&path).expect("temporary test directory should be created");
        path
    }

    #[test]
    fn backup_is_an_exact_byte_copy() {
        let directory = temporary_directory();
        let source = directory.join("note-data.json");
        let backup_dir = directory.join("backups");
        let source_bytes = b"{\"unicode\":\"caf\xC3\xA9\",\"line\":1}\n\0";
        fs::write(&source, source_bytes).expect("source should be written");

        let backup = create_timestamped_backup_at(&source, &backup_dir, 123).unwrap();

        assert_eq!(fs::read(&backup).unwrap(), source_bytes);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn backup_preserves_the_source_file() {
        let directory = temporary_directory();
        let source = directory.join("note-data.json");
        let backup_dir = directory.join("backups");
        let source_bytes = b"legacy bytes remain unchanged";
        fs::write(&source, source_bytes).expect("source should be written");

        create_timestamped_backup_at(&source, &backup_dir, 456).unwrap();

        assert_eq!(fs::read(&source).unwrap(), source_bytes);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn backup_refuses_a_timestamp_collision_without_overwriting() {
        let directory = temporary_directory();
        let source = directory.join("note-data.json");
        let backup_dir = directory.join("backups");
        fs::write(&source, b"original").expect("source should be written");

        let first_backup = create_timestamped_backup_at(&source, &backup_dir, 789).unwrap();
        fs::write(&source, b"changed after first backup").expect("source should be changed");

        let collision = create_timestamped_backup_at(&source, &backup_dir, 789).unwrap_err();

        assert_eq!(collision.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(first_backup).unwrap(), b"original");
        fs::remove_dir_all(directory).unwrap();
    }
}
