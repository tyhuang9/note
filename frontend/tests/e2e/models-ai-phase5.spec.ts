import { expect, test, type Page } from "@playwright/test";

const LEGACY_KEYS = [
  "note.aiProviders.settings.v1",
  "note.aiProviders.credentials.v1",
  "note.llamaHarness.selectedAgentId.v1",
] as const;
const CREDENTIAL_SENTINEL = "phase5-sentinel";

type MockOptions = {
  legacyEntries?: Array<[string, string]>;
  legacyCompleted?: boolean;
  migrationReject?: boolean;
  migrationRejectOnce?: boolean;
  modelProgressListenDelay?: boolean;
  modelProgressListenReject?: boolean;
  modelProgressUnlistenReject?: boolean;
  nativeChat?: boolean;
  ollamaUnavailable?: boolean;
  unownedManagedModel?: boolean;
};

async function installModelsAIMock(page: Page, options: MockOptions = {}) {
  await page.addInitScript((mockOptions) => {
    for (const [key, value] of mockOptions.legacyEntries ?? []) localStorage.setItem(key, value);
    const managedModel = {
      id: "ollama-local:lfm2.5-thinking:1.2b-q4_K_M",
      providerId: "ollama-local",
      runtimeName: "lfm2.5-thinking:1.2b-q4_K_M",
      name: "LFM2.5 Thinking 1.2B",
      capabilities: { chat: true, embeddings: false, vision: false, speechToText: false, streaming: false },
      contextWindowTokens: undefined,
      estimatedMemoryBytes: undefined,
      platforms: ["windows", "macos", "linux"],
      license: { name: "LFM Open License v1.0", url: "https://example.test/license" },
      expectedDownloadBytes: 731_000_000,
      managedRemoval: "note_managed_only",
      ownedByNote: !mockOptions.unownedManagedModel,
      structuredToolSupport: "unverified",
      executionMode: "chat_only",
    };
    const providers = [
      { id: "ollama-local", name: "Ollama", kind: "ollama", baseUrl: "http://127.0.0.1:11434", enabled: true, dataSharing: "local", credentialConfigured: false, capabilities: { chat: true, embeddings: false, speechToText: false }, managed: true },
      { id: "llama-harness", name: "llama-harness", kind: "llama_harness", baseUrl: "http://127.0.0.1:8787", enabled: true, dataSharing: "local", credentialConfigured: false, capabilities: { chat: true, embeddings: false, speechToText: false }, managed: true },
      { id: "openai-compatible-local", name: "OpenAI-compatible local", kind: "openai_compatible", baseUrl: "http://127.0.0.1:1234/v1", enabled: true, dataSharing: "local", credentialConfigured: false, capabilities: { chat: true, embeddings: true, speechToText: false }, managed: true },
      { id: "native-whisper", name: "Native Whisper", kind: "speech_to_text", enabled: false, dataSharing: "local", credentialConfigured: false, capabilities: { chat: false, embeddings: false, speechToText: true }, managed: true },
    ];
    let state: Record<string, any> = {
      schemaVersion: 1,
      revision: 1,
      legacyMigrationCompleted: mockOptions.legacyCompleted ?? true,
      providers,
      models: [managedModel],
      defaultChatModelId: mockOptions.nativeChat ? managedModel.id : undefined,
      selectedLlamaHarnessAgentId: mockOptions.nativeChat ? undefined : "test-agent",
    };
    const calls: Array<{ command: string; body?: unknown }> = [];
    const callbacks = new Map<number, (event: unknown) => void>();
    let callbackId = 0;
    let migrationAttempts = 0;
    let progressDeliveries = 0;
    let resolveProgressListen: (() => void) | undefined;
    window.modelsAIMock = {
      calls,
      writes: [],
      activeProgressCallbacks: () => callbacks.size,
      emitProgress: (payload) => callbacks.forEach((callback) => {
        progressDeliveries += 1;
        callback({ event: "note://model-progress", id: 1, payload });
      }),
      progressDeliveries: () => progressDeliveries,
      resolveProgressListen: () => resolveProgressListen?.(),
    };
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      window.modelsAIMock.writes.push({ key, value });
      return originalSetItem.call(this, key, value);
    };
    window.isTauri = true;
    window.__TAURI_INTERNALS__ = {
      transformCallback: (callback: (event: unknown) => void) => {
        const id = ++callbackId;
        callbacks.set(id, callback);
        return id;
      },
      invoke: async (command: string, body?: Record<string, unknown>) => {
        calls.push({ command, body });
        const request = body?.request as Record<string, any> | undefined;
        if (command === "models_ai_state_get") return state;
        if (command === "models_ai_migrate_legacy") {
          migrationAttempts += 1;
          if (mockOptions.migrationReject || (mockOptions.migrationRejectOnce && migrationAttempts === 1)) throw { code: "storage_unavailable", message: "Migration storage failed." };
          state = { ...state, revision: state.revision + 1, legacyMigrationCompleted: true, selectedLlamaHarnessAgentId: request?.selectedLlamaHarnessAgentId ?? state.selectedLlamaHarnessAgentId };
          return { status: "completed", migratedProviderIds: [], migratedCredentialProviderIds: [], state };
        }
        if (command === "models_ai_settings_save") {
          state = {
            ...state,
            defaultChatModelId: request?.defaultChatModelId ?? undefined,
            defaultEmbeddingModelId: request?.defaultEmbeddingModelId ?? undefined,
            selectedLlamaHarnessAgentId: request?.selectedLlamaHarnessAgentId ?? undefined,
            providers: (request?.providers ?? []).map((input: Record<string, unknown>) => ({
              credentialConfigured: false,
              capabilities: { chat: true, embeddings: true, speechToText: false },
              managed: false,
              ...state.providers.find((provider: Record<string, unknown>) => provider.id === input.id),
              ...input,
            })),
            revision: state.revision + 1,
          };
          return state;
        }
        if (command === "models_ai_credential_set") return { providerId: request?.providerId, credentialConfigured: true };
        if (command === "models_ai_credential_delete") return { providerId: request?.providerId, credentialConfigured: false };
        if (command === "models_ai_provider_test") return { providerId: request?.providerId, status: "reachable", latencyMs: 8, message: "Provider is reachable." };
        if (command === "models_ai_provider_list_models") return { providerId: request?.providerId, models: [], stateRevision: state.revision + 1 };
        if (command === "models_ai_chat") return { providerId: request?.providerId, modelId: request?.modelId, content: "Native chat response", executionMode: "chat_only" };
        if (command === "models_ai_ollama_status") return mockOptions.ollamaUnavailable
          ? { service: "unavailable", availableModels: [], managedModelInstalled: false, managedModelOwnedByNote: false, canRemove: false, pullInProgress: false, error: { code: "provider_unavailable", message: "Ollama is not installed." } }
          : { service: "ready", version: "0.12.0", availableModels: [managedModel.runtimeName], managedModelInstalled: true, managedModelOwnedByNote: !mockOptions.unownedManagedModel, canRemove: !mockOptions.unownedManagedModel, pullInProgress: false };
        if (command === "models_ai_ollama_cancel_pull") return { service: "ready", availableModels: [], managedModelInstalled: false, managedModelOwnedByNote: false, canRemove: false, pullInProgress: false };
        if (command === "plugin:event|listen") {
          const listenerId = body?.handler as number;
          if (mockOptions.modelProgressListenReject) {
            throw new Error("Model progress listener unavailable.");
          }
          if (mockOptions.modelProgressListenDelay) {
            return new Promise((resolve) => {
              resolveProgressListen = () => resolve(listenerId);
            });
          }
          return listenerId;
        }
        if (command === "plugin:event|unlisten") {
          if (mockOptions.modelProgressUnlistenReject) throw new Error("Model progress unlisten unavailable.");
          return undefined;
        }
        if (command === "load_app_data") return { blocks: [], folders: [], pages: [], sessionState: { workspaceTabs: [], selectedWorkspaceTabId: "" } };
        if (command === "save_app_data") return undefined;
        if (command === "assistant_calendar_create_reconciliation_status") return { state: "clear" };
        throw new Error(`Unexpected command: ${command}`);
      },
      metadata: { currentWindow: { label: "main" } },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_event: string, id: number) => callbacks.delete(id) };
  }, options);
}

async function startupCommands(page: Page) {
  return page.evaluate(() => window.modelsAIMock.calls.map((call) => call.command));
}

test("assistant probes Ollama without subscribing to progress, while Models & AI subscribes", async ({ page }) => {
  await installModelsAIMock(page);
  const network: string[] = [];
  page.on("request", (request) => {
    if (/127\.0\.0\.1:(11434|1234|8787)/.test(request.url())) network.push(request.url());
  });
  await page.goto("/");
  await expect.poll(() => startupCommands(page)).toContain("models_ai_state_get");
  let commands = await startupCommands(page);
  expect(commands.filter((command) => command.startsWith("models_ai_"))).toEqual(["models_ai_state_get"]);
  expect(network).toEqual([]);

  await page.getByRole("button", { name: "AI assistant" }).click();
  await expect.poll(() => startupCommands(page)).toContain("models_ai_ollama_status");
  expect(await startupCommands(page)).not.toContain("plugin:event|listen");

  await page.getByRole("button", { name: "Open Models & AI settings" }).click();
  await expect(page.getByRole("heading", { name: "Models & AI" })).toBeVisible();
  await expect.poll(() => startupCommands(page)).toContain("plugin:event|listen");
  await expect(page.locator(".workspace-models-ai-panel")).toHaveJSProperty("scrollWidth", await page.locator(".workspace-models-ai-panel").evaluate((node) => node.clientWidth));
});

test("Models & AI owns one progress listener across close and reopen", async ({ page }) => {
  await installModelsAIMock(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open Models & AI settings" }).click();
  await expect.poll(() => page.evaluate(() => window.modelsAIMock.activeProgressCallbacks())).toBe(1);
  await expect.poll(async () => (await startupCommands(page)).filter((command) => command === "plugin:event|listen")).toHaveLength(1);
  const registration = await page.evaluate(() => window.modelsAIMock.calls.find((call) => call.command === "plugin:event|listen"));
  expect(registration?.body).toMatchObject({ event: "note://model-progress", target: { kind: "Any" } });
  expect(typeof (registration?.body as { handler?: unknown })?.handler).toBe("number");

  await page.getByRole("button", { name: "Create root page" }).click();
  await expect.poll(() => page.evaluate(() => window.modelsAIMock.activeProgressCallbacks())).toBe(0);
  await expect.poll(async () => (await startupCommands(page)).filter((command) => command === "plugin:event|unlisten")).toHaveLength(1);

  await page.getByRole("button", { name: "Open Models & AI settings" }).click();
  await expect.poll(() => page.evaluate(() => window.modelsAIMock.activeProgressCallbacks())).toBe(1);
  await expect.poll(async () => (await startupCommands(page)).filter((command) => command === "plugin:event|listen")).toHaveLength(2);
  await page.evaluate(() => window.modelsAIMock.emitProgress({ operationId: "reopen-pull", modelId: "ollama-local:lfm2.5-thinking:1.2b-q4_K_M", state: "downloading", completedBytes: 100, totalBytes: 1000 }));
  await expect(page.getByRole("button", { name: "Cancel download" })).toBeVisible();
  expect(await page.evaluate(() => window.modelsAIMock.progressDeliveries())).toBe(1);
});

test("progress listener registration failure is a controlled settings error", async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  await installModelsAIMock(page, { modelProgressListenReject: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Open Models & AI settings" }).click();
  await expect(page.getByRole("alert")).toContainText("Model progress updates are unavailable.");
  expect(await page.evaluate(() => window.modelsAIMock.activeProgressCallbacks())).toBe(0);
  expect(pageErrors).toEqual([]);
});

test("progress listener cleanup consumes rejecting unlisten", async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  await installModelsAIMock(page, { modelProgressUnlistenReject: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Open Models & AI settings" }).click();
  await expect.poll(() => page.evaluate(() => window.modelsAIMock.activeProgressCallbacks())).toBe(1);
  await page.getByRole("button", { name: "Create root page" }).click();
  await expect.poll(() => page.evaluate(() => window.modelsAIMock.activeProgressCallbacks())).toBe(0);
  await expect.poll(() => startupCommands(page)).toContain("plugin:event|unlisten");
  expect(pageErrors).toEqual([]);
});

test("late progress listener cleanup consumes rejecting unlisten", async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  await installModelsAIMock(page, { modelProgressListenDelay: true, modelProgressUnlistenReject: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Open Models & AI settings" }).click();
  await expect.poll(() => page.evaluate(() => window.modelsAIMock.activeProgressCallbacks())).toBe(1);
  await page.getByRole("button", { name: "Create root page" }).click();
  await page.evaluate(() => window.modelsAIMock.resolveProgressListen());
  await expect.poll(() => page.evaluate(() => window.modelsAIMock.activeProgressCallbacks())).toBe(0);
  await expect.poll(() => startupCommands(page)).toContain("plugin:event|unlisten");
  expect(pageErrors).toEqual([]);
});

test("successful exact-key migration deletes all legacy keys without writing them", async ({ page }) => {
  await installModelsAIMock(page, {
    legacyCompleted: false,
    legacyEntries: [
      [LEGACY_KEYS[0], JSON.stringify({ providers: [], models: [] })],
      [LEGACY_KEYS[1], JSON.stringify({})],
      [LEGACY_KEYS[2], "test-agent"],
    ],
  });
  await page.goto("/");
  await expect.poll(() => startupCommands(page)).toContain("models_ai_migrate_legacy");
  expect(await page.evaluate((keys) => keys.map((key) => localStorage.getItem(key)), LEGACY_KEYS)).toEqual([null, null, null]);
  expect(await page.evaluate((keys) => window.modelsAIMock.writes.filter((write) => keys.includes(write.key as any)), LEGACY_KEYS)).toEqual([]);
});

for (const invalidCase of [
  { name: "malformed settings", key: LEGACY_KEYS[0], value: "{" },
  { name: "oversize settings", key: LEGACY_KEYS[0], value: "x".repeat(512 * 1024 + 1) },
  { name: "malformed credentials", key: LEGACY_KEYS[1], value: "[\"secret\"]" },
  { name: "oversize credentials", key: LEGACY_KEYS[1], value: "x".repeat(256 * 1024 + 1) },
  { name: "invalid selected agent", key: LEGACY_KEYS[2], value: "x".repeat(161) },
]) {
  test(`${invalidCase.name} retains every legacy key and never invokes migration`, async ({ page }) => {
    await installModelsAIMock(page, {
      legacyCompleted: false,
      legacyEntries: [
        [LEGACY_KEYS[0], invalidCase.key === LEGACY_KEYS[0] ? invalidCase.value : JSON.stringify({ providers: [], models: [] })],
        [LEGACY_KEYS[1], invalidCase.key === LEGACY_KEYS[1] ? invalidCase.value : JSON.stringify({})],
        [LEGACY_KEYS[2], invalidCase.key === LEGACY_KEYS[2] ? invalidCase.value : "test-agent"],
      ],
    });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Open Models & AI settings" })).toBeVisible();
    expect(await startupCommands(page)).not.toContain("models_ai_migrate_legacy");
    expect(await page.evaluate((keys) => keys.map((key) => localStorage.getItem(key) !== null), LEGACY_KEYS)).toEqual([true, true, true]);
  });
}

test("native migration failure retains every legacy key for retry", async ({ page }) => {
  await installModelsAIMock(page, {
    legacyCompleted: false,
    migrationReject: true,
    legacyEntries: [
      [LEGACY_KEYS[0], JSON.stringify({ providers: [], models: [] })],
      [LEGACY_KEYS[1], JSON.stringify({})],
      [LEGACY_KEYS[2], "test-agent"],
    ],
  });
  await page.goto("/");
  await expect.poll(() => startupCommands(page)).toContain("models_ai_migrate_legacy");
  expect(await page.evaluate((keys) => keys.map((key) => localStorage.getItem(key) !== null), LEGACY_KEYS)).toEqual([true, true, true]);
});

test("failed migration can be retried and deletes legacy keys only after completion", async ({ page }) => {
  await installModelsAIMock(page, {
    legacyCompleted: false,
    migrationRejectOnce: true,
    legacyEntries: [
      [LEGACY_KEYS[0], JSON.stringify({ providers: [], models: [] })],
      [LEGACY_KEYS[1], JSON.stringify({})],
      [LEGACY_KEYS[2], "test-agent"],
    ],
  });
  await page.goto("/");
  await expect.poll(async () => (await startupCommands(page)).filter((command) => command === "models_ai_migrate_legacy").length).toBe(1);
  expect(await page.evaluate((keys) => keys.map((key) => localStorage.getItem(key) !== null), LEGACY_KEYS)).toEqual([true, true, true]);

  await page.getByRole("button", { name: "Open Models & AI settings" }).click();
  await page.getByRole("button", { name: "Retry loading" }).click();
  await expect.poll(async () => (await startupCommands(page)).filter((command) => command === "models_ai_migrate_legacy").length).toBe(2);
  expect(await page.evaluate((keys) => keys.map((key) => localStorage.getItem(key)), LEGACY_KEYS)).toEqual([null, null, null]);
});

test("unavailable default Ollama model is not eligible for native assistant chat", async ({ page }) => {
  await page.route("http://127.0.0.1:8787/**", (route) => route.abort());
  await installModelsAIMock(page, { nativeChat: true, ollamaUnavailable: true });
  await page.goto("/");
  await expect.poll(() => startupCommands(page)).toContain("models_ai_state_get");
  expect((await startupCommands(page)).filter((command) => command.startsWith("models_ai_"))).toEqual(["models_ai_state_get"]);

  await page.getByRole("button", { name: /create new note/i }).click();
  await page.getByRole("button", { name: "AI assistant" }).click();
  await expect.poll(() => startupCommands(page)).toContain("models_ai_ollama_status");
  await expect(page.getByText("No chat model selected")).toBeVisible();
  await page.getByRole("textbox", { name: "Assistant prompt" }).fill("Summarize this note");
  await expect(page.getByRole("button", { name: "Send prompt" })).toBeDisabled();
  expect(await page.evaluate(() => window.modelsAIMock.calls.some((entry) => entry.command === "models_ai_chat"))).toBe(false);
});

test("native default model completes assistant chat without tools or harness networking", async ({ page }) => {
  await installModelsAIMock(page, { nativeChat: true });
  const harnessRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith("http://127.0.0.1:8787")) harnessRequests.push(request.url());
  });
  await page.goto("/");
  await page.getByRole("button", { name: /create new note/i }).click();
  await page.getByRole("button", { name: "AI assistant" }).click();
  await page.getByRole("textbox", { name: "Assistant prompt" }).fill("Summarize this note");
  await page.getByRole("button", { name: "Send prompt" }).click();
  await expect(page.getByRole("region", { name: "Assistant messages" })).toContainText("Native chat response");
  const call = await page.evaluate(() => window.modelsAIMock.calls.find((entry) => entry.command === "models_ai_chat"));
  expect(call?.body).toMatchObject({ request: { providerId: "ollama-local", modelId: "ollama-local:lfm2.5-thinking:1.2b-q4_K_M" } });
  expect(JSON.stringify(call?.body)).not.toContain("tools");
  expect(harnessRequests).toEqual([]);
});

test("settings, credentials, provider test, and model discovery use native commands without secret persistence", async ({ page }) => {
  await installModelsAIMock(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open Models & AI settings" }).click();
  await page.getByRole("button", { name: /OpenAI-compatible local/ }).click();
  const credential = page.getByLabel("New provider credential");
  await expect(credential).toHaveAttribute("type", "password");
  await expect(credential).toHaveAttribute("autocomplete", "new-password");
  await credential.fill(CREDENTIAL_SENTINEL);
  await page.getByRole("button", { name: "Store", exact: true }).click();
  await expect(page.getByText("Credential stored by Note’s native service.")).toBeVisible();
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByText(/Provider is reachable/)).toBeVisible();
  await page.getByRole("button", { name: "List models" }).click();
  await expect(page.getByText("Found 0 models.")).toBeVisible();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => startupCommands(page)).toContain("models_ai_settings_save");
  const calls = await page.evaluate(() => window.modelsAIMock.calls);
  expect(calls.map((call) => call.command)).toEqual(expect.arrayContaining([
    "models_ai_credential_set",
    "models_ai_provider_test",
    "models_ai_provider_list_models",
    "models_ai_settings_save",
  ]));
  expect(await page.evaluate(() => window.modelsAIMock.writes)).toEqual([]);
  expect(await page.evaluate((sentinel) => {
    const storageContains = (storage: Storage) => Array.from({ length: storage.length }, (_, index) => storage.getItem(storage.key(index) ?? "")).some((value) => value?.includes(sentinel));
    return {
      localStorage: storageContains(localStorage),
      sessionStorage: storageContains(sessionStorage),
      settingsSave: window.modelsAIMock.calls
        .filter((call) => call.command === "models_ai_settings_save")
        .some((call) => JSON.stringify(call.body).includes(sentinel)),
    };
  }, CREDENTIAL_SENTINEL)).toEqual({ localStorage: false, sessionStorage: false, settingsSave: false });
  await expect(credential).toHaveValue("");
});

test("provider transitions clear credential drafts for keyboard, add, and delete", async ({ page }) => {
  await installModelsAIMock(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open Models & AI settings" }).click();
  const openAI = page.getByRole("button", { name: /OpenAI-compatible local/ });
  const ollama = page.getByRole("button", { name: /Ollama/ });
  await openAI.click();
  const credential = page.getByLabel("New provider credential");
  await credential.fill("keyboard-transition-sentinel");
  await ollama.focus();
  await ollama.press("Enter");
  await expect(ollama).toBeFocused();
  await expect(page.getByText("Unstored credential cleared when changing providers.")).toBeVisible();
  await openAI.focus();
  await openAI.press("Enter");
  await expect(openAI).toBeFocused();
  await expect(credential).toHaveValue("");
  await expect(page.getByRole("button", { name: "Store", exact: true })).toBeDisabled();

  await credential.fill("add-transition-sentinel");
  await page.getByRole("button", { name: "Add compatible" }).click();
  await expect(credential).toHaveValue("");
  await expect(page.getByRole("button", { name: "Store", exact: true })).toBeDisabled();
  await credential.fill("delete-transition-sentinel");
  await page.getByRole("button", { name: "Delete provider" }).click();
  await expect.poll(() => startupCommands(page)).toContain("models_ai_settings_save");
  await openAI.click();
  await expect(credential).toHaveValue("");
  await expect(page.getByRole("button", { name: "Store", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.modelsAIMock.calls.filter((call) => call.command === "models_ai_credential_set"))).toEqual([]);
  expect(await page.evaluate(() => window.modelsAIMock.writes)).toEqual([]);
});

test("credentials require saved provider endpoint and sharing settings", async ({ page }) => {
  await installModelsAIMock(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open Models & AI settings" }).click();
  await page.getByRole("button", { name: "Add compatible" }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => startupCommands(page)).toContain("models_ai_settings_save");
  const credential = page.getByLabel("New provider credential");
  const baseUrl = page.getByRole("textbox", { name: "Base URL" });

  await baseUrl.fill("http://127.0.0.1:9999/v1");
  await credential.fill("endpoint-change-sentinel");
  await page.getByRole("button", { name: "Store", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Save provider changes before storing a credential.");
  expect(await page.evaluate(() => window.modelsAIMock.calls.filter((call) => call.command === "models_ai_credential_set"))).toEqual([]);

  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(async () => (await startupCommands(page)).filter((command) => command === "models_ai_settings_save")).toHaveLength(2);
  await page.getByRole("button", { name: "Store", exact: true }).click();
  await expect(page.getByText("Credential stored by Note’s native service.")).toBeVisible();
  expect(await page.evaluate(() => window.modelsAIMock.calls.filter((call) => call.command === "models_ai_credential_set"))).toHaveLength(1);

  await baseUrl.fill("https://api.example.test/v1");
  await credential.fill("sharing-change-sentinel");
  await page.getByRole("button", { name: "Store", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Save provider changes before storing a credential.");
  await expect(page.getByText("Remote data sharing")).toBeVisible();
  expect(await page.evaluate(() => window.modelsAIMock.calls.filter((call) => call.command === "models_ai_credential_set"))).toHaveLength(1);
});

test("new providers require saving before credentials can be stored", async ({ page }) => {
  await installModelsAIMock(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open Models & AI settings" }).click();
  await page.getByRole("button", { name: "Add compatible" }).click();
  const credential = page.getByLabel("New provider credential");
  await credential.fill("new-provider-sentinel");
  await page.getByRole("button", { name: "Store", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Save provider changes before storing a credential.");
  expect(await page.evaluate(() => window.modelsAIMock.calls.filter((call) => call.command === "models_ai_credential_set"))).toEqual([]);

  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => startupCommands(page)).toContain("models_ai_settings_save");
  await page.getByRole("button", { name: "Store", exact: true }).click();
  await expect(page.getByText("Credential stored by Note’s native service.")).toBeVisible();
  const calls = await page.evaluate(() => window.modelsAIMock.calls.filter((call) => call.command === "models_ai_credential_set"));
  expect(calls).toHaveLength(1);
  expect(calls[0]?.body).toMatchObject({ request: { providerId: expect.stringMatching(/^ai-provider-/) } });
});

test("custom endpoint sharing matches the native numeric loopback boundary", async ({ page }) => {
  await installModelsAIMock(page);
  await page.goto("/");
  const sharing = await page.evaluate(async () => {
    const { inferDataSharing } = await import("/src/features/settings/useAIProviderSettings.ts");
    return [
      "http://127.0.0.1:1234/v1",
      "https://127.255.255.254/v1",
      "http://[::1]:1234/v1",
      "http://localhost:1234/v1",
      "https://api.example.test/v1",
    ].map(inferDataSharing);
  });
  expect(sharing).toEqual(["local", "local", "local", "remote", "remote"]);
});

test("chat-only runtime rejects tool requests and cancel uses an exact no-argument invoke", async ({ page }) => {
  await installModelsAIMock(page);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { AssistantRuntime } = await import("/src/features/assistant/AssistantRuntime.ts");
    const { modelsAIClient } = await import("/src/native/modelsAIClient.ts");
    const runtime = new AssistantRuntime(
      { start: async () => ({ runId: "bad", status: "requires_action", toolRequests: [{ id: "tool", toolId: "notes.read_page", arguments: {} }] }), continue: async () => ({ runId: "bad", status: "completed", toolRequests: [] }) },
      { provider: "native", model: "chat", capabilities: { tools: false }, dataSharing: "local" },
      { read: async () => ({}), write: async () => ({}), describeWrite: () => { throw new Error("unused"); }, fingerprintWrite: () => "unused" },
    );
    const rejected = await runtime.start().then(() => null, (error: unknown) => ({ code: error && typeof error === "object" && "code" in error ? String(error.code) : "", message: error instanceof Error ? error.message : String(error) }));
    await modelsAIClient.ollamaCancelPull();
    return rejected;
  });
  expect(result).toMatchObject({ code: "chat_only_tool_request" });
  const cancel = await page.evaluate(() => window.modelsAIMock.calls.find((entry) => entry.command === "models_ai_ollama_cancel_pull"));
  expect(cancel?.body ?? {}).toEqual({});
  expect(cancel?.body).not.toHaveProperty("request");
});

test("pre-existing external managed tag is visible and cannot be removed", async ({ page }) => {
  await installModelsAIMock(page, { unownedManagedModel: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Open Models & AI settings" }).click();
  await expect(page.getByText("This model tag already exists outside Note and will not be removed by Note.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove managed model" })).toBeDisabled();
});

test("model progress exposes a cancellable live installation state", async ({ page }) => {
  await installModelsAIMock(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open Models & AI settings" }).click();
  await expect.poll(() => startupCommands(page)).toContain("plugin:event|listen");
  await page.evaluate(() => window.modelsAIMock.emitProgress({ operationId: "pull-1", modelId: "ollama-local:lfm2.5-thinking:1.2b-q4_K_M", state: "downloading", completedBytes: 100, totalBytes: 1000 }));
  await expect(page.getByRole("button", { name: "Cancel download" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel download" }).click();
  await expect.poll(() => startupCommands(page)).toContain("models_ai_ollama_cancel_pull");
});

declare global {
  interface Window {
    modelsAIMock: { activeProgressCallbacks: () => number; calls: Array<{ command: string; body?: unknown }>; emitProgress: (payload: unknown) => void; progressDeliveries: () => number; resolveProgressListen: () => void; writes: Array<{ key: string; value: string }> };
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => void };
    __TAURI_INTERNALS__: { transformCallback: (...args: any[]) => number; invoke: (command: string, body?: Record<string, unknown>) => Promise<unknown>; metadata: { currentWindow: { label: string } } };
    isTauri: boolean;
  }
}
