import type { CanvasElement } from "../model/elements";
import type {
  SceneChangeBatch,
  SceneChangeResult,
} from "./sceneRepository";

export type SaveState =
  | { kind: "saved" }
  | { kind: "saving" }
  | { kind: "failed"; error: Error };

type ApplySceneChanges = (batch: SceneChangeBatch) => Promise<SceneChangeResult>;
type QueueListener = (pageId: string, state: SaveState) => void;

type PageQueueState = {
  desired: Map<string, CanvasElement>;
  persisted: Map<string, CanvasElement>;
  revision: number;
  revisionAtLastDrain: number;
  running?: Promise<void>;
};

function cloneScene(elements: readonly CanvasElement[]) {
  return new Map(elements.map((element) => [element.id, element]));
}

function sceneChanges(
  pageId: string,
  baseRevision: number,
  persisted: ReadonlyMap<string, CanvasElement>,
  desired: ReadonlyMap<string, CanvasElement>,
): SceneChangeBatch | null {
  const upserts = [...desired.values()].filter(
    (element) => JSON.stringify(element) !== JSON.stringify(persisted.get(element.id)),
  );
  const deletedElementIds = [...persisted.keys()].filter((id) => !desired.has(id));
  return upserts.length || deletedElementIds.length
    ? { pageId, baseRevision, upserts, deletedElementIds }
    : null;
}

/**
 * A page-local write serializer. It snapshots only committed scene state;
 * callers should never feed it live pointer drafts. A failed write retains the
 * desired scene in memory and exposes the error for a visible retry state.
 */
export class SceneChangeQueue {
  private readonly pages = new Map<string, PageQueueState>();

  constructor(
    private readonly apply: ApplySceneChanges,
    private readonly onStateChange?: QueueListener,
  ) {}

  seed(pageId: string, revision: number, elements: readonly CanvasElement[]) {
    this.pages.set(pageId, {
      desired: cloneScene(elements),
      persisted: cloneScene(elements),
      revision,
      revisionAtLastDrain: 0,
    });
  }

  setRevision(pageId: string, revision: number) {
    const state = this.get(pageId);
    state.revision = revision;
  }

  replacePage(pageId: string, elements: readonly CanvasElement[]): Promise<void> {
    const state = this.get(pageId);
    state.desired = cloneScene(elements);
    state.revisionAtLastDrain += 1;
    return this.start(pageId, state);
  }

  async flush(pageId?: string): Promise<void> {
    const pageIds = pageId ? [pageId] : [...this.pages.keys()];
    await Promise.all(pageIds.map(async (id) => {
      const state = this.get(id);
      await this.start(id, state);
    }));
  }

  retry(pageId: string): Promise<void> {
    return this.start(pageId, this.get(pageId));
  }

  private get(pageId: string): PageQueueState {
    let state = this.pages.get(pageId);
    if (!state) {
      state = {
        desired: new Map(),
        persisted: new Map(),
        revision: 0,
        revisionAtLastDrain: 0,
      };
      this.pages.set(pageId, state);
    }
    return state;
  }

  private start(pageId: string, state: PageQueueState): Promise<void> {
    if (!state.running) {
      state.running = this.drain(pageId, state).finally(() => {
        state.running = undefined;
      });
    }
    return state.running;
  }

  private async drain(pageId: string, state: PageQueueState) {
    while (true) {
      const revisionAtStart = state.revisionAtLastDrain;
      const desired = new Map(state.desired);
      const batch = sceneChanges(pageId, state.revision, state.persisted, desired);
      if (!batch) {
        this.onStateChange?.(pageId, { kind: "saved" });
        return;
      }

      this.onStateChange?.(pageId, { kind: "saving" });
      try {
        const result = await this.apply(batch);
        state.persisted = desired;
        state.revision = result.newRevision;
      } catch (reason) {
        const error = reason instanceof Error ? reason : new Error(String(reason));
        this.onStateChange?.(pageId, { kind: "failed", error });
        throw error;
      }

      if (revisionAtStart === state.revisionAtLastDrain) {
        this.onStateChange?.(pageId, { kind: "saved" });
        return;
      }
    }
  }
}
