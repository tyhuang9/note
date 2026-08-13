import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  CalendarClientError,
  calendarClient,
  type CalImportCommitResult,
  type CalImportPreviewResult,
  type UnifiedBackupCreateResult,
  type UnifiedBackupRestoreCommitResult,
  type UnifiedBackupRestorePreviewResult,
} from "../../native/calendarClient";

type ImportPreview = Extract<CalImportPreviewResult, { status: "previewed" }>;
type RestorePreview = Extract<UnifiedBackupRestorePreviewResult, { status: "previewed" }>;
type Operation = "importPreview" | "importCommit" | "backupCreate" | "restorePreview" | "restoreCommit";
type Feedback = { kind: "status" | "error"; message: string };

const operationMessage: Record<Operation, string> = {
  importPreview: "Preparing Cal import preview…",
  importCommit: "Importing Cal events…",
  backupCreate: "Creating unified backup…",
  restorePreview: "Preparing backup restore preview…",
  restoreCommit: "Restoring backup…",
};

export default function DataMigrationBackupPanel() {
  const [operation, setOperation] = useState<Operation | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [importAcknowledged, setImportAcknowledged] = useState(false);
  const [importResult, setImportResult] = useState<CalImportCommitResult | null>(null);
  const [backupResult, setBackupResult] = useState<Extract<UnifiedBackupCreateResult, { status: "created" }> | null>(null);
  const [restorePreview, setRestorePreview] = useState<RestorePreview | null>(null);
  const [restoreAcknowledged, setRestoreAcknowledged] = useState(false);
  const [restoreResult, setRestoreResult] = useState<UnifiedBackupRestoreCommitResult | null>(null);
  const importPreviewButton = useRef<HTMLButtonElement>(null);
  const restorePreviewButton = useRef<HTMLButtonElement>(null);
  const importPreviewHeading = useRef<HTMLHeadingElement>(null);
  const restorePreviewHeading = useRef<HTMLHeadingElement>(null);
  const importCompletionHeading = useRef<HTMLHeadingElement>(null);
  const restoreCompletionHeading = useRef<HTMLHeadingElement>(null);
  const operationRef = useRef<Operation | null>(null);

  const busy = operation !== null;

  useEffect(() => {
    if (importPreview) importPreviewHeading.current?.focus();
  }, [importPreview]);

  useEffect(() => {
    if (restorePreview) restorePreviewHeading.current?.focus();
  }, [restorePreview]);

  useEffect(() => {
    if (importResult) importCompletionHeading.current?.focus();
  }, [importResult]);

  useEffect(() => {
    if (restoreResult) restoreCompletionHeading.current?.focus();
  }, [restoreResult]);

  async function run(operationName: Operation, action: () => Promise<void>) {
    if (operationRef.current) return;
    operationRef.current = operationName;
    setOperation(operationName);
    setFeedback(null);
    try {
      await action();
    } catch (cause) {
      setFeedback({ kind: "error", message: messageFor(cause) });
    } finally {
      operationRef.current = null;
      setOperation(null);
    }
  }

  function previewCalImport() {
    void run("importPreview", async () => {
      const result = await calendarClient.previewCalImport();
      setImportAcknowledged(false);
      setImportResult(null);
      if (result.status === "cancelled") {
        setImportPreview(null);
        setFeedback({ kind: "status", message: "Cal import preview cancelled. No events were changed." });
        return;
      }
      setImportPreview(result);
      setFeedback({ kind: "status", message: "Cal import preview is ready for review." });
    });
  }

  function commitCalImport() {
    if (!importPreview) return;
    if (isExpired(importPreview.expiresAtUtcMs)) {
      setImportPreview(null);
      setImportAcknowledged(false);
      setFeedback({ kind: "error", message: "This Cal import preview has expired. Preview the import again before confirming." });
      window.requestAnimationFrame(() => importPreviewButton.current?.focus());
      return;
    }
    void run("importCommit", async () => {
      const result = await calendarClient.commitCalImport(importPreview.sessionId);
      setImportPreview(null);
      setImportAcknowledged(false);
      setImportResult(result);
      setFeedback({ kind: "status", message: "Cal import completed." });
    });
  }

  function createUnifiedBackup() {
    void run("backupCreate", async () => {
      const result = await calendarClient.createUnifiedBackup();
      if (result.status === "cancelled") {
        setBackupResult(null);
        setFeedback({ kind: "status", message: "Unified backup creation cancelled." });
        return;
      }
      setBackupResult(result);
      setFeedback({ kind: "status", message: "Unified backup created." });
    });
  }

  function previewUnifiedRestore() {
    void run("restorePreview", async () => {
      const result = await calendarClient.previewUnifiedBackupRestore();
      setRestoreAcknowledged(false);
      setRestoreResult(null);
      if (result.status === "cancelled") {
        setRestorePreview(null);
        setFeedback({ kind: "status", message: "Backup restore preview cancelled. Nothing was restored." });
        return;
      }
      setRestorePreview(result);
      setFeedback({ kind: "status", message: "Backup restore preview is ready for review." });
    });
  }

  function commitUnifiedRestore() {
    if (!restorePreview) return;
    if (isExpired(restorePreview.expiresAtUtcMs)) {
      setRestorePreview(null);
      setRestoreAcknowledged(false);
      setFeedback({ kind: "error", message: "This backup restore preview has expired. Preview the backup again before confirming." });
      window.requestAnimationFrame(() => restorePreviewButton.current?.focus());
      return;
    }
    void run("restoreCommit", async () => {
      const result = await calendarClient.commitUnifiedBackupRestore(restorePreview.sessionId);
      setRestorePreview(null);
      setRestoreAcknowledged(false);
      setRestoreResult(result);
      setFeedback({ kind: "status", message: "Backup restore completed." });
    });
  }

  return <>
    {operation && <p aria-atomic="true" aria-live="polite" className="calendar-data-migration-feedback calendar-data-migration-operation" role="status">{operationMessage[operation]}</p>}
    <p aria-atomic="true" aria-live="polite" className={`calendar-data-migration-feedback${feedback?.kind === "status" ? "" : " is-empty"}`} role="status">{feedback?.kind === "status" ? feedback.message : ""}</p>
    {feedback?.kind === "error" && <p className="calendar-data-migration-feedback is-error" role="alert">{feedback.message}</p>}
    <section className="calendar-data-migration" aria-labelledby="data-migration-heading" aria-busy={busy}>
    <h2 id="data-migration-heading">Data migration &amp; backups</h2>
    <p className="calendar-data-migration-intro">Preview events from Cal, or create and restore a unified Note backup. Cal is opened read-only and is not changed.</p>

    <section className="calendar-data-migration-section" aria-labelledby="cal-import-heading">
      <div className="calendar-data-migration-section-heading">
        <div><h3 id="cal-import-heading">Import from Cal</h3><p>Review the selected Cal export before importing. The Cal source stays untouched.</p></div>
        <button className="calendar-button" disabled={busy} onClick={previewCalImport} ref={importPreviewButton} type="button">{importPreview ? "Preview Cal import again" : "Preview Cal import"}</button>
      </div>
      {importPreview && <section className="calendar-data-migration-preview" aria-labelledby="cal-import-preview-heading">
        <h4 id="cal-import-preview-heading" ref={importPreviewHeading} tabIndex={-1}>Cal import preview</h4>
        <p><strong>Selected file:</strong> {importPreview.fileName}</p>
        <dl className="calendar-data-migration-counts">
          <div><dt>Events found</dt><dd>{importPreview.totalCount}</dd></div>
          <div><dt>Eligible to import</dt><dd>{importPreview.acceptedCount}</dd></div>
          <div><dt>Already in Note</dt><dd>{importPreview.existingCount}</dd></div>
        </dl>
        <p className="calendar-data-migration-policy">Existing events are skipped; no copies or replacements.</p>
        <h5>Events to review</h5>
        {importPreview.items.length ? <ul className="calendar-data-migration-list" aria-label="Cal events to import">{importPreview.items.map((item) => <li key={item.sourceEventId}><strong>{item.title}</strong><span>{item.temporalKind === "timed" ? "Timed" : "All day"} · {item.startLabel} to {item.endLabel}</span></li>)}</ul> : <p className="calendar-empty">No events are eligible to import.</p>}
        <label className="calendar-data-migration-confirm"><input checked={importAcknowledged} disabled={busy} onChange={(event) => setImportAcknowledged(event.currentTarget.checked)} type="checkbox" /> I understand existing events will be skipped.</label>
        <div className="calendar-data-migration-actions"><button className="calendar-button calendar-primary" disabled={busy || !importAcknowledged} onClick={commitCalImport} type="button">Confirm Cal import</button><span>Preview expires {formatDateTime(importPreview.expiresAtUtcMs)}.</span></div>
      </section>}
      {importResult && <Completion headingRef={importCompletionHeading} title="Cal import completed"><ResultList items={[["Eligible events", importResult.acceptedCount], ["Imported", importResult.importedCount], ["Skipped", importResult.skippedCount], ["Recovery backup", importResult.recoveryBackupFileName], ["Completed", formatDateTime(importResult.committedAtUtcMs)]]} /></Completion>}
    </section>

    <section className="calendar-data-migration-section" aria-labelledby="unified-backup-heading">
      <div className="calendar-data-migration-section-heading">
        <div><h3 id="unified-backup-heading">Unified Note backup</h3><p>Create one backup that can include Note data and a calendar snapshot.</p></div>
        <button className="calendar-button" disabled={busy} onClick={createUnifiedBackup} type="button">Create unified backup</button>
      </div>
      {backupResult && <Completion title="Unified backup created"><ResultList items={[["Backup file", backupResult.fileName], ["Size", formatByteSize(backupResult.byteSize)], ["Created", formatDateTime(backupResult.createdAtUtcMs)]]} /></Completion>}
    </section>

    <section className="calendar-data-migration-section" aria-labelledby="unified-restore-heading">
      <div className="calendar-data-migration-section-heading">
        <div><h3 id="unified-restore-heading">Restore a unified backup</h3><p>Preview the selected backup first. Confirming a restore creates a recovery backup.</p></div>
        <button className="calendar-button" disabled={busy} onClick={previewUnifiedRestore} ref={restorePreviewButton} type="button">{restorePreview ? "Preview backup again" : "Preview backup restore"}</button>
      </div>
      {restorePreview && <section className="calendar-data-migration-preview" aria-labelledby="unified-restore-preview-heading">
        <h4 id="unified-restore-preview-heading" ref={restorePreviewHeading} tabIndex={-1}>Backup restore preview</h4>
        <ResultList items={[["Selected file", restorePreview.fileName], ["Size", formatByteSize(restorePreview.byteSize)], ["Includes Note data", yesNo(restorePreview.hasNoteData)], ["Includes calendar snapshot", yesNo(restorePreview.hasCalendarSnapshot)]]} />
        <p className="calendar-data-migration-policy">A recovery backup will be created if the restore completes.</p>
        <label className="calendar-data-migration-confirm"><input checked={restoreAcknowledged} disabled={busy} onChange={(event) => setRestoreAcknowledged(event.currentTarget.checked)} type="checkbox" /> I understand that confirming restores the selected backup and creates a recovery backup.</label>
        <div className="calendar-data-migration-actions"><button className="calendar-button calendar-primary" disabled={busy || !restoreAcknowledged} onClick={commitUnifiedRestore} type="button">Confirm backup restore</button><span>Preview expires {formatDateTime(restorePreview.expiresAtUtcMs)}.</span></div>
      </section>}
      {restoreResult && <Completion headingRef={restoreCompletionHeading} title="Backup restore completed"><ResultList items={[["Note data restored", yesNo(restoreResult.noteDataRestored)], ["Calendar restored", yesNo(restoreResult.calendarRestored)], ["Recovery backup", restoreResult.recoveryBackupFileName], ["Completed", formatDateTime(restoreResult.restoredAtUtcMs)]]} /></Completion>}
    </section>
    </section>
  </>;
}

function Completion({ children, headingRef, title }: { children: ReactNode; headingRef?: RefObject<HTMLHeadingElement | null>; title: string }) {
  return <section className="calendar-data-migration-completion" aria-label={title}><h4 ref={headingRef} tabIndex={-1}>{title}</h4>{children}</section>;
}

function ResultList({ items }: { items: Array<[string, number | string]> }) {
  return <dl className="calendar-data-migration-result-list">{items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

function isExpired(expiresAtUtcMs: number) { return Date.now() >= expiresAtUtcMs; }

function yesNo(value: boolean) { return value ? "Yes" : "No"; }

function formatByteSize(byteSize: number) {
  if (byteSize < 1024) return `${byteSize} bytes`;
  if (byteSize < 1024 * 1024) return `${(byteSize / 1024).toFixed(1)} KB`;
  return `${(byteSize / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDateTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(timestamp));
}

function messageFor(cause: unknown) {
  return cause instanceof CalendarClientError ? cause.message : "Migration or backup request failed. Please try again.";
}
