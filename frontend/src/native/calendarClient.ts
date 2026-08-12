import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type TimedEventInput = {
  temporalKind: "timed";
  localStart: string;
  localEnd: string;
  timeZone: string;
};

export type AllDayEventInput = {
  temporalKind: "allDay";
  startDate: string;
  endDateExclusive: string;
};

export type EventDraft = {
  title: string;
  notes: string | null;
  location: string | null;
  time: TimedEventInput | AllDayEventInput;
  recurrenceRule?: string | null;
  reminderOffsetsMinutes?: number[];
};

export type EventTime =
  | {
      temporalKind: "timed";
      startUtcMs: number;
      endUtcMs: number;
      timeZone: string;
    }
  | {
      temporalKind: "allDay";
      startDate: string;
      endDateExclusive: string;
    };

export type CalendarEvent = {
  id: string;
  calendarId: string;
  title: string;
  notes: string | null;
  location: string | null;
  time: EventTime;
  recurrenceRule: string | null;
  reminderOffsetsMinutes: number[];
  revision: number;
  createdAtUtcMs: number;
  updatedAtUtcMs: number;
};

export type CalendarOccurrence = {
  eventId: string;
  occurrenceKey: string;
  calendarId: string;
  title: string;
  notes: string | null;
  location: string | null;
  time: EventTime;
  recurrenceRule: string | null;
  reminderOffsetsMinutes: number[];
  revision: number;
};

export type CalendarRange = {
  startUtcMs: number;
  endUtcMs: number;
  startDate: string;
  endDateExclusive: string;
};

export type AgendaPageRequest = {
  direction: "before" | "after";
  anchorDate?: string;
  cursor?: string;
  displayTimeZone: string;
  limit: number;
};

export type AgendaPage = {
  days: Array<{ date: string; occurrences: CalendarOccurrence[] }>;
  nextCursor: string | null;
  exhausted: boolean;
};

export type SearchEventsRequest = CalendarRange & {
  query: string;
  limit: number;
};

export type CalendarSettings = {
  defaultEventDurationMinutes: number;
  weekStartsOn: "monday" | "sunday";
  timeFormat: "system" | "12h" | "24h";
  defaultReminderMinutes: number | null;
};

export type CalendarSettingsPatch = Partial<CalendarSettings>;

export type CalendarReadiness =
  | { state: "loading" }
  | { state: "ready"; initializationDurationMs: number }
  | { state: "unavailable"; initializationDurationMs: number };

export type ReminderPermissionStatus = "default" | "granted" | "denied";
export type ReminderSchedulerStatus = "waitingForPermission" | "ready" | "error";
export type ReminderStatus = {
  permissionStatus: ReminderPermissionStatus;
  schedulerStatus: ReminderSchedulerStatus;
  errorCode: string | null;
  recentCatchUp: {
    items: Array<{
      eventId: string;
      occurrenceKey: string;
      title: string;
      scheduledForUtcMs: number;
      deliveredAtUtcMs: number | null;
      status: "delivered" | "failed";
    }>;
    deliveredCount: number;
    suppressedCount: number;
  };
};

export type BackupCreateResult =
  | { status: "cancelled" }
  | {
      status: "created";
      fileName: string;
      byteSize: number;
      createdAtUtcMs: number;
    };

export type BackupRestoreCounts = {
  calendarCount: number;
  eventCount: number;
  reminderCount: number;
};

export type BackupRestorePreviewResult =
  | { status: "cancelled" }
  | {
      status: "previewed";
      sessionId: string;
      fileName: string;
      byteSize: number;
      expiresAtUtcMs: number;
      schemaVersion: number;
      backup: BackupRestoreCounts & {
        timedEventCount: number;
        allDayEventCount: number;
        recurringEventCount: number;
      };
      current: BackupRestoreCounts;
      settings: CalendarSettings;
    };

export type BackupRestoreCommitResult = {
  status: "restored";
  calendarCount: number;
  eventCount: number;
  reminderCount: number;
  recoveryBackupFileName: string;
  restoredAtUtcMs: number;
};

export type ExportIcsRequest = {
  selection: {
    startDate: string;
    endDate: string;
    timeZone: string;
  };
};

export type ExportIcsResult =
  | { status: "cancelled" }
  | {
      status: "created";
      fileName: string;
      byteSize: number;
      eventCount: number;
      createdAtUtcMs: number;
    };

export type IcsImportPreviewItem = {
  sourceIndex: number;
  status: "accepted" | "rejected";
  duplicateStatus:
    | "none"
    | "sameRevision"
    | "sourceChanged"
    | "unverified"
    | null;
  title: string;
  temporalKind: "timed" | "allDay" | null;
  startLabel: string | null;
  endLabel: string | null;
  timeZone: string | null;
  issues: Array<{
    severity: "warning" | "error";
    code: string;
    message: string;
  }>;
};

export type ImportIcsPreviewResult =
  | { status: "cancelled" }
  | {
      status: "previewed";
      sessionId: string;
      fileName: string;
      expiresAtUtcMs: number;
      totalCount: number;
      acceptedCount: number;
      rejectedCount: number;
      warningCount: number;
      sameRevisionCount: number;
      sourceChangedCount: number;
      unverifiedCount: number;
      items: IcsImportPreviewItem[];
    };

export type IcsImportDuplicatePolicy = "skipExisting" | "createCopies";

export type ImportIcsCommitResult = {
  status: "committed";
  duplicatePolicy: IcsImportDuplicatePolicy;
  acceptedCount: number;
  importedCount: number;
  skippedCount: number;
  committedAtUtcMs: number;
};

export type OccurrenceEventDraft = Omit<EventDraft, "recurrenceRule"> & {
  recurrenceRule?: never;
};

export type CalendarApiError = {
  code: string;
  message: string;
  field?: string;
};

export type CalendarCommand =
  | "calendar_list_events"
  | "calendar_widget_agenda"
  | "calendar_agenda_page"
  | "calendar_search"
  | "calendar_get_event"
  | "calendar_create_event"
  | "calendar_update_event"
  | "calendar_delete_event"
  | "calendar_update_occurrence"
  | "calendar_delete_occurrence"
  | "calendar_get_settings"
  | "calendar_update_settings"
  | "calendar_readiness_get"
  | "calendar_retry_initialization"
  | "notification_status_get"
  | "notification_permission_request"
  | "backup_create"
  | "backup_restore_preview"
  | "backup_restore_commit"
  | "export_ics"
  | "import_ics_preview"
  | "import_ics_commit";

const STORAGE_UNAVAILABLE: CalendarApiError = {
  code: "storage_unavailable",
  message: "Calendar storage is unavailable.",
};

export class CalendarClientError extends Error implements CalendarApiError {
  readonly code: string;
  readonly field?: string;

  constructor(error: CalendarApiError) {
    super(error.message);
    this.name = "CalendarClientError";
    this.code = error.code;
    this.field = error.field;
  }
}

export function isCalendarApiError(error: unknown): error is CalendarApiError {
  if (typeof error !== "object" || error === null) return false;

  const candidate = error as Record<string, unknown>;
  return (
    typeof candidate.code === "string" &&
    typeof candidate.message === "string" &&
    (candidate.field === undefined || typeof candidate.field === "string")
  );
}

async function invokeCalendar<Response>(
  command: CalendarCommand,
  request?: unknown,
): Promise<Response> {
  if (!isTauri()) throw new CalendarClientError(STORAGE_UNAVAILABLE);

  try {
    return request === undefined
      ? await invoke<Response>(command)
      : await invoke<Response>(command, { request });
  } catch (error) {
    throw new CalendarClientError(
      isCalendarApiError(error) ? error : STORAGE_UNAVAILABLE,
    );
  }
}

export const calendarClient = {
  listEvents(request: CalendarRange): Promise<CalendarOccurrence[]> {
    return invokeCalendar("calendar_list_events", request);
  },

  agendaPage(request: AgendaPageRequest): Promise<AgendaPage> {
    return invokeCalendar("calendar_agenda_page", request);
  },

  searchEvents(request: SearchEventsRequest): Promise<CalendarOccurrence[]> {
    return invokeCalendar("calendar_search", request);
  },

  getEvent(eventId: string): Promise<CalendarEvent> {
    return invokeCalendar("calendar_get_event", { eventId });
  },

  createEvent(event: EventDraft): Promise<CalendarEvent> {
    return invokeCalendar("calendar_create_event", event);
  },

  updateEvent(
    eventId: string,
    expectedRevision: number,
    event: EventDraft,
  ): Promise<CalendarEvent> {
    return invokeCalendar("calendar_update_event", {
      eventId,
      expectedRevision,
      event,
    });
  },

  deleteEvent(eventId: string, expectedRevision: number): Promise<void> {
    return invokeCalendar("calendar_delete_event", {
      eventId,
      expectedRevision,
    });
  },

  updateOccurrence(
    eventId: string,
    occurrenceKey: string,
    expectedRevision: number,
    event: OccurrenceEventDraft,
  ): Promise<CalendarEvent> {
    return invokeCalendar("calendar_update_occurrence", {
      eventId,
      occurrenceKey,
      expectedRevision,
      event,
    });
  },

  deleteOccurrence(
    eventId: string,
    occurrenceKey: string,
    expectedRevision: number,
  ): Promise<void> {
    return invokeCalendar("calendar_delete_occurrence", {
      eventId,
      occurrenceKey,
      expectedRevision,
    });
  },

  getSettings(): Promise<CalendarSettings> {
    return invokeCalendar("calendar_get_settings");
  },

  updateSettings(patch: CalendarSettingsPatch): Promise<CalendarSettings> {
    return invokeCalendar("calendar_update_settings", { patch });
  },

  getReadiness(): Promise<CalendarReadiness> {
    return invokeCalendar("calendar_readiness_get");
  },

  retryInitialization(): Promise<CalendarReadiness> {
    return invokeCalendar("calendar_retry_initialization");
  },

  getReminderStatus(): Promise<ReminderStatus> {
    return invokeCalendar("notification_status_get");
  },

  requestReminderPermission(): Promise<ReminderStatus> {
    return invokeCalendar("notification_permission_request");
  },

  createBackup(): Promise<BackupCreateResult> {
    return invokeCalendar("backup_create");
  },

  previewBackupRestore(): Promise<BackupRestorePreviewResult> {
    return invokeCalendar("backup_restore_preview");
  },

  commitBackupRestore(sessionId: string): Promise<BackupRestoreCommitResult> {
    return invokeCalendar("backup_restore_commit", { sessionId });
  },

  exportIcs(request: ExportIcsRequest): Promise<ExportIcsResult> {
    return invokeCalendar("export_ics", request);
  },

  previewIcsImport(): Promise<ImportIcsPreviewResult> {
    return invokeCalendar("import_ics_preview");
  },

  commitIcsImport(
    sessionId: string,
    duplicatePolicy: IcsImportDuplicatePolicy,
  ): Promise<ImportIcsCommitResult> {
    return invokeCalendar("import_ics_commit", {
      sessionId,
      duplicatePolicy,
    });
  },
};

export type CalendarChangedListener = () => void;

/** Main-window calendar changes only; callers own the returned unlisten handle. */
export async function listenForCalendarChanges(
  listener: CalendarChangedListener,
  signal?: AbortSignal,
): Promise<UnlistenFn> {
  if (!isTauri() || signal?.aborted) {
    return () => undefined;
  }

  const unlisten = await listen("note://calendar-changed", () => listener());
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    unlisten();
  };
  if (signal?.aborted) {
    stop();
    return () => undefined;
  }
  signal?.addEventListener("abort", stop, { once: true });
  return stop;
}
