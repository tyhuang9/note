/** Transient developer User Timing entries with fixed operation names only. */
export const performanceOperations = [
  "calendar.agenda", "calendar.search", "assistant.context", "assistant.provider", "assistant.tool",
  "widget.refresh", "main.activation",
] as const;
export type PerformanceOperation = (typeof performanceOperations)[number];
let invocation = 0;

function userTiming() {
  const api = globalThis.performance;
  return api && typeof api.mark === "function" && typeof api.measure === "function"
    && typeof api.clearMarks === "function" && typeof api.clearMeasures === "function" ? api : null;
}

export async function measurePerformance<T>(operation: PerformanceOperation, work: () => Promise<T>): Promise<T> {
  const api = userTiming();
  const token = ++invocation;
  const start = `note.${operation}.${token}.start`;
  const end = `note.${operation}.${token}.end`;
  const measure = `note.${operation}.${token}`;
  api?.mark(start);
  try { return await work(); }
  finally { if (api) { api.mark(end); api.measure(measure, start, end); api.clearMeasures(measure); api.clearMarks(start); api.clearMarks(end); } }
}

export function measurePerformanceSync<T>(operation: PerformanceOperation, work: () => T): T {
  const api = userTiming();
  const token = ++invocation;
  const start = `note.${operation}.${token}.start`;
  const end = `note.${operation}.${token}.end`;
  const measure = `note.${operation}.${token}`;
  api?.mark(start);
  try { return work(); }
  finally { if (api) { api.mark(end); api.measure(measure, start, end); api.clearMeasures(measure); api.clearMarks(start); api.clearMarks(end); } }
}
