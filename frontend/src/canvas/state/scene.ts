import type { CanvasElement, ElementId } from "../model/elements";
import type { CanvasTool, InteractionSession } from "../interaction/types";
import { clearSelection, pruneSelection, replaceSelection, toggleSelection } from "./selection";

export type SceneState = Readonly<{
  elementsById: Readonly<Record<ElementId, CanvasElement>>;
  orderedElementIds: readonly ElementId[];
  selectedElementIds: readonly ElementId[];
  activeTool: CanvasTool;
  interaction: InteractionSession;
}>;

export type SceneCommand =
  | { type: "add-elements"; elements: readonly CanvasElement[] }
  | { type: "update-elements"; elements: readonly CanvasElement[]; ignoreLocked?: boolean }
  | { type: "remove-elements"; elementIds: readonly ElementId[]; ignoreLocked?: boolean }
  | { type: "batch"; commands: readonly SceneCommand[] };

export type SceneAction =
  | { type: "command"; command: SceneCommand }
  | { type: "replace-elements"; elements: readonly CanvasElement[] }
  | { type: "select-replace"; elementIds: readonly ElementId[] }
  | { type: "select-toggle"; elementId: ElementId }
  | { type: "select-clear" }
  | { type: "select-prune" }
  | { type: "set-active-tool"; tool: CanvasTool }
  | { type: "set-interaction"; interaction: InteractionSession }
  | { type: "cancel-interaction" };

export function createSceneState(elements: readonly CanvasElement[] = [], activeTool: CanvasTool = "select"): SceneState {
  const { elementsById, orderedElementIds } = indexElements(elements);
  return { elementsById, orderedElementIds, selectedElementIds: [], activeTool, interaction: { kind: "idle" } };
}

export function reduceScene(state: SceneState, action: SceneAction): SceneState {
  switch (action.type) {
    case "command": return applySceneCommand(state, action.command);
    case "replace-elements": {
      const indexed = indexElements(action.elements);
      return { ...state, ...indexed, selectedElementIds: pruneSelection(state.selectedElementIds, indexed.elementsById), interaction: { kind: "idle" } };
    }
    case "select-replace": return { ...state, selectedElementIds: replaceSelection(action.elementIds, new Set(state.orderedElementIds)) };
    case "select-toggle": return { ...state, selectedElementIds: toggleSelection(state.selectedElementIds, action.elementId, new Set(state.orderedElementIds)) };
    case "select-clear": return { ...state, selectedElementIds: clearSelection() };
    case "select-prune": return { ...state, selectedElementIds: pruneSelection(state.selectedElementIds, state.elementsById) };
    case "set-active-tool": return { ...state, activeTool: action.tool };
    case "set-interaction": return { ...state, interaction: action.interaction };
    case "cancel-interaction": return { ...state, interaction: { kind: "idle" } };
  }
}

export function applySceneCommand(state: SceneState, command: SceneCommand): SceneState {
  switch (command.type) {
    case "batch": return command.commands.reduce(applySceneCommand, state);
    case "add-elements": {
      const elementsById = { ...state.elementsById };
      const orderedElementIds = [...state.orderedElementIds];
      let didAdd = false;
      for (const element of command.elements) {
        if (elementsById[element.id]) continue;
        elementsById[element.id] = element;
        orderedElementIds.push(element.id);
        didAdd = true;
      }
      if (!didAdd) return state;
      return { ...state, elementsById, orderedElementIds, selectedElementIds: pruneSelection(state.selectedElementIds, elementsById) };
    }
    case "update-elements": {
      const elementsById = { ...state.elementsById };
      let didUpdate = false;
      for (const element of command.elements) {
        const existing = elementsById[element.id];
        if (!existing || (existing.locked && !command.ignoreLocked)) continue;
        if (existing === element) continue;
        elementsById[element.id] = element;
        didUpdate = true;
      }
      if (!didUpdate) return state;
      return { ...state, elementsById };
    }
    case "remove-elements": {
      const removableIds = new Set(command.elementIds.filter((id) => {
        const element = state.elementsById[id];
        return element && (!element.locked || command.ignoreLocked);
      }));
      if (removableIds.size === 0) return state;
      const elementsById = { ...state.elementsById };
      for (const id of removableIds) delete elementsById[id];
      return { ...state, elementsById, orderedElementIds: state.orderedElementIds.filter((id) => !removableIds.has(id)), selectedElementIds: state.selectedElementIds.filter((id) => !removableIds.has(id)) };
    }
  }
}

export function invertSceneCommand(state: SceneState, command: SceneCommand): SceneCommand {
  switch (command.type) {
    case "add-elements": return { type: "remove-elements", elementIds: command.elements.filter((element) => !state.elementsById[element.id]).map((element) => element.id), ignoreLocked: true };
    case "update-elements": return { type: "update-elements", elements: command.elements.flatMap((element) => {
      const current = state.elementsById[element.id];
      return current && (!current.locked || command.ignoreLocked) ? [current] : [];
    }), ignoreLocked: true };
    case "remove-elements": return { type: "add-elements", elements: command.elementIds.flatMap((id) => {
      const current = state.elementsById[id];
      return current && (!current.locked || command.ignoreLocked) ? [current] : [];
    }) };
    case "batch": {
      let currentState = state;
      const inverses: SceneCommand[] = [];
      for (const nested of command.commands) {
        inverses.unshift(invertSceneCommand(currentState, nested));
        currentState = applySceneCommand(currentState, nested);
      }
      return { type: "batch", commands: inverses };
    }
  }
}

function indexElements(elements: readonly CanvasElement[]): Pick<SceneState, "elementsById" | "orderedElementIds"> {
  const elementsById: Record<ElementId, CanvasElement> = {};
  const orderedElementIds: ElementId[] = [];
  for (const element of elements) {
    if (elementsById[element.id]) continue;
    elementsById[element.id] = element;
    orderedElementIds.push(element.id);
  }
  return { elementsById, orderedElementIds };
}
