import { useCallback, useEffect, useRef, useState } from "react";
import {
  isVoiceNativeAvailable,
  isVoiceNativeClientError,
  type VoiceMode,
  type VoiceProposal,
  type VoiceSession,
  type VoiceStatus,
  voiceClient,
} from "../native/voiceClient";

type QuickCommandPhase = "idle" | "recording" | "transcribing" | "result" | "error";
type ActiveSession = Pick<VoiceSession, "generation" | "sessionId" | "mode">;

const modes: Array<{ label: string; value: VoiceMode }> = [
  { label: "Assistant command", value: "assistant_command" },
  { label: "Note dictation", value: "note_dictation" },
  { label: "Quick-capture note", value: "quick_capture" },
];

function modeLabel(mode: VoiceMode) {
  return modes.find((item) => item.value === mode)?.label ?? "Assistant command";
}

function elapsedLabel(seconds: number) {
  return `Recording ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function safeErrorMessage(error: unknown) {
  if (isVoiceNativeClientError(error)) return error.message;
  return "Native voice could not complete that request. Try again.";
}

export default function QuickCommandSurface() {
  const [mode, setMode] = useState<VoiceMode>("assistant_command");
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<QuickCommandPhase>("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [result, setResult] = useState<string | null>(null);
  const [proposal, setProposal] = useState<VoiceProposal | null>(null);
  const [error, setError] = useState<string | null>(
    isVoiceNativeAvailable() ? null : "Native voice is only available in the Note desktop app.",
  );
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus | null>(null);
  const activeSession = useRef<ActiveSession | null>(null);
  const textInputRef = useRef<HTMLInputElement | null>(null);
  const operation = useRef(0);
  const lastGeneration = useRef(-1);
  const recordingStartedAt = useRef<number | null>(null);
  const nativeAvailable = isVoiceNativeAvailable();
  const canRecord = Boolean(
    nativeAvailable && voiceStatus?.microphoneCapture.available && voiceStatus.transcription.available,
  );

  const resetSession = useCallback(() => {
    activeSession.current = null;
    recordingStartedAt.current = null;
    setElapsedSeconds(0);
  }, []);

  const startRecording = useCallback(async () => {
    if (!canRecord || phase === "recording" || phase === "transcribing") return;
    const currentOperation = ++operation.current;
    resetSession();
    setError(null);
    setResult(null);
    setProposal(null);
    setPhase("recording");

    try {
      const session = await voiceClient.start(mode);
      if (currentOperation !== operation.current) {
        if (session.state === "recording") void voiceClient.cancel(session.sessionId).catch(() => undefined);
        return;
      }
      lastGeneration.current = Math.max(lastGeneration.current, session.generation);
      if (session.state !== "recording") {
        resetSession();
        setPhase("error");
        setError("Native voice is unavailable. Check microphone and voice configuration.");
        return;
      }
      activeSession.current = session;
      recordingStartedAt.current = Date.now();
      setElapsedSeconds(0);
    } catch (requestError) {
      if (currentOperation !== operation.current) return;
      resetSession();
      setPhase("error");
      setError(safeErrorMessage(requestError));
    }
  }, [canRecord, mode, phase, resetSession]);

  const stopRecording = useCallback(async () => {
    const current = activeSession.current;
    if (!current || phase !== "recording") return;
    const currentOperation = ++operation.current;
    recordingStartedAt.current = null;
    setPhase("transcribing");

    try {
      const session = await voiceClient.stop(current.sessionId);
      if (currentOperation !== operation.current) return;
      if (session.generation !== current.generation || session.sessionId !== current.sessionId || session.mode !== current.mode) {
        throw new Error("Mismatched voice session.");
      }
      if (session.state === "cancelled") {
        resetSession();
        setPhase("idle");
      } else if (session.state === "timed_out") {
        resetSession();
        setPhase("error");
        setError("Recording reached the 30-second limit. Try a shorter recording.");
      } else if (session.state === "unavailable") {
        resetSession();
        setPhase("error");
        setError("Native voice is unavailable. Check microphone and voice configuration.");
      }
    } catch (requestError) {
      if (currentOperation !== operation.current) return;
      resetSession();
      setPhase("error");
      setError(safeErrorMessage(requestError));
    }
  }, [phase, resetSession]);

  const cancelRecording = useCallback(async () => {
    const current = activeSession.current;
    const currentOperation = ++operation.current;
    if (!current) {
      resetSession();
      setPhase("idle");
      return;
    }
    recordingStartedAt.current = null;
    try {
      const session = await voiceClient.cancel(current.sessionId);
      if (currentOperation !== operation.current) return;
      if (session.generation !== current.generation || session.sessionId !== current.sessionId || session.mode !== current.mode) {
        throw new Error("Mismatched voice session.");
      }
      lastGeneration.current = Math.max(lastGeneration.current, session.generation);
      resetSession();
      setPhase("idle");
    } catch (requestError) {
      if (currentOperation !== operation.current) return;
      resetSession();
      setPhase("error");
      setError(safeErrorMessage(requestError));
    }
  }, [resetSession]);

  const createTypedProposal = useCallback(async () => {
    if (!nativeAvailable || phase === "recording" || phase === "transcribing") return;
    const currentOperation = ++operation.current;
    setError(null);
    setResult(null);
    setProposal(null);
    try {
      const nextProposal = await voiceClient.typedProposal(mode, text);
      if (currentOperation !== operation.current) return;
      setProposal(nextProposal);
      setResult(nextProposal.text);
      setPhase("result");
    } catch (requestError) {
      if (currentOperation !== operation.current) return;
      setPhase("error");
      setError(safeErrorMessage(requestError));
    }
  }, [mode, nativeAvailable, phase, text]);

  const submitProposal = useCallback(async () => {
    if (!proposal) return;
    const currentOperation = ++operation.current;
    setError(null);
    try {
      const accepted = await voiceClient.submitProposal(proposal.proposalId, proposal.mode);
      if (currentOperation !== operation.current) return;
      if (!accepted) throw new Error("Native proposal was not accepted.");
      setProposal(null);
      setPhase("result");
      setResult("Proposal sent to Note. It has not changed a note or calendar item yet.");
      textInputRef.current?.focus();
    } catch (requestError) {
      if (currentOperation !== operation.current) return;
      setPhase("error");
      setError(safeErrorMessage(requestError));
    }
  }, [proposal]);

  useEffect(() => {
    let active = true;
    void voiceClient.status()
      .then((status) => {
        if (active) setVoiceStatus(status);
      })
      .catch(() => {
        if (active) {
          setPhase("error");
          setError("Native voice configuration could not be checked. Typed proposals are still available.");
        }
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (phase !== "recording") return;
    const timer = window.setInterval(() => {
      if (recordingStartedAt.current !== null) {
        setElapsedSeconds(Math.floor((Date.now() - recordingStartedAt.current) / 1000));
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [phase]);

  useEffect(() => {
    const controller = new AbortController();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && activeSession.current) {
        event.preventDefault();
        void cancelRecording();
      }
    };

    document.addEventListener("keydown", handleKeyDown, { signal: controller.signal });
    const applyState = (value: import("../native/voiceClient").VoiceStateEvent) => {
      if (value.generation < lastGeneration.current) return;
      const current = activeSession.current;
      const isNewer = !current || value.generation > current.generation;
      if (!isNewer && (
        value.generation !== current.generation ||
        value.sessionId !== current.sessionId ||
        value.mode !== current.mode
      )) return;
      lastGeneration.current = Math.max(lastGeneration.current, value.generation);
      if (value.state === "recording" || value.state === "transcribing") {
        activeSession.current = { generation: value.generation, sessionId: value.sessionId, mode: value.mode };
        setError(null);
        if (value.state === "recording") {
          recordingStartedAt.current = Date.now();
          setElapsedSeconds(0);
          setPhase("recording");
        } else {
          recordingStartedAt.current = null;
          setPhase("transcribing");
        }
        return;
      }
      resetSession();
      if (value.state === "cancelled" || value.state === "idle") {
        setPhase("idle");
      } else if (value.state === "timed_out") {
        setPhase("error");
        setError("Recording reached the 30-second limit. Try a shorter recording.");
      } else {
        setPhase("error");
        setError("Native voice is unavailable. Check microphone and voice configuration.");
      }
    };
    const applyTranscript = (value: import("../native/voiceClient").VoiceTranscriptEvent) => {
      const current = activeSession.current;
      if (
        value.generation < lastGeneration.current ||
        !current ||
        value.generation !== current.generation ||
        value.sessionId !== current.sessionId ||
        value.mode !== current.mode
      ) return;
      lastGeneration.current = value.generation;
      resetSession();
      setProposal({
        proposalId: value.proposalId,
        text: value.transcript,
        mode: value.mode,
        source: value.source,
      });
      setResult(value.transcript);
      setPhase("result");
    };
    void voiceClient.listen((event) => {
      if (event.type === "state") applyState(event.value);
      else if (event.type === "transcript") applyTranscript(event.value);
    }).then(async (unlisten) => {
      if (controller.signal.aborted) {
        await unlisten();
        return;
      }
      controller.signal.addEventListener("abort", () => void unlisten(), { once: true });
      try {
        const ready = await voiceClient.quickCommandReady();
        if (controller.signal.aborted || ready.generation < lastGeneration.current) return;
        lastGeneration.current = Math.max(lastGeneration.current, ready.generation);
        if (ready.state) applyState(ready.state);
        if (ready.transcript) applyTranscript(ready.transcript);
      } catch {
        if (!controller.signal.aborted) {
          setPhase("error");
          setError("Native voice session recovery is unavailable. Try reopening Quick command.");
        }
      }
    }).catch(() => {
      if (!controller.signal.aborted) {
        setPhase("error");
        setError("Native voice events are unavailable. Try reopening Quick command.");
      }
    });

    return () => controller.abort();
  }, [cancelRecording, resetSession]);

  const isBusy = phase === "recording" || phase === "transcribing";
  const inputTooLong = text.length > 500;
  const status =
    phase === "recording"
      ? elapsedLabel(elapsedSeconds)
      : phase === "transcribing"
        ? "Transcribing with native voice…"
        : phase === "result"
          ? proposal
            ? "Proposal ready to send to Note."
            : "Voice result is ready."
          : phase === "error"
            ? error ?? "Native voice is unavailable."
            : "Choose a mode, record, or type a short proposal.";

  return (
    <main className="quick-command-surface" data-surface="quick-command">
      <section className="quick-command-card" aria-labelledby="quick-command-title">
        <div className="quick-command-heading">
          <p className="quick-command-eyebrow">Note</p>
          <h1 id="quick-command-title">Quick command</h1>
        </div>

        <div className="quick-command-controls">
          <label className="quick-command-mode" htmlFor="quick-command-mode">
            <span>Command mode</span>
            <select
              id="quick-command-mode"
              value={mode}
              onChange={(event) => setMode(event.target.value as VoiceMode)}
              disabled={isBusy}
            >
              {modes.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              <option disabled>Calendar command — deferred</option>
              <option disabled>Confirmation — deferred</option>
            </select>
          </label>

          <label className="quick-command-input" htmlFor="quick-command-text">
            <span>Type a command or dictation</span>
            <input
              ref={textInputRef}
              id="quick-command-text"
              value={text}
              maxLength={500}
              onChange={(event) => setText(event.target.value)}
              placeholder={`Send ${modeLabel(mode).toLowerCase()} to Note`}
              disabled={isBusy || !nativeAvailable}
            />
          </label>

          <div className="quick-command-actions" aria-label="Quick command actions">
            {phase === "recording" ? (
              <button type="button" onClick={() => void stopRecording()}>
                Stop recording
              </button>
            ) : phase === "transcribing" ? (
              <button type="button" onClick={() => void cancelRecording()}>
                Cancel transcription
              </button>
            ) : (
              <button type="button" onClick={() => void startRecording()} disabled={!canRecord}>
                {canRecord ? "Record" : "Voice unavailable"}
              </button>
            )}
            <button
              type="button"
              onClick={() => void createTypedProposal()}
              disabled={!nativeAvailable || isBusy || !text.trim() || inputTooLong}
            >
              Use typed text
            </button>
            {proposal && (
              <button type="button" onClick={() => void submitProposal()}>
                Send proposal to Note
              </button>
            )}
          </div>
        </div>

        <p
          aria-atomic="true"
          aria-live={phase === "recording" ? "off" : "polite"}
          className="quick-command-status"
          role={phase === "recording" ? undefined : "status"}
        >
          {status}
        </p>
        {phase === "error" && error && <p className="quick-command-error" role="alert">{error}</p>}
        {result && phase === "result" && <p className="quick-command-result">{result}</p>}
        {voiceStatus && (!voiceStatus.microphoneCapture.available || !voiceStatus.transcription.available) && (
          <p className="quick-command-error" role="alert">
            Voice recording is unavailable. Check microphone permission and native voice configuration; typed proposals remain available.
          </p>
        )}
        <p className="quick-command-deferred">
          Calendar commands and confirmations are deferred and cannot be sent from this window.
        </p>
        {!nativeAvailable && (
          <p className="quick-command-error" role="alert">
            Browser microphone capture is unavailable. Open Note desktop to use native voice.
          </p>
        )}
        {inputTooLong && <p className="quick-command-error" role="alert">Typed input must be 500 characters or fewer.</p>}
      </section>
    </main>
  );
}
