import { expect, test } from "@playwright/test";

test("browser navigation defaults to the main note surface", async ({ page }) => {
  await page.goto("/");

  await expect(
    page.getByRole("tabpanel", { name: "Freeform note canvas" }),
  ).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary workspace tools" })).toBeVisible();
});

for (const surface of [
  { height: 520, heading: "Widget", id: "widget", path: "/widget.html", width: 360 },
  { height: 720, heading: "Event editor", id: "event-editor", path: "/event-editor.html", width: 560 },
] as const) {
  test(`${surface.heading} renders an isolated accessible placeholder`, async ({
    page,
  }) => {
    await page.setViewportSize({ height: surface.height, width: surface.width });
    await page.goto(surface.path);

    const main = page.getByRole("main");
    await expect(main).toBeVisible();
    await expect(main).toHaveAttribute("data-surface", surface.id);
    await expect(
      page.getByRole("heading", { level: 1, name: surface.heading }),
    ).toBeVisible();
    await expect(page.getByRole("status", { name: "Not available yet" })).toBeVisible();
    await expect(page.getByText(`${surface.heading} foundation placeholder.`)).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const card = document.querySelector(".auxiliary-surface-card");
          const cardBounds = card?.getBoundingClientRect();

          return Boolean(
            cardBounds &&
              document.documentElement.scrollWidth <= document.documentElement.clientWidth &&
              document.documentElement.scrollHeight <= document.documentElement.clientHeight &&
              cardBounds.top >= 0 &&
              cardBounds.bottom <= window.innerHeight,
          );
        }),
      )
      .toBe(true);
    await expect(main).toHaveCSS("height", `${surface.height}px`);
    await expect(main).toHaveCSS("width", `${surface.width}px`);
    await expect(page.locator(".canvas")).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Primary workspace tools" })).toHaveCount(0);
  });
}

test("quick command remains isolated and presents native-only typed fallback", async ({
  page,
}) => {
  await page.setViewportSize({ height: 180, width: 520 });
  await page.goto("/quick-command.html");

  const main = page.getByRole("main");
  await expect(main).toHaveAttribute("data-surface", "quick-command");
  await expect(page.getByRole("heading", { level: 1, name: "Quick command" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Command mode" })).toHaveValue("assistant_command");
  await expect(page.getByRole("textbox", { name: "Type a command or dictation" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Voice unavailable" })).toBeDisabled();
  await expect(page.getByRole("status")).toContainText("Choose a mode");
  await expect(page.getByText("Browser microphone capture is unavailable")).toBeVisible();
  await expect(page.getByText("Calendar commands and confirmations are deferred")).toBeVisible();
  await expect(page.locator(".canvas")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Primary workspace tools" })).toHaveCount(0);
});

test("unknown development surface fails closed", async ({ page }) => {
  await page.goto("/unsupported.html");

  await expect(
    page.getByRole("heading", { level: 1, name: "Unsupported window" }),
  ).toBeVisible();
  await expect(
    page.getByText("This window type is not supported."),
  ).toBeVisible();
  await expect(page.getByRole("main")).toHaveAttribute(
    "data-surface",
    "unsupported",
  );
  await expect(page.getByRole("status", { name: "Not available yet" })).toBeVisible();
  await expect(page.locator(".canvas")).toHaveCount(0);
});

test("assistant keeps typed input and explains disabled native voice", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "AI assistant" }).click();

  const prompt = page.getByRole("textbox", { name: "Assistant prompt" });
  const voice = page.getByRole("button", {
    name: "Native voice input unavailable",
  });

  await expect(prompt).toBeEditable();
  await prompt.fill("Summarize this note");
  await expect(prompt).toHaveValue("Summarize this note");
  await expect(voice).toBeDisabled();
  await expect(voice).toHaveAttribute("aria-describedby", "native-voice-status");
  await expect(page.getByText("Native voice input is not yet available.")).toBeVisible();
});
