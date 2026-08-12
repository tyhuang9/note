import { expect, test, type Page } from "@playwright/test";

test("voice assistant proposal pre-fills without sending or taking focus", async ({
  page,
}) => {
  await installVoiceProposalMock(page);
  await page.goto("/");
  await waitForVoiceProposalListener(page);

  await page.getByRole("button", { name: "Dark mode" }).focus();
  await emitVoiceProposal(page, {
    mode: "assistant_command",
    proposalId: "11111111-1111-4111-8111-111111111111",
    source: "voice",
    text: "Summarize the selected note",
  });

  await expect(page.getByRole("textbox", { name: "Assistant prompt" })).toHaveValue(
    "Summarize the selected note",
  );
  await expect(page.getByRole("status", { name: "Voice proposal ready for review" })).toContainText(
    "Nothing was sent automatically",
  );
  await expect(page.getByRole("status", { name: "Voice proposal ready for review" })).toContainText(
    "Summarize the selected note",
  );
  await expect(page.getByRole("button", { name: "Dark mode" })).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.voiceProposalMock.chatCalls)).toBe(0);
});

test("voice note proposals remain visible, non-mutating, and ignore replays", async ({
  page,
}) => {
  await installVoiceProposalMock(page);
  await page.goto("/");
  await waitForVoiceProposalListener(page);
  const savesBeforeProposal = await page.evaluate(() => window.voiceProposalMock.saveCalls);

  const proposalId = "22222222-2222-4222-8222-222222222222";
  await emitVoiceProposal(page, {
    mode: "note_dictation",
    proposalId,
    source: "typed",
    text: "Draft this for the current page",
  });

  const review = page.getByRole("status", { name: "Voice proposal ready for review" });
  await expect(review).toContainText("Draft this for the current page");
  await expect(review).toContainText("No note was changed");
  await expect.poll(() => page.evaluate(() => window.voiceProposalMock.saveCalls)).toBe(savesBeforeProposal);

  await emitVoiceProposal(page, {
    mode: "note_dictation",
    proposalId,
    source: "typed",
    text: "This replay must be ignored",
  });
  await expect(review).toContainText("Draft this for the current page");
  await expect(review).not.toContainText("This replay must be ignored");

  await emitVoiceProposal(page, {
    extra: true,
    mode: "quick_capture",
    proposalId: "33333333-3333-4333-8333-333333333333",
    source: "voice",
    text: "Malformed payload is ignored",
  });
  await expect(review).not.toContainText("Malformed payload is ignored");
});

async function waitForVoiceProposalListener(page: Page) {
  await expect.poll(() => page.evaluate(() => window.voiceProposalMock.listenerReady)).toBe(true);
}

async function emitVoiceProposal(page: Page, payload: Record<string, unknown>) {
  await page.evaluate((eventPayload) => window.voiceProposalMock.emit(eventPayload), payload);
}

async function installVoiceProposalMock(page: Page) {
  await page.addInitScript(() => {
    const callbacks = new Map<number, (event: { payload: unknown }) => void>();
    const listeners = new Map<string, number>();
    let callbackId = 0;
    let saveCalls = 0;
    let chatCalls = 0;
    const modelsAIState = {
      defaultChatModelId: "ollama-local:test-model",
      legacyMigrationCompleted: true,
      models: [
        {
          capabilities: { chat: true, embeddings: false, speechToText: false, streaming: false, vision: false },
          dataSharing: "local",
          executionMode: "chat_only",
          id: "ollama-local:test-model",
          license: { name: "test" },
          managedRemoval: "not_supported",
          name: "Test model",
          ownedByNote: false,
          platforms: [],
          providerId: "ollama-local",
          runtimeName: "test-model",
          structuredToolSupport: "unsupported",
        },
      ],
      providers: [
        {
          baseUrl: "http://127.0.0.1:11434",
          capabilities: { chat: true, embeddings: false, speechToText: false },
          credentialConfigured: false,
          dataSharing: "local",
          enabled: true,
          id: "ollama-local",
          kind: "ollama",
          managed: true,
          name: "Ollama",
        },
      ],
      revision: 1,
      schemaVersion: 1,
    };

    window.isTauri = true;
    window.voiceProposalMock = {
      chatCalls: 0,
      emit: (payload: unknown) => callbacks.get(listeners.get("note://voice-proposal") ?? -1)?.({ payload }),
      listenerReady: false,
      saveCalls: 0,
    };
    window.__TAURI_INTERNALS__ = {
      invoke: async (command: string, body?: Record<string, unknown>) => {
        if (command === "plugin:event|listen") {
          const event = body?.event;
          const handler = body?.handler;
          if (event === "note://voice-proposal" && typeof handler === "number") {
            listeners.set(event, handler);
            window.voiceProposalMock.listenerReady = true;
          }
          return 1;
        }
        if (command === "plugin:event|unlisten") return undefined;
        if (command === "models_ai_state_get") return modelsAIState;
        if (command === "load_app_data") {
          return {
            blocks: [],
            folders: [],
            pages: [{ folderId: "", id: "page-1", title: "Current page" }],
            sessionState: {
              selectedWorkspaceTabId: "note:page-1",
              workspaceTabs: [{ id: "note:page-1", title: "Current page", view: { kind: "note", pageId: "page-1" } }],
            },
          };
        }
        if (command === "save_app_data") {
          saveCalls += 1;
          window.voiceProposalMock.saveCalls = saveCalls;
          return undefined;
        }
        if (command === "assistant_calendar_create_reconciliation_status") return { state: "clear" };
        if (command === "models_ai_chat") {
          chatCalls += 1;
          window.voiceProposalMock.chatCalls = chatCalls;
          return { content: "not sent by this test", executionMode: "chat_only", modelId: "ollama-local:test-model", providerId: "ollama-local" };
        }
        throw new Error(`Unexpected command: ${command}`);
      },
      metadata: { currentWindow: { label: "main" } },
      transformCallback: (callback: (event: { payload: unknown }) => void) => {
        callbackId += 1;
        callbacks.set(callbackId, callback);
        return callbackId;
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: (_event: string, id: number) => callbacks.delete(id),
    };
  });
}

declare global {
  interface Window {
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: (event: string, id: number) => void };
    __TAURI_INTERNALS__: {
      invoke: (command: string, body?: Record<string, unknown>) => Promise<unknown>;
      metadata: { currentWindow: { label: string } };
      transformCallback: (callback: (event: { payload: unknown }) => void) => number;
    };
    isTauri: boolean;
    voiceProposalMock: {
      chatCalls: number;
      emit: (payload: unknown) => void;
      listenerReady: boolean;
      saveCalls: number;
    };
  }
}
