use super::models::{AssetDto, SaveAssetRequest};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

pub const MAX_ASSET_BYTES: usize = 16 * 1024 * 1024;
// An aggregate workspace quota is intentionally deferred until product usage limits are defined.

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}
fn extension(media_type: &str) -> Option<&'static str> {
    match media_type.to_ascii_lowercase().as_str() {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/svg+xml" => Some("svg"),
        _ => None,
    }
}

pub(crate) fn write_bytes(
    connection: &Connection,
    assets_dir: &Path,
    bytes: &[u8],
    media_type: &str,
    file_name: Option<&str>,
    natural_width: Option<u32>,
    natural_height: Option<u32>,
) -> Result<(AssetDto, std::path::PathBuf), String> {
    let ext = extension(media_type)
        .ok_or_else(|| format!("unsupported asset media type: {media_type}"))?;
    if bytes.is_empty() {
        return Err("asset payload is empty".into());
    }
    if bytes.len() > MAX_ASSET_BYTES {
        return Err(format!(
            "asset exceeds the maximum decoded size of {MAX_ASSET_BYTES} bytes"
        ));
    }
    fs::create_dir_all(assets_dir).map_err(|e| format!("create assets directory: {e}"))?;
    let id = Uuid::new_v4().to_string();
    let relative = format!("{id}.{ext}");
    let destination = assets_dir.join(&relative);
    let temporary = assets_dir.join(format!(".{id}.tmp"));
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|e| format!("create staged asset: {e}"))?;
    if let Err(error) = output.write_all(bytes).and_then(|_| output.sync_all()) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("write staged asset: {error}"));
    }
    if destination.exists() {
        let _ = fs::remove_file(&temporary);
        return Err("generated asset path already exists".into());
    }
    fs::rename(&temporary, &destination).map_err(|e| {
        let _ = fs::remove_file(&temporary);
        format!("publish asset: {e}")
    })?;
    let name = file_name
        .filter(|v| !v.trim().is_empty())
        .unwrap_or("image")
        .chars()
        .take(255)
        .collect::<String>();
    let dto = AssetDto {
        id: id.clone(),
        file_name: name.clone(),
        media_type: media_type.to_owned(),
        byte_size: bytes.len() as u64,
        natural_width,
        natural_height,
        data_base64: None,
    };
    if let Err(error) = connection.execute("INSERT INTO assets(id,relative_path,file_name,media_type,byte_size,natural_width,natural_height,created_at) VALUES(?,?,?,?,?,?,?,?)", params![id,relative,name,media_type,bytes.len() as i64,natural_width,natural_height,now_ms()]) { let _ = fs::remove_file(&destination); return Err(format!("record asset: {error}")); }
    Ok((dto, destination))
}

pub fn save(
    connection: &Connection,
    assets_dir: &Path,
    request: SaveAssetRequest,
) -> Result<AssetDto, String> {
    let bytes = decode_base64_limited(&request.data_base64)?;
    write_bytes(
        connection,
        assets_dir,
        &bytes,
        &request.media_type,
        request.file_name.as_deref(),
        request.natural_width,
        request.natural_height,
    )
    .map(|v| v.0)
}

pub(crate) fn decode_base64_limited(encoded: &str) -> Result<Vec<u8>, String> {
    let maximum_encoded_len = MAX_ASSET_BYTES.div_ceil(3) * 4;
    if encoded.len() > maximum_encoded_len {
        return Err(format!(
            "asset exceeds the maximum encoded size for {MAX_ASSET_BYTES} decoded bytes"
        ));
    }
    let bytes = STANDARD
        .decode(encoded.as_bytes())
        .map_err(|e| format!("invalid asset base64: {e}"))?;
    if bytes.len() > MAX_ASSET_BYTES {
        return Err(format!(
            "asset exceeds the maximum decoded size of {MAX_ASSET_BYTES} bytes"
        ));
    }
    Ok(bytes)
}

pub(crate) fn validate_reference(
    connection: &Connection,
    assets_dir: &Path,
    id: &str,
) -> Result<(), String> {
    let relative_path: String = connection
        .query_row("SELECT relative_path FROM assets WHERE id=?", [id], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("image asset not found: {id}"))?;
    let relative = Path::new(&relative_path);
    if relative.components().count() != 1
        || !matches!(
            relative.components().next(),
            Some(std::path::Component::Normal(_))
        )
    {
        return Err(format!("image asset {id} has an invalid managed path"));
    }
    let path = assets_dir.join(relative);
    let metadata = fs::symlink_metadata(&path)
        .map_err(|error| format!("image asset {id} file is unavailable: {error}"))?;
    if !metadata.file_type().is_file() {
        return Err(format!("image asset {id} is not a regular managed file"));
    }
    Ok(())
}

pub fn load(connection: &Connection, assets_dir: &Path, id: &str) -> Result<AssetDto, String> {
    let row = connection.query_row("SELECT relative_path,file_name,media_type,byte_size,natural_width,natural_height FROM assets WHERE id=?", [id], |r| Ok((r.get::<_,String>(0)?,r.get(1)?,r.get(2)?,r.get::<_,i64>(3)?,r.get(4)?,r.get(5)?))).optional().map_err(|e| e.to_string())?.ok_or_else(|| format!("asset not found: {id}"))?;
    let path = assets_dir.join(&row.0);
    if path.parent() != Some(assets_dir) {
        return Err("invalid stored asset path".into());
    }
    let bytes = fs::read(path).map_err(|e| format!("read asset: {e}"))?;
    if bytes.len() as i64 != row.3 {
        return Err(format!("asset {id} size does not match metadata"));
    }
    Ok(AssetDto {
        id: id.to_owned(),
        file_name: row.1,
        media_type: row.2,
        byte_size: row.3 as u64,
        natural_width: row.4,
        natural_height: row.5,
        data_base64: Some(STANDARD.encode(bytes)),
    })
}
