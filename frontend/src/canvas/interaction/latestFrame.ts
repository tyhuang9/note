export type AnimationFrameDriver = Readonly<{
  cancel: (frameId: number) => void;
  request: (callback: FrameRequestCallback) => number;
}>;

export type LatestFrameQueue<T> = Readonly<{
  cancel: () => void;
  flush: (value?: T) => void;
  schedule: (value: T) => void;
}>;

const browserFrameDriver: AnimationFrameDriver = {
  cancel: (frameId) => window.cancelAnimationFrame(frameId),
  request: (callback) => window.requestAnimationFrame(callback),
};

/** Keeps only the latest high-frequency input and applies it at most once per frame. */
export function createLatestFrameQueue<T>(
  apply: (value: T) => void,
  driver: AnimationFrameDriver = browserFrameDriver,
): LatestFrameQueue<T> {
  let frameId: number | null = null;
  let hasPendingValue = false;
  let pendingValue: T;

  const applyPending = () => {
    frameId = null;
    if (!hasPendingValue) return;
    hasPendingValue = false;
    apply(pendingValue);
  };

  return {
    cancel: () => {
      if (frameId !== null) driver.cancel(frameId);
      frameId = null;
      hasPendingValue = false;
    },
    flush: (value) => {
      if (value !== undefined) {
        pendingValue = value;
        hasPendingValue = true;
      }
      if (frameId !== null) driver.cancel(frameId);
      applyPending();
    },
    schedule: (value) => {
      pendingValue = value;
      hasPendingValue = true;
      if (frameId === null) frameId = driver.request(applyPending);
    },
  };
}
