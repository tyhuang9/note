import type { CalendarOccurrence, CalendarRange, EventTime } from "../../native/calendarClient";

export const AGENDA_DAYS = 32;

export function isoDate(date = new Date()): string {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, index) => (index === 0 ? String(part) : String(part).padStart(2, "0")))
    .join("-");
}

export function addDays(value: string, days: number): string {
  const [year, month, day] = value.split("-").map(Number);
  return isoDate(new Date(year, month - 1, day + days));
}

export function startOfMonth(value: string): string {
  return `${value.slice(0, 7)}-01`;
}

export function monthGridRange(value: string, weekStartsOn: "monday" | "sunday") {
  const [year, month] = value.slice(0, 7).split("-").map(Number);
  const first = new Date(year, month - 1, 1);
  const offset = (first.getDay() - (weekStartsOn === "sunday" ? 0 : 1) + 7) % 7;
  const start = isoDate(new Date(year, month - 1, 1 - offset));
  return { start, endExclusive: addDays(start, 42) };
}

export function rangeForDates(startDate: string, endDateExclusive: string): CalendarRange {
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDateExclusive}T00:00:00`);
  return { startDate, endDateExclusive, startUtcMs: start.getTime(), endUtcMs: end.getTime() };
}

export function occurrenceKey(occurrence: CalendarOccurrence): string {
  return `${occurrence.eventId}:${occurrence.occurrenceKey}`;
}

export function groupByDate(occurrences: CalendarOccurrence[], start: string, days: number, displayTimeZone: string) {
  const groups = new Map<string, CalendarOccurrence[]>();
  for (let index = 0; index < days; index += 1) groups.set(addDays(start, index), []);
  for (const occurrence of occurrences) {
    for (const date of occurrenceDates(occurrence.time, start, addDays(start, days), displayTimeZone)) {
      const list = groups.get(date);
      if (list && !list.some((item) => occurrenceKey(item) === occurrenceKey(occurrence))) list.push(occurrence);
    }
  }
  return groups;
}

export function occurrenceDates(time: EventTime, rangeStart: string, rangeEnd: string, displayTimeZone: string): string[] {
  if (time.temporalKind === "allDay") {
    const start = time.startDate > rangeStart ? time.startDate : rangeStart;
    const end = time.endDateExclusive < rangeEnd ? time.endDateExclusive : rangeEnd;
    const dates: string[] = [];
    for (let current = start; current < end; current = addDays(current, 1)) dates.push(current);
    return dates;
  }
  const start = zonedDate(time.startUtcMs, displayTimeZone);
  const end = zonedDate(time.endUtcMs - 1, displayTimeZone);
  const first = start > rangeStart ? start : rangeStart;
  const last = end < rangeEnd ? end : addDays(rangeEnd, -1);
  const dates: string[] = [];
  for (let current = first; current <= last; current = addDays(current, 1)) dates.push(current);
  return dates;
}

export function timeLabel(time: EventTime, format: "system" | "12h" | "24h", displayTimeZone: string, date?: string) {
  if (time.temporalKind === "allDay") return "All day";
  const hour12 = format === "system" ? undefined : format === "12h";
  const options: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit", ...(hour12 === undefined ? {} : { hour12 }), timeZone: displayTimeZone };
  const formatter = new Intl.DateTimeFormat(undefined, options);
  const start = formatter.format(new Date(time.startUtcMs));
  const end = formatter.format(new Date(time.endUtcMs));
  if (!date) return `${start}–${end}`;
  const startDate = zonedDate(time.startUtcMs, displayTimeZone);
  const endDate = zonedDate(time.endUtcMs - 1, displayTimeZone);
  if (date === startDate && date === endDate) return `${start}–${end}`;
  if (date === startDate) return `${start}–continues`;
  if (date === endDate) return `Continues–${end}`;
  return "Continues";
}

export function zonedDate(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function localDateTime(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

export function parseDraftDate(value: string): string {
  return value.length >= 10 ? value.slice(0, 10) : isoDate();
}

export function addLocalMinutes(value: string, minutes: number): string {
  const [date, time = "00:00"] = value.split("T");
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const next = new Date(year, month - 1, day, hour, minute + minutes);
  return `${isoDate(next)}T${String(next.getHours()).padStart(2, "0")}:${String(next.getMinutes()).padStart(2, "0")}`;
}

export type RecurrenceEditorState = {
  preset: "none" | "daily" | "weekdays" | "weekly" | "monthly" | "yearly" | "custom";
  ending: "never" | "until" | "count";
  until: string;
  count: string;
};

export function parseRecurrence(rule: string | null | undefined, timeZone = "UTC"): RecurrenceEditorState {
  if (!rule) return { preset: "none", ending: "never", until: "", count: "" };
  const parts = rule.split(";");
  const fields = new Map(parts.map((part) => {
    const separator = part.indexOf("=");
    return separator > 0 ? [part.slice(0, separator).toUpperCase(), part.slice(separator + 1)] : [part.toUpperCase(), ""];
  }));
  const allowed = new Set(["FREQ", "COUNT", "UNTIL"]);
  let preset: RecurrenceEditorState["preset"] = "custom";
  if (fields.get("FREQ") === "DAILY" && fields.get("BYDAY") === "MO,TU,WE,TH,FR") {
    preset = "weekdays";
    allowed.add("BYDAY");
  } else if (fields.get("FREQ") === "WEEKLY" && /^(SU|MO|TU|WE|TH|FR|SA)$/.test(fields.get("BYDAY") ?? "")) {
    preset = "weekly";
    allowed.add("BYDAY");
  } else if (fields.get("FREQ") === "MONTHLY" && /^([1-9]|[12]\d|3[01])$/.test(fields.get("BYMONTHDAY") ?? "")) {
    preset = "monthly";
    allowed.add("BYMONTHDAY");
  } else if (["DAILY", "YEARLY"].includes(fields.get("FREQ") ?? "")) {
    preset = fields.get("FREQ")!.toLowerCase() as RecurrenceEditorState["preset"];
  }
  if (preset === "custom" || fields.size !== parts.length || [...fields.keys()].some((key) => !allowed.has(key)) || (fields.has("COUNT") && fields.has("UNTIL"))) {
    return { preset: "custom", ending: "never", until: "", count: "" };
  }
  if (fields.has("COUNT") && /^\d+$/.test(fields.get("COUNT")!)) return { preset, ending: "count", until: "", count: fields.get("COUNT")! };
  if (fields.has("UNTIL") && /^\d{8}$/.test(fields.get("UNTIL")!)) {
    const value = fields.get("UNTIL")!;
    return { preset, ending: "until", until: `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`, count: "" };
  }
  if (fields.has("UNTIL") && /^\d{8}T\d{6}Z$/.test(fields.get("UNTIL")!)) {
    const value = fields.get("UNTIL")!;
    const utc = Date.UTC(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6, 8)), Number(value.slice(9, 11)), Number(value.slice(11, 13)), Number(value.slice(13, 15)));
    return { preset, ending: "until", until: zonedDate(utc, timeZone), count: "" };
  }
  if (fields.has("COUNT") || fields.has("UNTIL")) return { preset: "custom", ending: "never", until: "", count: "" };
  return { preset, ending: "never", until: "", count: "" };
}

export function recurrenceFor(preset: string, end: string, until: string, count: string, context: { start: string; allDay: boolean; timeZone: string }): string | null {
  const date = parseDraftDate(context.start);
  const [year, month, day] = date.split("-").map(Number);
  const weekday = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][new Date(year, month - 1, day).getDay()];
  if (preset === "weekdays" && (weekday === "SU" || weekday === "SA")) throw new Error("Weekday recurrence must start on a weekday.");
  const base: Record<string, string> = { none: "", daily: "FREQ=DAILY", weekdays: "FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR", weekly: `FREQ=WEEKLY;BYDAY=${weekday}`, monthly: `FREQ=MONTHLY;BYMONTHDAY=${day}`, yearly: "FREQ=YEARLY" };
  const rule = base[preset] ?? "";
  if (!rule) return null;
  if (end === "count" && /^\d+$/.test(count) && Number(count) > 0) return `${rule};COUNT=${count}`;
  if (end === "until" && /^\d{4}-\d{2}-\d{2}$/.test(until)) {
    if (context.allDay) return `${rule};UNTIL=${until.replace(/-/g, "")}`;
    const startTime = context.start.slice(11, 19) || "00:00";
    const utc = zonedLocalToUtcMs(`${until}T${startTime}`, context.timeZone);
    const stamp = new Date(utc).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    return `${rule};UNTIL=${stamp}`;
  }
  return rule;
}

function zonedLocalToUtcMs(value: string, timeZone: string): number {
  const [date, time] = value.split("T");
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute, second = 0] = time.split(":").map(Number);
  const desired = Date.UTC(year, month - 1, day, hour, minute, second);
  let result = desired;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const local = localDateTime(result, timeZone);
    const [localDate, localTime] = local.split("T");
    const [localYear, localMonth, localDay] = localDate.split("-").map(Number);
    const [localHour, localMinute] = localTime.split(":").map(Number);
    result += desired - Date.UTC(localYear, localMonth - 1, localDay, localHour, localMinute, second);
  }
  return result;
}
