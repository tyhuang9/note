type DrawingToolLockState = Readonly<{
  isDrawingToolLocked?: boolean;
}>;

/** Missing pre-v2 session data uses the unlocked drawing-tool behavior. */
export function getDrawingToolLockPreference(
  state: DrawingToolLockState | null | undefined,
): boolean {
  return state?.isDrawingToolLocked ?? false;
}
