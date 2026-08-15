use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

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
