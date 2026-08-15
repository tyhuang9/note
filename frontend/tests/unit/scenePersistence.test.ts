import { describe, expect, it } from "vitest";
import type { TextElement } from "../../src/canvas/model/elements";
import { SceneChangeQueue } from "../../src/canvas/persistence/sceneChangeQueue";
import {
  assetDataUrl,
  assetRequestFromDataUrl,
  createSceneRepository,
  type Invoke,
  type SceneChangeBatch,
} from "../../src/canvas/persistence/sceneRepository";

function text(id: string, content = id): TextElement {
  return {
    content,
    createdAt: 1,
    height: 20,
    id,
    locked: false,
    opacity: 1,
    pageId: "page",
    rotation: 0,
    type: "text",
    updatedAt: 1,
    width: 20,
    x: 0,
    y: 0,
    zIndex: 0,
  };
}

describe("scene repository", () => {
  it("maps every SQLite command through one typed Tauri boundary", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const invoke: Invoke = async (command, args) => {
      calls.push({ command, args });
      if (command === "initialize_storage") return { warnings: [] } as never;
      if (command === "load_workspace_data") return { elements: [], folders: [], pages: [], warnings: [] } as never;
      if (command === "reconcile_workspace_structure") return { pages: [] } as never;
      if (command === "apply_scene_changes") return { pageId: "page", newRevision: 1 } as never;
      if (command === "save_asset") return { id: "asset", fileName: "image.png", mediaType: "image/png", byteSize: 1 } as never;
      if (command === "load_asset") return { id: "asset", fileName: "image.png", mediaType: "image/png", byteSize: 1, dataBase64: "AA==" } as never;
      return undefined as never;
    };
    const repository = createSceneRepository(invoke);

    await repository.initializeStorage();
    await repository.loadWorkspace();
    await repository.reconcileWorkspaceStructure({ folders: [], pages: [], isDarkMode: true });
    await repository.applySceneChanges({ pageId: "page", baseRevision: 0, upserts: [text("element")], deletedElementIds: [] });
    await repository.saveAsset({ dataBase64: "AA==", mediaType: "image/png" });
    await repository.loadAsset("asset");
    await repository.saveSessionState({ selectedPageId: "page" });

    expect(calls.map((call) => call.command)).toEqual([
      "initialize_storage",
      "load_workspace_data",
      "reconcile_workspace_structure",
      "apply_scene_changes",
      "save_asset",
      "load_asset",
      "save_session_state",
    ]);
    expect(calls[3].args).toEqual(expect.objectContaining({ batch: expect.objectContaining({ baseRevision: 0 }) }));
  });

  it("maps standalone data URLs while rejecting non-base64 input", () => {
    expect(assetRequestFromDataUrl("data:image/PNG;base64,AA==", { fileName: "pixel.png" })).toEqual({
      dataBase64: "AA==",
      mediaType: "image/png",
      fileName: "pixel.png",
    });
    expect(assetDataUrl({ id: "asset", fileName: "pixel.png", mediaType: "image/png", byteSize: 1, dataBase64: "AA==" })).toBe("data:image/png;base64,AA==");
    expect(() => assetRequestFromDataUrl("https://example.com/image.png")).toThrow("base64 data URL");
  });
});

describe("scene change queue", () => {
  it("serializes same-page writes and advances revisions in order", async () => {
    const batches: SceneChangeBatch[] = [];
    let resolveFirst: ((value: { pageId: string; newRevision: number }) => void) | undefined;
    const queue = new SceneChangeQueue((batch) => {
      batches.push(batch);
      if (batches.length === 1) {
        return new Promise((resolve) => { resolveFirst = resolve; });
      }
      return Promise.resolve({ pageId: batch.pageId, newRevision: batch.baseRevision + 1 });
    });
    queue.seed("page", 4, [text("one", "initial")]);

    const first = queue.replacePage("page", [text("one", "first")]);
    const second = queue.replacePage("page", [text("one", "second"), text("two")]);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ baseRevision: 4, upserts: [{ content: "first" }] });
    resolveFirst?.({ pageId: "page", newRevision: 5 });
    await Promise.all([first, second]);

    expect(batches).toHaveLength(2);
    expect(batches[1]).toMatchObject({
      baseRevision: 5,
      upserts: expect.arrayContaining([expect.objectContaining({ content: "second" }), expect.objectContaining({ id: "two" })]),
    });
  });

  it("retains in-memory changes and reports a failed write until retried", async () => {
    let shouldFail = true;
    const states: string[] = [];
    const queue = new SceneChangeQueue(
      async (batch) => {
        if (shouldFail) throw new Error("disk full");
        return { pageId: batch.pageId, newRevision: batch.baseRevision + 1 };
      },
      (_pageId, state) => states.push(state.kind),
    );
    queue.seed("page", 0, []);

    await expect(queue.replacePage("page", [text("one")])).rejects.toThrow("disk full");
    expect(states).toContain("failed");
    shouldFail = false;
    await queue.retry("page");
    expect(states[states.length - 1]).toBe("saved");
  });
});
