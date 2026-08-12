import { expect, test, type Page } from "@playwright/test";

type VoiceSettingsMockOptions = {
  malformedMicrophones?: boolean;
  shortcutConflict?: boolean;
};

async function installVoiceSettingsMock(
  page: Page,
  options: VoiceSettingsMockOptions = {},
) {
  await page.addInitScript((mockOptions) => {
    type NativeCall = { command: string; body?: Record<string, unknown> };
    type Callback = (event: { payload: unknown }) => void;
    const callbacks = new Map<number, Callback>();
    const listenerIds = new Map<string, number>();
    const calls: NativeCall[] = [];
    let callbackId = 0;
    let shouldReturnMalformedMicrophones = Boolean(mockOptions.malformedMicrophones);
    let microphones = {
      available: true,
      limitation: "Choose the microphone Note should use for voice capture.",
      devices: [
        { id: "mic-1111111111111111", label: "Built-in microphone", selected: true },
        { id: "mic-2222222222222222", label: "USB microphone", selected: false },
      ],
      selectedId: "mic-1111111111111111",
      selectionNotice: "A saved selection will fall back to the system default when unavailable.",
    };
    let model = {
      state: "idle",
      displayName: "Whisper small.en",
      expectedDownloadBytes: 466_000_000,
      transcriptionAvailable: false,
    };
    let shortcuts = shortcutStatus(mockOptions.shortcutConflict ? "conflict" : "unregistered");

    window.voiceSettingsMock = {
      activeModelListeners: () => {
        const id = listenerIds.get("note://voice-model-progress");
        return id === undefined ? 0 : Number(callbacks.has(id));
      },
      calls,
      emitModelProgress: (payload: unknown) => {
        const event = payload as { state?: string; errorCode?: string };
        if (event.state === "installed" || event.state === "cancelled" || event.state === "failed") {
          model = {
            ...model,
            state: event.state,
            ...(event.errorCode ? { errorCode: event.errorCode } : {}),
          };
        }
        const id = listenerIds.get("note://voice-model-progress");
        if (id !== undefined) callbacks.get(id)?.({ payload });
      },
      setMalformedMicrophones: (value: boolean) => {
        shouldReturnMalformedMicrophones = value;
      },
    };
    window.isTauri = true;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" } },
      transformCallback: (callback: Callback) => {
        const id = ++callbackId;
        callbacks.set(id, callback);
        return id;
      },
      invoke: async (command: string, body?: Record<string, unknown>) => {
        calls.push({ command, body });
        const request = body?.request as Record<string, unknown> | undefined;
        if (command === "plugin:event|listen") {
          const event = body?.event;
          const handler = body?.handler;
          if (typeof event === "string" && typeof handler === "number") listenerIds.set(event, handler);
          return handler;
        }
        if (command === "plugin:event|unlisten") return undefined;
        if (command === "load_app_data") {
          return { blocks: [], folders: [], pages: [], sessionState: { workspaceTabs: [], selectedWorkspaceTabId: "" } };
        }
        if (command === "save_app_data") return undefined;
        if (command === "assistant_calendar_create_reconciliation_status") return { state: "clear" };
        if (command === "models_ai_state_get") {
          return { schemaVersion: 1, revision: 1, legacyMigrationCompleted: true, providers: [], models: [] };
        }
        if (command === "voice_microphones_get") {
          return shouldReturnMalformedMicrophones
            ? { ...microphones, unexpected: true }
            : microphones;
        }
        if (command === "voice_microphone_select") {
          const microphoneId = request?.microphoneId;
          if (typeof microphoneId !== "string") throw { code: "invalid_request" };
          microphones = {
            ...microphones,
            selectedId: microphoneId,
            devices: microphones.devices.map((device) => ({ ...device, selected: device.id === microphoneId })),
          };
          return microphones;
        }
        if (command === "voice_model_status") return model;
        if (command === "voice_model_install") {
          model = { ...model, state: "installing" };
          return model;
        }
        if (command === "voice_model_cancel_install") {
          model = { ...model, state: "cancelled" };
          return model;
        }
        if (command === "voice_model_remove") {
          model = { ...model, state: "idle" };
          return model;
        }
        if (command === "voice_shortcuts_status_get") return shortcuts;
        if (command === "voice_shortcuts_register") {
          shortcuts = shortcutStatus("registered");
          return shortcuts;
        }
        throw new Error(`Unexpected command: ${command}`);
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: (_event: string, id: number) => callbacks.delete(id),
    };

    function shortcutStatus(status: "registered" | "unregistered" | "conflict") {
      const phaseSeven = { status: "unavailable", message: "Phase 7 action is not started." } as const;
      return {
        holdToTalk: {
          status,
          key: "CmdOrCtrl+Shift+V",
          message: status === "registered"
            ? "Press and release support is registered for CmdOrCtrl+Shift+V."
            : status === "conflict"
              ? "CmdOrCtrl+Shift+V is already in use. Retry after releasing the conflicting shortcut."
              : "Register CmdOrCtrl+Shift+V to enable hold-to-talk.",
        },
        assistant: phaseSeven,
        quickCapture: phaseSeven,
        agenda: phaseSeven,
        widget: phaseSeven,
      };
    }
  }, options);
}

async function openVoiceSettings(page: Page) {
  await page.getByRole("button", { name: "Open Models & AI settings" }).click();
  await page.getByRole("button", { name: "Open Voice settings" }).click();
  await expect(page.getByRole("heading", { name: "Voice settings" })).toBeVisible();
}

test("voice settings rejects malformed native results and permits a safe retry", async ({ page }) => {
  await installVoiceSettingsMock(page, { malformedMicrophones: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Open Models & AI settings" }).click();
  await page.getByRole("button", { name: "Open Voice settings" }).click();
  await expect(page.getByRole("alert")).toContainText("invalid native response");
  await page.evaluate(() => window.voiceSettingsMock.setMalformedMicrophones(false));
  await page.getByRole("button", { name: "Retry loading" }).click();
  await expect(page.getByLabel("Preferred microphone")).toHaveValue("mic-1111111111111111");
  await expect(page.getByText("Phase 7 action is not started.").first()).toBeVisible();
});

test("model progress ignores malformed and stale events while showing cancellation and failure", async ({ page }) => {
  await installVoiceSettingsMock(page);
  await page.goto("/");
  await openVoiceSettings(page);
  await expect.poll(() => page.evaluate(() => window.voiceSettingsMock.activeModelListeners())).toBe(1);

  await page.getByRole("button", { name: /Download model/ }).click();
  await page.evaluate(() => window.voiceSettingsMock.emitModelProgress({ operationId: "operation-current", state: "installing", completedBytes: 0, totalBytes: 0 }));
  const indeterminate = page.getByRole("progressbar", { name: "Voice model progress is indeterminate" });
  await expect(indeterminate).toBeVisible();
  await expect(indeterminate).not.toHaveAttribute("max");
  await expect(page.getByText("Preparing the voice model. Download size is not available yet.")).toBeVisible();
  await page.evaluate(() => window.voiceSettingsMock.emitModelProgress({ operationId: "operation-current", state: "installing", completedBytes: 100_000, totalBytes: 466_000_000 }));
  await expect(page.getByText("100 KB of 466 MB")).toBeVisible();
  await page.evaluate(() => window.voiceSettingsMock.emitModelProgress({ operationId: "../invalid", state: "installed", completedBytes: 1, totalBytes: 1 }));
  await page.evaluate(() => window.voiceSettingsMock.emitModelProgress({ operationId: "operation-stale", state: "installed", completedBytes: 466_000_000, totalBytes: 466_000_000 }));
  await expect(page.getByRole("button", { name: "Cancel download" })).toBeVisible();
  await expect(page.getByText("100 KB of 466 MB")).toBeVisible();

  await page.getByRole("button", { name: "Cancel download" }).click();
  await expect(page.locator(".voice-settings-live")).toContainText("Model download was cancelled.");
  await expect(page.getByRole("button", { name: /Download model/ })).toBeVisible();

  await page.getByRole("button", { name: /Download model/ }).click();
  await page.evaluate(() => window.voiceSettingsMock.emitModelProgress({ operationId: "operation-failed", state: "failed", completedBytes: 100_000, totalBytes: 466_000_000, errorCode: "download_failed" }));
  await expect(page.getByRole("alert")).toContainText("Download failed (download_failed).");
  await expect(page.getByRole("button", { name: /Retry download/ })).toBeVisible();
});

test("microphone selection and conflicting hold-to-talk registration use native retries", async ({ page }) => {
  await installVoiceSettingsMock(page, { shortcutConflict: true });
  await page.goto("/");
  await openVoiceSettings(page);

  await page.getByLabel("Preferred microphone").selectOption("mic-2222222222222222");
  await expect(page.getByLabel("Preferred microphone")).toHaveValue("mic-2222222222222222");
  const microphoneCall = await page.evaluate(() => window.voiceSettingsMock.calls.find((call) => call.command === "voice_microphone_select"));
  expect(microphoneCall?.body).toEqual({ request: { microphoneId: "mic-2222222222222222" } });

  await page.getByRole("button", { name: "Retry hold-to-talk registration" }).click();
  await expect(page.locator(".voice-settings-live")).toContainText("Press and release support is registered for CmdOrCtrl+Shift+V.");
  await expect(page.getByText("registered", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.voiceSettingsMock.calls.some((call) => call.command === "voice_shortcuts_register"))).toBe(true);
});

test("voice model listener is removed when the settings tab is no longer active", async ({ page }) => {
  await installVoiceSettingsMock(page);
  await page.goto("/");
  await openVoiceSettings(page);
  await expect.poll(() => page.evaluate(() => window.voiceSettingsMock.activeModelListeners())).toBe(1);
  await page.getByRole("button", { name: "Create root page" }).click();
  await expect.poll(() => page.evaluate(() => window.voiceSettingsMock.activeModelListeners())).toBe(0);
  await expect.poll(() => page.evaluate(() => window.voiceSettingsMock.calls.some((call) => call.command === "plugin:event|unlisten"))).toBe(true);
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
    voiceSettingsMock: {
      activeModelListeners: () => number;
      calls: Array<{ command: string; body?: Record<string, unknown> }>;
      emitModelProgress: (payload: unknown) => void;
      setMalformedMicrophones: (value: boolean) => void;
    };
  }
}
