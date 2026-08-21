import { expect, test, type Locator, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await installPerimeterWorkspace(page);
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("tabpanel")).toBeVisible();
});

test("pointer two-click authoring selects a whole rotated rounded rectangle and commits the paired preview route", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const start = await modelToScreen(page, { x: 900, y: 650 });
  const expectedEnd = seededRoundedRectangleBoundaryPoint(0.18);
  const targetPoint = await modelToScreen(page, expectedEnd);

  await selectTool(page, "arrow");
  await page.mouse.click(start.x, start.y);
  await page.mouse.move(targetPoint.x + 23, targetPoint.y, { steps: 4 });
  const highlight = page.locator('[data-connector-target-id="rounded-rectangle"]');
  await expect(highlight).toHaveCount(1);
  await expect(highlight).toHaveAttribute("data-connector-binding-state", "near");
  await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 6 });

  await expect(highlight).toHaveAttribute("data-connector-binding-state", "snapped");
  await expect(highlight).toHaveClass(/is-snapped/);

  const preview = page.locator(".arrow-authoring-preview");
  const previewEnd = {
    x: Number(await preview.getAttribute("data-end-x")),
    y: Number(await preview.getAttribute("data-end-y")),
  };
  await page.mouse.click(targetPoint.x, targetPoint.y);

  await expect.poll(() => newestConnector(page)).toMatchObject({
    end: { kind: "element", targetElementId: "rounded-rectangle" },
  });
  const connector = await newestConnector(page);
  expect(connector?.end).toEqual({ kind: "element", targetElementId: "rounded-rectangle", gap: 0 });
  const committedEndScreen = await modelToScreen(page, previewEnd);
  const endHandle = page.getByRole("button", { name: "Move connector end endpoint" });
  const endHandleBounds = await requiredBounds(endHandle, "committed end endpoint");
  expect(Math.abs(endHandleBounds.x + endHandleBounds.width / 2 - committedEndScreen.x)).toBeLessThanOrEqual(1.5);
  expect(Math.abs(endHandleBounds.y + endHandleBounds.height / 2 - committedEndScreen.y)).toBeLessThanOrEqual(1.5);
});

test("keyboard chooser commits and rebinds whole-object targets without perimeter controls", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  await canvas.focus();
  await page.keyboard.press("a");
  await page.keyboard.press("Enter");
  const startHandle = page.getByRole("button", { name: "Move connector start endpoint" });
  await expect(startHandle).toBeFocused();

  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Choose start endpoint target" });
  await dialog.getByRole("button", { name: /^Rectangle 1 / }).click();
  await expect(dialog.getByRole("slider")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /anchor/i })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Bind start endpoint" }).click();
  await expect.poll(async () => (await newestConnector(page))?.start).toEqual({
    kind: "element", targetElementId: "rounded-rectangle", gap: 0,
  });

  await startHandle.focus();
  await page.keyboard.press("Enter");
  const arbitraryDialog = page.getByRole("dialog", { name: "Choose start endpoint target" });
  const targets = arbitraryDialog.locator("[data-connector-target]");
  await expect(targets.first()).toBeFocused();
  for (let index = 1; index < await targets.count(); index += 1) {
    await page.keyboard.press("Tab");
    await expect(targets.nth(index)).toBeFocused();
  }
  const bind = arbitraryDialog.getByRole("button", { name: "Bind start endpoint" });
  const detach = arbitraryDialog.getByRole("button", { name: "Detach start endpoint" });
  const close = arbitraryDialog.getByRole("button", { name: "Close endpoint chooser" });
  await page.keyboard.press("Tab");
  await expect(bind).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(detach).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(targets.first()).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(startHandle).toBeFocused();

  await startHandle.focus();
  await page.keyboard.press("Enter");
  const reopenedDialog = page.getByRole("dialog", { name: "Choose start endpoint target" });
  await reopenedDialog.getByRole("button", { name: /^Ellipse 1 / }).click();
  await reopenedDialog.getByRole("button", { name: "Bind start endpoint" }).click();
  await expect(startHandle).toBeFocused();

  await expect.poll(async () => (await newestConnector(page))?.start).toEqual({
    kind: "element", targetElementId: "ellipse", gap: 0,
  });

  await startHandle.focus();
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(async () => (await newestConnector(page))?.start).toMatchObject({ kind: "free" });
  await expect(page.locator('[role="status"].canvas-accessibility-status')).toHaveText(
    "Detached and moved start endpoint. It is now free.",
  );
});

test("retarget status announces each near, snap, loss, and cancellation transition once", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  await canvas.focus();
  await page.keyboard.press("a");
  await page.keyboard.press("Enter");
  await selectTool(page, "select");
  const endHandle = page.getByRole("button", { name: "Move connector end endpoint" });
  const handle = await requiredBounds(endHandle, "free end endpoint");
  const nearBoundary = await modelToScreen(page, seededRoundedRectangleBoundaryPoint(0.18));
  const nearBoundaryTwo = await modelToScreen(page, seededRoundedRectangleBoundaryPoint(0.22));
  const snappedBoundary = await modelToScreen(page, seededRoundedRectangleBoundaryPoint(0.18));
  const snappedBoundaryTwo = await modelToScreen(page, seededRoundedRectangleBoundaryPoint(0.22));
  const freePoint = await modelToScreen(page, { x: 100, y: 780 });
  const status = page.locator('[role="status"].canvas-accessibility-status');
  await observeConnectorStatus(page);

  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(nearBoundary.x + 23, nearBoundary.y);
  await expect(status).toHaveText(/Near Rectangle 1 .*bind the whole object/);
  const highlight = page.locator('[data-connector-target-id="rounded-rectangle"]');
  await expect(highlight).toHaveCount(1);
  await expect(highlight).toHaveAttribute("data-connector-binding-state", "near");
  await page.mouse.move(nearBoundaryTwo.x + 23, nearBoundaryTwo.y);
  await expect(status).toHaveText(/Near Rectangle 1 .*bind the whole object/);
  await page.mouse.move(snappedBoundary.x, snappedBoundary.y);
  await expect(status).toHaveText(/Snapped to Rectangle 1 .*nearest facing visible boundary/);
  await expect(highlight).toHaveAttribute("data-connector-binding-state", "snapped");
  await page.mouse.move(snappedBoundaryTwo.x, snappedBoundaryTwo.y);
  await expect(status).toHaveText(/Snapped to Rectangle 1 .*nearest facing visible boundary/);
  await page.mouse.move(freePoint.x, freePoint.y);
  await expect(status).toHaveText("No binding target. Endpoint will remain free.");
  await page.mouse.move(snappedBoundary.x, snappedBoundary.y);
  await expect(status).toHaveText(/Snapped to Rectangle 1 .*nearest facing visible boundary/);
  await endHandle.dispatchEvent("pointercancel", { pointerId: 1 });
  await page.mouse.up();
  await expect(status).toHaveText("Endpoint retargeting canceled. Existing binding remains unchanged.");

  const announcements = await readConnectorStatus(page);
  expect(announcements.filter((message) => message.startsWith("Near Rectangle 1"))).toHaveLength(1);
  expect(announcements.filter((message) => message.startsWith("Snapped to Rectangle 1"))).toHaveLength(2);
  expect(announcements.filter((message) => message === "No binding target. Endpoint will remain free.")).toHaveLength(1);
  expect(announcements.filter((message) => message === "Endpoint retargeting canceled. Existing binding remains unchanged.")).toHaveLength(1);
});

test("continuous authoring binds one whole-object target at 50%, 100%, and 200%", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const targets = [
    { id: "rounded-rectangle", point: () => seededRoundedRectangleBoundaryPoint(0.18) },
    { id: "ellipse", point: () => perimeterPoint({ x: 720, y: 230, width: 190, height: 130, rotation: -24, kind: "ellipse" }, 0.18) },
    { id: "diamond", point: () => perimeterPoint({ x: 470, y: 500, width: 190, height: 150, rotation: 41, kind: "diamond" }, 0.31) },
    { id: "text-target", point: () => perimeterPoint({ x: 760, y: 510, width: 190, height: 105, rotation: -17, kind: "text" }, 0.37) },
  ];

  for (const percent of [50, 100, 200]) {
    await setZoom(page, canvas, percent);
    for (const target of targets) {
      const end = await modelToScreen(page, target.point());
      const start = await modelToScreen(page, { x: 980, y: 720 });
      await selectTool(page, "arrow");
      await dispatchCanvasPointer(page, "pointerdown", start);
      await dispatchCanvasPointer(page, "pointermove", end);
      const highlight = page.locator(`[data-connector-target-id="${target.id}"].is-snapped`);
      await expect(highlight).toHaveCount(1);
      await expect(highlight).toHaveAttribute("data-connector-binding-state", "snapped");
      const preview = page.locator(".arrow-authoring-preview");
      const previewEnd = { x: Number(await preview.getAttribute("data-end-x")), y: Number(await preview.getAttribute("data-end-y")) };
      await dispatchCanvasPointer(page, "pointerdown", end);
      await expect.poll(() => newestConnector(page)).toMatchObject({ end: { kind: "element", targetElementId: target.id } });
      const committedHandle = await requiredBounds(page.getByRole("button", { name: "Move connector end endpoint" }), "committed endpoint handle");
      const committedEnd = await screenToModel(page, { x: committedHandle.x + committedHandle.width / 2, y: committedHandle.y + committedHandle.height / 2 });
      expect(Math.abs(committedEnd.x - previewEnd.x)).toBeLessThanOrEqual(1.5 / (percent / 100));
      expect(Math.abs(committedEnd.y - previewEnd.y)).toBeLessThanOrEqual(1.5 / (percent / 100));
      expect((await newestConnector(page))?.end).toEqual({ kind: "element", targetElementId: target.id, gap: 0 });
    }
  }
});

test("retargeting through a connector overlay binds, survives transforms and persistence, and cancels without writes", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  await canvas.focus();
  await page.keyboard.press("a");
  await page.keyboard.press("Enter");
  await selectTool(page, "select");
  const endHandle = page.getByRole("button", { name: "Move connector end endpoint" });
  const end = await modelToScreen(page, perimeterPoint({ x: 760, y: 510, width: 190, height: 105, rotation: -17, kind: "text" }, 0.37));
  expect(await page.evaluate((point) => document.elementFromPoint(point.x, point.y)
    ?.closest<HTMLElement>("[data-canvas-element-id]")?.dataset.canvasElementId ?? null, end)).not.toBe("text-target");
  const endHandleBounds = await requiredBounds(endHandle, "free end handle");
  await page.mouse.move(endHandleBounds.x + endHandleBounds.width / 2, endHandleBounds.y + endHandleBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await expect(page.locator('[data-connector-target-id="text-target"].is-snapped')).toHaveCount(1);
  await page.mouse.up();
  await expect.poll(async () => (await newestConnector(page))?.end).toEqual({
    kind: "element", targetElementId: "text-target", gap: 0,
  });

  const text = page.locator('[data-canvas-element-id="text-target"]');
  await text.focus();
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(async () => (await newestConnector(page))?.end).toEqual({
    kind: "element", targetElementId: "text-target", gap: 0,
  });
  await canvas.focus();
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+y");
  await expect.poll(async () => (await newestConnector(page))?.end).toEqual({
    kind: "element", targetElementId: "text-target", gap: 0,
  });
  await page.reload();
  await expect.poll(async () => (await newestConnector(page))?.end).toEqual({
    kind: "element", targetElementId: "text-target", gap: 0,
  });
  const persistedArrow = page.getByRole("button", { name: "Select and move arrow connector" }).last();
  await persistedArrow.focus();
  await page.keyboard.press("Enter");

  await resetCounts(page);
  const boundHandle = page.getByRole("button", { name: "Move connector end endpoint" });
  const boundHandleBounds = await requiredBounds(boundHandle, "bound end handle");
  await page.mouse.move(boundHandleBounds.x + boundHandleBounds.width / 2, boundHandleBounds.y + boundHandleBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x - 32, end.y, { steps: 3 });
  await boundHandle.dispatchEvent("pointercancel", { pointerId: 1 });
  await page.mouse.up();
  expect(await counts(page)).toEqual({ apply: 0, persistence: 0, session: 0 });

  await selectTool(page, "arrow");
  await page.waitForTimeout(650);
  await resetCounts(page);
  const start = await modelToScreen(page, { x: 980, y: 720 });
  await dispatchCanvasPointer(page, "pointerdown", start);
  await page.keyboard.press("Escape");
  expect(await counts(page)).toEqual({ apply: 0, persistence: 0, session: 0 });
});

test("pointer retarget rejects the opposite endpoint target without data, persistence, or history mutation", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  await canvas.focus();
  await page.keyboard.press("a");
  await page.keyboard.press("Enter");
  await selectTool(page, "select");
  await page.waitForTimeout(650);
  await resetCounts(page);

  const oppositeTarget = await modelToScreen(page, { x: 540, y: 310 });
  const endHandle = page.getByRole("button", { name: "Move connector end endpoint" });
  const endBounds = await requiredBounds(endHandle, "free end endpoint");
  await page.mouse.move(endBounds.x + endBounds.width / 2, endBounds.y + endBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(oppositeTarget.x, oppositeTarget.y);
  await page.mouse.up();
  await expect.poll(async () => (await newestConnector(page))?.end).toEqual({
    gap: 0,
    kind: "element",
    targetElementId: "rounded-rectangle",
  });
  await page.waitForTimeout(650);
  expect((await counts(page)).apply).toBe(1);

  const beforeRejectedDrop = await newestConnector(page);
  await resetCounts(page);
  await observeConnectorStatus(page);
  const startHandle = page.getByRole("button", { name: "Move connector start endpoint" });
  const startBounds = await requiredBounds(startHandle, "free start endpoint");
  const safeTarget = await modelToScreen(page, perimeterPoint({ x: 720, y: 230, width: 190, height: 130, rotation: -24, kind: "ellipse" }, 0.18));
  await page.mouse.move(startBounds.x + startBounds.width / 2, startBounds.y + startBounds.height / 2);
  await page.mouse.down();
  await startHandle.dispatchEvent("pointermove", { button: 0, clientX: safeTarget.x, clientY: safeTarget.y, pointerId: 1 });
  await expect(page.locator('[data-connector-target-id="ellipse"]')).toHaveAttribute("data-connector-binding-state", "snapped");
  await expect(page.locator('[role="status"].canvas-accessibility-status')).toHaveText(
    /Snapped to Ellipse 1 .*nearest facing visible boundary/,
  );
  const previewBounds = await requiredBounds(startHandle, "previewed start endpoint");
  expect(Math.hypot(previewBounds.x - startBounds.x, previewBounds.y - startBounds.y)).toBeGreaterThan(20);

  await page.mouse.move(oppositeTarget.x, oppositeTarget.y, { steps: 5 });
  await startHandle.dispatchEvent("pointermove", { button: 0, clientX: oppositeTarget.x, clientY: oppositeTarget.y, pointerId: 1 });
  const refusal = "Could not bind start endpoint. Choose a different target for each connector endpoint.";
  const status = page.locator('[role="status"].canvas-accessibility-status');
  await expect(status).toHaveText(refusal);
  expect(await status.evaluate((element) => !element.closest("[inert]"))).toBe(true);
  await expect(page.locator('[data-connector-target-id="rounded-rectangle"]')).toHaveCount(0);
  await expect(page.locator('[data-connector-target-id="ellipse"]')).toHaveCount(0);
  const restoredBounds = await requiredBounds(startHandle, "restored start endpoint");
  expect(restoredBounds.x).toBeCloseTo(startBounds.x, 1);
  expect(restoredBounds.y).toBeCloseTo(startBounds.y, 1);
  await startHandle.dispatchEvent("pointermove", { button: 0, clientX: oppositeTarget.x, clientY: oppositeTarget.y, pointerId: 1 });
  await expect(status).toHaveText(refusal);
  expect((await peekConnectorStatus(page)).filter((message) => message === refusal)).toHaveLength(1);
  await page.mouse.up();
  await page.waitForTimeout(650);
  expect(await newestConnector(page)).toEqual(beforeRejectedDrop);
  expect(await counts(page)).toEqual({ apply: 0, persistence: 0, session: 0 });
  expect((await readConnectorStatus(page)).filter((message) => message === refusal)).toHaveLength(1);

  await resetCounts(page);
  await observeConnectorStatus(page);
  const secondStartBounds = await requiredBounds(startHandle, "second free start endpoint");
  await page.mouse.move(
    secondStartBounds.x + secondStartBounds.width / 2,
    secondStartBounds.y + secondStartBounds.height / 2,
  );
  await page.mouse.down();
  await expect(status).toBeEmpty();
  await page.mouse.move(oppositeTarget.x, oppositeTarget.y);
  await expect(status).toHaveText(refusal);
  expect(await status.evaluate((element) => !element.closest("[inert]"))).toBe(true);
  await page.mouse.up();
  await page.waitForTimeout(650);
  expect(await newestConnector(page)).toEqual(beforeRejectedDrop);
  expect(await counts(page)).toEqual({ apply: 0, persistence: 0, session: 0 });
  expect((await readConnectorStatus(page)).filter((message) => message === refusal)).toHaveLength(1);

  await canvas.focus();
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await newestConnector(page))?.end).toMatchObject({ kind: "free" });
  await page.keyboard.press("Control+y");
  await expect.poll(async () => (await newestConnector(page))?.end).toMatchObject({
    kind: "element", targetElementId: "rounded-rectangle",
  });

  await page.waitForTimeout(650);
  await resetCounts(page);
  const recoveredStartBounds = await requiredBounds(startHandle, "recovered start endpoint");
  await page.mouse.move(
    recoveredStartBounds.x + recoveredStartBounds.width / 2,
    recoveredStartBounds.y + recoveredStartBounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(safeTarget.x, safeTarget.y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await newestConnector(page))?.start).toEqual({
    gap: 0, kind: "element", targetElementId: "ellipse",
  });
  await page.waitForTimeout(650);
  expect(await counts(page)).toEqual({ apply: 1, persistence: 2, session: 1 });
});

async function selectTool(page: Page, tool: string) {
  await page.locator(`.canvas-tool-palette [data-tool="${tool}"]`).click();
}

async function setZoom(page: Page, canvas: Locator, percent: number) {
  await canvas.focus();
  await page.keyboard.press("Control+0");
  const key = percent < 100 ? "Control+-" : "Control+=";
  for (let index = 0; index < Math.abs(percent - 100) / 10; index += 1) await page.keyboard.press(key);
  await expect(page.locator(".zoom-indicator")).toHaveText(`${percent}%`);
}

async function dispatchCanvasPointer(page: Page, type: "pointerdown" | "pointermove", point: Readonly<{ x: number; y: number }>) {
  await page.getByRole("tabpanel").dispatchEvent(type, { button: 0, clientX: point.x, clientY: point.y, pointerId: 41 });
}

async function requiredBounds(locator: Locator, label: string) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error(`${label} bounds were unavailable.`);
  return bounds;
}

async function newestConnector(page: Page) {
  return page.evaluate(() => {
    const elements = (window as unknown as { __perimeterWorkspace: { elements: Array<Record<string, unknown> & { type: string }> } }).__perimeterWorkspace.elements;
    return [...elements].reverse().find((element) => element.type === "connector");
  });
}

async function counts(page: Page) {
  return page.evaluate(() => (window as unknown as {
    __perimeterCounts: { apply: number; persistence: number; session: number };
  }).__perimeterCounts);
}

async function resetCounts(page: Page) {
  await page.evaluate(() => {
    (window as unknown as {
      __perimeterCounts: { apply: number; persistence: number; session: number };
    }).__perimeterCounts = { apply: 0, persistence: 0, session: 0 };
  });
}

async function observeConnectorStatus(page: Page) {
  await page.evaluate(() => {
    const status = document.querySelector<HTMLElement>('[role="status"].canvas-accessibility-status');
    if (!status) throw new Error("Connector status region was unavailable.");
    const runtime = window as typeof window & { __perimeterAnnouncements?: string[]; __perimeterStatusObserver?: MutationObserver };
    runtime.__perimeterAnnouncements = [];
    runtime.__perimeterStatusObserver?.disconnect();
    runtime.__perimeterStatusObserver = new MutationObserver(() => {
      const message = status.textContent?.trim() ?? "";
      if (message) runtime.__perimeterAnnouncements?.push(message);
    });
    runtime.__perimeterStatusObserver.observe(status, { characterData: true, childList: true, subtree: true });
  });
}

async function readConnectorStatus(page: Page) {
  return page.evaluate(() => {
    const runtime = window as typeof window & { __perimeterAnnouncements?: string[]; __perimeterStatusObserver?: MutationObserver };
    runtime.__perimeterStatusObserver?.disconnect();
    return runtime.__perimeterAnnouncements ?? [];
  });
}

async function peekConnectorStatus(page: Page) {
  return page.evaluate(() => (
    window as typeof window & { __perimeterAnnouncements?: string[] }
  ).__perimeterAnnouncements ?? []);
}

async function modelToScreen(page: Page, point: Readonly<{ x: number; y: number }>) {
  return page.evaluate((worldPoint) => {
    const content = document.querySelector<HTMLElement>(".canvas-content");
    if (!content) throw new Error("Canvas world layer was unavailable.");
    const bounds = content.getBoundingClientRect();
    const matrix = new DOMMatrixReadOnly(getComputedStyle(content).transform);
    return { x: bounds.x + worldPoint.x * matrix.a, y: bounds.y + worldPoint.y * matrix.d };
  }, point);
}

async function screenToModel(page: Page, point: Readonly<{ x: number; y: number }>) {
  return page.evaluate((screenPoint) => {
    const content = document.querySelector<HTMLElement>(".canvas-content");
    if (!content) throw new Error("Canvas world layer was unavailable.");
    const bounds = content.getBoundingClientRect();
    return { x: (screenPoint.x - bounds.x) / (bounds.width / content.offsetWidth), y: (screenPoint.y - bounds.y) / (bounds.height / content.offsetHeight) };
  }, point);
}

/** Independent seeded-fixture oracle for the rounded-rectangle's clean perimeter. */
function seededRoundedRectangleBoundaryPoint(t: number) {
  const width = 240;
  const height = 140;
  const radius = 12.6;
  const center = { x: width / 2, y: height / 2 };
  const radians = t * Math.PI * 2;
  const direction = { x: Math.sin(radians), y: -Math.cos(radians) };
  const local = rayRoundedRectangleIntersection(center, direction, width, height, radius);
  if (!local) throw new Error("Seeded rounded-rectangle oracle could not resolve its perimeter point.");
  const rotation = 31 * Math.PI / 180;
  const dx = local.x - center.x;
  const dy = local.y - center.y;
  return {
    x: 420 + center.x + dx * Math.cos(rotation) - dy * Math.sin(rotation),
    y: 240 + center.y + dx * Math.sin(rotation) + dy * Math.cos(rotation),
  };
}

function perimeterPoint(target: Readonly<{ height: number; kind: "diamond" | "ellipse" | "text"; rotation: number; width: number; x: number; y: number }>, t: number) {
  const radians = t * Math.PI * 2;
  const direction = { x: Math.sin(radians), y: -Math.cos(radians) };
  const halfWidth = target.width / 2;
  const halfHeight = target.height / 2;
  const distance = target.kind === "ellipse"
    ? 1
    : target.kind === "diamond"
      ? 1 / (Math.abs(direction.x) / halfWidth + Math.abs(direction.y) / halfHeight)
      : Math.min(halfWidth / Math.max(Math.abs(direction.x), Number.EPSILON), halfHeight / Math.max(Math.abs(direction.y), Number.EPSILON));
  const local = target.kind === "ellipse"
    ? { x: direction.x * halfWidth, y: direction.y * halfHeight }
    : { x: direction.x * distance, y: direction.y * distance };
  const rotation = target.rotation * Math.PI / 180;
  return {
    x: target.x + halfWidth + local.x * Math.cos(rotation) - local.y * Math.sin(rotation),
    y: target.y + halfHeight + local.x * Math.sin(rotation) + local.y * Math.cos(rotation),
  };
}

function rayRoundedRectangleIntersection(origin: { x: number; y: number }, direction: { x: number; y: number }, width: number, height: number, radius: number) {
  const segments = [
    { start: { x: radius, y: 0 }, end: { x: width - radius, y: 0 } },
    { start: { x: width - radius, y: 0 }, control: { x: width, y: 0 }, end: { x: width, y: radius } },
    { start: { x: width, y: radius }, end: { x: width, y: height - radius } },
    { start: { x: width, y: height - radius }, control: { x: width, y: height }, end: { x: width - radius, y: height } },
    { start: { x: width - radius, y: height }, end: { x: radius, y: height } },
    { start: { x: radius, y: height }, control: { x: 0, y: height }, end: { x: 0, y: height - radius } },
    { start: { x: 0, y: height - radius }, end: { x: 0, y: radius } },
    { start: { x: 0, y: radius }, control: { x: 0, y: 0 }, end: { x: radius, y: 0 } },
  ];
  const cross = (first: { x: number; y: number }, second: { x: number; y: number }) => first.x * second.y - first.y * second.x;
  const candidates = segments.flatMap((segment) => {
    if (!("control" in segment)) {
      const edge = { x: segment.end.x - segment.start.x, y: segment.end.y - segment.start.y };
      const divisor = cross(direction, edge);
      if (Math.abs(divisor) < 1e-12) return [];
      const delta = { x: segment.start.x - origin.x, y: segment.start.y - origin.y };
      const ray = cross(delta, edge) / divisor;
      const position = cross(delta, direction) / divisor;
      return ray >= 0 && position >= 0 && position <= 1 ? [{ x: origin.x + direction.x * ray, y: origin.y + direction.y * ray }] : [];
    }
    const a = { x: segment.start.x - 2 * segment.control.x + segment.end.x, y: segment.start.y - 2 * segment.control.y + segment.end.y };
    const b = { x: 2 * (segment.control.x - segment.start.x), y: 2 * (segment.control.y - segment.start.y) };
    const c = { x: segment.start.x - origin.x, y: segment.start.y - origin.y };
    const coefficientA = cross(a, direction);
    const coefficientB = cross(b, direction);
    const coefficientC = cross(c, direction);
    const roots = Math.abs(coefficientA) < 1e-12 ? [-coefficientC / coefficientB] : (() => {
      const discriminant = coefficientB * coefficientB - 4 * coefficientA * coefficientC;
      return discriminant < 0 ? [] : [(-coefficientB - Math.sqrt(discriminant)) / (2 * coefficientA), (-coefficientB + Math.sqrt(discriminant)) / (2 * coefficientA)];
    })();
    return roots.filter((ratio) => ratio >= 0 && ratio <= 1).map((ratio) => {
      const inverse = 1 - ratio;
      return { x: inverse * inverse * segment.start.x + 2 * inverse * ratio * segment.control.x + ratio * ratio * segment.end.x, y: inverse * inverse * segment.start.y + 2 * inverse * ratio * segment.control.y + ratio * ratio * segment.end.y };
    }).filter((point) => (point.x - origin.x) * direction.x + (point.y - origin.y) * direction.y >= 0);
  });
  return candidates.sort((first, second) => Math.hypot(first.x - origin.x, first.y - origin.y) - Math.hypot(second.x - origin.x, second.y - origin.y))[0] ?? null;
}

async function installPerimeterWorkspace(page: Page) {
  await page.addInitScript(() => {
    type ElementRecord = Record<string, unknown> & { id: string; pageId: string; type: string };
    const storageKey = "note-connector-perimeter-binding-v2";
    if (!sessionStorage.getItem(`${storageKey}:initialized`)) {
      localStorage.removeItem(storageKey);
      sessionStorage.setItem(`${storageKey}:initialized`, "true");
    }
    const style = { fillColor: null, roughness: 1, roundness: 0.18, seed: 17, strokeColor: { kind: "fixed", value: "#4c6ef5" }, strokeStyle: "solid", strokeWidth: 2 };
    const initial = {
      elements: [
        { createdAt: 1, height: 140, id: "rounded-rectangle", locked: false, opacity: 1, pageId: "page", rotation: 31, shape: "rectangle", style, type: "shape", updatedAt: 1, width: 240, x: 420, y: 240, zIndex: 3 },
        { createdAt: 1, height: 130, id: "ellipse", locked: false, opacity: 1, pageId: "page", rotation: -24, shape: "ellipse", style: { ...style, roundness: 0 }, type: "shape", updatedAt: 1, width: 190, x: 720, y: 230, zIndex: 4 },
        { createdAt: 1, height: 150, id: "diamond", locked: false, opacity: 1, pageId: "page", rotation: 41, shape: "diamond", style: { ...style, roundness: 0 }, type: "shape", updatedAt: 1, width: 190, x: 470, y: 500, zIndex: 5 },
        { backgroundMode: "surface", content: "Rotated text binding target", createdAt: 1, height: 105, id: "text-target", locked: false, opacity: 1, pageId: "page", rotation: -17, type: "text", updatedAt: 1, width: 190, x: 760, y: 510, zIndex: 6 },
        { createdAt: 1, end: { kind: "free", x: 1000, y: 596 }, id: "overlay-connector", locked: false, opacity: 1, pageId: "page", start: { kind: "free", x: 755, y: 596 }, style: { ...style, endArrowhead: "arrow", startArrowhead: "none" }, type: "connector", updatedAt: 1, zIndex: 12 },
      ] as ElementRecord[],
      folders: [], isDarkMode: false,
      pages: [{ folderId: "", id: "page", isBookmarked: false, revision: 0, title: "Perimeter binding" }],
      sessionState: { isToolLocked: true, openPageTabIds: ["page"], selectedFolderId: "", selectedPageId: "page" }, warnings: [],
    };
    const workspace = (localStorage.getItem(storageKey) ? JSON.parse(localStorage.getItem(storageKey)!) : initial) as typeof initial;
    const persist = () => localStorage.setItem(storageKey, JSON.stringify(workspace));
    if (!localStorage.getItem(storageKey)) persist();
    const runtime = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
      __perimeterCounts: { apply: number; persistence: number; session: number };
      __perimeterWorkspace: typeof workspace;
      isTauri: boolean;
    };
    runtime.isTauri = true;
    runtime.__perimeterCounts = { apply: 0, persistence: 0, session: 0 };
    runtime.__perimeterWorkspace = workspace;
    runtime.__TAURI_INTERNALS__ = { invoke: async (command, args = {}) => {
      if (command === "initialize_storage") return { databasePath: "perimeter.db", importedLegacyData: false, schemaVersion: 1, warnings: [] };
      if (command === "load_workspace_data") return workspace;
      if (command === "reconcile_workspace_structure") return { pages: workspace.pages };
      if (command === "apply_scene_changes") {
        runtime.__perimeterCounts.apply += 1;
        const batch = args.batch as { deletedElementIds: string[]; pageId: string; upserts: ElementRecord[] };
        const deleted = new Set(batch.deletedElementIds);
        const upserts = new Map(batch.upserts.map((element) => [element.id, element]));
        workspace.elements = workspace.elements.filter((element) => element.pageId !== batch.pageId || !deleted.has(element.id)).map((element) => upserts.get(element.id) ?? element);
        for (const element of batch.upserts) if (!workspace.elements.some((candidate) => candidate.id === element.id)) workspace.elements.push(element);
        workspace.pages[0].revision += 1;
        persist();
        runtime.__perimeterCounts.persistence += 1;
        return { newRevision: workspace.pages[0].revision, pageId: batch.pageId };
      }
      if (command === "save_session_state") { runtime.__perimeterCounts.session += 1; workspace.sessionState = args.state as typeof workspace.sessionState; persist(); runtime.__perimeterCounts.persistence += 1; return; }
      throw new Error(`Unexpected ${command}`);
    } };
  });
}
