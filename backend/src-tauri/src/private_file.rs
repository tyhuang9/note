use std::{io::Write, path::Path};

#[cfg(unix)]
use std::fs::File;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PrivateFileError;

pub(crate) fn atomic_write_private(
    destination: &Path,
    content: &[u8],
) -> Result<(), PrivateFileError> {
    let parent = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or(PrivateFileError)?;
    if !parent.is_dir() {
        return Err(PrivateFileError);
    }

    let mut temporary = tempfile::Builder::new()
        .prefix(".note-data-")
        .suffix(".tmp")
        .tempfile_in(parent)
        .map_err(|_| PrivateFileError)?;
    set_private_permissions(temporary.path())?;
    temporary
        .write_all(content)
        .and_then(|_| temporary.flush())
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|_| PrivateFileError)?;
    temporary
        .persist(destination)
        .map_err(|_| PrivateFileError)?;
    sync_directory_best_effort(parent);
    Ok(())
}

#[cfg(unix)]
fn set_private_permissions(path: &Path) -> Result<(), PrivateFileError> {
    use std::os::unix::fs::PermissionsExt;

    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|_| PrivateFileError)
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

    fn temporary_files(directory: std::path::PathBuf) -> Vec<std::path::PathBuf> {
        std::fs::read_dir(directory)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with(".note-data-") && name.ends_with(".tmp"))
            })
            .collect()
    }

    #[test]
    fn private_application_file_is_atomically_replaced() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("note-data.json");
        std::fs::write(&destination, b"old").unwrap();

        atomic_write_private(&destination, b"new").unwrap();

        assert_eq!(std::fs::read(&destination).unwrap(), b"new");
        assert!(temporary_files(directory.path().to_path_buf()).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn published_files_are_private_to_the_current_user() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("note-data.json");
        atomic_write_private(&destination, b"private").unwrap();

        assert_eq!(
            destination.metadata().unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
