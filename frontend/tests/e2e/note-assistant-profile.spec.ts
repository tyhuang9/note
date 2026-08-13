import { expect, test } from "@playwright/test";

test("note-assistant-v1 canonical manifest matches its golden contract", async ({ page }) => {
  await page.goto("/");
  const golden = await (await page.request.get("/src/features/assistant/note-assistant-v1.golden.json")).json();
  const profile = await page.evaluate(async () => {
    const registry = await import("/src/features/assistant/toolRegistry.ts");
    return registry.getCanonicalAssistantToolManifestV1();
  });
  const normalized = await page.evaluate(async (manifest) => {
    const digest = async (value: unknown) => {
      const bytes = new TextEncoder().encode(JSON.stringify(value));
      const hash = await crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
    };
    return {
      ...manifest,
      tools: await Promise.all(manifest.tools.map(async ({ inputSchema, outputSchema, ...tool }) => ({ ...tool, schemaHash: await digest([inputSchema, outputSchema]) }))),
    };
  }, profile);
  expect(normalized).toEqual(golden);
  expect(normalized.tools).toHaveLength(10);
  expect(normalized.tools.some((tool) => tool.id.startsWith("note."))).toBe(false);
});
