use rusqlite::{Connection, OpenFlags};
use std::{path::Path, time::Duration};

pub const SCHEMA_VERSION: i64 = 1;

pub fn open(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create storage directory: {e}"))?;
    }
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("open database: {e}"))?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|e| format!("set busy timeout: {e}"))?;
    connection
        .execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")
        .map_err(|e| format!("configure database: {e}"))?;
    Ok(connection)
}

pub fn migrate(connection: &mut Connection) -> Result<i64, String> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);").map_err(|e| format!("create migration metadata: {e}"))?;
    let current: i64 = connection
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if current > SCHEMA_VERSION {
        return Err(format!(
            "database schema version {current} is newer than supported version {SCHEMA_VERSION}"
        ));
    }
    if current < 1 {
        let tx = connection.transaction().map_err(|e| e.to_string())?;
        tx.execute_batch(r#"
CREATE TABLE folders(id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
CREATE TABLE pages(id TEXT PRIMARY KEY NOT NULL, folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE, title TEXT NOT NULL, is_bookmarked INTEGER NOT NULL DEFAULT 0 CHECK(is_bookmarked IN (0,1)), revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0));
CREATE INDEX pages_folder_id_idx ON pages(folder_id);
CREATE TABLE assets(id TEXT PRIMARY KEY NOT NULL, relative_path TEXT NOT NULL UNIQUE, file_name TEXT NOT NULL, media_type TEXT NOT NULL, byte_size INTEGER NOT NULL CHECK(byte_size >= 0), natural_width INTEGER, natural_height INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE elements(id TEXT PRIMARY KEY NOT NULL, page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE, element_type TEXT NOT NULL CHECK(element_type IN ('text','image','ink','shape','connector')), x REAL, y REAL, width REAL, height REAL, rotation REAL, z_index INTEGER NOT NULL, opacity REAL NOT NULL CHECK(opacity >= 0 AND opacity <= 1), locked INTEGER NOT NULL CHECK(locked IN (0,1)), group_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, payload_json TEXT NOT NULL);
CREATE INDEX elements_page_z_idx ON elements(page_id,z_index,id); CREATE INDEX elements_group_idx ON elements(group_id) WHERE group_id IS NOT NULL;
CREATE TABLE page_viewports(page_id TEXT PRIMARY KEY NOT NULL REFERENCES pages(id) ON DELETE CASCADE, pan_x REAL NOT NULL, pan_y REAL NOT NULL, zoom REAL NOT NULL CHECK(zoom > 0));
CREATE TABLE app_settings(id INTEGER PRIMARY KEY CHECK(id=1), theme TEXT, settings_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE session_state(id INTEGER PRIMARY KEY CHECK(id=1), state_json TEXT NOT NULL);
INSERT INTO schema_migrations(version,applied_at) VALUES(1,unixepoch('subsec')*1000);
PRAGMA user_version=1;
"#).map_err(|e| format!("apply migration 1: {e}"))?;
        tx.commit()
            .map_err(|e| format!("commit migration 1: {e}"))?;
    }
    Ok(SCHEMA_VERSION)
}
