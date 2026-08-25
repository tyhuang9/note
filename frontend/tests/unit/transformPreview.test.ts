import { describe, expect, it } from "vitest";
import type { ConnectorElement, RoughStyle, ShapeElement } from "../../src/canvas/model/elements";
import {
  getConnectorGeometryCacheDiagnostics,
  resetConnectorGeometryCacheDiagnostics,
} from "../../src/canvas/model/connectorBinding";
import {
  overlayTransformedElements,
  resolveAffectedConnectorGeometry,
} from "../../src/canvas/interaction/transformPreview";

const style: RoughStyle = {
  roughness: 1,
  roundness: 0,
  seed: 1,
  strokeColor: { kind: "fixed", value: "#111827" },
  strokeStyle: "solid",
  strokeWidth: 2,
};

function rectangle(id: string, x: number): ShapeElement {
  return {
    createdAt: 1,
    height: 80,
    id,
    locked: false,
    opacity: 1,
    pageId: "page",
    rotation: 0,
    shape: "rectangle",
    style,
    type: "shape",
    updatedAt: 1,
    width: 120,
    x,
    y: 20,
    zIndex: 1,
  };
}

function connector(id: string, targetId: string, endX: number): ConnectorElement {
  return {
    createdAt: 1,
    end: { kind: "free", x: endX, y: 60 },
    id,
    locked: false,
    opacity: 1,
    pageId: "page",
    routing: "straight",
    start: { gap: 0, kind: "element", targetElementId: targetId },
    style: { ...style, endArrowhead: "arrow", startArrowhead: "none" },
    type: "connector",
    updatedAt: 1,
    zIndex: 2,
  };
}

describe("transform connector previews", () => {
  it("resolves only captured connector IDs against a transformed overlay", () => {
    const target = rectangle("target", 20);
    const affected = connector("affected", target.id, 300);
    const unaffected = connector("unaffected", target.id, 360);
    const base = { [target.id]: target, [affected.id]: affected, [unaffected.id]: unaffected };
    const movedTarget = { ...target, x: 100 };
    const overlay = overlayTransformedElements(base, [movedTarget]);
    resetConnectorGeometryCacheDiagnostics();
    const previews = resolveAffectedConnectorGeometry(overlay, new Set([affected.id]));
    expect(previews.map(({ connector: item }) => item.id)).toEqual([affected.id]);
    expect(previews[0].points).not.toBeNull();
    expect(overlay[target.id]).toBe(movedTarget);
    expect(overlay[unaffected.id]).toBe(unaffected);
    expect(getConnectorGeometryCacheDiagnostics()).toEqual({ hits: 0, misses: 1 });
  });
});
