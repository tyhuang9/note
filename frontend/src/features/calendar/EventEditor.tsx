import { useEffect, useRef, useState } from "react";
import {
  CalendarClientError,
  calendarClient,
  type CalendarEvent,
  type CalendarOccurrence,
  type CalendarSettings,
  type EventDraft,
} from "../../native/calendarClient";
import { addDays, addLocalMinutes, localDateTime, parseDraftDate, parseRecurrence, recurrenceFor } from "./calendarUtils";

type EditorScope = "occurrence" | "series";
export type EditorState = { occurrence?: CalendarOccurrence; date: string; scope: EditorScope } | null;

export default function EventEditor({ initial, settings, displayTimeZone, onClose, onChanged }: { initial: NonNullable<EditorState>; settings: CalendarSettings; displayTimeZone: string; onClose: () => void; onChanged: () => void }) {
  const existing = initial.occurrence;
  const initialTime = existing?.time;
  const defaultStart = `${initial.date}T09:00`;
  const initialZone = initialTime?.temporalKind === "timed" ? initialTime.timeZone : displayTimeZone;
  const recurrence = parseRecurrence(existing?.recurrenceRule, initialZone);
  const [title, setTitle] = useState(existing?.title ?? "");
  const [location, setLocation] = useState(existing?.location ?? "");
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [allDay, setAllDay] = useState(initialTime?.temporalKind === "allDay");
  const [start, setStart] = useState(initialTime?.temporalKind === "timed" ? localDateTime(initialTime.startUtcMs, initialZone) : initialTime?.temporalKind === "allDay" ? initialTime.startDate : defaultStart);
  const [end, setEnd] = useState(initialTime?.temporalKind === "timed" ? localDateTime(initialTime.endUtcMs, initialZone) : initialTime?.temporalKind === "allDay" ? initialTime.endDateExclusive : addLocalMinutes(defaultStart, settings.defaultEventDurationMinutes));
  const [eventTimeZone, setEventTimeZone] = useState(initialZone);
  const [scope, setScope] = useState<EditorScope>(initial.scope);
  const [preset, setPreset] = useState(recurrence.preset);
  const [ending, setEnding] = useState(recurrence.ending);
  const [until, setUntil] = useState(recurrence.until);
  const [count, setCount] = useState(recurrence.count);
  const [recurrenceChanged, setRecurrenceChanged] = useState(false);
  const [rawRecurrence, setRawRecurrence] = useState(existing?.recurrenceRule ?? null);
  const [reminders, setReminders] = useState<number[]>(existing?.reminderOffsetsMinutes ?? (settings.defaultReminderMinutes === null ? [] : [settings.defaultReminderMinutes]));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [expectedRevision, setExpectedRevision] = useState(existing?.revision ?? 0);
  const [latest, setLatest] = useState<CalendarEvent | null>(null);
  const [master, setMaster] = useState<CalendarEvent | null>(null);
  const [loadingMaster, setLoadingMaster] = useState(Boolean(existing?.recurrenceRule));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const conflictRef = useRef<HTMLDivElement>(null);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const returnTo = useRef(document.activeElement as HTMLElement | null);
  const saveInFlight = useRef(false);

  useEffect(() => {
    const restoreBackground = isolateModalBackground(backdropRef.current);
    dialogRef.current?.querySelector<HTMLElement>("input, button, select, textarea")?.focus();
    return () => {
      restoreBackground();
      returnTo.current?.focus();
    };
  }, []);
  useEffect(() => { if (latest) conflictRef.current?.focus(); }, [latest]);
  useEffect(() => { if (confirmDelete) deleteCancelRef.current?.focus(); }, [confirmDelete]);
  useEffect(() => {
    if (!existing?.recurrenceRule) return;
    let active = true;
    void calendarClient.getEvent(existing.eventId)
      .then((event) => { if (active) setMaster(event); })
      .catch((cause) => { if (active) setError(`${messageFor(cause)} The event series could not be loaded.`); })
      .finally(() => { if (active) setLoadingMaster(false); });
    return () => { active = false; };
  }, [existing?.eventId, existing?.recurrenceRule]);

  const recurrenceRule = () => recurrenceChanged
    ? recurrenceFor(preset, ending, until, count, { start, allDay, timeZone: eventTimeZone })
    : rawRecurrence;
  const draft = (): EventDraft => ({
    title: title.trim(),
    location: location || null,
    notes: notes || null,
    time: allDay
      ? { temporalKind: "allDay", startDate: parseDraftDate(start), endDateExclusive: parseDraftDate(end) }
      : { temporalKind: "timed", localStart: withSeconds(start), localEnd: withSeconds(end), timeZone: eventTimeZone },
    ...(scope === "series" ? { recurrenceRule: recurrenceRule() } : {}),
    reminderOffsetsMinutes: [...new Set(reminders)].sort((a, b) => a - b),
  });

  const validate = () => {
    if (!title.trim()) return "A title is required.";
    if (title.length > 500 || location.length > 2000 || notes.length > 20000) return "One or more fields exceed their allowed length.";
    if (reminders.length > 5 || reminders.some((value) => !Number.isInteger(value) || value < 0 || value > 50400) || new Set(reminders).size !== reminders.length) return "Use up to five unique reminders between 0 and 50,400 minutes.";
    if (allDay) {
      const startDate = parseDraftDate(start);
      const endDate = parseDraftDate(end);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || startDate >= endDate) return "All-day events must end after they start.";
    } else if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(end) || start >= end) {
      return "Timed events must end after they start.";
    }
    if (scope === "series" && preset !== "none" && preset !== "custom") {
      if (ending === "count" && (!/^\d+$/.test(count) || Number(count) < 1 || Number(count) > 500000)) return "Repeat count must be between 1 and 500,000.";
      if (ending === "until" && (!/^\d{4}-\d{2}-\d{2}$/.test(until) || until < parseDraftDate(start))) return "Repeat end date must be on or after the series start date.";
    }
    try { if (scope === "series") recurrenceRule(); } catch (cause) { return cause instanceof Error ? cause.message : "The recurrence rule is invalid."; }
    return null;
  };

  const save = async () => {
    if (saveInFlight.current) return;
    const validationError = validate();
    if (validationError) { setError(validationError); return; }
    saveInFlight.current = true;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const value = draft();
      if (!existing) await calendarClient.createEvent(value);
      else if (scope === "occurrence") {
        const { recurrenceRule: _recurrenceRule, ...occurrenceDraft } = value;
        await calendarClient.updateOccurrence(existing.eventId, existing.occurrenceKey, expectedRevision, occurrenceDraft);
      } else await calendarClient.updateEvent(existing.eventId, expectedRevision, value);
      onChanged();
      onClose();
    } catch (cause) {
      if (cause instanceof CalendarClientError && cause.code === "revision_conflict" && existing) {
        setError("This event changed elsewhere. Your draft is still here.");
        try { setLatest(await calendarClient.getEvent(existing.eventId)); } catch { setError("This event changed elsewhere. Your draft is still here, but the latest version could not be loaded."); }
      } else setError(`${messageFor(cause)} Your draft is still here.`);
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!existing || saveInFlight.current || latest) return;
    saveInFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      if (scope === "occurrence") await calendarClient.deleteOccurrence(existing.eventId, existing.occurrenceKey, expectedRevision);
      else await calendarClient.deleteEvent(existing.eventId, expectedRevision);
      onChanged();
      onClose();
    } catch (cause) {
      setError(cause instanceof CalendarClientError && cause.code === "revision_conflict" ? "This event changed elsewhere. Close and review the latest event before deleting." : messageFor(cause));
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  };

  const reviewLatest = () => {
    if (!latest || scope !== "series") return;
    setTitle(latest.title);
    setLocation(latest.location ?? "");
    setNotes(latest.notes ?? "");
    setReminders(latest.reminderOffsetsMinutes);
    setExpectedRevision(latest.revision);
    if (latest.time.temporalKind === "timed") {
      setAllDay(false);
      setEventTimeZone(latest.time.timeZone);
      setStart(localDateTime(latest.time.startUtcMs, latest.time.timeZone));
      setEnd(localDateTime(latest.time.endUtcMs, latest.time.timeZone));
    } else {
      setAllDay(true);
      setStart(latest.time.startDate);
      setEnd(latest.time.endDateExclusive);
    }
    const nextRecurrence = parseRecurrence(latest.recurrenceRule, latest.time.temporalKind === "timed" ? latest.time.timeZone : displayTimeZone);
    setPreset(nextRecurrence.preset);
    setEnding(nextRecurrence.ending);
    setUntil(nextRecurrence.until);
    setCount(nextRecurrence.count);
    setRecurrenceChanged(false);
    setLatest(null);
    setRawRecurrence(latest.recurrenceRule);
    setError(null);
    setNotice("Latest version loaded. Review it before saving.");
  };

  const keepEditing = () => {
    if (!latest) return;
    setExpectedRevision(latest.revision);
    setLatest(null);
    setError(null);
    setNotice("Keeping your draft. Saving will apply it over the latest version.");
  };

  const applyMaster = () => {
    if (!master) {
      setError("The event series is not ready to edit. Try again.");
      return;
    }
    setScope("series");
    setTitle(master.title);
    setLocation(master.location ?? "");
    setNotes(master.notes ?? "");
    setReminders(master.reminderOffsetsMinutes);
    setExpectedRevision(master.revision);
    setRawRecurrence(master.recurrenceRule);
    if (master.time.temporalKind === "timed") {
      setAllDay(false);
      setEventTimeZone(master.time.timeZone);
      setStart(localDateTime(master.time.startUtcMs, master.time.timeZone));
      setEnd(localDateTime(master.time.endUtcMs, master.time.timeZone));
    } else {
      setAllDay(true);
      setStart(master.time.startDate);
      setEnd(master.time.endDateExclusive);
    }
    const parsed = parseRecurrence(master.recurrenceRule, master.time.temporalKind === "timed" ? master.time.timeZone : displayTimeZone);
    setPreset(parsed.preset);
    setEnding(parsed.ending);
    setUntil(parsed.until);
    setCount(parsed.count);
    setRecurrenceChanged(false);
    setError(null);
    setNotice("Editing the entire series from its original start.");
  };

  const applyOccurrence = () => {
    if (!existing) return;
    setScope("occurrence");
    setTitle(existing.title);
    setLocation(existing.location ?? "");
    setNotes(existing.notes ?? "");
    setReminders(existing.reminderOffsetsMinutes);
    setExpectedRevision(existing.revision);
    setRawRecurrence(existing.recurrenceRule);
    if (existing.time.temporalKind === "timed") {
      setAllDay(false);
      setEventTimeZone(existing.time.timeZone);
      setStart(localDateTime(existing.time.startUtcMs, existing.time.timeZone));
      setEnd(localDateTime(existing.time.endUtcMs, existing.time.timeZone));
    } else {
      setAllDay(true);
      setStart(existing.time.startDate);
      setEnd(existing.time.endDateExclusive);
    }
    const parsed = parseRecurrence(existing.recurrenceRule, existing.time.temporalKind === "timed" ? existing.time.timeZone : displayTimeZone);
    setPreset(parsed.preset);
    setEnding(parsed.ending);
    setUntil(parsed.until);
    setCount(parsed.count);
    setRecurrenceChanged(false);
    setError(null);
    setNotice("Editing only this occurrence.");
  };

  const changeStart = (value: string) => {
    setStart(value);
    if (scope === "series" && preset !== "none" && preset !== "custom") setRecurrenceChanged(true);
  };

  const toggleAllDay = (next: boolean) => {
    if (next === allDay) return;
    if (next) {
      const startDate = parseDraftDate(start);
      const endDate = parseDraftDate(end);
      setStart(startDate);
      setEnd(end.endsWith("T00:00") && endDate > startDate ? endDate : addDays(endDate >= startDate ? endDate : startDate, 1));
    } else {
      const startDate = parseDraftDate(start);
      const lastDate = addDays(parseDraftDate(end), -1);
      const nextStart = `${startDate}T09:00`;
      setStart(nextStart);
      setEnd(lastDate === startDate ? addLocalMinutes(nextStart, settings.defaultEventDurationMinutes) : addLocalMinutes(`${lastDate}T09:00`, settings.defaultEventDurationMinutes));
    }
    setAllDay(next);
    if (scope === "series" && preset !== "none" && preset !== "custom") setRecurrenceChanged(true);
  };

  const safeClose = () => { if (!saveInFlight.current) onClose(); };

  return <div className="calendar-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) safeClose(); }} ref={backdropRef}><div aria-describedby="calendar-editor-help" aria-labelledby="calendar-editor-title" aria-modal="true" className="calendar-dialog" onKeyDown={(event) => { if (event.key === "Escape") safeClose(); if (event.key === "Tab") trapFocus(event, dialogRef.current); }} ref={dialogRef} role="dialog">
    <header><h2 id="calendar-editor-title">{existing ? "Edit event" : "New event"}</h2><button aria-label="Close event editor" className="calendar-icon-button" disabled={saving} onClick={safeClose} type="button">×</button></header>
    <p id="calendar-editor-help">Changes are saved to your local calendar.</p>
    {error && <p className="calendar-field-error" role="alert">{error}</p>}
    {notice && <p aria-live="polite" className="calendar-notice">{notice}</p>}
    {latest && <div className="calendar-conflict" ref={conflictRef} role="alert" tabIndex={-1}><strong>This event changed elsewhere.</strong><span>Your draft has been preserved.</span><div>{scope === "series" && <button className="calendar-button" onClick={reviewLatest} type="button">Review latest</button>}<button className="calendar-button calendar-primary" onClick={keepEditing} type="button">Keep editing</button>{scope === "occurrence" && <button className="calendar-button" onClick={safeClose} type="button">Close and reopen</button>}</div></div>}
    <label>Title <input autoComplete="off" maxLength={500} onChange={(event) => setTitle(event.currentTarget.value)} value={title} /></label>
    <label>Location <input maxLength={2000} onChange={(event) => setLocation(event.currentTarget.value)} value={location} /></label>
    <label className="calendar-check"><input checked={allDay} onChange={(event) => toggleAllDay(event.currentTarget.checked)} type="checkbox" /> All day</label>
    <div className="calendar-time-fields"><label>Start <input onChange={(event) => changeStart(event.currentTarget.value)} type={allDay ? "date" : "datetime-local"} value={start} /></label><label>End <input onChange={(event) => setEnd(event.currentTarget.value)} type={allDay ? "date" : "datetime-local"} value={end} /></label></div>
    {!allDay && <p className="calendar-time-zone">Time zone: {eventTimeZone}</p>}
    {existing?.recurrenceRule && <fieldset><legend>Apply changes to</legend><label><input checked={scope === "occurrence"} name="scope" onChange={applyOccurrence} type="radio" /> This occurrence</label><label><input checked={scope === "series"} disabled={loadingMaster || !master} name="scope" onChange={applyMaster} type="radio" /> {loadingMaster ? "Loading series…" : "Entire series"}</label></fieldset>}
    {scope === "series" && <fieldset><legend>Repeats</legend><select aria-label="Repeats" onChange={(event) => { setPreset(event.currentTarget.value as typeof preset); setRecurrenceChanged(true); }} value={preset}>{preset === "custom" && <option value="custom">Custom recurrence (preserved)</option>}<option value="none">Does not repeat</option><option value="daily">Daily</option><option value="weekdays">Weekdays</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select>{preset === "custom" ? <p className="calendar-recurrence-note">This rule is preserved exactly unless you choose a replacement.</p> : preset !== "none" && <div className="calendar-recurrence-end"><select aria-label="Repeat ending" onChange={(event) => { setEnding(event.currentTarget.value as typeof ending); setRecurrenceChanged(true); }} value={ending}><option value="never">Never ends</option><option value="until">Ends on date</option><option value="count">Ends after count</option></select>{ending === "until" && <input aria-label="Repeat end date" onChange={(event) => { setUntil(event.currentTarget.value); setRecurrenceChanged(true); }} type="date" value={until} />}{ending === "count" && <input aria-label="Repeat count" min="1" onChange={(event) => { setCount(event.currentTarget.value); setRecurrenceChanged(true); }} type="number" value={count} />}</div>}</fieldset>}
    <fieldset><legend>Reminders</legend>{reminders.map((reminder, index) => <div className="calendar-reminder" key={`${reminder}-${index}`}><input aria-label={`Reminder ${index + 1} minutes before`} max="50400" min="0" onChange={(event) => setReminders((items) => items.map((value, itemIndex) => itemIndex === index ? Number(event.currentTarget.value) : value))} type="number" value={reminder} /><span>minutes before</span><button aria-label={`Remove reminder ${index + 1}`} onClick={() => setReminders((items) => items.filter((_, itemIndex) => itemIndex !== index))} type="button">Remove</button></div>)}<button disabled={reminders.length >= 5} onClick={() => setReminders((items) => [...items, 10])} type="button">Add reminder</button></fieldset>
    <label>Notes <textarea maxLength={20000} onChange={(event) => setNotes(event.currentTarget.value)} value={notes} /></label>
    {confirmDelete && <div className="calendar-delete-confirm" role="alert"><strong>Delete {scope === "occurrence" ? "this occurrence" : "the event series"}?</strong><div><button className="calendar-button" disabled={saving} onClick={() => setConfirmDelete(false)} ref={deleteCancelRef} type="button">Keep event</button><button className="calendar-danger" disabled={saving} onClick={() => void remove()} type="button">Confirm deletion</button></div></div>}
    <footer>{existing && !confirmDelete && <button className="calendar-danger" disabled={saving || Boolean(latest)} onClick={() => setConfirmDelete(true)} type="button">Delete</button>}<span /><button className="calendar-button" disabled={saving} onClick={safeClose} type="button">Cancel</button><button className="calendar-button calendar-primary" disabled={saving || Boolean(latest)} onClick={() => void save()} type="button">{saving ? "Saving…" : "Save event"}</button></footer>
  </div></div>;
}

function withSeconds(value: string) { return value.length === 16 ? `${value}:00` : value; }
function messageFor(cause: unknown) { return cause instanceof CalendarClientError ? cause.message : "Calendar request failed. Please try again."; }
function trapFocus(event: React.KeyboardEvent, container: HTMLElement | null) { if (!container) return; const focusable = Array.from(container.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href]')); if (!focusable.length) return; const first = focusable[0]; const last = focusable[focusable.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } }

function isolateModalBackground(backdrop: HTMLElement | null) {
  if (!backdrop) return () => undefined;
  const restored: Array<{ element: HTMLElement; ariaHidden: string | null; inert: boolean }> = [];
  let current: HTMLElement | null = backdrop;
  while (current?.parentElement) {
    const parent: HTMLElement = current.parentElement;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === current || !(sibling instanceof HTMLElement)) continue;
      restored.push({ element: sibling, ariaHidden: sibling.getAttribute("aria-hidden"), inert: sibling.inert });
      sibling.inert = true;
      sibling.setAttribute("aria-hidden", "true");
    }
    if (parent === document.body) break;
    current = parent;
  }
  return () => restored.reverse().forEach(({ element, ariaHidden, inert }) => {
    element.inert = inert;
    if (ariaHidden === null) element.removeAttribute("aria-hidden");
    else element.setAttribute("aria-hidden", ariaHidden);
  });
}
