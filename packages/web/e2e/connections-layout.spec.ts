import { expect, test } from "@playwright/test";
import { expectNoDocumentOverflow, installTrpcFixture } from "./fixtures";

test("connections keep search compact beside the destructive action on desktop", async ({
  page,
}) => {
  await installTrpcFixture(page);
  await page.setViewportSize({ width: 1440, height: 1024 });
  await page.goto("/connections");

  const search = page.locator(".connections-search");
  const closeAll = page.locator(".connections-close-all");
  const searchBox = await search.boundingBox();
  const closeBox = await closeAll.boundingBox();

  expect(searchBox).not.toBeNull();
  expect(closeBox).not.toBeNull();
  expect(searchBox?.width).toBeLessThanOrEqual(240);
  expect(closeBox?.y).toBe(searchBox?.y);
  await expectNoDocumentOverflow(page);
});

test("connections reserve full-width rows for phone controls only", async ({ page }) => {
  await installTrpcFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/connections");

  const searchBox = await page.locator(".connections-search").boundingBox();
  const closeBox = await page.locator(".connections-close-all").boundingBox();

  expect(searchBox).not.toBeNull();
  expect(closeBox).not.toBeNull();
  expect(closeBox?.y).toBeGreaterThan(searchBox?.y ?? 0);
  expect(Math.abs((searchBox?.width ?? 0) - (closeBox?.width ?? 0))).toBeLessThanOrEqual(1);
  await expectNoDocumentOverflow(page);
});

test("connections use the available content pane rather than the viewport for toolbar rows", async ({
  page,
}) => {
  await installTrpcFixture(page);
  await page.setViewportSize({ width: 768, height: 844 });
  await page.goto("/connections");

  const searchBox = await page.locator(".connections-search").boundingBox();
  const closeBox = await page.locator(".connections-close-all").boundingBox();

  expect(searchBox).not.toBeNull();
  expect(closeBox).not.toBeNull();
  if (!searchBox || !closeBox)
    throw new Error("Expected connections toolbar geometry to be measurable");
  expect(closeBox.y).toBeGreaterThan(searchBox.y);
  expect(Math.abs(searchBox.width - closeBox.width)).toBeLessThanOrEqual(1);
  await expectNoDocumentOverflow(page);
});
