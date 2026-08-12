import { expect, test, type Page } from "@playwright/test";

type WidgetMockOptions = {
  deferFirstAgenda?: boolean;
  failFirstAgenda?: boolean;
  longAgenda?: boolean;
  malformedAgenda?: boolean;
  malformedStatus?: boolean;
};

async function installWidgetMock(page: Page, options: WidgetMockOptions = {}) {
  await page.addInitScript((mockOptions) => {
    type Callback = (event: { payload: unknown }) => void;
    const callbacks = new Map<number, Callback>();
    const listeners = new Map<string, number>();
    const calls: Array<{ command: string; body?: Record<string, unknown> }> = [];
    let callbackId = 0;
    let agendaCalls = 0;
    let statusGetCalls = 0;
    let releaseFirstAgenda: (() => void) | undefined;
    let releaseDeferredAgenda: (() => void) | undefined;
    let releaseDeferredStatus: (() => void) | undefined;
    let deferNextAgenda = false;
    let deferNextStatus = false;
    let failNextAgenda = false;
    let failInitialAgendaAttempts = mockOptions.failFirstAgenda ? 2 : 0;
    const status = {
      requestedMode: "desktop",
      effectiveMode: "floating",
      visibilityRequested: true,
      visible: true,
      locked: false,
      sizePreset: "medium",
      attached: false,
      fallbackReason: "desktop_attachment_unavailable",
    };
    const agenda = (title: string) => mockOptions.longAgenda
      ? Array.from({ length: 32 }, (_, index) => ({
        eventId: "11111111-1111-4111-8111-111111111111",
        occurrenceKey: `2026-08-12-${index}`,
        title: `${title} ${index + 1}`,
        time: { temporalKind: "allDay" as const, startDate: "2026-08-12", endDateExclusive: "2026-08-13" },
      }))
      : [{
        eventId: "11111111-1111-4111-8111-111111111111",
        occurrenceKey: "2026-08-12",
        title,
        time: { temporalKind: "allDay" as const, startDate: "2026-08-12", endDateExclusive: "2026-08-13" },
      }];

    window.isTauri = true;
    window.widgetMock = {
      calls,
      emit: (event: string, payload: unknown) => {
        if (event === "note://widget-status-changed" && typeof payload === "object" && payload !== null) {
          Object.assign(status, payload);
        }
        callbacks.get(listeners.get(event) ?? -1)?.({ payload });
      },
      failNextAgenda: () => { failNextAgenda = true; },
      deferNextAgenda: () => { deferNextAgenda = true; },
      deferNextStatus: () => { deferNextStatus = true; },
      listenerEvents: () => [...listeners.keys()],
      releaseFirstAgenda: () => releaseFirstAgenda?.(),
      releaseDeferredAgenda: () => releaseDeferredAgenda?.(),
      releaseDeferredStatus: () => releaseDeferredStatus?.(),
      statusGetCalls: () => statusGetCalls,
    };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "widget" } },
      transformCallback: (callback: Callback) => {
        const id = ++callbackId;
        callbacks.set(id, callback);
        return id;
      },
      invoke: async (command: string, body?: Record<string, unknown>) => {
        calls.push({ command, body });
        if (command === "plugin:event|listen") {
          const event = body?.event;
          const handler = body?.handler;
          if (typeof event === "string" && typeof handler === "number") listeners.set(event, handler);
          return handler;
        }
        if (command === "plugin:event|unlisten") return undefined;
        if (command === "calendar_widget_agenda") {
          const request = body?.request as { displayTimeZone?: unknown } | undefined;
          if (
            !request ||
            typeof request.displayTimeZone !== "string" ||
            !body ||
            Object.keys(body).length !== 1 ||
            Object.keys(request).length !== 1
          ) {
            throw new Error("calendar_widget_agenda requires { request: { displayTimeZone } }");
          }
          agendaCalls += 1;
          if (mockOptions.deferFirstAgenda && agendaCalls === 1) {
            await new Promise<void>((resolve) => { releaseFirstAgenda = resolve; });
            return agenda("Older agenda");
          }
          if (deferNextAgenda) {
            deferNextAgenda = false;
            await new Promise<void>((resolve) => { releaseDeferredAgenda = resolve; });
          }
          if (failInitialAgendaAttempts > 0) {
            failInitialAgendaAttempts -= 1;
            throw { code: "calendar_unavailable", message: "Initial agenda load failed." };
          }
          if (failNextAgenda) {
            failNextAgenda = false;
            throw { code: "calendar_unavailable", message: "Agenda refresh failed." };
          }
          if (mockOptions.malformedAgenda) {
            return [{ eventId: "id", occurrenceKey: "key", title: "native agenda raw detail", unexpectedItem: "native agenda item raw detail", time: { temporalKind: "allDay", startDate: "2026-08-12", endDateExclusive: "2026-08-13", unexpectedTime: "native agenda time raw detail" } }];
          }
          return agenda(agendaCalls === 1 ? "Initial agenda" : "Current agenda");
        }
        if (command === "widget_status_get") {
          statusGetCalls += 1;
          if (mockOptions.malformedStatus) {
            return { ...status, errorReason: "native status raw detail", unexpectedStatus: "native status extra raw detail" };
          }
          const statusSnapshot = { ...status };
          if (deferNextStatus) {
            deferNextStatus = false;
            await new Promise<void>((resolve) => { releaseDeferredStatus = resolve; });
          }
          return statusSnapshot;
        }
        if (command === "widget_set_locked") {
          if (!body || typeof body.locked !== "boolean" || "request" in body) {
            throw new Error("widget_set_locked requires top-level { locked }");
          }
          status.locked = body.locked;
          return status;
        }
        if (command === "widget_set_size_preset") {
          const sizePreset = body?.sizePreset;
          if (
            !body ||
            (sizePreset !== "small" && sizePreset !== "medium" && sizePreset !== "large") ||
            "request" in body
          ) {
            throw new Error("widget_set_size_preset requires top-level { sizePreset }");
          }
          status.sizePreset = sizePreset;
          return status;
        }
        if (command === "widget_open_calendar") return undefined;
        if (command === "widget_show" || command === "widget_hide" || command === "widget_toggle") return status;
        throw new Error(`Unexpected command: ${command}`);
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: (_event: string, id: number) => callbacks.delete(id),
    };
  }, options);
}

test("widget renders a bounded native-only agenda and sends only widget commands", async ({ page }) => {
  await installWidgetMock(page);
  await page.setViewportSize({ height: 520, width: 360 });
  await page.goto("/widget.html");

  const main = page.getByRole("main");
  await expect(main).toHaveAttribute("data-surface", "widget");
  await expect(page.getByRole("heading", { level: 1, name: "Agenda" })).toBeVisible();
  await expect(page.getByText("Current agenda")).toBeVisible();
  await expect(page.getByText("Desktop placement is unavailable")).toBeVisible();
  await expect(page.getByRole("list")).toBeVisible();
  await expect(page.locator(".canvas")).toHaveCount(0);

  await page.getByRole("button", { name: "Open calendar" }).click();
  await page.getByRole("button", { name: "Lock widget" }).click();
  await expect(page.getByRole("button", { name: "Unlock widget" })).toBeVisible();
  await page.getByRole("button", { name: "Large" }).click();
  const requestsBeforeStatusEvent = await page.evaluate(() => window.widgetMock.calls
    .filter((call) => call.command === "calendar_widget_agenda").length);
  await page.evaluate(() => window.widgetMock.emit("note://widget-status-changed", {
    requestedMode: "desktop",
    effectiveMode: "floating",
    visibilityRequested: false,
    visible: false,
    locked: true,
    sizePreset: "large",
    attached: false,
    fallbackReason: "desktop_attachment_unavailable",
  }));
  await expect(page.getByRole("status").filter({ hasText: "Hidden · Floating window" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.widgetMock.calls
    .filter((call) => call.command === "calendar_widget_agenda").length),
  ).toBe(requestsBeforeStatusEvent + 1);

  await expect.poll(() => page.evaluate(() => window.widgetMock.calls
    .filter((call) => !call.command.startsWith("plugin:event|"))
    .map((call) => call.command),
  )).toEqual(expect.arrayContaining([
    "calendar_widget_agenda",
    "widget_status_get",
    "widget_open_calendar",
    "widget_set_locked",
    "widget_set_size_preset",
  ]));
  await expect.poll(() => page.evaluate(() => window.widgetMock.listenerEvents().sort())).toEqual([
    "note://calendar-changed",
    "note://widget-status-changed",
  ]);
  await expect.poll(() => page.evaluate(() => window.widgetMock.calls
    .filter((call) => call.command === "widget_set_locked")
    .at(-1)?.body,
  )).toEqual({ locked: true });
  await expect.poll(() => page.evaluate(() => window.widgetMock.calls
    .filter((call) => call.command === "widget_set_size_preset")
    .at(-1)?.body,
  )).toEqual({ sizePreset: "large" });
  await expect.poll(() => page.evaluate(() => window.widgetMock.calls
    .filter((call) => call.command === "calendar_widget_agenda")
    .at(0)?.body,
  )).toEqual({ request: { displayTimeZone: expect.any(String) } });
  const agendaRegion = page.getByRole("region", { name: "Upcoming agenda" });
  await expect(agendaRegion).toBeVisible();
  await agendaRegion.focus();
  await expect(agendaRegion).toBeFocused();
  await expect(agendaRegion).toHaveCSS("outline-width", "2px");
  await expect(main).toHaveCSS("height", "520px");
  await expect(main).toHaveCSS("width", "360px");
});

test("widget sanitizes malformed native agenda and status responses", async ({ page }) => {
  await installWidgetMock(page, { malformedAgenda: true, malformedStatus: true });
  await page.goto("/widget.html");

  await expect(page.getByText("The agenda widget is available in the Note desktop app.")).toHaveCount(2);
  await expect(page.getByText("native agenda raw detail")).toHaveCount(0);
  await expect(page.getByText("native agenda item raw detail")).toHaveCount(0);
  await expect(page.getByText("native agenda time raw detail")).toHaveCount(0);
  await expect(page.getByText("native status raw detail")).toHaveCount(0);
  await expect(page.getByText("native status extra raw detail")).toHaveCount(0);
});

test("widget ignores status events with extra native fields", async ({ page }) => {
  await installWidgetMock(page);
  await page.goto("/widget.html");
  await expect(page.getByRole("button", { name: "Lock widget" })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => window.widgetMock.listenerEvents().sort())).toEqual([
    "note://calendar-changed",
    "note://widget-status-changed",
  ]);

  await page.evaluate(() => window.widgetMock.emit("note://widget-status-changed", {
    requestedMode: "desktop",
    effectiveMode: "floating",
    visibilityRequested: false,
    visible: false,
    locked: true,
    sizePreset: "large",
    attached: false,
    errorReason: "native status event raw detail",
    unexpectedEvent: "native status event extra raw detail",
  }));

  await expect(page.getByRole("button", { name: "Lock widget" })).toBeEnabled();
  await expect(page.getByText("native status event raw detail")).toHaveCount(0);
  await expect(page.getByText("native status event extra raw detail")).toHaveCount(0);
});

test("widget debounces native refreshes, ignores stale results, and retains prior agenda on failure", async ({ page }) => {
  await installWidgetMock(page, { deferFirstAgenda: true });
  await page.goto("/widget.html");

  await expect(page.getByText("Current agenda")).toBeVisible();
  const requestsBeforeEvent = await page.evaluate(() => window.widgetMock.calls
    .filter((call) => call.command === "calendar_widget_agenda").length);
  await page.evaluate(() => {
    window.widgetMock.emit("note://calendar-changed", undefined);
    window.widgetMock.emit("note://calendar-changed", undefined);
  });
  await expect.poll(() => page.evaluate(() => window.widgetMock.calls
    .filter((call) => call.command === "calendar_widget_agenda").length),
  ).toBe(requestsBeforeEvent + 1);
  await page.evaluate(() => window.widgetMock.releaseFirstAgenda());
  await expect(page.getByText("Current agenda")).toBeVisible();
  await expect(page.getByText("Older agenda")).toHaveCount(0);

  await page.evaluate(() => window.widgetMock.failNextAgenda());
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByText("Current agenda")).toBeVisible();
  await expect(page.getByText("Latest refresh failed. Showing previously loaded agenda.")).toBeVisible();
});

test("widget keeps feedback focusable and keyboard-scrollable when messages overflow", async ({ page }) => {
  await installWidgetMock(page);
  await page.setViewportSize({ height: 300, width: 360 });
  await page.goto("/widget.html");
  await expect(page.getByText("Current agenda")).toBeVisible();

  await page.evaluate(() => window.widgetMock.emit("note://widget-status-changed", {
    requestedMode: "desktop",
    effectiveMode: "floating",
    visibilityRequested: true,
    visible: true,
    locked: false,
    sizePreset: "medium",
    attached: false,
    fallbackReason: "desktop_attachment_unavailable",
    errorReason: Array.from({ length: 32 }, (_, index) => `Status message ${index + 1}.`).join(" "),
  }));

  const feedback = page.getByRole("region", { name: "Widget feedback" });
  await expect(feedback).toBeVisible();
  await expect.poll(() => feedback.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await feedback.focus();
  await expect(feedback).toBeFocused();
  await expect(feedback).toHaveCSS("outline-width", "2px");
  const initialScrollTop = await feedback.evaluate((element) => element.scrollTop);
  await feedback.press("PageDown");
  await expect.poll(() => feedback.evaluate((element) => element.scrollTop)).toBeGreaterThan(initialScrollTop);
});

test("widget preserves retry focus while the initial agenda load is retried", async ({ page }) => {
  await installWidgetMock(page, { failFirstAgenda: true });
  await page.goto("/widget.html");

  const retry = page.getByRole("button", { name: "Try again" });
  await expect(retry).toBeVisible();
  await retry.focus();
  await expect(retry).toBeFocused();
  await page.evaluate(() => window.widgetMock.deferNextAgenda());
  await page.keyboard.press("Enter");
  const retryTarget = page.locator(".widget-empty-state button");
  await expect(retryTarget).toBeDisabled();
  await expect(retryTarget).toHaveText("Trying again…");
  await expect(page.locator('.widget-empty-state [role="status"]')).toBeFocused();
  await page.evaluate(() => window.widgetMock.releaseDeferredAgenda());
  await expect(page.getByText("Current agenda")).toBeVisible();
});

test("widget keeps a long agenda visible and focusable beside feedback", async ({ page }) => {
  await installWidgetMock(page, { longAgenda: true });
  await page.setViewportSize({ height: 300, width: 360 });
  await page.goto("/widget.html");

  const agendaRegion = page.getByRole("region", { name: "Upcoming agenda" });
  await expect(agendaRegion).toBeVisible();
  await expect(page.getByText("Desktop placement is unavailable")).toBeVisible();
  await expect.poll(() => agendaRegion.evaluate((element) => {
    const agendaBounds = element.getBoundingClientRect();
    const cardBounds = element.closest(".widget-card")?.getBoundingClientRect();
    return Boolean(
      cardBounds &&
      agendaBounds.height > 0 &&
      agendaBounds.bottom <= cardBounds.bottom &&
      element.scrollHeight > element.clientHeight,
    );
  })).toBe(true);
  await agendaRegion.focus();
  await expect(agendaRegion).toBeFocused();
});

test("widget status events win over older in-flight status reads", async ({ page }) => {
  await installWidgetMock(page);
  await page.goto("/widget.html");
  await expect(page.getByText("Current agenda")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.widgetMock.listenerEvents().sort())).toEqual([
    "note://calendar-changed",
    "note://widget-status-changed",
  ]);

  const statusCallsBeforeRefresh = await page.evaluate(() => window.widgetMock.statusGetCalls());
  await page.evaluate(() => {
    window.widgetMock.deferNextStatus();
    window.widgetMock.emit("note://calendar-changed", undefined);
  });
  await expect.poll(() => page.evaluate(() => window.widgetMock.statusGetCalls()))
    .toBe(statusCallsBeforeRefresh + 1);

  await page.evaluate(() => {
    window.widgetMock.emit("note://widget-status-changed", {
      requestedMode: "desktop",
      effectiveMode: "floating",
      visibilityRequested: true,
      visible: true,
      locked: true,
      sizePreset: "medium",
      attached: false,
    });
    window.widgetMock.releaseDeferredStatus();
  });

  await expect(page.getByRole("button", { name: "Unlock widget" })).toBeVisible();
  await page.waitForTimeout(220);
  await expect(page.getByRole("button", { name: "Unlock widget" })).toBeVisible();
});

test("widget keeps refresh focus while a loaded agenda is refreshing", async ({ page }) => {
  await installWidgetMock(page);
  await page.goto("/widget.html");
  await expect(page.getByText("Current agenda")).toBeVisible();

  await page.evaluate(() => window.widgetMock.deferNextAgenda());
  const refresh = page.getByRole("button", { name: "Refresh" });
  await refresh.click();
  await expect(refresh).toHaveText("Refreshing…");
  await expect(refresh).toBeFocused();
  await expect(refresh).toBeEnabled();

  await page.evaluate(() => window.widgetMock.releaseDeferredAgenda());
  await expect(refresh).toHaveText("Refresh");
});

declare global {
  interface Window {
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: (event: string, id: number) => void };
    __TAURI_INTERNALS__: {
      invoke: (command: string, body?: Record<string, unknown>) => Promise<unknown>;
      metadata: { currentWindow: { label: string } };
      transformCallback: (callback: (event: { payload: unknown }) => void) => number;
    };
    isTauri: boolean;
    widgetMock: {
      calls: Array<{ command: string; body?: Record<string, unknown> }>;
      emit: (event: string, payload: unknown) => void;
      failNextAgenda: () => void;
      deferNextAgenda: () => void;
      deferNextStatus: () => void;
      listenerEvents: () => string[];
      releaseFirstAgenda: () => void;
      releaseDeferredAgenda: () => void;
      releaseDeferredStatus: () => void;
      statusGetCalls: () => number;
    };
  }
}
