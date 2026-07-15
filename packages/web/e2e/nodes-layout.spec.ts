import { expect, test } from "@playwright/test";
import { expectNoDocumentOverflow, installTrpcFixture } from "./fixtures";

const primaryNodeName = "Амстердам — основной маршрут";

const scrollableNodesList = {
  now: primaryNodeName,
  autoNow: primaryNodeName,
  all: Array.from({ length: 8 }, (_, index) => ({
    name: index === 0 ? primaryNodeName : `Резервный маршрут ${index + 1}`,
    type: "vless",
    delay: 42 + index,
    network: "tcp",
    security: "tls",
    history: [42 + index],
  })),
};

test("nodes stay compact when a desktop viewport leaves a narrow content pane", async ({
  page,
}) => {
  await installTrpcFixture(page);
  await page.setViewportSize({ width: 920, height: 844 });
  await page.goto("/");

  await expect(page.getByRole("button", { name: "Дополнительные действия" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Пинг всех" })).toBeHidden();
  await expect(page.getByTestId("nodes-auto-params")).toHaveCSS("display", "grid");
  await expect(page.locator(".latency-chart-track").first()).toHaveCSS("height", "54px");
  await expectNoDocumentOverflow(page);
});

for (const width of [320, 390, 425]) {
  test(`nodes keep compact controls and do not overflow at ${width}px`, async ({ page }) => {
    await installTrpcFixture(page);
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");

    await expect(page.getByRole("button", { name: "Дополнительные действия" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Пинг всех" })).toBeHidden();
    await expect(page.getByTestId("nodes-auto-params")).toHaveCSS("display", "grid");
    await expectNoDocumentOverflow(page);
  });
}

test("nodes switch header and chart exactly at the 42rem inline boundary", async ({ page }) => {
  await installTrpcFixture(page);
  await page.setViewportSize({ width: 983, height: 844 });
  await page.goto("/");

  await expect(page.getByRole("button", { name: "Дополнительные действия" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Пинг всех" })).toBeHidden();
  await expect(page.locator(".latency-chart-track").first()).toHaveCSS("height", "54px");
  await expectNoDocumentOverflow(page);

  await page.setViewportSize({ width: 984, height: 844 });
  await expect(page.getByRole("button", { name: "Пинг всех" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Дополнительные действия" })).toBeHidden();
  await expect(page.getByTestId("nodes-auto-params")).toHaveCSS("display", "grid");
  await expect(page.locator(".latency-chart-track").first()).toHaveCSS("height", "92px");
  await expectNoDocumentOverflow(page);
});

test("nodes switch dense list rows exactly at the 48rem data boundary", async ({ page }) => {
  await installTrpcFixture(page);
  await page.setViewportSize({ width: 1079, height: 844 });
  await page.goto("/");
  await expect(page.locator(".node-row-mobile").first()).toBeVisible();
  await expect(page.locator(".node-row-desktop").first()).toBeHidden();
  await expectNoDocumentOverflow(page);

  await page.setViewportSize({ width: 1080, height: 844 });
  await expect(page.locator(".node-row-desktop").first()).toBeVisible();
  await expect(page.locator(".node-row-mobile").first()).toBeHidden();
  await expect(page.locator(".node-list-container")).toHaveCSS("border-top-width", "1px");
  const [tableSurface, surfaceToken] = await page
    .locator(".node-list-container")
    .evaluate((element) => {
      const probe = document.createElement("div");
      probe.style.backgroundColor = "var(--bg-surface)";
      document.body.append(probe);
      const resolvedToken = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return [getComputedStyle(element).backgroundColor, resolvedToken];
    });
  expect(tableSurface).toBe(surfaceToken);
  await expectNoDocumentOverflow(page);
});

test("nodes keep every strategy parameter on its own compact row before the 60rem detail boundary", async ({
  page,
}) => {
  await installTrpcFixture(page);
  await page.setViewportSize({ width: 1271, height: 844 });
  await page.goto("/");
  const rows = page.locator(".nodes-auto-param");
  await expect(rows).toHaveCount(5);
  const rowTops = await rows.evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().top),
  );
  expect(rowTops.every((top, index) => index === 0 || top > (rowTops[index - 1] ?? 0))).toBe(true);
  await expectNoDocumentOverflow(page);

  await page.setViewportSize({ width: 1272, height: 844 });
  await expect(page.getByTestId("nodes-auto-params")).toHaveCSS("display", "flex");
  const url = page.getByTitle("www.gstatic.com/generate_204");
  await expect(url).toHaveCSS("display", "block");
  await expect(url).toHaveCSS("text-overflow", "ellipsis");
  await expect(url.locator("..")).toHaveCSS("overflow", "hidden");
  await expectNoDocumentOverflow(page);
});

test("node action menus open above their trigger without covering it", async ({ page }) => {
  await installTrpcFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const trigger = page.getByRole("button", { name: "Действия для Амстердам — основной маршрут" });
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();

  const menu = page.getByRole("button", { name: "Отключить узел" }).locator("..");
  const triggerBox = await trigger.boundingBox();
  const menuBox = await menu.boundingBox();
  expect(triggerBox).not.toBeNull();
  expect(menuBox).not.toBeNull();
  if (!triggerBox || !menuBox) throw new Error("Expected action menu geometry to be measurable");
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(triggerBox.y - 8);

  await trigger.click();
  await expect(page.getByRole("button", { name: "Отключить узел" })).toBeHidden();

  await expectNoDocumentOverflow(page);
});

test("node action menus flip below an upper-edge trigger", async ({ page }) => {
  await installTrpcFixture(page, { "nodes.list": scrollableNodesList });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const trigger = page.getByRole("button", { name: `Действия для ${primaryNodeName}` });
  await trigger.evaluate((element) => element.scrollIntoView({ block: "start" }));
  expect(
    await trigger.evaluate((element) => element.getBoundingClientRect().top),
  ).toBeLessThanOrEqual(24);
  await trigger.click();

  const menu = page.getByRole("button", { name: "Отключить узел" }).locator("..");
  const triggerBox = await trigger.boundingBox();
  const menuBox = await menu.boundingBox();
  expect(triggerBox).not.toBeNull();
  expect(menuBox).not.toBeNull();
  if (!triggerBox || !menuBox) throw new Error("Expected action menu geometry to be measurable");
  expect(menuBox.y).toBeGreaterThanOrEqual(triggerBox.y + triggerBox.height + 8);

  await expectNoDocumentOverflow(page);
});

test("a hidden desktop bottom nav does not affect node menu placement", async ({ page }) => {
  await installTrpcFixture(page, { "nodes.list": scrollableNodesList });
  await page.setViewportSize({ width: 920, height: 844 });
  await page.goto("/");

  await expect(page.locator("nav.fixed")).toBeHidden();
  await expect(page.locator(".node-row-mobile").first()).toBeVisible();
  const trigger = page.getByRole("button", { name: `Действия для ${primaryNodeName}` });
  await trigger.evaluate((element) => element.scrollIntoView({ block: "start" }));
  await trigger.click();

  const menu = page.getByRole("button", { name: "Отключить узел" }).locator("..");
  const triggerBox = await trigger.boundingBox();
  const menuBox = await menu.boundingBox();
  if (!triggerBox || !menuBox) throw new Error("Expected action menu geometry to be measurable");
  expect(menuBox.y).toBeGreaterThanOrEqual(triggerBox.y + triggerBox.height + 8);
});

test("compact header menu closes on Escape and returns focus", async ({ page }) => {
  await installTrpcFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const trigger = page.getByRole("button", { name: "Дополнительные действия" });
  await trigger.click();
  await expect(page.getByRole("button", { name: "Пинг всех" })).toBeVisible();

  await page.keyboard.press("Escape");

  await expect(page.getByRole("button", { name: "Пинг всех" })).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("keyboard menu actions close and return focus to the compact header trigger", async ({
  page,
}) => {
  await installTrpcFixture(page, { "nodes.delay": 42 });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const trigger = page.getByRole("button", { name: "Дополнительные действия" });
  await trigger.click();
  const action = page.getByRole("button", { name: "Пинг всех" });
  await action.focus();
  await action.press("Enter");

  await expect(action).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("compact header menu closes on an outside pointer press", async ({ page }) => {
  await installTrpcFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await page.getByRole("button", { name: "Дополнительные действия" }).click();
  await expect(page.getByRole("button", { name: "Пинг всех" })).toBeVisible();

  await page.getByRole("heading", { name: "Узлы", exact: true }).click();

  await expect(page.getByRole("button", { name: "Пинг всех" })).toBeHidden();
});
