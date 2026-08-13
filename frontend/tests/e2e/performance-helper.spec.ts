import { expect, test } from "@playwright/test";

test("performance helper creates unique transient entries for concurrent resolve and reject paths", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const entries: string[] = [];
    const observer = new PerformanceObserver((list) => {
      entries.push(...list.getEntries().map((entry) => entry.name));
    });
    observer.observe({ entryTypes: ["mark", "measure"] });
    const helper = await import("/src/services/performance.ts");
    const resolved = helper.measurePerformance("calendar.agenda", () => new Promise<string>((resolve) => setTimeout(() => resolve("ok"), 10)));
    const rejected = helper.measurePerformance("calendar.agenda", () => new Promise((_, reject) => setTimeout(() => reject(new Error("expected")), 1)));
    await Promise.all([resolved, rejected.catch(() => "rejected")]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    observer.disconnect();
    return {
      entries,
      retained: performance.getEntriesByType("mark").concat(performance.getEntriesByType("measure")).filter((entry) => entry.name.startsWith("note.calendar.agenda.")),
    };
  });
  const starts = result.entries.filter((name) => name.endsWith(".start"));
  const measures = result.entries.filter((name) => /^note\.calendar\.agenda\.\d+$/.test(name));
  expect(new Set(starts).size).toBe(2);
  expect(new Set(measures).size).toBe(2);
  expect(result.retained).toEqual([]);
});
