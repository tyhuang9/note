use std::{
    ffi::OsString,
    fs::{self, OpenOptions},
    path::Path,
    process::Stdio,
    time::Duration,
};

use tokio::{process::Command, sync::watch, time::timeout};

use super::capture::{CapturedAudio, MIN_SAMPLES, TARGET_SAMPLE_RATE};

const TIMEOUT: Duration = Duration::from_secs(60);
const MAX_TRANSCRIPT_BYTES: u64 = 16 * 1024;
const MAX_TRANSCRIPT_CHARS: usize = 500;
const SESSION_PREFIX: &str = "note-voice-session-";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TranscriptionError {
    InvalidConfiguration,
    RecordingTooShort,
    TemporaryStorage,
    Process,
    TimedOut,
    Output,
    Cancelled,
}

pub(crate) async fn transcribe(
    cli: &Path,
    model: &Path,
    audio: CapturedAudio,
    mut cancelled: watch::Receiver<bool>,
    staging_root: &Path,
) -> Result<String, TranscriptionError> {
    let _timer =
        crate::performance::Timer::start(crate::performance::Operation::VoiceTranscription);
    if *cancelled.borrow() {
        return Err(TranscriptionError::Cancelled);
    }
    if audio.samples.len() < MIN_SAMPLES {
        return Err(TranscriptionError::RecordingTooShort);
    }
    if !is_regular_file(cli) || !is_regular_file(model) {
        return Err(TranscriptionError::InvalidConfiguration);
    }
    prepare_staging_root(staging_root)?;
    let directory = tempfile::Builder::new()
        .prefix(SESSION_PREFIX)
        .tempdir_in(staging_root)
        .map_err(|_| TranscriptionError::TemporaryStorage)?;
    private_directory(directory.path())?;
    let audio_path = directory.path().join("recording.wav");
    write_wav(&audio_path, &audio.samples)?;
    let output_prefix = directory.path().join("transcript");
    let output_path = directory.path().join("transcript.txt");
    let mut command = Command::new(cli);
    command
        .args(arguments(model, &audio_path, &output_prefix))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let mut child = command.spawn().map_err(|_| TranscriptionError::Process)?;
    let status = tokio::select! {
        result = timeout(TIMEOUT, child.wait()) => match result {
            Ok(result) => result.map_err(|_| TranscriptionError::Process)?,
            Err(_) => { let _ = child.kill().await; return Err(TranscriptionError::TimedOut); }
        },
        _ = wait_cancel(&mut cancelled) => { let _ = child.kill().await; return Err(TranscriptionError::Cancelled); }
    };
    if !status.success() || *cancelled.borrow() {
        return Err(if *cancelled.borrow() {
            TranscriptionError::Cancelled
        } else {
            TranscriptionError::Process
        });
    }
    read_transcript(&output_path)
}

pub(crate) fn prepare_staging_root(root: &Path) -> Result<(), TranscriptionError> {
    match fs::symlink_metadata(root) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(TranscriptionError::TemporaryStorage)
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(root).map_err(|_| TranscriptionError::TemporaryStorage)?;
        }
        Err(_) => return Err(TranscriptionError::TemporaryStorage),
    }
    private_directory(root)?;
    for entry in fs::read_dir(root).map_err(|_| TranscriptionError::TemporaryStorage)? {
        let entry = entry.map_err(|_| TranscriptionError::TemporaryStorage)?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let kind = entry
            .file_type()
            .map_err(|_| TranscriptionError::TemporaryStorage)?;
        if name.starts_with(SESSION_PREFIX) && kind.is_dir() && !kind.is_symlink() {
            fs::remove_dir_all(entry.path()).map_err(|_| TranscriptionError::TemporaryStorage)?;
        }
    }
    Ok(())
}

async fn wait_cancel(cancelled: &mut watch::Receiver<bool>) {
    if *cancelled.borrow() {
        return;
    }
    while cancelled.changed().await.is_ok() {
        if *cancelled.borrow() {
            return;
        }
    }
}

fn arguments(model: &Path, audio: &Path, output: &Path) -> Vec<OsString> {
    vec![
        "-m".into(),
        model.as_os_str().to_owned(),
        "-f".into(),
        audio.as_os_str().to_owned(),
        "-l".into(),
        "en".into(),
        "-nt".into(),
        "-np".into(),
        "-otxt".into(),
        "-of".into(),
        output.as_os_str().to_owned(),
    ]
}

fn write_wav(path: &Path, samples: &[i16]) -> Result<(), TranscriptionError> {
    let file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|_| TranscriptionError::TemporaryStorage)?;
    private_file(path)?;
    let mut writer = hound::WavWriter::new(
        file,
        hound::WavSpec {
            channels: 1,
            sample_rate: TARGET_SAMPLE_RATE,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        },
    )
    .map_err(|_| TranscriptionError::TemporaryStorage)?;
    for sample in samples {
        writer
            .write_sample(*sample)
            .map_err(|_| TranscriptionError::TemporaryStorage)?;
    }
    writer
        .finalize()
        .map_err(|_| TranscriptionError::TemporaryStorage)
}

fn read_transcript(path: &Path) -> Result<String, TranscriptionError> {
    let metadata = path.metadata().map_err(|_| TranscriptionError::Output)?;
    if !metadata.is_file() || metadata.len() > MAX_TRANSCRIPT_BYTES {
        return Err(TranscriptionError::Output);
    }
    let value = String::from_utf8(fs::read(path).map_err(|_| TranscriptionError::Output)?)
        .map_err(|_| TranscriptionError::Output)?;
    let value = value.trim().to_owned();
    if value.is_empty() || value.chars().count() > MAX_TRANSCRIPT_CHARS {
        Err(TranscriptionError::Output)
    } else {
        Ok(value)
    }
}

fn is_regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
}

#[cfg(unix)]
fn private_directory(path: &Path) -> Result<(), TranscriptionError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|_| TranscriptionError::TemporaryStorage)
}
#[cfg(not(unix))]
fn private_directory(_path: &Path) -> Result<(), TranscriptionError> {
    Ok(())
}
#[cfg(unix)]
fn private_file(path: &Path) -> Result<(), TranscriptionError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|_| TranscriptionError::TemporaryStorage)
}
#[cfg(not(unix))]
fn private_file(_path: &Path) -> Result<(), TranscriptionError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cli_uses_fixed_arguments_without_a_shell() {
        let arguments = arguments(
            Path::new("model; bad"),
            Path::new("audio.wav"),
            Path::new("output"),
        );
        assert_eq!(arguments[0], OsString::from("-m"));
        assert_eq!(arguments[1], OsString::from("model; bad"));
        assert!(arguments.contains(&OsString::from("-otxt")));
    }
    #[test]
    fn wav_is_bounded_mono_sixteen_kilohertz() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("audio.wav");
        write_wav(&path, &[0, 1]).unwrap();
        let reader = hound::WavReader::open(path).unwrap();
        assert_eq!(reader.spec().channels, 1);
        assert_eq!(reader.spec().sample_rate, TARGET_SAMPLE_RATE);
    }
}
