use std::{
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant},
};

#[cfg(desktop)]
use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    Device, SampleFormat, Stream, StreamConfig,
};
use uuid::Uuid;

pub(crate) const TARGET_SAMPLE_RATE: u32 = 16_000;
pub(crate) const MAX_DURATION_SECONDS: u32 = 30;
pub(crate) const MIN_SAMPLES: usize = TARGET_SAMPLE_RATE as usize / 4;
const MAX_SAMPLES: usize = TARGET_SAMPLE_RATE as usize * MAX_DURATION_SECONDS as usize;
const WORKER_REPLY_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CaptureError {
    Unsupported,
    Busy,
    NotActive,
    StartFailed,
    Internal,
}

#[derive(Clone, Debug)]
pub(crate) struct CapturedAudio {
    pub(crate) samples: Vec<i16>,
}

#[derive(Clone, Debug)]
pub(crate) struct CaptureDeadlineCompletion {
    pub(crate) id: Uuid,
    pub(crate) audio: CapturedAudio,
}

pub(crate) type CaptureDeadlineReceiver =
    mpsc::Receiver<Result<CaptureDeadlineCompletion, CaptureError>>;

pub(crate) enum CaptureStop {
    Stopped(Uuid, CapturedAudio),
    Deadline(CaptureDeadlineCompletion),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MicrophoneInfo {
    pub(crate) key: String,
    pub(crate) label: String,
}

pub(crate) struct CaptureController {
    commands: mpsc::Sender<WorkerCommand>,
}

impl CaptureController {
    pub(crate) fn new() -> Self {
        let (commands, receiver) = mpsc::channel();
        let _ = std::thread::Builder::new()
            .name("note-native-audio-capture".into())
            .spawn(move || capture_worker(receiver));
        Self { commands }
    }

    pub(crate) fn enumerate(&self) -> Result<Vec<MicrophoneInfo>, CaptureError> {
        self.request(|reply| WorkerCommand::Enumerate { reply })?
    }

    pub(crate) fn start(
        &self,
        id: Uuid,
        microphone_key: Option<String>,
    ) -> Result<CaptureDeadlineReceiver, CaptureError> {
        let (deadline_reply, deadline_receiver) = mpsc::sync_channel(1);
        self.request(|reply| WorkerCommand::Start {
            id,
            microphone_key,
            deadline_reply,
            reply,
        })??;
        Ok(deadline_receiver)
    }

    pub(crate) fn stop(&self) -> Result<CaptureStop, CaptureError> {
        self.request(|reply| WorkerCommand::Stop { reply })?
    }

    pub(crate) fn cancel(&self) -> Result<(), CaptureError> {
        self.request(|reply| WorkerCommand::Cancel { reply })?
    }

    pub(crate) fn supported(&self) -> bool {
        cfg!(desktop)
    }

    pub(crate) fn wait_for_deadline(
        receiver: CaptureDeadlineReceiver,
    ) -> Result<CaptureDeadlineCompletion, CaptureError> {
        receiver.recv().map_err(|_| CaptureError::NotActive)?
    }

    fn request<T: Send + 'static>(
        &self,
        command: impl FnOnce(mpsc::SyncSender<T>) -> WorkerCommand,
    ) -> Result<T, CaptureError> {
        let (reply, response) = mpsc::sync_channel(1);
        self.commands
            .send(command(reply))
            .map_err(|_| CaptureError::Internal)?;
        response
            .recv_timeout(WORKER_REPLY_TIMEOUT)
            .map_err(|_| CaptureError::Internal)
    }
}

enum WorkerCommand {
    Enumerate {
        reply: mpsc::SyncSender<Result<Vec<MicrophoneInfo>, CaptureError>>,
    },
    Start {
        id: Uuid,
        microphone_key: Option<String>,
        deadline_reply: mpsc::SyncSender<Result<CaptureDeadlineCompletion, CaptureError>>,
        reply: mpsc::SyncSender<Result<(), CaptureError>>,
    },
    Stop {
        reply: mpsc::SyncSender<Result<CaptureStop, CaptureError>>,
    },
    Cancel {
        reply: mpsc::SyncSender<Result<(), CaptureError>>,
    },
}

#[cfg(desktop)]
struct ActiveCapture {
    id: Uuid,
    deadline: Instant,
    stream: Stream,
    buffer: Arc<Mutex<SampleBuffer>>,
    deadline_reply: mpsc::SyncSender<Result<CaptureDeadlineCompletion, CaptureError>>,
}

fn capture_worker(receiver: mpsc::Receiver<WorkerCommand>) {
    #[cfg(desktop)]
    let mut active: Option<ActiveCapture> = None;
    #[cfg(desktop)]
    let mut deadline_completion: Option<CaptureDeadlineCompletion> = None;
    loop {
        #[cfg(desktop)]
        let command = match active.as_ref() {
            Some(capture) => match receiver
                .recv_timeout(capture.deadline.saturating_duration_since(Instant::now()))
            {
                Ok(command) => Some(command),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if let Some(capture) = active.take() {
                        let deadline_reply = capture.deadline_reply.clone();
                        let result = finish_capture(capture)
                            .map(|(id, audio)| CaptureDeadlineCompletion { id, audio });
                        if let Ok(completion) = &result {
                            deadline_completion = Some(completion.clone());
                        }
                        let _ = deadline_reply.send(result);
                    }
                    None
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            },
            None => match receiver.recv() {
                Ok(command) => Some(command),
                Err(_) => break,
            },
        };
        #[cfg(not(desktop))]
        let command = match receiver.recv() {
            Ok(command) => Some(command),
            Err(_) => break,
        };

        let Some(command) = command else { continue };
        match command {
            WorkerCommand::Enumerate { reply } => {
                #[cfg(desktop)]
                let result = enumerate_microphones();
                #[cfg(not(desktop))]
                let result = Err(CaptureError::Unsupported);
                let _ = reply.send(result);
            }
            WorkerCommand::Start {
                id,
                microphone_key,
                deadline_reply,
                reply,
            } => {
                #[cfg(desktop)]
                let result = if active.is_some() {
                    Err(CaptureError::Busy)
                } else {
                    CaptureSession::start(microphone_key.as_deref()).map(|(stream, buffer)| {
                        deadline_completion = None;
                        active = Some(ActiveCapture {
                            id,
                            deadline: Instant::now()
                                + Duration::from_secs(u64::from(MAX_DURATION_SECONDS)),
                            stream,
                            buffer,
                            deadline_reply,
                        });
                    })
                };
                #[cfg(not(desktop))]
                let result = Err(CaptureError::Unsupported);
                let _ = reply.send(result);
            }
            WorkerCommand::Stop { reply } => {
                #[cfg(desktop)]
                let result = active
                    .take()
                    .ok_or(CaptureError::NotActive)
                    .and_then(finish_capture)
                    .map(|(id, audio)| CaptureStop::Stopped(id, audio))
                    .or_else(|error| match deadline_completion.take() {
                        Some(completion) => Ok(CaptureStop::Deadline(completion)),
                        None => Err(error),
                    });
                #[cfg(not(desktop))]
                let result = Err(CaptureError::Unsupported);
                let _ = reply.send(result);
            }
            WorkerCommand::Cancel { reply } => {
                #[cfg(desktop)]
                {
                    active = None;
                    deadline_completion = None;
                }
                let _ = reply.send(Ok(()));
            }
        }
    }
}

#[cfg(desktop)]
fn finish_capture(capture: ActiveCapture) -> Result<(Uuid, CapturedAudio), CaptureError> {
    drop(capture.stream);
    let samples = capture
        .buffer
        .lock()
        .map_err(|_| CaptureError::Internal)?
        .samples
        .clone();
    Ok((capture.id, CapturedAudio { samples }))
}

#[cfg(desktop)]
struct CaptureSession;

#[cfg(desktop)]
impl CaptureSession {
    fn start(
        microphone_key: Option<&str>,
    ) -> Result<(Stream, Arc<Mutex<SampleBuffer>>), CaptureError> {
        let device = match microphone_key {
            Some(key) => enumerate_devices()?
                .into_iter()
                .find(|(microphone, _)| microphone.key == key)
                .map(|(_, device)| device)
                .ok_or(CaptureError::StartFailed)?,
            None => cpal::default_host()
                .default_input_device()
                .ok_or(CaptureError::Unsupported)?,
        };
        let supported = device
            .default_input_config()
            .map_err(|_| CaptureError::StartFailed)?;
        let sample_format = supported.sample_format();
        let config: StreamConfig = supported.into();
        let buffer = Arc::new(Mutex::new(SampleBuffer::new(
            config.sample_rate.0,
            usize::from(config.channels),
        )?));
        let stream = build_stream(&device, &config, sample_format, buffer.clone())?;
        stream.play().map_err(|_| CaptureError::StartFailed)?;
        Ok((stream, buffer))
    }
}

#[cfg(desktop)]
fn enumerate_microphones() -> Result<Vec<MicrophoneInfo>, CaptureError> {
    enumerate_devices().map(|devices| {
        devices
            .into_iter()
            .map(|(microphone, _)| microphone)
            .collect()
    })
}

#[cfg(desktop)]
fn enumerate_devices() -> Result<Vec<(MicrophoneInfo, Device)>, CaptureError> {
    let devices = cpal::default_host()
        .input_devices()
        .map_err(|_| CaptureError::StartFailed)?;
    let mut occurrences = std::collections::HashMap::<String, usize>::new();
    let mut microphones = Vec::new();
    for device in devices {
        let name = device
            .name()
            .unwrap_or_else(|_| "Unnamed microphone".to_owned());
        let occurrence = occurrences.entry(name.clone()).or_default();
        let key = format!("{}\u{1f}{name}", *occurrence);
        *occurrence += 1;
        let label = if *occurrence == 1 {
            name
        } else {
            format!("{name} ({})", *occurrence)
        };
        microphones.push((MicrophoneInfo { key, label }, device));
    }
    Ok(microphones)
}

#[cfg(desktop)]
fn build_stream(
    device: &Device,
    config: &StreamConfig,
    format: SampleFormat,
    buffer: Arc<Mutex<SampleBuffer>>,
) -> Result<Stream, CaptureError> {
    match format {
        SampleFormat::I8 => {
            build_typed_stream(device, config, buffer, |value: i8| value as f32 / 127.0)
        }
        SampleFormat::I16 => build_typed_stream(device, config, buffer, |value: i16| {
            value as f32 / i16::MAX as f32
        }),
        SampleFormat::I32 => build_typed_stream(device, config, buffer, |value: i32| {
            value as f32 / i32::MAX as f32
        }),
        SampleFormat::U8 => build_typed_stream(device, config, buffer, |value: u8| {
            (value as f32 - 128.0) / 127.0
        }),
        SampleFormat::U16 => build_typed_stream(device, config, buffer, |value: u16| {
            (value as f32 - 32768.0) / 32767.0
        }),
        SampleFormat::U32 => build_typed_stream(device, config, buffer, |value: u32| {
            (value as f64 / u32::MAX as f64 * 2.0 - 1.0) as f32
        }),
        SampleFormat::F32 => build_typed_stream(device, config, buffer, |value: f32| value),
        _ => Err(CaptureError::Unsupported),
    }
}

#[cfg(desktop)]
fn build_typed_stream<T>(
    device: &Device,
    config: &StreamConfig,
    buffer: Arc<Mutex<SampleBuffer>>,
    convert: fn(T) -> f32,
) -> Result<Stream, CaptureError>
where
    T: cpal::SizedSample + Copy + Send + 'static,
{
    let channels = usize::from(config.channels);
    let failed = buffer.clone();
    device
        .build_input_stream(
            config,
            move |data: &[T], _| {
                if let Ok(mut buffer) = buffer.lock() {
                    buffer.push_interleaved(data, channels, convert);
                }
            },
            move |_| {
                if let Ok(mut buffer) = failed.lock() {
                    buffer.failed = true;
                }
            },
            None,
        )
        .map_err(|_| CaptureError::StartFailed)
}

#[derive(Debug)]
struct SampleBuffer {
    samples: Vec<i16>,
    source_rate: u64,
    phase: u64,
    max_samples: usize,
    failed: bool,
}

impl SampleBuffer {
    fn new(source_rate: u32, channels: usize) -> Result<Self, CaptureError> {
        if source_rate == 0 || channels == 0 {
            return Err(CaptureError::StartFailed);
        }
        Ok(Self {
            samples: Vec::with_capacity(MAX_SAMPLES),
            source_rate: u64::from(source_rate),
            phase: 0,
            max_samples: MAX_SAMPLES,
            failed: false,
        })
    }

    fn push_interleaved<T>(&mut self, data: &[T], channels: usize, convert: fn(T) -> f32)
    where
        T: Copy,
    {
        if channels == 0 || self.failed || self.samples.len() >= self.max_samples {
            return;
        }
        for frame in data.chunks_exact(channels) {
            let mono = frame.iter().copied().map(convert).sum::<f32>() / channels as f32;
            self.phase = self.phase.saturating_add(u64::from(TARGET_SAMPLE_RATE));
            while self.phase >= self.source_rate && self.samples.len() < self.max_samples {
                self.samples.push(normalize_sample(mono));
                self.phase -= self.source_rate;
            }
            if self.samples.len() == self.max_samples {
                break;
            }
        }
    }
}

fn normalize_sample(value: f32) -> i16 {
    if !value.is_finite() {
        return 0;
    }
    let value = value.clamp(-1.0, 1.0);
    if value <= -1.0 {
        i16::MIN
    } else {
        (value * i16::MAX as f32).round() as i16
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_downmixes_and_resamples_to_bounded_mono_sixteen_kilohertz() {
        let mut buffer = SampleBuffer::new(48_000, 2).unwrap();
        buffer.push_interleaved(&[1.0_f32, -1.0, 0.5, 0.5, 1.0, 1.0], 2, |value| value);
        assert_eq!(buffer.samples, vec![i16::MAX]);

        let mut bounded = SampleBuffer::new(TARGET_SAMPLE_RATE, 1).unwrap();
        bounded.push_interleaved(&vec![0.25_f32; MAX_SAMPLES + 1], 1, |value| value);
        assert_eq!(bounded.samples.len(), MAX_SAMPLES);
    }
}
