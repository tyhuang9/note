import { expect, test } from "@playwright/test";

test("note-assistant-v1 canonical manifest matches its golden contract", async ({ page }) => {
  await page.goto("/");
  const golden = await (await page.request.get("/src/features/assistant/note-assistant-v1.golden.json")).json();
  const profile = await page.evaluate(async () => {
    const registry = await import("/src/features/assistant/toolRegistry.ts");
    return registry.getCanonicalAssistantToolManifestV1();
  });
  expect(profile).toEqual(golden);
  expect(profile.tools).toHaveLength(10);
  expect(profile.tools.some((tool) => tool.id.startsWith("note."))).toBe(false);
});
