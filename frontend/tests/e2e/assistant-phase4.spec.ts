import { expect, test, type Locator, type Page } from "@playwright/test";

type HarnessRun = {
  agentId?: string;
  appId?: string;
  durationMs?: number;
  modelId?: string;
  output?: string;
  rawResponse?: unknown;
  runId?: string;
  status?: "completed" | "failed" | "requires_action";
  toolRequests?: Array<{
    arguments: unknown;
    displayName?: string;
    id: string;
    name?: string;
    riskLevel?: "high" | "low" | "medium";
    toolId: string;
  }>;
};

type HarnessRecorder = {
  continueBodies: Array<Record<string, unknown>>;
  runBodies: Array<Record<string, unknown>>;
};

type HarnessOptions = {
  agents?: ReadonlyArray<{ description: string; id: string; name: string }>;
  defaultAgentId?: string;
  delaysMs?: readonly number[];
  order?: string[];
};

type NativeStatusStep =
  | "clear"
  | "current"
  | "invalid"
  | "pending"
  | "reject"
  | "required"
  | { delayMs: number; state: "clear" | "reconciliation_required" };

type NativeMockOptions = {
  acknowledgementMode?: "clear-unacknowledged" | "invalid" | "reject" | "success";
  confirmMode?: "create-and-hang" | "error" | "pending-then-replay" | "pending-then-unavailable" | "success";
  order?: string[];
  proposalDelayMs?: number;
  proposalReject?: boolean;
  proposalPending?: boolean;
  readDelayMs?: number;
  readPending?: boolean;
  readReject?: boolean;
  readResults?: Record<string, unknown>;
  reconciliationState?: "clear" | "reconciliation_required";
  revisePending?: boolean;
  statusSteps?: readonly NativeStatusStep[];
};

type NativeMockController = {
  readonly commands: string[];
  readonly order: string[];
  getReconciliationState(): "clear" | "reconciliation_required";
  setReconciliationState(state: "clear" | "reconciliation_required"): void;
};

const NOTE_MAXIMUM_RESULT_BYTES = 16_000;
const CALENDAR_MAXIMUM_RESULT_BYTES = 128 * 1024;
const PROVIDER_MAXIMUM_RESPONSE_BYTES = 1024 * 1024;

const sanitizedEvent = {
  eventId: "event-1",
  title: "Planning",
  notes: "Bring the bounded agenda.",
  location: "Studio",
  time: {
    temporalKind: "timed",
    startUtcMs: 1_754_041_200_000,
    endUtcMs: 1_754_043_000_000,
    timeZone: "America/Chicago",
  },
  recurrenceRule: null,
  reminderOffsetsMinutes: [10],
  revision: 1,
  source: "local_calendar",
  truncatedFields: [],
} as const;

const sanitizedOccurrence = {
  ...sanitizedEvent,
  occurrenceKey: "event-1:1754041200000",
};

const exactQueryResult = {
  items: [sanitizedOccurrence],
  completeness: "complete",
  omittedCount: 0,
} as const;

const exactSearchResult = {
  items: [sanitizedOccurrence],
  completeness: "unknown_beyond_limit",
  omittedCount: null,
} as const;

const exactCreatedResult = {
  status: "created",
  event: sanitizedEvent,
  providerResult: { status: "created", event: sanitizedEvent },
  replayed: false,
} as const;

const exactCancelledResult = {
  status: "cancelled",
  providerResult: { status: "cancelled" },
  replayed: false,
} as const;

const canonicalTools = [
  "notes.read_page",
  "notes.read_selection",
  "notes.search",
  "notes.insert_text",
  "notes.append_text",
  "notes.replace_text",
  "calendar.query",
  "calendar.search",
  "calendar.get_event",
  "calendar.create_event",
];

const legacyTools = [
  "note.getCurrentPage",
  "note.getSelectedBlocks",
  "note.searchPages",
  "note.createBlock",
  "note.updateBlock",
  "note.deleteBlock",
  "note.moveBlock",
  "note.createPage",
  "note.renamePage",
  "note.openPage",
];

function providerToolRequest(request: NonNullable<HarnessRun["toolRequests"]>[number]) {
  const isWrite = [
    "calendar.create_event",
    "notes.insert_text",
    "notes.append_text",
    "notes.replace_text",
    "note.createBlock",
    "note.updateBlock",
    "note.deleteBlock",
    "note.moveBlock",
    "note.createPage",
    "note.renamePage",
    "note.openPage",
  ].includes(request.toolId);
  return {
    ...request,
    displayName: request.displayName ?? request.toolId,
    name: request.name ?? request.toolId,
    riskLevel: request.riskLevel ?? (isWrite ? "high" : "low"),
  };
}

function validRunEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "test-agent",
    appId: "note",
    durationMs: 1,
    modelId: "test-model",
    output: "Valid response.",
    runId: "strict-run",
    status: "completed",
    toolRequests: [],
    ...overrides,
  };
}

function calendarCreateRequest(id = "calendar-call") {
  return providerToolRequest({
    arguments: {
      event: {
        location: null,
        notes: null,
        time: {
          localEnd: "2026-08-01T10:30",
          localStart: "2026-08-01T10:00",
          temporalKind: "timed",
          timeZone: "America/Chicago",
        },
        title: "Planning",
      },
    },
    id,
    toolId: "calendar.create_event",
  });
}

async function openAssistant(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /create new note/i }).click();
  await page.getByRole("button", { name: "AI assistant" }).click();
  return page.getByRole("complementary", { name: "AI assistant" });
}

async function openAssistantForExistingWorkspace(page: Page) {
  await page.goto("/");
  const assistantButton = page.getByRole("button", { name: "AI assistant" });
  try {
    await assistantButton.waitFor({ state: "visible", timeout: 10_000 });
  } catch {
    // A long aggregate run can occasionally race Vite's page bootstrap. Reload once;
    // all scenario assertions and side-effect checks still run unchanged afterward.
    await page.reload();
    await assistantButton.waitFor({ state: "visible", timeout: 10_000 });
  }
  await assistantButton.click();
  return page.getByRole("complementary", { name: "AI assistant" });
}

async function sendAfterConsent(page: Page, prompt: string) {
  await page.getByRole("textbox", { name: "Assistant prompt" }).fill(prompt);
  await page.getByRole("button", { name: "Send prompt" }).click();
  const consent = page.getByRole("region", { name: "Assistant data sharing review" });
  await expect(consent).toBeVisible();
  await consent.getByRole("button", { name: "Send with this context" }).click();
}

async function mockHarness(
  page: Page,
  runs: readonly HarnessRun[],
  options: HarnessOptions = {},
): Promise<HarnessRecorder> {
  const recorder: HarnessRecorder = { continueBodies: [], runBodies: [] };
  let runIndex = 0;
  await page.route("http://127.0.0.1:8787/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const corsHeaders = {
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-origin": "*",
    };
    if (request.method() === "OPTIONS") {
      await route.fulfill({ headers: corsHeaders, status: 204 });
      return;
    }
    if (path === "/api/setup/status") {
      await route.fulfill({ body: JSON.stringify({ active_agent_count: 1, litellm_enabled: true, litellm_ready: true, missing_steps: [], next_step: "ready", ready: true, usable_model_count: 1, usable_provider_count: 1 }), contentType: "application/json", headers: corsHeaders, status: 200 });
      return;
    }
    if (path === "/api/apps/note/capabilities") {
      const agents = options.agents?.length
        ? [...options.agents]
        : [{ description: "Playwright assistant", id: "test-agent", name: "Test agent" }];
      const agent = agents.find((candidate) => candidate.id === options.defaultAgentId) ?? agents[0];
      await route.fulfill({ body: JSON.stringify({ allowedAgents: agents, appId: "note", appName: "Note", defaultAgent: agent, model: { id: "test-model", modelName: "test-model", name: "Test model", provider: "mock", status: "ready" }, tools: [] }), contentType: "application/json", headers: corsHeaders, status: 200 });
      return;
    }
    const body = request.postDataJSON() as Record<string, unknown>;
    const isContinuation = path.endsWith("/tool-results");
    options.order?.push(isContinuation ? "provider:continue" : "provider:start");
    (isContinuation ? recorder.continueBodies : recorder.runBodies).push(body);
    const delayMs = options.delaysMs?.[runIndex] ?? 0;
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    const response = runs[Math.min(runIndex, runs.length - 1)];
    runIndex += 1;
    const responseBody = response.rawResponse ?? {
      agentId: response.agentId ?? options.defaultAgentId ?? "test-agent",
      appId: response.appId ?? "note",
      durationMs: response.durationMs ?? 1,
      modelId: response.modelId ?? "test-model",
      output: response.output,
      runId: response.runId ?? "phase4-run",
      status: response.status,
      toolRequests: (response.toolRequests ?? []).map(providerToolRequest),
    };
    await route.fulfill({
      body: JSON.stringify(responseBody),
      contentType: "application/json",
      headers: corsHeaders,
      status: 200,
    });
  });
  return recorder;
}

async function installProviderBodyOverride(
  page: Page,
  mode: "declared-too-large" | "empty" | "invalid-json" | "streamed-too-large",
) {
  await page.addInitScript(({ bodyMode, maximumBytes }) => {
    const realFetch = window.fetch.bind(window);
    window.providerBodyOverrideCalls = 0;
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url, location.href).pathname === "/api/runs" && init?.method === "POST") {
        window.providerBodyOverrideCalls += 1;
        if (bodyMode === "empty") return new Response(null, { status: 200 });
        if (bodyMode === "invalid-json") return new Response("{", { status: 200 });
        if (bodyMode === "declared-too-large") {
          return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{}")); controller.close(); } }), {
            headers: { "content-length": String(maximumBytes + 1), "content-type": "application/json" },
            status: 200,
          });
        }
        return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(maximumBytes + 1)); controller.close(); } }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      }
      return realFetch(input, init);
    };
  }, { bodyMode: mode, maximumBytes: PROVIDER_MAXIMUM_RESPONSE_BYTES });
}

async function installAssistantNativeMock(
  page: Page,
  options: NativeMockOptions = {},
): Promise<NativeMockController> {
  const durable = {
    commands: [] as string[],
    order: options.order ?? [],
    reconciliationState: options.reconciliationState ?? "clear" as "clear" | "reconciliation_required",
    statusSteps: [...(options.statusSteps ?? [])],
  };
  await page.exposeBinding("__phase4NativeBridge", async (_source, action: string, payload?: Record<string, unknown>) => {
    if (action === "record") {
      const command = String(payload?.command ?? "");
      durable.commands.push(command);
      durable.order.push(`native:${command}`);
      return null;
    }
    if (action === "status") {
      const step = durable.statusSteps.shift() ?? "current";
      if (step === "pending") return new Promise(() => undefined);
      if (step === "reject") throw { code: "storage_unavailable", message: "Native reconciliation status failed." };
      if (step === "invalid") return { state: "unknown" };
      if (typeof step === "object") {
        await new Promise((resolve) => setTimeout(resolve, step.delayMs));
        return { state: step.state };
      }
      if (step === "clear") return { state: "clear" };
      if (step === "required") return { state: "reconciliation_required" };
      return { state: durable.reconciliationState };
    }
    if (action === "mark-required") {
      durable.reconciliationState = "reconciliation_required";
      return null;
    }
    if (action === "acknowledge") {
      const mode = payload?.mode;
      if (mode !== "exact_created_outcome_received" && mode !== "agenda_inspected") {
        throw { code: "invalid_reconciliation_acknowledgement", message: "Unexpected acknowledgement mode." };
      }
      if (options.acknowledgementMode === "reject") {
        throw { code: "storage_unavailable", message: "Native reconciliation acknowledgement failed." };
      }
      if (options.acknowledgementMode === "invalid") return { state: "reconciliation_required", acknowledged: true, mode };
      durable.reconciliationState = "clear";
      return {
        state: "clear",
        acknowledged: options.acknowledgementMode !== "clear-unacknowledged",
        mode,
      };
    }
    throw new Error(`Unexpected native bridge action: ${action}`);
  });
  await page.addInitScript((mockOptions) => {
    window.isTauri = true;
    const privateToken = "phase4-private-token-never-render";
    let modelsAIState: Record<string, any> = {
      schemaVersion: 1,
      revision: 1,
      legacyMigrationCompleted: true,
      providers: [
        { id: "ollama-local", name: "Ollama", kind: "ollama", baseUrl: "http://127.0.0.1:11434", enabled: true, dataSharing: "local", credentialConfigured: false, capabilities: { chat: true, embeddings: false, speechToText: false }, managed: true },
        { id: "llama-harness", name: "llama-harness", kind: "llama_harness", baseUrl: "http://127.0.0.1:8787", enabled: true, dataSharing: "local", credentialConfigured: false, capabilities: { chat: true, embeddings: false, speechToText: false }, managed: true },
        { id: "openai-compatible-local", name: "OpenAI-compatible local", kind: "openai_compatible", baseUrl: "http://127.0.0.1:1234/v1", enabled: true, dataSharing: "local", credentialConfigured: false, capabilities: { chat: true, embeddings: true, speechToText: false }, managed: true },
        { id: "native-whisper", name: "Native Whisper", kind: "speech_to_text", enabled: false, dataSharing: "local", credentialConfigured: false, capabilities: { chat: false, embeddings: false, speechToText: true }, managed: true },
      ],
      models: [],
      selectedLlamaHarnessAgentId: "test-agent",
    };
    let firstConfirmToken: string | null = null;
    window.assistantNativeState = {
      commands: [],
      confirmAttempts: 0,
      createEffects: 0,
      proposalAttempts: 0,
      acknowledgementModes: [],
      reconciliationStatusChecks: 0,
      sameConfirmToken: true,
    };
    window.__TAURI_INTERNALS__ = {
      invoke: async (command: string, body?: Record<string, unknown>) => {
        window.assistantNativeState.commands.push(command);
        await window.__phase4NativeBridge("record", { command });
        if (command === "models_ai_state_get") return modelsAIState;
        if (command === "models_ai_settings_save") {
          const request = body?.request as { selectedLlamaHarnessAgentId?: string | null } | undefined;
          modelsAIState = { ...modelsAIState, revision: modelsAIState.revision + 1, selectedLlamaHarnessAgentId: request?.selectedLlamaHarnessAgentId ?? undefined };
          return modelsAIState;
        }
        if (command === "load_app_data") {
          return {
            blocks: [],
            folders: [{ id: "folder-1", name: "Target" }],
            pages: [{ folderId: "folder-1", id: "page-1", title: "One" }],
            sessionState: { selectedWorkspaceTabId: "note:page-1", workspaceTabs: [{ id: "note:page-1", title: "One", view: { kind: "note", pageId: "page-1" } }] },
          };
        }
        if (command === "save_app_data") return undefined;
        if (command === "assistant_calendar_create_reconciliation_status") {
          window.assistantNativeState.reconciliationStatusChecks += 1;
          return window.__phase4NativeBridge("status");
        }
        if (command === "assistant_calendar_create_reconciliation_acknowledge") {
          const request = body?.request as { mode?: string } | undefined;
          window.assistantNativeState.acknowledgementModes.push(request?.mode ?? "");
          return window.__phase4NativeBridge("acknowledge", { mode: request?.mode });
        }
        if (command === "assistant_calendar_tool_execute") {
          if (mockOptions.readPending) return new Promise(() => undefined);
          if (mockOptions.readDelayMs) {
            await new Promise((resolve) => window.setTimeout(resolve, mockOptions.readDelayMs));
          }
          if (mockOptions.readReject) {
            throw { code: "storage_unavailable", message: "Late native read failure." };
          }
          const request = body?.request as { schemaVersion: number; toolId: string };
          const fallbackResults: Record<string, unknown> = {
            "calendar.query": {
              items: [{ eventId: "event-1", title: "Planning", notes: "Bring the bounded agenda.", location: "Studio", time: { temporalKind: "timed", startUtcMs: 1754041200000, endUtcMs: 1754043000000, timeZone: "America/Chicago" }, recurrenceRule: null, reminderOffsetsMinutes: [10], revision: 1, source: "local_calendar", truncatedFields: [], occurrenceKey: "event-1:1754041200000" }],
              completeness: "complete",
              omittedCount: 0,
            },
            "calendar.search": {
              items: [{ eventId: "event-1", title: "Planning", notes: "Bring the bounded agenda.", location: "Studio", time: { temporalKind: "timed", startUtcMs: 1754041200000, endUtcMs: 1754043000000, timeZone: "America/Chicago" }, recurrenceRule: null, reminderOffsetsMinutes: [10], revision: 1, source: "local_calendar", truncatedFields: [], occurrenceKey: "event-1:1754041200000" }],
              completeness: "unknown_beyond_limit",
              omittedCount: null,
            },
            "calendar.get_event": { eventId: "event-1", title: "Planning", notes: "Bring the bounded agenda.", location: "Studio", time: { temporalKind: "timed", startUtcMs: 1754041200000, endUtcMs: 1754043000000, timeZone: "America/Chicago" }, recurrenceRule: null, reminderOffsetsMinutes: [10], revision: 1, source: "local_calendar", truncatedFields: [] },
          };
          return {
            result: mockOptions.readResults?.[request.toolId] ?? fallbackResults[request.toolId],
            schemaVersion: request.schemaVersion,
            toolId: request.toolId,
          };
        }
        if (command === "assistant_calendar_create_propose" || command === "assistant_calendar_create_revise") {
          const isRevision = command === "assistant_calendar_create_revise";
          if (!isRevision) window.assistantNativeState.proposalAttempts += 1;
          if (isRevision ? mockOptions.revisePending : mockOptions.proposalPending) return new Promise(() => undefined);
          if (!isRevision && mockOptions.proposalDelayMs) {
            await new Promise((resolve) => window.setTimeout(resolve, mockOptions.proposalDelayMs));
          }
          if (!isRevision && mockOptions.proposalReject) {
            throw { code: "storage_unavailable", message: "Late native proposal failure." };
          }
          return {
            expiresAtUtcMs: Date.now() + 120_000,
            providerResult: {
              status: "requires_confirmation",
              review: {
                fieldSources: { title: "model" }, location: null, notes: null,
                recurrenceRule: null, reminderOffsetsMinutes: [], source: "assistant",
                time: { durationMinutes: 30, localEnd: "2026-08-01T10:30", localStart: "2026-08-01T10:00", temporalKind: "timed", timeZone: "America/Chicago" },
                title: "Planning",
              },
            },
            review: {
              fieldSources: { title: "model" }, location: null, notes: null,
              recurrenceRule: null, reminderOffsetsMinutes: [], source: "assistant",
              time: { durationMinutes: 30, localEnd: "2026-08-01T10:30", localStart: "2026-08-01T10:00", temporalKind: "timed", timeZone: "America/Chicago" },
              title: "Planning",
            },
            runId: "phase4-run", schemaVersion: 1, token: privateToken, toolCallId: "calendar-call", toolId: "calendar.create_event",
          };
        }
        if (command === "assistant_calendar_create_confirm") {
          const request = body?.request as { token?: string };
          window.assistantNativeState.confirmAttempts += 1;
          if (firstConfirmToken === null) firstConfirmToken = request.token ?? null;
          else window.assistantNativeState.sameConfirmToken &&= request.token === firstConfirmToken;
          if (mockOptions.confirmMode === "error") {
            throw { code: "invalid_title", message: "Native confirmation rejected the reviewed title." };
          }
          if ((mockOptions.confirmMode === "create-and-hang" || mockOptions.confirmMode === "pending-then-replay" || mockOptions.confirmMode === "pending-then-unavailable") && window.assistantNativeState.confirmAttempts === 1) {
            window.assistantNativeState.createEffects += 1;
            await window.__phase4NativeBridge("mark-required");
            return new Promise(() => undefined);
          }
          if (mockOptions.confirmMode === "pending-then-unavailable") {
            throw { code: "pending_action_unavailable", message: "The confirmation replay entry expired." };
          }
          if (mockOptions.confirmMode !== "pending-then-replay") window.assistantNativeState.createEffects += 1;
          await window.__phase4NativeBridge("mark-required");
          return {
            status: "created",
            event: { eventId: "event-1", title: "Planning", notes: "Bring the bounded agenda.", location: "Studio", time: { temporalKind: "timed", startUtcMs: 1754041200000, endUtcMs: 1754043000000, timeZone: "America/Chicago" }, recurrenceRule: null, reminderOffsetsMinutes: [10], revision: 1, source: "local_calendar", truncatedFields: [] },
            providerResult: { status: "created", event: { eventId: "event-1", title: "Planning", notes: "Bring the bounded agenda.", location: "Studio", time: { temporalKind: "timed", startUtcMs: 1754041200000, endUtcMs: 1754043000000, timeZone: "America/Chicago" }, recurrenceRule: null, reminderOffsetsMinutes: [10], revision: 1, source: "local_calendar", truncatedFields: [] } },
            replayed: mockOptions.confirmMode === "pending-then-replay",
          };
        }
        if (command === "assistant_calendar_create_cancel") {
          return { status: "cancelled", providerResult: { status: "cancelled" }, replayed: false };
        }
        throw new Error(`Unexpected command: ${command}`);
      },
      metadata: { currentWindow: { label: "main" } },
    };
  }, options);
  return {
    commands: durable.commands,
    order: durable.order,
    getReconciliationState: () => durable.reconciliationState,
    setReconciliationState: (state) => { durable.reconciliationState = state; },
  };
}

async function openPendingConfirmationReview(page: Page, width: number): Promise<Locator> {
  await installAssistantNativeMock(page, { confirmMode: "pending-then-replay" });
  await mockHarness(page, [{
    runId: "pending-layout-run",
    status: "requires_action",
    toolRequests: [{
      arguments: { event: { location: null, notes: null, time: { localEnd: "2026-08-01T10:30", localStart: "2026-08-01T10:00", temporalKind: "timed", timeZone: "America/Chicago" }, title: "Planning" } },
      id: "calendar-call",
      toolId: "calendar.create_event",
    }],
  }]);
  await page.setViewportSize({ width, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "AI assistant" }).click();
  await page.clock.install();
  await sendAfterConsent(page, `Create Planning at ${width}px`);
  const review = page.getByRole("region", { name: "Calendar event review" });
  await review.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => page.evaluate(() => window.assistantNativeState.confirmAttempts)).toBe(1);
  await page.clock.fastForward(120_000);
  await expect(review.getByRole("button", { name: "Retry Confirm" })).toBeEnabled();
  return review;
}

test("unknown provider holds the exact v1 manifest and context until disclosure is confirmed", async ({ page }) => {
  const recorder = await mockHarness(page, [{ output: "Manifest accepted.", status: "completed" }]);
  await openAssistant(page);
  await page.getByRole("textbox", { name: "Assistant prompt" }).fill("Summarize this page");
  await page.getByRole("button", { name: "Send prompt" }).click();

  const consent = page.getByRole("region", { name: "Assistant data sharing review" });
  await expect(consent).toContainText("Nothing has been sent yet.");
  expect(recorder.runBodies).toHaveLength(0);
  await consent.getByRole("button", { name: "Send with this context" }).click();
  await expect.poll(() => recorder.runBodies.length).toBe(1);

  const payload = recorder.runBodies[0];
  const manifest = payload.toolManifest as {
    compatibilityAliases: Array<{ aliasFor: string; id: string; schemaVersion: number }>;
    limits: { maximumCallsPerRound: number; maximumCallsTotal: number; maximumRounds: number };
    schemaVersion: number;
    tools: Array<Record<string, unknown>>;
  };
  expect(manifest.schemaVersion).toBe(1);
  expect(manifest.limits).toEqual({ maximumCallsPerRound: 8, maximumCallsTotal: 24, maximumRounds: 5 });
  expect(manifest.tools.map((tool) => tool.id)).toEqual([...canonicalTools, ...legacyTools]);
  expect(manifest.compatibilityAliases).toEqual([
    { aliasFor: "notes.read_page", id: "note.getCurrentPage", schemaVersion: 1 },
    { aliasFor: "notes.read_selection", id: "note.getSelectedBlocks", schemaVersion: 1 },
    { aliasFor: "notes.search", id: "note.searchPages", schemaVersion: 1 },
    { aliasFor: "notes.insert_text", id: "note.createBlock", schemaVersion: 1 },
  ]);
  expect(manifest.tools.every((tool) => String(tool.id).length <= 200)).toBe(true);
  for (const tool of manifest.tools) {
    const isCalendar = String(tool.id).startsWith("calendar.");
    expect(tool.maximumResultBytes).toBe(isCalendar ? CALENDAR_MAXIMUM_RESULT_BYTES : NOTE_MAXIMUM_RESULT_BYTES);
    expect((tool.outputSchema as Record<string, unknown>).maximumBytes).toBe(isCalendar ? CALENDAR_MAXIMUM_RESULT_BYTES : NOTE_MAXIMUM_RESULT_BYTES);
    expect(tool.timeoutMs).toBe(tool.risk === "read" ? 10_000 : 120_000);
  }

  const byId = new Map(manifest.tools.map((tool) => [String(tool.id), tool]));
  for (const id of ["notes.append_text", "notes.replace_text"]) {
    const input = byId.get(id)?.inputSchema as { properties: { blockId: { maxLength: number } }; required: string[] };
    expect(input.required).toEqual(["blockId", "content"]);
    expect(input.properties.blockId.maxLength).toBe(200);
  }
  const queryInput = byId.get("calendar.query")?.inputSchema as { properties: Record<string, Record<string, unknown>> };
  const searchInput = byId.get("calendar.search")?.inputSchema as { properties: Record<string, Record<string, unknown>> };
  expect(queryInput.properties.startUtcMs.type).toBe("integer");
  expect(queryInput.properties.endUtcMs.type).toBe("integer");
  expect(queryInput.properties.limit).toMatchObject({ type: "integer", minimum: 1, maximum: 25 });
  expect(searchInput.properties.limit).toMatchObject({ type: "integer", minimum: 1, maximum: 20 });
  const create = manifest.tools.find((tool) => tool.id === "calendar.create_event");
  expect(create).toMatchObject({ authorizedWindows: ["main"], confirmationRequired: true, maximumResultBytes: CALENDAR_MAXIMUM_RESULT_BYTES, providerDataSharing: "sanitized_calendar_content", risk: "write", schemaVersion: 1, timeoutMs: 120_000 });
  const createInput = create?.inputSchema as { properties: { event: { additionalProperties: boolean; properties: { reminderOffsetsMinutes: Record<string, unknown>; time: { oneOf: Array<Record<string, unknown>> } }; required: string[] }; inferredFields: Record<string, unknown> }; required: string[] };
  const event = createInput.properties.event;
  expect(createInput.required).toEqual(["event"]);
  expect(event.additionalProperties).toBe(false);
  expect(event.required).toEqual(["title", "notes", "location", "time"]);
  expect(event.properties.time.oneOf).toEqual(expect.arrayContaining([
    expect.objectContaining({ additionalProperties: false, required: ["temporalKind", "localStart", "localEnd", "timeZone"] }),
    expect.objectContaining({ additionalProperties: false, required: ["temporalKind", "startDate", "endDateExclusive"] }),
  ]));
  expect(event.properties.reminderOffsetsMinutes).toMatchObject({ maxItems: 5, uniqueItems: true, items: { type: "integer", minimum: 0, maximum: 50_400 } });
  expect(createInput.properties.inferredFields).toMatchObject({ maxItems: 9, uniqueItems: true });

  const queryOutput = byId.get("calendar.query")?.outputSchema as { completenessRequired: boolean; properties: Record<string, Record<string, unknown>> };
  const searchOutput = byId.get("calendar.search")?.outputSchema as { completenessRequired: boolean; properties: Record<string, Record<string, unknown>> };
  const getOutput = byId.get("calendar.get_event")?.outputSchema as { completenessRequired: boolean; properties: Record<string, unknown> };
  expect(queryOutput.completenessRequired).toBe(true);
  expect(queryOutput.properties.items.maxItems).toBe(25);
  expect(queryOutput.properties.completeness.enum).toEqual(["complete", "truncated"]);
  expect(queryOutput.properties.omittedCount).toMatchObject({ type: "integer", minimum: 0 });
  expect(searchOutput.completenessRequired).toBe(true);
  expect(searchOutput.properties.items.maxItems).toBe(20);
  expect(searchOutput.properties.completeness.enum).toEqual(["complete", "unknown_beyond_limit"]);
  expect(searchOutput.properties.omittedCount).toEqual({ type: "null" });
  expect(getOutput.completenessRequired).toBe(false);
  expect(getOutput.properties).not.toHaveProperty("completeness");
  expect(getOutput.properties).toMatchObject({ eventId: { type: "string", maxLength: 200 }, title: { type: "string", maxLength: 200 }, notes: { anyOf: expect.any(Array) }, location: { anyOf: expect.any(Array) }, time: { oneOf: expect.any(Array) }, revision: { type: "integer" }, source: { const: "local_calendar" } });
  expect(JSON.stringify(payload)).not.toMatch(/token|phase4-opaque-token/i);
});

test("failed provider result is an error and never a synthetic Done response", async ({ page }) => {
  await mockHarness(page, [{ output: "Provider unavailable", status: "failed" }]);
  await openAssistant(page);
  await sendAfterConsent(page, "Fail safely");
  await expect(page.locator(".assistant-error")).toContainText("Provider unavailable");
  await expect(page.getByRole("region", { name: "Assistant messages" })).not.toContainText("Done.");
});

test("mixed assistant writes are rejected before mutation or provider continuation", async ({ page }) => {
  const recorder = await mockHarness(page, [{
    runId: "mixed-run",
    status: "requires_action",
    toolRequests: [
      { arguments: { content: "first" }, id: "write-1", toolId: "notes.insert_text" },
      { arguments: { content: "second" }, id: "write-2", toolId: "notes.insert_text" },
    ],
  }]);
  await openAssistant(page);
  await sendAfterConsent(page, "Try two writes");
  await expect(page.locator(".assistant-error")).toContainText("Mixed or multiple assistant writes require separate requests.");
  expect(recorder.continueBodies).toHaveLength(0);
  await expect(page.locator(".text-block-display")).toHaveCount(0);
});

test("Note write is informed, exposes editable fields, and performs no mutation before confirmation", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const recorder = await mockHarness(page, [
    { runId: "note-run", status: "requires_action", toolRequests: [{ arguments: { content: "Proposed Note text", x: 100, y: 120 }, id: "note-call", toolId: "notes.insert_text" }] },
    { output: "Note follow-up complete.", runId: "note-run", status: "completed" },
  ]);
  await openAssistant(page);
  await sendAfterConsent(page, "Add a note");
  const review = page.getByRole("region", { name: "Note change review" });
  await expect(review).toContainText("Insert a new text block");
  await expect(review).toContainText("Proposed Note text");
  await expect(page.locator(".text-block-display")).toHaveCount(0);
  await review.getByRole("button", { name: "Edit proposed fields" }).click();
  const proposedText = review.locator("textarea");
  await proposedText.fill("Edited Note text");
  expect(pageErrors).toEqual([]);
  await expect(review.getByRole("button", { name: "Save changes for review" })).toBeVisible();
  await review.getByRole("button", { name: "Save changes for review" }).click();
  await expect(review.getByRole("button", { name: "Confirm" })).toBeFocused();
  await review.getByRole("button", { name: "Confirm" }).click();
  await expect(page.locator(".text-block-display")).toContainText("Edited Note text");
  await expect.poll(() => recorder.continueBodies.length).toBe(1);
  await expect(page.getByRole("region", { name: "Assistant messages" })).toContainText("Note follow-up complete.");
});

test("explicit createPage destination conflict prevents the reviewed mutation", async ({ page }) => {
  await installAssistantNativeMock(page);
  const recorder = await mockHarness(page, [{ runId: "create-page", status: "requires_action", toolRequests: [{ arguments: { title: "New destination page", folderId: "folder-1" }, id: "create-page-call", toolId: "note.createPage" }] }]);
  await page.goto("/");
  await page.getByRole("button", { name: "AI assistant" }).click();
  await sendAfterConsent(page, "Create a page in Target");
  const review = page.getByRole("region", { name: "Note change review" });
  await expect(review).toContainText("folder “Target” (folder-1)");
  const folderRow = page.getByRole("treeitem", { name: /folder Target/i });
  await folderRow.dblclick();
  const folderName = page.getByRole("textbox", { name: "Folder name" });
  await folderName.fill("Renamed target");
  await folderName.press("Enter");
  await review.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByRole("alert")).toContainText("The reviewed Note target changed. Ask the assistant for a new proposal.");
  await expect(review).toHaveCount(0);
  expect(recorder.continueBodies).toHaveLength(0);
  await expect(page.getByText("New destination page", { exact: true })).toHaveCount(0);
});

test("review controls meet 44px targets and remain visible in forced colors", async ({ page }) => {
  await mockHarness(page, [{ runId: "note-review-size", status: "requires_action", toolRequests: [{ arguments: { content: "Accessible proposal", x: 100, y: 120 }, id: "note-call", toolId: "notes.insert_text" }] }]);
  await openAssistant(page);
  await page.emulateMedia({ forcedColors: "active" });
  await sendAfterConsent(page, "Check review controls");
  const review = page.getByRole("region", { name: "Note change review" });
  const buttons = review.locator(".assistant-review-actions button");
  for (let index = 0; index < await buttons.count(); index += 1) {
    const box = await buttons.nth(index).boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  await review.getByRole("button", { name: "Edit proposed fields" }).click();
  const controls = review.locator(".assistant-review-form input, .assistant-review-form textarea, .assistant-review-form button");
  for (let index = 0; index < await controls.count(); index += 1) {
    const box = await controls.nth(index).boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);
  const colors = await review.evaluate((element) => {
    const card = getComputedStyle(element);
    const button = getComputedStyle(element.querySelector("button")!);
    return { background: card.backgroundColor, border: card.borderColor, buttonBackground: button.backgroundColor, buttonBorder: button.borderColor, buttonColor: button.color };
  });
  expect(colors.border).not.toBe("rgba(0, 0, 0, 0)");
  expect(colors.buttonBorder).not.toBe("rgba(0, 0, 0, 0)");
  expect(colors.buttonColor).not.toBe(colors.buttonBackground);
});

test("calendar proposal token stays out of browser-visible and provider-visible state", async ({ page }) => {
  await installAssistantNativeMock(page);
  const recorder = await mockHarness(page, [
    { runId: "phase4-run", status: "requires_action", toolRequests: [{ arguments: { event: { location: null, notes: null, time: { localEnd: "2026-08-01T10:30", localStart: "2026-08-01T10:00", temporalKind: "timed", timeZone: "America/Chicago" }, title: "Planning" } }, id: "calendar-call", toolId: "calendar.create_event" }] },
    { output: "Calendar follow-up complete.", runId: "phase4-run", status: "completed" },
  ]);
  const consoleMessages: string[] = [];
  page.on("console", (message) => consoleMessages.push(message.text()));
  await page.goto("/");
  await page.getByRole("button", { name: "AI assistant" }).click();
  await sendAfterConsent(page, "Create planning event");
  const review = page.getByRole("region", { name: "Calendar event review" });
  await expect(review).toContainText("Planning");
  await expect(page.locator("body")).not.toContainText(/phase4-private-token/i);
  const browserState = await page.evaluate(() => ({ href: location.href, local: JSON.stringify(localStorage), session: JSON.stringify(sessionStorage), text: document.body.textContent }));
  expect(JSON.stringify(browserState)).not.toMatch(/phase4-private-token/i);
  expect(JSON.stringify(recorder)).not.toMatch(/phase4-private-token/i);
  expect(consoleMessages.join("\n")).not.toMatch(/phase4-private-token/i);
  const confirm = review.getByRole("button", { name: "Confirm" });
  await confirm.click();
  await expect.poll(() => page.evaluate(() => window.assistantNativeState.commands.filter((call) => call === "assistant_calendar_create_confirm").length)).toBe(1);
  await expect.poll(() => recorder.continueBodies.length).toBe(1);
  expect(recorder.continueBodies[0].toolResults).toEqual([{ toolCallId: "calendar-call", toolId: "calendar.create_event", result: exactCreatedResult }]);
  await expect(page.getByRole("region", { name: "Assistant messages" })).toContainText("Calendar follow-up complete.");
});

test("calendar query, search, and get_event use exact production results before continuation", async ({ page }) => {
  await installAssistantNativeMock(page);
  const recorder = await mockHarness(page, [
    { runId: "calendar-read", status: "requires_action", toolRequests: [
      { arguments: { endDateExclusive: "2026-08-02", endUtcMs: 1_754_064_000_000, limit: 25, startDate: "2026-08-01", startUtcMs: 1_753_977_600_000 }, id: "calendar-query-call", toolId: "calendar.query" },
      { arguments: { query: "Planning", endDateExclusive: "2026-08-02", endUtcMs: 1_754_064_000_000, limit: 20, startDate: "2026-08-01", startUtcMs: 1_753_977_600_000 }, id: "calendar-search-call", toolId: "calendar.search" },
      { arguments: { eventId: "event-1" }, id: "calendar-get-call", toolId: "calendar.get_event" },
    ] },
    { output: "Found Planning.", runId: "calendar-read", status: "completed" },
  ]);
  await page.goto("/");
  await page.getByRole("button", { name: "AI assistant" }).click();
  await sendAfterConsent(page, "What is on my calendar?");
  await expect.poll(() => page.evaluate(() => window.assistantNativeState.commands.filter((call) => call === "assistant_calendar_tool_execute").length)).toBe(3);
  await expect.poll(() => recorder.continueBodies.length).toBe(1);
  expect(recorder.continueBodies[0].toolResults).toEqual([
    { result: exactQueryResult, toolCallId: "calendar-query-call", toolId: "calendar.query" },
    { result: exactSearchResult, toolCallId: "calendar-search-call", toolId: "calendar.search" },
    { result: sanitizedEvent, toolCallId: "calendar-get-call", toolId: "calendar.get_event" },
  ]);
  await expect(page.getByRole("region", { name: "Assistant messages" })).toContainText("Found Planning.");
});

test("old calendar result shape is rejected before provider continuation", async ({ page }) => {
  await installAssistantNativeMock(page, {
    readResults: {
      "calendar.query": { complete: true, events: [{ id: "event-1", title: "Planning" }] },
    },
  });
  const recorder = await mockHarness(page, [{ runId: "old-shape", status: "requires_action", toolRequests: [{ arguments: { endDateExclusive: "2026-08-02", endUtcMs: 1_754_064_000_000, limit: 1, startDate: "2026-08-01", startUtcMs: 1_753_977_600_000 }, id: "old-shape-call", toolId: "calendar.query" }] }]);
  await page.goto("/");
  await page.getByRole("button", { name: "AI assistant" }).click();
  await sendAfterConsent(page, "Use the old shape");
  await expect(page.getByRole("alert")).toContainText("calendar.query result does not match its declared fields.");
  expect(recorder.continueBodies).toHaveLength(0);
});

for (const invalidCase of [
  {
    name: "fractional calendar instants",
    calls: [{ arguments: { endDateExclusive: "2026-08-02", endUtcMs: 1_754_064_000_000, limit: 1, startDate: "2026-08-01", startUtcMs: 1_753_977_600_000.5 }, id: "invalid-query", toolId: "calendar.query" }],
    message: "startUtcMs must be an integer.",
  },
  {
    name: "duplicate inferred fields",
    calls: [{ arguments: { event: { title: "Planning", notes: null, location: null, time: { temporalKind: "allDay", startDate: "2026-08-01", endDateExclusive: "2026-08-02" } }, inferredFields: ["title", "title"] }, id: "invalid-create", toolId: "calendar.create_event" }],
    message: "inferredFields must contain unique supported fields.",
  },
  {
    name: "overlong Note block IDs",
    calls: [{ arguments: { blockId: "b".repeat(201), content: "No mutation" }, id: "invalid-note", toolId: "notes.append_text" }],
    message: "blockId must be bounded text.",
  },
] as const) {
  test(`invalid batch rejects ${invalidCase.name} before side effects or continuation`, async ({ page }) => {
    await installAssistantNativeMock(page);
    const recorder = await mockHarness(page, [{ runId: "invalid-batch", status: "requires_action", toolRequests: invalidCase.calls }]);
    await openAssistantForExistingWorkspace(page);
    await sendAfterConsent(page, invalidCase.name);
    await expect(page.getByRole("alert")).toContainText(invalidCase.message);
    expect(recorder.continueBodies).toHaveLength(0);
    expect(await page.evaluate(() => window.assistantNativeState.commands.filter((command) => command.startsWith("assistant_calendar_") && !command.includes("_reconciliation_")).length)).toBe(0);
    await expect(page.locator(".text-block-display")).toHaveCount(0);
  });
}

for (const bodyCase of [
  { mode: "declared-too-large", message: "llama-harness response exceeded the 1 MiB safety limit." },
  { mode: "streamed-too-large", message: "llama-harness response exceeded the 1 MiB safety limit." },
  { mode: "invalid-json", message: "llama-harness returned invalid JSON." },
  { mode: "empty", message: "llama-harness returned an empty response body." },
] as const) {
  test(`provider ${bodyCase.mode} response fails closed before parsing, tools, or continuation`, async ({ page }) => {
    await installAssistantNativeMock(page);
    await installProviderBodyOverride(page, bodyCase.mode);
    const recorder = await mockHarness(page, [{ output: "must not be used", status: "completed" }]);
    await page.goto("/");
    await page.getByRole("button", { name: "AI assistant" }).click();
    await sendAfterConsent(page, bodyCase.mode);
    await expect(page.getByRole("alert")).toContainText(bodyCase.message);
    expect(await page.evaluate(() => window.providerBodyOverrideCalls)).toBe(1);
    expect(recorder.continueBodies).toHaveLength(0);
    expect(await page.evaluate(() => window.assistantNativeState.commands.filter((command) => command.startsWith("assistant_calendar_") && !command.includes("_reconciliation_")).length)).toBe(0);
  });
}

test("provider start uses a deterministic 120 second deadline", async ({ page }) => {
  await installAssistantNativeMock(page);
  const recorder = await mockHarness(page, [{ output: "late", status: "completed" }], { delaysMs: [500] });
  await openAssistantForExistingWorkspace(page);
  await page.clock.install();
  await sendAfterConsent(page, "Timeout provider start");
  await expect.poll(() => recorder.runBodies.length).toBe(1);
  await page.clock.fastForward(120_000);
  await expect(page.getByRole("alert")).toContainText("llama-harness request timed out after 120 seconds.");
  expect(recorder.continueBodies).toHaveLength(0);
});

test("provider continuation uses a deterministic 120 second deadline", async ({ page }) => {
  await installAssistantNativeMock(page);
  const recorder = await mockHarness(page, [
    { runId: "continue-timeout", status: "requires_action", toolRequests: [{ arguments: { eventId: "event-1" }, id: "get-call", toolId: "calendar.get_event" }] },
    { output: "late", status: "completed" },
  ], { delaysMs: [0, 500] });
  await page.goto("/");
  await page.getByRole("button", { name: "AI assistant" }).click();
  await page.clock.install();
  await sendAfterConsent(page, "Timeout provider continuation");
  await expect.poll(() => recorder.continueBodies.length).toBe(1);
  await page.clock.fastForward(120_000);
  await expect(page.getByRole("alert")).toContainText("llama-harness request timed out after 120 seconds.");
});

test("caller Cancel remains cancellation while a provider start is delayed", async ({ page }) => {
  await installAssistantNativeMock(page);
  const recorder = await mockHarness(page, [{ output: "late", status: "completed" }], { delaysMs: [500] });
  await page.goto("/");
  await page.getByRole("button", { name: "AI assistant" }).click();
  await page.clock.install();
  await sendAfterConsent(page, "Cancel provider start");
  await expect.poll(() => recorder.runBodies.length).toBe(1);
  const cancel = page.getByRole("button", { name: "Cancel", exact: true });
  await expect(cancel).toBeFocused();
  await cancel.click();
  await expect(page.locator(".assistant-status")).toContainText("Assistant request cancelled.");
  await page.clock.fastForward(120_001);
  await expect(page.getByRole("complementary", { name: "AI assistant" })).not.toContainText("timed out");
});

test("calendar read uses a deterministic 10 second tool deadline with no continuation", async ({ page }) => {
  await installAssistantNativeMock(page, { readPending: true });
  const recorder = await mockHarness(page, [{ runId: "read-timeout", status: "requires_action", toolRequests: [{ arguments: { eventId: "event-1" }, id: "get-call", toolId: "calendar.get_event" }] }]);
  await page.goto("/");
  await page.getByRole("button", { name: "AI assistant" }).click();
  await page.clock.install();
  await sendAfterConsent(page, "Timeout calendar read");
  await expect.poll(() => page.evaluate(() => window.assistantNativeState.commands.includes("assistant_calendar_tool_execute"))).toBe(true);
  await page.clock.fastForward(10_000);
  await expect(page.getByRole("alert")).toContainText("calendar.get_event read timed out after 10 seconds.");
  expect(recorder.continueBodies).toHaveLength(0);
});

test("calendar proposal uses a deterministic 120 second write deadline", async ({ page }) => {
  await installAssistantNativeMock(page, { proposalPending: true });
  const recorder = await mockHarness(page, [{ runId: "proposal-timeout", status: "requires_action", toolRequests: [{ arguments: { event: { title: "Planning", notes: null, location: null, time: { temporalKind: "allDay", startDate: "2026-08-01", endDateExclusive: "2026-08-02" } } }, id: "calendar-call", toolId: "calendar.create_event" }] }]);
  await page.goto("/");
  await page.getByRole("button", { name: "AI assistant" }).click();
  await page.clock.install();
  await sendAfterConsent(page, "Timeout calendar proposal");
  await expect.poll(() => page.evaluate(() => window.assistantNativeState.commands.includes("assistant_calendar_create_propose"))).toBe(true);
  await page.clock.fastForward(120_000);
  await expect(page.getByRole("alert")).toContainText("No calendar creation was requested, and no unreturned review authority can be used.");
  await expect(page.getByRole("region", { name: "Calendar event review" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Confirm/ })).toHaveCount(0);
  expect(await page.evaluate(() => window.assistantNativeState.commands.includes("assistant_calendar_create_confirm"))).toBe(false);
  expect(recorder.continueBodies).toHaveLength(0);
});

test("timed-out confirmation retains a locked review and reconciles the same private proposal", async ({ page }) => {
  const native = await installAssistantNativeMock(page, { confirmMode: "pending-then-replay" });
  const recorder = await mockHarness(page, [
    { runId: "phase4-run", status: "requires_action", toolRequests: [{ arguments: { event: { location: null, notes: null, time: { localEnd: "2026-08-01T10:30", localStart: "2026-08-01T10:00", temporalKind: "timed", timeZone: "America/Chicago" }, title: "Planning" } }, id: "calendar-call", toolId: "calendar.create_event" }] },
    { output: "Reconciled once.", runId: "phase4-run", status: "completed" },
  ]);
  await page.setViewportSize({ width: 800, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "AI assistant" }).click();
  await page.clock.install();
  await sendAfterConsent(page, "Create and reconcile Planning");
  const review = page.getByRole("region", { name: "Calendar event review" });
  await review.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => page.evaluate(() => window.assistantNativeState.confirmAttempts)).toBe(1);
  await page.clock.fastForward(120_000);
  await expect(review).toBeVisible();
  await expect(review).toContainText("Calendar confirmation timed out. The outcome is pending or unknown. Keep Note open and retry Confirm to reconcile this same proposal safely.");
  await expect(review).toContainText("Confirmation outcome pending; retry Confirm to reconcile");
  const retry = review.getByRole("button", { name: "Retry Confirm" });
  await expect(retry).toBeEnabled();
  await expect(review.getByRole("button", { name: "Edit details" })).toBeDisabled();
  await expect(review.getByRole("button", { name: "Cancel" })).toBeDisabled();

  await page.keyboard.press("Escape");
  await expect(review).toBeVisible();
  await page.locator(".assistant-close-button").click();
  await expect(review).toBeVisible();
  await page.locator(".is-assistant-backdrop").click({ force: true });
  await expect(review).toBeVisible();
  await page.evaluate(() => (document.querySelector('[aria-label="Expand sidebar"]') as HTMLButtonElement | null)?.click());
  await expect(review).toBeVisible();
  await expect(page.locator(".is-explorer-backdrop")).toHaveCount(0);

  await retry.click();
  await expect.poll(() => page.evaluate(() => window.assistantNativeState.confirmAttempts)).toBe(2);
  expect(await page.evaluate(() => window.assistantNativeState.sameConfirmToken)).toBe(true);
  expect(await page.evaluate(() => window.assistantNativeState.createEffects)).toBe(1);
  await expect.poll(() => recorder.continueBodies.length).toBe(1);
  expect(await page.evaluate(() => window.assistantNativeState.acknowledgementModes)).toEqual(["exact_created_outcome_received"]);
  expect(native.getReconciliationState()).toBe("clear");
  expect(recorder.continueBodies[0].toolResults).toEqual([{ toolCallId: "calendar-call", toolId: "calendar.create_event", result: { ...exactCreatedResult, replayed: true } }]);
  await expect(review).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Assistant messages" })).toContainText("Reconciled once.");
  await page.reload();
  await page.getByRole("button", { name: "AI assistant" }).click();
  await expect(page.getByRole("alert", { name: "Unresolved calendar confirmation" })).toHaveCount(0);
});

for (const layout of [
  { name: "compact", width: 1_000 },
  { name: "desktop", width: 1_440 },
] as const) {
  test(`pending confirmation blocks the ${layout.name} sidebar transition`, async ({ page }) => {
    const review = await openPendingConfirmationReview(page, layout.width);
    await page.evaluate(() => {
      const toggle = document.querySelector<HTMLButtonElement>('[aria-label="Expand sidebar"], [aria-label="Collapse sidebar"]');
      if (!toggle) throw new Error("Sidebar presentation toggle was not rendered.");
      toggle.click();
    });
    await expect(review).toBeVisible();
    await expect(review.getByRole("button", { name: "Retry Confirm" })).toBeEnabled();
    await expect(page.locator(".assistant-status")).toContainText("Confirmation outcome is pending or unknown.");
    await expect(page.locator(".is-explorer-backdrop")).toHaveCount(0);
  });
}

test("definitive native confirmation validation failure clears review and requires a new proposal", async ({ page }) => {
  await installAssistantNativeMock(page, { confirmMode: "error" });
  const recorder = await mockHarness(page, [{ runId: "phase4-run", status: "requires_action", toolRequests: [{ arguments: { event: { location: null, notes: null, time: { localEnd: "2026-08-01T10:30", localStart: "2026-08-01T10:00", temporalKind: "timed", timeZone: "America/Chicago" }, title: "Planning" } }, id: "calendar-call", toolId: "calendar.create_event" }] }]);
  await page.goto("/");
  await page.getByRole("button", { name: "AI assistant" }).click();
  await sendAfterConsent(page, "Fail confirmation terminally");
  const review = page.getByRole("region", { name: "Calendar event review" });
  await review.getByRole("button", { name: "Confirm" }).click();
  await expect(page.locator(".assistant-error")).toContainText("Calendar event was not created. Request a new proposal. Native confirmation rejected the reviewed title.");
  await expect(review).toHaveCount(0);
  expect(recorder.continueBodies).toHaveLength(0);
  await expect(page.getByRole("textbox", { name: "Assistant prompt" })).toBeFocused();
});

test("valid near-limit Note output continues and valid over-limit output is rejected first", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { AssistantRuntime } = await import("/src/features/assistant/AssistantRuntime.ts");
    const makeResult = (count: number) => ({
      page: { id: "page", folderId: "", title: "Boundary" },
      blocks: Array.from({ length: count }, (_, index) => ({ id: `block-${index}`, pageId: "page", content: "x".repeat(3600), x: index, y: index, width: 320, height: 80 })),
      completeness: { complete: true, omittedCount: 0, maximumBytes: 16_000 },
    });
    const run = async (toolResult: unknown) => {
      let continued = 0;
      const runtime = new AssistantRuntime(
        { start: async () => ({ runId: "boundary", status: "requires_action", toolRequests: [{ id: "read", toolId: "notes.read_page", arguments: { includeBlocks: true } }] }), continue: async () => { continued += 1; return { runId: "boundary", status: "completed", output: "ok", toolRequests: [] }; } },
        { provider: "test", model: "test", capabilities: { tools: true }, dataSharing: "local" },
        { read: async () => toolResult, write: async () => ({}), describeWrite: () => { throw new Error("not used"); }, fingerprintWrite: () => "not-used" },
      );
      try { await runtime.start(); return { continued, error: null }; }
      catch (error) { return { continued, error: error instanceof Error ? error.message : String(error) }; }
    };
    const near = makeResult(4);
    const over = makeResult(5);
    return { nearBytes: new TextEncoder().encode(JSON.stringify(near)).byteLength, overBytes: new TextEncoder().encode(JSON.stringify(over)).byteLength, near: await run(near), over: await run(over) };
  });
  expect(result.nearBytes).toBeLessThanOrEqual(NOTE_MAXIMUM_RESULT_BYTES);
  expect(result.nearBytes).toBeGreaterThan(14_000);
  expect(result.near).toEqual({ continued: 1, error: null });
  expect(result.overBytes).toBeGreaterThan(NOTE_MAXIMUM_RESULT_BYTES);
  expect(result.over.continued).toBe(0);
  expect(result.over.error).toContain("notes.read_page returned more data than its declared provider limit.");
});

test("maximal valid calendar query schema remains below its declared 128 KiB cap", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const registry = await import("/src/features/assistant/toolRegistry.ts");
    const tool = registry.assistantToolRegistry.find((candidate) => candidate.id === "calendar.query")!;
    const item = (index: number) => ({
      eventId: `e${index}`.padEnd(200, "e"), occurrenceKey: `o${index}`.padEnd(200, "o"), title: "t".repeat(200), notes: "n".repeat(500), location: "l".repeat(200),
      time: { temporalKind: "timed", startUtcMs: index, endUtcMs: index + 1, timeZone: "z".repeat(128) }, recurrenceRule: "r".repeat(512), reminderOffsetsMinutes: [0, 1, 2, 3, 50_400], revision: index, source: "local_calendar", truncatedFields: ["title", "notes", "location"],
    });
    const value = { items: Array.from({ length: 25 }, (_, index) => item(index)), completeness: "truncated", omittedCount: 1 };
    registry.validateAssistantToolResult(tool, value);
    return { bytes: new TextEncoder().encode(JSON.stringify(value)).byteLength, maximumBytes: tool.maximumResultBytes };
  });
  expect(result.maximumBytes).toBe(CALENDAR_MAXIMUM_RESULT_BYTES);
  expect(result.bytes).toBeLessThan(CALENDAR_MAXIMUM_RESULT_BYTES);
});

test("schema-valid multibyte calendar output over 128 KiB is rejected before continuation", async ({ page }) => {
  const wide = (count: number) => "界".repeat(count);
  const item = (index: number) => ({
    eventId: wide(200), occurrenceKey: wide(200), title: wide(200), notes: wide(500), location: wide(200),
    time: { temporalKind: "timed", startUtcMs: index, endUtcMs: index + 1, timeZone: wide(128) }, recurrenceRule: wide(512), reminderOffsetsMinutes: [0, 1, 2, 3, 50_400], revision: index, source: "local_calendar", truncatedFields: ["title", "notes", "location"],
  });
  const value = { items: Array.from({ length: 25 }, (_, index) => item(index)), completeness: "truncated", omittedCount: 1 };
  expect(new TextEncoder().encode(JSON.stringify(value)).byteLength).toBeGreaterThan(CALENDAR_MAXIMUM_RESULT_BYTES);
  await installAssistantNativeMock(page, { readResults: { "calendar.query": value } });
  const recorder = await mockHarness(page, [{ runId: "calendar-boundary", status: "requires_action", toolRequests: [{ id: "query", toolId: "calendar.query", arguments: { startUtcMs: 0, endUtcMs: 1, startDate: "2026-08-01", endDateExclusive: "2026-08-02", limit: 25 } }] }]);
  await page.goto("/");
  await page.getByRole("button", { name: "AI assistant" }).click();
  await sendAfterConsent(page, "Calendar multibyte boundary");
  await expect(page.getByRole("alert")).toContainText("calendar.query returned more data than its declared provider limit.");
  expect(recorder.continueBodies).toHaveLength(0);
});

test("unknown-provider disclosure names conditional bounded tool-result sharing", async ({ page }) => {
  await mockHarness(page, [{ output: "unused", status: "completed" }]);
  await openAssistant(page);
  await page.getByRole("textbox", { name: "Assistant prompt" }).fill("Read my calendar");
  await page.getByRole("button", { name: "Send prompt" }).click();
  await expect(page.getByRole("region", { name: "Assistant data sharing review" })).toContainText("Later bounded read-tool results for this whole run, sent to the provider for tool-result continuation: Note page, selection, and search text snippets and identifiers; calendar titles, times, locations, and event notes from query, search, or get_event");
});

test("Escape on a narrow pre-send disclosure keeps the panel open, cancels, and restores composer focus", async ({ page }) => {
  const recorder = await mockHarness(page, [{ output: "unused", status: "completed" }]);
  await page.setViewportSize({ width: 800, height: 800 });
  await openAssistant(page);
  const prompt = page.getByRole("textbox", { name: "Assistant prompt" });
  await prompt.fill("Keep this private");
  await page.getByRole("button", { name: "Send prompt" }).click();
  const consent = page.getByRole("region", { name: "Assistant data sharing review" });
  await expect(consent.getByRole("button", { name: "Send with this context" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(consent).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "AI assistant" })).toBeVisible();
  await expect(prompt).toHaveValue("Keep this private");
  await expect(prompt).toBeFocused();
  expect(recorder.runBodies).toHaveLength(0);
});

test("Escape on a narrow calendar review cancels it without closing the panel", async ({ page }) => {
  await installAssistantNativeMock(page);
  const recorder = await mockHarness(page, [
    { runId: "phase4-run", status: "requires_action", toolRequests: [{ arguments: { event: { location: null, notes: null, time: { localEnd: "2026-08-01T10:30", localStart: "2026-08-01T10:00", temporalKind: "timed", timeZone: "America/Chicago" }, title: "Planning" } }, id: "calendar-call", toolId: "calendar.create_event" }] },
    { output: "Cancelled follow-up.", runId: "phase4-run", status: "completed" },
  ]);
  await page.setViewportSize({ width: 800, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "AI assistant" }).click();
  await sendAfterConsent(page, "Create planning event");
  await expect(page.getByRole("region", { name: "Calendar event review" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("region", { name: "Calendar event review" })).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "AI assistant" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.assistantNativeState.commands.filter((call) => call === "assistant_calendar_create_cancel").length)).toBe(1);
  await expect.poll(() => recorder.continueBodies.length).toBe(1);
  expect(recorder.continueBodies[0].toolResults).toEqual([{ toolCallId: "calendar-call", toolId: "calendar.create_event", result: exactCancelledResult }]);
});

for (const cancellationCase of [
  { kind: "read", outcome: "late resolve", native: { readDelayMs: 1_000 }, advanceMs: 1_001, command: "assistant_calendar_tool_execute", tool: { arguments: { eventId: "event-1" }, id: "cancel-read", toolId: "calendar.get_event" } },
  { kind: "read", outcome: "late reject", native: { readDelayMs: 1_000, readReject: true }, advanceMs: 1_001, command: "assistant_calendar_tool_execute", tool: { arguments: { eventId: "event-1" }, id: "cancel-read", toolId: "calendar.get_event" } },
  { kind: "read", outcome: "late timeout", native: { readPending: true }, advanceMs: 10_001, command: "assistant_calendar_tool_execute", tool: { arguments: { eventId: "event-1" }, id: "cancel-read", toolId: "calendar.get_event" } },
  { kind: "proposal", outcome: "late resolve", native: { proposalDelayMs: 1_000 }, advanceMs: 1_001, command: "assistant_calendar_create_propose", tool: calendarCreateRequest("cancel-proposal") },
  { kind: "proposal", outcome: "late reject", native: { proposalDelayMs: 1_000, proposalReject: true }, advanceMs: 1_001, command: "assistant_calendar_create_propose", tool: calendarCreateRequest("cancel-proposal") },
  { kind: "proposal", outcome: "late timeout", native: { proposalPending: true }, advanceMs: 120_001, command: "assistant_calendar_create_propose", tool: calendarCreateRequest("cancel-proposal") },
] as const) {
  test(`cancelled ${cancellationCase.kind} remains cancelled after ${cancellationCase.outcome}`, async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await installAssistantNativeMock(page, cancellationCase.native);
    const recorder = await mockHarness(page, [{ runId: `cancel-${cancellationCase.kind}`, status: "requires_action", toolRequests: [cancellationCase.tool] }]);
    await openAssistantForExistingWorkspace(page);
    await page.clock.install();
    const prompt = `Cancel ${cancellationCase.kind} ${cancellationCase.outcome}`;
    await sendAfterConsent(page, prompt);
    await expect.poll(() => page.evaluate((command) => window.assistantNativeState.commands.includes(command), cancellationCase.command)).toBe(true);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.locator(".assistant-status")).toContainText("Assistant request cancelled.");
    await page.clock.fastForward(cancellationCase.advanceMs);
    await expect(page.locator(".assistant-status")).toContainText("Assistant request cancelled.");
    await expect(page.locator(".assistant-error")).toHaveCount(0);
    await expect(page.getByRole("region", { name: /calendar event review|note change review/i })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Assistant prompt" })).toHaveValue(prompt);
    expect(recorder.continueBodies).toHaveLength(0);
    expect(pageErrors).toEqual([]);
  });
}

test("revision timeout discards uncertain authority without a confirm path", async ({ page }) => {
  await installAssistantNativeMock(page, { revisePending: true });
  const recorder = await mockHarness(page, [{ runId: "revise-timeout", status: "requires_action", toolRequests: [calendarCreateRequest()] }]);
  await page.goto("/");
  await page.getByRole("button", { name: "AI assistant" }).click();
  await page.clock.install();
  await sendAfterConsent(page, "Revise and lose the proposal safely");
  const review = page.getByRole("region", { name: "Calendar event review" });
  await review.getByRole("button", { name: "Edit details" }).click();
  await review.getByLabel("Title").fill("Revised planning");
  await review.getByRole("button", { name: "Save details for review" }).click();
  await expect.poll(() => page.evaluate(() => window.assistantNativeState.commands.includes("assistant_calendar_create_revise"))).toBe(true);
  await page.clock.fastForward(120_000);
  await expect(page.locator(".assistant-error")).toContainText("No calendar creation was requested, and no uncertain review authority can be used.");
  await expect(page.locator(".assistant-status")).toContainText("discarded without creating an event");
  await expect(review).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Confirm/ })).toHaveCount(0);
  expect(await page.evaluate(() => window.assistantNativeState.commands.includes("assistant_calendar_create_confirm"))).toBe(false);
  expect(recorder.continueBodies).toHaveLength(0);
});

test("expired confirmation replay becomes unresolved and locks new creates until inspection and acknowledgement", async ({ page }) => {
  await installAssistantNativeMock(page, { confirmMode: "pending-then-unavailable" });
  const recorder = await mockHarness(page, [
    { runId: "unresolved-first", status: "requires_action", toolRequests: [calendarCreateRequest("unresolved-first-call")] },
    { runId: "blocked-before-agenda", status: "requires_action", toolRequests: [calendarCreateRequest("blocked-before-agenda-call")] },
    { runId: "blocked-before-ack", status: "requires_action", toolRequests: [calendarCreateRequest("blocked-before-ack-call")] },
    { runId: "allowed-after-ack", status: "requires_action", toolRequests: [calendarCreateRequest("allowed-after-ack-call")] },
  ]);
  await page.setViewportSize({ width: 800, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "AI assistant" }).click();
  await page.clock.install();
  await sendAfterConsent(page, "Create Planning, then reconcile it");
  const review = page.getByRole("region", { name: "Calendar event review" });
  await review.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => page.evaluate(() => window.assistantNativeState.confirmAttempts)).toBe(1);
  await page.clock.fastForward(120_000);
  await review.getByRole("button", { name: "Retry Confirm" }).click();

  const unresolved = page.getByRole("alert", { name: "Unresolved calendar confirmation" });
  await expect(unresolved).toBeVisible();
  await expect(unresolved).toContainText("The event may already exist");
  await expect(page.getByRole("complementary", { name: "AI assistant" })).not.toContainText(/not created/i);
  await expect(review).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Confirm/ })).toHaveCount(0);
  expect(await page.evaluate(() => window.assistantNativeState.createEffects)).toBe(1);
  expect(await page.evaluate(() => window.assistantNativeState.sameConfirmToken)).toBe(true);
  expect(recorder.continueBodies).toHaveLength(0);

  const openAgenda = unresolved.getByRole("button", { name: "Open Agenda" });
  const acknowledge = unresolved.getByRole("button", { name: "I checked; unlock creates" });
  await expect(openAgenda).toBeFocused();
  await expect(acknowledge).toBeDisabled();
  for (const control of [openAgenda, acknowledge]) {
    const box = await control.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }

  await sendAfterConsent(page, "Try a duplicate before Agenda");
  await expect(page.locator(".assistant-error")).toContainText("locked until you inspect Agenda and acknowledge");
  expect(await page.evaluate(() => window.assistantNativeState.proposalAttempts)).toBe(1);

  await openAgenda.press("Enter");
  await expect(page.getByRole("complementary", { name: "AI assistant" })).toHaveCount(0);
  await page.getByRole("button", { name: "AI assistant" }).click();
  const reopenedWarning = page.getByRole("alert", { name: "Unresolved calendar confirmation" });
  await expect(reopenedWarning.getByRole("button", { name: "I checked; unlock creates" })).toBeEnabled();
  await sendAfterConsent(page, "Try a duplicate before acknowledgement");
  await expect(page.locator(".assistant-error")).toContainText("locked until you inspect Agenda and acknowledge");
  expect(await page.evaluate(() => window.assistantNativeState.proposalAttempts)).toBe(1);

  const unlockedButton = reopenedWarning.getByRole("button", { name: "I checked; unlock creates" });
  await unlockedButton.focus();
  await unlockedButton.press("Enter");
  await expect(reopenedWarning).toHaveCount(0);
  await page.getByRole("textbox", { name: "Assistant prompt" }).fill("Create only after explicit acknowledgement");
  await page.getByRole("button", { name: "Send prompt" }).click();
  await page.getByRole("region", { name: "Assistant data sharing review" }).getByRole("button", { name: "Send with this context" }).click();
  await expect(page.getByRole("region", { name: "Calendar event review" })).toBeVisible();
  expect(await page.evaluate(() => window.assistantNativeState.proposalAttempts)).toBe(2);
});

test("durable startup reconciliation survives reload and status hydration precedes every allowed proposal", async ({ page }) => {
  const native = await installAssistantNativeMock(page, { reconciliationState: "reconciliation_required" });
  const recorder = await mockHarness(page, [
    { runId: "blocked-after-reload", status: "requires_action", toolRequests: [calendarCreateRequest()] },
    { runId: "blocked-after-agenda", status: "requires_action", toolRequests: [calendarCreateRequest()] },
    { runId: "allowed-after-native-ack", status: "requires_action", toolRequests: [calendarCreateRequest()] },
  ]);
  await page.setViewportSize({ width: 800, height: 800 });
  await page.goto("/");
  await expect.poll(() => native.commands.filter((command) => command === "assistant_calendar_create_reconciliation_status").length).toBeGreaterThan(0);
  const initialStatusChecks = native.commands.filter((command) => command === "assistant_calendar_create_reconciliation_status").length;
  await page.reload();
  await expect.poll(() => native.commands.filter((command) => command === "assistant_calendar_create_reconciliation_status").length).toBeGreaterThan(initialStatusChecks);
  await page.getByRole("button", { name: "AI assistant" }).click();

  let warning = page.getByRole("alert", { name: "Unresolved calendar confirmation" });
  await expect(warning).toContainText("The event may already exist");
  await expect(warning.getByRole("button", { name: "I checked; unlock creates" })).toBeDisabled();
  await sendAfterConsent(page, "Blocked before inspecting the durable warning");
  await expect(page.locator(".assistant-error")).toContainText("locked until you inspect Agenda and acknowledge");
  expect(native.commands.filter((command) => command === "assistant_calendar_create_propose")).toHaveLength(0);

  await warning.getByRole("button", { name: "Open Agenda" }).click();
  await page.getByRole("button", { name: "AI assistant" }).click();
  warning = page.getByRole("alert", { name: "Unresolved calendar confirmation" });
  await expect(warning.getByRole("button", { name: "I checked; unlock creates" })).toBeEnabled();
  await sendAfterConsent(page, "Still blocked after opening Agenda alone");
  await expect(page.locator(".assistant-error")).toContainText("locked until you inspect Agenda and acknowledge");
  expect(native.commands.filter((command) => command === "assistant_calendar_create_propose")).toHaveLength(0);

  await warning.getByRole("button", { name: "I checked; unlock creates" }).click();
  await expect(warning).toHaveCount(0);
  expect(native.getReconciliationState()).toBe("clear");
  expect(native.commands.filter((command) => command === "assistant_calendar_create_reconciliation_acknowledge")).toHaveLength(1);
  await sendAfterConsent(page, "Allowed only after durable acknowledgement");
  await expect(page.getByRole("region", { name: "Calendar event review" })).toBeVisible();
  expect(native.commands.filter((command) => command === "assistant_calendar_create_propose")).toHaveLength(1);
  expect(native.commands.indexOf("assistant_calendar_create_reconciliation_status")).toBeLessThan(native.commands.indexOf("assistant_calendar_create_propose"));
  expect(recorder.continueBodies).toHaveLength(0);
});

test("loading reconciliation status visibly locks calendar creation before native proposal", async ({ page }) => {
  const native = await installAssistantNativeMock(page, { statusSteps: ["pending", "pending"] });
  await mockHarness(page, [{ runId: "loading-lock", status: "requires_action", toolRequests: [calendarCreateRequest()] }]);
  const assistant = await openAssistantForExistingWorkspace(page);
  const loadingStatus = assistant.getByRole("status", { name: "Calendar creation status" });
  await expect(loadingStatus).toContainText("Calendar creation stays locked until the native status check completes.");
  const composer = page.getByRole("textbox", { name: "Assistant prompt" });
  await composer.focus();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(composer).toBeFocused();
  await expect(loadingStatus).toBeVisible();
  await sendAfterConsent(page, "Do not create while reconciliation status is loading");
  await expect(page.locator(".assistant-error")).toContainText("locked until you inspect Agenda and acknowledge");
  expect(native.commands.filter((command) => command === "assistant_calendar_create_propose")).toHaveLength(0);
});

test("keyboard Retry announces authoritative clear and moves focus to the durable composer", async ({ page }) => {
  await installAssistantNativeMock(page, { statusSteps: ["reject", "reject", "clear"] });
  await mockHarness(page, [{ output: "unused", status: "completed" }]);
  await openAssistantForExistingWorkspace(page);
  const warning = page.getByRole("alert", { name: "Unresolved calendar confirmation" });
  const retry = warning.getByRole("button", { name: "Retry status" });
  await retry.focus();
  await retry.press("Enter");

  await expect(warning).toHaveCount(0);
  await expect(page.locator(".assistant-status")).toHaveText("Calendar status verified; creation unlocked");
  await expect(page.getByRole("textbox", { name: "Assistant prompt" })).toBeFocused();
});

for (const retryFailure of ["reject", "invalid"] as const) {
  test(`keyboard Retry ${retryFailure} before Agenda inspection restores Retry focus`, async ({ page }) => {
    await installAssistantNativeMock(page, { statusSteps: ["reject", "reject", retryFailure] });
    await mockHarness(page, [{ output: "unused", status: "completed" }]);
    await openAssistantForExistingWorkspace(page);
    const warning = page.getByRole("alert", { name: "Unresolved calendar confirmation" });
    const retry = warning.getByRole("button", { name: "Retry status" });
    await retry.focus();
    await retry.press("Enter");

    await expect(warning).toContainText("Creation remains locked");
    await expect(retry).toBeEnabled();
    await expect(retry).toBeFocused();
    await expect(page.locator(".assistant-status")).toHaveText("Calendar status check failed; creation remains locked.");
  });
}

test("compact warning remount chooses safe focus and inspected Retry failure returns to acknowledgement", async ({ page }) => {
  await installAssistantNativeMock(page, { statusSteps: ["reject", "reject", "reject"] });
  await mockHarness(page, [{ output: "unused", status: "completed" }]);
  await page.setViewportSize({ width: 800, height: 800 });
  await openAssistantForExistingWorkspace(page);
  await page.locator(".assistant-close-button").click();
  await expect(page.getByRole("complementary", { name: "AI assistant" })).toHaveCount(0);
  await page.getByRole("button", { name: "AI assistant" }).click();
  let warning = page.getByRole("alert", { name: "Unresolved calendar confirmation" });
  const openAgenda = warning.getByRole("button", { name: "Open Agenda" });
  await expect(openAgenda).toBeFocused();
  await openAgenda.press("Enter");
  await expect(page.getByRole("complementary", { name: "AI assistant" })).toHaveCount(0);

  await page.getByRole("button", { name: "AI assistant" }).click();
  warning = page.getByRole("alert", { name: "Unresolved calendar confirmation" });
  const acknowledge = warning.getByRole("button", { name: "I checked; unlock creates" });
  await expect(acknowledge).toBeEnabled();
  await expect(acknowledge).toBeFocused();
  const retry = warning.getByRole("button", { name: "Retry status" });
  await retry.focus();
  await retry.press("Enter");

  await expect(warning).toContainText("Creation remains locked");
  await expect(acknowledge).toBeEnabled();
  await expect(acknowledge).toBeFocused();
});

test("failed native acknowledgement restores focus to the enabled acknowledgement", async ({ page }) => {
  await installAssistantNativeMock(page, { acknowledgementMode: "reject", reconciliationState: "reconciliation_required" });
  await mockHarness(page, [{ output: "unused", status: "completed" }]);
  await page.setViewportSize({ width: 800, height: 800 });
  await openAssistantForExistingWorkspace(page);
  let warning = page.getByRole("alert", { name: "Unresolved calendar confirmation" });
  await warning.getByRole("button", { name: "Open Agenda" }).press("Enter");
  await page.getByRole("button", { name: "AI assistant" }).click();
  warning = page.getByRole("alert", { name: "Unresolved calendar confirmation" });
  const acknowledge = warning.getByRole("button", { name: "I checked; unlock creates" });
  await acknowledge.press("Enter");

  await expect(warning).toContainText("Could not clear the calendar creation lock");
  await expect(acknowledge).toBeEnabled();
  await expect(acknowledge).toBeFocused();
});

for (const statusFailure of ["reject", "invalid"] as const) {
  test(`${statusFailure} reconciliation status stays locked until Retry obtains authoritative clear`, async ({ page }) => {
    const native = await installAssistantNativeMock(page, { statusSteps: [statusFailure, statusFailure, "clear"] });
    await mockHarness(page, [
      { runId: `${statusFailure}-blocked`, status: "requires_action", toolRequests: [calendarCreateRequest()] },
      { runId: `${statusFailure}-recovered`, status: "requires_action", toolRequests: [calendarCreateRequest()] },
    ]);
    await openAssistantForExistingWorkspace(page);
    const warning = page.getByRole("alert", { name: "Unresolved calendar confirmation" });
    await expect(warning).toContainText("Creation remains locked");
    await sendAfterConsent(page, `Block create after ${statusFailure} status`);
    await expect(page.locator(".assistant-error")).toContainText("locked until you inspect Agenda and acknowledge");
    expect(native.commands.filter((command) => command === "assistant_calendar_create_propose")).toHaveLength(0);

    await warning.getByRole("button", { name: "Retry status" }).click();
    await expect(warning).toHaveCount(0);
    await sendAfterConsent(page, `Create after ${statusFailure} status recovers`);
    await expect(page.getByRole("region", { name: "Calendar event review" })).toBeVisible();
    expect(native.commands.filter((command) => command === "assistant_calendar_create_propose")).toHaveLength(1);
  });
}

test("browser mode blocks calendar create as native-only while Note-only assistant writes still work", async ({ page }) => {
  const recorder = await mockHarness(page, [
    { runId: "browser-calendar", status: "requires_action", toolRequests: [calendarCreateRequest()] },
    { runId: "browser-note", status: "requires_action", toolRequests: [{ arguments: { content: "Browser Note write", x: 100, y: 120 }, id: "browser-note-call", toolId: "notes.insert_text" }] },
    { output: "Browser Note write complete.", runId: "browser-note", status: "completed" },
  ]);
  await openAssistant(page);
  const warning = page.getByRole("alert", { name: "Unresolved calendar confirmation" });
  await expect(warning).toContainText("Calendar creation is available only in the native Note app.");
  await expect(warning.getByRole("button", { name: "Retry status" })).toHaveCount(0);

  await sendAfterConsent(page, "Attempt browser calendar create");
  await expect(page.locator(".assistant-error")).toContainText("locked until you inspect Agenda and acknowledge");
  expect(recorder.continueBodies).toHaveLength(0);
  await sendAfterConsent(page, "Apply a Note-only assistant write");
  const noteReview = page.getByRole("region", { name: "Note change review" });
  await expect(noteReview).toContainText("Browser Note write");
  await noteReview.getByRole("button", { name: "Confirm" }).click();
  await expect(page.locator(".text-block-display")).toContainText("Browser Note write");
  await expect.poll(() => recorder.continueBodies.length).toBe(1);
  await expect(page.getByRole("region", { name: "Assistant messages" })).toContainText("Browser Note write complete.");
});

test("lost confirmation response leaves a durable marker that relocks creation after reload", async ({ page }) => {
  const native = await installAssistantNativeMock(page, { confirmMode: "create-and-hang" });
  const recorder = await mockHarness(page, [{ runId: "lost-response", status: "requires_action", toolRequests: [calendarCreateRequest()] }]);
  await openAssistantForExistingWorkspace(page);
  await sendAfterConsent(page, "Create before a simulated renderer crash");
  const review = page.getByRole("region", { name: "Calendar event review" });
  await review.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => native.getReconciliationState()).toBe("reconciliation_required");
  expect(recorder.continueBodies).toHaveLength(0);

  await page.reload();
  await page.getByRole("button", { name: "AI assistant" }).click();
  await expect(page.getByRole("alert", { name: "Unresolved calendar confirmation" })).toContainText("The event may already exist");
  await sendAfterConsent(page, "Do not duplicate the event after reload");
  await expect(page.locator(".assistant-error")).toContainText("locked until you inspect Agenda and acknowledge");
  expect(native.commands.filter((command) => command === "assistant_calendar_create_propose")).toHaveLength(1);
  expect(recorder.continueBodies).toHaveLength(0);
});

for (const acknowledgementMode of ["reject", "invalid"] as const) {
  test(`created event with ${acknowledgementMode} exact-receipt acknowledgement never continues and remains locked after reload`, async ({ page }) => {
    const native = await installAssistantNativeMock(page, { acknowledgementMode });
    const recorder = await mockHarness(page, [
      { runId: `ack-${acknowledgementMode}`, status: "requires_action", toolRequests: [calendarCreateRequest()] },
      { output: "must not continue", runId: `ack-${acknowledgementMode}`, status: "completed" },
    ]);
    await openAssistantForExistingWorkspace(page);
    await sendAfterConsent(page, `Create with ${acknowledgementMode} acknowledgement`);
    const review = page.getByRole("region", { name: "Calendar event review" });
    await review.getByRole("button", { name: "Confirm" }).click();
    await expect(page.locator(".assistant-status")).toContainText("Calendar event created; reconciliation acknowledgement failed. Calendar creation remains locked.");
    await expect(review).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Confirm/ })).toHaveCount(0);
    expect(recorder.continueBodies).toHaveLength(0);
    expect(native.getReconciliationState()).toBe("reconciliation_required");
    expect(native.commands.filter((command) => command === "assistant_calendar_create_reconciliation_acknowledge")).toHaveLength(1);

    await page.reload();
    await page.getByRole("button", { name: "AI assistant" }).click();
    await expect(page.getByRole("alert", { name: "Unresolved calendar confirmation" })).toContainText("The event may already exist");
    expect(recorder.continueBodies).toHaveLength(0);
  });
}

test("authoritative clear with acknowledged false preserves confirm-ack-continuation ordering", async ({ page }) => {
  const order: string[] = [];
  const native = await installAssistantNativeMock(page, { acknowledgementMode: "clear-unacknowledged", order });
  const recorder = await mockHarness(page, [
    { runId: "idempotent-clear", status: "requires_action", toolRequests: [calendarCreateRequest()] },
    { output: "Created exactly once.", runId: "idempotent-clear", status: "completed" },
  ], { order });
  await openAssistantForExistingWorkspace(page);
  await sendAfterConsent(page, "Create with idempotent clear acknowledgement");
  await page.getByRole("region", { name: "Calendar event review" }).getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => recorder.continueBodies.length).toBe(1);
  expect(await page.evaluate(() => window.assistantNativeState.acknowledgementModes)).toEqual(["exact_created_outcome_received"]);
  expect(native.getReconciliationState()).toBe("clear");
  const orderedBoundary = order.filter((entry) => [
    "native:assistant_calendar_create_confirm",
    "native:assistant_calendar_create_reconciliation_acknowledge",
    "provider:continue",
  ].includes(entry));
  expect(orderedBoundary).toEqual([
    "native:assistant_calendar_create_confirm",
    "native:assistant_calendar_create_reconciliation_acknowledge",
    "provider:continue",
  ]);
  expect(order.indexOf("native:assistant_calendar_create_reconciliation_status")).toBeLessThan(order.indexOf("native:assistant_calendar_create_propose"));

  await page.reload();
  await page.getByRole("button", { name: "AI assistant" }).click();
  await expect(page.getByRole("alert", { name: "Unresolved calendar confirmation" })).toHaveCount(0);
});

test("an older delayed clear status cannot overwrite a newer Agenda-inspected lock mutation", async ({ page }) => {
  const native = await installAssistantNativeMock(page, {
    reconciliationState: "reconciliation_required",
    statusSteps: ["reject", "reject", { delayMs: 500, state: "clear" }],
  });
  await mockHarness(page, [{ output: "unused", status: "completed" }]);
  await openAssistantForExistingWorkspace(page);
  let warning = page.getByRole("alert", { name: "Unresolved calendar confirmation" });
  await warning.getByRole("button", { name: "Retry status" }).click();
  await expect(warning.getByRole("button", { name: "Open Agenda" })).toBeDisabled();
  await page.getByRole("navigation", { name: "Primary workspace tools" }).getByRole("button", { name: "Open Agenda" }).click();
  await page.waitForTimeout(650);
  warning = page.getByRole("alert", { name: "Unresolved calendar confirmation" });
  await expect(warning).toBeVisible();
  await expect(warning.getByRole("button", { name: "I checked; unlock creates" })).toBeEnabled();
  expect(native.getReconciliationState()).toBe("reconciliation_required");
});

test("programmatic cancellation after confirmation dispatch is terminally unresolved", async ({ page }) => {
  await installAssistantNativeMock(page, { confirmMode: "pending-then-unavailable" });
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { AssistantRuntime } = await import("/src/features/assistant/AssistantRuntime.ts");
    const runtime = new AssistantRuntime(
      {
        start: async () => ({
          runId: "programmatic-cancel",
          status: "requires_action",
          toolRequests: [{
            id: "calendar-call",
            toolId: "calendar.create_event",
            arguments: {
              event: {
                title: "Planning",
                notes: null,
                location: null,
                time: {
                  temporalKind: "timed",
                  localStart: "2026-08-01T10:00",
                  localEnd: "2026-08-01T10:30",
                  timeZone: "America/Chicago",
                },
              },
            },
          }],
        }),
        continue: async () => ({ runId: "programmatic-cancel", status: "completed", output: "must not continue", toolRequests: [] }),
      },
      { provider: "test", model: "test", capabilities: { tools: true }, dataSharing: "local" },
      {
        read: async () => ({}),
        write: async () => ({}),
        describeWrite: () => { throw new Error("not used"); },
        fingerprintWrite: () => "not-used",
        canProposeCalendarCreate: () => true,
      },
    );
    await runtime.start();
    const confirmation = runtime.confirm().then(
      () => ({ code: null, message: null }),
      (error: unknown) => ({ code: error && typeof error === "object" && "code" in error ? String(error.code) : null, message: error instanceof Error ? error.message : String(error) }),
    );
    for (let attempt = 0; attempt < 20 && window.assistantNativeState.confirmAttempts === 0; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
    runtime.cancel();
    return confirmation;
  });
  expect(result.code).toBe("calendar_confirm_outcome_unresolved");
  expect(result.message).toContain("may already exist");
  expect(result.message).not.toMatch(/not created/i);
  expect(await page.evaluate(() => window.assistantNativeState.confirmAttempts)).toBe(1);
});

test("remote consent binds the exact prompt, agent, history, and Note context across background changes", async ({ page }) => {
  const agents = [
    { description: "Primary Playwright assistant", id: "test-agent", name: "Test agent" },
    { description: "Alternate Playwright assistant", id: "agent-beta", name: "Beta agent" },
  ] as const;
  const recorder = await mockHarness(page, [
    { output: "Seed answer.", runId: "seed-run", status: "completed" },
    { agentId: "agent-beta", runId: "consent-bound-run", status: "requires_action", toolRequests: [{ arguments: { includeBlocks: true }, id: "consent-read", toolId: "notes.read_page" }] },
    { agentId: "agent-beta", output: "Bound continuation complete.", runId: "consent-bound-run", status: "completed" },
  ], { agents });
  await openAssistant(page);
  await sendAfterConsent(page, "Seed context");
  await expect(page.getByRole("region", { name: "Assistant messages" })).toContainText("Seed answer.");
  const originalContext = recorder.runBodies[0].context;

  const agentSelect = page.getByRole("combobox", { name: "Assistant agent" });
  await agentSelect.selectOption("agent-beta");
  const prompt = "Use the exact disclosed beta-agent snapshot";
  const composer = page.getByRole("textbox", { name: "Assistant prompt" });
  await composer.fill(prompt);
  await page.getByRole("button", { name: "Send prompt" }).click();
  const consent = page.getByRole("region", { name: "Assistant data sharing review" });
  await expect(consent).toContainText(`Beta agent (agent-beta)`);
  await expect(consent).toContainText(prompt);
  await expect(consent).toContainText("This request goes through local llama-harness.");
  await expect(consent).toContainText("Its reported upstream routing label is local llama-harness; reported upstream mock, using reported model test-model (test-model).");
  await expect(consent).toContainText("Note cannot independently verify the upstream provider identity or routing.");
  await expect(consent).toContainText("Processing location is unknown");
  await expect(composer).toBeDisabled();
  await expect(agentSelect).toBeDisabled();
  await expect(page.getByRole("button", { name: "Refresh" })).toBeDisabled();
  const outputActions = page.getByRole("region", { name: "Assistant output actions" }).getByRole("button");
  expect(await outputActions.count()).toBeGreaterThan(0);
  for (let index = 0; index < await outputActions.count(); index += 1) {
    await expect(outputActions.nth(index)).toBeDisabled();
  }
  expect(recorder.runBodies).toHaveLength(1);

  const canvas = page.locator(".canvas");
  const canvasBounds = await canvas.boundingBox();
  if (!canvasBounds) throw new Error("Canvas bounds were not available for the background context mutation.");
  await page.mouse.click(canvasBounds.x + 320, canvasBounds.y + 240);
  await page.keyboard.press("x");
  const backgroundEditor = page.locator(".text-block-editor-content");
  await expect(backgroundEditor).toBeFocused();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText("Background context changed after disclosure");
  await expect(backgroundEditor).toContainText("Background context changed after disclosure");
  await page.evaluate(() => {
    const select = document.querySelector<HTMLSelectElement>('[aria-label="Assistant agent"]');
    if (!select) throw new Error("Assistant agent selector is unavailable.");
    select.value = "test-agent";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(consent).toContainText(`Beta agent (agent-beta)`);
  await consent.getByRole("button", { name: "Send with this context" }).click();
  await expect.poll(() => recorder.runBodies.length).toBe(2);
  await expect.poll(() => recorder.continueBodies.length).toBe(1);
  await expect(page.getByRole("region", { name: "Assistant messages" })).toContainText("Bound continuation complete.");

  const boundBody = recorder.runBodies[1];
  expect(boundBody.agentId).toBe("agent-beta");
  expect(boundBody.context).toEqual(originalContext);
  expect(boundBody.messages).toEqual([
    { content: "Seed context", role: "user" },
    { content: "Seed answer.", role: "assistant" },
    { content: prompt, role: "user" },
  ]);
  expect(recorder.continueBodies[0]).toMatchObject({ appId: "note" });
});

test("Keep private sends nothing and restores the exact prompt and focus", async ({ page }) => {
  const recorder = await mockHarness(page, [{ output: "must not be sent", status: "completed" }]);
  await openAssistant(page);
  const prompt = page.getByRole("textbox", { name: "Assistant prompt" });
  await prompt.fill("Keep this exact prompt private");
  await page.getByRole("button", { name: "Send prompt" }).click();
  const consent = page.getByRole("region", { name: "Assistant data sharing review" });
  await consent.getByRole("button", { name: "Keep private" }).click();
  await expect(consent).toHaveCount(0);
  await expect(prompt).toHaveValue("Keep this exact prompt private");
  await expect(prompt).toBeFocused();
  expect(recorder.runBodies).toHaveLength(0);
  expect(recorder.continueBodies).toHaveLength(0);
});

test("wrong initial model ID fails closed and restores the exact prompt for fresh consent", async ({ page }) => {
  await installAssistantNativeMock(page);
  const recorder = await mockHarness(page, [{ rawResponse: validRunEnvelope({ modelId: "unreviewed-model" }) }]);
  await openAssistantForExistingWorkspace(page);
  const promptText = "Reject an unreviewed initial model identity";
  const composer = page.getByRole("textbox", { name: "Assistant prompt" });
  await composer.fill(promptText);
  await page.getByRole("button", { name: "Send prompt" }).click();
  const consent = page.getByRole("region", { name: "Assistant data sharing review" });
  await expect(consent).toContainText("local llama-harness");
  await expect(consent).toContainText("test-model (test-model)");
  await expect(consent).toContainText("Note cannot independently verify the upstream provider identity or routing.");
  await consent.getByRole("button", { name: "Send with this context" }).click();

  await expect(page.locator(".assistant-error")).toContainText("modelId does not match the reviewed model");
  await expect(composer).toHaveValue(promptText);
  await expect(page.getByRole("region", { name: "Assistant messages" })).not.toContainText("Done.");
  expect(recorder.runBodies).toHaveLength(1);
  expect(recorder.continueBodies).toHaveLength(0);
  expect(await page.evaluate(() => window.assistantNativeState.commands.filter((command) => command === "assistant_calendar_tool_execute" || command === "assistant_calendar_create_propose").length)).toBe(0);

  await page.getByRole("button", { name: "Send prompt" }).click();
  const freshConsent = page.getByRole("region", { name: "Assistant data sharing review" });
  await expect(freshConsent).toContainText(promptText);
  await expect(freshConsent).toContainText("test-model (test-model)");
  expect(recorder.runBodies).toHaveLength(1);
});

test("wrong continuation model ID fails closed without another tool or synthetic completion", async ({ page }) => {
  await installAssistantNativeMock(page);
  const recorder = await mockHarness(page, [
    { runId: "wrong-continuation-model", status: "requires_action", toolRequests: [{ arguments: { eventId: "event-1" }, id: "model-bound-read", toolId: "calendar.get_event" }] },
    { rawResponse: validRunEnvelope({ modelId: "unreviewed-model", runId: "wrong-continuation-model" }) },
  ]);
  await openAssistantForExistingWorkspace(page);
  const promptText = "Reject a continuation from another model";
  await sendAfterConsent(page, promptText);

  await expect(page.locator(".assistant-error")).toContainText("modelId does not match the reviewed model");
  await expect(page.getByRole("textbox", { name: "Assistant prompt" })).toHaveValue(promptText);
  await expect(page.getByRole("region", { name: "Assistant messages" })).not.toContainText("Done.");
  expect(recorder.runBodies).toHaveLength(1);
  expect(recorder.continueBodies).toHaveLength(1);
  expect(await page.evaluate(() => window.assistantNativeState.commands.filter((command) => command === "assistant_calendar_tool_execute").length)).toBe(1);
  expect(await page.evaluate(() => window.assistantNativeState.commands.filter((command) => command === "assistant_calendar_create_propose").length)).toBe(0);
});

test("completion status keeps the reviewed agent and model snapshot after live agent selection changes", async ({ page }) => {
  const agents = [
    { description: "Primary Playwright assistant", id: "test-agent", name: "Test agent" },
    { description: "Alternate Playwright assistant", id: "agent-beta", name: "Beta agent" },
  ] as const;
  const recorder = await mockHarness(page, [
    { agentId: "agent-beta", runId: "phase4-run", status: "requires_action", toolRequests: [calendarCreateRequest()] },
    { agentId: "agent-beta", output: "Snapshotted completion.", runId: "phase4-run", status: "completed" },
  ], { agents });
  await installAssistantNativeMock(page);
  await openAssistantForExistingWorkspace(page);
  const agentSelect = page.getByRole("combobox", { name: "Assistant agent" });
  await agentSelect.selectOption("agent-beta");
  await sendAfterConsent(page, "Create with the beta snapshot");
  const review = page.getByRole("region", { name: "Calendar event review" });
  await agentSelect.selectOption("test-agent");
  await review.getByRole("button", { name: "Confirm" }).click();

  await expect.poll(() => recorder.continueBodies.length).toBe(1);
  await expect(page.locator(".assistant-status")).toContainText("Received response from Beta agent / test-model");
  await expect(page.locator(".assistant-status")).not.toContainText("Test agent / test-model");
  await expect(page.getByRole("region", { name: "Assistant messages" })).toContainText("Snapshotted completion.");
});

for (const recoveryCase of [
  {
    name: "provider-envelope failure",
    failedRun: { rawResponse: validRunEnvelope({ status: undefined }) },
    expectedError: "invalid run envelope",
  },
  {
    name: "pre-review validation failure",
    failedRun: { runId: "invalid-pre-review", status: "requires_action" as const, toolRequests: [{ arguments: { content: 7 }, id: "invalid-write", toolId: "notes.insert_text" }] },
    expectedError: "content must be bounded text",
  },
] as const) {
  test(`${recoveryCase.name} restores one prompt without duplicating conversation history`, async ({ page }) => {
    const recorder = await mockHarness(page, [
      { output: "Preserved seed answer.", runId: "recovery-seed", status: "completed" },
      recoveryCase.failedRun,
    ]);
    await openAssistant(page);
    await sendAfterConsent(page, "Preserved seed prompt");
    await expect(page.getByRole("region", { name: "Assistant messages" })).toContainText("Preserved seed answer.");
    const failedPrompt = `Restore after ${recoveryCase.name}`;
    await sendAfterConsent(page, failedPrompt);
    await expect(page.locator(".assistant-error")).toContainText(recoveryCase.expectedError);
    const composer = page.getByRole("textbox", { name: "Assistant prompt" });
    await expect(composer).toHaveValue(failedPrompt);
    await expect(page.locator(".assistant-message-user")).toHaveCount(1);
    await expect(page.getByRole("region", { name: "Assistant messages" })).not.toContainText(failedPrompt);
    expect(recorder.runBodies).toHaveLength(2);
    expect(recorder.runBodies[1].messages).toEqual([
      { content: "Preserved seed prompt", role: "user" },
      { content: "Preserved seed answer.", role: "assistant" },
      { content: failedPrompt, role: "user" },
    ]);

    await page.getByRole("button", { name: "Send prompt" }).click();
    const freshConsent = page.getByRole("region", { name: "Assistant data sharing review" });
    await expect(freshConsent).toContainText(failedPrompt);
    expect(recorder.runBodies).toHaveLength(2);
    await freshConsent.getByRole("button", { name: "Keep private" }).click();
    await expect(composer).toHaveValue(failedPrompt);
    await expect(composer).toBeFocused();
    expect(recorder.runBodies).toHaveLength(2);
  });
}

const strictToolRequest = providerToolRequest({
  arguments: { eventId: "event-1" },
  id: "strict-call",
  toolId: "calendar.get_event",
});

for (const malformed of [
  { name: "missing status", response: validRunEnvelope({ status: undefined }) },
  { name: "unknown status", response: validRunEnvelope({ status: "waiting" }) },
  { name: "missing run ID", response: validRunEnvelope({ runId: undefined }) },
  { name: "blank run ID", response: validRunEnvelope({ runId: " " }) },
  { name: "non-text agent ID", response: validRunEnvelope({ agentId: 7 }) },
  { name: "wrong app ID", response: validRunEnvelope({ appId: "calendar" }) },
  { name: "unexpected top-level field", response: validRunEnvelope({ secret: "must fail closed" }) },
  {
    name: "unexpected tool field",
    response: validRunEnvelope({ status: "requires_action", toolRequests: [{ ...strictToolRequest, secret: "must fail closed" }] }),
  },
  {
    name: "duplicate tool-call IDs",
    response: validRunEnvelope({ status: "requires_action", toolRequests: [strictToolRequest, { ...strictToolRequest, toolId: "calendar.search" }] }),
  },
  {
    name: "more than eight tool calls",
    response: validRunEnvelope({ status: "requires_action", toolRequests: Array.from({ length: 9 }, (_, index) => ({ ...strictToolRequest, id: `strict-${index}` })) }),
  },
  {
    name: "null tool arguments",
    response: validRunEnvelope({ status: "requires_action", toolRequests: [{ ...strictToolRequest, arguments: null }] }),
  },
  {
    name: "array tool arguments",
    response: validRunEnvelope({ status: "requires_action", toolRequests: [{ ...strictToolRequest, arguments: [] }] }),
  },
  {
    name: "oversized tool arguments",
    response: validRunEnvelope({ status: "requires_action", toolRequests: [{ ...strictToolRequest, arguments: { eventId: "x".repeat(128 * 1024) } }] }),
  },
  {
    name: "unsupported risk level",
    response: validRunEnvelope({ status: "requires_action", toolRequests: [{ ...strictToolRequest, riskLevel: "critical" }] }),
  },
  {
    name: "blank tool name",
    response: validRunEnvelope({ status: "requires_action", toolRequests: [{ ...strictToolRequest, name: "" }] }),
  },
  {
    name: "non-text display name",
    response: validRunEnvelope({ status: "requires_action", toolRequests: [{ ...strictToolRequest, displayName: 42 }] }),
  },
  {
    name: "completed status with tools",
    response: validRunEnvelope({ status: "completed", toolRequests: [strictToolRequest] }),
  },
  {
    name: "requires-action status without tools",
    response: validRunEnvelope({ status: "requires_action", toolRequests: [] }),
  },
] as const) {
  test(`strict provider envelope rejects ${malformed.name} before native dispatch`, async ({ page }) => {
    await installAssistantNativeMock(page);
    const recorder = await mockHarness(page, [{ rawResponse: malformed.response }]);
    await openAssistantForExistingWorkspace(page);
    await sendAfterConsent(page, `Reject ${malformed.name}`);
    await expect(page.locator(".assistant-error")).toContainText("invalid run envelope");
    expect(recorder.runBodies).toHaveLength(1);
    expect(recorder.continueBodies).toHaveLength(0);
    expect(await page.evaluate(() => window.assistantNativeState.commands.filter((command) => command.startsWith("assistant_calendar_") && !command.includes("_reconciliation_")).length)).toBe(0);
    await expect(page.getByRole("region", { name: "Assistant messages" })).not.toContainText("Done.");
  });
}

for (const mismatch of [
  { name: "run ID", continuation: validRunEnvelope({ runId: "different-run", agentId: "test-agent" }) },
  { name: "agent ID", continuation: validRunEnvelope({ runId: "bound-run", agentId: "different-agent" }) },
] as const) {
  test(`provider continuation cannot change the bound ${mismatch.name}`, async ({ page }) => {
    await installAssistantNativeMock(page);
    const recorder = await mockHarness(page, [
      { runId: "bound-run", status: "requires_action", toolRequests: [{ arguments: { eventId: "event-1" }, id: "bound-call", toolId: "calendar.get_event" }] },
      { rawResponse: mismatch.continuation },
    ]);
    await page.goto("/");
    await page.getByRole("button", { name: "AI assistant" }).click();
    await sendAfterConsent(page, `Reject continuation ${mismatch.name}`);
    await expect(page.locator(".assistant-error")).toContainText("invalid run envelope");
    expect(recorder.continueBodies).toHaveLength(1);
    expect(await page.evaluate(() => window.assistantNativeState.commands.filter((command) => command === "assistant_calendar_tool_execute").length)).toBe(1);
    await expect(page.getByRole("region", { name: "Assistant messages" })).not.toContainText("Done.");
  });
}

test("a valid strict envelope may use empty output", async ({ page }) => {
  await mockHarness(page, [{ output: "", status: "completed" }]);
  await openAssistant(page);
  await sendAfterConsent(page, "Accept bounded empty output");
  await expect(page.getByRole("region", { name: "Assistant messages" })).toContainText("Done.");
  await expect(page.locator(".assistant-error")).toHaveCount(0);
});

declare global {
  interface Window {
    assistantNativeState: {
      acknowledgementModes: string[];
      commands: string[];
      confirmAttempts: number;
      createEffects: number;
      proposalAttempts: number;
      reconciliationStatusChecks: number;
      sameConfirmToken: boolean;
    };
    __phase4NativeBridge: (action: string, payload?: Record<string, unknown>) => Promise<unknown>;
    providerBodyOverrideCalls: number;
    __TAURI_INTERNALS__: {
      invoke: (command: string, body?: Record<string, unknown>) => Promise<unknown>;
      metadata: { currentWindow: { label: string } };
    };
    isTauri: boolean;
  }
}
