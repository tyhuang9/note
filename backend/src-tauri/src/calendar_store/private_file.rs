use std::{
    fs::OpenOptions,
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
};

#[cfg(unix)]
use std::fs::File;

use tempfile::{Builder, TempPath};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PrivateFileError {
    DestinationExists,
    Failed,
}

pub(crate) struct PrivateTempFile {
    path: TempPath,
    parent: PathBuf,
}

impl PrivateTempFile {
    pub(crate) fn create(
        destination: &Path,
        prefix: &str,
        suffix: &str,
    ) -> Result<Self, PrivateFileError> {
        match destination.try_exists() {
            Ok(true) => return Err(PrivateFileError::DestinationExists),
            Ok(false) => {}
            Err(_) => return Err(PrivateFileError::Failed),
        }

        Self::create_in_parent(destination, prefix, suffix)
    }

    fn create_in_parent(
        destination: &Path,
        prefix: &str,
        suffix: &str,
    ) -> Result<Self, PrivateFileError> {
        let parent = destination
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        if !parent.is_dir() {
            return Err(PrivateFileError::Failed);
        }

        let path = Builder::new()
            .prefix(prefix)
            .suffix(suffix)
            .tempfile_in(parent)
            .map_err(|_| PrivateFileError::Failed)?
            .into_temp_path();
        set_private_permissions(&path)?;

        Ok(Self {
            path,
            parent: parent.to_owned(),
        })
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn write_and_sync(&self, content: &[u8]) -> Result<u64, PrivateFileError> {
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .truncate(true)
            .open(&self.path)
            .map_err(|_| PrivateFileError::Failed)?;
        file.write_all(content)
            .and_then(|_| file.flush())
            .and_then(|_| file.sync_all())
            .map_err(|_| PrivateFileError::Failed)?;
        u64::try_from(content.len()).map_err(|_| PrivateFileError::Failed)
    }

    pub(crate) fn sync(&self) -> Result<u64, PrivateFileError> {
        OpenOptions::new()
            .read(true)
            .write(true)
            .open(&self.path)
            .and_then(|file| file.sync_all())
            .map_err(|_| PrivateFileError::Failed)?;
        self.path
            .metadata()
            .map(|metadata| metadata.len())
            .map_err(|_| PrivateFileError::Failed)
    }

    pub(crate) fn publish(self, destination: &Path) -> Result<(), PrivateFileError> {
        match self.path.persist_noclobber(destination) {
            Ok(()) => {}
            Err(error)
                if error.error.kind() == ErrorKind::AlreadyExists
                    || destination.try_exists().unwrap_or(false) =>
            {
                return Err(PrivateFileError::DestinationExists);
            }
            Err(_) => return Err(PrivateFileError::Failed),
        }

        sync_directory_best_effort(&self.parent);
        Ok(())
    }
}

#[cfg(unix)]
fn set_private_permissions(path: &Path) -> Result<(), PrivateFileError> {
    use std::os::unix::fs::PermissionsExt;

    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|_| PrivateFileError::Failed)
}

#[cfg(not(unix))]
fn set_private_permissions(_path: &Path) -> Result<(), PrivateFileError> {
    Ok(())
}

#[cfg(unix)]
fn sync_directory_best_effort(path: &Path) {
    if let Ok(directory) = File::open(path) {
        let _ = directory.sync_all();
    }
}

#[cfg(not(unix))]
fn sync_directory_best_effort(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_exports(directory: &Path) -> Vec<String> {
        std::fs::read_dir(directory)
            .unwrap()
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| name.starts_with(".note-calendar-export-"))
            .collect()
    }

    #[test]
    fn content_is_synced_and_published_without_overwrite() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("calendar.ics");
        let temporary =
            PrivateTempFile::create(&destination, ".note-calendar-export-", ".ics").unwrap();
        assert_eq!(temporary.write_and_sync(b"calendar"), Ok(8));
        temporary.publish(&destination).unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), b"calendar");

        let second = PrivateTempFile::create(&destination, ".note-calendar-export-", ".ics");
        assert!(matches!(second, Err(PrivateFileError::DestinationExists)));
        assert_eq!(std::fs::read(&destination).unwrap(), b"calendar");
    }

    #[test]
    fn dropped_or_failed_publication_cleans_the_temporary_file() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("calendar.ics");
        {
            let temporary =
                PrivateTempFile::create(&destination, ".note-calendar-export-", ".ics").unwrap();
            temporary.write_and_sync(b"private").unwrap();
            std::fs::write(&destination, b"existing").unwrap();
            assert_eq!(
                temporary.publish(&destination),
                Err(PrivateFileError::DestinationExists)
            );
        }
        assert!(temporary_exports(directory.path()).is_empty());
        assert_eq!(std::fs::read(destination).unwrap(), b"existing");
    }

    #[cfg(unix)]
    #[test]
    fn published_files_are_private_to_the_current_user() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("private.ics");
        let temporary =
            PrivateTempFile::create(&destination, ".note-calendar-export-", ".ics").unwrap();
        temporary.write_and_sync(b"private").unwrap();
        temporary.publish(&destination).unwrap();

        assert_eq!(
            destination.metadata().unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
