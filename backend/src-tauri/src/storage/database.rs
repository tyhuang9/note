use rusqlite::{Connection, OpenFlags};
use std::{path::Path, time::Duration};

pub const SCHEMA_VERSION: i64 = 5;

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
    if current < 2 {
        let tx = connection.transaction().map_err(|e| e.to_string())?;
        tx.execute_batch(
            r#"
ALTER TABLE folders ADD COLUMN is_bookmarked INTEGER NOT NULL DEFAULT 0 CHECK(is_bookmarked IN (0,1));
INSERT INTO schema_migrations(version,applied_at) VALUES(2,unixepoch('subsec')*1000);
PRAGMA user_version=2;
"#,
        )
        .map_err(|e| format!("apply migration 2: {e}"))?;
        tx.commit()
            .map_err(|e| format!("commit migration 2: {e}"))?;
    }
    if current < 3 {
        let tx = connection.transaction().map_err(|e| e.to_string())?;
        tx.execute_batch(
            r#"
ALTER TABLE folders ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'active' CHECK(lifecycle IN ('active','trashed'));
ALTER TABLE folders ADD COLUMN trashed_at INTEGER;
ALTER TABLE pages ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'active' CHECK(lifecycle IN ('active','trashed'));
ALTER TABLE pages ADD COLUMN trashed_at INTEGER;
CREATE INDEX folders_lifecycle_idx ON folders(lifecycle);
CREATE INDEX pages_lifecycle_idx ON pages(lifecycle);
INSERT INTO schema_migrations(version,applied_at) VALUES(3,unixepoch('subsec')*1000);
PRAGMA user_version=3;
"#,
        )
        .map_err(|e| format!("apply migration 3: {e}"))?;
        tx.commit()
            .map_err(|e| format!("commit migration 3: {e}"))?;
    }
    if current < 4 {
        let tx = connection.transaction().map_err(|e| e.to_string())?;
        tx.execute_batch(r#"
CREATE TABLE trash_purge_snapshots(token TEXT PRIMARY KEY NOT NULL, snapshot_json TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TRIGGER folders_lifecycle_invariant_insert BEFORE INSERT ON folders WHEN (NEW.lifecycle='active' AND NEW.trashed_at IS NOT NULL) OR (NEW.lifecycle='trashed' AND NEW.trashed_at IS NULL) BEGIN SELECT RAISE(ABORT,'invalid folder lifecycle timestamp'); END;
CREATE TRIGGER folders_lifecycle_invariant_update BEFORE UPDATE OF lifecycle,trashed_at ON folders WHEN (NEW.lifecycle='active' AND NEW.trashed_at IS NOT NULL) OR (NEW.lifecycle='trashed' AND NEW.trashed_at IS NULL) BEGIN SELECT RAISE(ABORT,'invalid folder lifecycle timestamp'); END;
CREATE TRIGGER pages_lifecycle_invariant_insert BEFORE INSERT ON pages WHEN (NEW.lifecycle='active' AND NEW.trashed_at IS NOT NULL) OR (NEW.lifecycle='trashed' AND NEW.trashed_at IS NULL) BEGIN SELECT RAISE(ABORT,'invalid page lifecycle timestamp'); END;
CREATE TRIGGER pages_lifecycle_invariant_update BEFORE UPDATE OF lifecycle,trashed_at ON pages WHEN (NEW.lifecycle='active' AND NEW.trashed_at IS NOT NULL) OR (NEW.lifecycle='trashed' AND NEW.trashed_at IS NULL) BEGIN SELECT RAISE(ABORT,'invalid page lifecycle timestamp'); END;
INSERT INTO schema_migrations(version,applied_at) VALUES(4,unixepoch('subsec')*1000);
PRAGMA user_version=4;
"#).map_err(|e| format!("apply migration 4: {e}"))?;
        tx.commit().map_err(|e| format!("commit migration 4: {e}"))?;
    }
    if current < 5 {
        connection.execute_batch(r#"
CREATE TABLE asset_cleanup_journal(asset_id TEXT PRIMARY KEY NOT NULL, relative_path TEXT NOT NULL, staged_path TEXT NOT NULL);
INSERT INTO schema_migrations(version,applied_at) VALUES(5,unixepoch('subsec')*1000);
PRAGMA user_version=5;
"#).map_err(|e| format!("apply migration 5: {e}"))?;
    }
    Ok(SCHEMA_VERSION)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_two_adds_folder_bookmarks_without_changing_existing_folders() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                r#"
CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE folders(id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
CREATE TABLE pages(id TEXT PRIMARY KEY NOT NULL, folder_id TEXT NOT NULL, title TEXT NOT NULL, is_bookmarked INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0);
INSERT INTO folders(id,name) VALUES('folder','Folder');
INSERT INTO schema_migrations(version,applied_at) VALUES(1,0);
PRAGMA user_version=1;
"#,
            )
            .unwrap();

        assert_eq!(migrate(&mut connection).unwrap(), 4);
        assert_eq!(
            connection
                .query_row(
                    "SELECT id,name,is_bookmarked FROM folders WHERE id='folder'",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                        ))
                    },
                )
                .unwrap(),
            ("folder".into(), "Folder".into(), 0),
        );
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            5,
        );
    }

    #[test]
    fn migration_three_marks_existing_rows_active() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(r#"
CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE folders(id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, is_bookmarked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE pages(id TEXT PRIMARY KEY NOT NULL, folder_id TEXT NOT NULL, title TEXT NOT NULL, is_bookmarked INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0);
INSERT INTO folders(id,name) VALUES('folder','Folder');
INSERT INTO pages(id,folder_id,title) VALUES('page','folder','Page');
INSERT INTO schema_migrations(version,applied_at) VALUES(2,0);
PRAGMA user_version=2;
"#).unwrap();

        migrate(&mut connection).unwrap();
        let rows: Vec<(String, Option<i64>)> = connection
            .prepare("SELECT lifecycle,trashed_at FROM pages")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(rows, vec![("active".into(), None)]);
    }
}
