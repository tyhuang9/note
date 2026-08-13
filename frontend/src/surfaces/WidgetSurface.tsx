import { useCallback, useEffect, useRef, useState } from "react";
import {
  listenForWidgetCalendarChanges,
  listenForWidgetStatusChanges,
  type WidgetAgendaItem,
  type WidgetSizePreset,
  type WidgetStatus,
  widgetClient,
} from "../native/widgetClient";
import { measurePerformance } from "../services/performance";

const REFRESH_DEBOUNCE_MS = 160;
const sizePresets: Array<{ label: string; value: WidgetSizePreset }> = [
  { label: "Small", value: "small" },
  { label: "Medium", value: "medium" },
  { label: "Large", value: "large" },
];

type AgendaDay = {
  dateKey: string;
  label: string;
  items: WidgetAgendaItem[];
};

function displayTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function safeErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function datePartsForTimeZone(timestamp: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(new Date(timestamp));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "00";

  return {
    dateKey: `${part("year")}-${part("month")}-${part("day")}`,
    label: new Intl.DateTimeFormat("en-US", {
      day: "numeric",
      month: "short",
      timeZone,
      weekday: "short",
    }).format(new Date(timestamp)),
  };
}

function allDayDateLabel(date: string) {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    weekday: "short",
  }).format(new Date(`${date}T12:00:00Z`));
}

function itemDate(item: WidgetAgendaItem, timeZone: string) {
  if (item.time.temporalKind === "allDay") {
    return { dateKey: item.time.startDate, label: allDayDateLabel(item.time.startDate) };
  }

  return datePartsForTimeZone(item.time.startUtcMs, timeZone);
}

function itemStart(item: WidgetAgendaItem) {
  return item.time.temporalKind === "allDay"
    ? Date.parse(`${item.time.startDate}T00:00:00Z`)
    : item.time.startUtcMs;
}

function agendaDays(items: WidgetAgendaItem[], timeZone: string): AgendaDay[] {
  const grouped = new Map<string, AgendaDay>();

  for (const item of [...items].sort((left, right) => {
    const byStart = itemStart(left) - itemStart(right);
    return byStart || left.title.localeCompare(right.title, "en");
  })) {
    const { dateKey, label } = itemDate(item, timeZone);
    const existing = grouped.get(dateKey);
    if (existing) existing.items.push(item);
    else grouped.set(dateKey, { dateKey, label, items: [item] });
  }

  return [...grouped.values()].sort((left, right) => left.dateKey.localeCompare(right.dateKey));
}

function timeLabel(item: WidgetAgendaItem, timeZone: string) {
  if (item.time.temporalKind === "allDay") return "All day";

  const formatter = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  });
  return `${formatter.format(new Date(item.time.startUtcMs))}–${formatter.format(new Date(item.time.endUtcMs))}`;
}

function isWidgetStatus(value: unknown): value is WidgetStatus {
  if (typeof value !== "object" || value === null) return false;
  const status = value as Record<string, unknown>;
  return (
    (status.requestedMode === "floating" || status.requestedMode === "desktop") &&
    status.effectiveMode === "floating" &&
    typeof status.visibilityRequested === "boolean" &&
    typeof status.visible === "boolean" &&
    typeof status.locked === "boolean" &&
    (status.sizePreset === "small" || status.sizePreset === "medium" || status.sizePreset === "large") &&
    status.attached === false
  );
}

export default function WidgetSurface() {
  const [timeZone] = useState(displayTimeZone);
  const [agenda, setAgenda] = useState<WidgetAgendaItem[] | null>(null);
  const [agendaLoading, setAgendaLoading] = useState(true);
  const [agendaError, setAgendaError] = useState<string | null>(null);
  const [status, setStatus] = useState<WidgetStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<"lock" | "size" | "open" | null>(null);
  const mounted = useRef(true);
  const agendaGeneration = useRef(0);
  const agendaLoaded = useRef(false);
  const statusGeneration = useRef(0);
  const retryStatusRef = useRef<HTMLParagraphElement | null>(null);

  const refreshAgenda = useCallback(async () => {
    const generation = ++agendaGeneration.current;
    setAgendaLoading(true);
    if (agendaLoaded.current) setAgendaError(null);

    try {
      const nextAgenda = await measurePerformance("widget.refresh", () => widgetClient.agenda(timeZone));
      if (!mounted.current || generation !== agendaGeneration.current) return;
      setAgenda(nextAgenda);
      setAgendaError(null);
      agendaLoaded.current = true;
    } catch (error) {
      if (!mounted.current || generation !== agendaGeneration.current) return;
      setAgendaError(safeErrorMessage(error, "The agenda could not be refreshed."));
    } finally {
      if (mounted.current && generation === agendaGeneration.current) {
        setAgendaLoading(false);
      }
    }
  }, [timeZone]);

  const refreshStatus = useCallback(async () => {
    const generation = ++statusGeneration.current;
    setStatusError(null);

    try {
      const nextStatus = await widgetClient.getStatus();
      if (!mounted.current || generation !== statusGeneration.current) return;
      setStatus(nextStatus);
    } catch (error) {
      if (!mounted.current || generation !== statusGeneration.current) return;
      setStatusError(safeErrorMessage(error, "Widget status could not be checked."));
    }
  }, []);

  const updateStatus = useCallback(async (
    action: "lock" | "size",
    request: () => Promise<WidgetStatus>,
  ) => {
    if (pendingAction) return;
    const generation = ++statusGeneration.current;
    setActionError(null);
    setPendingAction(action);
    try {
      const nextStatus = await request();
      if (!mounted.current || generation !== statusGeneration.current) return;
      setStatus(nextStatus);
      setStatusError(null);
    } catch (error) {
      if (mounted.current && generation === statusGeneration.current) {
        setActionError(safeErrorMessage(error, "Widget controls could not be updated."));
      }
    } finally {
      if (mounted.current) setPendingAction(null);
    }
  }, [pendingAction]);

  const openCalendar = useCallback(async () => {
    if (pendingAction) return;
    setActionError(null);
    setPendingAction("open");
    try {
      await widgetClient.openCalendar();
    } catch (error) {
      if (mounted.current) {
        setActionError(safeErrorMessage(error, "The calendar could not be opened."));
      }
    } finally {
      if (mounted.current) setPendingAction(null);
    }
  }, [pendingAction]);

  useEffect(() => {
    if (agendaLoading && agendaError) retryStatusRef.current?.focus();
  }, [agendaError, agendaLoading]);

  useEffect(() => {
    mounted.current = true;
    let refreshTimer: number | undefined;
    let active = true;
    let unlistenCalendar: (() => void) | undefined;
    let unlistenStatus: (() => void) | undefined;
    const scheduleRefresh = () => {
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined;
        void refreshAgenda();
        void refreshStatus();
      }, REFRESH_DEBOUNCE_MS);
    };
    const setupListeners = async () => {
      try {
        unlistenCalendar = await listenForWidgetCalendarChanges(scheduleRefresh);
        if (!active) {
          unlistenCalendar();
          return;
        }
        unlistenStatus = await listenForWidgetStatusChanges((nextStatus) => {
          if (isWidgetStatus(nextStatus)) {
            statusGeneration.current += 1;
            setStatus(nextStatus);
            setStatusError(null);
          }
          scheduleRefresh();
        });
        if (!active) {
          unlistenCalendar();
          unlistenStatus();
        }
      } catch {
        unlistenCalendar?.();
        unlistenStatus?.();
        if (active) setStatusError("Widget updates are unavailable. Refresh reloads the agenda.");
      }
    };

    void refreshAgenda();
    void refreshStatus();
    void setupListeners();

    return () => {
      active = false;
      mounted.current = false;
      agendaGeneration.current += 1;
      statusGeneration.current += 1;
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      unlistenCalendar?.();
      unlistenStatus?.();
    };
  }, [refreshAgenda, refreshStatus]);

  const days = agenda ? agendaDays(agenda, timeZone) : [];
  const hasAgenda = agenda !== null;
  const refreshing = agendaLoading && hasAgenda;
  const hasFeedback = Boolean(
    status?.fallbackReason || status?.errorReason || statusError || actionError || (hasAgenda && agendaError),
  );
  const availabilityLabel = status
    ? `${status.visible ? "Visible" : "Hidden"} · Floating window`
    : "Checking widget status";

  return (
    <main className="widget-surface" data-surface="widget">
      <section
        className={`widget-card${hasFeedback ? " widget-card--has-feedback" : ""}`}
        aria-labelledby="widget-title"
      >
        <header className="widget-header">
          <div>
            <p className="widget-eyebrow">Note</p>
            <h1 id="widget-title">Agenda</h1>
            <p className="widget-window-status" role="status">{availabilityLabel}</p>
          </div>
          <button
            className="widget-open-calendar"
            disabled={pendingAction !== null}
            onClick={() => void openCalendar()}
            type="button"
          >
            {pendingAction === "open" ? "Opening…" : "Open calendar"}
          </button>
        </header>

        <div className="widget-controls">
          <button
            disabled={!hasAgenda && agendaLoading}
            onClick={() => void refreshAgenda()}
            type="button"
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          <button
            aria-pressed={status?.locked ?? false}
            disabled={!status || pendingAction !== null}
            onClick={() => void updateStatus("lock", () => widgetClient.setLocked(!status?.locked))}
            type="button"
          >
            {pendingAction === "lock" ? "Updating…" : status?.locked ? "Unlock widget" : "Lock widget"}
          </button>
          <fieldset className="widget-size-controls" disabled={!status || pendingAction !== null}>
            <legend>Widget size</legend>
            <div>
              {sizePresets.map((preset) => (
                <button
                  aria-pressed={status?.sizePreset === preset.value}
                  key={preset.value}
                  onClick={() => void updateStatus("size", () => widgetClient.setSizePreset(preset.value))}
                  type="button"
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </fieldset>
        </div>

        <div
          aria-label={hasFeedback ? "Widget feedback" : undefined}
          className="widget-feedback"
          role={hasFeedback ? "region" : undefined}
          tabIndex={hasFeedback ? 0 : undefined}
        >
          {status?.fallbackReason === "desktop_attachment_unavailable" && (
            <p className="widget-notice" role="status">
              Desktop placement is unavailable, so this agenda stays in a floating window.
            </p>
          )}
          {status?.errorReason && (
            <p className="widget-notice" role="status">Widget status: {status.errorReason}</p>
          )}
          {statusError && <p className="widget-error" role="status">{statusError}</p>}
          {actionError && <p className="widget-error" role="alert">{actionError}</p>}
          {hasAgenda && agendaError && (
            <p className="widget-error" role="status">
              Latest refresh failed. Showing previously loaded agenda. {agendaError}
            </p>
          )}
        </div>

        <div
          aria-busy={agendaLoading}
          aria-label="Upcoming agenda"
          className="widget-agenda"
          role="region"
          tabIndex={0}
        >
          {!hasAgenda && agendaLoading && !agendaError && (
            <p className="widget-loading" role="status">Loading agenda…</p>
          )}
          {!hasAgenda && agendaError && (
            <div className="widget-empty-state" role="alert">
              <p
                ref={agendaLoading ? retryStatusRef : undefined}
                role={agendaLoading ? "status" : undefined}
                tabIndex={agendaLoading ? -1 : undefined}
              >
                {agendaLoading ? `Retrying agenda… ${agendaError}` : agendaError}
              </p>
              <button
                disabled={agendaLoading}
                onClick={() => void refreshAgenda()}
                type="button"
              >
                {agendaLoading ? "Trying again…" : "Try again"}
              </button>
            </div>
          )}
          {hasAgenda && !agendaError && refreshing && (
            <p className="widget-loading" role="status">Refreshing agenda…</p>
          )}
          {hasAgenda && days.length === 0 && !agendaError && (
            <div className="widget-empty-state" role="status">
              <p>No upcoming events.</p>
              <p>Your next seven days are clear.</p>
            </div>
          )}
          {days.map((day) => (
            <section className="widget-day" key={day.dateKey} aria-labelledby={`widget-day-${day.dateKey}`}>
              <h2 id={`widget-day-${day.dateKey}`}>{day.label}</h2>
              <ul>
                {day.items.map((item) => (
                  <li key={`${item.eventId}-${item.occurrenceKey}`}>
                    <span className="widget-event-title">{item.title || "Untitled event"}</span>
                    <time className="widget-event-time">{timeLabel(item, timeZone)}</time>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </section>
    </main>
  );
}
