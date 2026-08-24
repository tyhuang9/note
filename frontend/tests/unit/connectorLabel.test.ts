import { describe, expect, it } from "vitest";
import {
  CONNECTOR_LABEL_GAP_PADDING,
  CONNECTOR_LABEL_LINE_HEIGHT,
  MAX_CONNECTOR_LABEL_BYTES,
  connectorLabelFontPixels,
  getConnectorLabelGapHalfLength,
  measureConnectorLabelWidth,
  normalizeConnectorLabel,
  resolveConnectorLabelStyle,
} from "../../src/canvas/model/connectorLabel";

describe("connector label shaft gaps", () => {
  const upright = resolveConnectorLabelStyle(undefined);
  const follow = { ...upright, orientation: "follow" as const };

  it("uses label width only for following labels at every shaft angle", () => {
    const label = "Follow me";
    const expected = measureConnectorLabelWidth(label, follow) / 2 + CONNECTOR_LABEL_GAP_PADDING;
    expect(getConnectorLabelGapHalfLength(label, follow, 0, { x: 0, y: 0 }, { x: 200, y: 0 })).toBeCloseTo(expected, 5);
    expect(getConnectorLabelGapHalfLength(label, follow, 0, { x: 0, y: 0 }, { x: 0, y: 200 })).toBeCloseTo(expected, 5);
  });

  it("projects upright labels onto the resolved shaft", () => {
    const label = "Upright label";
    const width = measureConnectorLabelWidth(label, upright);
    const height = connectorLabelFontPixels(upright.fontSize) * CONNECTOR_LABEL_LINE_HEIGHT;
    expect(getConnectorLabelGapHalfLength(label, upright, 0, { x: 0, y: 0 }, { x: 200, y: 0 }))
      .toBeCloseTo(width / 2 + CONNECTOR_LABEL_GAP_PADDING, 5);
    expect(getConnectorLabelGapHalfLength(label, upright, 0, { x: 0, y: 0 }, { x: 0, y: 200 }))
      .toBeCloseTo(height / 2 + CONNECTOR_LABEL_GAP_PADDING, 5);
    expect(getConnectorLabelGapHalfLength(label, upright, 0, { x: 0, y: 0 }, { x: 200, y: 200 }))
      .toBeCloseTo((width + height) / (2 * Math.SQRT2) + CONNECTOR_LABEL_GAP_PADDING, 5);
  });

  it("rejects oversized Unicode labels without treating them as intentional deletion", () => {
    const oversized = "😀".repeat(Math.floor(MAX_CONNECTOR_LABEL_BYTES / 4) + 1);
    expect(new TextEncoder().encode(oversized).byteLength).toBeGreaterThan(MAX_CONNECTOR_LABEL_BYTES);
    expect(normalizeConnectorLabel(oversized)).toBeUndefined();
    expect(normalizeConnectorLabel("   \n  ")).toBeUndefined();
  });
});
