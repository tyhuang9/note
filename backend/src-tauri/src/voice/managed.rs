use std::{
    fmt::Write as _,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

use futures_util::StreamExt;
use reqwest::Client;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::{
    sync::{watch, Mutex},
    time::timeout,
};

const MODEL_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/c521a4b02f422512d734391fdf08bb08c0862f68/ggml-small.en.bin";
const MODEL_SHA256: &str = "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d";
const MODEL_FILE: &str = "ggml-small.en.bin";
const MAX_MODEL_BYTES: u64 = 768 * 1024 * 1024;
const EXPECTED_DOWNLOAD_BYTES: u64 = 487_614_201;
const HEADERS_TIMEOUT: Duration = Duration::from_secs(20);
const DOWNLOAD_IDLE_TIMEOUT: Duration = Duration::from_secs(45);
const STAGING_PREFIX: &str = "note-voice-model-";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum VoiceModelProgressState {
    Installing,
    Verifying,
    Installed,
    Cancelled,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VoiceModelProgress {
    pub(crate) operation_id: String,
    pub(crate) state: VoiceModelProgressState,
    pub(crate) completed_bytes: u64,
    pub(crate) total_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error_code: Option<&'static str>,
}

// `total_bytes == 0` explicitly means indeterminate progress. Starting, verifying,
// and terminal states use it; received download chunks retain a known HTTP total.

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VoiceModelStatus {
    pub(crate) state: VoiceModelState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error_code: Option<&'static str>,
    pub(crate) display_name: &'static str,
    pub(crate) expected_download_bytes: u64,
    pub(crate) transcription_available: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum VoiceModelState {
    Idle,
    Installing,
    Installed,
    Cancelled,
    Failed,
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum VoiceModelError {
    Busy,
    Cancelled,
    DownloadFailed,
    VerificationFailed,
    InstallationFailed,
    RemoveFailed,
}

impl VoiceModelError {
    const fn error_code(self) -> &'static str {
        match self {
            Self::Busy => "model_busy",
            Self::Cancelled => "model_cancelled",
            Self::DownloadFailed => "model_download_failed",
            Self::VerificationFailed => "model_verification_failed",
            Self::InstallationFailed => "model_installation_failed",
            Self::RemoveFailed => "model_remove_failed",
        }
    }
}

pub(crate) struct ManagedVoiceModel {
    root: PathBuf,
    http: Client,
    install: Mutex<InstallSlot>,
}

struct InstallSlot {
    generation: u64,
    cancel: Option<watch::Sender<bool>>,
    last_state: VoiceModelState,
    last_error_code: Option<&'static str>,
}

impl Default for InstallSlot {
    fn default() -> Self {
        Self {
            generation: 0,
            cancel: None,
            last_state: VoiceModelState::Idle,
            last_error_code: None,
        }
    }
}

impl ManagedVoiceModel {
    pub(crate) fn new(root: PathBuf) -> Self {
        let http = Client::builder()
            .connect_timeout(HEADERS_TIMEOUT)
            .redirect(reqwest::redirect::Policy::limited(4))
            .build()
            .expect("managed voice HTTP client must be constructible");
        Self {
            root,
            http,
            install: Mutex::new(InstallSlot::default()),
        }
    }

    pub(crate) async fn status(&self) -> VoiceModelStatus {
        let install = self.install.lock().await;
        let (state, error_code) = if !cfg!(desktop) {
            (VoiceModelState::Unavailable, None)
        } else if self.validated_model_path().is_some() {
            (VoiceModelState::Installed, None)
        } else if install.cancel.is_some() {
            (VoiceModelState::Installing, None)
        } else {
            (install.last_state, install.last_error_code)
        };
        VoiceModelStatus {
            state,
            error_code,
            display_name: "Whisper small.en",
            expected_download_bytes: EXPECTED_DOWNLOAD_BYTES,
            // The managed model is useful only once Note bundles a native Whisper runtime.
            transcription_available: false,
        }
    }

    pub(crate) async fn install<F>(
        &self,
        operation_id: String,
        mut emit: F,
    ) -> Result<(), VoiceModelError>
    where
        F: FnMut(VoiceModelProgress),
    {
        if self.validated_model_path().is_some() {
            return Ok(());
        }
        let (generation, mut cancelled) = self.begin_install().await?;
        let result = self
            .install_inner(&operation_id, &mut cancelled, &mut emit)
            .await;
        self.finish_install(generation, result).await;
        emit(progress(
            &operation_id,
            match result {
                Ok(()) => VoiceModelProgressState::Installed,
                Err(VoiceModelError::Cancelled) => VoiceModelProgressState::Cancelled,
                Err(_) => VoiceModelProgressState::Failed,
            },
            0,
            0,
            result.err().map(VoiceModelError::error_code),
        ));
        result
    }

    pub(crate) async fn cancel_install(&self) {
        if let Some(cancel) = self.install.lock().await.cancel.as_ref() {
            let _ = cancel.send(true);
        }
    }

    pub(crate) async fn remove(&self) -> Result<(), VoiceModelError> {
        if self.install.lock().await.cancel.is_some() {
            return Err(VoiceModelError::Busy);
        }
        let path = self.model_path();
        if managed_directory_if_safe(&self.root).is_none() {
            return Err(VoiceModelError::RemoveFailed);
        }
        let result = match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() => Err(VoiceModelError::RemoveFailed),
            Ok(metadata) if metadata.is_file() => {
                fs::remove_file(path).map_err(|_| VoiceModelError::RemoveFailed)
            }
            Ok(_) => Err(VoiceModelError::RemoveFailed),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(VoiceModelError::RemoveFailed),
        };
        if result.is_ok() {
            let mut install = self.install.lock().await;
            install.last_state = VoiceModelState::Idle;
            install.last_error_code = None;
        }
        result
    }

    async fn begin_install(&self) -> Result<(u64, watch::Receiver<bool>), VoiceModelError> {
        let mut install = self.install.lock().await;
        if install.cancel.is_some() {
            return Err(VoiceModelError::Busy);
        }
        install.generation = install.generation.wrapping_add(1);
        let generation = install.generation;
        let (sender, receiver) = watch::channel(false);
        install.cancel = Some(sender);
        install.last_state = VoiceModelState::Installing;
        install.last_error_code = None;
        Ok((generation, receiver))
    }

    async fn finish_install(&self, generation: u64, result: Result<(), VoiceModelError>) {
        let mut install = self.install.lock().await;
        if install.generation == generation {
            install.cancel = None;
            match result {
                Ok(()) => {
                    install.last_state = VoiceModelState::Installed;
                    install.last_error_code = None;
                }
                Err(VoiceModelError::Cancelled) => {
                    install.last_state = VoiceModelState::Cancelled;
                    install.last_error_code = None;
                }
                Err(error) => {
                    install.last_state = VoiceModelState::Failed;
                    install.last_error_code = Some(error.error_code());
                }
            }
        }
    }

    async fn install_inner<F>(
        &self,
        operation_id: &str,
        cancelled: &mut watch::Receiver<bool>,
        emit: &mut F,
    ) -> Result<(), VoiceModelError>
    where
        F: FnMut(VoiceModelProgress),
    {
        check_cancelled(cancelled)?;
        prepare_root(&self.root)?;
        cleanup_stale_staging(&self.root)?;
        let staging = tempfile::Builder::new()
            .prefix(STAGING_PREFIX)
            .tempdir_in(&self.root)
            .map_err(|_| VoiceModelError::InstallationFailed)?;
        set_private_directory_permissions(staging.path())?;
        let staged_model = staging.path().join(MODEL_FILE);
        emit(progress(
            operation_id,
            VoiceModelProgressState::Installing,
            0,
            0,
            None,
        ));
        self.download(operation_id, &staged_model, cancelled, emit)
            .await?;
        emit(progress(
            operation_id,
            VoiceModelProgressState::Verifying,
            0,
            0,
            None,
        ));
        verify_sha256(&staged_model)?;
        check_cancelled(cancelled)?;

        let destination_directory = prepare_managed_directory(&self.root)?;
        let destination = destination_directory.join(MODEL_FILE);
        match fs::symlink_metadata(&destination) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                return Err(VoiceModelError::InstallationFailed)
            }
            Ok(_) if valid_model(&destination) => return Ok(()),
            Ok(_) => {
                fs::remove_file(&destination).map_err(|_| VoiceModelError::InstallationFailed)?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(VoiceModelError::InstallationFailed),
        }
        // A same-volume rename is atomic where the platform permits it. Existing managed
        // files are retained rather than overwritten, avoiding a non-atomic replacement.
        fs::rename(&staged_model, &destination).map_err(|_| VoiceModelError::InstallationFailed)?;
        if valid_model(&destination) {
            Ok(())
        } else {
            Err(VoiceModelError::InstallationFailed)
        }
    }

    async fn download<F>(
        &self,
        operation_id: &str,
        destination: &Path,
        cancelled: &mut watch::Receiver<bool>,
        emit: &mut F,
    ) -> Result<(), VoiceModelError>
    where
        F: FnMut(VoiceModelProgress),
    {
        let response = tokio::select! {
            changed = cancelled.changed() => {
                let _ = changed;
                return Err(VoiceModelError::Cancelled);
            }
            response = timeout(HEADERS_TIMEOUT, self.http.get(MODEL_URL).send()) => {
                response.map_err(|_| VoiceModelError::DownloadFailed)?
                    .map_err(|_| VoiceModelError::DownloadFailed)?
            }
        };
        if !response.status().is_success() {
            return Err(VoiceModelError::DownloadFailed);
        }
        let total = response.content_length().unwrap_or(0);
        if total > MAX_MODEL_BYTES {
            return Err(VoiceModelError::DownloadFailed);
        }
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(destination)
            .map_err(|_| VoiceModelError::InstallationFailed)?;
        set_private_file_permissions(destination)?;
        let mut body = response.bytes_stream();
        let mut completed = 0_u64;
        while let Some(next) = tokio::select! {
            changed = cancelled.changed() => {
                let _ = changed;
                return Err(VoiceModelError::Cancelled);
            }
            next = timeout(DOWNLOAD_IDLE_TIMEOUT, body.next()) => {
                next.map_err(|_| VoiceModelError::DownloadFailed)?
            }
        } {
            let chunk = next.map_err(|_| VoiceModelError::DownloadFailed)?;
            completed = completed
                .checked_add(chunk.len() as u64)
                .ok_or(VoiceModelError::DownloadFailed)?;
            if completed > MAX_MODEL_BYTES || (total > 0 && completed > total) {
                return Err(VoiceModelError::DownloadFailed);
            }
            file.write_all(&chunk)
                .map_err(|_| VoiceModelError::DownloadFailed)?;
            emit(progress(
                operation_id,
                VoiceModelProgressState::Installing,
                completed,
                total,
                None,
            ));
        }
        if completed == 0 || (total > 0 && completed != total) {
            return Err(VoiceModelError::DownloadFailed);
        }
        file.sync_all()
            .map_err(|_| VoiceModelError::DownloadFailed)?;
        check_cancelled(cancelled)
    }

    pub(crate) fn model_path(&self) -> PathBuf {
        self.root.join("managed").join(MODEL_FILE)
    }

    fn validated_model_path(&self) -> Option<PathBuf> {
        let path = managed_directory_if_safe(&self.root)?.join(MODEL_FILE);
        valid_model(&path).then_some(path)
    }

    pub(crate) fn is_verified_model_path(&self, path: &Path) -> bool {
        self.validated_model_path().as_deref() == Some(path)
    }
}

fn progress(
    operation_id: &str,
    state: VoiceModelProgressState,
    completed_bytes: u64,
    total_bytes: u64,
    error_code: Option<&'static str>,
) -> VoiceModelProgress {
    VoiceModelProgress {
        operation_id: operation_id.to_owned(),
        state,
        completed_bytes,
        total_bytes,
        error_code,
    }
}

fn check_cancelled(cancelled: &watch::Receiver<bool>) -> Result<(), VoiceModelError> {
    if *cancelled.borrow() {
        Err(VoiceModelError::Cancelled)
    } else {
        Ok(())
    }
}

fn verify_sha256(path: &Path) -> Result<(), VoiceModelError> {
    let mut file = File::open(path).map_err(|_| VoiceModelError::InstallationFailed)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 32 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| VoiceModelError::InstallationFailed)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    let mut actual = String::with_capacity(64);
    for byte in digest.finalize() {
        let _ = write!(actual, "{byte:02x}");
    }
    if actual.eq_ignore_ascii_case(MODEL_SHA256) {
        Ok(())
    } else {
        Err(VoiceModelError::VerificationFailed)
    }
}

fn prepare_root(root: &Path) -> Result<(), VoiceModelError> {
    match fs::symlink_metadata(root) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            Err(VoiceModelError::InstallationFailed)
        }
        Ok(_) => set_private_directory_permissions(root),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(root).map_err(|_| VoiceModelError::InstallationFailed)?;
            set_private_directory_permissions(root)
        }
        Err(_) => Err(VoiceModelError::InstallationFailed),
    }
}

fn prepare_managed_directory(root: &Path) -> Result<PathBuf, VoiceModelError> {
    let directory = root.join("managed");
    match fs::symlink_metadata(&directory) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(VoiceModelError::InstallationFailed)
        }
        Ok(_) => set_private_directory_permissions(&directory)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&directory).map_err(|_| VoiceModelError::InstallationFailed)?;
            set_private_directory_permissions(&directory)?;
        }
        Err(_) => return Err(VoiceModelError::InstallationFailed),
    }
    Ok(directory)
}

fn managed_directory_if_safe(root: &Path) -> Option<PathBuf> {
    let root_metadata = fs::symlink_metadata(root).ok()?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return None;
    }
    let directory = root.join("managed");
    let metadata = fs::symlink_metadata(&directory).ok()?;
    (!metadata.file_type().is_symlink() && metadata.is_dir()).then_some(directory)
}

fn cleanup_stale_staging(root: &Path) -> Result<(), VoiceModelError> {
    for entry in fs::read_dir(root).map_err(|_| VoiceModelError::InstallationFailed)? {
        let entry = entry.map_err(|_| VoiceModelError::InstallationFailed)?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let kind = entry
            .file_type()
            .map_err(|_| VoiceModelError::InstallationFailed)?;
        if name.starts_with(STAGING_PREFIX) && kind.is_dir() && !kind.is_symlink() {
            fs::remove_dir_all(entry.path()).map_err(|_| VoiceModelError::InstallationFailed)?;
        }
    }
    Ok(())
}

fn is_regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
}

fn valid_model(path: &Path) -> bool {
    is_regular_file(path)
        && fs::metadata(path)
            .is_ok_and(|metadata| (1024 * 1024..=MAX_MODEL_BYTES).contains(&metadata.len()))
        && verify_sha256(path).is_ok()
}

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path) -> Result<(), VoiceModelError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|_| VoiceModelError::InstallationFailed)
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_path: &Path) -> Result<(), VoiceModelError> {
    Ok(())
}

#[cfg(unix)]
fn set_private_file_permissions(path: &Path) -> Result<(), VoiceModelError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|_| VoiceModelError::InstallationFailed)
}

#[cfg(not(unix))]
fn set_private_file_permissions(_path: &Path) -> Result<(), VoiceModelError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_model_metadata_is_https_and_checksum_bound() {
        assert!(MODEL_URL.starts_with("https://"));
        assert!(MODEL_URL.contains("/resolve/c521a4b02f422512d734391fdf08bb08c0862f68/"));
        assert_eq!(MODEL_SHA256.len(), 64);
        assert!(MODEL_SHA256.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[test]
    fn corrupted_preexisting_model_is_not_treated_as_installed() {
        let directory = tempfile::tempdir().unwrap();
        let model = directory.path().join(MODEL_FILE);
        fs::write(&model, vec![0_u8; 1024 * 1024]).unwrap();
        assert!(!valid_model(&model));
        assert_eq!(
            verify_sha256(&model),
            Err(VoiceModelError::VerificationFailed)
        );
    }

    #[tokio::test]
    async fn cancellation_is_observed_before_download() {
        let (sender, receiver) = watch::channel(false);
        sender.send(true).unwrap();
        assert_eq!(check_cancelled(&receiver), Err(VoiceModelError::Cancelled));
    }

    #[test]
    fn progress_allows_indeterminate_totals_and_preserves_download_totals() {
        let starting = progress("operation", VoiceModelProgressState::Installing, 0, 0, None);
        let downloading = progress(
            "operation",
            VoiceModelProgressState::Installing,
            128,
            512,
            None,
        );
        let verifying = progress("operation", VoiceModelProgressState::Verifying, 0, 0, None);
        assert_eq!(starting.total_bytes, 0);
        assert_eq!(verifying.total_bytes, 0);
        assert_eq!(
            (downloading.completed_bytes, downloading.total_bytes),
            (128, 512)
        );
    }
}
