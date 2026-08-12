import { expect, test, type Page } from "@playwright/test";

type QuickCommandMockOptions = {
  ready?: Record<string, unknown>;
  statusFails?: boolean;
};

async function installQuickCommandMock(page: Page, options: QuickCommandMockOptions = {}) {
  await page.addInitScript((mockOptions) => {
    type Callback = (event: { payload: unknown }) => void;
    const callbacks = new Map<number, Callback>();
    const listeners = new Map<string, number>();
    let callbackId = 0;
    const session = {
      generation: 12,
      sessionId: "11111111-1111-4111-8111-111111111111",
      state: "recording",
      mode: "assistant_command",
    };

    window.isTauri = true;
    window.quickCommandMock = {
      emit: (event: string, payload: unknown) => callbacks.get(listeners.get(event) ?? -1)?.({ payload }),
      readyCalledAfterListeners: false,
    };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "quick-command" } },
      transformCallback: (callback: Callback) => {
        const id = ++callbackId;
        callbacks.set(id, callback);
        return id;
      },
      invoke: async (command: string, body?: Record<string, unknown>) => {
        if (command === "plugin:event|listen") {
          const event = body?.event;
          const handler = body?.handler;
          if (typeof event === "string" && typeof handler === "number") listeners.set(event, handler);
          return handler;
        }
        if (command === "plugin:event|unlisten") return undefined;
        if (command === "voice_status_get") {
          if (mockOptions.statusFails) throw { code: "voice_unavailable" };
          return {
            microphoneCapture: { available: true, limitation: "Native microphone capture is available." },
            transcription: { available: true, limitation: "Native transcription is available." },
          };
        }
        if (command === "voice_quick_command_ready") {
          window.quickCommandMock.readyCalledAfterListeners = [
            "note://voice-state",
            "note://voice-transcript",
            "note://voice-shortcut",
          ].every((event) => listeners.has(event));
          return mockOptions.ready ?? { generation: 0, shortcutPressed: false };
        }
        if (command === "voice_capture_start") return session;
        if (command === "voice_capture_stop") return { ...session, state: "transcribing" };
        if (command === "voice_capture_cancel") return { ...session, state: "cancelled" };
        if (command === "voice_proposal_submit") return { accepted: true };
        if (command === "voice_typed_proposal") {
          return { proposalId: "22222222-2222-4222-8222-222222222222", text: "Typed fallback", mode: "assistant_command", source: "typed" };
        }
        throw new Error(`Unexpected command: ${command}`);
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: (_event: string, id: number) => callbacks.delete(id),
    };
  }, options);
}

test("quick command replays a mounted current session and discards older events", async ({ page }) => {
  await installQuickCommandMock(page, {
    ready: {
      generation: 7,
      shortcutPressed: true,
      state: {
        generation: 7,
        sessionId: "33333333-3333-4333-8333-333333333333",
        state: "transcribing",
        mode: "assistant_command",
        source: "quick_command",
      },
      transcript: {
        generation: 7,
        sessionId: "33333333-3333-4333-8333-333333333333",
        proposalId: "44444444-4444-4444-8444-444444444444",
        transcript: "Recovered command",
        mode: "assistant_command",
        source: "voice",
      },
    },
  });
  await page.goto("/quick-command.html");

  await expect(page.getByText("Recovered command")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.quickCommandMock.readyCalledAfterListeners)).toBe(true);
  await page.evaluate(() => window.quickCommandMock.emit("note://voice-state", {
    generation: 6,
    sessionId: "stale-session",
    state: "unavailable",
    mode: "assistant_command",
    source: "quick_command",
  }));
  await expect(page.getByText("Recovered command")).toBeVisible();

  await page.getByRole("button", { name: "Send proposal to Note" }).click();
  await expect(page.getByRole("textbox", { name: "Type a command or dictation" })).toBeFocused();
});

test("quick command keeps a cancelable transcription control and an off live timer", async ({ page }) => {
  await installQuickCommandMock(page);
  await page.goto("/quick-command.html");

  await page.getByRole("button", { name: "Record" }).click();
  await expect(page.locator(".quick-command-status")).toHaveAttribute("aria-live", "off");
  await page.getByRole("button", { name: "Stop recording" }).click();
  const cancel = page.getByRole("button", { name: "Cancel transcription" });
  await expect(cancel).toBeVisible();
  await cancel.click();
  await expect(page.getByRole("button", { name: "Record" })).toBeVisible();
});

test("quick command reports unavailable status while retaining typed fallback", async ({ page }) => {
  await installQuickCommandMock(page, { statusFails: true });
  await page.goto("/quick-command.html");

  await expect(page.getByRole("alert")).toContainText("Typed proposals are still available");
  await expect(page.getByRole("textbox", { name: "Type a command or dictation" })).toBeEditable();
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
    quickCommandMock: {
      emit: (event: string, payload: unknown) => void;
      readyCalledAfterListeners: boolean;
    };
  }
}
