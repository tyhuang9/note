import { expect, test, type Locator, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await installPerimeterWorkspace(page);
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("tabpanel")).toBeVisible();
});

test("pointer two-click authoring snaps a rotated rounded rectangle at an arbitrary perimeter position and commits the preview point", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  const start = await modelToScreen(page, { x: 900, y: 650 });
  const expectedEnd = seededRoundedRectangleBoundaryPoint(0.18);
  const targetPoint = await modelToScreen(page, expectedEnd);

  await selectTool(page, "arrow");
  await page.mouse.click(start.x, start.y);
  await page.mouse.move(targetPoint.x + 23, targetPoint.y, { steps: 4 });
  const revealedMarker = page.locator('[data-connector-target-id="rounded-rectangle"]');
  await expect(revealedMarker).toHaveCount(1);
  await expect(revealedMarker).not.toHaveClass(/is-snapped/);
  await expect.poll(() => markerCssWidth(revealedMarker)).toBe(10);
  await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 6 });

  const marker = page.locator('[data-connector-target-id="rounded-rectangle"].is-active');
  await expect(marker).toHaveCount(1);
  await expect(marker).toHaveAttribute("data-connector-anchor", "perimeter");
  await expect.poll(() => markerCssWidth(marker)).toBe(14);

  const preview = page.locator(".arrow-authoring-preview");
  const previewEnd = {
    x: Number(await preview.getAttribute("data-end-x")),
    y: Number(await preview.getAttribute("data-end-y")),
  };
  expect(Math.abs(previewEnd.x - expectedEnd.x)).toBeLessThanOrEqual(0.01);
  expect(Math.abs(previewEnd.y - expectedEnd.y)).toBeLessThanOrEqual(0.01);
  await page.mouse.click(targetPoint.x, targetPoint.y);

  await expect.poll(() => newestConnector(page)).toMatchObject({
    end: { kind: "element", targetElementId: "rounded-rectangle" },
  });
  const connector = await newestConnector(page);
  const committedT = (connector?.end as { anchor?: { t?: number } } | undefined)?.anchor?.t;
  expect(committedT).toBeCloseTo(0.18, 5);
  const committedEnd = seededRoundedRectangleBoundaryPoint(committedT ?? Number.NaN);
  const committedEndScreen = await modelToScreen(page, committedEnd);
  const endHandle = page.getByRole("button", { name: "Move connector end endpoint" });
  const endHandleBounds = await requiredBounds(endHandle, "committed end endpoint");
  expect(Math.abs(endHandleBounds.x + endHandleBounds.width / 2 - committedEndScreen.x)).toBeLessThanOrEqual(1.5);
  expect(Math.abs(endHandleBounds.y + endHandleBounds.height / 2 - committedEndScreen.y)).toBeLessThanOrEqual(1.5);
});

test("keyboard chooser commits an arbitrary one-degree perimeter binding", async ({ page }) => {
  const canvas = page.getByRole("tabpanel");
  await canvas.focus();
  await page.keyboard.press("a");
  await page.keyboard.press("Enter");
  const startHandle = page.getByRole("button", { name: "Move connector start endpoint" });
  await expect(startHandle).toBeFocused();

  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Choose start endpoint target" });
  await dialog.getByRole("button", { name: /^Rectangle 1 / }).click();
  await dialog.getByRole("button", { name: /^Right anchor/ }).click();
  await dialog.getByRole("button", { name: "Bind start endpoint" }).click();
  await expect.poll(() => newestConnector(page)).toMatchObject({
    start: { kind: "element", targetElementId: "rounded-rectangle", anchor: { t: 0.25 } },
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
  const top = arbitraryDialog.getByRole("button", { name: /^Top anchor/ });
  const right = arbitraryDialog.getByRole("button", { name: /^Right anchor/ });
  const bottom = arbitraryDialog.getByRole("button", { name: /^Bottom anchor/ });
  const left = arbitraryDialog.getByRole("button", { name: /^Left anchor/ });
  await page.keyboard.press("Tab");
  await expect(top).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(right).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(bottom).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(left).toBeFocused();
  const range = arbitraryDialog.getByRole("slider", { name: /Target-relative boundary position/ });
  await page.keyboard.press("Tab");
  await expect(range).toBeFocused();
  await expect(range).toHaveAttribute("aria-valuetext", /0 degrees target-relative boundary position on Rectangle 1/);
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
  await reopenedDialog.getByRole("button", { name: /^Top anchor/ }).click();
  const reopenedRange = reopenedDialog.getByRole("slider", { name: /Target-relative boundary position/ });
  await reopenedRange.focus();
  for (let index = 0; index < 37; index += 1) await page.keyboard.press("ArrowRight");
  await expect(reopenedRange).toHaveAttribute("aria-valuetext", /37 degrees target-relative boundary position on Rectangle 1/);
  await reopenedDialog.getByRole("button", { name: "Bind start endpoint" }).click();
  await expect(startHandle).toBeFocused();

  await expect.poll(() => newestConnector(page)).toMatchObject({
    start: { kind: "element", targetElementId: "rounded-rectangle", anchor: { t: 37 / 360 } },
  });

  await startHandle.focus();
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(async () => {
    const start = (await newestConnector(page))?.start as { anchor: { t: number }; kind: string; targetElementId: string };
    return start?.kind === "element" && start.targetElementId === "rounded-rectangle" && start.anchor.t !== 37 / 360;
  }).toBe(true);
  await expect(page.locator('[role="status"].canvas-accessibility-status')).toHaveText(
    /Moved start endpoint along Rectangle 1 .*target-relative boundary position \d+ degrees\./,
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
  const nearPerimeter = await modelToScreen(page, seededRoundedRectangleBoundaryPoint(0.18));
  const nearPerimeterTwo = await modelToScreen(page, seededRoundedRectangleBoundaryPoint(0.22));
  const snappedPerimeter = await modelToScreen(page, seededRoundedRectangleBoundaryPoint(0.18));
  const snappedPerimeterTwo = await modelToScreen(page, seededRoundedRectangleBoundaryPoint(0.22));
  const seamPerimeter = await modelToScreen(page, seededRoundedRectangleBoundaryPoint(0.999));
  const freePoint = await modelToScreen(page, { x: 100, y: 780 });
  const status = page.locator('[role="status"].canvas-accessibility-status');
  await observeConnectorStatus(page);

  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(nearPerimeter.x + 23, nearPerimeter.y);
  await expect(status).toHaveText(/Near Rectangle 1 .*target-relative boundary position/);
  const nearMarker = page.locator('[data-connector-target-id="rounded-rectangle"]');
  await expect(nearMarker).toHaveCount(1);
  await expect(nearMarker).not.toHaveClass(/is-snapped/);
  await expect.poll(() => markerCssWidth(nearMarker)).toBe(10);
  await page.mouse.move(nearPerimeterTwo.x + 23, nearPerimeterTwo.y);
  await expect(status).toHaveText(/Near Rectangle 1 .*target-relative boundary position/);
  await page.mouse.move(snappedPerimeter.x, snappedPerimeter.y);
  await expect(status).toHaveText(/Snapped to Rectangle 1 .*target-relative boundary position/);
  const snappedMarker = page.locator('[data-connector-target-id="rounded-rectangle"].is-active');
  await expect(snappedMarker).toHaveCount(1);
  await expect(snappedMarker).toHaveClass(/is-snapped/);
  await expect.poll(() => markerCssWidth(snappedMarker)).toBe(14);
  await page.mouse.move(snappedPerimeterTwo.x, snappedPerimeterTwo.y);
  await expect(status).toHaveText(/Snapped to Rectangle 1 .*target-relative boundary position/);
  await page.mouse.move(freePoint.x, freePoint.y);
  await expect(status).toHaveText("No binding target. Endpoint will remain free.");
  await page.mouse.move(seamPerimeter.x, seamPerimeter.y);
  await expect(status).toHaveText(/Snapped to Rectangle 1 .*target-relative boundary position 0 degrees\./);
  await endHandle.dispatchEvent("pointercancel", { pointerId: 1 });
  await page.mouse.up();
  await expect(status).toHaveText("Endpoint retargeting canceled. Existing binding remains unchanged.");

  const announcements = await readConnectorStatus(page);
  expect(announcements.filter((message) => message.startsWith("Near Rectangle 1") && message.includes("target-relative boundary position"))).toHaveLength(1);
  expect(announcements.filter((message) => message.startsWith("Snapped to Rectangle 1") && message.includes("target-relative boundary position"))).toHaveLength(2);
  expect(announcements.some((message) => message.includes("target-relative boundary position 360 degrees"))).toBe(false);
  expect(announcements.filter((message) => message === "No binding target. Endpoint will remain free.")).toHaveLength(1);
  expect(announcements.filter((message) => message === "Endpoint retargeting canceled. Existing binding remains unchanged.")).toHaveLength(1);
});

test("continuous authoring binds one arbitrary perimeter target at 50%, 100%, and 200%", async ({ page }) => {
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
      const marker = page.locator(`[data-connector-target-id="${target.id}"].is-active`);
      await expect(marker).toHaveCount(1);
      await expect.poll(() => markerCssWidth(marker)).toBe(14);
      const preview = page.locator(".arrow-authoring-preview");
      const previewEnd = { x: Number(await preview.getAttribute("data-end-x")), y: Number(await preview.getAttribute("data-end-y")) };
      await dispatchCanvasPointer(page, "pointerdown", end);
      await expect.poll(() => newestConnector(page)).toMatchObject({ end: { kind: "element", targetElementId: target.id } });
      const committedHandle = await requiredBounds(page.getByRole("button", { name: "Move connector end endpoint" }), "committed endpoint handle");
      const committedEnd = await screenToModel(page, { x: committedHandle.x + committedHandle.width / 2, y: committedHandle.y + committedHandle.height / 2 });
      expect(Math.abs(committedEnd.x - previewEnd.x)).toBeLessThanOrEqual(1.5 / (percent / 100));
      expect(Math.abs(committedEnd.y - previewEnd.y)).toBeLessThanOrEqual(1.5 / (percent / 100));
      const t = ((await newestConnector(page))?.end as { anchor: { t: number } }).anchor.t;
      expect([0, 0.25, 0.5, 0.75]).not.toContain(t);
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
  await expect(page.locator('[data-connector-target-id="text-target"].is-active')).toHaveCount(1);
  await page.mouse.up();
  await expect.poll(() => newestConnector(page)).toMatchObject({ end: { kind: "element", targetElementId: "text-target" } });
  const boundT = ((await newestConnector(page))?.end as { anchor: { t: number } }).anchor.t;

  const text = page.locator('[data-canvas-element-id="text-target"]');
  await text.focus();
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(async () => ((await newestConnector(page))?.end as { anchor: { t: number } }).anchor.t).toBe(boundT);
  await canvas.focus();
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+y");
  await expect.poll(() => newestConnector(page)).toMatchObject({ end: { kind: "element", targetElementId: "text-target", anchor: { t: boundT } } });
  await page.reload();
  await expect.poll(() => newestConnector(page)).toMatchObject({ end: { kind: "element", targetElementId: "text-target", anchor: { t: boundT } } });
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
  expect(await counts(page)).toEqual({ apply: 0, session: 0 });

  await selectTool(page, "arrow");
  const start = await modelToScreen(page, { x: 980, y: 720 });
  await dispatchCanvasPointer(page, "pointerdown", start);
  await page.keyboard.press("Escape");
  expect(await counts(page)).toEqual({ apply: 0, session: 0 });
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

async function markerCssWidth(locator: Locator) {
  return locator.evaluate((marker) => Number.parseFloat(getComputedStyle(marker).width));
}

async function newestConnector(page: Page) {
  return page.evaluate(() => {
    const elements = (window as unknown as { __perimeterWorkspace: { elements: Array<Record<string, unknown> & { type: string }> } }).__perimeterWorkspace.elements;
    return [...elements].reverse().find((element) => element.type === "connector");
  });
}

async function counts(page: Page) {
  return page.evaluate(() => (window as unknown as { __perimeterCounts: { apply: number; session: number } }).__perimeterCounts);
}

async function resetCounts(page: Page) {
  await page.evaluate(() => { (window as unknown as { __perimeterCounts: { apply: number; session: number } }).__perimeterCounts = { apply: 0, session: 0 }; });
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
      __perimeterCounts: { apply: number; session: number };
      __perimeterWorkspace: typeof workspace;
      isTauri: boolean;
    };
    runtime.isTauri = true;
    runtime.__perimeterCounts = { apply: 0, session: 0 };
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
        return { newRevision: workspace.pages[0].revision, pageId: batch.pageId };
      }
      if (command === "save_session_state") { runtime.__perimeterCounts.session += 1; workspace.sessionState = args.state as typeof workspace.sessionState; persist(); return; }
      throw new Error(`Unexpected ${command}`);
    } };
  });
}
