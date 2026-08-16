import { describe, expect, it } from "vitest";
import { cleanupMarquee } from "../../src/canvas/interaction/marqueeCleanup";

describe("marquee cleanup", () => {
  it("cancels queued rendering, clears its pending rectangle, and hides the frame", () => {
    const rafId = { current: 42 as number | null };
    const pendingRect = { current: { x: 1, y: 2, width: 3, height: 4 } as unknown | null };
    const marqueeElement = { current: { style: { display: "block" } } };
    const cancelled: number[] = [];

    cleanupMarquee(rafId, pendingRect, marqueeElement, (id) => cancelled.push(id));

    expect(cancelled).toEqual([42]);
    expect(rafId.current).toBeNull();
    expect(pendingRect.current).toBeNull();
    expect(marqueeElement.current?.style.display).toBe("none");
  });

  it("is safe when no frame is pending or mounted", () => {
    const rafId = { current: null as number | null };
    const pendingRect = { current: null as unknown | null };
    const marqueeElement = { current: null as { style: { display: string } } | null };
    cleanupMarquee(rafId, pendingRect, marqueeElement, () => {
      throw new Error("no RAF should be cancelled");
    });
    expect(rafId.current).toBeNull();
  });
});
