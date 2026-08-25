import type { SceneCommand, SceneState } from "./scene";
import { applySceneCommand, invertSceneCommand } from "./scene";

export type SceneHistoryEntry = Readonly<{ undo: SceneCommand; redo: SceneCommand }>;
export type SceneHistoryState = Readonly<{ past: readonly SceneHistoryEntry[]; future: readonly SceneHistoryEntry[] }>;
export const emptySceneHistory = (): SceneHistoryState => ({ past: [], future: [] });

export function executeSceneCommand(state: SceneState, history: SceneHistoryState, command: SceneCommand): Readonly<{ state: SceneState; history: SceneHistoryState }> {
  const nextState = applySceneCommand(state, command);
  if (nextState === state) return { state, history };
  return { state: nextState, history: { past: [...history.past, { undo: invertSceneCommand(state, command), redo: command }], future: [] } };
}

export function undoSceneCommand(state: SceneState, history: SceneHistoryState): Readonly<{ state: SceneState; history: SceneHistoryState }> {
  const entry = history.past[history.past.length - 1];
  if (!entry) return { state, history };
  return { state: applySceneCommand(state, entry.undo), history: { past: history.past.slice(0, -1), future: [entry, ...history.future] } };
}

export function redoSceneCommand(state: SceneState, history: SceneHistoryState): Readonly<{ state: SceneState; history: SceneHistoryState }> {
  const [entry, ...future] = history.future;
  if (!entry) return { state, history };
  return { state: applySceneCommand(state, entry.redo), history: { past: [...history.past, entry], future } };
}
