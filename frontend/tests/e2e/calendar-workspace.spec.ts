import { expect, test, type Page } from "@playwright/test";

test("calendar shows a bounded agenda, month detail, and an accessible editor", async ({ page }) => {
  await installCalendarMock(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agenda" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Earlier" })).toBeVisible();
  expect(await page.getByRole("button", { name: "New event" }).evaluate((element) => ({ width: element.getBoundingClientRect().width, wraps: element.scrollHeight > element.clientHeight }))).toMatchObject({ width: expect.any(Number), wraps: false });
  expect(await page.getByRole("button", { name: "New event" }).evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(80);
  await page.getByRole("button", { name: "Month" }).click();
  await expect(page.getByRole("button", { name: "Select 2026-07-21" })).toBeVisible();
  const grid = page.getByRole("grid", { name: "Month" });
  await expect(grid.locator(":scope > [role=row]")).toHaveCount(7);
  await expect(grid.locator(":scope > [role=row]").first().getByRole("columnheader")).toHaveCount(7);
  await expect(grid.locator(":scope > [role=row]").nth(1).getByRole("gridcell")).toHaveCount(7);
  expect(await page.getByRole("button", { name: "Select 2026-07-21" }).evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(44);
  expect(await page.locator(".calendar-cell-item").first().evaluate((element) => { const item = element.getBoundingClientRect().width; const cell = element.closest(".calendar-cell")?.getBoundingClientRect().width ?? 0; return item >= cell - 12; })).toBe(true);
  await page.getByRole("button", { name: "Select 2026-07-21" }).click();
  await expect(page.getByRole("complementary", { name: "Events on 2026-07-21" })).toContainText("Planning");
  await page.getByRole("button", { name: "Planning" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Edit event" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("radio", { name: "This occurrence" })).toBeChecked();
  expect(await dialog.getByLabel("All day").locator("xpath=..").evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  expect(await dialog.getByRole("radio", { name: "This occurrence" }).locator("xpath=..").evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  await expect(page.locator(".calendar-header")).toHaveAttribute("aria-hidden", "true");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".calendar-header")).not.toHaveAttribute("aria-hidden");
});

test("agenda request generations settle busy independently from search", async ({ page }) => {
  await installCalendarMock(page, { slowAgenda: true });
  await page.goto("/");
  await page.getByPlaceholder("Search calendar").fill("Planning");
  await expect(page.getByRole("heading", { name: "Search results" })).toBeVisible();
  await page.evaluate(() => window.calendarMock.releaseAgenda?.());
  await page.getByPlaceholder("Search calendar").fill("");
  await expect(page.getByRole("button", { name: "Later" })).toBeEnabled();
});

test("agenda cursor retention has no stale cursor after trimming to 64 days", async ({ page }) => {
  await installCalendarMock(page, { pagination: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Later" }).click();
  await page.getByRole("button", { name: "Later" }).click();
  await page.getByRole("button", { name: "Earlier" }).click();
  await expect(page.locator(".calendar-agenda-day")).toHaveCount(64);
  const requests = await calendarRequests(page, "calendar_agenda_page");
  expect(requests[1]).toMatchObject({ direction: "after", cursor: "after-1", limit: 32 });
  expect(requests[2]).toMatchObject({ direction: "after", cursor: "after-2", limit: 32 });
  expect(requests[3]).toMatchObject({ direction: "before", anchorDate: "2026-08-02", limit: 32 });
  expect(requests[3]).not.toHaveProperty("cursor");
});

test("timed overnight events use display-zone half-open days and continuation labels", async ({ page }) => {
  await installCalendarMock(page, { overnight: true });
  await page.goto("/");
  const days = page.locator(".calendar-agenda-day");
  await expect(days).toHaveCount(2);
  await expect(days.nth(0)).toContainText("continues");
  await expect(days.nth(1)).toContainText("Continues");
  await page.getByRole("button", { name: "Month" }).click();
  await expect(page.getByRole("button", { name: "Select 2026-07-21" }).locator("..")).toContainText("Planning");
  await expect(page.getByRole("button", { name: "Select 2026-07-22" }).locator("..")).toContainText("Planning");
});

test("more than 100 agenda occurrences use measured windowed rendering", async ({ page }) => {
  await installCalendarMock(page, { manyEvents: true });
  await page.goto("/");
  await expect(page.locator(".calendar-virtual-viewport")).toBeVisible();
  const rendered = await page.locator(".calendar-virtual-row .calendar-event").count();
  expect(rendered).toBeGreaterThan(0);
  expect(rendered).toBeLessThan(101);
});

test("series and occurrence scope restore their own time and preserve a custom RRULE", async ({ page }) => {
  await installCalendarMock(page, { projectedSeries: true, customRule: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Projected series" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit event" });
  const series = dialog.getByRole("radio", { name: "Entire series" });
  await expect(series).toBeEnabled();
  await series.check();
  await expect(dialog.getByLabel("Start")).toHaveValue("2026-07-21T09:00");
  await expect(dialog.getByLabel("Repeats")).toHaveValue("custom");
  await dialog.getByRole("radio", { name: "This occurrence" }).check();
  await expect(dialog.getByLabel("Start")).toHaveValue("2026-07-28T09:00");
  await series.check();
  await dialog.getByLabel("Title").fill("Updated series");
  await dialog.getByRole("button", { name: "Save event" }).click();
  const updates = await calendarRequests(page, "calendar_update_event");
  expect(updates[0].event.time).toMatchObject({ localStart: "2026-07-21T09:00:00", timeZone: "America/New_York" });
  expect(updates[0].event.recurrenceRule).toBe("FREQ=WEEKLY;BYDAY=TU,TH;COUNT=8");
});

test("new-event RRULEs match native timed, all-day, weekly, and monthly contracts", async ({ page }) => {
  await installCalendarMock(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Month" }).click();
  await page.getByRole("button", { name: "Select 2026-07-21" }).click();

  await page.getByRole("button", { name: "New event" }).click();
  let dialog = page.getByRole("dialog", { name: "New event" });
  await dialog.getByLabel("Title").fill("Weekly timed");
  await dialog.getByLabel("Start").fill("2026-07-21T09:00");
  await dialog.getByLabel("End").fill("2026-07-21T10:00");
  await dialog.getByLabel("Repeats").selectOption("weekly");
  await dialog.getByLabel("Repeat ending").selectOption("until");
  await dialog.getByLabel("Repeat end date").fill("2026-08-04");
  await dialog.getByRole("button", { name: "Save event" }).click();

  await page.getByRole("button", { name: "New event" }).click();
  dialog = page.getByRole("dialog", { name: "New event" });
  await dialog.getByLabel("Title").fill("All day");
  await dialog.getByLabel("All day").check();
  await dialog.getByLabel("Start").fill("2026-07-21");
  await dialog.getByLabel("End").fill("2026-07-22");
  await dialog.getByLabel("Repeats").selectOption("daily");
  await dialog.getByLabel("Repeat ending").selectOption("until");
  await dialog.getByLabel("Repeat end date").fill("2026-08-04");
  await dialog.getByRole("button", { name: "Save event" }).click();

  await page.getByRole("button", { name: "New event" }).click();
  dialog = page.getByRole("dialog", { name: "New event" });
  await dialog.getByLabel("Title").fill("Monthly");
  await dialog.getByLabel("Repeats").selectOption("monthly");
  await dialog.getByRole("button", { name: "Save event" }).click();

  const creates = await calendarRequests(page, "calendar_create_event");
  expect(creates[0].recurrenceRule).toMatch(/^FREQ=WEEKLY;BYDAY=TU;UNTIL=20260804T\d{6}Z$/);
  expect(creates[1].recurrenceRule).toBe("FREQ=DAILY;UNTIL=20260804");
  expect(creates[2].recurrenceRule).toBe("FREQ=MONTHLY;BYMONTHDAY=21");
});

test("weekday recurrence rejects a weekend seed and timed ranges validate client-side", async ({ page }) => {
  await installCalendarMock(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Month" }).click();
  await page.getByRole("button", { name: "Select 2026-07-25" }).click();
  await page.getByRole("button", { name: "New event" }).click();
  const dialog = page.getByRole("dialog", { name: "New event" });
  await expect(dialog.getByLabel("End")).toHaveValue("2026-07-25T10:00");
  await dialog.getByLabel("Title").fill("Invalid weekend");
  await dialog.getByLabel("End").fill("2026-07-25T09:00");
  await dialog.getByLabel("Repeats").selectOption("weekdays");
  await dialog.getByRole("button", { name: "Save event" }).click();
  await expect(dialog.getByRole("alert")).toContainText("must end after");
  await dialog.getByLabel("End", { exact: true }).fill("2026-07-25T10:00");
  await dialog.getByRole("button", { name: "Save event" }).click();
  await expect(dialog.getByRole("alert")).toContainText("must start on a weekday");
  expect(await calendarRequests(page, "calendar_create_event")).toHaveLength(0);
});

test("revision conflict preserves occurrence draft, focuses choices, and never applies master fields", async ({ page }) => {
  await installCalendarMock(page, { conflictOnce: true, projectedSeries: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Projected series" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit event" });
  await dialog.getByLabel("Title").fill("My occurrence draft");
  await dialog.getByRole("button", { name: "Save event" }).click();
  const conflict = dialog.locator(".calendar-conflict");
  await expect(conflict).toBeFocused();
  await expect(conflict).toContainText("changed elsewhere");
  await expect(dialog.getByRole("button", { name: "Review latest" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(dialog.getByLabel("Title")).toHaveValue("My occurrence draft");
  await expect(dialog.getByLabel("Start")).toHaveValue("2026-07-28T09:00");
  await dialog.getByRole("button", { name: "Save event" }).click();
  const updates = await calendarRequests(page, "calendar_update_occurrence");
  expect(updates[1]).toMatchObject({ expectedRevision: 2, event: { title: "My occurrence draft", time: { localStart: "2026-07-28T09:00:00" } } });
});

test("series conflict offers Review latest and loads master fields deliberately", async ({ page }) => {
  await installCalendarMock(page, { conflictOnce: true, projectedSeries: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Projected series" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit event" });
  await dialog.getByRole("radio", { name: "Entire series" }).check();
  await dialog.getByLabel("Title").fill("Stale series draft");
  await dialog.getByRole("button", { name: "Save event" }).click();
  await dialog.getByRole("button", { name: "Review latest" }).click();
  await expect(dialog.getByLabel("Title")).toHaveValue("Projected series");
  await expect(dialog.getByLabel("Start")).toHaveValue("2026-07-21T09:00");
  await expect(dialog.getByText("Latest version loaded", { exact: false })).toBeVisible();
});

test("settings failure remains announced across month loads and grid arrows move focus", async ({ page }) => {
  await installCalendarMock(page, { settingsFail: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Month" }).click();
  await page.getByText("Settings", { exact: true }).click();
  await page.getByLabel("Week starts").selectOption("sunday");
  await expect(page.getByRole("alert")).toContainText("Settings were not changed");
  await expect(page.getByLabel("Week starts")).toHaveValue("monday");
  await page.getByRole("button", { name: "Next month" }).click();
  await expect(page.getByRole("alert")).toContainText("Settings were not changed");
  await page.getByRole("button", { name: "Previous month" }).click();
  const day = page.getByRole("button", { name: "Select 2026-07-21" });
  await day.click();
  await day.press("ArrowRight");
  await expect(page.getByRole("button", { name: "Select 2026-07-22" })).toBeFocused();
});

test("an older month completion cannot clear a newer settings error", async ({ page }) => {
  await installCalendarMock(page, { settingsFail: true, slowMonth: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Month" }).click();
  await expect.poll(() => calendarRequests(page, "calendar_list_events")).toHaveLength(1);
  await page.getByText("Settings", { exact: true }).click();
  await page.getByLabel("Week starts").selectOption("sunday");
  await expect(page.getByRole("alert")).toContainText("Settings were not changed");
  await page.evaluate(() => window.calendarMock.releaseMonth?.());
  await expect(page.getByRole("alert")).toContainText("Settings were not changed");
});

test("out-of-order settings responses cannot overwrite the latest save", async ({ page }) => {
  await installCalendarMock(page, { settingsOutOfOrder: true });
  await page.goto("/");
  await page.getByText("Settings", { exact: true }).click();
  await page.getByLabel("Week starts").selectOption("sunday");
  await page.getByLabel("Time format").selectOption("24h");
  await expect(page.getByLabel("Time format")).toHaveValue("24h");
  await page.evaluate(() => window.calendarMock.releaseSettings?.());
  await expect(page.getByLabel("Week starts")).toHaveValue("sunday");
  await expect(page.getByLabel("Time format")).toHaveValue("24h");
  await expect.poll(() => calendarRequests(page, "calendar_update_settings")).toHaveLength(2);
  const requests = await calendarRequests(page, "calendar_update_settings");
  expect(requests[1].patch).toMatchObject({ weekStartsOn: "sunday", timeFormat: "24h" });
});

test("retry initialization failures are caught and announced", async ({ page }) => {
  await installCalendarMock(page, { unavailable: true, retryFail: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Retry calendar" }).click();
  await expect(page.locator(".calendar-readiness")).toContainText("Retry failed");
  await expect(page.getByRole("button", { name: "Retry calendar" })).toBeEnabled();
});

test("inline delete confirmation receives focus and is keyboard-cancellable", async ({ page }) => {
  await installCalendarMock(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Planning" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit event" });
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(dialog.getByRole("button", { name: "Keep event" })).toBeFocused();
  await dialog.getByRole("button", { name: "Keep event" }).press("Enter");
  await expect(dialog.getByRole("button", { name: "Delete" })).toBeVisible();
});

test("a delayed native listener is unregistered after the calendar unmounts", async ({ page }) => {
  await installCalendarMock(page, { delayedListener: true });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agenda" })).toBeVisible();
  await expect.poll(async () => (await calendarRequests(page, "plugin:event|listen")).length).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Close Agenda" }).click();
  await page.evaluate(() => window.calendarMock.releaseListener?.());
  await expect.poll(() => page.evaluate(() => window.calendarMock.unlistenCount)).toBeGreaterThan(0);
});

test("agenda exhaustion disables continuation without issuing another request", async ({ page }) => {
  await installCalendarMock(page, { exhausted: true });
  await page.goto("/");
  const later = page.getByRole("button", { name: "No later events" });
  await expect(later).toBeDisabled();
  const before = (await calendarRequests(page, "calendar_agenda_page")).length;
  await later.evaluate((button: HTMLButtonElement) => button.click());
  expect((await calendarRequests(page, "calendar_agenda_page")).length).toBe(before);
});

test("default duration and all-day toggles remain coherent", async ({ page }) => {
  await installCalendarMock(page, { defaultDuration: 75 });
  await page.goto("/");
  await page.getByRole("button", { name: "Month" }).click();
  await page.getByRole("button", { name: "Select 2026-07-25" }).click();
  await page.getByRole("button", { name: "New event" }).click();
  const dialog = page.getByRole("dialog", { name: "New event" });
  await expect(dialog.getByLabel("Start")).toHaveValue("2026-07-25T09:00");
  await expect(dialog.getByLabel("End")).toHaveValue("2026-07-25T10:15");
  await dialog.getByLabel("All day").check();
  await expect(dialog.getByLabel("Start")).toHaveValue("2026-07-25");
  await expect(dialog.getByLabel("End")).toHaveValue("2026-07-26");
  await dialog.getByLabel("Title").fill("Invalid all day");
  await dialog.getByLabel("End").fill("2026-07-25");
  await dialog.getByRole("button", { name: "Save event" }).click();
  await expect(dialog.getByRole("alert")).toContainText("All-day events must end after they start");
  await dialog.getByLabel("End").fill("2026-07-26");
  await dialog.getByLabel("All day").uncheck();
  await expect(dialog.getByLabel("Start")).toHaveValue("2026-07-25T09:00");
  await expect(dialog.getByLabel("End")).toHaveValue("2026-07-25T10:15");
});

test("supported COUNT recurrence is preserved when series fields do not change", async ({ page }) => {
  await installCalendarMock(page, { projectedSeries: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Projected series" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit event" });
  await dialog.getByRole("radio", { name: "Entire series" }).check();
  await expect(dialog.getByLabel("Repeat ending")).toHaveValue("count");
  await expect(dialog.getByLabel("Repeat count")).toHaveValue("8");
  await dialog.getByLabel("Title").fill("Count preserved");
  await dialog.getByRole("button", { name: "Save event" }).click();
  const updates = await calendarRequests(page, "calendar_update_event");
  expect(updates[0].event.recurrenceRule).toBe("FREQ=WEEKLY;BYDAY=TU;COUNT=8");
});

test("supported timed UNTIL recurrence is parsed and preserved exactly", async ({ page }) => {
  await installCalendarMock(page, { projectedSeries: true, untilRule: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Projected series" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit event" });
  await dialog.getByRole("radio", { name: "Entire series" }).check();
  await expect(dialog.getByLabel("Repeat ending")).toHaveValue("until");
  await expect(dialog.getByLabel("Repeat end date")).toHaveValue("2026-08-04");
  await dialog.getByLabel("Title").fill("Until preserved");
  await dialog.getByRole("button", { name: "Save event" }).click();
  const updates = await calendarRequests(page, "calendar_update_event");
  expect(updates[0].event.recurrenceRule).toBe("FREQ=WEEKLY;BYDAY=TU;UNTIL=20260804T130000Z");
});

test("calendar stays usable at phone width", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 844 });
  await installCalendarMock(page);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "New event" })).toBeVisible();
  await expect(page.locator(".calendar-workspace")).not.toHaveCSS("overflow", "hidden");
  expect(await page.getByRole("button", { name: "New event" }).evaluate((element) => ({ width: element.getBoundingClientRect().width, wraps: element.scrollHeight > element.clientHeight }))).toMatchObject({ width: expect.any(Number), wraps: false });
  expect(await page.getByRole("button", { name: "New event" }).evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(80);
  await page.getByRole("button", { name: "New event" }).click();
  const editor = page.getByRole("dialog", { name: "New event" });
  await editor.getByRole("button", { name: "Add reminder" }).click();
  expect(await editor.getByRole("button", { name: "Remove reminder 1" }).evaluate((element) => ({ width: element.getBoundingClientRect().width, wraps: element.scrollHeight > element.clientHeight }))).toMatchObject({ width: expect.any(Number), wraps: false });
  expect(await editor.getByRole("button", { name: "Remove reminder 1" }).evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(70);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 768, height: 900 });
  await page.getByRole("button", { name: "Month" }).click();
  await expect(page.getByRole("grid", { name: "Month" })).toBeVisible();
});

test("calendar defines light and dark theme tokens locally", async ({ page }) => {
  await installCalendarMock(page);
  await page.goto("/");
  await page.locator(".app-shell").evaluate((element) => element.classList.remove("is-dark"));
  const workspace = page.locator(".calendar-workspace");
  await expect(workspace).toHaveCSS("color", "rgb(38, 50, 65)");
  await expect(workspace).toHaveCSS("background-color", "rgb(245, 247, 250)");
  await page.locator(".app-shell").evaluate((element) => element.classList.add("is-dark"));
  await expect(workspace).toHaveCSS("color", "rgb(245, 245, 245)");
  await expect(workspace).toHaveCSS("background-color", "rgb(22, 22, 22)");
});

type MockOptions = { slowAgenda?: boolean; slowMonth?: boolean; pagination?: boolean; overnight?: boolean; manyEvents?: boolean; projectedSeries?: boolean; customRule?: boolean; untilRule?: boolean; conflictOnce?: boolean; settingsFail?: boolean; settingsOutOfOrder?: boolean; delayedListener?: boolean; defaultDuration?: number; exhausted?: boolean; unavailable?: boolean; retryFail?: boolean };

async function installCalendarMock(page: Page, options: MockOptions = {}) {
  await page.addInitScript((mockOptions) => {
    const id = "11111111-1111-4111-8111-111111111111";
    const calendarId = "22222222-2222-4222-8222-222222222222";
    const rule = mockOptions.customRule ? "FREQ=WEEKLY;BYDAY=TU,TH;COUNT=8" : mockOptions.untilRule ? "FREQ=WEEKLY;BYDAY=TU;UNTIL=20260804T130000Z" : "FREQ=WEEKLY;BYDAY=TU;COUNT=8";
    const occurrence = {
      eventId: id, occurrenceKey: mockOptions.projectedSeries ? "2026-07-28T13:00:00Z" : "2026-07-21", calendarId,
      title: mockOptions.projectedSeries ? "Projected series" : "Planning", notes: null, location: "Studio",
      time: mockOptions.projectedSeries
        ? { temporalKind: "timed", startUtcMs: Date.parse("2026-07-28T13:00:00Z"), endUtcMs: Date.parse("2026-07-28T14:00:00Z"), timeZone: "America/New_York" }
        : { temporalKind: "allDay", startDate: "2026-07-21", endDateExclusive: "2026-07-22" },
      recurrenceRule: rule, reminderOffsetsMinutes: [10], revision: 1,
    };
    const master = {
      id, calendarId, title: occurrence.title, notes: null, location: "Studio",
      time: mockOptions.projectedSeries
        ? { temporalKind: "timed", startUtcMs: Date.parse("2026-07-21T13:00:00Z"), endUtcMs: Date.parse("2026-07-21T14:00:00Z"), timeZone: "America/New_York" }
        : occurrence.time,
      recurrenceRule: rule, reminderOffsetsMinutes: [10], revision: mockOptions.conflictOnce ? 2 : 1, createdAtUtcMs: 1, updatedAtUtcMs: 2,
    };
    const data = { blocks: [], folders: [], pages: [], sessionState: { selectedWorkspaceTabId: "agenda", workspaceTabs: [{ id: "agenda", title: "Agenda", view: { kind: "agenda", view: "agenda" } }] } };
    const calls: Array<{ command: string; body?: Record<string, unknown> }> = [];
    let releaseAgenda: (() => void) | undefined;
    let agendaReleased = !mockOptions.slowAgenda;
    let releaseMonth: (() => void) | undefined;
    let monthReleased = !mockOptions.slowMonth;
    let conflicted = false;
    let settingsFailed = false;
    let settingsCall = 0;
    let releaseSettings: (() => void) | undefined;
    const addDate = (value: string, days: number) => { const date = new Date(`${value}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); };
    const occurrenceForDate = (date: string, index: number) => ({ ...occurrence, occurrenceKey: `${date}:${index}`, title: index ? `Planning ${index}` : occurrence.title, time: { temporalKind: "allDay", startDate: date, endDateExclusive: addDate(date, 1) } });
    let releaseListener: (() => void) | undefined;
    window.calendarMock = { calls, releaseAgenda: () => { agendaReleased = true; releaseAgenda?.(); }, releaseMonth: () => { monthReleased = true; releaseMonth?.(); }, releaseListener: () => releaseListener?.(), releaseSettings: () => releaseSettings?.(), unlistenCount: 0 };
    window.isTauri = true;
    window.__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (command: string, body?: Record<string, unknown>) => {
        calls.push({ command, body });
        const request = body?.request as Record<string, unknown> | undefined;
        if (command === "load_app_data") return data;
        if (command === "save_app_data") return undefined;
        if (command === "calendar_readiness_get") return mockOptions.unavailable ? { state: "unavailable", initializationDurationMs: 1 } : { state: "ready", initializationDurationMs: 1 };
        if (command === "calendar_retry_initialization") { if (mockOptions.retryFail) throw { code: "storage_unavailable", message: "Retry failed." }; return { state: "ready", initializationDurationMs: 1 }; }
        if (command === "calendar_get_settings") return { defaultEventDurationMinutes: mockOptions.defaultDuration ?? 60, weekStartsOn: "monday", timeFormat: "system", defaultReminderMinutes: null };
        if (command === "calendar_update_settings") {
          if (mockOptions.settingsFail && !settingsFailed) { settingsFailed = true; throw { code: "storage_unavailable", message: "Settings save failed." }; }
          settingsCall += 1;
          if (mockOptions.settingsOutOfOrder && settingsCall === 1) await new Promise<void>((resolve) => { releaseSettings = resolve; });
          const patch = request?.patch as { weekStartsOn?: string; timeFormat?: string };
          return { defaultEventDurationMinutes: 60, weekStartsOn: patch?.weekStartsOn ?? "monday", timeFormat: patch?.timeFormat ?? "system", defaultReminderMinutes: null };
        }
        if (command === "calendar_agenda_page") {
          if (!agendaReleased) await new Promise<void>((resolve) => { releaseAgenda = resolve; });
          if (mockOptions.pagination) {
            const direction = request?.direction;
            const cursor = request?.cursor;
            const anchorDate = request?.anchorDate as string | undefined;
            let start = "2026-07-01";
            let nextCursor = "after-1";
            if (cursor === "after-1") { start = "2026-08-02"; nextCursor = "after-2"; }
            if (cursor === "after-2") { start = "2026-09-03"; nextCursor = "after-3"; }
            if (direction === "before") { start = addDate(anchorDate!, -32); nextCursor = "before-1"; }
            return { days: Array.from({ length: 32 }, (_, index) => { const date = addDate(start, index); return { date, occurrences: [occurrenceForDate(date, index)] }; }), nextCursor, exhausted: false };
          }
          if (mockOptions.manyEvents) return { days: [{ date: "2026-07-21", occurrences: Array.from({ length: 101 }, (_, index) => occurrenceForDate("2026-07-21", index)) }], nextCursor: "cursor", exhausted: false };
          if (mockOptions.overnight) {
            const overnight = { ...occurrence, recurrenceRule: null, time: { temporalKind: "timed", startUtcMs: Date.parse("2026-07-22T04:00:00Z"), endUtcMs: Date.parse("2026-07-22T08:00:00Z"), timeZone: "Pacific/Auckland" } };
            return { days: [{ date: "2026-07-21", occurrences: [overnight] }, { date: "2026-07-22", occurrences: [overnight] }], nextCursor: null, exhausted: true };
          }
          return { days: [{ date: mockOptions.projectedSeries ? "2026-07-28" : "2026-07-21", occurrences: [occurrence] }], nextCursor: mockOptions.exhausted ? null : "cursor", exhausted: Boolean(mockOptions.exhausted) };
        }
        if (command === "calendar_list_events" || command === "calendar_search") {
          if (command === "calendar_list_events" && !monthReleased) await new Promise<void>((resolve) => { releaseMonth = resolve; });
          if (mockOptions.overnight) return [{ ...occurrence, recurrenceRule: null, time: { temporalKind: "timed", startUtcMs: Date.parse("2026-07-22T04:00:00Z"), endUtcMs: Date.parse("2026-07-22T08:00:00Z"), timeZone: "Pacific/Auckland" } }];
          return [occurrence];
        }
        if (command === "calendar_get_event") return master;
        if (command === "calendar_update_event" || command === "calendar_update_occurrence") {
          if (mockOptions.conflictOnce && !conflicted) { conflicted = true; throw { code: "revision_conflict", message: "Event revision conflict." }; }
          return { ...master, ...(request?.event as object), revision: master.revision + 1 };
        }
        if (command === "calendar_create_event") return { ...master, ...(request as object), recurrenceRule: request?.recurrenceRule ?? null };
        if (command === "calendar_delete_event" || command === "calendar_delete_occurrence") return undefined;
        if (command === "plugin:event|listen") { if (mockOptions.delayedListener) await new Promise<void>((resolve) => { releaseListener = resolve; }); return 1; }
        if (command === "plugin:event|unlisten") { window.calendarMock.unlistenCount += 1; return undefined; }
        throw new Error(`Unexpected command: ${command}`);
      },
      metadata: { currentWindow: { label: "main" } },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => { window.calendarMock.unlistenCount += 1; } };
  }, options);
}

async function calendarRequests(page: Page, command: string): Promise<any[]> {
  return page.evaluate((name) => window.calendarMock.calls.filter((call) => call.command === name).map((call) => call.body?.request), command);
}

declare global {
  interface Window {
    calendarMock: { calls: Array<{ command: string; body?: Record<string, unknown> }>; releaseAgenda?: () => void; releaseMonth?: () => void; releaseListener?: () => void; releaseSettings?: () => void; unlistenCount: number };
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: (event: string, id: number) => void };
    __TAURI_INTERNALS__: { transformCallback: (callback: (...args: unknown[]) => unknown, once?: boolean) => number; invoke: (command: string, body?: Record<string, unknown>) => Promise<unknown>; metadata: { currentWindow: { label: string } } };
    isTauri: boolean;
  }
}
