import { describe, expect, it } from "vitest";
import {
  createLatestFrameQueue,
  type AnimationFrameDriver,
} from "../../src/canvas/interaction/latestFrame";

function fakeFrameDriver() {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  const driver: AnimationFrameDriver = {
    cancel: (frameId) => {
      callbacks.delete(frameId);
    },
    request: (callback) => {
      const frameId = nextId++;
      callbacks.set(frameId, callback);
      return frameId;
    },
  };
  return {
    driver,
    paint: () => {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback(0);
    },
    pendingCount: () => callbacks.size,
  };
}

describe("latest animation-frame queue", () => {
  it("applies 60 Hz input no more than once in each display frame", () => {
    const frames = fakeFrameDriver();
    const values: number[] = [];
    const queue = createLatestFrameQueue((value: number) => values.push(value), frames.driver);
    for (let value = 0; value < 60; value += 1) {
      queue.schedule(value);
      frames.paint();
    }
    expect(values).toHaveLength(60);
    expect(values[values.length - 1]).toBe(59);
  });

  it("coalesces a 120 Hz burst to one latest-value paint per 60 Hz frame", () => {
    const frames = fakeFrameDriver();
    const values: number[] = [];
    const queue = createLatestFrameQueue((value: number) => values.push(value), frames.driver);
    for (let value = 0; value < 120; value += 1) {
      queue.schedule(value);
      if (value % 2 === 1) frames.paint();
    }
    expect(values).toHaveLength(60);
    expect(values).toEqual(Array.from({ length: 60 }, (_, index) => index * 2 + 1));
  });

  it("flushes the pointer-up value synchronously and cancels discarded work", () => {
    const frames = fakeFrameDriver();
    const values: number[] = [];
    const queue = createLatestFrameQueue((value: number) => values.push(value), frames.driver);
    queue.schedule(1);
    queue.schedule(2);
    queue.flush(3);
    expect(values).toEqual([3]);
    expect(frames.pendingCount()).toBe(0);
    queue.schedule(4);
    queue.cancel();
    frames.paint();
    expect(values).toEqual([3]);
  });
});
