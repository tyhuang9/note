import { expect, test } from "@playwright/test";
import golden from "../../src/features/assistant/note-assistant-v1.golden.json";

test("note-assistant-v1 canonical manifest matches its golden contract", async ({ page }) => {
  await page.goto("/");
  const profile = await page.evaluate(async () => {
    const registry = await import("/src/features/assistant/toolRegistry.ts");
    return registry.getCanonicalAssistantToolManifestV1();
  });
  expect(profile).toMatchObject(golden);
  expect(profile.tools).toHaveLength(10);
  expect(profile.tools.map((tool) => tool.id)).toEqual(golden.tools.map((tool) => tool.id));
  expect(profile.tools.some((tool) => tool.id.startsWith("note."))).toBe(false);
  for (const tool of profile.tools) {
    expect(tool.inputSchema).toBeTruthy();
    expect(tool.outputSchema).toBeTruthy();
    expect(tool.authorizedWindows).toEqual(["main"]);
  }
});
