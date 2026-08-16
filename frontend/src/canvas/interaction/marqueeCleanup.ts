/** Clears every pending marquee side effect through one idempotent path. */
export function cleanupMarquee(
  rafId: { current: number | null },
  pendingRect: { current: unknown | null },
  marqueeElement: { current: { style: { display: string } } | null },
  cancelFrame: (frameId: number) => void = window.cancelAnimationFrame,
) {
  if (rafId.current !== null) {
    cancelFrame(rafId.current);
    rafId.current = null;
  }
  pendingRect.current = null;
  if (marqueeElement.current) marqueeElement.current.style.display = "none";
}
