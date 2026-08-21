import { describe, expect, it } from "vitest";
import type { ConnectorElement, ShapeElement, TextElement } from "../../src/canvas/model/elements";
import { SceneChangeQueue } from "../../src/canvas/persistence/sceneChangeQueue";
import {
  assetDataUrl,
  assetRequestFromDataUrl,
  createSceneRepository,
  isAssetBlobWithinLimit,
  MAX_ASSET_BYTES,
  normalizeLoadedCanvasElement,
  type Invoke,
  type SceneChangeBatch,
} from "../../src/canvas/persistence/sceneRepository";
import { MAX_CANVAS_VALUE } from "../../src/canvas/model/connectorBinding";

function text(id: string, content = id): TextElement {
  return {
    backgroundMode: "surface",
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
  it("normalizes missing and invalid legacy text background modes to surface", () => {
    const legacy = { ...text("legacy"), backgroundMode: undefined } as unknown as TextElement;
    const invalid = { ...text("invalid"), backgroundMode: "gradient" } as unknown as TextElement;
    expect(normalizeLoadedCanvasElement(legacy)).toMatchObject({ backgroundMode: "surface" });
    expect(normalizeLoadedCanvasElement(invalid)).toMatchObject({ backgroundMode: "surface" });
    expect(normalizeLoadedCanvasElement({ ...text("transparent"), backgroundMode: "transparent" })).toMatchObject({ backgroundMode: "transparent" });
  });

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

  it("normalizes missing legacy primitive style fields at the load boundary", async () => {
    const invoke: Invoke = async () => ({
      elements: [
        {
          createdAt: 1,
          height: 40,
          id: "legacy-shape",
          locked: false,
          opacity: 1,
          pageId: "page",
          rotation: 0,
          shape: "rectangle",
          type: "shape",
          updatedAt: 1,
          width: 60,
          x: 10,
          y: 20,
          zIndex: 0,
        },
        {
          createdAt: 1,
          end: { kind: "free", x: 80, y: 80 },
          id: "legacy-connector",
          locked: false,
          opacity: 1,
          pageId: "page",
          routing: "straight",
          start: { kind: "free", x: 20, y: 20 },
          style: { strokeWidth: 4 },
          type: "connector",
          updatedAt: 1,
          zIndex: 1,
        },
      ],
      folders: [],
      pages: [],
      warnings: [],
    }) as never;

    const workspace = await createSceneRepository(invoke).loadWorkspace();
    expect(workspace.elements[0]).toMatchObject({
      style: {
        fillColor: null,
        roughness: 1.2,
        roundness: 0,
        strokeColor: { kind: "theme", token: "foreground" },
        strokeStyle: "solid",
        strokeWidth: 2,
      },
    });
    expect(workspace.elements[1]).toMatchObject({
      style: {
        endArrowhead: "none",
        startArrowhead: "none",
        strokeStyle: "solid",
        strokeWidth: 4,
      },
    });
    const repeatedWorkspace = await createSceneRepository(invoke).loadWorkspace();
    expect((repeatedWorkspace.elements[0] as ShapeElement).style.seed).toBe(
      (workspace.elements[0] as ShapeElement).style.seed,
    );
    expect(workspace.elements[0]).not.toHaveProperty("text");
  });

  it("matches the backend asset-size limit before FileReader allocation", () => {
    expect(isAssetBlobWithinLimit({ size: MAX_ASSET_BYTES })).toBe(true);
    expect(isAssetBlobWithinLimit({ size: MAX_ASSET_BYTES + 1 })).toBe(false);
    const oversizedBase64 = "A".repeat(Math.ceil((MAX_ASSET_BYTES + 1) / 3) * 4);
    expect(() => assetRequestFromDataUrl(`data:image/png;base64,${oversizedBase64}`)).toThrow("16 MiB");
  });

  it("preserves bound connector endpoints through load normalization", async () => {
    const rectangle: ShapeElement = {
      createdAt: 1,
      height: 60,
      id: "rectangle",
      locked: false,
      opacity: 1,
      pageId: "page",
      rotation: 0,
      shape: "rectangle",
      style: {
        fillColor: null,
        roughness: 1,
        roundness: 0,
        seed: 1,
        strokeColor: { kind: "theme", token: "foreground" },
        strokeStyle: "solid",
        strokeWidth: 2,
      },
      type: "shape",
      updatedAt: 1,
      width: 100,
      x: 10,
      y: 20,
      zIndex: 0,
    };
    const boundConnector: ConnectorElement = {
      createdAt: 1,
      end: { kind: "free", x: 180, y: 60 },
      id: "bound-arrow",
      locked: false,
      opacity: 1,
      pageId: "page",
      routing: "straight",
      start: { kind: "element", targetElementId: "rectangle", anchor: { t: 0.25 }, gap: 6 },
      style: {
        endArrowhead: "arrow",
        fillColor: null,
        roughness: 1,
        roundness: 0,
        seed: 1,
        startArrowhead: "none",
        strokeColor: { kind: "theme", token: "foreground" },
        strokeStyle: "solid",
        strokeWidth: 2,
      },
      type: "connector",
      updatedAt: 1,
      zIndex: 1,
    };
    const sameTargetLegacyConnector: ConnectorElement = {
      ...boundConnector,
      id: "same-target-legacy-arrow",
      start: { kind: "element", targetElementId: "rectangle", anchor: { t: 0.25 }, gap: 0 },
      end: { kind: "element", targetElementId: "rectangle", anchor: { t: 0.75 }, gap: 0 },
    };
    const calls: string[] = [];
    const invoke: Invoke = async (command) => {
      calls.push(command);
      if (command === "load_workspace_data") {
        return { elements: [rectangle, boundConnector, sameTargetLegacyConnector], folders: [], pages: [], warnings: [] } as never;
      }
      return undefined as never;
    };

    const elements = (await createSceneRepository(invoke).loadWorkspace()).elements;
    const loaded = elements.find(
      (element): element is ConnectorElement => element.id === boundConnector.id,
    );
    expect(loaded).toMatchObject({
      start: { kind: "element", targetElementId: "rectangle", gap: 6 },
      style: { endArrowhead: "arrow" },
    });
    expect(loaded?.start).not.toHaveProperty("anchor");
    expect(elements.find((element) => element.id === sameTargetLegacyConnector.id)).toMatchObject({
      start: { kind: "free", x: 110, y: 50 },
      end: { kind: "free", x: 10, y: 50 },
    });
    expect(calls).toEqual(["load_workspace_data"]);
  });

  it("normalizes malformed bindings and unsafe coordinates to safe free endpoints", async () => {
    const rectangle: ShapeElement = {
      createdAt: 1,
      height: 60,
      id: "rectangle",
      locked: false,
      opacity: 1,
      pageId: "page",
      rotation: 0,
      shape: "rectangle",
      style: {
        fillColor: null,
        roughness: 1,
        roundness: 0,
        seed: 1,
        strokeColor: { kind: "theme", token: "foreground" },
        strokeStyle: "solid",
        strokeWidth: 2,
      },
      type: "shape",
      updatedAt: 1,
      width: 100,
      x: 10,
      y: 20,
      zIndex: 0,
    };
    const arrow = (
      id: string,
      start: ConnectorElement["start"],
      endArrowhead: "none" | "arrow" = "arrow",
    ): ConnectorElement => ({
      createdAt: 1,
      end: { kind: "free", x: 180, y: 60 },
      id,
      locked: false,
      opacity: 1,
      pageId: "page",
      routing: "straight",
      start,
      style: {
        endArrowhead,
        fillColor: null,
        roughness: 1,
        roundness: 0,
        seed: 1,
        startArrowhead: "none",
        strokeColor: { kind: "theme", token: "foreground" },
        strokeStyle: "solid",
        strokeWidth: 2,
      },
      type: "connector",
      updatedAt: 1,
      zIndex: 1,
    });
    const bound = (targetElementId: string, gap = 0): ConnectorElement["start"] => (
      { kind: "element", targetElementId, anchor: { t: 0.25 }, gap }
    );
    const foreignRectangle = { ...rectangle, id: "foreign-rectangle", pageId: "other-page" };
    const unsafeRectangle = { ...rectangle, id: "unsafe-rectangle", x: MAX_CANVAS_VALUE + 1 };
    const unsafeRotationRectangle = { ...rectangle, id: "unsafe-rotation", rotation: 361 };
    const overshootRectangle = {
      ...rectangle,
      id: "overshoot-rectangle",
      width: 1,
      x: MAX_CANVAS_VALUE - 1,
    };
    const invoke: Invoke = async (command) => {
      if (command !== "load_workspace_data") return undefined as never;
      return {
        elements: [
          rectangle,
          foreignRectangle,
          unsafeRectangle,
          unsafeRotationRectangle,
          overshootRectangle,
          text("text-target"),
          arrow("missing", bound("missing")),
          arrow("nonshape", bound("text-target")),
          arrow("cross-page", bound("foreign-rectangle")),
          arrow("unsafe-shape", bound("unsafe-rectangle")),
          arrow("group", { kind: "group", targetGroupId: "group", anchor: { t: 0.25 }, gap: 0 }),
          arrow("connector", { kind: "connector", targetConnectorId: "missing", pathT: 0.25, gap: 0 }),
          arrow("large-free", { kind: "free", x: MAX_CANVAS_VALUE + 1, y: 0 }),
          arrow("large-gap", bound("rectangle", MAX_CANVAS_VALUE + 1)),
          arrow("anchor-extra", {
            kind: "element",
            targetElementId: "rectangle",
            anchor: { t: 0.25, side: "right" },
            gap: 0,
          } as unknown as ConnectorElement["start"]),
          arrow("resolved-overshoot", bound("overshoot-rectangle", MAX_CANVAS_VALUE)),
          arrow("line", bound("rectangle"), "none"),
          arrow("null", null as unknown as ConnectorElement["start"]),
          arrow("undefined", undefined as unknown as ConnectorElement["start"]),
          arrow("string", "endpoint" as unknown as ConnectorElement["start"]),
          arrow("number", 42 as unknown as ConnectorElement["start"]),
        ],
        folders: [],
        pages: [],
        warnings: [],
      } as never;
    };

    const loaded = await createSceneRepository(invoke).loadWorkspace();
    const connectorById = Object.fromEntries(
      loaded.elements
        .filter((element): element is ConnectorElement => element.type === "connector")
        .map((element) => [element.id, element]),
    );
    expect(loaded.elements.some((element) => element.id === "unsafe-rectangle")).toBe(false);
    expect(loaded.elements.some((element) => element.id === "unsafe-rotation")).toBe(false);
    for (const id of ["missing", "unsafe-shape", "group", "connector", "large-free", "large-gap", "anchor-extra", "resolved-overshoot", "null", "undefined", "string", "number"]) {
      expect(connectorById[id].start).toEqual({ kind: "free", x: 0, y: 0 });
    }
    expect(connectorById.nonshape.start).toEqual({ kind: "element", targetElementId: "text-target", gap: 0 });
    expect(connectorById["cross-page"].start).toEqual({ kind: "free", x: 0, y: 0 });
    expect(connectorById.line.start).toEqual({ kind: "free", x: 112, y: 60 });
  });

  it("persists a normalized overshooting legacy binding while deleting its target", async () => {
    const target: ShapeElement = {
      createdAt: 1,
      height: 60,
      id: "overshoot-target",
      locked: false,
      opacity: 1,
      pageId: "page",
      rotation: 0,
      shape: "rectangle",
      style: {
        fillColor: null,
        roughness: 1,
        roundness: 0,
        seed: 1,
        strokeColor: { kind: "theme", token: "foreground" },
        strokeStyle: "solid",
        strokeWidth: 2,
      },
      type: "shape",
      updatedAt: 1,
      width: 1,
      x: MAX_CANVAS_VALUE - 1,
      y: 20,
      zIndex: 0,
    };
    const connector: ConnectorElement = {
      createdAt: 1,
      end: { kind: "free", x: 0, y: 0 },
      id: "legacy-arrow",
      locked: false,
      opacity: 1,
      pageId: "page",
      routing: "straight",
      start: {
        kind: "element",
        targetElementId: target.id,
        anchor: { t: 0.25 },
        gap: MAX_CANVAS_VALUE,
      },
      style: {
        endArrowhead: "arrow",
        fillColor: null,
        roughness: 1,
        roundness: 0,
        seed: 1,
        startArrowhead: "none",
        strokeColor: { kind: "theme", token: "foreground" },
        strokeStyle: "solid",
        strokeWidth: 2,
      },
      type: "connector",
      updatedAt: 1,
      zIndex: 1,
    };
    let savedBatch: SceneChangeBatch | undefined;
    const invoke: Invoke = async (command, args) => {
      if (command === "load_workspace_data") {
        return {
          elements: [target, connector],
          folders: [],
          pages: [{ id: "page", revision: 4 }],
          warnings: [],
        } as never;
      }
      if (command === "apply_scene_changes") {
        savedBatch = args?.batch as SceneChangeBatch;
        return { pageId: "page", newRevision: 5 } as never;
      }
      return undefined as never;
    };
    const repository = createSceneRepository(invoke);
    const workspace = await repository.loadWorkspace();
    const normalized = workspace.elements.find(
      (element): element is ConnectorElement => element.id === connector.id,
    );
    expect(normalized?.start).toEqual({ kind: "free", x: 0, y: 0 });
    if (!normalized) throw new Error("Expected normalized legacy connector");

    await repository.applySceneChanges({
      pageId: "page",
      baseRevision: 4,
      upserts: [normalized],
      deletedElementIds: [target.id],
    });

    expect(savedBatch).toEqual(expect.objectContaining({
      upserts: [expect.objectContaining({
        id: connector.id,
        start: { kind: "free", x: 0, y: 0 },
      })],
      deletedElementIds: [target.id],
    }));
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
