import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  CalendarClientError,
  calendarClient,
  listenForCalendarChanges,
  type CalendarOccurrence,
  type CalendarReadiness,
  type CalendarSettings,
} from "../../native/calendarClient";
import { AGENDA_DAYS, addDays, groupByDate, isoDate, monthGridRange, occurrenceKey, rangeForDates, startOfMonth, timeLabel } from "./calendarUtils";
import EventEditor, { type EditorState } from "./EventEditor";
import "./calendar.css";

type View = "agenda" | "month";
type AgendaDay = { date: string; occurrences: CalendarOccurrence[] };
type Direction = "before" | "after";
type ErrorSource = "agenda" | "month" | "readiness" | "search" | "settings";
type WorkspaceError = { message: string; source: ErrorSource };
type AgendaModel = {
  days: AgendaDay[];
  cursors: Record<Direction, string | null>;
  exhausted: Record<Direction, boolean>;
};

const defaultSettings: CalendarSettings = { defaultEventDurationMinutes: 60, weekStartsOn: "monday", timeFormat: "system", defaultReminderMinutes: null };
const emptyAgenda: AgendaModel = { days: [], cursors: { before: null, after: null }, exhausted: { before: false, after: false } };

export default function CalendarWorkspace({ activeView, onViewChange }: { activeView: View; onViewChange: (view: View) => void }) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const [readiness, setReadiness] = useState<CalendarReadiness>({ state: "loading" });
  const [settings, setSettings] = useState(defaultSettings);
  const [anchor, setAnchor] = useState(isoDate());
  const [month, setMonth] = useState(startOfMonth(isoDate()));
  const [agenda, setAgenda] = useState<AgendaModel>(emptyAgenda);
  const agendaRef = useRef(emptyAgenda);
  const [agendaBusy, setAgendaBusy] = useState(false);
  const [monthItems, setMonthItems] = useState<CalendarOccurrence[]>([]);
  const [selectedDate, setSelectedDate] = useState(isoDate());
  const [search, setSearch] = useState("");
  const [searchRetry, setSearchRetry] = useState(0);
  const [searchItems, setSearchItems] = useState<CalendarOccurrence[]>([]);
  const [error, setError] = useState<WorkspaceError | null>(null);
  const [editor, setEditor] = useState<EditorState>(null);
  const agendaGeneration = useRef(0);
  const monthGeneration = useRef(0);
  const searchGeneration = useRef(0);
  const desiredSettings = useRef(defaultSettings);
  const persistedSettings = useRef(defaultSettings);
  const settingsSavePending = useRef(false);
  const settingsSaveRunning = useRef(false);
  const refreshTimer = useRef<number | null>(null);

  const replaceAgenda = useCallback((next: AgendaModel) => {
    agendaRef.current = next;
    setAgenda(next);
  }, []);

  const loadReadiness = useCallback(async () => {
    try {
      const next = await calendarClient.getReadiness();
      if (next.state === "ready") {
        try {
          const loadedSettings = await calendarClient.getSettings();
          desiredSettings.current = loadedSettings;
          persistedSettings.current = loadedSettings;
          setSettings(loadedSettings);
        } catch (cause) {
          setError({ source: "settings", message: messageFor(cause) });
        }
      }
      setReadiness(next);
    } catch (cause) {
      setReadiness({ state: "unavailable", initializationDurationMs: 0 });
      setError({ source: "readiness", message: messageFor(cause) });
    }
  }, []);

  const loadAgenda = useCallback(async (direction: Direction, reset = false, resetAnchor = anchor) => {
    const token = ++agendaGeneration.current;
    const current = agendaRef.current;
    if (!reset && current.exhausted[direction]) return;
    setAgendaBusy(true);
    try {
      const cursor = reset ? null : current.cursors[direction];
      const boundary = direction === "before"
        ? current.days[0]?.date ?? resetAnchor
        : current.days.length ? addDays(current.days[current.days.length - 1].date, 1) : resetAnchor;
      const page = await calendarClient.agendaPage({
        direction,
        ...(cursor ? { cursor } : { anchorDate: reset ? resetAnchor : boundary }),
        displayTimeZone: timeZone,
        limit: AGENDA_DAYS,
      });
      if (token !== agendaGeneration.current) return;
      setError((current) => current?.source === "agenda" ? null : current);
      const incoming = page.days.map((day) => ({ ...day, occurrences: dedupe(day.occurrences) }));
      if (reset) {
        replaceAgenda({
          days: incoming.slice(0, 64),
          cursors: { before: null, after: page.nextCursor },
          exhausted: { before: false, after: page.exhausted },
        });
        return;
      }
      const merged = direction === "before" ? [...incoming, ...current.days] : [...current.days, ...incoming];
      const unique = new Map(merged.map((day) => [day.date, day]));
      const sorted = [...unique.values()].sort((a, b) => a.date.localeCompare(b.date));
      const trimmed = sorted.length > 64;
      const days = trimmed ? direction === "before" ? sorted.slice(0, 64) : sorted.slice(-64) : sorted;
      const cursors = { ...current.cursors, [direction]: page.nextCursor };
      const exhausted = { ...current.exhausted, [direction]: page.exhausted };
      if (trimmed) {
        const opposite: Direction = direction === "before" ? "after" : "before";
        cursors[opposite] = null;
        exhausted[opposite] = false;
      }
      replaceAgenda({ days, cursors, exhausted });
    } catch (cause) {
      if (token === agendaGeneration.current) setError({ source: "agenda", message: messageFor(cause) });
    } finally {
      if (token === agendaGeneration.current) setAgendaBusy(false);
    }
  }, [anchor, replaceAgenda, timeZone]);

  const loadMonth = useCallback(async () => {
    const token = ++monthGeneration.current;
    const range = monthGridRange(month, settings.weekStartsOn);
    try {
      const items = await calendarClient.listEvents(rangeForDates(range.start, range.endExclusive));
      if (token === monthGeneration.current) {
        setMonthItems(dedupe(items));
        setError((current) => current?.source === "month" ? null : current);
      }
    } catch (cause) {
      if (token === monthGeneration.current) setError({ source: "month", message: messageFor(cause) });
    }
  }, [month, settings.weekStartsOn]);

  const refresh = useCallback(() => {
    if (readiness.state !== "ready") return;
    if (activeView === "agenda") void loadAgenda("after", true);
    else void loadMonth();
  }, [activeView, loadAgenda, loadMonth, readiness.state]);

  const retryError = useCallback(() => {
    if (!error) return;
    if (error.source === "agenda") void loadAgenda("after", true);
    else if (error.source === "month") void loadMonth();
    else if (error.source === "search") setSearchRetry((value) => value + 1);
  }, [error, loadAgenda, loadMonth]);

  const retryReadiness = useCallback(async () => {
    setError((current) => current?.source === "readiness" ? null : current);
    try {
      setReadiness(await calendarClient.retryInitialization());
      await loadReadiness();
    } catch (cause) {
      setReadiness({ state: "unavailable", initializationDurationMs: 0 });
      setError({ source: "readiness", message: messageFor(cause) });
    }
  }, [loadReadiness]);

  const flushSettings = useCallback(async () => {
    if (settingsSaveRunning.current) return;
    settingsSaveRunning.current = true;
    try {
      while (settingsSavePending.current) {
        settingsSavePending.current = false;
        const target = desiredSettings.current;
        try {
          const saved = await calendarClient.updateSettings(target);
          persistedSettings.current = saved;
          if (desiredSettings.current === target) {
            desiredSettings.current = saved;
            setSettings(saved);
            setError((current) => current?.source === "settings" ? null : current);
          }
        } catch (cause) {
          if (desiredSettings.current === target) {
            desiredSettings.current = persistedSettings.current;
            setSettings(persistedSettings.current);
            setError({ source: "settings", message: `${messageFor(cause)} Settings were not changed.` });
          }
        }
      }
    } finally {
      settingsSaveRunning.current = false;
    }
  }, []);

  const saveSettings = useCallback((patch: Partial<CalendarSettings>) => {
    const next = { ...desiredSettings.current, ...patch };
    desiredSettings.current = next;
    setSettings(next);
    settingsSavePending.current = true;
    void flushSettings();
  }, [flushSettings]);

  useEffect(() => { void loadReadiness(); }, [loadReadiness]);
  useEffect(() => { if (readiness.state === "ready") refresh(); }, [readiness.state, refresh]);
  useEffect(() => {
    const controller = new AbortController();
    void listenForCalendarChanges(() => {
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(refresh, 120);
    }, controller.signal).catch(() => undefined);
    return () => {
      controller.abort();
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    };
  }, [refresh]);
  useEffect(() => {
    const token = ++searchGeneration.current;
    const query = search.trim().slice(0, 200);
    if (!query || readiness.state !== "ready") {
      setSearchItems([]);
      return;
    }
    const timer = window.setTimeout(() => {
      const start = isoDate();
      void calendarClient.searchEvents({ ...rangeForDates(start, addDays(start, 366)), query, limit: 50 })
        .then((items) => {
          if (token === searchGeneration.current) {
            setSearchItems(dedupe(items));
            setError((current) => current?.source === "search" ? null : current);
          }
        })
        .catch((cause) => { if (token === searchGeneration.current) setError({ source: "search", message: messageFor(cause) }); });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [readiness.state, search, searchRetry]);

  const monthGroups = useMemo(() => {
    const range = monthGridRange(month, settings.weekStartsOn);
    return groupByDate(monthItems, range.start, 42, timeZone);
  }, [month, monthItems, settings.weekStartsOn, timeZone]);
  const selectedItems = useMemo(() => monthGroups.get(selectedDate) ?? [], [monthGroups, selectedDate]);

  if (readiness.state !== "ready") return <Readiness readiness={readiness} error={error} onRetry={retryReadiness} />;

  return <main className="calendar-workspace" aria-label="Calendar">
    <header className="calendar-header">
      <div><p className="calendar-kicker">Calendar</p><h1>{activeView === "agenda" ? "Agenda" : new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(new Date(`${month}T12:00:00`))}</h1></div>
      <div className="calendar-actions"><span className="calendar-zone" title={timeZone}>{timeZone}</span><button className="calendar-button calendar-primary" onClick={() => setEditor({ date: selectedDate, scope: "series" })} type="button">New event</button></div>
    </header>
    <div className="calendar-toolbar" role="toolbar" aria-label="Calendar controls">
      <div className="calendar-segmented" aria-label="Calendar view"><button aria-pressed={activeView === "agenda"} onClick={() => onViewChange("agenda")} type="button">Agenda</button><button aria-pressed={activeView === "month"} onClick={() => onViewChange("month")} type="button">Month</button></div>
      <button className="calendar-button" onClick={() => { const today = isoDate(); setAnchor(today); setMonth(startOfMonth(today)); setSelectedDate(today); }} type="button">Today</button>
      {activeView === "month" && <><button aria-label="Previous month" className="calendar-icon-button" onClick={() => { const next = startOfMonth(addDays(month, -1)); setMonth(next); setSelectedDate(next); }} type="button">‹</button><button aria-label="Next month" className="calendar-icon-button" onClick={() => { const next = startOfMonth(addDays(month, 32)); setMonth(next); setSelectedDate(next); }} type="button">›</button></>}
      <label className="calendar-search"><span className="visually-hidden">Search events</span><input maxLength={200} onChange={(event) => setSearch(event.currentTarget.value)} placeholder="Search calendar" value={search} /></label>
      <details className="calendar-settings"><summary>Settings</summary><label>Week starts <select value={settings.weekStartsOn} onChange={(event) => void saveSettings({ weekStartsOn: event.currentTarget.value as CalendarSettings["weekStartsOn"] })}><option value="monday">Monday</option><option value="sunday">Sunday</option></select></label><label>Time format <select value={settings.timeFormat} onChange={(event) => void saveSettings({ timeFormat: event.currentTarget.value as CalendarSettings["timeFormat"] })}><option value="system">System</option><option value="12h">12-hour</option><option value="24h">24-hour</option></select></label></details>
    </div>
    {error && <div className="calendar-error" role="alert">{error.message}{["agenda", "month", "search"].includes(error.source) && <button onClick={retryError} type="button">Retry</button>}</div>}
    {search.trim() ? <SearchResults items={searchItems} onSelect={(occurrence) => setEditor({ occurrence, date: selectedDate, scope: occurrence.recurrenceRule ? "occurrence" : "series" })} settings={settings} timeZone={timeZone} /> : activeView === "agenda" ? <Agenda days={agenda.days} busy={agendaBusy} exhausted={agenda.exhausted} onEarlier={() => void loadAgenda("before")} onLater={() => void loadAgenda("after")} onSelect={(occurrence, date) => setEditor({ occurrence, date, scope: occurrence.recurrenceRule ? "occurrence" : "series" })} settings={settings} timeZone={timeZone} /> : <MonthGrid month={month} groups={monthGroups} selectedDate={selectedDate} onSelectDate={setSelectedDate} onSelect={setEditor} settings={settings} />}
    {activeView === "month" && <aside className="calendar-day-detail" aria-label={`Events on ${selectedDate}`}><h2>{new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(new Date(`${selectedDate}T12:00:00`))}</h2><EventList date={selectedDate} items={selectedItems} settings={settings} timeZone={timeZone} onSelect={(occurrence) => setEditor({ occurrence, date: selectedDate, scope: occurrence.recurrenceRule ? "occurrence" : "series" })} /></aside>}
    {editor && <EventEditor initial={editor} settings={settings} displayTimeZone={timeZone} onClose={() => setEditor(null)} onChanged={refresh} />}
  </main>;
}

function Readiness({ readiness, error, onRetry }: { readiness: CalendarReadiness; error: WorkspaceError | null; onRetry: () => Promise<void> }) {
  const [retrying, setRetrying] = useState(false);
  return <main className="calendar-workspace calendar-readiness" role={readiness.state === "loading" ? "status" : undefined}><h1>{readiness.state === "loading" ? "Opening calendar…" : "Calendar is unavailable"}</h1><p>{error?.message ?? (readiness.state === "loading" ? "Your notes are ready while calendar storage initializes." : "Calendar storage could not be opened. Your notes are unaffected.")}</p>{readiness.state === "unavailable" && <button className="calendar-button calendar-primary" disabled={retrying} onClick={() => { setRetrying(true); void onRetry().finally(() => setRetrying(false)); }} type="button">{retrying ? "Retrying…" : "Retry calendar"}</button>}</main>;
}

function Agenda({ days, busy, exhausted, onEarlier, onLater, onSelect, settings, timeZone }: { days: AgendaDay[]; busy: boolean; exhausted: Record<Direction, boolean>; onEarlier: () => void; onLater: () => void; onSelect: (occurrence: CalendarOccurrence, date: string) => void; settings: CalendarSettings; timeZone: string }) {
  const count = days.reduce((total, day) => total + day.occurrences.length, 0);
  return <section className="calendar-agenda"><button className="calendar-button" disabled={busy || exhausted.before} onClick={onEarlier} type="button">{exhausted.before ? "No earlier events" : "Earlier"}</button>{days.length === 0 && !busy ? <p className="calendar-empty">No events in this window.</p> : count > 100 ? <WindowedAgenda days={days} onSelect={onSelect} settings={settings} timeZone={timeZone} /> : days.map((day) => <section className="calendar-agenda-day" key={day.date}><h2>{dayHeading(day.date)}</h2><EventList date={day.date} items={day.occurrences} settings={settings} timeZone={timeZone} onSelect={(occurrence) => onSelect(occurrence, day.date)} /></section>)}<button className="calendar-button" disabled={busy || exhausted.after} onClick={onLater} type="button">{busy ? "Loading…" : exhausted.after ? "No later events" : "Later"}</button></section>;
}

type VirtualRow = { key: string; kind: "heading"; date: string } | { key: string; kind: "event"; date: string; occurrence: CalendarOccurrence } | { key: string; kind: "empty"; date: string };

function WindowedAgenda({ days, onSelect, settings, timeZone }: { days: AgendaDay[]; onSelect: (occurrence: CalendarOccurrence, date: string) => void; settings: CalendarSettings; timeZone: string }) {
  const rows = useMemo<VirtualRow[]>(() => days.flatMap((day) => [{ key: `heading:${day.date}`, kind: "heading" as const, date: day.date }, ...(day.occurrences.length ? day.occurrences.map((occurrence) => ({ key: `${day.date}:${occurrenceKey(occurrence)}`, kind: "event" as const, date: day.date, occurrence })) : [{ key: `empty:${day.date}`, kind: "empty" as const, date: day.date }])]), [days]);
  const viewport = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<string, number>());
  const [measureVersion, setMeasureVersion] = useState(0);
  const [windowState, setWindowState] = useState({ top: 0, height: 600 });
  useLayoutEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const update = () => setWindowState({ top: node.scrollTop, height: node.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    node.addEventListener("scroll", update, { passive: true });
    return () => { observer.disconnect(); node.removeEventListener("scroll", update); };
  }, []);
  const offsets = useMemo(() => {
    let total = 0;
    return rows.map((row) => { const top = total; total += heights.current.get(row.key) ?? (row.kind === "heading" ? 49 : 52); return { row, top, height: heights.current.get(row.key) ?? (row.kind === "heading" ? 49 : 52), total }; });
  }, [measureVersion, rows]);
  const start = Math.max(0, offsets.findIndex((entry) => entry.top + entry.height >= windowState.top) - 5);
  const firstAfter = offsets.findIndex((entry) => entry.top > windowState.top + windowState.height);
  const end = Math.min(offsets.length, (firstAfter < 0 ? offsets.length : firstAfter) + 5);
  const totalHeight = offsets.length ? offsets[offsets.length - 1].total : 0;
  const measure = useCallback((key: string, height: number) => {
    if (heights.current.get(key) !== height) {
      heights.current.set(key, height);
      setMeasureVersion((value) => value + 1);
    }
  }, []);
  return <section aria-label={`${rows.length} agenda rows`} className="calendar-virtual-viewport" ref={viewport}><div className="calendar-virtual-content" style={{ height: totalHeight }}>{offsets.slice(start, end).map(({ row, top }) => <MeasuredRow key={row.key} rowKey={row.key} top={top} onMeasure={measure}>{row.kind === "heading" ? <h2>{dayHeading(row.date)}</h2> : row.kind === "empty" ? <p className="calendar-empty">No events.</p> : <EventButton date={row.date} item={row.occurrence} onSelect={() => onSelect(row.occurrence, row.date)} settings={settings} timeZone={timeZone} />}</MeasuredRow>)}</div></section>;
}

function MeasuredRow({ children, onMeasure, rowKey, top }: { children: React.ReactNode; onMeasure: (key: string, height: number) => void; rowKey: string; top: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(() => onMeasure(rowKey, node.getBoundingClientRect().height));
    observer.observe(node);
    onMeasure(rowKey, node.getBoundingClientRect().height);
    return () => observer.disconnect();
  }, [onMeasure, rowKey]);
  return <div className="calendar-virtual-row" ref={ref} style={{ transform: `translateY(${top}px)` }}>{children}</div>;
}

function SearchResults({ items, onSelect, settings, timeZone }: { items: CalendarOccurrence[]; onSelect: (item: CalendarOccurrence) => void; settings: CalendarSettings; timeZone: string }) { return <section className="calendar-search-results" aria-live="polite"><h2>Search results</h2><EventList items={items} settings={settings} timeZone={timeZone} onSelect={onSelect} /></section>; }
function EventList({ date, items, settings, timeZone, onSelect }: { date?: string; items: CalendarOccurrence[]; settings: CalendarSettings; timeZone: string; onSelect: (item: CalendarOccurrence) => void }) { return items.length ? <div className="calendar-event-list">{items.map((item) => <EventButton date={date} item={item} key={occurrenceKey(item)} onSelect={() => onSelect(item)} settings={settings} timeZone={timeZone} />)}</div> : <p className="calendar-empty">No events.</p>; }
function EventButton({ date, item, settings, timeZone, onSelect }: { date?: string; item: CalendarOccurrence; settings: CalendarSettings; timeZone: string; onSelect: () => void }) { return <button className="calendar-event" onClick={onSelect} type="button"><span>{item.title}</span><small>{timeLabel(item.time, settings.timeFormat, timeZone, date)}{item.location ? ` · ${item.location}` : ""}</small></button>; }

function MonthGrid({ month, groups, selectedDate, onSelectDate, onSelect, settings }: { month: string; groups: Map<string, CalendarOccurrence[]>; selectedDate: string; onSelectDate: (date: string) => void; onSelect: (state: EditorState) => void; settings: CalendarSettings }) {
  const range = monthGridRange(month, settings.weekStartsOn);
  const weekdays = settings.weekStartsOn === "monday" ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const moveFocus = (event: React.KeyboardEvent, date: string) => {
    const offsets: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    const offset = offsets[event.key];
    if (!offset) return;
    event.preventDefault();
    const next = addDays(date, offset);
    if (next < range.start || next >= range.endExclusive) return;
    onSelectDate(next);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-calendar-date="${next}"]`)?.focus());
  };
  const cell = (index: number) => {
    const date = addDays(range.start, index);
    const items = groups.get(date) ?? [];
    return <article className={`calendar-cell ${date.slice(0, 7) !== month.slice(0, 7) ? "is-outside" : ""} ${date === selectedDate ? "is-selected" : ""}`} key={date} role="gridcell"><button aria-label={`Select ${date}`} className="calendar-day-button" data-calendar-date={date} onClick={() => onSelectDate(date)} onKeyDown={(event) => moveFocus(event, date)} tabIndex={date === selectedDate ? 0 : -1} type="button">{Number(date.slice(-2))}</button>{items.slice(0, 2).map((item) => <button className="calendar-cell-item" key={occurrenceKey(item)} onClick={() => onSelect({ occurrence: item, date, scope: item.recurrenceRule ? "occurrence" : "series" })} type="button">{item.title}</button>)}{items.length > 2 && <button className="calendar-more" onClick={() => onSelectDate(date)} type="button">+{items.length - 2}</button>}</article>;
  };
  return <section className="calendar-month"><div aria-label="Month" className="calendar-grid" role="grid"><div className="calendar-grid-row" role="row">{weekdays.map((day) => <span key={day} role="columnheader">{day}</span>)}</div>{Array.from({ length: 6 }, (_, week) => <div className="calendar-grid-row" key={week} role="row">{Array.from({ length: 7 }, (_, day) => cell(week * 7 + day))}</div>)}</div></section>;
}

function dayHeading(date: string) { return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric" }).format(new Date(`${date}T12:00:00`)); }
function dedupe(items: CalendarOccurrence[]) { const result = new Map<string, CalendarOccurrence>(); items.forEach((item) => result.set(occurrenceKey(item), item)); return [...result.values()]; }
function messageFor(cause: unknown) { return cause instanceof CalendarClientError ? cause.message : "Calendar request failed. Please try again."; }
