import { expect, test } from "@playwright/test";
import { expectNoDocumentOverflow, installTrpcFixture } from "./fixtures";

const sourceFixture = {
  id: 1,
  kind: "sub",
  value: "https://example.test/subscription",
  label: "Fixture subscription with a long readable name",
  hwid: false,
  enabled: true,
  sortOrder: 0,
  proxies: [{ name: "Fixture node", type: "vless", server: "example.test", port: 443 }],
  meta: { used: 7_500_000_000, total: 200_000_000_000, expire: 1_800_000_000, updateHours: 6 },
  updatedAt: "2026-07-12T12:00:00.000Z",
  createdAt: "2026-07-12T12:00:00.000Z",
};

const sourceFixtures = Array.from({ length: 8 }, (_, index) => ({
  ...sourceFixture,
  id: index + 1,
  label: `${sourceFixture.label} ${index + 1}`,
  sortOrder: index,
}));

test("forms keep compact layouts in a 768px desktop viewport with the sidebar", async ({
  page,
}) => {
  await page.setViewportSize({ width: 768, height: 844 });

  await installTrpcFixture(page, { "sources.list": [sourceFixture] });
  await page.goto("/sources");
  const sourcesPage = page.locator(".responsive-page--sources");
  expect((await sourcesPage.boundingBox())?.width).toBeLessThan(672);
  await expect(page.locator(".sources-list")).toHaveCSS("gap", "12px");
  await expect(page.locator(".source-row")).toHaveCSS("flex-direction", "column");
  await expect(page.getByText("до 15.01.2027")).toBeVisible();
  const sourceRow = page.locator(".source-row").first();
  const sourceRowBox = await sourceRow.boundingBox();
  const deleteBox = await page.getByRole("button", { name: "Удалить источник" }).boundingBox();
  expect(sourceRowBox).not.toBeNull();
  expect(deleteBox).not.toBeNull();
  if (!sourceRowBox || !deleteBox) throw new Error("Expected source row controls to be measurable");
  expect(deleteBox.x + deleteBox.width).toBeLessThanOrEqual(sourceRowBox.x + sourceRowBox.width);
  await expectNoDocumentOverflow(page);

  await installTrpcFixture(page);
  await page.goto("/settings");
  await expect(page.locator(".labeled-control-row").first()).toHaveCSS("flex-direction", "column");
  await expectNoDocumentOverflow(page);

  await page.goto("/routing");
  await expect(page.locator(".channel-card-toggle").first()).toHaveCSS("flex-wrap", "wrap");
  await expectNoDocumentOverflow(page);
});

test("forms use their dense layouts only when the page container is wide enough", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1024 });

  await installTrpcFixture(page, { "sources.list": [sourceFixture] });
  await page.goto("/sources");
  await expect(page.locator(".sources-list")).toHaveCSS("gap", "0px");
  await expect(page.locator(".source-row")).toHaveCSS("flex-direction", "row");
  const wideAddBox = await page.locator(".source-form-submit-button").boundingBox();
  const wideFormBox = await page.locator("form").first().boundingBox();
  expect(wideAddBox?.width).toBeLessThan(wideFormBox?.width ?? 0);
  await expectNoDocumentOverflow(page);

  await installTrpcFixture(page);
  await page.goto("/settings");
  await expect(page.locator(".labeled-control-row").first()).toHaveCSS("flex-direction", "row");
  await expectNoDocumentOverflow(page);

  await page.goto("/routing");
  await expect(page.locator(".channel-card-toggle").first()).toHaveCSS("flex-wrap", "nowrap");
  await expectNoDocumentOverflow(page);
});

test("forms retain reachable controls and bottom navigation on phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });

  await installTrpcFixture(page, { "sources.list": sourceFixtures });
  await page.goto("/sources");
  await expect(page.locator(".source-row").first()).toHaveCSS("flex-direction", "column");
  const phoneAddBox = await page.locator(".source-form-submit-button").boundingBox();
  const phoneInputBox = await page.getByLabel("Ссылка источника").boundingBox();
  expect(phoneAddBox).not.toBeNull();
  expect(phoneInputBox).not.toBeNull();
  if (!phoneAddBox || !phoneInputBox)
    throw new Error("Expected source form controls to be measurable");
  expect(Math.abs(phoneAddBox.width - phoneInputBox.width)).toBeLessThanOrEqual(1);
  const lastDelete = page.getByRole("button", { name: "Удалить источник" }).last();
  await lastDelete.scrollIntoViewIfNeeded();
  const nav = page.locator("nav.fixed");
  await expect(nav).toBeVisible();
  const lastDeleteBox = await lastDelete.boundingBox();
  const navBox = await nav.boundingBox();
  expect((lastDeleteBox?.y ?? Infinity) + (lastDeleteBox?.height ?? 0)).toBeLessThanOrEqual(
    navBox?.y ?? -Infinity,
  );
  await expectNoDocumentOverflow(page);

  await installTrpcFixture(page);
  await page.goto("/settings");
  await expect(page.locator(".labeled-control-row").first()).toHaveCSS("flex-direction", "column");
  await expectNoDocumentOverflow(page);

  await page.goto("/routing");
  await expect(page.locator(".channel-card-toggle").first()).toHaveCSS("flex-wrap", "wrap");
  await expectNoDocumentOverflow(page);
});
