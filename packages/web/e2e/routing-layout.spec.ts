import { expect, test } from "@playwright/test";
import { expectNoDocumentOverflow, installTrpcFixture } from "./fixtures";

test("routing uses a compact create action on phone and a labelled action in a wide pane", async ({
  page,
}) => {
  await installTrpcFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/routing");

  const phoneCreate = page.getByRole("button", { name: "Новый канал" });
  await expect(phoneCreate).toBeVisible();
  expect((await phoneCreate.boundingBox())?.width).toBeLessThanOrEqual(44);
  await expectNoDocumentOverflow(page);

  await page.setViewportSize({ width: 1440, height: 1024 });
  const desktopCreate = page.getByRole("button", { name: "Новый канал" });
  await expect(desktopCreate).toBeVisible();
  expect((await desktopCreate.boundingBox())?.width).toBeGreaterThan(100);
});

test("routing switches create actions exactly at the 42rem page boundary", async ({ page }) => {
  await installTrpcFixture(page);
  await page.setViewportSize({ width: 983, height: 844 });
  await page.goto("/routing");
  expect(
    (await page.getByRole("button", { name: "Новый канал" }).boundingBox())?.width,
  ).toBeLessThanOrEqual(44);
  await expectNoDocumentOverflow(page);

  await page.setViewportSize({ width: 984, height: 844 });
  expect(
    (await page.getByRole("button", { name: "Новый канал" }).boundingBox())?.width,
  ).toBeGreaterThan(100);
  await expectNoDocumentOverflow(page);
});
