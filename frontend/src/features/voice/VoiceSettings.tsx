import { useCallback, useEffect, useRef, useState } from "react";
import {
  isVoiceSettingsClientError,
  voiceSettingsClient,
  type VoiceMicrophonesStatus,
  type VoiceModelProgressEvent,
  type VoiceModelStatus,
  type VoiceShortcutsStatus,
} from "../../native/voiceSettingsClient";
import "./VoiceSettings.css";

type LoadStatus = "loading" | "ready" | "unavailable" | "error";
type ModelAction = "install" | "cancel" | "remove" | null;

function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Voice settings could not complete that request. Try again.";
}

function statusMessage(status: VoiceModelStatus) {
  switch (status.state) {
    case "installed":
      return status.transcriptionAvailable
        ? "The downloaded model is ready for transcription."
        : "The model is installed, but the transcription runtime is not available yet.";
    case "installing":
      return "Downloading the voice model…";
    case "cancelled":
      return "Model download was cancelled.";
    case "failed":
      return "Model download failed. Retry the download.";
    case "unavailable":
      return "Voice model installation is unavailable on this device.";
    default:
      return "Download the local voice model to prepare transcription.";
  }
}

function formatBytes(value: number) {
  if (value < 1_000_000) return `${Math.ceil(value / 1_000)} KB`;
  return `${(value / 1_000_000).toFixed(value >= 100_000_000 ? 0 : 1)} MB`;
}

function isTerminalProgress(event: VoiceModelProgressEvent) {
  return event.state === "installed" || event.state === "cancelled" || event.state === "failed";
}

export function VoiceSettings() {
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("loading");
  const [loadMessage, setLoadMessage] = useState("Loading voice settings…");
  const [microphones, setMicrophones] = useState<VoiceMicrophonesStatus | null>(null);
  const [model, setModel] = useState<VoiceModelStatus | null>(null);
  const [shortcuts, setShortcuts] = useState<VoiceShortcutsStatus | null>(null);
  const [progress, setProgress] = useState<VoiceModelProgressEvent | null>(null);
  const [actionError, setActionError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [isSelectingMicrophone, setIsSelectingMicrophone] = useState(false);
  const [isRegisteringShortcut, setIsRegisteringShortcut] = useState(false);
  const [modelAction, setModelAction] = useState<ModelAction>(null);
  const activeOperationIdRef = useRef<string | null>(null);
  const isModelOperationActiveRef = useRef(false);

  const load = useCallback(async () => {
    setLoadStatus("loading");
    setLoadMessage("Loading voice settings…");
    setActionError("");
    try {
      const [nextMicrophones, nextModel, nextShortcuts] = await Promise.all([
        voiceSettingsClient.microphonesGet(),
        voiceSettingsClient.modelStatus(),
        voiceSettingsClient.shortcutsStatusGet(),
      ]);
      setMicrophones(nextMicrophones);
      setModel(nextModel);
      setShortcuts(nextShortcuts);
      setProgress(null);
      activeOperationIdRef.current = null;
      isModelOperationActiveRef.current = nextModel.state === "installing";
      setLoadStatus("ready");
      setAnnouncement("Voice settings loaded.");
    } catch (error) {
      setLoadStatus(
        isVoiceSettingsClientError(error) && error.code === "voice_settings_unavailable"
          ? "unavailable"
          : "error",
      );
      setLoadMessage(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (loadStatus !== "ready") return;
    let disposed = false;
    let unlisten: (() => void | Promise<void>) | undefined;

    function disposeListener(listener: () => void | Promise<void>) {
      void Promise.resolve(listener()).catch(() => undefined);
    }

    function applyProgress(event: VoiceModelProgressEvent) {
      if (disposed || !isModelOperationActiveRef.current) return;
      const activeOperationId = activeOperationIdRef.current;
      if (activeOperationId && activeOperationId !== event.operationId) return;
      if (!activeOperationId) activeOperationIdRef.current = event.operationId;

      setProgress(event);
      setModel((current) => current
        ? {
            ...current,
            state: event.state === "verifying" ? "installing" : event.state,
            ...(event.errorCode ? { errorCode: event.errorCode } : {}),
          }
        : current);
      setAnnouncement(
        event.state === "verifying"
          ? "Download complete. Verifying the voice model…"
          : event.state === "installed"
            ? "Voice model installed."
            : event.state === "cancelled"
              ? "Model download was cancelled."
              : event.state === "failed"
                ? "Model download failed."
                : "Downloading the voice model…",
      );

      if (isTerminalProgress(event)) {
        isModelOperationActiveRef.current = false;
        setProgress(null);
        void voiceSettingsClient.modelStatus()
          .then((next) => {
            if (!disposed && activeOperationIdRef.current === event.operationId) {
              setModel(next);
            }
          })
          .catch(() => undefined);
      }
    }

    void voiceSettingsClient.listenToModelProgress(applyProgress)
      .then((listener) => {
        if (disposed) disposeListener(listener);
        else unlisten = listener;
      })
      .catch(() => {
        if (!disposed) setActionError("Model progress updates are unavailable.");
      });

    return () => {
      disposed = true;
      if (unlisten) disposeListener(unlisten);
    };
  }, [loadStatus]);

  async function selectMicrophone(microphoneId: string) {
    if (isSelectingMicrophone) return;
    setActionError("");
    setIsSelectingMicrophone(true);
    try {
      const next = await voiceSettingsClient.microphoneSelect(microphoneId);
      setMicrophones(next);
      setAnnouncement(`Microphone changed to ${next.devices.find((device) => device.selected)?.label ?? "the selected device"}.`);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setIsSelectingMicrophone(false);
    }
  }

  async function registerShortcut() {
    if (isRegisteringShortcut) return;
    setActionError("");
    setIsRegisteringShortcut(true);
    try {
      const next = await voiceSettingsClient.shortcutsRegister();
      setShortcuts(next);
      setAnnouncement(next.holdToTalk.message);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setIsRegisteringShortcut(false);
    }
  }

  async function runModelAction(action: Exclude<ModelAction, null>) {
    if (modelAction) return;
    setActionError("");
    setModelAction(action);
    if (action === "install") {
      activeOperationIdRef.current = null;
      isModelOperationActiveRef.current = true;
      setProgress(null);
      setModel((current) => current ? { ...current, state: "installing", errorCode: undefined } : current);
      setAnnouncement("Starting the voice model download…");
    }
    if (action === "cancel") {
      activeOperationIdRef.current = null;
      isModelOperationActiveRef.current = false;
      setProgress(null);
    }
    try {
      const next = action === "install"
        ? await voiceSettingsClient.modelInstall()
        : action === "cancel"
          ? await voiceSettingsClient.modelCancelInstall()
          : await voiceSettingsClient.modelRemove();
      setModel(next);
      if (action !== "install" || next.state !== "installing") {
        isModelOperationActiveRef.current = next.state === "installing";
      }
      setAnnouncement(statusMessage(next));
    } catch (error) {
      isModelOperationActiveRef.current = false;
      setModel((current) => action === "install" && current
        ? { ...current, state: "failed" }
        : current);
      setActionError(errorMessage(error));
    } finally {
      setModelAction(null);
    }
  }

  if (loadStatus !== "ready" || !microphones || !model || !shortcuts) {
    return (
      <section className="voice-settings-shell voice-settings-state" aria-busy={loadStatus === "loading"} aria-labelledby="voice-settings-title">
        <p className="workspace-system-eyebrow">Settings</p>
        <h1 id="voice-settings-title">Voice settings</h1>
        <div className={loadStatus === "loading" ? "voice-settings-live" : "voice-settings-alert"} role={loadStatus === "loading" ? "status" : "alert"}>
          {loadMessage}
        </div>
        {loadStatus !== "loading" ? <button className="voice-settings-primary" onClick={() => void load()} type="button">Retry loading</button> : null}
      </section>
    );
  }

  const selectedMicrophoneId = microphones.selectedId ?? "";
  const downloadProgress = progress && activeOperationIdRef.current === progress.operationId
    ? progress
    : null;
  const isDownloading = model.state === "installing";
  const isIndeterminateProgress = downloadProgress?.totalBytes === 0;
  const holdToTalk = shortcuts.holdToTalk;
  const phaseSevenActions = [
    ["Assistant", shortcuts.assistant],
    ["Quick capture", shortcuts.quickCapture],
    ["Agenda", shortcuts.agenda],
    ["Widget", shortcuts.widget],
  ] as const;

  return (
    <section className="voice-settings-shell" aria-busy={Boolean(modelAction || isSelectingMicrophone || isRegisteringShortcut)} aria-labelledby="voice-settings-title">
      <header className="voice-settings-header">
        <div>
          <p className="workspace-system-eyebrow">Settings</p>
          <h1 id="voice-settings-title">Voice settings</h1>
          <p>Choose a microphone, prepare local transcription, and manage the hold-to-talk shortcut.</p>
        </div>
        <button className="voice-settings-secondary" onClick={() => void load()} type="button">Refresh voice settings</button>
      </header>

      {actionError ? <div className="voice-settings-alert" role="alert">{actionError}</div> : null}
      <div className="voice-settings-live" aria-live="polite" role="status">{announcement || "Voice settings are ready."}</div>

      <section className="voice-settings-card" aria-labelledby="voice-microphone-title">
        <div className="voice-settings-section-heading">
          <div><p className="voice-settings-kicker">Input</p><h2 id="voice-microphone-title">Microphone</h2></div>
          <span className={`voice-settings-badge ${microphones.available ? "is-ready" : "is-unavailable"}`}>{microphones.available ? "Available" : "Unavailable"}</span>
        </div>
        <p>{microphones.limitation}</p>
        {microphones.available && microphones.devices.length ? <label className="voice-settings-field">
          <span>Preferred microphone</span>
          <select
            aria-describedby={microphones.selectionNotice ? "voice-microphone-notice" : undefined}
            disabled={isSelectingMicrophone}
            onChange={(event) => void selectMicrophone(event.currentTarget.value)}
            value={selectedMicrophoneId}
          >
            <option disabled value="">Choose a microphone</option>
            {microphones.devices.map((device) => <option key={device.id} value={device.id}>{device.label}</option>)}
          </select>
        </label> : <p className="voice-settings-muted">No selectable microphone is currently available.</p>}
        {microphones.selectionNotice ? <p className="voice-settings-notice" id="voice-microphone-notice" role="status">{microphones.selectionNotice}</p> : null}
      </section>

      <section className="voice-settings-card" aria-labelledby="voice-model-title">
        <div className="voice-settings-section-heading">
          <div><p className="voice-settings-kicker">Local transcription</p><h2 id="voice-model-title">{model.displayName}</h2></div>
          <span className={`voice-settings-badge is-${model.state}`}>{model.state === "installed" ? "Installed" : model.state}</span>
        </div>
        <p>{statusMessage(model)}</p>
        {downloadProgress ? <div className="voice-settings-progress">
          <label htmlFor="voice-model-progress">{downloadProgress.state === "verifying" ? "Verifying downloaded model" : "Downloading voice model"}</label>
          <progress
            id="voice-model-progress"
            {...(isIndeterminateProgress
              ? { "aria-label": "Voice model progress is indeterminate" }
              : { max: downloadProgress.totalBytes, value: downloadProgress.completedBytes })}
          >
            {isIndeterminateProgress
              ? "Progress is indeterminate"
              : `${Math.round((downloadProgress.completedBytes / downloadProgress.totalBytes) * 100)}%`}
          </progress>
          <span>{isIndeterminateProgress
            ? "Preparing the voice model. Download size is not available yet."
            : `${formatBytes(downloadProgress.completedBytes)} of ${formatBytes(downloadProgress.totalBytes)}`}</span>
        </div> : null}
        {model.state === "failed" && model.errorCode ? <p className="voice-settings-model-error" role="alert">Download failed ({model.errorCode}).</p> : null}
        {model.state === "installed" && !model.transcriptionAvailable ? <p className="voice-settings-notice">The download is retained locally; live transcription will become available when its native runtime is added.</p> : null}
        <div className="voice-settings-actions">
          {isDownloading ? <button className="voice-settings-secondary" disabled={modelAction === "cancel"} onClick={() => void runModelAction("cancel")} type="button">{modelAction === "cancel" ? "Cancelling…" : "Cancel download"}</button> : null}
          {model.state === "installed" ? <button className="voice-settings-danger" disabled={Boolean(modelAction)} onClick={() => void runModelAction("remove")} type="button">{modelAction === "remove" ? "Removing…" : "Remove downloaded model"}</button> : null}
          {model.state !== "installed" && !isDownloading && model.state !== "unavailable" ? <button className="voice-settings-primary" disabled={Boolean(modelAction)} onClick={() => void runModelAction("install")} type="button">{modelAction === "install" ? "Starting download…" : model.state === "failed" ? "Retry download" : "Download model"} <span className="voice-settings-download-size">({formatBytes(model.expectedDownloadBytes)})</span></button> : null}
        </div>
      </section>

      <section className="voice-settings-card" aria-labelledby="voice-shortcuts-title">
        <div className="voice-settings-section-heading">
          <div><p className="voice-settings-kicker">Global shortcut</p><h2 id="voice-shortcuts-title">Hold to talk</h2></div>
          <span className={`voice-settings-badge is-${holdToTalk.status}`}>{holdToTalk.status}</span>
        </div>
        <p><kbd>{holdToTalk.key}</kbd> — {holdToTalk.message}</p>
        {holdToTalk.status !== "registered" && holdToTalk.status !== "unavailable" ? <button className="voice-settings-primary" disabled={isRegisteringShortcut} onClick={() => void registerShortcut()} type="button">{isRegisteringShortcut ? "Registering…" : holdToTalk.status === "conflict" ? "Retry hold-to-talk registration" : "Register hold-to-talk"}</button> : null}
        <div className="voice-settings-deferred" aria-label="Deferred voice actions">
          <h3>Other voice actions</h3>
          <ul>
            {phaseSevenActions.map(([label, action]) => <li key={label}><strong>{label}</strong><span>{action.message}</span></li>)}
          </ul>
        </div>
      </section>
    </section>
  );
}
